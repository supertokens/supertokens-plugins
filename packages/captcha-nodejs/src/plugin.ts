import { SuperTokensPlugin } from 'supertokens-node/types';
import { PLUGIN_ID, PLUGIN_SDK_VERSION, setPluginConfig } from './config';
import { SuperTokensPluginCaptchaConfig } from './types';
import { validateCaptcha } from './captcha';

export const init = (
  config: SuperTokensPluginCaptchaConfig
): SuperTokensPlugin => {
  setPluginConfig(config);
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
                const validateResult = config.shouldValidate(
                  'signUpPOST',
                  input
                );
                let shouldValidate = validateResult;
                // We can just always await, no need to check if it's a promise
                // is there any reason for this check?
                if (validateResult instanceof Promise) {
                  shouldValidate = await validateResult;
                }
                if (!shouldValidate) {
                  return originalImplementation.signUpPOST!(input);
                }
              }

              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body);
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
                const validateResult = config.shouldValidate(
                  'passwordResetPOST',
                  input
                );
                let shouldValidate = validateResult;
                if (validateResult instanceof Promise) {
                  shouldValidate = await validateResult;
                }
                if (!shouldValidate) {
                  return originalImplementation.passwordResetPOST!(input);
                }
              }
              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body);
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
                const validateResult = config.shouldValidate(
                  'generatePasswordResetTokenPOST',
                  input
                );
                let shouldValidate = validateResult;
                if (validateResult instanceof Promise) {
                  shouldValidate = await validateResult;
                }
                if (!shouldValidate) {
                  return originalImplementation.generatePasswordResetTokenPOST!(
                    input
                  );
                }
              }
              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body);
              } catch (e) {
                return {
                  status: 'GENERAL_ERROR',
                  message: 'CAPTCHA verification failed',
                };
              }
              return originalImplementation.generatePasswordResetTokenPOST!(
                input
              );
            },
            signInPOST: async (input) => {
              if (config.shouldValidate) {
                const validateResult = config.shouldValidate(
                  'signInPOST',
                  input
                );
                let shouldValidate = validateResult;
                if (validateResult instanceof Promise) {
                  shouldValidate = await validateResult;
                }
                if (!shouldValidate) {
                  return originalImplementation.signInPOST!(input);
                }
              }

              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body);
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
                const validateResult = config.shouldValidate(
                  'consumeCodePOST',
                  input
                );
                let shouldValidate = validateResult;
                if (validateResult instanceof Promise) {
                  shouldValidate = await validateResult;
                }
                if (!shouldValidate) {
                  return originalImplementation.consumeCodePOST!(input);
                }
              }

              // Skip captcha validation if magic link was used
              if ('linkCode' in input) {
                return originalImplementation.consumeCodePOST!(input);
              }

              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body);
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
                const validateResult = config.shouldValidate(
                  'createCodePOST',
                  input
                );
                let shouldValidate = validateResult;
                if (validateResult instanceof Promise) {
                  shouldValidate = await validateResult;
                }
                if (!shouldValidate) {
                  return originalImplementation.createCodePOST!(input);
                }
              }

              const body = await input.options.req.getJSONBody();
              try {
                await validateCaptcha(body);
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
