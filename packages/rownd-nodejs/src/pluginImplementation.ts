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
  NATIVE_EMAIL_VERIFICATION_UPGRADE_REQUIRED_MESSAGE,
  PUBLIC_TENANT_ID,
} from "./constants";
import { RowndEmailChangeError, RowndPluginError } from "./errors";
import { logDebugMessage } from "./logger";
import type {
  RowndEmailChangeRequestContext,
  RowndPluginNormalisedConfig,
} from "./types";
import { createClient } from "./telemetry/createTelemetryClient";
import {
  assertRowndAppVariantIsConfigured,
  buildRowndAppConfig,
  isEmailSignInEnabled,
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
      const existingMetadata = user
        ? await getUserMetadata(user.id)
        : undefined;

      if (!user || existingMetadata?.rownd_migration_complete !== true) {
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
          if (user) {
            throw new Error("Incomplete migrated user could not be reconciled");
          }
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

      const newlyAssociatedRecipeUserIds = [];
      try {
        for (const loginMethod of user?.loginMethods ?? []) {
          if (loginMethod.tenantIds.includes(tenantId)) continue;

          const associationResult = await MultiTenancy.associateUserToTenant(
            tenantId,
            loginMethod.recipeUserId,
            userContext,
          );
          if (associationResult.status !== "OK") {
            throw new Error(
              `Failed to associate migrated user with tenant: ${associationResult.status}`,
            );
          }
          if (!associationResult.wasAlreadyAssociated) {
            newlyAssociatedRecipeUserIds.push(loginMethod.recipeUserId);
          }
        }
      } catch (error) {
        await Promise.all(
          newlyAssociatedRecipeUserIds.map((associatedRecipeUserId) =>
            MultiTenancy.disassociateUserFromTenant(
              tenantId!,
              associatedRecipeUserId,
              userContext,
            ),
          ),
        );
        throw error;
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

function buildEmailChangeUserContext(
  userContext: SuperTokensUserContext,
  payloadContext?: Record<string, unknown>,
): SuperTokensUserContext & RowndEmailChangeRequestContext {
  const displayContext = payloadContext?.rowndDisplayContext;
  const emailChangeContext: RowndEmailChangeRequestContext = {
    ...(displayContext === "browser" ||
    displayContext === "mobile_app" ||
    displayContext === "customer_web_view"
      ? { rowndDisplayContext: displayContext }
      : {}),
    ...(typeof payloadContext?.rowndClientDomain === "string"
      ? { rowndClientDomain: payloadContext.rowndClientDomain }
      : {}),
    ...(typeof payloadContext?.rowndNativeEmailVerification === "boolean"
      ? {
        rowndNativeEmailVerification:
            payloadContext.rowndNativeEmailVerification,
      }
      : {}),
  };

  return {
    ...userContext,
    ...emailChangeContext,
  };
}

function nativeEmailVerificationUpgradeRequired(
  context: RowndEmailChangeRequestContext,
) {
  return (
    context.rowndDisplayContext === "mobile_app" &&
    context.rowndNativeEmailVerification !== true
  );
}

function nativeEmailVerificationUpgradeRequiredResponse() {
  return {
    status: "ERROR" as const,
    code: 426,
    message: NATIVE_EMAIL_VERIFICATION_UPGRADE_REQUIRED_MESSAGE,
  };
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

export function handleUpdateUser(deps: RowndRouteHandlerDeps) {
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
    const requestUserContext = buildEmailChangeUserContext(
      userContext,
      payload.context,
    );
    const { email, ...dataWithoutEmail } = inputData;
    const hasEmailField = hasOwn(inputData, "email");
    if (hasEmailField && (typeof email !== "string" || email.trim().length === 0)) {
      return {
        status: "ERROR" as const,
        code: 400,
        message: "email must be a non-empty string",
      };
    }
    const hasEmailUpdate = hasEmailField && typeof email === "string";
    const permissionError = validateWritableFields(
      Object.keys(dataWithoutEmail),
    );

    if (permissionError) {
      return permissionError;
    }

    const currentEmail = hasEmailUpdate
      ? (await getUserById(session!.getUserId(), session!.getTenantId())).data.email
      : undefined;
    const changesEmail = hasEmailUpdate &&
      (typeof currentEmail !== "string" ||
        currentEmail.trim().toLowerCase() !== email.trim().toLowerCase());

    if (changesEmail) {
      if (nativeEmailVerificationUpgradeRequired(requestUserContext)) {
        return nativeEmailVerificationUpgradeRequiredResponse();
      }
      const sessionError = await validateEmailChangeSession(
        deps,
        session!,
        appVariantId,
        requestUserContext,
      );
      if (sessionError) return sessionError;
    }

    if (hasEmailUpdate) {
      try {
        const pendingVerificationResult = await startPendingEmailVerification({
          userId: session!.getUserId(),
          recipeUserId: session!.getRecipeUserId(),
          initiatingSessionHandle: session!.getHandle(),
          tenantId: session!.getTenantId(),
          email,
          pendingVerificationId: randomUUID(),
          userContext: appVariantId
            ? { ...requestUserContext, rowndAppVariantId: appVariantId }
            : requestUserContext,
        });
        const updateResult = Object.keys(dataWithoutEmail).length > 0
          ? await updateUserData(
            session!.getUserId(),
            dataWithoutEmail,
            session!.getTenantId(),
          )
          : pendingVerificationResult;
        return {
          status: "OK" as const,
          ...updateResult,
        };
      } catch (error) {
        if (error instanceof RowndEmailChangeError) {
          return {
            status: "ERROR" as const,
            code: error.httpStatus,
            message: error.message,
          };
        }
        throw error;
      }
    }

    if (Object.keys(dataWithoutEmail).length > 0) {
      await updateUserData(
        session!.getUserId(),
        dataWithoutEmail,
        session!.getTenantId(),
      );
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

export function handleUpdateUserField(deps: RowndRouteHandlerDeps) {
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
    const requestUserContext = buildEmailChangeUserContext(
      userContext,
      payload.context,
    );
    if (field === "email") {
      if (typeof payload.value !== "string" || payload.value.trim().length === 0) {
        return {
          status: "ERROR" as const,
          code: 400,
          message: "email must be a non-empty string",
        };
      }

      const currentEmail = (
        await getUserById(session!.getUserId(), session!.getTenantId())
      ).data.email;
      const changesEmail =
        typeof currentEmail !== "string" ||
        currentEmail.trim().toLowerCase() !==
          payload.value.trim().toLowerCase();
      if (changesEmail) {
        if (nativeEmailVerificationUpgradeRequired(requestUserContext)) {
          return nativeEmailVerificationUpgradeRequiredResponse();
        }
        const sessionError = await validateEmailChangeSession(
          deps,
          session!,
          appVariantId,
          requestUserContext,
        );
        if (sessionError) return sessionError;
      }

      try {
        const pendingVerificationResult = await startPendingEmailVerification({
          userId: session!.getUserId(),
          recipeUserId: session!.getRecipeUserId(),
          initiatingSessionHandle: session!.getHandle(),
          tenantId: session!.getTenantId(),
          email: payload.value,
          pendingVerificationId: randomUUID(),
          userContext: appVariantId
            ? { ...requestUserContext, rowndAppVariantId: appVariantId }
            : requestUserContext,
        });
        return {
          status: "OK" as const,
          ...pendingVerificationResult,
        };
      } catch (error) {
        if (error instanceof RowndEmailChangeError) {
          return {
            status: "ERROR" as const,
            code: error.httpStatus,
            message: error.message,
          };
        }
        throw error;
      }
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

async function validateEmailChangeSession(
  deps: RowndRouteHandlerDeps,
  session: NonNullable<SuperTokensSession>,
  appVariantId: string | undefined,
  userContext: SuperTokensUserContext,
) {
  if (!isEmailSignInEnabled(deps.pluginConfig, appVariantId)) {
    return {
      status: "ERROR" as const,
      code: 403,
      message: "email sign-in is not enabled",
    };
  }
  if (
    !SuperTokens.isRecipeInitialized("passwordless") ||
    !SuperTokens.isRecipeInitialized("emailverification")
  ) {
    return {
      status: "ERROR" as const,
      code: 503,
      message: "email sign-in is not available",
    };
  }

  const authenticationTime = await session.getTimeCreated(userContext);
  const sessionAgeMs = Date.now() - authenticationTime;
  if (sessionAgeMs > deps.pluginConfig.emailChange.maxSessionAgeSeconds * 1000) {
    return recentAuthenticationRequiredResponse();
  }

  return undefined;
}

function recentAuthenticationRequiredResponse() {
  return {
    status: "ERROR" as const,
    code: 403,
    message: "recent authentication is required to change email",
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
