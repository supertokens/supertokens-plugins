import { UserContext } from "supertokens-node/types";

export type SuperTokensPluginTenantDiscoveryPluginConfig = {
  // Option to opt-in for the tenant selector dropdown
  enableTenantListAPI?: boolean;
};

export type SuperTokensPluginTenantDiscoveryPluginNormalisedConfig = {
  // Option to opt-in for the tenant selector dropdown
  enableTenantListAPI: boolean;
};

export type MinimalTenantDetails = {
  tenantId: string;
  displayName: string;
}

export type OverrideableTenantFunctionImplementation = {
  getTenantIdFromEmail: (email: string) => Promise<string>;
  getTenants: (userContext?: UserContext) => Promise<MinimalTenantDetails[]>;
  isValidTenant: (tenantId: string, userContext?: UserContext) => Promise<boolean>;
  isRestrictedEmailDomain: (emailDomain: string) => boolean;
};
