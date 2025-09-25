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
import { enableDebugLogs, logDebugMessage } from "./logger";
import { AwaitingApproval } from "./pages/awaiting-approval";
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
>(
  (pluginConfig) => {
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
            {
              path: "/awaiting-approval",
              handler: () => AwaitingApproval.call(null),
            },
          ],
        };
      },
      overrideMap: {
        emailpassword: {
          functions: (originalImplementation) => ({
            ...originalImplementation,
            signUp: async (input) => {
              const signUpResponse = await originalImplementation.signUp(input);
              logDebugMessage(`response: ${signUpResponse}`);
              if ((signUpResponse.status as any) !== "PENDING_APPROVAL") {
                return signUpResponse;
              }

              // If it was okay, check if they were added to tenant or not.
              const { wasAddedToTenant, reason } = signUpResponse as any;
              if (wasAddedToTenant === true) {
                // We don't have to do anything
                return signUpResponse;
              }

              // Since the tenant was not added, if we got a reason, we will have
              // to parse it.
              if (reason === undefined) {
                return signUpResponse;
              }

              // Since reason is defined, parse it and handle accordingly.
              if (reason === "REQUIRES_APPROVAL") {
                if (typeof window !== "undefined") {
                  window.location.assign("/awaiting-approval");
                }
              }

              // NOTE: Currently we don't have any possibility of reason being any other
              // value. If that changes, we can update in the future.
              return signUpResponse;
            },
          }),
        },
      },
    };
  },
  {},
  (pluginConfig) => pluginConfig,
);
