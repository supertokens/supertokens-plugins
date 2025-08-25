import { createPluginInitFunction } from "@shared/js";
import { buildContext, getQuerier } from "@shared/react";
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
import { enableDebugLogs } from "./logger";
import { BanUserPage } from "./pages";
import { defaultTranslationsUserBanning } from "./translations";
import {
  SuperTokensPluginUserBanningPluginConfig,
  TranslationKeys,
  SuperTokensPluginUserBanningPluginNormalisedConfig,
} from "./types";

const { usePluginContext, setContext } = buildContext<{
  plugins: SuperTokensPublicPlugin[];
  sdkVersion: string;
  appConfig: SuperTokensPublicConfig;
  pluginConfig: SuperTokensPluginUserBanningPluginNormalisedConfig;
  querier: ReturnType<typeof getQuerier>;
  api: ReturnType<typeof getApi>;
  t: (key: TranslationKeys) => string;
}>();
export { usePluginContext };

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginUserBanningPluginConfig,
  undefined,
  SuperTokensPluginUserBanningPluginNormalisedConfig
>(
  (pluginConfig) => {
    return {
      id: PLUGIN_ID,
      compatibleAuthReactSDKVersions: [">=0.50.0"],
      routeHandlers: [
        {
          path: "/admin/ban-user",
          handler: () => BanUserPage.call(null),
        },
      ],

      init: async (appConfig, plugins, sdkVersion) => {
        if (appConfig.enableDebugLogs) {
          enableDebugLogs();
        }

        const querier = getQuerier(new URL(API_PATH, appConfig.appInfo.apiDomain.getAsStringDangerous()).toString());
        const api = getApi(querier);
        const t = getTranslationFunction<TranslationKeys>(defaultTranslationsUserBanning);

        setContext({
          plugins,
          sdkVersion,
          appConfig,
          pluginConfig,
          querier,
          api,
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
  undefined,
  (pluginConfig) => ({
    userBanningPermission: pluginConfig.userBanningPermission ?? DEFAULT_PERMISSION_NAME,
    bannedUserRole: pluginConfig.bannedUserRole ?? DEFAULT_BANNED_USER_ROLE,
    onPermissionFailureRedirectPath:
      pluginConfig.onPermissionFailureRedirectPath ?? DEFAULT_ON_PERMISSION_FAILURE_REDIRECT_PATH,
  })
);
