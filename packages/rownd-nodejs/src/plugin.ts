import { SuperTokensPlugin } from "supertokens-node/types";
import type { APIInterface as EmailVerificationAPIInterface } from "supertokens-node/recipe/emailverification";
import { createPluginInitFunction } from "@shared/js";
import { withRequestHandler } from "@shared/nodejs";
import { createInstance } from "@rownd/node";
import supertokens from "supertokens-node";
import { randomUUID } from "crypto";
import {
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
  HANDLE_BASE_PATH,
  PUBLIC_TENANT_ID,
  ANONYMOUS_AUTH_METHOD_ID,
  GUEST_AUTH_METHOD_ID,
} from "./constants";
import { RowndPluginConfig, RowndPluginNormalisedConfig } from "./types";
import { enableDebugLogs, logDebugMessage } from "./logger";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { createClient } from "./telemetry/createTelemetryClient";
import { RowndPluginError } from "./errors";
import {
  parseRequest,
  mapRowndUserToSuperTokens,
  importUser,
  setRowndClient,
  setPluginConfig,
  validateRowndToken,
  fetchRowndUserInfo,
  getUserById,
  getUserMetadata,
  updateUserData,
  updateUserMetadata,
  startPendingEmailVerification,
  completePendingEmailVerification,
  buildAppConfig,
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
          return {
            status: "OK" as const,
            routeHandlers: [
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/app-config`,
                method: "get",
                handler: withRequestHandler(async () => {
                  return {
                    status: "OK" as const,
                    ...buildAppConfig(pluginConfig, stConfig),
                  };
                }),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/guest`,
                method: "post",
                handler: withRequestHandler(
                  async (req, res, _session, userContext) => {
                    const startedAt = Date.now();
                    const guestId = `guest_${randomUUID()}`;

                    try {
                      const body = (await req.getJSONBody()) as
                        | { auth_level?: string }
                        | undefined;
                      const thirdPartyId =
                        body?.auth_level === ANONYMOUS_AUTH_METHOD_ID
                          ? ANONYMOUS_AUTH_METHOD_ID
                          : GUEST_AUTH_METHOD_ID;

                      const response =
                        await ThirdParty.manuallyCreateOrUpdateUser(
                          PUBLIC_TENANT_ID,
                          thirdPartyId,
                          guestId,
                          `${guestId}@anonymous.local`,
                          false,
                          undefined,
                          userContext,
                        );

                      if (response.status !== "OK") {
                        throw new Error(
                          `Guest user creation failed with status: ${response.status}`,
                        );
                      }

                      const recipeUserId = response.recipeUserId;

                      await UserMetadata.updateUserMetadata(response.user.id, {
                        auth_level: thirdPartyId,
                        is_anonymous: true,
                      });

                      await Session.createNewSession(
                        req,
                        res,
                        PUBLIC_TENANT_ID,
                        recipeUserId,
                        {
                          auth_level: thirdPartyId,
                          is_anonymous: true,
                          app_user_id: response.user.id,
                        },
                        {},
                        userContext,
                      );

                      logDebugMessage(
                        `Guest session created for user: ${response.user.id}`,
                      );

                      telemetryClient.recordSuccess({
                        outcome: "success",
                        durationMs: Date.now() - startedAt,
                        tenantId: PUBLIC_TENANT_ID,
                        superTokensUserId: response.user.id,
                      });

                      return {
                        status: "OK",
                        createdNewRecipeUser: response.createdNewRecipeUser,
                      };
                    } catch (error) {
                      logDebugMessage(
                        `Guest login failed. Error: ${
                          error instanceof Error
                            ? error.message
                            : "Unknown error"
                        }`,
                      );
                      telemetryClient.recordError({
                        error,
                        startedAt,
                        tenantId: PUBLIC_TENANT_ID,
                      });
                      return {
                        status: "ERROR",
                        message: "Guest login failed",
                      };
                    }
                  },
                ),
              },
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
                      if (!stConfig.supertokens) {
                        throw new Error("Supertokens config not found");
                      }
                      const parsed = await parseRequest(req);
                      rowndUserId = await validateRowndToken(parsed.token);
                      user = await supertokens.getUser(
                        rowndUserId,
                        userContext,
                      );

                      if (!user) {
                        const rowndUser = await fetchRowndUserInfo(rowndUserId);
                        const stUserImport =
                          mapRowndUserToSuperTokens(rowndUser);
                        try {
                          const importedUser = await importUser(
                            stUserImport,
                            stConfig.supertokens,
                          );
                          superTokensUserId = importedUser.id;
                          if (importedUser.loginMethods[0]?.recipeUserId) {
                            recipeUserId = supertokens.convertToRecipeUserId(
                              importedUser.loginMethods[0].recipeUserId,
                            );
                          }
                        } catch (err) {
                          // Handle race condition: user might have been migrated by another request
                          user = await supertokens.getUser(
                            rowndUserId,
                            userContext,
                          );
                          if (!user) {
                            throw err;
                          }
                          superTokensUserId = user.id;
                          recipeUserId = user.loginMethods[0]?.recipeUserId;
                          logDebugMessage(
                            `User already migrated (race condition). tenantId: ${PUBLIC_TENANT_ID}, rowndUserId: ${rowndUserId}`,
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
                        throw new Error(
                          "User not found or has no login methods",
                        );
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
                          error instanceof Error
                            ? error.message
                            : "Unknown error"
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
                    ...(await getUserById(userId)),
                  };
                }),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
                method: "put",
                verifySessionOptions: {
                  sessionRequired: true,
                },
                handler: withRequestHandler(
                  async (req, _res, session, userContext) => {
                    if (!session) {
                      throw new Error("Session not found");
                    }

                    const payload = (await req.getJSONBody()) as
                      | { data?: Record<string, any> }
                      | undefined;
                    const inputData = payload?.data || {};
                    const { email, ...dataWithoutEmail } = inputData;
                    const hasEmailUpdate =
                      Object.prototype.hasOwnProperty.call(inputData, "email") &&
                      typeof email === "string";

                    if (Object.keys(dataWithoutEmail).length > 0) {
                      await updateUserData(
                        session.getUserId(),
                        dataWithoutEmail,
                      );
                    }

                    if (hasEmailUpdate) {
                      return {
                        status: "OK" as const,
                        ...(await startPendingEmailVerification({
                          userId: session.getUserId(),
                          recipeUserId: session.getRecipeUserId(),
                          tenantId: session.getTenantId(),
                          email,
                          pendingVerificationId: randomUUID(),
                          userContext,
                        })),
                      };
                    }

                    return {
                      status: "OK" as const,
                      ...(await getUserById(session.getUserId())),
                    };
                  },
                ),
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

                  const metadata = await getUserMetadata(session.getUserId());
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
                    ...(await updateUserMetadata(
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
                  const metadata = await getUserMetadata(session.getUserId());
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
                handler: withRequestHandler(
                  async (req, _res, session, userContext) => {
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
                    if (
                      field === "email" &&
                      typeof payload?.value === "string"
                    ) {
                      return {
                        status: "OK" as const,
                        ...(await startPendingEmailVerification({
                          userId: session.getUserId(),
                          recipeUserId: session.getRecipeUserId(),
                          tenantId: session.getTenantId(),
                          email: payload.value,
                          pendingVerificationId: randomUUID(),
                          userContext,
                        })),
                      };
                    }

                    return {
                      status: "OK" as const,
                      ...(await updateUserData(session.getUserId(), {
                        [field]: payload?.value,
                      })),
                    };
                  },
                ),
              },
            ],
          };
        },
        overrideMap: {
          session: {
            recipeInitRequired: true,
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
