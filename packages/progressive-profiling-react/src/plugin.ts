import { createPluginInitFunction } from "@shared/js";
import { buildContext, getQuerier } from "@shared/react";
import { getTranslationFunction, SuperTokensPlugin } from "supertokens-auth-react";
import { BooleanClaim } from "supertokens-auth-react/recipe/session";

import { getApi } from "./api";
import { API_PATH, FIELD_TYPE_COMPONENT_MAP, PLUGIN_ID } from "./constants";
import { enableDebugLogs } from "./logger";
import { SetupProfilePage } from "./setup-profile-page";
import { defaultTranslationsProgressiveProfiling } from "./translations";
import {
  SuperTokensPluginProfileProgressiveProfilingConfig,
  SuperTokensPluginProfileProgressiveProfilingImplementation,
  FormInputComponentMap,
  TranslationKeys,
} from "./types";

const { usePluginContext, setContext } = buildContext<{
  pluginConfig: SuperTokensPluginProfileProgressiveProfilingConfig;
  componentMap: FormInputComponentMap;
  querier: ReturnType<typeof getQuerier>;
  api: ReturnType<typeof getApi>;
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
}>();
export { usePluginContext };

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginProfileProgressiveProfilingConfig,
  SuperTokensPluginProfileProgressiveProfilingImplementation
>(
  (pluginConfig, implementation) => {
    const componentMap = implementation.componentMap(FIELD_TYPE_COMPONENT_MAP);

    const ProgressiveProfilingCompletedClaim = new BooleanClaim({
      id: `${PLUGIN_ID}-completed`,
      refresh: async () => {},
      onFailureRedirection: async ({ reason }) => {
        return "/user/setup";
      },
    });

    return {
      id: PLUGIN_ID,
      init: (config) => {
        if (config.enableDebugLogs) {
          enableDebugLogs();
        }

        const querier = getQuerier(new URL(API_PATH, config.appInfo.apiDomain.getAsStringDangerous()).toString());
        const api = getApi(querier);
        const t = getTranslationFunction<TranslationKeys>(defaultTranslationsProgressiveProfiling);

        setContext({
          pluginConfig,
          componentMap,
          querier,
          api,
          t,
        });
      },
      routeHandlers: (appConfig: any, plugins: any, sdkVersion: any) => {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: "/user/setup",
              handler: () => SetupProfilePage.call(null),
            },
          ],
        };
      },
      overrideMap: {
        session: {
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,
              getGlobalClaimValidators(input) {
                return [
                  ...input.claimValidatorsAddedByOtherRecipes,
                  ProgressiveProfilingCompletedClaim.validators.isTrue(),
                ];
              },
            };
          },
        },
      },
    };
  },
  {
    componentMap: (originalImplementation) => originalImplementation,
  },
);
