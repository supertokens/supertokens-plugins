export type SuperTokensPluginProfileSecurityConfig = {
  enableSettingPassword?: boolean;
  enableThirdPartyLinkning?: boolean;
  enableMfaConfiguration?: boolean;
};

export type SuperTokensPluginProfileSecurityNormalisedConfig = Required<SuperTokensPluginProfileSecurityConfig>;
