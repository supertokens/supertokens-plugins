import { SuperTokensPlugin } from "supertokens-node/types";
import { createPluginInitFunction } from "@shared/js";
import { withRequestHandler } from "@shared/nodejs";
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SQUADUP_BASE_URL,
  DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
  HANDLE_BASE_PATH,
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
} from "./constants";
import { SquadUpPluginConfig, SquadUpPluginNormalisedConfig } from "./types";
import { enableDebugLogs, logDebugMessage } from "./logger";
import { handleListTickets } from "./pluginImplementation";

export const init: (config: SquadUpPluginConfig) => SuperTokensPlugin =
  createPluginInitFunction<
    SuperTokensPlugin,
    SquadUpPluginConfig,
    {},
    SquadUpPluginNormalisedConfig
  >(
    (pluginConfig) => {
      if (pluginConfig.enableDebugLogs) {
        enableDebugLogs();
      }

      logDebugMessage("SquadUp plugin init complete");

      return {
        id: PLUGIN_ID,
        compatibleSDKVersions: PLUGIN_SDK_VERSION,
        routeHandlers(stConfig) {
          const apiBasePath =
            stConfig.appInfo.apiBasePath.getAsStringDangerous();

          return {
            status: "OK" as const,
            routeHandlers: [
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/tickets`,
                method: "get" as const,
                verifySessionOptions: { sessionRequired: true },
                handler: withRequestHandler(handleListTickets(pluginConfig)),
              },
            ],
          };
        },
      };
    },
    () => ({}),
    (config: SquadUpPluginConfig): SquadUpPluginNormalisedConfig => {
      if (!config?.apiKey) {
        throw new Error("Missing apiKey in SquadUp plugin config");
      }

      const defaultPageSize = config.defaultPageSize ?? DEFAULT_PAGE_SIZE;
      if (!Number.isInteger(defaultPageSize) || defaultPageSize <= 0) {
        throw new Error("defaultPageSize must be a positive integer");
      }

      const ticketAvailabilityWindowMs =
        config.ticketAvailabilityWindowMs ??
        DEFAULT_TICKET_AVAILABILITY_WINDOW_MS;
      if (
        typeof ticketAvailabilityWindowMs !== "number" ||
        ticketAvailabilityWindowMs < 0
      ) {
        throw new Error("ticketAvailabilityWindowMs must be non-negative");
      }

      return {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl ?? DEFAULT_SQUADUP_BASE_URL,
        defaultPageSize,
        ticketAvailabilityWindowMs,
        enableDebugLogs: config.enableDebugLogs,
      };
    },
  );
