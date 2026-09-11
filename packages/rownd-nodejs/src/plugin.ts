import { SuperTokensPlugin } from "supertokens-node/types";
import type { APIInterface as EmailVerificationAPIInterface } from "supertokens-node/recipe/emailverification";
import type { APIInterface as PasswordlessAPIInterface } from "supertokens-node/recipe/passwordless";
import type { APIInterface as ThirdPartyAPIInterface } from "supertokens-node/recipe/thirdparty";
import { createPluginInitFunction } from "@shared/js";
import { withRequestHandler } from "@shared/nodejs";
import { createInstance } from "@rownd/node";
import supertokens from "supertokens-node";
import {
  HANDLE_BASE_PATH,
  HUB_VERIFY_EMAIL_PAGE_PATH,
  HUB_LOGIN_PAGE_PATH,
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
} from "./constants";
import { RowndPluginConfig, RowndPluginNormalisedConfig } from "./types";
import { enableDebugLogs, logDebugMessage } from "./logger";
import { createClient } from "./telemetry/createTelemetryClient";
import { assertRowndAppVariantIsConfigured, setPluginConfig } from "./config";
import { shouldLinkRowndAccounts } from "./rownd-compatibility";
import { setRowndClient } from "./rownd-repository";
import {
  buildRowndSessionClaims,
  completePendingEmailVerification,
  recordRowndAppVariantForUser,
  RowndIsAnonymousClaim,
} from "./supertokens-repository";
import {
  getRequestedAppVariantIdFromRequest,
  getRequestedClientDomainFromRequest,
  getRequestedDisplayContextFromRequest,
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
} from "./pluginImplementation";

export const init: (config: RowndPluginConfig) => SuperTokensPlugin =
  createPluginInitFunction<
    SuperTokensPlugin,
    RowndPluginConfig,
    {},
    RowndPluginNormalisedConfig
  >(
    (pluginConfig) => {
      const rowndClient = createInstance({
        app_key: pluginConfig.rowndAppKey,
        app_secret: pluginConfig.rowndAppSecret,
      });
      const telemetryClient = createClient(pluginConfig.telemetry);
      let hubBootstrapParams: Record<string, string> | undefined;

      const addHubBootstrapParams = <T extends Record<string, any>>(
        input: T,
        linkKey: keyof T,
        targetPath: string,
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
        const clientDomainKey =
          clientDomain ?? (displayContext === "mobile_app" ? "mobile" : "browser");
        const clientBaseUrl = pluginConfig.clientDomains?.[clientDomainKey];
        const bootstrapParams = {
          appKey: pluginConfig.rowndAppKey,
          ...(hubBootstrapParams ?? {}),
          ...(typeof appVariantId === "string" ? { appVariantId } : {}),
          ...(typeof displayContext === "string" ? { displayContext } : {}),
          ...(typeof redirectToPath === "string" ? { redirectToPath } : {}),
        };

        const rewrittenLink = input[linkKey]
          ? clientBaseUrl
            ? rewriteLinkToBaseUrl(
              input[linkKey],
              targetPath,
              clientBaseUrl,
              bootstrapParams,
            )
            : rewriteLinkPath(input[linkKey], targetPath, bootstrapParams)
          : input[linkKey];

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
        },
        routeHandlers(stConfig) {
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
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/migrate`,
                method: "post" as const,
                handler: withRequestHandler(handleMigrate(routeHandlerDeps)),
              },
              {
                path: `${apiBasePath}/plugin/migrate-session`,
                method: "post" as const,
                handler: withRequestHandler(handleMigrate(routeHandlerDeps)),
              },
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
                verifySessionOptions: { sessionRequired: true },
                handler: withRequestHandler(handleGetUser()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
                method: "put" as const,
                verifySessionOptions: { sessionRequired: true },
                handler: withRequestHandler(handleUpdateUser()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
                method: "delete" as const,
                verifySessionOptions: { sessionRequired: true },
                handler: withRequestHandler(handleDeleteUser()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/meta`,
                method: "get" as const,
                verifySessionOptions: { sessionRequired: true },
                handler: withRequestHandler(handleGetUserMeta()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/meta`,
                method: "put" as const,
                verifySessionOptions: { sessionRequired: true },
                handler: withRequestHandler(handleUpdateUserMeta()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/field`,
                method: "get" as const,
                verifySessionOptions: { sessionRequired: true },
                handler: withRequestHandler(handleGetUserField()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/field`,
                method: "put" as const,
                verifySessionOptions: { sessionRequired: true },
                handler: withRequestHandler(handleUpdateUserField()),
              },
            ],
          };
        },
        overrideMap: {
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

                const displayContext = getRequestedDisplayContextFromRequest(
                  input.options.req,
                );
                if (displayContext) {
                  input.userContext.rowndDisplayContext = displayContext;
                }
                const redirectToPath = getRequestedRedirectToPathFromRequest(
                  input.options.req,
                );
                if (redirectToPath) {
                  input.userContext.rowndRedirectToPath = redirectToPath;
                }
                const clientDomain = getRequestedClientDomainFromRequest(
                  input.options.req,
                );
                if (clientDomain) {
                  input.userContext.rowndClientDomain = clientDomain;
                }
                const appVariantId = getRequestedAppVariantIdFromRequest(
                  input.options.req,
                );
                if (appVariantId) {
                  input.userContext.rowndAppVariantId = appVariantId;
                }
                assertRowndAppVariantIsConfigured(appVariantId);

                return originalImplementation.createCodePOST(input);
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
                const [rowndSessionClaims, rowndIsAnonymousClaim] =
                  await Promise.all([
                    buildRowndSessionClaims(
                      input.userId,
                      input.accessTokenPayload,
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
                        return implementation.sendEmail({
                          ...addHubBootstrapParams(
                            input,
                            "emailVerifyLink",
                            HUB_VERIFY_EMAIL_PAGE_PATH,
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

                const response =
                  await originalImplementation.verifyEmailPOST(input);
                if (response.status === "OK") {
                  await completePendingEmailVerification({
                    recipeUserId: response.user.recipeUserId,
                    email: response.user.email,
                    userContext: input.userContext,
                  });
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
      if (!config?.rowndAppKey || !config?.rowndAppSecret) {
        throw new Error(
          "Missing rowndAppKey or rowndAppSecret in plugin config",
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
      for (const [key, value] of Object.entries(config.clientDomains ?? {})) {
        validateClientDomainUrl(key, value);
      }
      return {
        rowndAppKey: config.rowndAppKey,
        rowndAppSecret: config.rowndAppSecret,
        enableDebugLogs: config.enableDebugLogs,
        clientDomains: config.clientDomains,
        telemetry: config.telemetry,
        schema: config.schema,
        appConfig: config.appConfig,
        subBrands: config.subBrands,
      };
    },
  );

function validateClientDomainUrl(key: string, value: string) {
  try {
    if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
      throw new Error();
    }
    new URL(value);
  } catch {
    throw new Error(`Invalid clientDomains.${key} in plugin config`);
  }
}
