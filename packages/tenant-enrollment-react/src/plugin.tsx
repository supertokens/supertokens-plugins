import { createPluginInitFunction } from "@shared/js";
import { buildContext, getQuerier } from "@shared/react";
import { useState } from "react";
import {
  SuperTokensPlugin,
  SuperTokensPublicConfig,
  SuperTokensPublicPlugin,
  getTranslationFunction,
} from "supertokens-auth-react";

import { getApi } from "./api";
import { PLUGIN_ID, API_PATH } from "./constants";
import { enableDebugLogs } from "./logger";
import { defaultTranslationsTenantEnrollment } from "./translations";
import { SuperTokensPluginTenantEnrollmentPluginConfig, TranslationKeys } from "./types";


const { usePluginContext, setContext } = buildContext<{
  plugins: SuperTokensPublicPlugin[];
  sdkVersion: string;
  appConfig: SuperTokensPublicConfig;
  pluginConfig: SuperTokensPluginTenantEnrollmentPluginConfig;
  querier: ReturnType<typeof getQuerier>;
  api: ReturnType<typeof getApi>;
  t: (key: TranslationKeys) => string;
  functions: null;
}>();
export { usePluginContext };


export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginTenantEnrollmentPluginConfig,
  {},
  // NOTE: Update the following type if we update the type to accept any values
  SuperTokensPluginTenantEnrollmentPluginConfig
>((pluginConfig) => {
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
          functions: null,
        });
    },
    routeHandlers: (appConfig: any, plugins: any, sdkVersion: any) => {
      return {
        status: "OK",
        routeHandlers: [
          // Add route handlers here
          // Example:
          // {
          //   path: '/example-page',
          //   handler: () => ExamplePage.call(null),
          // },
        ],
      };
    },
    overrideMap: {
      // Add recipe overrides here
      // Example:
      // emailpassword: {
      //   functions: (originalImplementation) => ({
      //     ...originalImplementation,
      //     // Override functions here
      //   }),
      // },
    },
    generalAuthRecipeComponentOverrides: {
      // Add component overrides here
      // Example:
      // AuthPageHeader_Override: ({ DefaultComponent, ...props }) => {
      //   return <DefaultComponent {...props} />;
      // },
    },
  };
},
{},
(pluginConfig) => pluginConfig
);
