import { User } from "supertokens-node";
import {
  AssociateAllLoginMethodsOfUserWithTenant,
  GetUserIdsInTenantWithRole,
  SendPluginEmail,
  AssignRoleToUserInTenant,
} from "@supertokens-plugins/tenants-nodejs";
import { UserContext } from "supertokens-node/lib/build/types";

export type SuperTokensPluginTenantEnrollmentPluginConfig = {
  emailDomainToTenantIdMap: Record<string, string>;
  inviteOnlyTenants?: string[];
  requiresApprovalTenants?: string[];
};

export type SuperTokensPluginTenantEnrollmentPluginNormalisedConfig = {
  emailDomainToTenantIdMap: Record<string, string>;
  inviteOnlyTenants: string[];
  requiresApprovalTenants: string[];
};

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
    associateLoginMethodDef: AssociateAllLoginMethodsOfUserWithTenant,
    sendEmail: SendPluginEmail,
    appUrl: string,
    userContext: UserContext,
    assignRoleToUserInTenant: AssignRoleToUserInTenant,
  ) => Promise<{
    wasAddedToTenant: boolean;
    reason?: string;
  }>;
  isTenantInviteOnly: (tenantId: string) => boolean;
  doesTenantRequireApproval: (tenantId: string) => boolean;
  isApprovedIdPProvider: (tenantId: string, thirdPartyId: string) => boolean;
  isMatchingEmailDomain: (tenantId: string, email: string) => boolean;
  sendTenantJoiningRequestEmail: (
    tenantId: string,
    user: User,
    appUrl: string,
    sendEmail: SendPluginEmail,
    userContext: UserContext,
  ) => Promise<void>;
  getUserIdsInTenantWithRole: GetUserIdsInTenantWithRole;
  isUserSigningUpToTenant: (tenantId: string, details: { email?: string; phoneNumber?: string }) => Promise<boolean>;
};
