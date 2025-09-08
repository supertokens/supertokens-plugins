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
  determineTenantFromSubdomain: () => string | undefined;
  parseTenantId: () => ParseTenantIdReturnType;
  setEmailId: (emailId: string) => void;
  getEmailId: () => string | undefined;
  removeEmailId: () => void;
};

export interface TenantDetails {
  tenantId: string;
}

export interface TenantList {
  tenants: TenantDetails[];
}

export type TranslationKeys = keyof (typeof defaultTranslationsTenantDiscovery)["en"];
