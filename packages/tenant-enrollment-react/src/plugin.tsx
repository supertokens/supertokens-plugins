import { createPluginInitFunction } from "@shared/js";
import { buildContext, getQuerier } from "@shared/react";
import {
  SuperTokensPlugin,
  SuperTokensPublicConfig,
  SuperTokensPublicPlugin,
  getTranslationFunction,
} from "supertokens-auth-react";

import { getApi } from "./api";
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
        // emailpassword: {
        //   functions: (originalImplementation) => ({
        //     ...originalImplementation,
        //     signUp: async (input) => {
        //       let signUpResponse;
        //       implementation.withSignUpBlockedRedirect(async () => {
        //         signUpResponse = await originalImplementation.signUp(input);
        //       });

        //       return signUpResponse;
        //     },
        //   }),
        // },
        // webauthn: {
        //   functions: (originalImplementation) => ({
        //     ...originalImplementation,
        //     getRegisterOptions: async (input) => {
        //       let response;
        //       implementation.withSignUpBlockedRedirect(async () => {
        //         response = await originalImplementation.getRegisterOptions(input);
        //       });
        //       return response;
        //     },
        //   }),
        // },
        // passwordless: {
        //   functions: (originalImplementation) => ({
        //     ...originalImplementation,
        //     createCode: async (input) => {
        //       let createCodeResponse;
        //       implementation.withSignUpBlockedRedirect(async () => {
        //         createCodeResponse = await originalImplementation.createCode(input);
        //       });

        //       return createCodeResponse;
        //     },
        //     consumeCode: async (input) => {
        //       let consumeCodeResponse;
        //       implementation.withSignUpBlockedRedirect(async () => {
        //         consumeCodeResponse = await originalImplementation.consumeCode(input);
        //       });

        //       return consumeCodeResponse;
        //     },
        //   }),
        // },
        // thirdparty: {
        //   functions: (originalImplementation) => ({
        //     ...originalImplementation,
        //     signInAndUp: async (input) => {
        //       let signInAndUpResponse;
        //       implementation.withSignUpBlockedRedirect(async () => {
        //         signInAndUpResponse = await originalImplementation.signInAndUp(input);
        //       });
        //       return signInAndUpResponse;
        //     },
        //   }),
        // },
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
