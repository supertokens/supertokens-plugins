import { defaultTranslationsTenantDiscovery } from "./translations";

export type SuperTokensPluginTenantDiscoveryPluginConfig = {
  showTenantSelector?: boolean;
  extractTenantIdFromDomain?: boolean;
};

export type SuperTokensPluginTenantDiscoveryPluginNormalisedConfig = {
  showTenantSelector?: boolean;
  extractTenantIdFromDomain?: boolean;
};

export type ParseTenantIdReturnType =
  | { tenantId: string; shouldShowSelector: false }
  | { tenantId: null; shouldShowSelector: true };

export type OverrideableTenantFunctionImplementation = {
  setTenantId: (tenantId: string, email?: string, shouldRefresh?: boolean) => void;
  determineTenantFromURL: () => Promise<string | undefined>;
  shouldDetermineTenantFromURL: () => Promise<boolean>;
  determineTenantFromSubdomain: () => string | undefined;
  parseTenantId: () => ParseTenantIdReturnType;
};

export interface TenantDetails {
  tenantId: string;
}

export interface TenantList {
  tenants: TenantDetails[];
}

export type TranslationKeys = keyof (typeof defaultTranslationsTenantDiscovery)["en"];
