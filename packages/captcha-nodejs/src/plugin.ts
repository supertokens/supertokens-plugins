import { SuperTokensPlugin } from 'supertokens-node/types';
import { PLUGIN_ID, PLUGIN_SDK_VERSION, validatePluginConfig } from './config';
import { SuperTokensPluginCaptchaConfig } from './types';
import { validateCaptcha } from './captcha';

export const init = (
  config: SuperTokensPluginCaptchaConfig,
): SuperTokensPlugin => {
  validatePluginConfig(config);
  return {
    id: PLUGIN_ID,
    compatibleSDKVersions: [PLUGIN_SDK_VERSION],
    overrideMap: {
      emailpassword: {
        apis: (originalImplementation) => {
          if (!originalImplementation.signInPOST) {
            return originalImplementation;
          }
          return {
            ...originalImplementation,
            signUpPOST: async (input) => {
              if (config.shouldValidate) {
                const shouldValidate = await config.shouldValidate(
                  'signUpPOST',
                  input,
                );
                if (!shouldValidate) {
                  return originalImplementation.signUpPOST!(input);
                }
              }

              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body, config);
              } catch (e) {
                return {
                  status: 'GENERAL_ERROR',
                  message: 'CAPTCHA verification failed',
                };
              }
              return originalImplementation.signUpPOST!(input);
            },
            passwordResetPOST: async (input) => {
              if (config.shouldValidate) {
                const shouldValidate = await config.shouldValidate(
                  'passwordResetPOST',
                  input,
                );
                if (!shouldValidate) {
                  return originalImplementation.passwordResetPOST!(input);
                }
              }
              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body, config);
              } catch (e) {
                return {
                  status: 'GENERAL_ERROR',
                  message: 'CAPTCHA verification failed',
                };
              }
              return originalImplementation.passwordResetPOST!(input);
            },
            generatePasswordResetTokenPOST: async (input) => {
              if (config.shouldValidate) {
                const validateResult = await config.shouldValidate(
                  'generatePasswordResetTokenPOST',
                  input,
                );
                if (!validateResult) {
                  return originalImplementation.generatePasswordResetTokenPOST!(
                    input,
                  );
                }
              }
              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body, config);
              } catch (e) {
                return {
                  status: 'GENERAL_ERROR',
                  message: 'CAPTCHA verification failed',
                };
              }
              return originalImplementation.generatePasswordResetTokenPOST!(
                input,
              );
            },
            signInPOST: async (input) => {
              if (config.shouldValidate) {
                const validateResult = await config.shouldValidate(
                  'signInPOST',
                  input,
                );
                if (!validateResult) {
                  return originalImplementation.signInPOST!(input);
                }
              }

              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body, config);
              } catch (e) {
                return {
                  status: 'GENERAL_ERROR',
                  message: 'CAPTCHA verification failed',
                };
              }
              return originalImplementation.signInPOST!(input);
            },
          };
        },
      },
      passwordless: {
        apis: (originalImplementation) => {
          return {
            ...originalImplementation,
            consumeCodePOST: async (input) => {
              if (config.shouldValidate) {
                const validateResult = await config.shouldValidate(
                  'consumeCodePOST',
                  input,
                );
                if (!validateResult) {
                  return originalImplementation.consumeCodePOST!(input);
                }
              }

              // Skip captcha validation if magic link was used
              if ('linkCode' in input) {
                return originalImplementation.consumeCodePOST!(input);
              }

              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body, config);
              } catch (e) {
                return {
                  status: 'GENERAL_ERROR',
                  message: 'CAPTCHA verification failed',
                };
              }
              return originalImplementation.consumeCodePOST!(input);
            },
            createCodePOST: async (input) => {
              if (config.shouldValidate) {
                const validateResult = await config.shouldValidate(
                  'createCodePOST',
                  input,
                );
                if (!validateResult) {
                  return originalImplementation.createCodePOST!(input);
                }
              }

              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body, config);
              } catch (e) {
                return {
                  status: 'GENERAL_ERROR',
                  message: 'CAPTCHA verification failed',
                };
              }
              return originalImplementation.createCodePOST!(input);
            },
          };
        },
      },
    },
  };
};
