import { defaultTranslationsTenantDiscovery } from "./translations";

export type SuperTokensPluginTenantDiscoveryPluginConfig = {
  showTenantSelector?: boolean;
  extractTenantIdFromDomain?: boolean;
};

export type SuperTokensPluginTenantDiscoveryPluginNormalisedConfig = {
  showTenantSelector?: boolean;
  extractTenantIdFromDomain?: boolean;
};

export type OverrideableTenantFunctionImplementation = {
  setTenantId: (tenantId: string, email?: string, shouldRefresh?: boolean) => void;
  determineTenantFromURL: () => Promise<string | undefined>;
  shouldDetermineTenantFromURL: () => Promise<boolean>;
  determineTenantFromSubdomain: () => Promise<string | undefined>;
};

export interface TenantDetails {
  tenantId: string;
}

export interface TenantList {
  tenants: TenantDetails[];
}

export type TranslationKeys = keyof (typeof defaultTranslationsTenantDiscovery)["en"];
