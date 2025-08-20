import { SuperTokensPlugin } from 'supertokens-node/types';
import SuperTokens from 'supertokens-node';
import Session from 'supertokens-node/recipe/session';
import { PLUGIN_ID, HANDLE_BASE_PATH, PLUGIN_SDK_VERSION } from './config';
import { UserBanningService } from './userBanningService';
import { PermissionClaim } from 'supertokens-node/recipe/userroles';

// todo: feedback: have more exposed apis from the sdk - can't list users, cant get a user by email (or other fields), etc.

export const init = (): SuperTokensPlugin => {
  const userBanningService = new UserBanningService();

  return {
    id: PLUGIN_ID,
    compatibleSDKVersions: PLUGIN_SDK_VERSION,
    routeHandlers: [
      {
        path: HANDLE_BASE_PATH + '/ban',
        method: 'post',
        verifySessionOptions: {
          sessionRequired: true,
          overrideGlobalClaimValidators: (globalClaimValidators) => {
            return [...globalClaimValidators, PermissionClaim.validators.includes('ban-user')];
          },
        },
        handler: async (req, res, _, userContext) => {
          let tenantId = await req.getKeyValueFromQuery('tenantId');
          if (!tenantId) {
            res.setStatusCode(400);
            res.sendJSONResponse({
              status: 'BAD_INPUT_ERROR',
              message: 'tenantId is required',
            });
            return null;
          }

          // make sure the request is valid
          const body: {
            userId?: string;
            email?: string;
            isBanned: boolean;
          } = await req.getJSONBody();
          if (typeof body.isBanned !== 'boolean') {
            res.setStatusCode(400);
            res.sendJSONResponse({
              status: 'BAD_INPUT_ERROR',
              message: 'isBanned are required',
            });
            return null;
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
            res.setStatusCode(400);
            res.sendJSONResponse({
              status: 'BAD_INPUT_ERROR',
              message: 'userId or email is required',
            });
            return null;
          }

          if (!userId) {
            res.setStatusCode(400);
            res.sendJSONResponse({
              status: 'BAD_INPUT_ERROR',
              message: 'user not found',
            });
            return null;
          }

          // set the ban status
          const result = await userBanningService.setBanStatus(userId, body.isBanned, userContext);

          // revoke all sessions if the user is banned
          if (body.isBanned) {
            await Session.revokeAllSessionsForUser(userId);
          }

          if (result.status === 'OK') {
            res.setStatusCode(200);
            res.sendJSONResponse({ status: 'OK' });
          } else {
            res.setStatusCode(400);
            res.sendJSONResponse(result);
          }

          return null;
        },
      },
      {
        path: HANDLE_BASE_PATH + '/ban',
        method: 'get',
        verifySessionOptions: {
          sessionRequired: true,
          overrideGlobalClaimValidators: (globalClaimValidators, session, userContext) => {
            return [...globalClaimValidators, PermissionClaim.validators.includes('ban-user')];
          },
        },
        handler: async (req, res, _, userContext) => {
          // make sure the user is allowed to get the ban status
          // if (!(await isAuthorised(req, res, "admin"))) {
          //   sendUnauthorisedAccess(res);
          //   return null;
          // }

          let tenantId = await req.getKeyValueFromQuery('tenantId');
          if (!tenantId) {
            res.setStatusCode(400);
            res.sendJSONResponse({
              status: 'BAD_INPUT_ERROR',
              message: 'tenantId is required',
            });
            return null;
          }

          // make sure the request is valid
          let userId: string | undefined = await req.getKeyValueFromQuery('userId');
          let email: string | undefined = await req.getKeyValueFromQuery('email');

          if (email) {
            const user = await SuperTokens.listUsersByAccountInfo(tenantId, {
              email: email.toLowerCase(),
            });
            userId = user?.[0]?.id;
          }

          userId = userId?.trim();

          if (!userId) {
            res.setStatusCode(400);
            res.sendJSONResponse({
              status: 'BAD_INPUT_ERROR',
              message: 'userId or email is required',
            });
            return null;
          }

          // get the ban status
          const result = await userBanningService.getBanStatus(userId, userContext);

          if (result.status === 'OK') {
            res.setStatusCode(200);
            res.sendJSONResponse(result);
          } else {
            res.setStatusCode(400);
            res.sendJSONResponse(result);
          }

          return null;
        },
      },
    ],
    overrideMap: {
      session: {
        functions: (originalImplementation) => {
          return {
            ...originalImplementation,

            createNewSession: async (input) => {
              const result = await userBanningService.getBanStatus(input.userId, input.userContext);
              if (result.status !== 'OK') {
                throw new Error('Failed to get user metadata');
              }

              // throw an error if the user is banned. Can't return a status, because the createNewSession doesn't allow for returning a status.
              if (result.banned) {
                throw new Error('User banned');
              }

              return originalImplementation.createNewSession(input);
            },

            getSession: async (input) => {
              const result = await originalImplementation.getSession(input);
              if (!result) return undefined;

              const userId = result.getUserId(input.userContext);
              if (!userId) return result;

              const banned = userBanningService.getBanStatusFromCache(userId);
              if (!banned) return result; // even if undefined, we still return the result, because we won't be hitting the database

              return undefined;
            },
          };
        },
      },
    },
  };
};
