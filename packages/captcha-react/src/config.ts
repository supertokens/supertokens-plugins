import { SuperTokensPluginCaptchaConfig } from './types';

import { SuperTokensPublicConfig } from 'supertokens-auth-react/lib/build/types';

let PluginConfig: SuperTokensPluginCaptchaConfig;
const SupportedCaptchaTypes = ['reCAPTCHAv3', 'reCAPTCHAv2', 'turnstile'];

const SUPERTOKENS_DEBUG_NAMESPACE = 'com.supertokens.plugin-captcha';

let __debugLogsEnabled = false;

export function enableLogging(): void {
  __debugLogsEnabled = true;
}

export function logDebugMessage(message: string): void {
  // if(!__debugLogsEnabled) return;
  console.log(
    `${SUPERTOKENS_DEBUG_NAMESPACE} {t: "${new Date().toISOString()}", message: "${message}", supertokens-plugin-captcha: ""}`
  );
}

export function setPluginConfig(config: SuperTokensPluginCaptchaConfig) {
  logDebugMessage(`Setting plugin config for type: ${config.type}`);

  if (PluginConfig) {
    throw new Error('Plugin was already initialised');
  }

  if (!SupportedCaptchaTypes.includes(config.type)) {
    logDebugMessage(`Unsupported CAPTCHA type: ${config.type}`);
    throw new Error('Unsupported CAPTCHA type');
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
  logDebugMessage('Plugin config set successfully');
}

export function getPluginConfig(): SuperTokensPluginCaptchaConfig {
  if (!PluginConfig) {
    logDebugMessage('Plugin config not found - plugin was not initialised');
    throw new Error('The plugin was not initialised');
  }
  return PluginConfig;
}

export function validatePublicConfig(config: SuperTokensPublicConfig) {
  logDebugMessage('Validating public config');
  const pluginConfig = getPluginConfig();
  if (config.useShadowDom && pluginConfig.type !== 'reCAPTCHAv3') {
    logDebugMessage(
      `Shadow DOM incompatible with captcha type: ${pluginConfig.type}`
    );
    throw new Error(
      'The captcha input cannot be rendered when using shadow dom'
    );
  }
  logDebugMessage('Public config validation passed');
}
