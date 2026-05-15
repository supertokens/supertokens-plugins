import { createPluginInitFunction } from "@shared/js";
import { buildContext, getQuerier } from "@shared/react";
import {
  SuperTokensPlugin,
  SuperTokensPublicConfig,
  SuperTokensPublicPlugin,
  getTranslationFunction,
} from "supertokens-auth-react";

import { NOT_ALLOWED_TO_SIGNUP_REASON_MESSAGE } from "../../../shared/tenants/src";

import { getApi } from "./api";
import { ErrorMessage } from "./components";
import { PLUGIN_ID, API_PATH } from "./constants";
import { enableDebugLogs, logDebugMessage } from "./logger";
import { getOverrideableTenantFunctionImplementation } from "./pluginImplementation";
import { defaultTranslationsTenantEnrollment } from "./translations";
import {
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantEnrollmentPluginConfig,
  TranslationKeys,
} from "./types";

const { usePluginContext, setContext } = buildContext<{
  plugins: SuperTokensPublicPlugin[];
  sdkVersion: string;
  appConfig: SuperTokensPublicConfig;
  pluginConfig: SuperTokensPluginTenantEnrollmentPluginConfig;
  querier: ReturnType<typeof getQuerier>;
  api: ReturnType<typeof getApi>;
  t: (key: TranslationKeys) => string;
  functions: OverrideableTenantFunctionImplementation;
}>();
export { usePluginContext };

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginTenantEnrollmentPluginConfig,
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantEnrollmentPluginConfig
>(
  (pluginConfig, implementation) => {
    let isInviteOnly = false;
    let generalErrorMessage: string | undefined = undefined;
    return {
      id: PLUGIN_ID,
      init: (config, plugins, sdkVersion) => {
        if (config.enableDebugLogs) {
          enableDebugLogs();
        }

        const querier = getQuerier(new URL(API_PATH, config.appInfo.apiDomain.getAsStringDangerous()).toString());
        const api = getApi(querier);

        // Set up the usePlugin hook
        const apiBasePath = new URL(API_PATH, config.appInfo.apiDomain.getAsStringDangerous()).toString();
        const translations = getTranslationFunction<TranslationKeys>(defaultTranslationsTenantEnrollment);

        setContext({
          plugins,
          sdkVersion,
          appConfig: config,
          pluginConfig,
          querier,
          api,
          t: translations,
          functions: implementation,
        });
      },
      overrideMap: {
        webauthn: {
          functions: (originalImplementation) => ({
            ...originalImplementation,
            getRegisterOptions: async (input) => {
              let response;
              try {
                response = await originalImplementation.getRegisterOptions(input);

                // If the execution completes without getting a general error, clear
                // the errorMessage in case it is there from before.
                generalErrorMessage = undefined;
              } catch (error: any) {
                if (
                  error.isSuperTokensGeneralError === true &&
                  Object.values(NOT_ALLOWED_TO_SIGNUP_REASON_MESSAGE).includes(error.message)
                ) {
                  // This is an error for sign-up being blocked so we will
                  // capture the message and use it later.
                  generalErrorMessage = error.message;
                }
              }
              return response;
            },
          }),
          components: {
            WebauthnPasskeySignUpSomethingWentWrong_Override: ({ DefaultComponent, ...props }) => {
              return (
                <div>
                  {generalErrorMessage !== undefined && <ErrorMessage message={generalErrorMessage} />}
                  {/* @ts-ignore */}
                  <DefaultComponent {...props} />
                </div>
              );
            },
          },
        },
        multitenancy: {
          functions: (originalImplementation) => ({
            ...originalImplementation,
            getLoginMethods: async (input) => {
              const response = await originalImplementation.getLoginMethods(input);

              const isTenantInviteOnly = await response.fetchResponse.json().then((data) => data.isTenantInviteOnly);
              logDebugMessage(`Parsed isTenantInviteOnly to be ${isTenantInviteOnly} from response body`);

              if (isTenantInviteOnly !== undefined && typeof isTenantInviteOnly === "boolean") {
                isInviteOnly = isTenantInviteOnly;
                logDebugMessage("Update isInviteOnly value!");
              }

              return response;
            },
          }),
        },
      },
      generalAuthRecipeComponentOverrides: {
        AuthPageHeader_Override: ({ DefaultComponent, ...props }) => {
          logDebugMessage(`Got isInviteOnly value as ${isInviteOnly}`);
          // If the tenant is invite only, disable the sign in switcher
          // @ts-ignore
          return <DefaultComponent {...props} hideSignInSwitcher={isInviteOnly} />;
        },
      },
    };
  },
  getOverrideableTenantFunctionImplementation,
  (pluginConfig) => pluginConfig,
);
