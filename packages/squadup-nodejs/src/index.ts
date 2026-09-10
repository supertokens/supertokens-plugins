import { init } from "./plugin";
export { init };
export default { init };
export type {
  SquadUpApiKeyResolver,
  SquadUpCredentials,
  SquadUpTenantContext,
  SquadUpTicketAvailabilityWindow,
  SquadUpPluginConfig,
  SquadUpPluginNormalisedConfig,
  SquadUpTicketData,
  SquadUpEventData,
  SquadUpTicketsResponse,
  SquadUpErrorResponse,
} from "./types";
export {
  PLUGIN_ID,
  PLUGIN_VERSION,
  PLUGIN_SDK_VERSION,
  HANDLE_BASE_PATH,
  DEFAULT_SQUADUP_BASE_URL,
  DEFAULT_PAGE_SIZE,
  DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
} from "./constants";
