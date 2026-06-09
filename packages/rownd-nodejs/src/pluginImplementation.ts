import { randomUUID } from "crypto";
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import type {
  PluginRouteHandler,
  SuperTokensPublicConfig,
} from "supertokens-node/types";

import {
  ANONYMOUS_AUTH_METHOD_ID,
  GUEST_AUTH_METHOD_ID,
  PUBLIC_TENANT_ID,
} from "./constants";
import { RowndPluginError } from "./errors";
import { logDebugMessage } from "./logger";
import type { RowndPluginNormalisedConfig } from "./types";
import { createClient } from "./telemetry/createTelemetryClient";
import {
  assertRowndAppVariantIsConfigured,
  buildRowndAppConfig,
} from "./config";
import {
  buildRowndAudience,
  canUpdateUserDataField,
  isInternalMetadataField,
  mapRowndUserToSuperTokens,
} from "./rownd-compatibility";
import {
  fetchOptionalRowndUserInfo,
  validateRowndToken,
} from "./rownd-repository";
import {
  getUserById,
  getUserMetadata,
  importUser,
  recordRowndAppVariantForUser,
  startPendingEmailVerification,
  updateUserData,
  updateUserMetadata,
} from "./supertokens-repository";
import {
  getErrorMessage,
  getJsonBody,
  getRequestedAppVariantIdFromRequest,
  hasOwn,
  missingFieldResponse,
  parseGuestBody,
  parseRequest,
  parseUpdateFieldBody,
  parseUpdateMetaBody,
  parseUpdateUserBody,
} from "./utils";

type SuperTokensRequest = Parameters<PluginRouteHandler["handler"]>[0];
type SuperTokensResponse = Parameters<PluginRouteHandler["handler"]>[1];
type SuperTokensSession = Parameters<PluginRouteHandler["handler"]>[2];
type SuperTokensUserContext = Parameters<PluginRouteHandler["handler"]>[3];
type TelemetryClient = ReturnType<typeof createClient>;

export type RowndRouteHandlerDeps = {
  pluginConfig: RowndPluginNormalisedConfig;
  stConfig: SuperTokensPublicConfig;
  telemetryClient: TelemetryClient;
};

export function handleGetAppConfig(deps: RowndRouteHandlerDeps) {
  return async (req: SuperTokensRequest) => {
    const appVariantId = getRequestedAppVariantIdFromRequest(req);
    const appConfig = buildRowndAppConfig(
      deps.pluginConfig,
      deps.stConfig,
      appVariantId,
    );

    if (!appConfig) {
      return {
        status: "ERROR" as const,
        message: `Unknown Rownd app variant: ${appVariantId}`,
      };
    }

    return {
      status: "OK" as const,
      ...appConfig,
    };
  };
}

export function handleGuestLogin(deps: RowndRouteHandlerDeps) {
  return async (
    req: SuperTokensRequest,
    res: SuperTokensResponse,
    _session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const startedAt = Date.now();
    const guestId = `guest_${randomUUID()}`;

    try {
      const body = parseGuestBody(await getJsonBody(req));
      const appVariantId = getRequestedAppVariantIdFromRequest(req);
      assertRowndAppVariantIsConfigured(appVariantId);
      const thirdPartyId =
        body.authLevel === ANONYMOUS_AUTH_METHOD_ID
          ? ANONYMOUS_AUTH_METHOD_ID
          : GUEST_AUTH_METHOD_ID;
      const thirdPartyUserId =
        thirdPartyId === ANONYMOUS_AUTH_METHOD_ID
          ? `anon_${randomUUID()}`
          : guestId;

      const response = await ThirdParty.manuallyCreateOrUpdateUser(
        PUBLIC_TENANT_ID,
        thirdPartyId,
        thirdPartyUserId,
        `${thirdPartyUserId}@anonymous.local`,
        false,
        undefined,
        userContext,
      );

      if (response.status !== "OK") {
        throw new Error(
          `Guest user creation failed with status: ${response.status}`,
        );
      }

      await Session.createNewSession(
        req,
        res,
        PUBLIC_TENANT_ID,
        response.recipeUserId,
        {
          ...buildRowndAudience({}, appVariantId),
          auth_level: GUEST_AUTH_METHOD_ID,
          is_anonymous: true,
          app_user_id: response.user.id,
        },
        {},
        userContext,
      );

      logDebugMessage(`Guest session created for user: ${response.user.id}`);
      deps.telemetryClient.recordSuccess({
        outcome: "success",
        durationMs: Date.now() - startedAt,
        tenantId: PUBLIC_TENANT_ID,
        superTokensUserId: response.user.id,
      });

      return {
        status: "OK" as const,
        createdNewRecipeUser: response.createdNewRecipeUser,
      };
    } catch (error) {
      logDebugMessage(`Guest login failed. Error: ${getErrorMessage(error)}`);
      deps.telemetryClient.recordError({
        error,
        startedAt,
        tenantId: PUBLIC_TENANT_ID,
      });
      return {
        status: "ERROR" as const,
        message: "Guest login failed",
      };
    }
  };
}

export function handleMigrate(deps: RowndRouteHandlerDeps) {
  return async (
    req: SuperTokensRequest,
    res: SuperTokensResponse,
    _session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const startedAt = Date.now();
    let tenantId: string | undefined = PUBLIC_TENANT_ID;
    let rowndUserId: string | undefined;
    let superTokensUserId: string | undefined;
    let user: Awaited<ReturnType<typeof SuperTokens.getUser>>;
    let recipeUserId:
      | Parameters<typeof Session.createNewSession>[3]
      | undefined;

    try {
      if (!deps.stConfig.supertokens) {
        throw new Error("Supertokens config not found");
      }

      const parsed = await parseRequest(req);
      const appVariantId = getRequestedAppVariantIdFromRequest(req);
      assertRowndAppVariantIsConfigured(appVariantId);
      rowndUserId = await validateRowndToken(parsed.token);
      const rowndUser = await fetchOptionalRowndUserInfo(rowndUserId);

      if (!rowndUser) {
        logDebugMessage(
          `Skipping migration because user does not exist in Rownd. tenantId: ${PUBLIC_TENANT_ID}, rowndUserId: ${rowndUserId}`,
        );
        return { status: "OK" as const };
      }

      user = await SuperTokens.getUser(rowndUserId, userContext);

      if (!user) {
        const stUserImport = mapRowndUserToSuperTokens(rowndUser);

        try {
          const importedUser = await importUser(
            stUserImport,
            deps.stConfig.supertokens,
          );
          superTokensUserId = importedUser.id;
          if (importedUser.loginMethods[0]?.recipeUserId) {
            recipeUserId = SuperTokens.convertToRecipeUserId(
              importedUser.loginMethods[0].recipeUserId,
            );
          }
        } catch (err) {
          user = await SuperTokens.getUser(rowndUserId, userContext);
          if (!user) {
            throw err;
          }
          superTokensUserId = user.id;
          recipeUserId = user.loginMethods[0]?.recipeUserId;
          logDebugMessage(
            `User already migrated (race condition). tenantId: ${PUBLIC_TENANT_ID}, rowndUserId: ${rowndUserId}`,
          );
        }

        logDebugMessage(
          `User migrated successfully. tenantId: ${PUBLIC_TENANT_ID}, rowndUserId: ${rowndUserId}`,
        );
      } else {
        superTokensUserId = user.id;
        recipeUserId = user.loginMethods[0]?.recipeUserId;
        logDebugMessage(
          `User already migrated. tenantId: ${PUBLIC_TENANT_ID}, rowndUserId: ${rowndUserId}`,
        );
      }

      if (superTokensUserId) {
        await recordRowndAppVariantForUser(superTokensUserId, appVariantId);
      }

      if (!recipeUserId) {
        throw new Error("User not found or has no login methods");
      }

      await Session.createNewSession(
        req,
        res,
        PUBLIC_TENANT_ID,
        recipeUserId,
        {
          ...buildRowndAudience({}, appVariantId),
        },
        {},
        userContext,
      );

      logDebugMessage(
        `Session migrated successfully. tenantId: ${PUBLIC_TENANT_ID}, userId: ${superTokensUserId}`,
      );

      deps.telemetryClient.recordSuccess({
        outcome: "success",
        durationMs: Date.now() - startedAt,
        tenantId,
        rowndUserId,
        superTokensUserId,
      });

      return { status: "OK" as const };
    } catch (error) {
      logDebugMessage(`Migration failed. Error: ${getErrorMessage(error)}`);
      deps.telemetryClient.recordError({
        error,
        startedAt,
        tenantId,
        rowndUserId,
        superTokensUserId,
      });
      return {
        status: "ERROR" as const,
        message:
          error instanceof RowndPluginError
            ? error.message
            : "Migration failed",
      };
    }
  };
}

export function handleGetUser() {
  return async (
    _req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
  ) => {
    const user = await getUserById(session!.getUserId());
    return {
      status: "OK" as const,
      ...user,
    };
  };
}

export function handleUpdateUser() {
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const appVariantId = getRequestedAppVariantIdFromRequest(req);
    assertRowndAppVariantIsConfigured(appVariantId);
    const payload = parseUpdateUserBody(await getJsonBody(req));
    const inputData = payload.data ?? {};
    const requestUserContext = {
      ...userContext,
      ...payload.context,
    };
    const { email, ...dataWithoutEmail } = inputData;
    const hasEmailUpdate =
      hasOwn(inputData, "email") && typeof email === "string";
    const permissionError = validateWritableFields(
      Object.keys(dataWithoutEmail),
    );

    if (permissionError) {
      return permissionError;
    }

    if (Object.keys(dataWithoutEmail).length > 0) {
      await updateUserData(session!.getUserId(), dataWithoutEmail);
    }

    if (hasEmailUpdate) {
      const pendingVerificationResult = await startPendingEmailVerification({
        userId: session!.getUserId(),
        recipeUserId: session!.getRecipeUserId(),
        tenantId: session!.getTenantId(),
        email,
        pendingVerificationId: randomUUID(),
        userContext: appVariantId
          ? { ...requestUserContext, rowndAppVariantId: appVariantId }
          : requestUserContext,
      });
      return {
        status: "OK" as const,
        ...pendingVerificationResult,
      };
    }

    const user = await getUserById(session!.getUserId());
    return {
      status: "OK" as const,
      ...user,
    };
  };
}

export function handleDeleteUser() {
  return async (
    _req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
  ) => {
    await SuperTokens.deleteUser(session!.getUserId(), true);
    return { status: "OK" as const };
  };
}

export function handleSignOut() {
  return async (
    _req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    await Session.revokeAllSessionsForUser(
      session!.getUserId(),
      true,
      session!.getTenantId(),
      userContext,
    );

    return { status: "OK" as const };
  };
}

export function handleGetUserMeta() {
  return async (
    _req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
  ) => {
    const metadata = await getUserMetadata(session!.getUserId());
    return {
      status: "OK" as const,
      id: session!.getUserId(),
      meta: Object.fromEntries(
        Object.entries(metadata).filter(
          ([key]) => !isInternalMetadataField(key),
        ),
      ),
    };
  };
}

export function handleUpdateUserMeta() {
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
  ) => {
    const payload = parseUpdateMetaBody(await getJsonBody(req));
    const internalField = Object.keys(payload.meta ?? {}).find(
      isInternalMetadataField,
    );

    if (internalField) {
      return {
        status: "ERROR" as const,
        code: 403,
        message: `field is not writable: ${internalField}`,
      };
    }

    const updateMetadataResult = await updateUserMetadata(
      session!.getUserId(),
      payload.meta ?? {},
    );
    return {
      status: "OK" as const,
      ...updateMetadataResult,
    };
  };
}

export function handleGetUserField() {
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
  ) => {
    const field = req.getKeyValueFromQuery("field");
    if (!field) {
      return missingFieldResponse();
    }

    const user = await getUserById(session!.getUserId());
    return {
      status: "OK" as const,
      value: user.data[field],
    };
  };
}

export function handleUpdateUserField() {
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const appVariantId = getRequestedAppVariantIdFromRequest(req);
    assertRowndAppVariantIsConfigured(appVariantId);
    const field = req.getKeyValueFromQuery("field");
    if (!field) {
      return missingFieldResponse();
    }

    const payload = parseUpdateFieldBody(await getJsonBody(req));
    if (field === "email" && typeof payload.value === "string") {
      const pendingVerificationResult = await startPendingEmailVerification({
        userId: session!.getUserId(),
        recipeUserId: session!.getRecipeUserId(),
        tenantId: session!.getTenantId(),
        email: payload.value,
        pendingVerificationId: randomUUID(),
        userContext: appVariantId
          ? { ...userContext, rowndAppVariantId: appVariantId }
          : userContext,
      });
      return {
        status: "OK" as const,
        ...pendingVerificationResult,
      };
    }

    const permissionError = validateWritableFields([field]);
    if (permissionError) {
      return permissionError;
    }

    const updateUserDataResult = await updateUserData(session!.getUserId(), {
      [field]: payload.value,
    });
    return {
      status: "OK" as const,
      ...updateUserDataResult,
    };
  };
}

function validateWritableFields(fields: string[]) {
  const readOnlyField = fields.find((field) => !canUpdateUserDataField(field));

  if (!readOnlyField) {
    return undefined;
  }

  return {
    status: "ERROR" as const,
    code: 403,
    message: `field is not writable: ${readOnlyField}`,
  };
}
