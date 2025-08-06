import { SuperTokensPluginCaptchaConfig } from "./types";

export const PLUGIN_ID = "supertokens-plugin-captcha";
export const PLUGIN_SDK_VERSION = "22.1.0-canary-plugins.0";

let PluginConfig: SuperTokensPluginCaptchaConfig;

export function getPluginConfig() {
  if (!PluginConfig) {
    throw new Error("The plugin was not initialised");
  }

  return PluginConfig;
}

export function setPluginConfig(config: SuperTokensPluginCaptchaConfig) {
  if (!config.type) {
    throw new Error("The captcha type is required");
  }

  if (
    config.type === "reCAPTCHAv3" &&
    config.captcha?.secretKey === undefined
  ) {
    throw new Error("reCAPTCHAv3 secretKey is required");
  }

  if (
    config.type === "reCAPTCHAv2" &&
    config.captcha?.secretKey === undefined
  ) {
    throw new Error("reCAPTCHAv2 secretKey is required");
  }

  if (config.type === "turnstile" && config.captcha?.secretKey === undefined) {
    throw new Error("turnstile secretKey is required");
  }

  PluginConfig = config;
}
