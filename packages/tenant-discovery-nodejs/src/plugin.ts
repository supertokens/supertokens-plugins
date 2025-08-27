import { SuperTokensPlugin } from 'supertokens-node/types';
import { createPluginInitFunction } from '@shared/js';
import {
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantDiscoveryPluginConfig,
  SuperTokensPluginTenantDiscoveryPluginNormalisedConfig,
} from './types';
import { HANDLE_BASE_PATH, PLUGIN_ID, PLUGIN_SDK_VERSION } from './constants';
import { POPULAR_EMAIL_DOMAINS } from './constants';
import { withRequestHandler } from '@shared/nodejs';
import { enableDebugLogs, logDebugMessage } from './logger';

import { getOverrideableTenantFunctionImplementation } from './recipeImplementation';

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginTenantDiscoveryPluginConfig,
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantDiscoveryPluginNormalisedConfig
>(
  (pluginConfig, implementation): SuperTokensPlugin => {
    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: PLUGIN_SDK_VERSION,
      init: async (appConfig) => {
        if (appConfig.debug) {
          enableDebugLogs();
        }

        // Ensure that the domain is not a generic one
        // Go through each domain and check if it is a popular one
        const restrictedDomains = [...(pluginConfig.restrictedEmailDomains ?? []), ...POPULAR_EMAIL_DOMAINS];

        logDebugMessage(`Restricted domains: ${restrictedDomains}`);
        logDebugMessage(`Checking if email domain to tenant ID map contains any of them`);
        for (const domain of Object.keys(pluginConfig.emailDomainToTenantIdMap)) {
          if (restrictedDomains.includes(domain)) {
            throw new Error(`Email domain "${domain}" is not allowed`);
          }
        }
      },
      routeHandlers: () => {
        return {
          status: 'OK',
          routeHandlers: [
            {
              path: `${HANDLE_BASE_PATH}/list`,
              method: 'get',
              handler: withRequestHandler(async (req, res, session, useContext) => {
                const tenants = await implementation.getTenants();
                return {
                  status: 'OK',
                  tenants,
                };
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/from-email`,
              method: 'post',
              handler: withRequestHandler(async (req, res, session, userContext) => {
                const payload: { email?: string } | undefined = await req.getJSONBody();
                if (!payload?.email?.trim()) {
                  return {
                    status: 'ERROR',
                    message: 'Email is required',
                  };
                }

                const tenantId = await implementation.getTenantIdFromEmail(payload.email);
                return {
                  status: 'OK',
                  tenant: tenantId,
                  email: payload.email,
                };
              }),
            },
          ],
        };
      },
      overrideMap: {
        emailpassword: {
          apis: (originalImplementation) => {
            return {
              ...originalImplementation,
            };
          },
        },
      },
      exports: {},
    };
  },
  (config) => getOverrideableTenantFunctionImplementation(config),
);
