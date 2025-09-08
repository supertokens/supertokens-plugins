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
  | { tenantId: string; doTenantDiscovery: false }
  | { tenantId: null; doTenantDiscovery: true };

export type FromEmailReturnType = | { status: "OK"; tenant: string }
| { status: "NOT_ALLOWED"; message: string }
| { status: "ERROR"; message: string }

export type OverrideableTenantFunctionImplementation = {
  setTenantId: (tenantId: string) => void;
  determineTenantFromURL: () => Promise<string | undefined>;
  determineTenantFromSubdomain: () => string | undefined;
  parseTenantId: () => ParseTenantIdReturnType;
  setEmailId: (emailId: string) => void;
  getEmailId: () => string | undefined;
  removeEmailId: () => void;
  getTenantIdFromQuery: () => string | undefined;
};

export interface TenantDetails {
  tenantId: string;
  displayName: string;
}

export interface TenantList {
  tenants: TenantDetails[];
}

export type TranslationKeys = keyof (typeof defaultTranslationsTenantDiscovery)["en"];
