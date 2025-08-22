import { SuperTokensPlugin } from "supertokens-node/types";
import SuperTokens from "supertokens-node";
import {
  PLUGIN_ID,
  HANDLE_BASE_PATH,
  PLUGIN_SDK_VERSION,
  DEFAULT_PERMISSION_NAME,
  DEFAULT_BANNED_USER_ROLE,
} from "./constants";
import { UserBanningService } from "./userBanningService";
import { PermissionClaim, UserRoleClaim } from "supertokens-node/recipe/userroles";
import { createPluginInitFunction } from "@shared/js";
import { withRequestHandler } from "@shared/nodejs";
import {
  SuperTokensPluginUserBanningImplementation,
  SuperTokensPluginUserBanningPluginConfig,
  SuperTokensPluginUserBanningPluginNormalisedConfig,
} from "./types";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginUserBanningPluginConfig,
  SuperTokensPluginUserBanningImplementation,
  SuperTokensPluginUserBanningPluginNormalisedConfig
>(
  (pluginConfig, implementation): SuperTokensPlugin => {
    const log = implementation.logger((...args) => console.log(`[${PLUGIN_ID}]`, ...args));

    const userBanningService = new UserBanningService(pluginConfig);

    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: PLUGIN_SDK_VERSION,
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
            let tenantId = await req.getKeyValueFromQuery("tenantId");
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
            const result = await userBanningService.setBanStatusAndRefreshSessions(
              tenantId,
              userId,
              body.isBanned,
              userContext
            );
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
        },
        session: {
          recipeInitRequired: true,
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,

              getGlobalClaimValidators: async (input) => [
                ...(await originalImplementation.getGlobalClaimValidators(input)),
                UserRoleClaim.validators.excludes(pluginConfig.bannedUserRole),
              ],

              getSession: async (input) => {
                const session = await originalImplementation.getSession(input);

                await userBanningService.assertAndRevokeBannedSession(session, input.userContext);

                return session;
              },

              createNewSession: async (input) => {
                const session = await originalImplementation.createNewSession(input);

                await userBanningService.assertAndRevokeBannedSession(session, input.userContext);

                return session;
              },
            };
          },
        },
      },
    };
  },
  {
    logger: (originalImplementation) => originalImplementation,
  },
  (config) => ({
    userBanningPermission: config.userBanningPermission ?? DEFAULT_PERMISSION_NAME,
    bannedUserRole: config.bannedUserRole ?? DEFAULT_BANNED_USER_ROLE,
  })
);
