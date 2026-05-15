import { SuperTokensPlugin } from "supertokens-node/types";
import type { APIInterface as EmailVerificationAPIInterface } from "supertokens-node/recipe/emailverification";
import { createPluginInitFunction } from "@shared/js";
import { withRequestHandler } from "@shared/nodejs";
import { createInstance } from "@rownd/node";
import supertokens from "supertokens-node";
import { HANDLE_BASE_PATH, PLUGIN_ID, PLUGIN_SDK_VERSION } from "./constants";
import { RowndPluginConfig, RowndPluginNormalisedConfig } from "./types";
import { enableDebugLogs, logDebugMessage } from "./logger";
import { createClient } from "./telemetry/createTelemetryClient";
import {
  setRowndClient,
  setPluginConfig,
  buildRowndSessionClaims,
  completePendingEmailVerification,
  RowndIsAnonymousClaim,
  handleDeleteUser,
  handleGetAppConfig,
  handleGetUser,
  handleGetUserField,
  handleGetUserMeta,
  handleGuestLogin,
  handleMigrate,
  handleUpdateUser,
  handleUpdateUserField,
  handleUpdateUserMeta,
  shouldLinkRowndAccounts,
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
          accountlinking: {
            recipeInitRequired: true,
            config: (config) => {
              const originalShouldDoAutomaticAccountLinking =
                config.shouldDoAutomaticAccountLinking;

              return {
                ...config,
                shouldDoAutomaticAccountLinking: async (...input) => {
                  const rowndLinkingDecision = shouldLinkRowndAccounts(input);
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
                input.accessTokenPayload = {
                  ...input.accessTokenPayload,
                  ...(await buildRowndSessionClaims(input.userId)),
                  ...(await RowndIsAnonymousClaim.build(
                    input.userId,
                    input.recipeUserId,
                    input.tenantId,
                    input.accessTokenPayload,
                    input.userContext,
                  )),
                };

                return originalImplementation.createNewSession(input);
              },
            }),
          },
          emailverification: {
            recipeInitRequired: true,
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
      return {
        rowndAppKey: config.rowndAppKey,
        rowndAppSecret: config.rowndAppSecret,
        enableDebugLogs: config.enableDebugLogs,
        telemetry: config.telemetry,
        schema: config.schema,
        appConfig: config.appConfig,
      };
    },
  );
