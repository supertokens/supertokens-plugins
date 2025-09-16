import { createPluginInitFunction } from "@shared/js";
import { buildContext } from "@shared/react";
import { SuperTokensPlugin, getTranslationFunction } from "supertokens-auth-react";

import { DEFAULT_PROFILE_PAGE_PATH, PLUGIN_ID } from "./constants";
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

        sections.push({
          ...newSection,
          order: newSection.order ?? sectionOrder++,
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
          t,
        });
      },
      routeHandlers: () => {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: "/user/profile",
              handler: () => UserProfilePage.call(null),
            },
          ],
        };
      },
      exports: {
        getSections,
        registerSection,
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
