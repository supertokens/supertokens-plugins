import { TenantConfig } from "supertokens-node/lib/build/recipe/multitenancy/types";

export type SuperTokensPluginTenantDiscoveryPluginConfig = {
  // Option to opt-in for the tenant selector dropdown
  showTenantSelector?: boolean;
};

export type SuperTokensPluginTenantDiscoveryPluginNormalisedConfig = {
  // Option to opt-in for the tenant selector dropdown
  showTenantSelector: boolean;
};

export type OverrideableTenantFunctionImplementation = {
  getTenantIdFromEmail: (email: string) => Promise<string>;
  getTenants: () => Promise<({ tenantId: string } & TenantConfig)[]>;
  isValidTenant: (tenantId: string) => Promise<boolean>;
  isRestrictedEmailDomain: (emailDomain: string) => boolean;
};
