import { defaultTranslationsUserBanning } from "./translations";

export type SuperTokensPluginUserBanningPluginConfig = {
  userBanningPermission?: string;
  bannedUserRole?: string;
  onPermissionFailureRedirectPath?: string;
};

export type SuperTokensPluginUserBanningPluginNormalisedConfig = {
  userBanningPermission: string;
  bannedUserRole: string;
  onPermissionFailureRedirectPath: string;
};

export type SuperTokensPluginUserBanningImplementation = {
  logger: (originalImplementation: (...args: any[]) => void) => (...args: any[]) => void;
};

export type TranslationKeys = keyof (typeof defaultTranslationsUserBanning)["en"];
