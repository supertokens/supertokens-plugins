/* eslint-disable @typescript-eslint/no-unused-vars */
import { User, listUsersByAccountInfo } from "supertokens-node";
import { OverrideableTenantFunctionImplementation, SuperTokensPluginTenantEnrollmentPluginConfig } from "./types";
import {
  assignRoleToUserInTenant,
  AssociateAllLoginMethodsOfUserWithTenant,
  SendPluginEmail,
} from "@supertokens-plugins/tenants-nodejs";
import { NOT_ALLOWED_TO_SIGNUP_REASONS, ROLES } from "@shared/tenants";
import SuperTokens from "supertokens-node";
import { UserContext } from "supertokens-node/lib/build/types";

export const getOverrideableTenantFunctionImplementation = (
  config: SuperTokensPluginTenantEnrollmentPluginConfig,
): OverrideableTenantFunctionImplementation => {
  const implementation: OverrideableTenantFunctionImplementation = {
    canUserJoinTenant: async (tenantId, userIdentificationDetail) => {
      /**
       * Check if the user can join the tenant based on the email domain
       *
       * @param email - The email of the user
       * @param tenantId - The id of the tenant
       * @returns true if the user can join the tenant, false otherwise
       */

      // Skip this for the public tenant
      if (tenantId === "public") {
        return {
          canJoin: true,
          reason: undefined,
        };
      }

      // Check if the tenant is invite only in which case we
      // can't allow the user to join
      if (implementation.isTenantInviteOnly(tenantId)) {
        return {
          canJoin: false,
          reason: NOT_ALLOWED_TO_SIGNUP_REASONS.INVITE_ONLY,
        };
      }

      let canJoin = false;
      let reason = undefined;
      if (userIdentificationDetail.type === "email") {
        canJoin = implementation.isMatchingEmailDomain(tenantId, userIdentificationDetail.email);
        if (!canJoin) {
          reason = NOT_ALLOWED_TO_SIGNUP_REASONS.EMAIL_DOMAIN_NOT_ALLOWED;
        }
      } else if (userIdentificationDetail.type === "thirdParty") {
        canJoin = implementation.isApprovedIdPProvider(tenantId, userIdentificationDetail.thirdPartyId);
        if (!canJoin) {
          reason = NOT_ALLOWED_TO_SIGNUP_REASONS.IDP_NOT_ALLOWED;
        }
      } else if (userIdentificationDetail.type === "phoneNumber") {
        // We don't really have a way to check anything for phones so we can
        // allow signup.
        return {
          canJoin: true
        };
      }

      return {
        canJoin,
        reason,
      };
    },
    handleTenantJoiningApproval: async (
      user: User,
      tenantId: string,
      associateLoginMethodDef: AssociateAllLoginMethodsOfUserWithTenant,
      sendEmail: SendPluginEmail,
      appUrl: string,
      userContext: UserContext,
    ) => {
      /**
       * Handle the tenant joining functionality for the user.
       *
       * If the tenant requires approval, we will add a request for the
       * user.
       * If the tenant doesn't require approval, we will add them as a member
       * right away.
       *
       * @param user - The user to handle the tenant joining for
       * @param tenantId - The id of the tenant to handle the tenant joining for
       * @param associateLoginMethodDef - The function to associate the login methods of the user with the tenant
       */
      // Skip this for the public tenant
      if (tenantId === "public") {
        return {
          wasAddedToTenant: true,
          reason: undefined,
        };
      }

      // If the tenant doesn't require approval, add the user as a member
      // and return.
      if (!implementation.doesTenantRequireApproval(tenantId)) {
        // TODO: Use fn from implementation of base-tenants
        await assignRoleToUserInTenant(tenantId, user.id, ROLES.MEMBER);
        return {
          wasAddedToTenant: true,
        };
      }

      // We don't need to do anything in particular except notifying
      // the tenant admins about the new user request being added.
      // await implementation.sendTenantJoiningRequestEmail(tenantId, user, appUrl, sendEmail, userContext);

      return {
        wasAddedToTenant: false,
        reason: "REQUIRES_APPROVAL",
      };
    },
    isTenantInviteOnly: (tenantId) => {
      return config.inviteOnlyTenants?.includes(tenantId) ?? false;
    },
    doesTenantRequireApproval: (tenantId) => {
      return config.requiresApprovalTenants?.includes(tenantId) ?? false;
    },
    isApprovedIdPProvider: (thirdPartyId) => {
      return thirdPartyId.startsWith("boxy-saml");
    },
    isMatchingEmailDomain: (tenantId, email) => {
      const emailDomain = email.split("@");
      if (emailDomain.length !== 2) {
        return false;
      }

      const parsedTenantId = config.emailDomainToTenantIdMap[emailDomain[1]!.toLowerCase()];
      return parsedTenantId === tenantId;
    },
    sendTenantJoiningRequestEmail: async (tenantId, user, appUrl, sendEmail, userContext) => {
      /**
       * Send an email to all the admins of the tenant
       *
       * @param tenantId - The id of the tenant to send the email to
       * @param user - The user who is requesting to join the tenant
       * @param sendEmail - The function to send the email
       */
      // TODO: Use fn from implementation from base tenants
      const adminUsers = await implementation.getUserIdsInTenantWithRole(tenantId, ROLES.ADMIN);

      // For each of the users, we will need to find their email address.
      const adminEmails = await Promise.all(
        adminUsers.map(async (userId) => {
          const userDetails = await SuperTokens.getUser(userId);
          // TODO: Handle multiple emails?
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
                type: "TENANT_REQUEST_APPROVAL",
                email,
                tenantId,
                senderEmail: user.emails[0]!,
                appUrl,
              },
              userContext,
            );
          }),
      );
    },
    getUserIdsInTenantWithRole: async (tenantId, role) => {
      throw new Error("Not implemented");
    },
    isUserSigningUpToTenant: async (tenantId, details) => {
      /**
       * List the users by account info and filter using the passed
       * tenantId and email.
       */
      const accountInfoResponse = await listUsersByAccountInfo(tenantId, details);
      return accountInfoResponse.length === 0;
    },
  };

  return implementation;
};
