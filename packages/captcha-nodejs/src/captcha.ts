import { ReCaptchaV2Response, ReCaptchaV3Response, SuperTokensPluginCaptchaConfig, TurnstileResponse } from "./types";
import { CaptchaPluginError } from "./errors";

export const SupportedCaptchaTypes = ["reCAPTCHAv3", "reCAPTCHAv2", "turnstile"];

const CaptchaValidators: Record<
  SuperTokensPluginCaptchaConfig["type"],
  (captcha: string, config: SuperTokensPluginCaptchaConfig) => Promise<void>
> = {
  reCAPTCHAv3: verifyReCaptchaV3,
  reCAPTCHAv2: verifyReCaptchaV2,
  turnstile: verifyTurnstile,
};

export async function validateCaptcha(body: Record<string, unknown>, config: SuperTokensPluginCaptchaConfig) {
  const captcha = "captcha" in body ? (body.captcha as string) : null;
  const type = "captchaType" in body ? body.captchaType : null;

  if (!captcha) {
    throw new CaptchaPluginError("CAPTCHA_VERIFICATION_ERROR", "The 'captcha' field is required");
  }

  if (!type) {
    throw new CaptchaPluginError("CAPTCHA_VERIFICATION_ERROR", "The 'captchaType' field is required");
  }

  if (type !== config.type) {
    throw new CaptchaPluginError(
      "CAPTCHA_VERIFICATION_ERROR",
      `Invalid captcha type. Expected ${config.type} but got ${type}`,
    );
  }

  const validator = CaptchaValidators[config.type];
  if (!validator) {
    throw new CaptchaPluginError(
      "CAPTCHA_VERIFICATION_ERROR",
      `Unsupported captcha type: ${config.type}. Must be one of ${SupportedCaptchaTypes.join(", ")}`,
    );
  }

  await validator(captcha, config);
}

async function verifyReCaptchaV3(captcha: string, config: SuperTokensPluginCaptchaConfig): Promise<void> {
  const reCAPTCHAv3Key = config.captcha.secretKey;

  const response = await fetch(
    `https://www.google.com/recaptcha/api/siteverify?secret=${reCAPTCHAv3Key}&response=${captcha}`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new CaptchaPluginError("CAPTCHA_VERIFICATION_ERROR", "CAPTCHA verification failed");
  }

  const data = (await response.json()) as ReCaptchaV3Response;
  if (!data.success) {
    throw new CaptchaPluginError("CAPTCHA_VERIFICATION_ERROR", "CAPTCHA verification failed");
  }
}

async function verifyReCaptchaV2(captcha: string, config: SuperTokensPluginCaptchaConfig): Promise<void> {
  const reCAPTCHAv2Key = config.captcha.secretKey;

  const response = await fetch(
    `https://www.google.com/recaptcha/api/siteverify?secret=${reCAPTCHAv2Key}&response=${captcha}`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new CaptchaPluginError("CAPTCHA_VERIFICATION_ERROR", "CAPTCHA verification failed");
  }

  const data = (await response.json()) as ReCaptchaV2Response;
  if (!data.success) {
    throw new CaptchaPluginError("CAPTCHA_VERIFICATION_ERROR", "CAPTCHA verification failed");
  }
}

async function verifyTurnstile(captcha: string, config: SuperTokensPluginCaptchaConfig): Promise<void> {
  const turnstileKey = config.captcha?.secretKey;

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      secret: turnstileKey,
      response: captcha,
    }),
  });
  if (!response.ok) {
    throw new CaptchaPluginError("CAPTCHA_VERIFICATION_ERROR", "CAPTCHA verification failed");
  }

  const data = (await response.json()) as TurnstileResponse;
  if (!data.success) {
    throw new CaptchaPluginError("CAPTCHA_VERIFICATION_ERROR", "CAPTCHA verification failed");
  }
}
