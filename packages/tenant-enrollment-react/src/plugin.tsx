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
import { enableDebugLogs } from "./logger";
import { SignUpBlocked } from "./pages/blocked";
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
      routeHandlers: (appConfig: any, plugins: any, sdkVersion: any) => {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: "/signup-blocked",
              handler: () => SignUpBlocked.call(null),
            },
          ],
        };
      },
      overrideMap: {
        emailpassword: {
          functions: (originalImplementation) => ({
            ...originalImplementation,
            signUp: async (input) => {
              let signUpResponse;
              implementation.withSignUpBlockedRedirect(async () => {
                signUpResponse = await originalImplementation.signUp(input);
              });

              return signUpResponse;
            },
          }),
        },
        webauthn: {
          functions: (originalImplementation) => ({
            ...originalImplementation,
            getRegisterOptions: async (input) => {
              let response;
              implementation.withSignUpBlockedRedirect(async () => {
                response = await originalImplementation.getRegisterOptions(input);
              });
              return response;
            },
          }),
        },
      },
    };
  },
  getOverrideableTenantFunctionImplementation,
  (pluginConfig) => pluginConfig,
);
