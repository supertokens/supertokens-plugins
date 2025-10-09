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
import { enableDebugLogs, logDebugMessage } from "./logger";
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
      id: "stpl-pp-c",
      refresh: async () => {},
      onFailureRedirection: async () => {
        return pluginConfig.setupPagePath;
      },
    });

    // The progressive profiling completed claim ID to ensure
    // the correct order of the claims
    const MULTIPLE_TENANTS_PRESENT_CLAIM_ID = "stpl-tm-ta";

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
                logDebugMessage(`validators from progressive profiling: ${JSON.stringify(input)}`);
                const allValidators = originalImplementation.getGlobalClaimValidators(input);

                // Check if the tenant management validator is added, in which
                // case we want to add it "after" the progressive profiling one.
                const tmClaimValidators = allValidators.filter(
                  (validator) => validator.id === MULTIPLE_TENANTS_PRESENT_CLAIM_ID,
                );
                const otherClaimValidators = allValidators.filter(
                  (validator) => validator.id !== MULTIPLE_TENANTS_PRESENT_CLAIM_ID,
                );

                return [
                  ...otherClaimValidators,
                  ...(pluginConfig.requireSetup ? [ProgressiveProfilingCompletedClaim.validators.isTrue()] : []),
                  ...tmClaimValidators,
                ];
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
