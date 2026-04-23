import { SuperTokensPlugin } from "supertokens-node/types";
import { createPluginInitFunction } from "@shared/js";
import { withRequestHandler } from "@shared/nodejs";
import { createInstance } from "@rownd/node";
import supertokens from "supertokens-node";
import {
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
  HANDLE_BASE_PATH,
  PUBLIC_TENANT_ID,
} from "./constants";
import { RowndPluginConfig, RowndPluginNormalisedConfig } from "./types";
import { enableDebugLogs, logDebugMessage } from "./logger";
import Session from "supertokens-node/recipe/session";
import { createClient } from "./telemetry/createTelemetryClient";
import { RowndPluginError } from "./errors";
import {
  parseRequest,
  mapRowndUserToSuperTokens,
  importUser,
  setRowndClient,
  validateRowndToken,
  fetchRowndUserInfo,
  buildRowndStyleUserResponse,
  getRowndStyleMetadata,
  updateRowndUserData,
  updateRowndUserMetadata,
} from "./pluginImplementation";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  RowndPluginConfig,
  {},
  RowndPluginNormalisedConfig
>(
  (config) => {
    const rowndClient = createInstance({
      app_key: config.rowndAppKey,
      app_secret: config.rowndAppSecret,
    });
    const telemetryClient = createClient(config.telemetry);

    setRowndClient(rowndClient);

    if (config.enableDebugLogs) {
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
      },
      routeHandlers(config) {
        const apiBasePath = config.appInfo.apiBasePath.getAsStringDangerous();
        return {
          status: "OK",
          routeHandlers: [
            {
              path: `${apiBasePath}${HANDLE_BASE_PATH}/migrate`,
              method: "post",
              handler: withRequestHandler(
                async (req, res, _session, userContext) => {
                  const startedAt = Date.now();
                  let tenantId: string | undefined = PUBLIC_TENANT_ID;
                  let rowndUserId: string | undefined;
                  let superTokensUserId: string | undefined;
                  let user: Awaited<ReturnType<typeof supertokens.getUser>>;
                  let recipeUserId:
                    | Parameters<typeof Session.createNewSession>[3]
                    | undefined;
                  try {
                    if (!config.supertokens) {
                      throw new Error("Supertokens config not found");
                    }
                    const parsed = await parseRequest(req);
                    rowndUserId = await validateRowndToken(parsed.token);
                    user = await supertokens.getUser(rowndUserId, userContext);

                    if (!user) {
                      const rowndUser = await fetchRowndUserInfo(rowndUserId);
                      const stUserImport = mapRowndUserToSuperTokens(rowndUser);
                      const importedUser = await importUser(
                        stUserImport,
                        config.supertokens,
                      );
                      superTokensUserId = importedUser.id;
                      if (importedUser.loginMethods[0]?.recipeUserId) {
                        recipeUserId = supertokens.convertToRecipeUserId(
                          importedUser.loginMethods[0].recipeUserId,
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

                    if (!recipeUserId) {
                      throw new Error("User not found or has no login methods");
                    }

                    await Session.createNewSession(
                      req,
                      res,
                      PUBLIC_TENANT_ID,
                      recipeUserId,
                      {},
                      {},
                      userContext,
                    );

                    logDebugMessage(
                      `Session migrated successfully. tenantId: ${PUBLIC_TENANT_ID}, userId: ${superTokensUserId}`,
                    );

                    telemetryClient.recordSuccess({
                      outcome: "success",
                      durationMs: Date.now() - startedAt,
                      tenantId,
                      rowndUserId,
                      superTokensUserId,
                    });

                    return { status: "OK" };
                  } catch (error) {
                    logDebugMessage(
                      `Migration failed. Error: ${
                        error instanceof Error ? error.message : "Unknown error"
                      }`,
                    );
                    telemetryClient.recordError({
                      error,
                      startedAt,
                      tenantId,
                      rowndUserId,
                      superTokensUserId,
                    });
                    return {
                      status: "ERROR",
                      message:
                        error instanceof RowndPluginError
                          ? error.message
                          : "Migration failed",
                    };
                  }
                },
              ),
            },
            {
              path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
              method: "get",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (_req, _res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const userId = session.getUserId();
                return {
                  status: "OK" as const,
                  ...(await buildRowndStyleUserResponse(userId)),
                };
              }),
            },
            {
              path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
              method: "put",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, _res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const payload = (await req.getJSONBody()) as
                  | { data?: Record<string, any> }
                  | undefined;
                return {
                  status: "OK" as const,
                  ...(await updateRowndUserData(
                    session.getUserId(),
                    payload?.data || {},
                  )),
                };
              }),
            },
            {
              path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
              method: "delete",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (_req, _res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                await supertokens.deleteUser(session.getUserId(), true);
                return { status: "OK" as const };
              }),
            },
            {
              path: `${apiBasePath}${HANDLE_BASE_PATH}/user/meta`,
              method: "get",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (_req, _res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const metadata = await getRowndStyleMetadata(
                  session.getUserId(),
                );
                return {
                  status: "OK" as const,
                  id: session.getUserId(),
                  meta: metadata.meta,
                };
              }),
            },
            {
              path: `${apiBasePath}${HANDLE_BASE_PATH}/user/meta`,
              method: "put",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, _res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const payload = (await req.getJSONBody()) as
                  | { meta?: Record<string, any> }
                  | undefined;
                return {
                  status: "OK" as const,
                  ...(await updateRowndUserMetadata(
                    session.getUserId(),
                    payload?.meta || {},
                  )),
                };
              }),
            },
            {
              path: `${apiBasePath}${HANDLE_BASE_PATH}/user/field`,
              method: "get",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, _res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const field = req.getKeyValueFromQuery("field");
                if (!field) {
                  return {
                    status: "ERROR" as const,
                    code: 400,
                    message: "field is required",
                  };
                }
                const metadata = await getRowndStyleMetadata(
                  session.getUserId(),
                );
                return {
                  status: "OK" as const,
                  value: metadata.data[field],
                };
              }),
            },
            {
              path: `${apiBasePath}${HANDLE_BASE_PATH}/user/field`,
              method: "put",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, _res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const field = req.getKeyValueFromQuery("field");
                if (!field) {
                  return {
                    status: "ERROR" as const,
                    code: 400,
                    message: "field is required",
                  };
                }
                const payload = (await req.getJSONBody()) as
                  | { value?: any }
                  | undefined;
                return {
                  status: "OK" as const,
                  ...(await updateRowndUserData(session.getUserId(), {
                    [field]: payload?.value,
                  })),
                };
              }),
            },
            // Merge/group/passkey compatibility APIs are intentionally unsupported here.
            // Those flows should be handled administratively or by dedicated backend features,
            // not via the migrated Rownd compatibility surface.
          ],
        };
      },
    };
  },
  () => ({}),
  (config: RowndPluginConfig) => {
    if (!config?.rowndAppKey || !config?.rowndAppSecret) {
      throw new Error("Missing rowndAppKey or rowndAppSecret in plugin config");
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
    };
  },
);
