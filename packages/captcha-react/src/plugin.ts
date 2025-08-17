import { SuperTokensPlugin } from 'supertokens-auth-react/lib/build/types';
import { PLUGIN_ID } from './constants';
import { ComponentOverrides } from './components';
import { captcha } from './captcha';
import {
  isEmailPasswordCaptchaPreAndPostAPIHookAction,
  isPasswordlessCaptchaPreAndPostAPIHookAction,
  SuperTokensPluginCaptchaConfig,
} from './types';
import { PreAndPostAPIHookAction as EmailPasswordPreAndPostAPIHookAction } from 'supertokens-auth-react/lib/build/recipe/emailpassword/types';
import { PreAndPostAPIHookAction as PasswordlessPreAndPostAPIHookAction } from 'supertokens-auth-react/lib/build/recipe/passwordless/types';
import {
  setPluginConfig,
  validatePublicConfig,
  getPluginConfig,
} from './config';
import { RecipePreAPIHookContext } from 'supertokens-auth-react/lib/build/recipe/recipeModule/types';

export const init = (
  config: SuperTokensPluginCaptchaConfig,
): SuperTokensPlugin => {
  setPluginConfig(config);
  return {
    id: PLUGIN_ID,
    init: (config) => {
      validatePublicConfig(config);
    },
    overrideMap: {
      emailpassword: {
        config: (config) => {
          return {
            ...config,
            preAPIHook,
          };
        },
        components: {
          EmailPasswordSignInForm_Override:
            ComponentOverrides.EmailPasswordSignInForm(),
          EmailPasswordSignUpForm_Override:
            ComponentOverrides.EmailPasswordSignUpForm(),
          EmailPasswordResetPasswordEmail_Override:
            ComponentOverrides.EmailPasswordResetPasswordEmail(),
          EmailPasswordSubmitNewPassword_Override:
            ComponentOverrides.EmailPasswordSubmitNewPassword(),
        },
      },
      passwordless: {
        config: (config) => {
          return {
            ...config,
            preAPIHook,
          };
        },
        components: {
          PasswordlessEmailForm_Override:
            ComponentOverrides.PasswordlessEmailForm(),
          PasswordlessPhoneForm_Override:
            ComponentOverrides.PasswordlessPhoneForm(),
          PasswordlessEmailOrPhoneForm_Override:
            ComponentOverrides.PasswordlessEmailOrPhoneForm(),
          PasswordlessEPComboEmailForm_Override:
            ComponentOverrides.PasswordlessEPComboEmailForm(),
          PasswordlessEPComboEmailOrPhoneForm_Override:
            ComponentOverrides.PasswordlessEPComboEmailOrPhoneForm(),
          PasswordlessUserInputCodeForm_Override:
            ComponentOverrides.PasswordlessUserInputCodeForm(),
        },
      },
    },
  };
};

async function preAPIHook(
  context:
    | RecipePreAPIHookContext<EmailPasswordPreAndPostAPIHookAction>
    | RecipePreAPIHookContext<PasswordlessPreAndPostAPIHookAction>,
) {
  const { action } = context;
  const config = getPluginConfig();
  if (
    !isEmailPasswordCaptchaPreAndPostAPIHookAction(action) &&
    !isPasswordlessCaptchaPreAndPostAPIHookAction(action)
  ) {
    return context;
  }

  if (config.shouldValidate && !config.shouldValidate(context)) {
    return context;
  }

  const token = await captcha.getToken();
  if (!token) {
    return context;
  }

  let payload: Record<string, any> & {
    captcha: string;
    captchaType: SuperTokensPluginCaptchaConfig['type'];
  };
  try {
    payload = JSON.parse(context.requestInit.body as string);
  } catch (e) {
    throw new Error('Error setting CAPTCHA token');
  }

  payload.captcha = token;
  payload.captchaType = config.type;
  context.requestInit.body = JSON.stringify(payload);
  return context;
}
