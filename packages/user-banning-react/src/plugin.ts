import { createPluginInitFunction } from "@shared/js";
import { getQuerier } from "@shared/react";
import { createContext } from "react";
import { SuperTokensPublicConfig, SuperTokensPublicPlugin, getTranslationFunction } from "supertokens-auth-react";
import { SuperTokensPlugin } from "supertokens-auth-react/lib/build/types";
import { UserRoleClaim } from "supertokens-auth-react/recipe/userroles";

import { getApi } from "./api";
import {
  API_PATH,
  DEFAULT_BANNED_USER_ROLE,
  DEFAULT_ON_PERMISSION_FAILURE_REDIRECT_PATH,
  DEFAULT_PERMISSION_NAME,
  PLUGIN_ID,
} from "./constants";
import { BanUserPage } from "./pages";
import { defaultTranslationsUserBanning } from "./translations";
import {
  SuperTokensPluginUserBanningPluginConfig,
  TranslationKeys,
  SuperTokensPluginUserBanningImplementation,
  SuperTokensPluginUserBanningPluginNormalisedConfig,
} from "./types";

export let PluginContext: React.Context<{
  plugins: SuperTokensPublicPlugin[];
  sdkVersion: string;
  appConfig: SuperTokensPublicConfig;
  pluginConfig: SuperTokensPluginUserBanningPluginNormalisedConfig;
  log: (...args: any[]) => void;
  querier: ReturnType<typeof getQuerier>;
  api: ReturnType<typeof getApi>;
  t: (key: TranslationKeys) => string;
}>;

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginUserBanningPluginConfig,
  SuperTokensPluginUserBanningImplementation,
  SuperTokensPluginUserBanningPluginNormalisedConfig
>(
  (pluginConfig, implementation) => {
    const log = implementation.logger((...args) => console.log(`[${PLUGIN_ID}]`, ...args));

    return {
      id: PLUGIN_ID,
      routeHandlers: [
        {
          path: "/admin/ban-user",
          handler: () => BanUserPage.call(null),
        },
      ],

      init: async (appConfig, plugins, sdkVersion) => {
        const querier = getQuerier(new URL(API_PATH, appConfig.appInfo.apiDomain.getAsStringDangerous()).toString());
        const api = getApi(querier);
        const t = getTranslationFunction<TranslationKeys>(defaultTranslationsUserBanning);

        PluginContext = createContext({
          plugins,
          sdkVersion,
          appConfig,
          pluginConfig,
          querier,
          api,
          log,
          t,
        });
      },
      overrideMap: {
        session: {
          recipeInitRequired: true,
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,
              getGlobalClaimValidators: (input) => [
                ...originalImplementation.getGlobalClaimValidators(input),
                UserRoleClaim.validators.excludes(pluginConfig.bannedUserRole),
              ],
            };
          },
        },
      },
    };
  },
  {
    logger: (originalImplementation) => originalImplementation,
  },
  (pluginConfig) => ({
    userBanningPermission: pluginConfig.userBanningPermission ?? DEFAULT_PERMISSION_NAME,
    bannedUserRole: pluginConfig.bannedUserRole ?? DEFAULT_BANNED_USER_ROLE,
    onPermissionFailureRedirectPath:
      pluginConfig.onPermissionFailureRedirectPath ?? DEFAULT_ON_PERMISSION_FAILURE_REDIRECT_PATH,
  })
);
