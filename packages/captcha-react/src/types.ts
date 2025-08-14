/// <reference types="@types/cloudflare-turnstile" />
/// <reference types="@types/grecaptcha" />

import { RecipePreAPIHookContext } from 'supertokens-auth-react/lib/build/recipe/recipeModule/types';
import { PreAndPostAPIHookAction as EmailPasswordPreAndPostAPIHookAction } from 'supertokens-auth-react/lib/build/recipe/emailpassword/types';
import { PreAndPostAPIHookAction as PasswordlessPreAndPostAPIHookAction } from 'supertokens-auth-react/lib/build/recipe/passwordless/types';

declare global {
  interface Window {
    grecaptcha: ReCaptchaV2.ReCaptcha;
    turnstile: Turnstile.Turnstile;
    onLoadReCAPTCHAv2: () => void;
    onLoadTurnstile: () => void;
  }
}

export interface CaptchaProvider {
  load: (onLoad?: () => void) => Promise<void>;
  render?: (
    container: HTMLDivElement,
    onSubmit: (token: string) => void,
    onError: (error: Error) => void
  ) => void;
  getToken: () => Promise<string>;
}

export type ReCAPTCHAv2Config = ReCaptchaV2.Parameters;
export type ReCAPTCHAv3Config = {
  /**
   * Your sitekey.
   */
  sitekey: string;
  /**
   * The name of the action. Actions may only contain alphanumeric characters and slashes, and must not be user-specific.
   */
  action?: string;
};
export type TurnstileConfig = Turnstile.RenderParameters;

type CaptchaConfig =
  | {
      type: 'reCAPTCHAv3';
      captcha: ReCAPTCHAv3Config;
    }
  | {
      type: 'reCAPTCHAv2';
      captcha: ReCAPTCHAv2Config;
    }
  | {
      type: 'turnstile';
      captcha: TurnstileConfig;
    };

export type EmailPasswordCaptchaPreAndPostAPIHookActions = Extract<
  EmailPasswordPreAndPostAPIHookAction,
  | 'EMAIL_PASSWORD_SIGN_UP'
  | 'EMAIL_PASSWORD_SIGN_IN'
  | 'SUBMIT_NEW_PASSWORD'
  | 'SEND_RESET_PASSWORD_EMAIL'
>;

export function isEmailPasswordCaptchaPreAndPostAPIHookAction(
  action: string
): action is EmailPasswordCaptchaPreAndPostAPIHookActions {
  return (
    action === 'EMAIL_PASSWORD_SIGN_UP' ||
    action === 'EMAIL_PASSWORD_SIGN_IN' ||
    action === 'SEND_RESET_PASSWORD_EMAIL' ||
    action === 'SUBMIT_NEW_PASSWORD'
  );
}

export type PasswordlessCaptchaPreAndPostAPIHookActions = Extract<
  PasswordlessPreAndPostAPIHookAction,
  | 'PASSWORDLESS_CONSUME_CODE'
  | 'PASSWORDLESS_CREATE_CODE'
  | 'PASSWORDLESS_RESEND_CODE' // We do not have a matching override in the backend, do we want this in the list?
>;

export function isPasswordlessCaptchaPreAndPostAPIHookAction(
  action: string
): action is PasswordlessCaptchaPreAndPostAPIHookActions {
  return (
    action === 'PASSWORDLESS_CONSUME_CODE' ||
    action === 'PASSWORDLESS_CREATE_CODE' ||
    action === 'PASSWORDLESS_RESEND_CODE'
  );
}

export type SuperTokensPluginCaptchaConfig = CaptchaConfig & {
  InputContainer?: React.ForwardRefExoticComponent<
    CaptchInputContainerProps & React.RefAttributes<HTMLDivElement>
  >;
  inputContainerId?: string | (() => Promise<string>);
  shouldValidate?: (
    contenxt:
      | RecipePreAPIHookContext<EmailPasswordPreAndPostAPIHookAction>
      | RecipePreAPIHookContext<PasswordlessPreAndPostAPIHookAction>
  ) => boolean;
};

export type CaptchInputContainerProps = {
  form:
    | 'EmailPasswordSignInForm'
    | 'EmailPasswordSignUpForm'
    | 'EmailPasswordResetPasswordEmail'
    | 'EmailPasswordSubmitNewPassword'
    | 'PasswordlessEmailForm'
    | 'PasswordlessPhoneForm'
    | 'PasswordlessEmailOrPhoneForm'
    | 'PasswordlessEPComboEmailForm'
    | 'PasswordlessEPComboEmailOrPhoneForm'
    | 'PasswordlessUserInputForm';
} & React.HTMLAttributes<HTMLDivElement>;
