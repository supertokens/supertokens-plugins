import { TenantConfig } from "supertokens-node/lib/build/recipe/multitenancy/types";

export type SuperTokensPluginTenantDiscoveryPluginConfig = {
  // List of email domains that should be restricted
  // along with the already blacklisted ones.
  restrictedEmailDomains?: Array<string>;
};

export type SuperTokensPluginTenantDiscoveryPluginNormalisedConfig = {
  // List of email domains that should be restricted
  // along with the already blacklisted ones.
  restrictedEmailDomains?: Array<string>;
};

export type OverrideableTenantFunctionImplementation = {
  getTenantIdFromEmail: (email: string) => Promise<string>;
  getTenants: () => Promise<({ tenantId: string } & TenantConfig)[]>;
  isValidTenant: (tenantId: string) => Promise<boolean>;
};
