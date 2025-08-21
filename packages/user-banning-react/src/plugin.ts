import { createContext } from 'react';
import { SuperTokensPlugin } from 'supertokens-auth-react/lib/build/types';
import {
  API_PATH,
  DEFAULT_ON_PERMISSION_FAILURE_REDIRECT_PATH,
  DEFAULT_PERMISSION_NAME,
  PLUGIN_ID,
} from './constants';
import { BanUserPage } from './pages';
import { createPluginInitFunction } from '@shared/js';
import {
  SuperTokensPublicConfig,
  SuperTokensPublicPlugin,
  getTranslationFunction,
} from 'supertokens-auth-react';
import {
  SuperTokensPluginUserBanningPluginConfig,
  TranslationKeys,
  SuperTokensPluginUserBanningImplementation,
} from './types';
import { getQuerier } from './querier';
import { getApi } from './api';
import { defaultTranslationsUserBanning } from './translations';

// todo: feedback: need some util for calling the custom plugin api
export let PluginContext: React.Context<{
  plugins: SuperTokensPublicPlugin[];
  sdkVersion: string;
  appConfig: SuperTokensPublicConfig;
  pluginConfig: SuperTokensPluginUserBanningPluginConfig;
  log: (...args: any[]) => void;
  querier: ReturnType<typeof getQuerier>;
  api: ReturnType<typeof getApi>;
  t: (key: TranslationKeys) => string;
}>;

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginUserBanningPluginConfig,
  SuperTokensPluginUserBanningImplementation
>(
  (
    pluginConfig = {
      permissionName: DEFAULT_PERMISSION_NAME,
      onPermissionFailureRedirectPath: DEFAULT_ON_PERMISSION_FAILURE_REDIRECT_PATH,
    },
    implementation
  ) => {
    const log = implementation.logger((...args) =>
      console.log(`[${PLUGIN_ID}]`, ...args)
    );

    return {
      id: PLUGIN_ID,
      routeHandlers: [
        {
          path: '/admin/ban-user',
          handler: () => BanUserPage.call(null),
        },
      ],
      init: async (appConfig, plugins, sdkVersion) => {
        const querier = getQuerier(
          new URL(
            API_PATH,
            appConfig.appInfo.apiDomain.getAsStringDangerous()
          ).toString()
        );
        const api = getApi(querier);
        const t = getTranslationFunction<TranslationKeys>(
          defaultTranslationsUserBanning
        );

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
        },
      },
    };
  },
  {
    logger: (originalImplementation) => originalImplementation,
  }
);
