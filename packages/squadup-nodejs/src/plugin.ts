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
      const listTicketsHandler = handleListTickets(pluginConfig);

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
                handler: withRequestHandler(listTicketsHandler),
              },
            ],
          };
        },
      };
    },
    () => ({}),
    (config: SquadUpPluginConfig): SquadUpPluginNormalisedConfig => {
      if (
        !config ||
        (config.apiKey !== undefined) ===
          (config.resolveApiKey !== undefined) ||
        (config.apiKey !== undefined &&
          (typeof config.apiKey !== "string" || !config.apiKey.trim())) ||
        (config.resolveApiKey !== undefined &&
          typeof config.resolveApiKey !== "function")
      ) {
        throw new Error("Configure exactly one of apiKey or resolveApiKey");
      }
      const defaultPageSize = config.defaultPageSize ?? DEFAULT_PAGE_SIZE;
      const maxPageSize = config.maxPageSize ?? 100;
      if (
        !Number.isInteger(maxPageSize) ||
        maxPageSize <= 0 ||
        defaultPageSize > maxPageSize
      ) {
        throw new Error(
          "maxPageSize must be a positive integer >= defaultPageSize",
        );
      }
      let emailCache: SquadUpPluginNormalisedConfig["emailCache"] = false;
      if (config.emailCache !== false) {
        emailCache = {
          ttlMs: config.emailCache?.ttlMs ?? 30_000,
          maxEntries: config.emailCache?.maxEntries ?? 1000,
        };
      }
      if (
        emailCache &&
        (!Number.isFinite(emailCache.ttlMs) ||
          emailCache.ttlMs < 0 ||
          !Number.isInteger(emailCache.maxEntries) ||
          emailCache.maxEntries < 0)
      ) {
        throw new Error(
          "emailCache requires finite non-negative ttlMs and integer maxEntries",
        );
      }

      if (!Number.isInteger(defaultPageSize) || defaultPageSize <= 0) {
        throw new Error("defaultPageSize must be a positive integer");
      }

      const ticketAvailabilityWindowMs =
        config.ticketAvailabilityWindowMs ??
        DEFAULT_TICKET_AVAILABILITY_WINDOW_MS;
      if (
        typeof ticketAvailabilityWindowMs !== "function" &&
        (typeof ticketAvailabilityWindowMs !== "number" ||
          !Number.isFinite(ticketAvailabilityWindowMs) ||
          ticketAvailabilityWindowMs < 0)
      ) {
        throw new Error("ticketAvailabilityWindowMs must be non-negative");
      }

      return {
        ...(config.resolveApiKey !== undefined
          ? { resolveApiKey: config.resolveApiKey }
          : { apiKey: config.apiKey }),
        baseUrl: config.baseUrl ?? DEFAULT_SQUADUP_BASE_URL,
        defaultPageSize,
        maxPageSize,
        emailCache,
        ticketAvailabilityWindowMs,
        enableDebugLogs: config.enableDebugLogs,
      };
    },
  );
