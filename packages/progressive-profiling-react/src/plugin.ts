import { createPluginInitFunction } from "@shared/js";
import { buildContext, getQuerier } from "@shared/react";
import { getTranslationFunction, SuperTokensPlugin } from "supertokens-auth-react";
import { BooleanClaim } from "supertokens-auth-react/recipe/session";

import { getApi } from "./api";
import {
  API_PATH,
  DEFAULT_FIELD_TYPE_COMPONENT_MAP,
  DEFAULT_REQUIRE_SETUP,
  DEFAULT_SETUP_PAGE_PATH,
  DEFAULT_SHOW_END_SECTION,
  DEFAULT_SHOW_START_SECTION,
  PLUGIN_ID,
} from "./constants";
import { enableDebugLogs } from "./logger";
import { ProgressiveProfilingSetupPage } from "./progressive-profiling-setup-page";
import { defaultTranslationsProgressiveProfiling } from "./translations";
import {
  SuperTokensPluginProfileProgressiveProfilingConfig,
  SuperTokensPluginProfileProgressiveProfilingNormalisedConfig,
  SuperTokensPluginProfileProgressiveProfilingImplementation,
  FormInputComponentMap,
  TranslationKeys,
} from "./types";

const { usePluginContext, setContext } = buildContext<{
  pluginConfig: SuperTokensPluginProfileProgressiveProfilingConfig;
  componentMap: FormInputComponentMap;
  querier: ReturnType<typeof getQuerier>;
  api: ReturnType<typeof getApi>;
  t: (key: TranslationKeys, replacements?: Record<string, string>) => string;
  ProgressiveProfilingCompletedClaim: BooleanClaim;
}>();
export { usePluginContext };

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginProfileProgressiveProfilingConfig,
  SuperTokensPluginProfileProgressiveProfilingImplementation,
  SuperTokensPluginProfileProgressiveProfilingNormalisedConfig
>(
  (pluginConfig, implementation) => {
    const componentMap = implementation.componentMap();

    const ProgressiveProfilingCompletedClaim = new BooleanClaim({
      id: `${PLUGIN_ID}-completed`,
      refresh: async () => {},
      onFailureRedirection: async () => {
        return pluginConfig.setupPagePath;
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
          ProgressiveProfilingCompletedClaim,
        });
      },
      routeHandlers: () => {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: pluginConfig.setupPagePath,
              handler: () => ProgressiveProfilingSetupPage.call(null),
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
                return pluginConfig.requireSetup
                  ? [
                      ...input.claimValidatorsAddedByOtherRecipes,
                      ProgressiveProfilingCompletedClaim.validators.isTrue(),
                    ]
                  : input.claimValidatorsAddedByOtherRecipes;
              },
            };
          },
        },
      },
    };
  },
  {
    componentMap: () => DEFAULT_FIELD_TYPE_COMPONENT_MAP,
  },
  (config) => ({
    requireSetup: config.requireSetup ?? DEFAULT_REQUIRE_SETUP,
    setupPagePath: config.setupPagePath ?? DEFAULT_SETUP_PAGE_PATH,
    showStartSection: config.showStartSection ?? DEFAULT_SHOW_START_SECTION,
    showEndSection: config.showEndSection ?? DEFAULT_SHOW_END_SECTION,
    onSuccess: config.onSuccess,
  }),
);
