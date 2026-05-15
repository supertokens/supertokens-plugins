import { User } from "supertokens-node";
import {
  AssociateAllLoginMethodsOfUserWithTenant,
  GetUserIdsInTenantWithRole,
  SendPluginEmail,
  AssignRoleToUserInTenant,
} from "@supertokens-plugins/tenants-nodejs";
import { UserContext } from "supertokens-node/lib/build/types";
import { NotAllowedToSignUpReason } from "../../../shared/tenants/src/types";
import { AccountInfoInput } from "supertokens-node/recipe/accountlinking/types";

export type SuperTokensPluginTenantEnrollmentPluginConfig = {
  emailDomainToTenantIdMap: Record<string, string>;
  inviteOnlyTenants?: string[];
  requiresApprovalTenants?: string[];
  allowSignUpToPublicTenant?: boolean;
};

export type SuperTokensPluginTenantEnrollmentPluginNormalisedConfig = {
  emailDomainToTenantIdMap: Record<string, string>;
  inviteOnlyTenants: string[];
  requiresApprovalTenants: string[];
  allowSignUpToPublicTenant: boolean;
};

export type SuperTokensPluginTenantEnrollmentPluginContext = {
  associateLoginMethod: AssociateAllLoginMethodsOfUserWithTenant,
  assignRoleToUserInTenant: AssignRoleToUserInTenant,
  getUserIdsInTenantWithRole: GetUserIdsInTenantWithRole
  sendPluginEmail: SendPluginEmail;
}

export type UserIdentificationDetail =
  | {
      type: "email";
      email: string;
    }
  | {
      type: "thirdParty";
      thirdPartyId: string;
    }
  | {
      type: "phoneNumber";
      phoneNumber: string;
    };

export type OverrideableTenantFunctionImplementation = {
  canUserJoinTenant: (
    tenantId: string,
    emailOrThirdPartyId: UserIdentificationDetail,
  ) => Promise<{
    canJoin: boolean;
    reason?: string;
  }>;
  handleTenantJoiningApproval: (
    user: User,
    tenantId: string,
    appUrl: string,
    userContext: UserContext,
  ) => Promise<{
    wasAddedToTenant: boolean;
    reason?: string;
  }>;
  isTenantInviteOnly: (tenantId: string) => boolean;
  doesTenantRequireApproval: (tenantId: string) => boolean;
  isApprovedIdPProvider: (tenantId: string, thirdPartyId: string) => boolean;
  isMatchingEmailDomain: (tenantId: string, email: string) => boolean;
  isPhoneNumberAllowed: (tenantId: string, phoneNumber: string) => boolean;
  sendTenantJoiningRequestEmail: (
    tenantId: string,
    user: User,
    appUrl: string,
    userContext: UserContext,
  ) => Promise<void>;
  isUserSigningUpToTenant: (tenantId: string, details: AccountInfoInput, recipeId: string) => Promise<boolean>;
  getMessageForNoSignUpReason: (reason: NotAllowedToSignUpReason) => string;
  filterAdminEmailsToNotify: (adminUserIds: string[]) => Promise<string[]>;
};
