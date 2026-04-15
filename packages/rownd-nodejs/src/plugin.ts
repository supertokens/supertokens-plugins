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
import {
  parseRequest,
  mapRowndUserToSuperTokens,
  importUser,
  setRowndClient,
  validateRowndToken,
  fetchRowndUserInfo,
  findSuperTokensUserIdByRowndUserId,
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
              path: `${apiBasePath}${HANDLE_BASE_PATH}/migrate-user`,
              method: "post",
              handler: withRequestHandler(async (req) => {
                const startedAt = Date.now();
                let tenantId: string | undefined = PUBLIC_TENANT_ID;
                let rowndUserId: string | undefined;
                let superTokensUserId: string | undefined;
                try {
                  if (!config.supertokens) {
                    throw new Error("Supertokens config not found");
                  }
                  const parsed = await parseRequest(req);
                  rowndUserId = await validateRowndToken(parsed.token);
                  const existingUserId =
                    await findSuperTokensUserIdByRowndUserId(rowndUserId);
                  if (existingUserId) {
                    logDebugMessage(
                      `User already migrated. tenantId: ${PUBLIC_TENANT_ID}, rowndUserId: ${rowndUserId}`,
                    );
                    telemetryClient.recordSuccess({
                      outcome: "success",
                      operation: "migrate-user",
                      durationMs: Date.now() - startedAt,
                      tenantId,
                      rowndUserId,
                      superTokensUserId: existingUserId,
                    });
                    return { status: "OK" };
                  }
                  const rowndUser = await fetchRowndUserInfo(rowndUserId);
                  const stUserImport = mapRowndUserToSuperTokens(rowndUser);
                  superTokensUserId = await importUser(
                    stUserImport,
                    config.supertokens,
                  );
                  logDebugMessage(
                    `User migrated successfully. tenantId: ${PUBLIC_TENANT_ID}, rowndUserId: ${rowndUser.data?.user_id}`,
                  );

                  telemetryClient.recordSuccess({
                    outcome: "success",
                    operation: "migrate-user",
                    durationMs: Date.now() - startedAt,
                    tenantId,
                    rowndUserId,
                    superTokensUserId,
                  });

                  return { status: "OK" };
                } catch (error) {
                  logDebugMessage(
                    `User migration failed. Error: ${
                      error instanceof Error ? error.message : "Unknown error"
                    }`,
                  );
                  telemetryClient.recordError({
                    operation: "migrate-user",
                    error,
                    startedAt,
                    tenantId,
                    rowndUserId,
                    superTokensUserId,
                  });
                  return {
                    status: "ERROR",
                    message:
                      error instanceof Error ? error.message : "Unknown error",
                  };
                }
              }),
            },
            {
              path: `${apiBasePath}${HANDLE_BASE_PATH}/migrate-session`,
              method: "post",
              handler: withRequestHandler(
                async (req, res, _session, userContext) => {
                  const startedAt = Date.now();
                  let tenantId: string | undefined = PUBLIC_TENANT_ID;
                  let rowndUserId: string | undefined;
                  let superTokensUserId: string | undefined;
                  try {
                    if (!config.supertokens) {
                      throw new Error("Supertokens config not found");
                    }
                    const parsed = await parseRequest(req);
                    rowndUserId = await validateRowndToken(parsed.token);
                    superTokensUserId =
                      await findSuperTokensUserIdByRowndUserId(rowndUserId);

                    if (!superTokensUserId) {
                      const rowndUser = await fetchRowndUserInfo(rowndUserId);
                      const stUserImport = mapRowndUserToSuperTokens(rowndUser);
                      superTokensUserId = await importUser(
                        stUserImport,
                        config.supertokens,
                      );
                    }

                    if (!superTokensUserId) {
                      throw new Error(
                        "User migration failed or user not found after migration",
                      );
                    }

                    const user = await supertokens.getUser(
                      superTokensUserId,
                      userContext,
                    );
                    if (!user || user.loginMethods.length === 0) {
                      throw new Error("User not found or has no login methods");
                    }

                    const recipeUserId = user.loginMethods[0]!.recipeUserId;

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
                      `Session migrated successfully. tenantId: ${PUBLIC_TENANT_ID}, userId: ${user.id}`,
                    );

                    telemetryClient.recordSuccess({
                      outcome: "success",
                      operation: "migrate-session",
                      durationMs: Date.now() - startedAt,
                      tenantId,
                      rowndUserId,
                      superTokensUserId,
                    });

                    return { status: "OK" };
                  } catch (error) {
                    logDebugMessage(
                      `Session migration failed. Error: ${
                        error instanceof Error ? error.message : "Unknown error"
                      }`,
                    );
                    telemetryClient.recordError({
                      operation: "migrate-session",
                      error,
                      startedAt,
                      tenantId,
                      rowndUserId,
                      superTokensUserId,
                    });
                    return {
                      status: "ERROR",
                      message:
                        error instanceof Error
                          ? error.message
                          : "Unknown error",
                    };
                  }
                },
              ),
            },
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
