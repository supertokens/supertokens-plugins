type CaptchaPluginErrorType = "CAPTCHA_VERIFICATION_ERROR" | "PLUGIN_CONFIG_ERROR";

export class CaptchaPluginError extends Error {
  constructor(public type: CaptchaPluginErrorType, message: string) {
    super(message);
  }
}
