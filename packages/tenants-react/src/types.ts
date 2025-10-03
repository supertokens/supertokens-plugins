import { User } from "supertokens-web-js/types";

import { defaultTranslationsTenants } from "./translations";


export type SuperTokensPluginTenantsPluginConfig = {
  requireTenantCreation?: boolean;
};

export type SuperTokensPluginTenantsPluginNormalisedConfig = {
  requireTenantCreation?: boolean;
};

export type TranslationKeys = keyof (typeof defaultTranslationsTenants)["en"];

export type UserWithRole = { roles: string[] } & User;
