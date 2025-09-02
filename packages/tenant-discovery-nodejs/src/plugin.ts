import { SuperTokensPlugin } from "supertokens-node/types";
import { createPluginInitFunction } from "@shared/js";
import {
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantDiscoveryPluginConfig,
  SuperTokensPluginTenantDiscoveryPluginNormalisedConfig,
} from "./types";
import { HANDLE_BASE_PATH, PLUGIN_ID, PLUGIN_SDK_VERSION } from "./constants";
import { withRequestHandler } from "@shared/nodejs";
import { enableDebugLogs } from "./logger";

import { getOverrideableTenantFunctionImplementation } from "./recipeImplementation";

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
      },
      routeHandlers: () => {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: `${HANDLE_BASE_PATH}/list`,
              method: "get",
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!pluginConfig.showTenantSelector) {
                  return {
                    status: "TENANT_SELECTOR_NOT_ENABLED",
                    message: "Tenant Selector is not enabled"
                  };
                }

                const tenants = await implementation.getTenants(userContext);
                // Transform tenants to only include JSON-serializable properties
                const serializableTenants = tenants.map(({ tenantId, ...config }) => ({
                  tenantId,
                  ...Object.fromEntries(
                    Object.entries(config).filter(
                      ([, value]) => typeof value !== "function" && value !== undefined && value !== null,
                    ),
                  ),
                }));
                return {
                  status: "OK",
                  tenants: serializableTenants,
                };
              }),
            },
            {
              path: `${HANDLE_BASE_PATH}/from-email`,
              method: "post",
              handler: withRequestHandler(async (req, res, session, userContext) => {
                const payload: { email?: string } | undefined = await req.getJSONBody();
                if (!payload?.email?.trim()) {
                  return {
                    status: "ERROR",
                    message: "Email is required",
                  };
                }

                const tenantId = await implementation.getTenantIdFromEmail(payload.email);

                // Check if the inferred tenantId is valid and otherwise return
                // `public`.
                const isInferredTenantIdValid = await implementation.isValidTenant(tenantId, userContext);

                return {
                  status: "OK",
                  tenant: isInferredTenantIdValid ? tenantId : "public",
                  inferredTenantId: tenantId,
                  email: payload.email,
                };
              }),
            },
          ],
        };
      },
      exports: {},
    };
  },
  () => getOverrideableTenantFunctionImplementation(),
  (config) => ({
    showTenantSelector: config.showTenantSelector ?? false,
  })
);
