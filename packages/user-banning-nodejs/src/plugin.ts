import { SuperTokensPlugin } from "supertokens-node/types";
import SuperTokens from "supertokens-node";
import {
  PLUGIN_ID,
  HANDLE_BASE_PATH,
  PLUGIN_SDK_VERSION,
  DEFAULT_PERMISSION_NAME,
  DEFAULT_BANNED_USER_ROLE,
  PLUGIN_ERROR_NAME,
} from "./constants";
import { UserBanningService } from "./userBanningService";
import { PermissionClaim, UserRoleClaim } from "supertokens-node/recipe/userroles";
import { createPluginInitFunction } from "@shared/js";
import { withRequestHandler } from "@shared/nodejs";
import { SuperTokensPluginUserBanningPluginConfig, SuperTokensPluginUserBanningPluginNormalisedConfig } from "./types";
import SuperTokensSessionError from "supertokens-node/lib/build/recipe/session/error";
import { enableDebugLogs, logDebugMessage } from "./logger";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginUserBanningPluginConfig,
  UserBanningService,
  SuperTokensPluginUserBanningPluginNormalisedConfig
>(
  (pluginConfig, userBanningService): SuperTokensPlugin => {
    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: PLUGIN_SDK_VERSION,
      init: async (appConfig) => {
        if (appConfig.debug) {
          enableDebugLogs();
        }
      },
      routeHandlers: [
        {
          path: `${HANDLE_BASE_PATH}/ban`,
          method: "post",
          verifySessionOptions: {
            sessionRequired: true,
            overrideGlobalClaimValidators: (globalClaimValidators) => [
              ...globalClaimValidators,
              PermissionClaim.validators.includes(pluginConfig.userBanningPermission),
            ],
          },
          handler: withRequestHandler(async (req, res, session, userContext) => {
            let tenantId = req.getKeyValueFromQuery("tenantId");
            if (!tenantId) {
              return {
                status: "BAD_INPUT_ERROR",
                message: "tenantId is required",
              };
            }

            // make sure the request is valid
            const body: {
              userId?: string;
              email?: string;
              isBanned: boolean;
            } = await req.getJSONBody();
            if (typeof body.isBanned !== "boolean") {
              return {
                status: "BAD_INPUT_ERROR",
                message: "isBanned are required",
              };
            }

            let userId: string | undefined;
            if (body.userId) {
              userId = body.userId;
            } else if (body.email) {
              const user = await SuperTokens.listUsersByAccountInfo(tenantId, {
                email: body.email.toLowerCase(),
              });
              userId = user?.[0]?.id;
            } else {
              return {
                status: "BAD_INPUT_ERROR",
                message: "userId or email is required",
              };
            }

            if (!userId) {
              return {
                status: "BAD_INPUT_ERROR",
                message: "user not found",
              };
            }

            // set the ban status
            const result = await userBanningService.setBanStatusAndUpdateSessions(userId, body.isBanned, userContext);
            if (result.status !== "OK") {
              return {
                status: "UNKNOWN_ERROR",
                message: "Could not set ban status",
              };
            }

            return result;
          }),
        },
        {
          path: `${HANDLE_BASE_PATH}/ban`,
          method: "get",
          verifySessionOptions: {
            sessionRequired: true,
            overrideGlobalClaimValidators: (globalClaimValidators) => [
              ...globalClaimValidators,
              PermissionClaim.validators.includes(pluginConfig.userBanningPermission),
            ],
          },
          handler: withRequestHandler(async (req, res, _, userContext) => {
            let tenantId = await req.getKeyValueFromQuery("tenantId");
            if (!tenantId) {
              return {
                status: "BAD_INPUT_ERROR",
                message: "tenantId is required",
              };
            }

            // make sure the request is valid
            let userId: string | undefined = await req.getKeyValueFromQuery("userId");
            let email: string | undefined = await req.getKeyValueFromQuery("email");

            if (email) {
              const user = await SuperTokens.listUsersByAccountInfo(tenantId, {
                email: email.toLowerCase(),
              });
              userId = user?.[0]?.id;
            }

            userId = userId?.trim();

            if (!userId) {
              return {
                status: "BAD_INPUT_ERROR",
                message: "userId or email is required",
              };
            }

            // get the ban status
            return userBanningService.getBanStatus(tenantId, userId, userContext);
          }),
        },
      ],
      overrideMap: {
        userroles: {
          recipeInitRequired: true,
          functions: (originalImplementation) => ({
            ...originalImplementation,
            removeUserRole: async (input) => {
              if (input.role === pluginConfig.bannedUserRole) {
                await userBanningService.removeBanFromCache(input.tenantId, input.userId);
              }
              return await originalImplementation.removeUserRole(input);
            },
            addRoleToUser: async (input) => {
              if (input.role === pluginConfig.bannedUserRole) {
                await userBanningService.addBanToCache(input.tenantId, input.userId);
              }
              return await originalImplementation.addRoleToUser(input);
            },
          }),
        },
        session: {
          recipeInitRequired: true,
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,

              getGlobalClaimValidators: async (input) => [
                ...(await originalImplementation.getGlobalClaimValidators(input)),
                // This shouldn't be needed, but it's good to have it as a backup (plus it'd be weird not to have it)
                UserRoleClaim.validators.excludes(pluginConfig.bannedUserRole),
              ],

              getSession: async (input) => {
                const session = await originalImplementation.getSession(input);
                if (session) {
                  await userBanningService.preLoadCacheIfNeeded();
                  const banStatus = await userBanningService.getBanStatusFromCache(
                    session.getTenantId(),
                    session.getUserId()
                  );
                  if (banStatus) {
                    await session.revokeSession();
                    throw new SuperTokensSessionError({
                      message: "User banned",
                      type: SuperTokensSessionError.UNAUTHORISED,
                    });
                  }
                }
                return session;
              },

              createNewSession: async (input) => {
                const banStatus = await userBanningService.getBanStatus(
                  input.tenantId,
                  input.userId,
                  input.userContext
                );
                if (banStatus.status === "OK" && banStatus.banned) {
                  const error = new Error("User banned");
                  error.name = PLUGIN_ERROR_NAME;
                  throw error;
                }
                return originalImplementation.createNewSession(input);
              },
            };
          },
        },
        // These overrides are mostly "cosmetic", just ensuring that a nice error message is returned to the client
        emailpassword: {
          recipeInitRequired: false,
          apis: (originalImplementation) => ({
            ...originalImplementation,
            signInPOST: overrideWithPluginErrorHandler(
              originalImplementation.signInPOST?.bind(originalImplementation)!
            ),
            signUpPOST: overrideWithPluginErrorHandler(
              originalImplementation.signUpPOST?.bind(originalImplementation)!
            ),
          }),
        },
        passwordless: {
          recipeInitRequired: false,
          apis: (originalImplementation) => ({
            ...originalImplementation,
            consumeCodePOST: overrideWithPluginErrorHandler(
              originalImplementation.consumeCodePOST?.bind(originalImplementation)!
            ),
          }),
        },
        thirdparty: {
          recipeInitRequired: false,
          apis: (originalImplementation) => ({
            ...originalImplementation,
            signInUpPOST: overrideWithPluginErrorHandler(
              originalImplementation.signInUpPOST?.bind(originalImplementation)!
            ),
          }),
        },
        webauthn: {
          recipeInitRequired: false,
          apis: (originalImplementation) => ({
            ...originalImplementation,
            signInPOST: overrideWithPluginErrorHandler(
              originalImplementation.signInPOST?.bind(originalImplementation)!
            ),
            signUpPOST: overrideWithPluginErrorHandler(
              originalImplementation.signUpPOST?.bind(originalImplementation)!
            ),
          }),
        },
      },
    };
  },
  (config) => new UserBanningService(config),
  (config) => ({
    userBanningPermission: config.userBanningPermission ?? DEFAULT_PERMISSION_NAME,
    bannedUserRole: config.bannedUserRole ?? DEFAULT_BANNED_USER_ROLE,
  })
);

function overrideWithPluginErrorHandler<I, O>(originalFunction: (input: I) => Promise<O>): (input: I) => Promise<O> {
  return async (input: I) => {
    try {
      return (await originalFunction(input)) as O;
    } catch (error) {
      if (error instanceof Error && error.name === PLUGIN_ERROR_NAME) {
        return {
          status: "GENERAL_ERROR",
          message: error.message,
        } as any;
      }
      throw error;
    }
  };
}
