/* eslint-disable @typescript-eslint/no-unused-vars */
import { User, listUsersByAccountInfo } from "supertokens-node";
import {
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantEnrollmentPluginContext,
  SuperTokensPluginTenantEnrollmentPluginNormalisedConfig,
} from "./types";
import { NOT_ALLOWED_TO_SIGNUP_REASON_MESSAGE, NotAllowedToSignUpReason, ROLES } from "@shared/tenants";
import SuperTokens from "supertokens-node";
import { UserContext } from "supertokens-node/lib/build/types";

export const getOverrideableTenantFunctionImplementation = (
  config: SuperTokensPluginTenantEnrollmentPluginNormalisedConfig,
  pluginContext: Partial<SuperTokensPluginTenantEnrollmentPluginContext>,
): OverrideableTenantFunctionImplementation => {
  const implementation: OverrideableTenantFunctionImplementation = {
    canUserJoinTenant: async function (tenantId, userIdentificationDetail) {
      /**
       * Check if the user can join the tenant based on the email domain
       *
       * @param email - The email of the user
       * @param tenantId - The id of the tenant
       * @returns true if the user can join the tenant, false otherwise
       */

      // Skip this for the public tenant
      if (config.allowSignUpToPublicTenant === true && tenantId === "public") {
        return {
          canJoin: true,
          reason: undefined,
        };
      }

      // Check if the tenant is invite only in which case we
      // can't allow the user to join
      if (this.isTenantInviteOnly(tenantId)) {
        return {
          canJoin: false,
          reason: this.getMessageForNoSignUpReason(NotAllowedToSignUpReason.INVITE_ONLY),
        };
      }

      let canJoin = false;
      let reason = undefined;
      if (userIdentificationDetail.type === "email") {
        canJoin = this.isMatchingEmailDomain(tenantId, userIdentificationDetail.email);
        if (!canJoin) {
          reason = this.getMessageForNoSignUpReason(NotAllowedToSignUpReason.EMAIL_DOMAIN_NOT_ALLOWED);
        }
      } else if (userIdentificationDetail.type === "thirdParty") {
        canJoin = this.isApprovedIdPProvider(tenantId, userIdentificationDetail.thirdPartyId);
        if (!canJoin) {
          reason = this.getMessageForNoSignUpReason(NotAllowedToSignUpReason.IDP_NOT_ALLOWED);
        }
      } else if (userIdentificationDetail.type === "phoneNumber") {
        // We don't really have a way to check anything for phones so we can
        // allow signup.
        canJoin = this.isPhoneNumberAllowed(tenantId, userIdentificationDetail.phoneNumber);
        if (!canJoin) {
          reason = this.getMessageForNoSignUpReason(NotAllowedToSignUpReason.PHONE_NOT_ALLOWED);
        }
      }

      return {
        canJoin,
        reason,
      };
    },
    handleTenantJoiningApproval: async function (
      user: User,
      tenantId: string,
      appUrl: string,
      userContext: UserContext,
    ) {
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
       */
      // Skip this for the public tenant
      if (config.allowSignUpToPublicTenant === true && tenantId === "public") {
        return {
          wasAddedToTenant: true,
          reason: undefined,
        };
      }

      // If the tenant doesn't require approval, add the user as a member
      // and return.
      if (!this.doesTenantRequireApproval(tenantId)) {
        await normalizePluginContextType(pluginContext).assignRoleToUserInTenant(
          tenantId,
          user.id,
          ROLES.TENANT_MEMBER,
        );
        return {
          wasAddedToTenant: true,
        };
      }

      // We don't need to do anything in particular except notifying
      // the tenant admins about the new user request being added.
      await this.sendTenantJoiningRequestEmail(tenantId, user, appUrl, userContext);

      return {
        wasAddedToTenant: false,
        reason: "REQUIRES_APPROVAL",
      };
    },
    isTenantInviteOnly: function (tenantId) {
      return config.inviteOnlyTenants?.includes(tenantId) ?? false;
    },
    doesTenantRequireApproval: function (tenantId) {
      return config.requiresApprovalTenants?.includes(tenantId) ?? false;
    },
    isApprovedIdPProvider: function (thirdPartyId) {
      return thirdPartyId.startsWith("boxy-saml");
    },
    isMatchingEmailDomain: function (tenantId, email) {
      const emailDomain = email.split("@");
      if (emailDomain.length !== 2) {
        return false;
      }

      const parsedTenantId =
        config.emailDomainToTenantIdMap[emailDomain[1]!.toLowerCase()] ?? emailDomain[1]!.toLowerCase();
      return parsedTenantId === tenantId;
    },
    sendTenantJoiningRequestEmail: async function (tenantId, user, appUrl, userContext) {
      /**
       * Send an email to all the admins of the tenant
       *
       * @param tenantId - The id of the tenant to send the email to
       * @param user - The user who is requesting to join the tenant
       */
      const adminUsers = await normalizePluginContextType(pluginContext).getUserIdsInTenantWithRole(
        tenantId,
        ROLES.TENANT_ADMIN,
      );

      // For each of the users, we will need to find their email address.
      const adminEmails = await this.filterAdminEmailsToNotify(adminUsers);

      // Send emails to all tenant admins using Promise.all
      // NOTE: No need to await for all the emails to be sent
      Promise.all(
        adminEmails
          .filter((email) => email !== undefined)
          .map(async (email) => {
            await normalizePluginContextType(pluginContext).sendPluginEmail(
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
    filterAdminEmailsToNotify: async function (adminUserIds) {
      /**
       * Filter and return the admin emails to notify for tenant joining requests.
       */
      const adminEmails = await Promise.all(
        adminUserIds.map(async (userId) => {
          const userDetails = await SuperTokens.getUser(userId);

          // We are using the first email that belongs to the user.
          // This can always be overridden to change this behavior.
          return userDetails?.emails[0];
        }),
      );
      return adminEmails.filter((adminEmail) => adminEmail !== undefined);
    },
    isUserSigningUpToTenant: async function (tenantId, details, recipeId) {
      /**
       * List the users by account info and filter using the passed
       * tenantId and email.
       */
      const accountInfoResponse = await listUsersByAccountInfo(tenantId, details);

      // Check if the user with the same details exist in the recipe.
      const isAccountPresent = accountInfoResponse.find((user) => {
        user.loginMethods.find((lm) => {
          // Check if recipe ID matches.
          if (lm.recipeId !== recipeId) return false;

          // Check email/phoneNumber/third-party match based on the passed details
          if ("email" in details) return lm.hasSameEmailAs(details.email);
          else if ("phoneNumber" in details) return lm.hasSamePhoneNumberAs(details.phoneNumber);
          else if ("thirdParty" in details) return lm.hasSameThirdPartyInfoAs(details.thirdParty);

          // If nothing matches, return `false`.
          return false;
        });
      });

      return isAccountPresent ? false : true;
    },
    getMessageForNoSignUpReason: function (reason) {
      /**
       * Return a proper message for the passed reason for not
       * allowing signup.
       */
      return NOT_ALLOWED_TO_SIGNUP_REASON_MESSAGE[reason];
    },
    isPhoneNumberAllowed: function (tenantId, phoneNumber) {
      /**
       * Check if the phone number is allowed to join the tenant
       *
       * @param tenantId - The id of the tenant to check if the phone number is allowed to join
       * @param phoneNumber - The phone number to check if it is allowed to join the tenant
       * @returns true if the phone number is allowed to join the tenant, false otherwise
       */
      return true;
    },
  };

  return implementation;
};

function isInitializedPluginContext(
  pluginContext: Partial<SuperTokensPluginTenantEnrollmentPluginContext>,
): pluginContext is SuperTokensPluginTenantEnrollmentPluginContext {
  // None of them should be undefined.
  return (
    pluginContext.assignRoleToUserInTenant !== undefined &&
    pluginContext.associateLoginMethod !== undefined &&
    pluginContext.getUserIdsInTenantWithRole !== undefined &&
    pluginContext.sendPluginEmail !== undefined
  );
}

function normalizePluginContextType(
  pluginContext: Partial<SuperTokensPluginTenantEnrollmentPluginContext>,
): SuperTokensPluginTenantEnrollmentPluginContext {
  if (isInitializedPluginContext(pluginContext)) {
    return pluginContext;
  } else {
    throw Error("pluginContext not initialized");
  }
}
