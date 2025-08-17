import { SuperTokensPluginCaptchaConfig } from './types';

import { SuperTokensPublicConfig } from 'supertokens-auth-react/lib/build/types';

let PluginConfig: SuperTokensPluginCaptchaConfig;
const SupportedCaptchaTypes = ['reCAPTCHAv3', 'reCAPTCHAv2', 'turnstile'];

export function setPluginConfig(config: SuperTokensPluginCaptchaConfig) {
  if (PluginConfig) {
    throw new Error('Plugin was already initialised');
  }

  if (!SupportedCaptchaTypes.includes(config.type)) {
    throw new Error(`Unsupported CAPTCHA type - ${config.type}`);
  }

  if (config.type === 'reCAPTCHAv3' && !config.captcha.sitekey) {
    throw new Error('reCAPTCHAv3 site key is required');
  }
  if (config.type === 'reCAPTCHAv2' && !config.captcha.sitekey) {
    throw new Error('reCAPTCHAv2 site key is required');
  }
  if (config.type === 'turnstile' && !config.captcha.sitekey) {
    throw new Error('turnstile site key is required');
  }

  if (config.type === 'reCAPTCHAv3' && config.InputContainer) {
    throw new Error('reCAPTCHAv3 does not support rendering');
  }

  PluginConfig = config;
}

export function getPluginConfig(): SuperTokensPluginCaptchaConfig {
  if (!PluginConfig) {
    throw new Error('The plugin was not initialised');
  }
  return PluginConfig;
}

export function validatePublicConfig(config: SuperTokensPublicConfig) {
  const pluginConfig = getPluginConfig();
  if (config.useShadowDom && pluginConfig.type !== 'reCAPTCHAv3') {
    throw new Error(
      'The captcha input cannot be rendered when using shadow dom',
    );
  }
}
