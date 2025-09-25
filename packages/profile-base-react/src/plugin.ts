import { createPluginInitFunction } from "@shared/js";
import { buildContext } from "@shared/react";
import { SuperTokensPlugin, getTranslationFunction } from "supertokens-auth-react";

import { DEFAULT_PROFILE_PAGE_PATH, PLUGIN_ID, SECTION_ORDER_INCREMENT } from "./constants";
import { enableDebugLogs, logDebugMessage } from "./logger";
import {
  RegisterSection,
  Section,
  SuperTokensPluginProfileConfig,
  SuperTokensPluginProfileNormalisedConfig,
  SuperTokensPluginProfileSection,
} from "./types";
import { UserProfilePage } from "./user-profile-page";

const { usePluginContext, setContext } = buildContext<{
  pluginConfig: SuperTokensPluginProfileConfig;
  getSections: () => SuperTokensPluginProfileSection[];
  registerSection: RegisterSection;
  getOnLoadHandlers: () => (() => Promise<void>)[];
  t: (key: string, replacements?: Record<string, string>) => string;
}>();
export { usePluginContext };

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginProfileConfig,
  undefined,
  SuperTokensPluginProfileNormalisedConfig
>(
  (pluginConfig) => {
    const sections: SuperTokensPluginProfileSection[] = [...pluginConfig.sections];

    const getSections = () => {
      return sections.sort((a, b) => a.order - b.order);
    };

    const onLoadHandlers: (() => Promise<void>)[] = [];
    const registerOnLoadHandler = (handler: () => Promise<void>) => {
      onLoadHandlers.push(handler);
    };
    const getOnLoadHandlers = () => {
      return onLoadHandlers;
    };

    let sectionOrder = 0;
    const registerSection: RegisterSection = async (sectionBuilder) => {
      let newSections: Section[];

      try {
        const result = await sectionBuilder();
        if (!Array.isArray(result)) {
          newSections = [result];
        } else {
          newSections = result;
        }
      } catch (error) {
        logDebugMessage(`Error while registering section: ${error instanceof Error ? error.message : "Unknown error"}`);
        return;
      }

      for (const newSection of newSections) {
        if (sections.find((s) => s.id === newSection.id)) {
          logDebugMessage(`Profile plugin section with id "${newSection.id}" already registered. Skipping...`);
          continue;
        }

        let order = newSection.order;
        if (!order) {
          sectionOrder += SECTION_ORDER_INCREMENT;
          order = sectionOrder;
        }

        sections.push({
          ...newSection,
          order,
        });
      }
    };

    return {
      id: PLUGIN_ID,
      init: (appConfig) => {
        if (appConfig.enableDebugLogs) {
          enableDebugLogs();
        }

        const t = getTranslationFunction();

        setContext({
          pluginConfig,
          getSections,
          registerSection,
          getOnLoadHandlers,
          t,
        });
      },
      routeHandlers: () => {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: pluginConfig.profilePagePath,
              handler: () => UserProfilePage.call(null),
            },
          ],
        };
      },
      exports: {
        getSections,
        registerSection,
        registerOnLoadHandler,
      },
    };
  },
  undefined,
  (config) => {
    return {
      profilePagePath: config.profilePagePath ?? DEFAULT_PROFILE_PAGE_PATH,
      sections: config.sections ?? [],
    };
  },
);
