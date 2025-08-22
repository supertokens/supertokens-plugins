export type SuperTokensPluginUserBanningPluginConfig = {
  userBanningPermission?: string;
  bannedUserRole?: string;
};

export type SuperTokensPluginUserBanningPluginNormalisedConfig = {
  userBanningPermission: string;
  bannedUserRole: string;
};

export type SuperTokensPluginUserBanningImplementation = {
  logger: (originalImplementation: (...args: any[]) => void) => (...args: any[]) => void;
};
