import SuperTokensError from "supertokens-node/lib/build/error";

type CaptchaPluginErrorType = "CAPTCHA_VERIFICATION_ERROR" | "PLUGIN_CONFIG_ERROR";

export class CaptchaPluginError extends SuperTokensError {
  constructor(type: CaptchaPluginErrorType, message: string) {
    super({ type, message });
  }
}
