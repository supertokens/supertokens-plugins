import { SuperTokensPlugin } from "supertokens-node/types";
import { createPluginInitFunction } from "@shared/js";
import {
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantDiscoveryPluginConfig,
  SuperTokensPluginTenantDiscoveryPluginNormalisedConfig,
} from "./types";
import { HANDLE_BASE_PATH, PLUGIN_ID, PLUGIN_SDK_VERSION } from "./constants";
import { withRequestHandler } from "@shared/nodejs";
import { enableDebugLogs, logDebugMessage } from "./logger";

import { getOverrideableTenantFunctionImplementation } from "./pluginImplementation";

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
        logDebugMessage("Tenant Discovery Node plugin initiate complete");
      },
      routeHandlers: () => {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: `${HANDLE_BASE_PATH}/list`,
              method: "get",
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!pluginConfig.enableTenantListAPI) {
                  return {
                    status: "TENANT_SELECTOR_NOT_ENABLED",
                    message: "Tenant Selector is not enabled",
                  };
                }

                const tenants = await implementation.getTenants(userContext);
                return {
                  status: "OK",
                  tenants: tenants,
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
                const tenantIdToReturn = isInferredTenantIdValid ? tenantId : "public";

                // Check if the tenant is allowed for the email.
                if (!implementation.isTenantAllowedForEmail(payload.email, tenantIdToReturn)) {
                  // Return an error indicating the user is not allowed.
                  return {
                    status: "NOT_ALLOWED",
                    message: "No tenant found for the passed email Id",
                  };
                }

                return {
                  status: "OK",
                  tenant: tenantIdToReturn,
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
    enableTenantListAPI: config.enableTenantListAPI ?? false,
  }),
);
