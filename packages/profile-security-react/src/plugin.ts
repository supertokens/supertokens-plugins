import { createPluginInitFunction } from "@shared/js";
import { buildContext, getQuerier } from "@shared/react";
import { FlashToastKey } from "@shared/ui";
import {
  getTranslationFunction,
  SuperTokensPlugin,
  SuperTokensPublicConfig,
  SuperTokensPublicPlugin,
} from "supertokens-auth-react";
import { MultiFactorAuthPreBuiltUI } from "supertokens-auth-react/recipe/multifactorauth/prebuiltui";

import { getApi } from "./api";
import { thirdPartyIdToProviderMap } from "./components/security-section/third-party-section";
import { API_PATH, PLUGIN_ID } from "./constants";
import { enableDebugLogs, logDebugMessage } from "./logger";
import { SecuritySectionWrapper } from "./security-section-wrapper";
import { defaultTranslationsSecurity } from "./translations";
import { SuperTokensPluginProfileSecurityConfig, TranslationKeys } from "./types";

const { usePluginContext, setContext } = buildContext<{
  plugins: SuperTokensPublicPlugin[];
  sdkVersion: string;
  appConfig: SuperTokensPublicConfig;
  pluginConfig: SuperTokensPluginProfileSecurityConfig;
  querier: ReturnType<typeof getQuerier>;
  api: ReturnType<typeof getApi>;
  t: (key: TranslationKeys, replacements?: Record<string, string>) => string;
}>();

export { usePluginContext };

export const init = createPluginInitFunction<SuperTokensPlugin, SuperTokensPluginProfileSecurityConfig>(
  (pluginConfig) => {
    let t: (key: TranslationKeys, replacements?: Record<string, string>) => string = (key) => key;

    return {
      id: PLUGIN_ID,
      overrideMap: {
        thirdparty: {
          functions: (originalImplementation) => ({
            ...originalImplementation,
            signInAndUp: async (input) => {
              const state = originalImplementation.getStateAndOtherInfoFromStorage(input);

              const result = await originalImplementation.signInAndUp(input);
              if (!state?.shouldTryLinkingWithSessionUser) {
                return result;
              }

              const providerName =
                thirdPartyIdToProviderMap[state?.thirdPartyId as keyof typeof thirdPartyIdToProviderMap].name;

              if (result.status === "OK") {
                window.location.href = `/user/profile#security?${FlashToastKey.Success}=${encodeURIComponent(
                  t("PL_SEC_TP_SUCCESS_LINK_ACCOUNT", {
                    provider: providerName ?? "",
                  }),
                )}`;
              } else {
                window.location.href = `/user/profile#security?${FlashToastKey.Error}=${encodeURIComponent(
                  t("PL_SEC_TP_ERROR_LINK_ACCOUNT", {
                    provider: providerName ?? "",
                  }),
                )}`;
              }

              return result;
            },
          }),
        },
      },
      // even though this is async, it will not be awaited by the sdk
      init: async (appConfig, plugins, sdkVersion) => {
        if (appConfig.enableDebugLogs) {
          enableDebugLogs();
        }

        const baseProfilePlugin: SuperTokensPlugin | undefined = plugins.find(
          (plugin) => plugin.id === "supertokens-plugin-profile-base",
        );
        if (!baseProfilePlugin) {
          logDebugMessage("Base profile plugin not found. Not adding common details profile plugin.");
          return;
        }

        if (!baseProfilePlugin.exports) {
          logDebugMessage("Base profile plugin does not export anything. Not adding common details profile plugin.");
          return;
        }

        const registerSection = baseProfilePlugin.exports?.registerSection;
        if (!registerSection) {
          logDebugMessage(
            "Base profile plugin does not export registerSection. Not adding common details profile plugin.",
          );
          return;
        }

        const querier = getQuerier(new URL(API_PATH, appConfig.appInfo.apiDomain.getAsStringDangerous()).toString());

        const recipeTranslationStores = [MultiFactorAuthPreBuiltUI.languageTranslations];
        t = getTranslationFunction(...recipeTranslationStores, defaultTranslationsSecurity);

        setContext({
          plugins,
          sdkVersion,
          appConfig,
          pluginConfig,
          querier,
          api: getApi(querier),
          t,
        });

        await registerSection(async () => ({
          id: "security",
          title: t("PL_SEC_HEADER_TITLE"),
          order: 999, // last section
          component: () => SecuritySectionWrapper.call(null),
        }));
      },
    };
  },
);
