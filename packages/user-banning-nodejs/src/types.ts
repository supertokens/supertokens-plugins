export type SuperTokensPluginUserBanningPluginConfig = {
  userBanningPermission?: string;
  bannedUserRole?: string;
  globalBanning: boolean;
};

export type SuperTokensPluginUserBanningPluginNormalisedConfig = {
  userBanningPermission: string;
  bannedUserRole: string;
  globalBanning: boolean;
};
