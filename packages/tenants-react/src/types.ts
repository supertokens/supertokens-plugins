import { User } from "supertokens-web-js/types";

import { defaultTranslationsTenants } from "./translations";


export type SuperTokensPluginTenantsPluginConfig = {
  requireTenantCreation?: boolean;
  redirectToUrlOnJoiningTenant?: string;
};

export type SuperTokensPluginTenantsPluginNormalisedConfig = {
  requireTenantCreation?: boolean;
  redirectToUrlOnJoiningTenant: string;
};

export type TranslationKeys = keyof (typeof defaultTranslationsTenants)["en"];

export type UserWithRole = { roles: string[] } & User;
