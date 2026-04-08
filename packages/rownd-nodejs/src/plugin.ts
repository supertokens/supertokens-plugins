import { SuperTokensPlugin, UserContext } from "supertokens-node/types";
import { createPluginInitFunction } from "@shared/js";
import { withRequestHandler } from "@shared/nodejs";
import { createInstance } from "@rownd/node";
import supertokens from "supertokens-node";
import { PLUGIN_ID, PLUGIN_SDK_VERSION, HANDLE_BASE_PATH } from "./constants";
import {
  RowndPluginConfig,
  RowndPluginNormalisedConfig,
  RowndUser,
  IRowndClient,
} from "./types";
import { TelemetryService } from "./telemetry";
import Session from "supertokens-node/recipe/session";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { Querier } from "supertokens-node/lib/build/querier";
import NormalisedURLPath from "supertokens-node/lib/build/normalisedURLPath";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  RowndPluginConfig,
  {}, // implementation not needed for this plugin
  RowndPluginNormalisedConfig
>(
  (config) => {
    const rowndClient = createInstance({
      app_key: config.rowndAppKey,
      app_secret: config.rowndAppSecret,
    }) as unknown as IRowndClient;

    const telemetry = new TelemetryService(config.telemetry);

    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: [PLUGIN_SDK_VERSION, "23.0.0", "23.0.1"],
      routeHandlers() {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: `${HANDLE_BASE_PATH}/migrate-user`,
              method: "post",
              handler: withRequestHandler(
                async (req, res, session, userContext) => {
                  const authHeader = req.getHeaderValue("authorization");
                  if (!authHeader) {
                    return {
                      status: "ERROR",
                      message: "Missing authorization header",
                    };
                  }

                  const token = authHeader.replace(/^Bearer /i, "");
                  const body = (await req.getJSONBody()) as
                    | { tenantId?: string }
                    | undefined;
                  const tenantId = body?.tenantId || "public";

                  try {
                    const tokenInfo = await rowndClient.validateToken(token);
                    const rowndUser: RowndUser =
                      await rowndClient.fetchUserInfo({
                        user_id: tokenInfo.user_id,
                      });

                    await migrateToSupertokens(
                      rowndUser,
                      tenantId,
                      userContext,
                    );

                    await telemetry.logSuccess("migrate-user", {
                      tenantId,
                      rowndUserId: rowndUser.app_user_id,
                    });

                    return { status: "OK" };
                  } catch (error: unknown) {
                    await telemetry.logError("migrate-user", error, {
                      tenantId,
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
            {
              path: `${HANDLE_BASE_PATH}/migrate-session`,
              method: "post",
              handler: withRequestHandler(
                async (req, res, session, userContext) => {
                  const authHeader = req.getHeaderValue("authorization");
                  if (!authHeader) {
                    return {
                      status: "ERROR",
                      message: "Missing authorization header",
                    };
                  }

                  const token = authHeader.replace(/^Bearer /i, "");
                  const body = (await req.getJSONBody()) as
                    | { tenantId?: string }
                    | undefined;
                  const tenantId = body?.tenantId || "public";

                  try {
                    const tokenInfo = await rowndClient.validateToken(token);
                    const rowndUserId = tokenInfo.user_id;

                    // 1. Check if user exists in SuperTokens by externalId
                    let superTokensUserId: string | undefined;
                    const mapping = await supertokens.getUserIdMapping({
                      userId: rowndUserId,
                      userIdType: "EXTERNAL",
                      userContext,
                    });

                    if (mapping.status === "OK") {
                      superTokensUserId = mapping.superTokensUserId;
                    }

                    // 2. If user doesn't exist, migrate them
                    if (!superTokensUserId) {
                      const rowndUser: RowndUser =
                        await rowndClient.fetchUserInfo({
                          user_id: rowndUserId,
                        });
                      await migrateToSupertokens(
                        rowndUser,
                        tenantId,
                        userContext,
                      );
                      const newMapping = await supertokens.getUserIdMapping({
                        userId: rowndUserId,
                        userIdType: "EXTERNAL",
                        userContext,
                      });
                      if (newMapping.status === "OK") {
                        superTokensUserId = newMapping.superTokensUserId;
                      }
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

                    const recipeUserId = user.loginMethods[0]?.recipeUserId;
                    if (!recipeUserId) {
                      throw new Error("User has no recipe user ID");
                    }

                    // 3. Create session for the user
                    await Session.createNewSession(
                      req,
                      res,
                      tenantId,
                      recipeUserId,
                      {},
                      {},
                      userContext,
                    );

                    await telemetry.logSuccess("migrate-session", {
                      tenantId,
                      userId: user.id,
                    });

                    return { status: "OK" };
                  } catch (error: unknown) {
                    await telemetry.logError("migrate-session", error, {
                      tenantId,
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
  () => ({}), // Not needed for this plugin
  (config: RowndPluginConfig) => {
    if (!config?.rowndAppKey || !config?.rowndAppSecret) {
      throw new Error("Missing rowndAppKey or rowndAppSecret in plugin config");
    }
    return {
      rowndAppKey: config.rowndAppKey,
      rowndAppSecret: config.rowndAppSecret,
      telemetry: config.telemetry,
    };
  },
);

async function migrateToSupertokens(
  rowndUser: RowndUser,
  tenantId: string,
  userContext: UserContext,
) {
  const loginMethods: unknown[] = [];

  // Map Google ID
  if (rowndUser.data.google_id) {
    loginMethods.push({
      recipeId: "thirdparty",
      thirdParty: { id: "google", userId: rowndUser.data.google_id as string },
      email: rowndUser.data.email as string,
      verified: !!rowndUser.verified_data.google_id,
    });
  }

  // Map Apple ID
  if (rowndUser.data.apple_id) {
    loginMethods.push({
      recipeId: "thirdparty",
      thirdParty: { id: "apple", userId: rowndUser.data.apple_id as string },
      email: rowndUser.data.email as string,
      verified: !!rowndUser.verified_data.apple_id,
    });
  }

  // Map Phone
  if (rowndUser.data.phone_number && loginMethods.length === 0) {
    loginMethods.push({
      recipeId: "passwordless",
      phoneNumber: rowndUser.data.phone_number as string,
      verified: !!rowndUser.verified_data.phone_number,
    });
  }

  // Fallback to email if no third-party ID or phone is found
  if (loginMethods.length === 0 && rowndUser.data.email) {
    loginMethods.push({
      recipeId: "passwordless",
      email: rowndUser.data.email as string,
      verified: !!rowndUser.verified_data.email,
    });
  }

  if (loginMethods.length === 0) {
    throw new Error("No valid login methods found in Rownd user data");
  }

  // Import the user via bulk import
  const importPayload = {
    users: [
      {
        externalUserId: rowndUser.app_user_id,
        loginMethods,
      },
    ],
  };

  const querier = Querier.getNewInstanceOrThrowError();
  const importResponse = (await querier.sendPostRequest(
    new NormalisedURLPath("/bulk-import/users") as any,
    importPayload,
    userContext,
  )) as { status: string; message?: string };

  if (importResponse.status !== "OK") {
    throw new Error(
      `Bulk import failed: ${importResponse.message || "Unknown error"}`,
    );
  }

  // Fetch the SuperTokens userId using externalUserId
  const mapping = await supertokens.getUserIdMapping({
    userId: rowndUser.app_user_id,
    userIdType: "EXTERNAL",
    userContext,
  });

  if (mapping.status !== "OK") {
    throw new Error("User mapping not found after import");
  }

  const user = await supertokens.getUser(
    mapping.superTokensUserId,
    userContext,
  );
  if (!user) {
    throw new Error("User not found after import");
  }

  // Sync metadata
  if (rowndUser.data && Object.keys(rowndUser.data).length > 0) {
    const existingMetadata = await UserMetadata.getUserMetadata(
      user.id,
      userContext,
    );
    const newMetadata = {
      ...existingMetadata.metadata,
      ...(rowndUser.data as Record<string, unknown>),
      rownd_migrated: true,
      rownd_user_id: rowndUser.app_user_id,
    };

    await UserMetadata.updateUserMetadata(user.id, newMetadata, userContext);
  }
}
