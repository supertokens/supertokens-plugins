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
  resolvePluginConfigSnapshot,
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
  clearSuperTokensCoreCallCache,
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
  createDerivedUserContext,
} from "./utils";

type SuperTokensRequest = Parameters<PluginRouteHandler["handler"]>[0];
type SuperTokensResponse = Parameters<PluginRouteHandler["handler"]>[1];
type SuperTokensSession = Parameters<PluginRouteHandler["handler"]>[2];
type SuperTokensUserContext = Parameters<PluginRouteHandler["handler"]>[3];
type TelemetryClient = ReturnType<typeof createClient>;

function isBodyString(
  body: unknown,
  key: string,
): body is Record<string, string> {
  return (
    isRecord(body) && typeof body[key] === "string" && body[key].length > 0
  );
}

export type RowndRouteHandlerDeps = {
  pluginConfig: RowndPluginNormalisedConfig;
  stConfig: SuperTokensPublicConfig;
  telemetryClient: TelemetryClient;
};

export function handleGetAppConfig(deps: RowndRouteHandlerDeps) {
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    _session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const resolved = await resolvePluginConfigSnapshot(deps.pluginConfig, {
      tenantId: resolveTenantId(req),
      request: req,
      userContext,
    });
    const appVariantId = getRequestedAppVariantIdFromRequest(req);
    const appConfig = buildRowndAppConfig(
      resolved.config,
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
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    _session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    try {
      const resolved = await resolvePluginConfigSnapshot(deps.pluginConfig, {
        tenantId: resolveTenantId(req),
        request: req,
        userContext,
      });
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

      assertRowndAppVariantIsConfigured(resolved.config, appVariantId);
      const resolvedClientDomain = resolveAllowedClientDomain({
        clientDomain,
        pluginConfig: resolved.config,
        stConfig: deps.stConfig,
        request: req,
      });
      const normalizedRedirectToPath = normalizeRedirectToPathForClientDomain(
        redirectToPath,
        resolvedClientDomain,
      );
      assertAllowedBypassRedirectPath(
        resolved.config,
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
      const resolved = await resolvePluginConfigSnapshot(deps.pluginConfig, {
        tenantId,
        request: req,
        userContext,
      });

      const body = parseGuestBody(await getJsonBody(req));
      const appVariantId = getRequestedAppVariantIdFromRequest(req);
      assertRowndAppVariantIsConfigured(resolved.config, appVariantId);
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
        resolved.userContext,
      );

      if (response.status !== "OK") {
        throw new Error(
          `Guest user creation failed with status: ${response.status}`,
        );
      }

      await recordRowndAppVariantForUser(
        response.user.id,
        appVariantId,
        resolved.userContext,
        tenantId,
      );

      await Session.createNewSession(
        req,
        res,
        tenantId,
        response.recipeUserId,
        {
          ...buildRowndAudience({}, appVariantId, resolved.config),
          auth_level: authLevel,
          ...([GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID].includes(authLevel)
            ? { is_anonymous: true }
            : {}),
          app_user_id: response.user.id,
        },
        {},
        resolved.userContext,
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
      Parameters<typeof Session.createNewSession>[3] | undefined;

    try {
      if (!deps.stConfig.supertokens) {
        throw new Error("Supertokens config not found");
      }

      tenantId = resolveTenantId(req);
      const resolved = await resolvePluginConfigSnapshot(deps.pluginConfig, {
        tenantId,
        request: req,
        userContext,
      });

      const parsed = await parseRequest(req);
      const appVariantId = getRequestedAppVariantIdFromRequest(req);
      assertRowndAppVariantIsConfigured(resolved.config, appVariantId);
      rowndUserId = await validateRowndToken(parsed.token);
      const rowndUser = await fetchOptionalRowndUserInfo(rowndUserId);

      if (!rowndUser) {
        logDebugMessage(
          `Skipping migration because user does not exist in Rownd. tenantId: ${tenantId}, rowndUserId: ${rowndUserId}`,
        );
        return { status: "OK" as const };
      }

      user = await SuperTokens.getUser(rowndUserId, resolved.userContext);
      const existingMetadata = user
        ? await getUserMetadata(user.id, resolved.userContext)
        : undefined;

      if (!user || existingMetadata?.rownd_migration_complete !== true) {
        const stUserImport = mapRowndUserToSuperTokens(
          rowndUser,
          tenantId === PUBLIC_TENANT_ID ? undefined : tenantId,
        );

        const reconciled = await reconcileRowndUserWithExistingLoginMethods(
          stUserImport,
          tenantId,
          resolved.userContext,
        );
        if (!reconciled) {
          if (user) {
            throw new Error("Incomplete migrated user could not be reconciled");
          }
          await importUser(stUserImport, deps.stConfig.supertokens);
        }
        clearSuperTokensCoreCallCache(resolved.userContext);
        user = await SuperTokens.getUser(rowndUserId, resolved.userContext);
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
        await recordRowndAppVariantForUser(
          superTokensUserId,
          appVariantId,
          resolved.userContext,
          tenantId,
        );
      }

      const tenantLoginMethod = user?.loginMethods.find((method) =>
        method.tenantIds.includes(tenantId!),
      );
      recipeUserId = tenantLoginMethod?.recipeUserId ?? recipeUserId;

      if (!recipeUserId) {
        throw new Error("User not found or has no login methods");
      }

      if (user) {
        await associateUserLoginMethodsToTenant(
          user,
          tenantId,
          resolved.userContext,
        );
      }

      await Session.createNewSession(
        req,
        res,
        tenantId,
        recipeUserId,
        {
          ...buildRowndAudience({}, appVariantId, resolved.config),
        },
        {},
        resolved.userContext,
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

export async function associateUserLoginMethodsToTenant(
  user: NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>,
  tenantId: string,
  userContext: SuperTokensUserContext,
) {
  for (const loginMethod of user.loginMethods) {
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
  }
}

function getEmailChangeUserContextValues(
  payloadContext?: Record<string, unknown>,
): RowndEmailChangeRequestContext {
  const displayContext = payloadContext?.rowndDisplayContext;
  const emailChangeContext: RowndEmailChangeRequestContext = {
    rowndDisplayContext:
      displayContext === "browser" ||
      displayContext === "mobile_app" ||
      displayContext === "customer_web_view"
        ? displayContext
        : undefined,
    rowndClientDomain:
      typeof payloadContext?.rowndClientDomain === "string"
        ? payloadContext.rowndClientDomain
        : undefined,
    rowndNativeEmailVerification:
      typeof payloadContext?.rowndNativeEmailVerification === "boolean"
        ? payloadContext.rowndNativeEmailVerification
        : undefined,
  };

  return emailChangeContext;
}

function nativeEmailVerificationUpgradeRequired(context: Record<string, any>) {
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

export function handleGetUser(deps: RowndRouteHandlerDeps) {
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const resolved = await resolvePluginConfigSnapshot(deps.pluginConfig, {
      tenantId: session!.getTenantId(userContext),
      request: req,
      userContext,
    });
    const user = await getUserById(
      session!.getUserId(resolved.userContext),
      session!.getTenantId(resolved.userContext),
      resolved.userContext,
    );
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
    const tenantId = session!.getTenantId(userContext);
    const resolved = await resolvePluginConfigSnapshot(deps.pluginConfig, {
      tenantId,
      request: req,
      userContext,
    });
    const appVariantId = getRequestedAppVariantIdFromRequest(req);
    assertRowndAppVariantIsConfigured(resolved.config, appVariantId);
    const payload = parseUpdateUserBody(await getJsonBody(req));
    const inputData = payload.data ?? {};
    const operationContext = createDerivedUserContext(resolved.userContext, {
      ...getEmailChangeUserContextValues(payload.context),
      rowndAppVariantId: appVariantId,
    });
    {
      const { email, ...dataWithoutEmail } = inputData;
      const hasEmailField = hasOwn(inputData, "email");
      if (
        hasEmailField &&
        (typeof email !== "string" || email.trim().length === 0)
      ) {
        return {
          status: "ERROR" as const,
          code: 400,
          message: "email must be a non-empty string",
        };
      }
      const hasEmailUpdate = hasEmailField && typeof email === "string";
      const permissionError = validateWritableFields(
        Object.keys(dataWithoutEmail),
        resolved.config,
      );

      if (permissionError) {
        return permissionError;
      }

      const currentEmail = hasEmailUpdate
        ? (
          await getUserById(
              session!.getUserId(operationContext),
              session!.getTenantId(operationContext),
              operationContext,
          )
        ).data.email
        : undefined;
      const changesEmail =
        hasEmailUpdate &&
        (typeof currentEmail !== "string" ||
          currentEmail.trim().toLowerCase() !== email.trim().toLowerCase());

      if (changesEmail) {
        if (nativeEmailVerificationUpgradeRequired(operationContext)) {
          return nativeEmailVerificationUpgradeRequiredResponse();
        }
        const sessionError = await validateEmailChangeSession(
          { ...deps, pluginConfig: resolved.config },
          session!,
          appVariantId,
          operationContext,
        );
        if (sessionError) return sessionError;
      }

      if (hasEmailUpdate) {
        try {
          const pendingVerificationResult = await startPendingEmailVerification(
            {
              userId: session!.getUserId(operationContext),
              recipeUserId: session!.getRecipeUserId(operationContext),
              initiatingSessionHandle: session!.getHandle(operationContext),
              tenantId: session!.getTenantId(operationContext),
              email,
              pendingVerificationId: randomUUID(),
              userContext: operationContext,
            },
          );
          const updateResult =
            Object.keys(dataWithoutEmail).length > 0
              ? await updateUserData(
                  session!.getUserId(operationContext),
                  dataWithoutEmail,
                  session!.getTenantId(operationContext),
                  operationContext,
              )
              : pendingVerificationResult;
          return {
            status: "OK" as const,
            ...updateResult,
            email_verification_pending: changesEmail,
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
          session!.getUserId(operationContext),
          dataWithoutEmail,
          session!.getTenantId(operationContext),
          operationContext,
        );
      }

      const user = await getUserById(
        session!.getUserId(operationContext),
        session!.getTenantId(operationContext),
        operationContext,
      );
      return {
        status: "OK" as const,
        ...user,
      };
    }
  };
}

export function handleDeleteUser() {
  return async (
    _req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    await SuperTokens.deleteUser(
      session!.getUserId(userContext),
      true,
      userContext,
    );
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
      session!.getUserId(userContext),
      true,
      session!.getTenantId(userContext),
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
    userContext: SuperTokensUserContext,
  ) => {
    const metadata = await getUserMetadata(
      session!.getUserId(userContext),
      userContext,
    );
    return {
      status: "OK" as const,
      id: session!.getUserId(userContext),
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
    userContext: SuperTokensUserContext,
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
      session!.getUserId(userContext),
      payload.meta ?? {},
      userContext,
    );
    return {
      status: "OK" as const,
      ...updateMetadataResult,
    };
  };
}

export function handleGetUserField(deps: RowndRouteHandlerDeps) {
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const resolved = await resolvePluginConfigSnapshot(deps.pluginConfig, {
      tenantId: session!.getTenantId(userContext),
      request: req,
      userContext,
    });
    const field = req.getKeyValueFromQuery("field");
    if (!field) {
      return missingFieldResponse();
    }

    const user = await getUserById(
      session!.getUserId(resolved.userContext),
      session!.getTenantId(resolved.userContext),
      resolved.userContext,
    );
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
    const tenantId = session!.getTenantId(userContext);
    const resolved = await resolvePluginConfigSnapshot(deps.pluginConfig, {
      tenantId,
      request: req,
      userContext,
    });
    const appVariantId = getRequestedAppVariantIdFromRequest(req);
    assertRowndAppVariantIsConfigured(resolved.config, appVariantId);
    const field = req.getKeyValueFromQuery("field");
    if (!field) {
      return missingFieldResponse();
    }

    const payload = parseUpdateFieldBody(await getJsonBody(req));
    const operationContext = createDerivedUserContext(resolved.userContext, {
      ...getEmailChangeUserContextValues(payload.context),
      rowndAppVariantId: appVariantId,
    });
    {
      if (field === "email") {
        if (
          typeof payload.value !== "string" ||
          payload.value.trim().length === 0
        ) {
          return {
            status: "ERROR" as const,
            code: 400,
            message: "email must be a non-empty string",
          };
        }

        const currentEmail = (
          await getUserById(
            session!.getUserId(operationContext),
            session!.getTenantId(operationContext),
            operationContext,
          )
        ).data.email;
        const changesEmail =
          typeof currentEmail !== "string" ||
          currentEmail.trim().toLowerCase() !==
            payload.value.trim().toLowerCase();
        if (changesEmail) {
          if (nativeEmailVerificationUpgradeRequired(operationContext)) {
            return nativeEmailVerificationUpgradeRequiredResponse();
          }
          const sessionError = await validateEmailChangeSession(
            { ...deps, pluginConfig: resolved.config },
            session!,
            appVariantId,
            operationContext,
          );
          if (sessionError) return sessionError;
        }

        try {
          const pendingVerificationResult = await startPendingEmailVerification(
            {
              userId: session!.getUserId(operationContext),
              recipeUserId: session!.getRecipeUserId(operationContext),
              initiatingSessionHandle: session!.getHandle(operationContext),
              tenantId: session!.getTenantId(operationContext),
              email: payload.value,
              pendingVerificationId: randomUUID(),
              userContext: operationContext,
            },
          );
          return {
            status: "OK" as const,
            ...pendingVerificationResult,
            email_verification_pending: changesEmail,
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

      const permissionError = validateWritableFields([field], resolved.config);
      if (permissionError) {
        return permissionError;
      }

      const updateUserDataResult = await updateUserData(
        session!.getUserId(operationContext),
        { [field]: payload.value },
        session!.getTenantId(operationContext),
        operationContext,
      );
      return {
        status: "OK" as const,
        ...updateUserDataResult,
      };
    }
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
  if (
    sessionAgeMs >
    deps.pluginConfig.emailChange.maxSessionAgeSeconds * 1000
  ) {
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

function validateWritableFields(
  fields: string[],
  pluginConfig?: RowndPluginNormalisedConfig,
) {
  const readOnlyField = fields.find(
    (field) => !canUpdateUserDataField(field, pluginConfig),
  );

  if (!readOnlyField) {
    return undefined;
  }

  return {
    status: "ERROR" as const,
    code: 403,
    message: `field is not writable: ${readOnlyField}`,
  };
}
