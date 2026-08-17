import { SuperTokensPlugin, type UserContext } from "supertokens-node/types";
import {
  EmailVerificationClaim,
  type APIInterface as EmailVerificationAPIInterface,
} from "supertokens-node/recipe/emailverification";
import type {
  APIInterface as OAuth2ProviderAPIInterface,
  RecipeInterface as OAuth2ProviderRecipeInterface,
} from "supertokens-node/recipe/oauth2provider/types";
import type { APIInterface as PasswordlessAPIInterface } from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import type { APIInterface as ThirdPartyAPIInterface } from "supertokens-node/recipe/thirdparty";
import type {
  SessionContainerInterface,
  VerifySessionOptions,
} from "supertokens-node/recipe/session/types";
import { createPluginInitFunction } from "@shared/js";
import { withRequestHandler } from "@shared/nodejs";
import { createInstance } from "@rownd/node";
import supertokens from "supertokens-node";
import {
  HANDLE_BASE_PATH,
  HUB_VERIFY_EMAIL_PAGE_PATH,
  HUB_LOGIN_PAGE_PATH,
  PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
  ROWND_JWT_CLAIMS,
} from "./constants";
import { RowndPluginConfig, RowndPluginNormalisedConfig } from "./types";
import { enableDebugLogs, logDebugMessage } from "./logger";
import { createClient } from "./telemetry/createTelemetryClient";
import {
  assertRowndAppVariantIsConfigured,
  isEmailSignInEnabled,
  setPluginConfig,
  setSuperTokensConfig,
} from "./config";
import { RowndEmailChangeError } from "./errors";
import {
  applyRowndOAuthResourceParams,
  buildRowndOAuthPayload,
  buildRowndOAuthUserInfo,
  normalizeRowndOAuthScopes,
  shouldLinkRowndAccounts,
} from "./rownd-compatibility";
import { setRowndClient } from "./rownd-repository";
import {
  buildRowndSessionClaims,
  completePendingEmailVerification,
  addPendingEmailVerificationMarker,
  getPendingEmailVerificationIdFromUserContext,
  recordRowndAppVariantForUser,
  resolvePendingEmailVerificationToken,
  RowndIsAnonymousClaim,
} from "./supertokens-repository";
import {
  getRequestedAppVariantIdFromRequest,
  getRequestedClientDomainFromRequest,
  getRequestedDisplayContextFromRequest,
  getRequestedOAuthLoginChallengeFromRequest,
  getRequestedRedirectToPathFromRequest,
  rewriteLinkToBaseUrl,
  rewriteLinkPath,
} from "./utils";
import {
  handleDeleteUser,
  handleGetAppConfig,
  handleGetUser,
  handleGetUserField,
  handleGetUserMeta,
  handleGuestLogin,
  handleMigrate,
  handleSignOut,
  handleUpdateUser,
  handleUpdateUserField,
  handleUpdateUserMeta,
  handleValidatePasswordlessConfirmationBypass,
} from "./pluginImplementation";

const DISABLED_MIGRATION_ROWND_APP_KEY = "migration-disabled";
const PENDING_EMAIL_VERIFICATION_SESSION_ERROR =
  "email change verification requires the initiating session";

async function refreshRowndSessionClaims(input: {
  session: SessionContainerInterface;
  userId: string;
  appVariantId?: string;
  userContext: UserContext;
}) {
  const currentPayload = input.session.getAccessTokenPayload();
  const [rowndSessionClaims, rowndIsAnonymousClaim] = await Promise.all([
    buildRowndSessionClaims(
      input.userId,
      currentPayload,
      input.appVariantId,
    ),
    RowndIsAnonymousClaim.build(
      input.userId,
      input.session.getRecipeUserId(),
      input.session.getTenantId(),
      currentPayload,
      input.userContext,
    ),
  ]);
  await input.session.mergeIntoAccessTokenPayload({
    ...rowndSessionClaims,
    ...rowndIsAnonymousClaim,
    [ROWND_JWT_CLAIMS.IsAnonymous]:
      rowndSessionClaims[ROWND_JWT_CLAIMS.IsAnonymous] ?? null,
    anonymous_id: rowndSessionClaims.anonymous_id ?? null,
  });
}

function applyRowndPasswordlessRequestContext(
  req: Parameters<typeof getRequestedDisplayContextFromRequest>[0],
  userContext: UserContext,
) {
  const displayContext = getRequestedDisplayContextFromRequest(req);
  if (displayContext) {
    userContext.rowndDisplayContext = displayContext;
  }
  const redirectToPath = getRequestedRedirectToPathFromRequest(req);
  if (redirectToPath) {
    userContext.rowndRedirectToPath = redirectToPath;
  }
  const clientDomain = getRequestedClientDomainFromRequest(req);
  if (clientDomain) {
    userContext.rowndClientDomain = clientDomain;
  }
  const appVariantId = getRequestedAppVariantIdFromRequest(req);
  if (appVariantId) {
    userContext.rowndAppVariantId = appVariantId;
  }
  const oauthLoginChallenge = getRequestedOAuthLoginChallengeFromRequest(req);
  if (oauthLoginChallenge) {
    userContext.rowndOAuthLoginChallenge = oauthLoginChallenge;
  }
  assertRowndAppVariantIsConfigured(appVariantId);
}

const verifyRowndUserSessionOptions: VerifySessionOptions = {
  sessionRequired: true,
  checkDatabase: true,
  overrideGlobalClaimValidators: (validators) =>
    validators.filter((validator) => {
      return (
        !("claim" in validator) ||
        validator.claim.key !== EmailVerificationClaim.key
      );
    }),
};

const verifyRowndUserWriteSessionOptions: VerifySessionOptions = {
  ...verifyRowndUserSessionOptions,
  checkDatabase: true,
};

export const init: (config: RowndPluginConfig) => SuperTokensPlugin =
  createPluginInitFunction<
    SuperTokensPlugin,
    RowndPluginConfig,
    {},
    RowndPluginNormalisedConfig
  >(
    (pluginConfig) => {
      const rowndClient =
        !pluginConfig.disableRowndUserMigration && pluginConfig.rowndAppSecret
          ? createInstance({
            app_key: pluginConfig.rowndAppKey,
            app_secret: pluginConfig.rowndAppSecret,
          })
          : undefined;
      const telemetryClient = createClient(pluginConfig.telemetry);
      let hubBootstrapParams: Record<string, string> | undefined;

      const addHubBootstrapParams = <T extends Record<string, any>>(
        input: T,
        linkKey: keyof T,
        targetPath: string,
        additionalParams: Record<string, string> = {},
      ) => {
        const appVariantId = input?.userContext?.rowndAppVariantId as
          | string
          | undefined;
        const displayContext = input?.userContext?.rowndDisplayContext as
          | string
          | undefined;
        const redirectToPath = input?.userContext?.rowndRedirectToPath as
          | string
          | undefined;
        const clientDomain = input?.userContext?.rowndClientDomain as
          | string
          | undefined;
        const oauthLoginChallenge = input?.userContext
          ?.rowndOAuthLoginChallenge as string | undefined;
        const clientDomainKey =
          clientDomain ??
          (displayContext === "mobile_app" ? "mobile" : "browser");
        const clientBaseUrl = pluginConfig.clientDomains?.[clientDomainKey];
        const bootstrapParams = {
          appKey: pluginConfig.rowndAppKey,
          ...(hubBootstrapParams ?? {}),
          ...(input.userInputCode
            ? { passwordlessFlowType: "USER_INPUT_CODE_AND_MAGIC_LINK" }
            : {}),
          ...(typeof appVariantId === "string" ? { appVariantId } : {}),
          ...(typeof displayContext === "string" ? { displayContext } : {}),
          ...(typeof redirectToPath === "string" ? { redirectToPath } : {}),
          ...(typeof oauthLoginChallenge === "string"
            ? { oauthLoginChallenge }
            : {}),
          ...additionalParams,
        };

        if (!input[linkKey]) {
          return input;
        }

        const rewrittenLink = clientBaseUrl
          ? rewriteLinkToBaseUrl(
            input[linkKey],
            targetPath,
            clientBaseUrl,
            bootstrapParams,
          )
          : rewriteLinkPath(input[linkKey], targetPath, bootstrapParams);

        return {
          ...input,
          [linkKey]: rewrittenLink,
        };
      };

      setRowndClient(rowndClient);
      setPluginConfig(pluginConfig);

      if (pluginConfig.enableDebugLogs) {
        enableDebugLogs();
      }

      logDebugMessage("Rownd plugin init complete");

      return {
        id: PLUGIN_ID,
        compatibleSDKVersions: PLUGIN_SDK_VERSION,
        init: async () => {
          if (pluginConfig.disableRowndUserMigration) {
            console.warn(
              "RowndMigrationPlugin: Rownd user and session migration is disabled.",
            );
          }
          if (!supertokens.isRecipeInitialized("session")) {
            console.warn(
              "RowndMigrationPlugin: Session recipe is not initialized. Session migration will fail.",
            );
          }
          if (!supertokens.isRecipeInitialized("thirdparty")) {
            console.warn(
              "RowndMigrationPlugin: ThirdParty recipe is not initialized. Guest login will fail.",
            );
          }
          if (!supertokens.isRecipeInitialized("emailverification")) {
            console.warn(
              "RowndMigrationPlugin: EmailVerification recipe is not initialized. Verified email profile updates will fail.",
            );
          }
          if (
            isEmailSignInEnabled(pluginConfig) &&
            !supertokens.isRecipeInitialized("passwordless")
          ) {
            console.warn(
              "RowndMigrationPlugin: Passwordless recipe is not initialized. Email profile updates will fail.",
            );
          }
        },
        routeHandlers(stConfig) {
          setSuperTokensConfig(stConfig);
          const apiBasePath =
            stConfig.appInfo.apiBasePath.getAsStringDangerous();
          hubBootstrapParams = {
            apiDomain: stConfig.appInfo.apiDomain.getAsStringDangerous(),
            apiBasePath,
          };
          const routeHandlerDeps = {
            pluginConfig,
            stConfig,
            telemetryClient,
          };

          return {
            status: "OK" as const,
            routeHandlers: [
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/app-config`,
                method: "get" as const,
                handler: withRequestHandler(
                  handleGetAppConfig(routeHandlerDeps),
                ),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/guest`,
                method: "post" as const,
                handler: withRequestHandler(handleGuestLogin(routeHandlerDeps)),
              },
              ...(!pluginConfig.disableRowndUserMigration
                ? [
                  {
                    path: `${apiBasePath}${HANDLE_BASE_PATH}/migrate`,
                    method: "post" as const,
                    handler: withRequestHandler(
                      handleMigrate(routeHandlerDeps),
                    ),
                  },
                ]
                : []),
              {
                path: `${apiBasePath}/plugin/passwordless-cross-device-confirmation/validate`,
                method: "post" as const,
                handler: withRequestHandler(
                  handleValidatePasswordlessConfirmationBypass(
                    routeHandlerDeps,
                  ),
                ),
              },
              ...(!pluginConfig.disableRowndUserMigration
                ? [
                  {
                    path: `${apiBasePath}/plugin/migrate-session`,
                    method: "post" as const,
                    handler: withRequestHandler(
                      handleMigrate(routeHandlerDeps),
                    ),
                  },
                ]
                : []),
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/signout`,
                method: "post" as const,
                verifySessionOptions: {
                  sessionRequired: true,
                  checkDatabase: true,
                },
                handler: withRequestHandler(handleSignOut()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
                method: "get" as const,
                verifySessionOptions: verifyRowndUserSessionOptions,
                handler: withRequestHandler(handleGetUser()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
                method: "put" as const,
                verifySessionOptions: verifyRowndUserWriteSessionOptions,
                handler: withRequestHandler(handleUpdateUser(routeHandlerDeps)),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
                method: "delete" as const,
                verifySessionOptions: {
                  sessionRequired: true,
                  checkDatabase: true,
                },
                handler: withRequestHandler(handleDeleteUser()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/meta`,
                method: "get" as const,
                verifySessionOptions: {
                  sessionRequired: true,
                  checkDatabase: true,
                },
                handler: withRequestHandler(handleGetUserMeta()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/meta`,
                method: "put" as const,
                verifySessionOptions: {
                  sessionRequired: true,
                  checkDatabase: true,
                },
                handler: withRequestHandler(handleUpdateUserMeta()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/field`,
                method: "get" as const,
                verifySessionOptions: verifyRowndUserSessionOptions,
                handler: withRequestHandler(handleGetUserField()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/field`,
                method: "put" as const,
                verifySessionOptions: verifyRowndUserWriteSessionOptions,
                handler: withRequestHandler(handleUpdateUserField(routeHandlerDeps)),
              },
            ],
          };
        },
        overrideMap: {
          oauth2provider: {
            recipeInitRequired: false,
            functions: (
              originalImplementation: OAuth2ProviderRecipeInterface,
            ) => ({
              ...originalImplementation,
              getRequestedScopes: async (input) => {
                const scopes =
                  await originalImplementation.getRequestedScopes(input);
                return normalizeRowndOAuthScopes(scopes);
              },
              buildAccessTokenPayload: async (input) => {
                const payload =
                  await originalImplementation.buildAccessTokenPayload(input);
                return buildRowndOAuthPayload({
                  user: input.user,
                  client: input.client,
                  scopes: input.scopes,
                  currentPayload: payload,
                  userContext: input.userContext,
                });
              },
              buildIdTokenPayload: async (input) => {
                const payload =
                  await originalImplementation.buildIdTokenPayload(input);
                return buildRowndOAuthPayload({
                  user: input.user,
                  client: input.client,
                  scopes: input.scopes,
                  currentPayload: payload,
                  userContext: input.userContext,
                });
              },
              buildUserInfo: async (input) => {
                const payload =
                  await originalImplementation.buildUserInfo(input);
                return buildRowndOAuthUserInfo({
                  user: input.user,
                  accessTokenPayload: input.accessTokenPayload,
                  scopes: input.scopes,
                  currentPayload: payload,
                });
              },
            }),
            apis: (originalImplementation: OAuth2ProviderAPIInterface) => ({
              ...originalImplementation,
              authGET: async (input) => {
                if (originalImplementation.authGET === undefined) {
                  throw new Error("OAuth2Provider authGET is unavailable");
                }

                applyRowndOAuthResourceParams({
                  params: input.params,
                  userContext: input.userContext,
                });

                return originalImplementation.authGET(input);
              },
              tokenPOST: async (input) => {
                if (originalImplementation.tokenPOST === undefined) {
                  throw new Error("OAuth2Provider tokenPOST is unavailable");
                }

                applyRowndOAuthResourceParams({
                  params: input.body,
                  userContext: input.userContext,
                });

                return originalImplementation.tokenPOST(input);
              },
            }),
          },
          passwordless: {
            config: (config) => {
              const originalEmailDeliveryOverride =
                config.emailDelivery?.override;
              const originalSmsDeliveryOverride = config.smsDelivery?.override;

              return {
                ...config,
                emailDelivery: {
                  ...config.emailDelivery,
                  override: (originalImplementation, builder) => {
                    const implementation = originalEmailDeliveryOverride
                      ? originalEmailDeliveryOverride(
                        originalImplementation,
                        builder,
                      )
                      : originalImplementation;

                    return {
                      ...implementation,
                      sendEmail: async function (input) {
                        return implementation.sendEmail(
                          addHubBootstrapParams(
                            input,
                            "urlWithLinkCode",
                            HUB_LOGIN_PAGE_PATH,
                          ),
                        );
                      },
                    };
                  },
                },
                smsDelivery: {
                  ...config.smsDelivery,
                  override: (originalImplementation, builder) => {
                    const implementation = originalSmsDeliveryOverride
                      ? originalSmsDeliveryOverride(
                        originalImplementation,
                        builder,
                      )
                      : originalImplementation;

                    return {
                      ...implementation,
                      sendSms: async function (input) {
                        return implementation.sendSms(
                          addHubBootstrapParams(
                            input,
                            "urlWithLinkCode",
                            HUB_LOGIN_PAGE_PATH,
                          ),
                        );
                      },
                    };
                  },
                },
              };
            },
            apis: (originalImplementation: PasswordlessAPIInterface) => ({
              ...originalImplementation,
              createCodePOST: async (
                input: Parameters<
                  NonNullable<PasswordlessAPIInterface["createCodePOST"]>
                >[0],
              ) => {
                if (originalImplementation.createCodePOST === undefined) {
                  throw new Error("Passwordless createCodePOST is unavailable");
                }

                applyRowndPasswordlessRequestContext(
                  input.options.req,
                  input.userContext,
                );

                return originalImplementation.createCodePOST(input);
              },
              resendCodePOST: async (
                input: Parameters<
                  NonNullable<PasswordlessAPIInterface["resendCodePOST"]>
                >[0],
              ) => {
                if (originalImplementation.resendCodePOST === undefined) {
                  throw new Error("Passwordless resendCodePOST is unavailable");
                }

                applyRowndPasswordlessRequestContext(
                  input.options.req,
                  input.userContext,
                );

                return originalImplementation.resendCodePOST(input);
              },
              consumeCodePOST: async (
                input: Parameters<
                  NonNullable<PasswordlessAPIInterface["consumeCodePOST"]>
                >[0],
              ) => {
                if (originalImplementation.consumeCodePOST === undefined) {
                  throw new Error(
                    "Passwordless consumeCodePOST is unavailable",
                  );
                }

                const appVariantId = getRequestedAppVariantIdFromRequest(
                  input.options.req,
                );
                if (appVariantId) {
                  input.userContext.rowndAppVariantId = appVariantId;
                }
                assertRowndAppVariantIsConfigured(appVariantId);
                const response =
                  await originalImplementation.consumeCodePOST(input);

                if (response.status === "OK") {
                  await recordRowndAppVariantForUser(
                    response.user.id,
                    appVariantId,
                  );

                  await refreshRowndSessionClaims({
                    session: response.session,
                    userId: response.user.id,
                    appVariantId,
                    userContext: input.userContext,
                  });
                }

                return response;
              },
            }),
          },
          thirdparty: {
            apis: (originalImplementation: ThirdPartyAPIInterface) => ({
              ...originalImplementation,
              signInUpPOST: async (
                input: Parameters<
                  NonNullable<ThirdPartyAPIInterface["signInUpPOST"]>
                >[0],
              ) => {
                if (originalImplementation.signInUpPOST === undefined) {
                  throw new Error("ThirdParty signInUpPOST is unavailable");
                }

                const appVariantId = getRequestedAppVariantIdFromRequest(
                  input.options.req,
                );
                if (appVariantId) {
                  input.userContext.rowndAppVariantId = appVariantId;
                }
                assertRowndAppVariantIsConfigured(appVariantId);
                const response =
                  await originalImplementation.signInUpPOST(input);

                if (response.status === "OK") {
                  await recordRowndAppVariantForUser(
                    response.user.id,
                    appVariantId,
                  );
                  await refreshRowndSessionClaims({
                    session: response.session,
                    userId: response.user.id,
                    appVariantId,
                    userContext: input.userContext,
                  });
                }

                return response;
              },
            }),
          },
          accountlinking: {
            recipeInitRequired: true,
            config: (config) => {
              const originalShouldDoAutomaticAccountLinking =
                config.shouldDoAutomaticAccountLinking;

              return {
                ...config,
                shouldDoAutomaticAccountLinking: async (...input) => {
                  if (
                    input[4]?.rowndDisableAutomaticAccountLinking === true
                  ) {
                    return {
                      shouldAutomaticallyLink: false,
                      shouldRequireVerification: false,
                    };
                  }
                  const rowndLinkingDecision =
                    await shouldLinkRowndAccounts(input);
                  if (rowndLinkingDecision) {
                    return rowndLinkingDecision;
                  }

                  if (originalShouldDoAutomaticAccountLinking) {
                    return originalShouldDoAutomaticAccountLinking(...input);
                  }

                  return {
                    shouldAutomaticallyLink: false,
                    shouldRequireVerification: false,
                  };
                },
              };
            },
          },
          session: {
            recipeInitRequired: true,
            functions: (originalImplementation) => ({
              ...originalImplementation,
              createNewSession: async (input) => {
                const appVariantId =
                  typeof input.userContext.rowndAppVariantId === "string"
                    ? input.userContext.rowndAppVariantId
                    : undefined;
                const [rowndSessionClaims, rowndIsAnonymousClaim] =
                  await Promise.all([
                    buildRowndSessionClaims(
                      input.userId,
                      input.accessTokenPayload,
                      appVariantId,
                    ),
                    RowndIsAnonymousClaim.build(
                      input.userId,
                      input.recipeUserId,
                      input.tenantId,
                      input.accessTokenPayload,
                      input.userContext,
                    ),
                  ]);
                input.accessTokenPayload = {
                  ...input.accessTokenPayload,
                  ...rowndSessionClaims,
                  ...rowndIsAnonymousClaim,
                };

                return originalImplementation.createNewSession(input);
              },
            }),
          },
          emailverification: {
            recipeInitRequired: true,
            config: (config) => {
              const originalEmailDeliveryOverride =
                config.emailDelivery?.override;

              return {
                ...config,
                emailDelivery: {
                  ...config.emailDelivery,
                  override: (originalImplementation, builder) => {
                    const implementation = originalEmailDeliveryOverride
                      ? originalEmailDeliveryOverride(
                        originalImplementation,
                        builder,
                      )
                      : originalImplementation;

                    return {
                      ...implementation,
                      sendEmail: async (input) => {
                        const pendingVerificationId =
                          getPendingEmailVerificationIdFromUserContext(
                            input.userContext,
                          );
                        const deliveryInput = pendingVerificationId
                          ? {
                            ...input,
                            emailVerifyLink:
                              addPendingEmailVerificationMarker({
                                pendingVerificationId,
                                emailVerifyLink: input.emailVerifyLink,
                              }),
                          }
                          : input;
                        return implementation.sendEmail({
                          ...addHubBootstrapParams(
                            deliveryInput,
                            "emailVerifyLink",
                            HUB_VERIFY_EMAIL_PAGE_PATH,
                            pendingVerificationId
                              ? {
                                [PENDING_EMAIL_VERIFICATION_QUERY_PARAM]:
                                  pendingVerificationId,
                              }
                              : {},
                          ),
                        });
                      },
                    };
                  },
                },
              };
            },
            apis: (originalImplementation: EmailVerificationAPIInterface) => ({
              ...originalImplementation,
              verifyEmailPOST: async (
                input: Parameters<
                  NonNullable<EmailVerificationAPIInterface["verifyEmailPOST"]>
                >[0],
              ) => {
                if (originalImplementation.verifyEmailPOST === undefined) {
                  throw new Error(
                    "EmailVerification verifyEmailPOST is unavailable",
                  );
                }

                const pendingVerificationId =
                  input.options.req.getKeyValueFromQuery(
                    PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
                  );
                const pendingToken =
                  await resolvePendingEmailVerificationToken({
                    token: input.token,
                    queryPendingVerificationId: pendingVerificationId,
                    tenantId: input.tenantId,
                    session: input.session,
                    userContext: input.userContext,
                  });
                if (pendingToken.status === "INVALID_PENDING") {
                  return {
                    status: "GENERAL_ERROR" as const,
                    message: PENDING_EMAIL_VERIFICATION_SESSION_ERROR,
                  };
                }

                const response = await originalImplementation.verifyEmailPOST(
                  pendingToken.status === "OK"
                    ? { ...input, token: pendingToken.coreToken }
                    : input,
                );
                if (response.status === "OK" && pendingToken.status === "OK") {
                  let verificationResult;
                  try {
                    verificationResult = await completePendingEmailVerification({
                      recipeUserId: response.user.recipeUserId,
                      email: response.user.email,
                      tenantId: input.tenantId,
                      sessionHandle: input.session?.getHandle(),
                      pendingVerificationId:
                        pendingToken.pendingVerificationId,
                      pendingUserId: pendingToken.userId,
                      userContext: input.userContext,
                    });
                  } catch (error) {
                    if (error instanceof RowndEmailChangeError) {
                      return {
                        status: "GENERAL_ERROR" as const,
                        message: error.message,
                      };
                    }
                    throw error;
                  }

                  const session = input.session;
                  const shouldReplaceSession =
                    session &&
                    verificationResult &&
                    session.getHandle() ===
                      verificationResult.initiatingSessionHandle;

                  if (shouldReplaceSession && verificationResult) {
                    try {
                      response.newSession = await Session.createNewSession(
                        input.options.req,
                        input.options.res,
                        session.getTenantId(input.userContext),
                        verificationResult.recipeUserId,
                        {},
                        {},
                        input.userContext,
                      );
                    } catch (error) {
                      await verificationResult
                        .rollbackOnSessionReplacementFailure();
                      throw error;
                    }
                  }
                }

                return response;
              },
            }),
          },
        },
      };
    },
    () => ({}),
    (config: RowndPluginConfig) => {
      if (
        config?.disableRowndUserMigration !== undefined &&
        typeof config.disableRowndUserMigration !== "boolean"
      ) {
        throw new Error(
          "disableRowndUserMigration must be a boolean in plugin config",
        );
      }
      if (
        !config?.disableRowndUserMigration &&
        (!config?.rowndAppKey || !config?.rowndAppSecret)
      ) {
        throw new Error(
          "Missing rowndAppKey or rowndAppSecret in plugin config. Set disableRowndUserMigration to true to disable migration.",
        );
      }
      if (config.telemetry?.provider === "axiom") {
        if (!config.telemetry.token || !config.telemetry.dataset) {
          throw new Error(
            "Missing telemetry axiom token or dataset in plugin config",
          );
        }
      }
      if (config.telemetry?.provider === "custom") {
        if (typeof config.telemetry.factory !== "function") {
          throw new Error(
            "Missing telemetry custom factory function in plugin config",
          );
        }
      }
      if (
        config.emailChange?.maxSessionAgeSeconds !== undefined &&
        (!Number.isFinite(config.emailChange.maxSessionAgeSeconds) ||
          config.emailChange.maxSessionAgeSeconds <= 0)
      ) {
        throw new Error(
          "emailChange.maxSessionAgeSeconds must be a positive number",
        );
      }
      for (const [key, value] of Object.entries(config.clientDomains ?? {})) {
        validateClientDomainUrl(key, value);
      }
      return {
        rowndAppKey: config.rowndAppKey ?? DISABLED_MIGRATION_ROWND_APP_KEY,
        rowndAppSecret: config.rowndAppSecret,
        disableRowndUserMigration: config.disableRowndUserMigration === true,
        enableDebugLogs: config.enableDebugLogs,
        clientDomains: config.clientDomains,
        crossDeviceConfirmationBypass: config.crossDeviceConfirmationBypass,
        telemetry: config.telemetry,
        schema: config.schema,
        appConfig: config.appConfig,
        subBrands: config.subBrands,
        emailChange: {
          maxSessionAgeSeconds: config.emailChange?.maxSessionAgeSeconds ?? 600,
        },
      };
    },
  );

function validateClientDomainUrl(key: string, value: string) {
  try {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
    ) {
      throw new Error();
    }
    new URL(value);
  } catch {
    throw new Error(`Invalid clientDomains.${key} in plugin config`);
  }
}
