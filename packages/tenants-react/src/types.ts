import { defaultTranslationsTenants } from "./translations";


export type SuperTokensPluginTenantsPluginConfig = {
  requireTenantCreation?: boolean;
};

export type SuperTokensPluginTenantsPluginNormalisedConfig = {
  requireTenantCreation?: boolean;
};

export type TranslationKeys = keyof (typeof defaultTranslationsTenants)["en"];
