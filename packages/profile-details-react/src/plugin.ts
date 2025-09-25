import { createPluginInitFunction } from "@shared/js";
import { buildContext, getQuerier } from "@shared/react";
import {
  getTranslationFunction,
  SuperTokensPlugin,
  SuperTokensPublicConfig,
  SuperTokensPublicPlugin,
} from "supertokens-auth-react";

import { AccountSectionWrapper } from "./account-section-wrapper";
import { getApi } from "./api";
import { API_PATH, FIELD_INPUT_COMPONENT_MAP, FIELD_VIEW_COMPONENT_MAP, PLUGIN_ID } from "./constants";
import { DetailsSectionWrapper } from "./details-section-wrapper";
import { enableDebugLogs, logDebugMessage } from "./logger";
import { defaultTranslationsCommonDetails } from "./translations";
import {
  SuperTokensPluginProfileDetailsConfig,
  SuperTokensPluginProfileDetailsImplementation,
  FormInputComponentMap,
  TranslationKeys,
  FormViewComponentMap,
} from "./types";

const { usePluginContext, setContext } = buildContext<{
  plugins: SuperTokensPublicPlugin[];
  sdkVersion: string;
  appConfig: SuperTokensPublicConfig;
  pluginConfig: SuperTokensPluginProfileDetailsConfig;
  fieldInputComponentMap: FormInputComponentMap;
  fieldViewComponentMap: FormViewComponentMap;
  querier: ReturnType<typeof getQuerier>;
  api: ReturnType<typeof getApi>;
  t: (key: TranslationKeys) => string;
}>();
export { usePluginContext };

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginProfileDetailsConfig,
  SuperTokensPluginProfileDetailsImplementation
>(
  (pluginConfig, implementation) => {
    const fieldInputComponentMap = implementation.fieldInputComponentMap(FIELD_INPUT_COMPONENT_MAP);
    const fieldViewComponentMap = implementation.fieldViewComponentMap(FIELD_VIEW_COMPONENT_MAP);

    return {
      id: PLUGIN_ID,
      overrideMap: {},
      // even though this is async, it will not be awaited by the sdk
      init: async (appConfig, plugins, sdkVersion) => {
        if (appConfig.enableDebugLogs) {
          enableDebugLogs();
        }

        const baseProfilePlugin: SuperTokensPlugin | undefined = plugins.find(
          (plugin: any) => plugin.id === "supertokens-plugin-profile-base",
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

        const registerOnLoadHandler = baseProfilePlugin.exports?.registerOnLoadHandler;
        if (!registerOnLoadHandler) {
          logDebugMessage(
            "Base profile plugin does not export registerOnLoadHandler. Not adding common details profile plugin.",
          );
          return;
        }

        const querier = getQuerier(new URL(API_PATH, appConfig.appInfo.apiDomain.getAsStringDangerous()).toString());
        const api = getApi(querier);
        const t = getTranslationFunction<TranslationKeys>(defaultTranslationsCommonDetails);

        setContext({
          plugins,
          sdkVersion,
          appConfig,
          pluginConfig,
          fieldInputComponentMap,
          fieldViewComponentMap,
          querier,
          api,
          t,
        });

        registerOnLoadHandler(async () => {
          await registerSection(async () => ({
            id: "account",
            title: t("PL_CD_SECTION_ACCOUNT_LABEL"),
            component: () => AccountSectionWrapper.call(null),
          }));

          await registerSection(async () => {
            const result = await api.getSections();
            if (result.status !== "OK") {
              throw new Error("Error fetching sections");
            }

            return result.sections.map((section) => ({
              id: section.id,
              title: section.label,
              component: () =>
                DetailsSectionWrapper.call(null, {
                  section,
                }),
            }));
          });
        });
      },
    };
  },
  {
    fieldInputComponentMap: (originalImplementation) => originalImplementation,
    fieldViewComponentMap: (originalImplementation) => originalImplementation,
  },
);
