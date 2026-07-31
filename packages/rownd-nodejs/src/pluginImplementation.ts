import { randomUUID } from "crypto";
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import MultiTenancy from "supertokens-node/recipe/multitenancy";
import type {
  PluginRouteHandler,
  SuperTokensPublicConfig,
} from "supertokens-node/types";

import {
  GUEST_AUTH_METHOD_ID,
  INSTANT_AUTH_METHOD_ID,
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
  reconcileRowndUserWithExistingLoginMethods,
  recordRowndAppVariantForUser,
  startPendingEmailVerification,
  updateUserData,
  updateUserMetadata,
} from "./supertokens-repository";
import {
  assertAllowedBypassRedirectPath,
  getErrorMessage,
  getJsonBody,
  normalizeRedirectToPathForClientDomain,
  getRequestedAppVariantIdFromRequest,
  hasOwn,
  isRecord,
  missingFieldResponse,
  parseGuestBody,
  parseRequest,
  parseUpdateFieldBody,
  parseUpdateMetaBody,
  parseUpdateUserBody,
  resolveTenantId,
  resolveAllowedClientDomain,
} from "./utils";

type SuperTokensRequest = Parameters<PluginRouteHandler["handler"]>[0];
type SuperTokensResponse = Parameters<PluginRouteHandler["handler"]>[1];
type SuperTokensSession = Parameters<PluginRouteHandler["handler"]>[2];
type SuperTokensUserContext = Parameters<PluginRouteHandler["handler"]>[3];
type TelemetryClient = ReturnType<typeof createClient>;

type SuperTokensUserContextWithCache = SuperTokensUserContext & {
  _default?: {
    coreCallCache?: Record<string, unknown>;
  };
};

function isBodyString(body: unknown, key: string): body is Record<string, string> {
  return isRecord(body) && typeof body[key] === "string" && body[key].length > 0;
}

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

export function handleValidatePasswordlessConfirmationBypass(
  deps: RowndRouteHandlerDeps,
) {
  return async (req: SuperTokensRequest) => {
    try {
      const body = await getJsonBody(req);
      const clientDomain = isBodyString(body, "clientDomain")
        ? body.clientDomain
        : undefined;
      const redirectToPath = isBodyString(body, "redirectToPath")
        ? body.redirectToPath
        : undefined;
      const appVariantId = isBodyString(body, "appVariantId")
        ? body.appVariantId
        : undefined;

      assertRowndAppVariantIsConfigured(appVariantId);
      const resolvedClientDomain = resolveAllowedClientDomain({
        clientDomain,
        pluginConfig: deps.pluginConfig,
        stConfig: deps.stConfig,
        request: req,
      });
      const normalizedRedirectToPath = normalizeRedirectToPathForClientDomain(
        redirectToPath,
        resolvedClientDomain,
      );
      assertAllowedBypassRedirectPath(
        deps.pluginConfig,
        normalizedRedirectToPath,
      );

      return {
        status: "OK" as const,
        bypass: true,
      };
    } catch (error) {
      logDebugMessage(
        `Passwordless confirmation bypass validation failed. Error: ${getErrorMessage(error)}`,
      );
      return {
        status: "ERROR" as const,
        bypass: false,
      };
    }
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
    let tenantId: string | undefined;

    try {
      tenantId = resolveTenantId(req);

      const body = parseGuestBody(await getJsonBody(req));
      const appVariantId = getRequestedAppVariantIdFromRequest(req);
      assertRowndAppVariantIsConfigured(appVariantId);
      const thirdPartyId =
        body.authLevel === INSTANT_AUTH_METHOD_ID
          ? INSTANT_AUTH_METHOD_ID
          : GUEST_AUTH_METHOD_ID;
      const thirdPartyUserId =
        thirdPartyId === INSTANT_AUTH_METHOD_ID
          ? `anon_${randomUUID()}`
          : guestId;
      const authLevel =
        thirdPartyId === INSTANT_AUTH_METHOD_ID
          ? INSTANT_AUTH_METHOD_ID
          : GUEST_AUTH_METHOD_ID;

      const response = await ThirdParty.manuallyCreateOrUpdateUser(
        tenantId,
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

      await recordRowndAppVariantForUser(response.user.id, appVariantId);

      await Session.createNewSession(
        req,
        res,
        tenantId,
        response.recipeUserId,
        {
          ...buildRowndAudience({}, appVariantId),
          auth_level: authLevel,
          ...([GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID].includes(authLevel) ? { is_anonymous: true } : {}),
          app_user_id: response.user.id,
        },
        {},
        userContext,
      );

      logDebugMessage(`Guest session created for user: ${response.user.id}`);
      deps.telemetryClient.recordSuccess({
        outcome: "success",
        durationMs: Date.now() - startedAt,
        tenantId,
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
        tenantId,
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
    let tenantId: string | undefined;
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

      tenantId = resolveTenantId(req);

      const parsed = await parseRequest(req);
      const appVariantId = getRequestedAppVariantIdFromRequest(req);
      assertRowndAppVariantIsConfigured(appVariantId);
      rowndUserId = await validateRowndToken(parsed.token);
      const rowndUser = await fetchOptionalRowndUserInfo(rowndUserId);

      if (!rowndUser) {
        logDebugMessage(
          `Skipping migration because user does not exist in Rownd. tenantId: ${tenantId}, rowndUserId: ${rowndUserId}`,
        );
        return { status: "OK" as const };
      }

      user = await SuperTokens.getUser(rowndUserId, userContext);

      if (!user) {
        const stUserImport = mapRowndUserToSuperTokens(
          rowndUser,
          tenantId === PUBLIC_TENANT_ID ? undefined : tenantId,
        );

        const reconciled = await reconcileRowndUserWithExistingLoginMethods(
          stUserImport,
          tenantId,
          userContext,
        );
        if (!reconciled) {
          await importUser(stUserImport, deps.stConfig.supertokens);
        }
        clearSuperTokensCoreCallCache(userContext);
        user = await SuperTokens.getUser(rowndUserId, userContext);
        if (!user) {
          throw new Error("Imported user could not be resolved");
        }
        superTokensUserId = user.id;
        recipeUserId = user.loginMethods[0]?.recipeUserId;

        logDebugMessage(
          `User migrated successfully. tenantId: ${tenantId}, rowndUserId: ${rowndUserId}`,
        );
      } else {
        superTokensUserId = user.id;
        recipeUserId = user.loginMethods[0]?.recipeUserId;
        logDebugMessage(
          `User already migrated. tenantId: ${tenantId}, rowndUserId: ${rowndUserId}`,
        );
      }

      if (superTokensUserId) {
        await recordRowndAppVariantForUser(superTokensUserId, appVariantId);
      }

      const tenantLoginMethod = user?.loginMethods.find((method) =>
        method.tenantIds.includes(tenantId!),
      );
      recipeUserId = tenantLoginMethod?.recipeUserId ?? recipeUserId;

      if (!recipeUserId) {
        throw new Error("User not found or has no login methods");
      }

      if (!tenantLoginMethod) {
        const associationResult = await MultiTenancy.associateUserToTenant(
          tenantId,
          recipeUserId,
          userContext,
        );
        if (associationResult.status !== "OK") {
          throw new Error(`Failed to associate migrated user with tenant: ${associationResult.status}`);
        }
      }

      await Session.createNewSession(
        req,
        res,
        tenantId,
        recipeUserId,
        {
          ...buildRowndAudience({}, appVariantId),
        },
        {},
        userContext,
      );

      logDebugMessage(
        `Session migrated successfully. tenantId: ${tenantId}, userId: ${superTokensUserId}`,
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

function clearSuperTokensCoreCallCache(userContext: SuperTokensUserContext) {
  const cacheContext = userContext as SuperTokensUserContextWithCache;
  if (cacheContext._default?.coreCallCache) {
    cacheContext._default.coreCallCache = {};
  }
}

export function handleGetUser() {
  return async (
    _req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
  ) => {
    const user = await getUserById(session!.getUserId(), session!.getTenantId());
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
      await updateUserData(
        session!.getUserId(),
        dataWithoutEmail,
        session!.getTenantId(),
      );
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

    const user = await getUserById(session!.getUserId(), session!.getTenantId());
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

    const user = await getUserById(session!.getUserId(), session!.getTenantId());
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

    const updateUserDataResult = await updateUserData(
      session!.getUserId(),
      { [field]: payload.value },
      session!.getTenantId(),
    );
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
