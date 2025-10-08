import { User } from "supertokens-web-js/types";

import { defaultTranslationsTenants } from "./translations";

export type SuperTokensPluginTenantsPluginConfig = {
  requireTenantCreation?: boolean;
  redirectToUrlOnJoiningTenant?: string | (() => void);
};

export type SuperTokensPluginTenantsPluginNormalisedConfig = {
  requireTenantCreation?: boolean;
  redirectOnJoiningTenantFn: () => void;
};

export type TranslationKeys = keyof (typeof defaultTranslationsTenants)["en"];

export type UserWithRole = { roles: string[] } & User;
