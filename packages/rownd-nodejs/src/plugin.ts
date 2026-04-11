import { SuperTokensPlugin } from "supertokens-node/types";
import { createPluginInitFunction } from "@shared/js";
import { withRequestHandler } from "@shared/nodejs";
import { createInstance } from "@rownd/node";
import supertokens from "supertokens-node";
import { PLUGIN_ID, PLUGIN_SDK_VERSION, HANDLE_BASE_PATH } from "./constants";
import { RowndPluginConfig, RowndPluginNormalisedConfig } from "./types";
import { enableDebugLogs, logDebugMessage } from "./logger";
import Session from "supertokens-node/recipe/session";
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

    setRowndClient(rowndClient);

    if (config.enableDebugLogs) {
      enableDebugLogs();
    }

    logDebugMessage("Rownd plugin init complete");

    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: [PLUGIN_SDK_VERSION, "23.0.0", "23.0.1"],
      init: async () => {
        if (!supertokens.isRecipeInitialized("session")) {
          console.warn(
            "RowndMigrationPlugin: Session recipe is not initialized. Session migration will fail.",
          );
        }
      },
      routeHandlers(config) {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: `${HANDLE_BASE_PATH}/migrate-user`,
              method: "post",
              handler: withRequestHandler(async (req) => {
                try {
                  if (!config.supertokens) {
                    throw new Error("Supertokens config not found");
                  }
                  const parsed = await parseRequest(req);
                  const rowndUserId = await validateRowndToken(parsed.token);
                  const existingUserId =
                    await findSuperTokensUserIdByRowndUserId(rowndUserId);
                  if (existingUserId) {
                    logDebugMessage(
                      `User already migrated. tenantId: ${parsed.tenantId}, rowndUserId: ${rowndUserId}`,
                    );
                    return { status: "OK" };
                  }
                  const rowndUser = await fetchRowndUserInfo(rowndUserId);
                  const stUserImport = mapRowndUserToSuperTokens(rowndUser);
                  await importUser(stUserImport, config.supertokens);

                  logDebugMessage(
                    `User migrated successfully. tenantId: ${parsed.tenantId}, rowndUserId: ${rowndUser.app_user_id}`,
                  );

                  return { status: "OK" };
                } catch (error: unknown) {
                  logDebugMessage(
                    `User migration failed. Error: ${error instanceof Error ? error.message : "Unknown error"}`,
                  );
                  return {
                    status: "ERROR",
                    message:
                      error instanceof Error ? error.message : "Unknown error",
                  };
                }
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/migrate-session`,
              method: "post",
              handler: withRequestHandler(
                async (req, res, _session, userContext) => {
                  try {
                    if (!config.supertokens) {
                      throw new Error("Supertokens config not found");
                    }
                    const parsed = await parseRequest(req);
                    const rowndUserId = await validateRowndToken(parsed.token);
                    let superTokensUserId =
                      await findSuperTokensUserIdByRowndUserId(rowndUserId);

                    if (!superTokensUserId) {
                      const rowndUser = await fetchRowndUserInfo(rowndUserId);
                      const stUserImport = mapRowndUserToSuperTokens(rowndUser);
                      await importUser(stUserImport, config.supertokens);
                      superTokensUserId =
                        await findSuperTokensUserIdByRowndUserId(rowndUserId);
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
                      parsed.tenantId,
                      recipeUserId,
                      {},
                      {},
                      userContext,
                    );

                    logDebugMessage(
                      `Session migrated successfully. tenantId: ${parsed.tenantId}, userId: ${user.id}`,
                    );

                    return { status: "OK" };
                  } catch (error: unknown) {
                    logDebugMessage(
                      `Session migration failed. Error: ${error instanceof Error ? error.message : "Unknown error"}`,
                    );
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
    return {
      rowndAppKey: config.rowndAppKey,
      rowndAppSecret: config.rowndAppSecret,
      enableDebugLogs: config.enableDebugLogs,
    };
  },
);
