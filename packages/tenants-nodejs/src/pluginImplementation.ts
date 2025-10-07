/* eslint-disable @typescript-eslint/no-unused-vars */
import crypto from "crypto";
import supertokens from "supertokens-node";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import MultiTenancy from "supertokens-node/recipe/multitenancy";
import {
  InviteeDetails,
  ROLES,
  TenantCreationRequest,
  TenantCreationRequestWithUser,
  TenantList,
} from "@shared/tenants";
import { User, UserContext } from "supertokens-node/types";
import {
  ErrorResponse,
  MetadataType,
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantPluginConfig,
  TenantCreationRequestMetadataType,
} from "./types";
import { logDebugMessage } from "supertokens-node/lib/build/logger";
import UserRoles from "supertokens-node/recipe/userroles";
import { LoginMethod } from "supertokens-node/lib/build/user";
import {
  assignAdminToUserInTenant,
  assignRoleToUserInTenant as defaultAssignRoleToUserInTenant,
  getUserIdsInTenantWithRole,
} from "./roles";
import { TENANT_CREATE_METADATA_REQUESTS_KEY } from "./constants";

export const getOverrideableTenantFunctionImplementation = (
  pluginConfig: SuperTokensPluginTenantPluginConfig,
): OverrideableTenantFunctionImplementation => {
  const implementation: OverrideableTenantFunctionImplementation = {
    getTenants: async (
      sessionOrUserId: SessionContainerInterface | string,
    ): Promise<({ status: "OK" } & TenantList) | { status: "ERROR"; message: string }> => {
      const userId = typeof sessionOrUserId === "string" ? sessionOrUserId : sessionOrUserId.getUserId();

      const userDetails = await supertokens.getUser(userId);
      if (!userDetails) {
        return {
          status: "ERROR",
          message: "User not found",
        };
      }

      const tenantDetails = await MultiTenancy.listAllTenants();

      return {
        status: "OK",
        tenants: tenantDetails.tenants.map((tenant) => ({ tenantId: tenant.tenantId, displayName: tenant.tenantId })),
        joinedTenantIds: userDetails.tenantIds,
      };
    },
    getTenantUsers: async (tenantId: string): Promise<{ status: "OK"; users: (User & { roles?: string[] })[] }> => {
      const getUsersResponse = await supertokens.getUsersOldestFirst({
        tenantId: tenantId,
      });

      // Find all the users that have a role in the tenant
      // and return details.
      // Iterate through all the the available roles and find users.
      const userIdToRoleMap: Record<string, string[]> = {};
      for (const role of Object.values(ROLES)) {
        const users = await getUserIdsInTenantWithRole(tenantId, role);
        for (const user of users) {
          userIdToRoleMap[user] = [...(userIdToRoleMap[user] || []), role];
        }
      }

      return {
        status: "OK",
        users: getUsersResponse.users.map((user) => ({
          ...user,
          roles: userIdToRoleMap[user.id] ?? [],
        })),
      };
    },
    addInvitation: async (
      email: string,
      tenantId: string,
      role: string,
      metadata: MetadataType,
    ): Promise<{ status: "OK"; code: string } | ErrorResponse> => {
      // Check if the user:
      // 1. is already associated with the tenant
      // 2. is already invited to the tenant

      const getUsersResponse = await supertokens.getUsersOldestFirst({
        tenantId: tenantId,
      });

      // We will have to find whether the user is already associated
      // by searching with the email.
      const userDetails = getUsersResponse.users.find((user) => user.emails.some((userEmail) => userEmail === email));
      if (userDetails) {
        return {
          status: "ERROR",
          message: "User already associated with tenant",
        };
      }

      // Check if the user is already invited to the tenant
      let tenantMetadata = await metadata.get(tenantId);
      if (tenantMetadata?.invitees.some((invitee) => invitee.email === email)) {
        return {
          status: "ERROR",
          message: "User already invited to tenant",
        };
      }

      if (tenantMetadata === undefined) {
        tenantMetadata = {
          invitees: [],
        };
      }

      // Generate a random string for the code
      const code = crypto.randomBytes(10).toString("hex");

      // Invite the user to the tenant
      await metadata.set(tenantId, {
        ...tenantMetadata,
        invitees: [...tenantMetadata.invitees, { email, role, code }],
      });

      return {
        status: "OK",
        code,
      };
    },
    removeInvitation: async (
      email: string,
      tenantId: string,
      metadata: MetadataType,
    ): Promise<{ status: "OK" } | ErrorResponse> => {
      // Check if the user is invited to the tenant
      const tenantMetadata = await metadata.get(tenantId);
      if (!tenantMetadata) {
        return {
          status: "ERROR",
          message: "Tenant not found",
        };
      }

      // Check if the user is invited to the tenant
      const isInvited = tenantMetadata.invitees.some((invitee) => invitee.email === email);
      if (!isInvited) {
        return {
          status: "ERROR",
          message: "User not invited to tenant",
        };
      }

      // Remove the invitation from the tenants's metadata.
      await metadata.set(tenantId, {
        ...tenantMetadata,
        invitees: tenantMetadata.invitees.filter((invitee) => invitee.email !== email),
      });

      return {
        status: "OK",
      };
    },
    getInvitations: async (
      tenantId: string,
      metadata: MetadataType,
    ): Promise<{ status: "OK"; invitees: InviteeDetails[] } | ErrorResponse> => {
      const tenantMetadata = await metadata.get(tenantId);
      if (!tenantMetadata) {
        return {
          status: "OK",
          invitees: [],
        };
      }

      return {
        status: "OK",
        invitees: tenantMetadata.invitees,
      };
    },
    acceptInvitation: async function (
      code: string,
      tenantId: string,
      session: SessionContainerInterface,
      metadata: MetadataType,
    ): Promise<{ status: "OK" } | ErrorResponse> {
      // Check if the user is invited to the tenant
      const tenantMetadata = await metadata.get(tenantId);
      if (!tenantMetadata) {
        return {
          status: "ERROR",
          message: "Tenant not found",
        };
      }

      // Find the invitation details
      const inviteeDetails = tenantMetadata.invitees.find((invitee) => invitee.code === code);
      if (!inviteeDetails) {
        return {
          status: "ERROR",
          message: "Invitation not found",
        };
      }

      await this.associateAllLoginMethodsOfUserWithTenant(
        tenantId,
        session.getUserId(),
        (loginMethod) => loginMethod.email === inviteeDetails.email,
      );

      // Remove the invitation from the tenants's metadata.
      await metadata.set(tenantId, {
        ...tenantMetadata,
        invitees: tenantMetadata.invitees.filter((invitee) => invitee.email !== inviteeDetails.email),
      });
      logDebugMessage(`Removed invitation from tenant ${tenantId}`);

      // Add the user with the role
      await this.assignRoleToUserInTenant(tenantId, session.getUserId(), inviteeDetails.role);

      return {
        status: "OK",
      };
    },
    isAllowedToJoinTenant: async (targetUser: User, session: SessionContainerInterface) => {
      // By default we will allow all users to join a tenant.
      return true;
    },
    isAllowedToCreateTenant: async (session: SessionContainerInterface) => {
      // By default we will allow all users to create a tenant.
      return true;
    },
    canCreateInvitation: async (email: string, role: string, tenantId: string, session: SessionContainerInterface) => {
      // By default, any user can be invited.
      return true;
    },
    canApproveJoinRequest: async (targetUser: User, tenantId: string, session: SessionContainerInterface) => {
      // By default, all users can be approved to join
      return true;
    },
    canApproveTenantCreationRequest: async (
      targetUser: User,
      creationRequest: TenantCreationRequest,
      session: SessionContainerInterface,
    ) => {
      // By default, all users' tenant creation requests can be approved
      return true;
    },
    canRemoveTargetUserFromTenant: async (targetUser: User, tenantId: string, session: SessionContainerInterface) => {
      // By default, can remove anyone from tenant
      return true;
    },
    associateAllLoginMethodsOfUserWithTenant: async (
      tenantId: string,
      userId: string,
      loginMethodFilter?: (loginMethod: LoginMethod) => boolean,
    ) => {
      const userDetails = await supertokens.getUser(userId);
      if (!userDetails) {
        throw new Error(`User ${userId} not found`);
      }

      // Find all the loginMethods for the user that match the email for the
      // invitation.
      const loginMethods = userDetails.loginMethods.filter(loginMethodFilter ?? (() => true));
      logDebugMessage(`loginMethods: ${JSON.stringify(loginMethods)}`);

      // For each of the loginMethods, associate the user with the tenant
      for (const loginMethod of loginMethods) {
        await MultiTenancy.associateUserToTenant(tenantId, loginMethod.recipeUserId);
        logDebugMessage(`Associated user ${userDetails.id} with tenant ${tenantId}`);
      }
    },
    doesTenantCreationRequireApproval: async (session: SessionContainerInterface) => {
      // By default, tenant creation does require approval.
      return pluginConfig.requireTenantCreationRequestApproval ?? true;
    },
    addTenantCreationRequest: async function (session, tenantDetails, metadata, appUrl, userContext, sendEmail) {
      // Add tenant creation request to metadata
      let tenantCreateRequestMetadata = await metadata.get(TENANT_CREATE_METADATA_REQUESTS_KEY);

      if (tenantCreateRequestMetadata === undefined) {
        // Initialize it
        tenantCreateRequestMetadata = {
          requests: [],
        };
      }

      // Add the new creation request
      const requestId = crypto.randomBytes(10).toString("hex").substring(0, 13);
      await metadata.set(TENANT_CREATE_METADATA_REQUESTS_KEY, {
        ...tenantCreateRequestMetadata,
        requests: [
          ...(tenantCreateRequestMetadata.requests ?? []),
          { ...tenantDetails, userId: session.getUserId(), requestId },
        ],
      });

      // Extract the email of the user that is creating the tenant
      const creatorUserId = session.getUserId();
      const userDetails = await supertokens.getUser(creatorUserId);
      const creatorEmail = userDetails?.emails[0];

      // Notify app admins
      await this.sendTenantCreationRequestEmail(
        tenantDetails.name,
        creatorEmail ?? creatorUserId,
        appUrl,
        userContext,
        sendEmail,
      );

      return {
        status: "OK",
        requestId,
      };
    },
    getTenantCreationRequests: async (metadata: TenantCreationRequestMetadataType, userContext: UserContext) => {
      const tenantCreateRequestMetadata = await metadata.get(TENANT_CREATE_METADATA_REQUESTS_KEY);

      // Fetch the user details for each user
      const requestsWithUser: TenantCreationRequestWithUser[] = [];

      for (const request of tenantCreateRequestMetadata.requests) {
        const userDetails = await supertokens.getUser(request.userId, userContext);
        if (!userDetails) {
          logDebugMessage(
            `Couldn't find user details for tenant request ${request.requestId} and user: ${request.userId}`,
          );
        } else {
          requestsWithUser.push({ ...request, id: userDetails.id, emails: userDetails.emails });
        }
      }

      return {
        status: "OK",
        requests: requestsWithUser,
      };
    },
    acceptTenantCreationRequest: async function (requestId, session, metadata) {
      /**
       * Mark the request as accepted by creating the tenant
       * and remove the create request.
       *
       * @param requestId - The id of the request to accept
       * @param session - The session of the user accepting the request
       * @param metadata - The metadata of the tenant
       * @returns The status of the request
       */
      const tenantCreateRequestMetadata = await metadata.get(TENANT_CREATE_METADATA_REQUESTS_KEY);
      if (!tenantCreateRequestMetadata) {
        return {
          status: "ERROR",
          message: "Tenant creation request not found",
        };
      }

      // Find the request
      const request = tenantCreateRequestMetadata.requests.find((request) => request.requestId === requestId);
      if (!request) {
        return {
          status: "ERROR",
          message: "Tenant creation request not found",
        };
      }

      const targetUserDetails = await supertokens.getUser(request.userId);

      if (!targetUserDetails) {
        return {
          status: "ERROR",
          message: "User of tenant creation request not found",
        };
      }

      // Check if the tenant creation request can be approved.
      if (!(await this.canApproveTenantCreationRequest(targetUserDetails, request, session))) {
        return {
          status: "ERROR",
          message: "User not allowed to create tenant",
        };
      }

      // Create the tenant and assign admin to the user that added the request.
      const createResponse = await this.createTenantAndAssignAdmin(
        {
          name: request.name,
          firstFactors: request.firstFactors,
        },
        request.userId,
      );

      if (createResponse.status !== "OK") {
        return createResponse;
      }

      // Remove the request from the metadata
      await metadata.set(TENANT_CREATE_METADATA_REQUESTS_KEY, {
        ...tenantCreateRequestMetadata,
        requests: tenantCreateRequestMetadata.requests.filter((request) => request.requestId !== requestId),
      });

      return {
        status: "OK",
      };
    },
    createTenantAndAssignAdmin: async (tenantDetails, userId) => {
      const createResponse = await MultiTenancy.createOrUpdateTenant(tenantDetails.name, {
        firstFactors: tenantDetails.firstFactors,
      });

      // Add the user as the admin of the tenant
      await assignAdminToUserInTenant(tenantDetails.name, userId);

      return createResponse;
    },
    rejectTenantCreationRequest: async (requestId, session, metadata) => {
      const tenantCreateRequestMetadata = await metadata.get(TENANT_CREATE_METADATA_REQUESTS_KEY);
      if (!tenantCreateRequestMetadata) {
        return {
          status: "ERROR",
          message: "Tenant creation request not found",
        };
      }

      // Remove the request from the metadata
      await metadata.set(TENANT_CREATE_METADATA_REQUESTS_KEY, {
        ...tenantCreateRequestMetadata,
        requests: tenantCreateRequestMetadata.requests.filter((request) => request.requestId !== requestId),
      });

      return {
        status: "OK",
      };
    },
    sendTenantCreationRequestEmail: async (tenantId, creatorEmail, appUrl, userContext, sendEmail) => {
      /**
       * Send an email to all the admins of the app.
       *
       * @param tenantId - The id of the tenant that is being created
       * @param creatorEmail - The email of the user that is creating the tenant
       * @param appUrl - The url of the app
       */
      const adminUsers = await getUserIdsInTenantWithRole("public", ROLES.APP_ADMIN);

      // For each of the users, we will need to find their email address.
      const adminEmails = await Promise.all(
        adminUsers.map(async (userId) => {
          const userDetails = await supertokens.getUser(userId);
          return userDetails?.emails[0];
        }),
      );

      // Send emails to all tenant admins using Promise.all
      await Promise.all(
        adminEmails
          .filter((email) => email !== undefined)
          .map(async (email) => {
            await sendEmail(
              {
                type: "TENANT_CREATE_APPROVAL",
                email,
                tenantId,
                creatorEmail,
                appUrl,
              },
              userContext,
            );
          }),
      );
    },
    getAppUrl: (appInfo, request, userContext) => {
      /**
       * Get the App URL using the app info, request and user context.
       */
      const websiteDomain = appInfo.getTopLevelWebsiteDomain({
        request,
        userContext,
      });
      return `${websiteDomain ? "https://" : "http://"}${websiteDomain ?? "localhost"}${appInfo.websiteBasePath ?? ""}`;
    },
    rejectRequestToJoinTenant: async (tenantId: string, userId: string): Promise<{ status: "OK" } | ErrorResponse> => {
      // We need to check that the user doesn't have an existing role, in which
      // case we cannot "accept" the request.
      const role = await UserRoles.getRolesForUser(tenantId, userId);
      if (role.roles.length > 0) {
        return {
          status: "ERROR",
          message: "Request already accepted",
        };
      }

      // Find all the recipeUserIds for the user
      // Remove the user from the tenant
      const userDetails = await supertokens.getUser(userId);
      if (!userDetails) {
        return {
          status: "ERROR",
          message: "User not found",
        };
      }

      // For each of the loginMethods, associate the user with the tenant
      for (const loginMethod of userDetails.loginMethods) {
        await MultiTenancy.disassociateUserFromTenant(tenantId, loginMethod.recipeUserId);
        logDebugMessage(`Disassociated user ${userDetails.id} from tenant ${tenantId}`);
      }

      return {
        status: "OK",
      };
    },
    getPreferredTenantId: (tenantIds: string[], inputTenantId: string): string | undefined => {
      /**
       * Find the preferred tenant ID from the list of tenant IDs.
       *
       * By default we will find the first non public tenant Id and return
       * that.
       */
      // If the requireNonPublicTenantAssociation is not enabled, we will return the
      // input tenant ID directly.
      if (!pluginConfig.requireNonPublicTenantAssociation) {
        return inputTenantId;
      }

      return tenantIds.find((tenantId) => tenantId !== "public");
    },
    assignRoleToUserInTenant: (tenantId: string, userId: string, role: string): Promise<void> => {
      /**
       * Assign the passed role to the user in tenantId.
       *
       * @param tenantId - The tenant id to assign the role to.
       * @param userId - The user id to assign the role to.
       * @param role - The role to assign to the user.
       */
      return defaultAssignRoleToUserInTenant(tenantId, userId, role);
    },
  };

  return implementation;
};
