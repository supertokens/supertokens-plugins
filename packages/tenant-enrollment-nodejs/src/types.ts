import { User } from 'supertokens-node';
import {
  AssociateAllLoginMethodsOfUserWithTenant,
  GetUserIdsInTenantWithRole,
  SendPluginEmail,
} from '@supertokens-plugins/tenants-nodejs';
import { UserContext } from 'supertokens-node/lib/build/types';

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

export type EmailOrThirdPartyId =
  | {
      type: 'email';
      email: string;
    }
  | {
      type: 'thirdParty';
      thirdPartyId: string;
    };

export type OverrideableTenantFunctionImplementation = {
  canUserJoinTenant: (
    tenantId: string,
    emailOrThirdPartyId: EmailOrThirdPartyId,
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
};
