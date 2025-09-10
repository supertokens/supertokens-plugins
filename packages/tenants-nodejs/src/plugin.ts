import { NormalisedAppinfo, SuperTokensPlugin, UserContext } from "supertokens-node/types";
import MultiTenancy from "supertokens-node/recipe/multitenancy";
import Session from "supertokens-node/recipe/session";
import { logDebugMessage } from "supertokens-node/lib/build/logger";
import supertokens from "supertokens-node";
import UserRoles from "supertokens-node/recipe/userroles";

import { createPluginInitFunction } from "@shared/js";
import { pluginUserMetadata, withRequestHandler } from "@shared/nodejs";

import {
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantPluginConfig,
  PluginEmailDeliveryInput,
  SendPluginEmail,
  SuperTokensPluginTenantPluginNormalisedConfig,
} from "./types";
import { HANDLE_BASE_PATH, METADATA_KEY, PLUGIN_ID, PLUGIN_SDK_VERSION } from "./constants";
import { BooleanClaim } from "supertokens-node/lib/build/recipe/session/claims";
import { ROLES, TenantCreationRequestMetadata, TenantMetadata } from "@shared/tenants";
import { assignAdminToUserInTenant, assignRoleToUserInTenant, createRoles, getUserIdsInTenantWithRole } from "./roles";
import { extractInvitationCodeAndTenantId, validateWithoutClaim } from "./util";
import { getOverrideableTenantFunctionImplementation, rejectRequestToJoinTenant } from "./recipeImplementation";
import { EmailDeliveryInterface } from "supertokens-node/lib/build/ingredients/emaildelivery/types";
import { DefaultPluginEmailService } from "./defaultEmailService";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginTenantPluginConfig,
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantPluginNormalisedConfig
>(
  (pluginConfig, implementation) => {
    const metadata = pluginUserMetadata<TenantMetadata>(METADATA_KEY);
    const tenantCreationRequestMetadata = pluginUserMetadata<TenantCreationRequestMetadata>(METADATA_KEY);

    let appInfo: NormalisedAppinfo;

    // Whether the user should have a non public tenant associated
    // with them or not.
    //
    // This defaults to `false` and is only enabled if the `requireNonPublicTenantAssociation`
    // is set to `true`.
    const MultipleTenantsPresentClaim = new BooleanClaim({
      key: `${PLUGIN_ID}-multiple-tenants-present`,
      fetchValue: async (userId) => {
        const userDetails = await supertokens.getUser(userId);
        if (!userDetails) {
          return false;
        }

        // Do not assume that everyone is part of public tenant
        return userDetails.tenantIds.length === 1;
      },
    });

    // Initialize email service - use provided service or default
    const baseEmailService: EmailDeliveryInterface<PluginEmailDeliveryInput> =
      pluginConfig.emailDelivery?.service || new DefaultPluginEmailService();

    // Apply override if provided (this is where users can provide their sendEmail implementation)
    const emailService: EmailDeliveryInterface<PluginEmailDeliveryInput> = pluginConfig.emailDelivery?.override
      ? pluginConfig.emailDelivery.override(baseEmailService)
      : baseEmailService;

    // Helper function to send emails
    const sendPluginEmail: SendPluginEmail = async (input: PluginEmailDeliveryInput, userContext: UserContext) => {
      try {
        await emailService.sendEmail({
          ...input,
          userContext,
        });
      } catch (error: any) {
        logDebugMessage(`Failed to send email: ${error.message}`);
        throw new Error(`Failed to send ${input.type.toLowerCase()} email: ${error.message}`);
      }
    };

    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: PLUGIN_SDK_VERSION,
      init: async (appConfig) => {
        await createRoles();
        logDebugMessage("TenantPlugin initialized with email service");

        appInfo = appConfig.appInfo;
      },
      routeHandlers() {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: `${HANDLE_BASE_PATH}/list`,
              method: "get",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  if (!pluginConfig.requireNonPublicTenantAssociation) {
                    return globalValidators;
                  }

                  return validateWithoutClaim(globalValidators, MultipleTenantsPresentClaim.key);
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                return implementation.getTenants(session);
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/create`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  if (!pluginConfig.requireNonPublicTenantAssociation) {
                    return globalValidators;
                  }

                  return validateWithoutClaim(globalValidators, MultipleTenantsPresentClaim.key);
                },
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                if (!implementation.isAllowedToCreateTenant(session)) {
                  return {
                    status: "ERROR",
                    message: "You are not allowed to create a tenant",
                  };
                }

                const payload: { name?: string; firstFactors?: string[] } | undefined = await req.getJSONBody();
                if (!payload?.name?.trim()) {
                  return {
                    status: "ERROR",
                    message: "Name is required",
                  };
                }
                const firstFactors = payload.firstFactors ?? null;

                // We need to check if tenant creation requires approval, in which case
                // we will not create the tenant until an app admin approves it.
                // Essentially, we will just store the tenant details in the metadata
                // until it is approved or rejected.
                const appUrl = implementation.getAppUrl(appInfo, req, userContext);
                if (await implementation.doesTenantCreationRequireApproval(session)) {
                  // Add tenant details to metadata
                  const addTenantCreationRequestResponse = await implementation.addTenantCreationRequest(
                    session,
                    {
                      name: payload.name,
                      firstFactors,
                    },
                    tenantCreationRequestMetadata,
                    appUrl,
                    userContext,
                    sendPluginEmail,
                  );

                  return {
                    ...addTenantCreationRequestResponse,
                    pendingApproval: true,
                    firstFactors,
                  };
                }

                const createResponse = await implementation.createTenantAndAssignAdmin(
                  {
                    name: payload.name,
                    firstFactors,
                  },
                  session.getUserId(),
                );

                if (createResponse.status !== "OK") {
                  return createResponse;
                }

                return {
                  status: "OK",
                  createdNew: createResponse.createdNew,
                  firstFactors,
                  isPendingApproval: false,
                };
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/tenant-requests/list`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                // Should only be accessible to app admin roles
                overrideGlobalClaimValidators: (globalValidators) => {
                  return [...globalValidators, UserRoles.UserRoleClaim.validators.includesAny([ROLES.APP_ADMIN])];
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                return implementation.getTenantCreationRequests(tenantCreationRequestMetadata);
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/tenant-requests/accept`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                // Should only be accessible to app admin roles
                overrideGlobalClaimValidators: (globalValidators) => {
                  return [...globalValidators, UserRoles.UserRoleClaim.validators.includesAny([ROLES.APP_ADMIN])];
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const payload: { requestId: string } | undefined = await req.getJSONBody();
                if (!payload?.requestId) {
                  return {
                    status: "ERROR",
                    message: "Request ID is required",
                  };
                }

                return implementation.acceptTenantCreationRequest(
                  payload.requestId,
                  session,
                  tenantCreationRequestMetadata,
                );
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/tenant-requests/reject`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                // Should only be accessible to app admin roles
                overrideGlobalClaimValidators: (globalValidators) => {
                  return [...globalValidators, UserRoles.UserRoleClaim.validators.includesAny([ROLES.APP_ADMIN])];
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const payload: { requestId: string } | undefined = await req.getJSONBody();
                if (!payload?.requestId) {
                  return {
                    status: "ERROR",
                    message: "Request ID is required",
                  };
                }

                return implementation.rejectTenantCreationRequest(
                  payload.requestId,
                  session,
                  tenantCreationRequestMetadata,
                );
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/join`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  if (!pluginConfig.requireNonPublicTenantAssociation) {
                    return globalValidators;
                  }

                  return validateWithoutClaim(globalValidators, MultipleTenantsPresentClaim.key);
                },
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const userDetails = await supertokens.getUser(session.getUserId());
                if (!userDetails) {
                  return {
                    status: "USER_NOT_FOUND",
                    message: "User not found",
                  };
                }

                if (!implementation.isAllowedToJoinTenant(userDetails, session)) {
                  return {
                    status: "ERROR",
                    message: "You are not allowed to join a tenant",
                  };
                }

                const payload: { tenantId: string } | undefined = await req.getJSONBody();
                if (!payload?.tenantId) {
                  return {
                    status: "ERROR",
                    message: "Tenant ID is required",
                  };
                }

                const tenantDetails = await MultiTenancy.getTenant(payload.tenantId);
                if (!tenantDetails) {
                  return {
                    status: "ERROR",
                    message: "Tenant not found",
                  };
                }

                // Associate the user with the tenant
                // NOTE: Unlikely that login method will be undefined so we can ignore that.
                await MultiTenancy.associateUserToTenant(payload.tenantId, userDetails.loginMethods[0]!.recipeUserId);

                // Do session.revoke and create a new session instead of the above
                await session.revokeSession();
                await Session.createNewSession(
                  req,
                  res,
                  payload.tenantId,
                  session.getRecipeUserId(),
                  session.getAccessTokenPayload(),
                  undefined,
                  userContext,
                );

                return {
                  status: "OK",
                  message: "User associated with tenant",
                };
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/leave`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  if (!pluginConfig.requireNonPublicTenantAssociation) {
                    return globalValidators;
                  }

                  return validateWithoutClaim(globalValidators, MultipleTenantsPresentClaim.key);
                },
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const userDetails = await supertokens.getUser(session.getUserId());
                if (!userDetails) {
                  return {
                    status: "USER_NOT_FOUND",
                    message: "User not found",
                  };
                }

                const tenantId = session.getTenantId();

                const tenantDetails = await MultiTenancy.getTenant(tenantId);
                if (!tenantDetails) {
                  return {
                    status: "ERROR",
                    message: "Tenant not found",
                  };
                }

                // Associate the user with the tenant
                // NOTE: Unlikely that login method will be undefined so we can ignore that.
                await MultiTenancy.disassociateUserFromTenant(tenantId, userDetails.loginMethods[0]!.recipeUserId);

                // Do session.revoke and create a new session instead of the above
                await session.revokeSession();
                await Session.createNewSession(
                  req,
                  res,
                  tenantId,
                  session.getRecipeUserId(),
                  session.getAccessTokenPayload(),
                  undefined,
                  userContext,
                );

                return {
                  status: "OK",
                  message: "User disassociated from tenant",
                };
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/users`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  return [
                    ...globalValidators,
                    UserRoles.UserRoleClaim.validators.includesAny([ROLES.ADMIN, ROLES.MEMBER]),
                  ];
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const tenantIdToUse = session.getTenantId();
                const getUsersResponse = await implementation.getTenantUsers(tenantIdToUse);

                return getUsersResponse;
              }),
            },
            // Invite related routes
            {
              path: `${HANDLE_BASE_PATH}/invite/add`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  return [...globalValidators, UserRoles.UserRoleClaim.validators.includesAny([ROLES.ADMIN])];
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                // Parse the tenantId from the body
                const payload: { email: string } | undefined = await req.getJSONBody();
                const tenantId = session.getTenantId();
                const email = payload?.email?.trim();

                if (!email) {
                  return {
                    status: "ERROR",
                    message: "Email is required",
                  };
                }

                return implementation.addInvitation(email, tenantId, metadata);
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/invite/remove`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  return [...globalValidators, UserRoles.UserRoleClaim.validators.includesAny([ROLES.ADMIN])];
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                // Parse the tenantId from the body
                const payload: { email: string } | undefined = await req.getJSONBody();
                const tenantId = session.getTenantId();
                const email = payload?.email?.trim();
                if (!email) {
                  return {
                    status: "ERROR",
                    message: "Email is required",
                  };
                }

                return implementation.removeInvitation(email, tenantId, metadata);
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/invite/list`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  return [
                    ...globalValidators,
                    UserRoles.UserRoleClaim.validators.includesAny([ROLES.ADMIN, ROLES.MEMBER]),
                  ];
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const tenantIdToUse = session.getTenantId();
                return implementation.getInvitations(tenantIdToUse, metadata);
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/invite/accept`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const payload: { tenantId: string; code: string } | undefined = await req.getJSONBody();
                const tenantId = payload?.tenantId;
                const code = payload?.code;
                if (!tenantId || !code) {
                  return {
                    status: "ERROR",
                    message: "Tenant ID and code are required",
                  };
                }

                return implementation.acceptInvitation(code, tenantId, session, metadata);
              }),
            },
            {
              // TODO: Remove this before merging
              path: `${HANDLE_BASE_PATH}/become-admin`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const payload: { tenantId: string } | undefined = await req.getJSONBody();
                const tenantId = payload?.tenantId;
                if (!tenantId) {
                  return {
                    status: "ERROR",
                    message: "Tenant ID is required",
                  };
                }

                await assignAdminToUserInTenant(tenantId, session.getUserId());
                logDebugMessage(`Admin role assigned to user: ${session.getUserId()}`);

                const roles = await UserRoles.getUsersThatHaveRole(tenantId, ROLES.ADMIN);
                logDebugMessage(`roles: ${JSON.stringify(roles)}`);

                // Do session.revoke and create a new session instead of the above
                await session.fetchAndSetClaim(UserRoles.UserRoleClaim);

                return {
                  status: "OK",
                  message: "Admin role assigned to user",
                  roles: roles,
                };
              }),
            },
            // Request related routes
            {
              path: `${HANDLE_BASE_PATH}/request/list`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  return [...globalValidators, UserRoles.UserRoleClaim.validators.includesAny([ROLES.ADMIN])];
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const tenantIdToUse = session.getTenantId();

                // Find all the users in the tenants that do not have a role and return
                // that list.
                //
                // We will find all the users in the tenant and subtract the users that
                // have the admin or member role.
                const tenantUsers = await implementation.getTenantUsers(tenantIdToUse);
                if (tenantUsers.status !== "OK") {
                  return tenantUsers;
                }

                // Find all the users that have the admin and member role
                const adminUsers = await getUserIdsInTenantWithRole(tenantIdToUse, ROLES.ADMIN);
                const memberUsers = await getUserIdsInTenantWithRole(tenantIdToUse, ROLES.MEMBER);

                // Find all the users that do not have a role
                const usersWithoutRole = tenantUsers.users.filter(
                  (user) => !adminUsers.includes(user.id) && !memberUsers.includes(user.id),
                );

                return {
                  status: "OK",
                  users: usersWithoutRole,
                };
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/request/accept`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  return [...globalValidators, UserRoles.UserRoleClaim.validators.includesAny([ROLES.ADMIN])];
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                // Parse the tenantId from the body
                const tenantIdToUse = session.getTenantId();
                const payload: { userId: string } | undefined = await req.getJSONBody();

                if (!payload?.userId) {
                  return {
                    status: "ERROR",
                    message: "User ID is required",
                  };
                }

                // We need to check that the user doesn't have an existing role, in which
                // case we cannot "accept" the request.
                const role = await UserRoles.getRolesForUser(tenantIdToUse, payload.userId);
                if (role.roles.length > 0) {
                  return {
                    status: "ERROR",
                    message: "User is already a member of the tenant",
                  };
                }

                await assignRoleToUserInTenant(tenantIdToUse, payload.userId, ROLES.MEMBER);

                return {
                  status: "OK",
                  message: "Request accepted",
                };
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/request/reject`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  return [...globalValidators, UserRoles.UserRoleClaim.validators.includesAny([ROLES.ADMIN])];
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const tenantIdToUse = session.getTenantId();
                const payload: { userId: string } | undefined = await req.getJSONBody();

                if (!payload?.userId) {
                  return {
                    status: "ERROR",
                    message: "User ID is required",
                  };
                }

                return rejectRequestToJoinTenant(tenantIdToUse, payload.userId);
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/request/add`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }
                const userId = session.getUserId();

                const payload: { tenantId: string } | undefined = await req.getJSONBody();
                if (!payload?.tenantId) {
                  return {
                    status: "ERROR",
                    message: "Tenant ID is required",
                  };
                }

                // NOTE: We can skip the check for the user being already associated
                // since they will be associated again without any errors.
                await implementation.associateAllLoginMethodsOfUserWithTenant(payload.tenantId, userId);

                return {
                  status: "OK",
                  message: "Request added",
                };
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/switch-tenant`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                // NOTE: This is a special case where we cannot
                // use role based claims for checking if user can
                // switch to tenant.
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const payload: { tenantId: string } | undefined = await req.getJSONBody();
                const tenantId = payload?.tenantId;
                if (!tenantId) {
                  return {
                    status: "ERROR",
                    message: "Tenant ID is required",
                  };
                }

                // Check if the user has the role of member or admin in the tenant.
                const roles = (await UserRoles.getRolesForUser(tenantId, session.getUserId())).roles;
                if (roles.length === 0) {
                  return {
                    status: "ERROR_NOT_ALLOWED",
                    message: "Cannot switch to tenant",
                  };
                }

                // Since the user has a role, ensure that it is a valid one.
                if (!roles.includes(ROLES.ADMIN) && !roles.includes(ROLES.MEMBER)) {
                  return {
                    status: "ERROR_NOT_ALLOWED",
                    message: "Requires member or higher role",
                    roles: roles,
                  };
                }

                // Do session.revoke and create a new session instead of the above
                await session.revokeSession();
                await Session.createNewSession(
                  req,
                  res,
                  payload.tenantId,
                  session.getRecipeUserId(),
                  session.getAccessTokenPayload(),
                  undefined,
                  userContext,
                );

                return {
                  status: "OK",
                  message: "Session switched",
                };
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/role/change`,
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  return [...globalValidators, UserRoles.UserRoleClaim.validators.includesAny([ROLES.ADMIN])];
                },
              },
              handler: withRequestHandler(async (req, res, session) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                // Parse the tenantId from the body
                const tenantIdToUse = session.getTenantId();
                const payload: { userId: string; role: string } | undefined = await req.getJSONBody();

                if (!payload?.userId || !payload?.role) {
                  return {
                    status: "ERROR",
                    message: "User ID and role is required",
                  };
                }

                // We need to remove any existing role from the tenant for the user
                // and assign the new one to them.

                // We need to check that the user doesn't have an existing role, in which
                // case we cannot "accept" the request.
                const roleDetails = await UserRoles.getRolesForUser(tenantIdToUse, payload.userId);
                for (const role of roleDetails.roles) {
                  UserRoles.removeUserRole(tenantIdToUse, payload.userId, role);
                }

                // NOTE: We are assuming that the role passed in the payload
                // is a valid one.
                await assignRoleToUserInTenant(tenantIdToUse, payload.userId, payload.role);

                return {
                  status: "OK",
                  message: "Role changed",
                };
              }),
            },
          ],
        };
      },
      overrideMap: {
        session: {
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,
              getGlobalClaimValidators: async function (input) {
                if (!pluginConfig.requireNonPublicTenantAssociation) {
                  return input.claimValidatorsAddedByOtherRecipes;
                }

                return [...input.claimValidatorsAddedByOtherRecipes, MultipleTenantsPresentClaim.validators.isTrue()];
              },
              createNewSession: async (input) => {
                const userDetails = await supertokens.getUser(input.userId);
                if (!userDetails) {
                  logDebugMessage(`User ${input.userId} not found, should never come here, throwing error`);
                  throw new Error("Should never come here");
                }
                logDebugMessage(`User found for user id: ${input.userId}`);

                let tenantId = input.tenantId;

                // If they have a non public tenant, that gets the preference
                // when creating the session.

                const firstNonPublicTenantId = userDetails.tenantIds.find((tenantId) => tenantId !== "public");
                if (firstNonPublicTenantId && firstNonPublicTenantId !== input.tenantId) {
                  logDebugMessage(`Creating new session with tenant: ${firstNonPublicTenantId}`);
                  return Session.createNewSessionWithoutRequestResponse(
                    firstNonPublicTenantId,
                    input.recipeUserId,
                    input.accessTokenPayload,
                    input.sessionDataInDatabase,
                    input.disableAntiCsrf,
                    input.userContext,
                  );
                }

                logDebugMessage(`Tenant ID to use for new session: ${tenantId}`);

                input.accessTokenPayload = {
                  ...input.accessTokenPayload,
                  ...(pluginConfig.requireNonPublicTenantAssociation
                    ? await MultipleTenantsPresentClaim.build(
                        input.userId,
                        input.recipeUserId,
                        tenantId,
                        input.accessTokenPayload,
                        input.userContext,
                      )
                    : {}),
                };

                return originalImplementation.createNewSession({
                  ...input,
                  tenantId,
                });
              },
            };
          },
        },
        emailpassword: {
          apis: (originalImplementation) => {
            return {
              ...originalImplementation,
              signInPOST: async (input) => {
                const { code, tenantId, shouldAcceptInvite } = await extractInvitationCodeAndTenantId(
                  input.options.req,
                );

                const signInResponse = await originalImplementation.signInPOST!(input);
                if (!shouldAcceptInvite || signInResponse.status !== "OK") return signInResponse;

                const invitationResponse = await implementation.acceptInvitation(
                  code,
                  tenantId,
                  signInResponse.session,
                  metadata,
                );

                return {
                  ...signInResponse,
                  invitation: invitationResponse,
                };
              },
              signUpPOST: async (input) => {
                const { code, tenantId, shouldAcceptInvite } = await extractInvitationCodeAndTenantId(
                  input.options.req,
                );

                const signUpResponse = await originalImplementation.signUpPOST!(input);
                if (!shouldAcceptInvite || signUpResponse.status !== "OK") return signUpResponse;

                const invitationResponse = await implementation.acceptInvitation(
                  code,
                  tenantId,
                  signUpResponse.session,
                  metadata,
                );

                return {
                  ...signUpResponse,
                  invitation: invitationResponse,
                };
              },
            };
          },
        },
        passwordless: {
          apis: (originalImplementation) => {
            return {
              ...originalImplementation,
              consumeCodePOST: async (input) => {
                const { code, tenantId, shouldAcceptInvite } = await extractInvitationCodeAndTenantId(
                  input.options.req,
                );

                const consumeCodeResponse = await originalImplementation.consumeCodePOST!(input);
                if (!shouldAcceptInvite || consumeCodeResponse.status !== "OK") return consumeCodeResponse;

                const invitationResponse = await implementation.acceptInvitation(
                  code,
                  tenantId,
                  consumeCodeResponse.session,
                  metadata,
                );

                return {
                  ...consumeCodeResponse,
                  invitation: invitationResponse,
                };
              },
            };
          },
        },
        thirdparty: {
          apis: (originalImplementation) => {
            return {
              ...originalImplementation,
              signInUpPOST: async (input) => {
                const { code, tenantId, shouldAcceptInvite } = await extractInvitationCodeAndTenantId(
                  input.options.req,
                );

                const signInUpResponse = await originalImplementation.signInUpPOST!(input);
                if (!shouldAcceptInvite || signInUpResponse.status !== "OK") return signInUpResponse;

                const invitationResponse = await implementation.acceptInvitation(
                  code,
                  tenantId,
                  signInUpResponse.session,
                  metadata,
                );

                return {
                  ...signInUpResponse,
                  invitation: invitationResponse,
                };
              },
            };
          },
        },
      },
      exports: {
        associateAllLoginMethodsOfUserWithTenant: implementation.associateAllLoginMethodsOfUserWithTenant,
        sendEmail: sendPluginEmail,
        getUserIdsInTenantWithRole,
        getAppUrl: implementation.getAppUrl,
      },
    };
  },
  getOverrideableTenantFunctionImplementation,
  (config) => ({
    requireNonPublicTenantAssociation: config.requireNonPublicTenantAssociation ?? false,
    requireTenantCreationRequestApproval: config.requireTenantCreationRequestApproval ?? true,
  }),
);
