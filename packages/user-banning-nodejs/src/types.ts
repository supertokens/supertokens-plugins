export type SuperTokensPluginUserBanningPluginConfig = {
  userBanningPermission?: string;
  bannedUserRole?: string;
};

export type SuperTokensPluginUserBanningPluginNormalisedConfig = {
  userBanningPermission: string;
  bannedUserRole: string;
};

export type SuperTokensPluginUserBanningPluginLogger = (...args: any[]) => void;

export type SuperTokensPluginUserBanningImplementation = {
  logger: (
    originalImplementation: SuperTokensPluginUserBanningPluginLogger
  ) => SuperTokensPluginUserBanningPluginLogger;
};
