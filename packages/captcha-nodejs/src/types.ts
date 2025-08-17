import { APIInterface as EmailPasswordAPIInterface } from 'supertokens-node/recipe/emailpassword/types';
import { APIInterface as PasswordlessAPIInterface } from 'supertokens-node/recipe/passwordless/types';

export interface ShouldValidate {
  (
    api: 'signInPOST',
    input: Parameters<NonNullable<EmailPasswordAPIInterface['signInPOST']>>[0],
  ): boolean | Promise<boolean>;
  (
    api: 'signUpPOST',
    input: Parameters<NonNullable<EmailPasswordAPIInterface['signUpPOST']>>[0],
  ): boolean | Promise<boolean>;
  (
    api: 'passwordResetPOST',
    input: Parameters<
      NonNullable<EmailPasswordAPIInterface['passwordResetPOST']>
    >[0],
  ): boolean | Promise<boolean>;
  (
    api: 'generatePasswordResetTokenPOST',
    input: Parameters<
      NonNullable<EmailPasswordAPIInterface['generatePasswordResetTokenPOST']>
    >[0],
  ): boolean | Promise<boolean>;
  (
    api: 'consumeCodePOST',
    input: Parameters<
      NonNullable<PasswordlessAPIInterface['consumeCodePOST']>
    >[0],
  ): boolean | Promise<boolean>;
  (
    api: 'createCodePOST',
    input: Parameters<
      NonNullable<PasswordlessAPIInterface['createCodePOST']>
    >[0],
  ): boolean | Promise<boolean>;
  (
    api: 'consumeCodePOST',
    input: Parameters<
      NonNullable<PasswordlessAPIInterface['consumeCodePOST']>
    >[0],
  ): boolean | Promise<boolean>;
}

export type SuperTokensPluginCaptchaConfig = {
  type: 'reCAPTCHAv3' | 'reCAPTCHAv2' | 'turnstile';
  captcha: {
    secretKey: string;
  };
  // By default the captcha validation is performed on all the form submit actions
  // Use this property to specify when to perform the validation
  shouldValidate?: ShouldValidate;
};

export type ReCaptchaV3Response = {
  success: boolean;
  'error-codes': string[];
  hostname: string;
  action: string;
  score: number;
  challenge_ts: string;
};

export type ReCaptchaV2Response = {
  success: boolean;
  action: string;
  'error-codes': string[];
  challenge_ts: string;
};

export type TurnstileResponse = {
  success: boolean;
  'error-codes': string[];
  hostname: string;
  challenge_ts: string;
};
