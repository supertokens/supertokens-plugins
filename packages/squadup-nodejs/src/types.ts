import type { JSONObject, UserContext } from "supertokens-node/types";

export type SquadUpTenantContext = {
  tenantId: string;
  userContext: UserContext;
};
export type SquadUpApiKeyResolver = (
  context: SquadUpTenantContext,
) => Promise<string | undefined>;
export type SquadUpCredentials =
  | { apiKey: string; resolveApiKey?: never }
  | { apiKey?: never; resolveApiKey: SquadUpApiKeyResolver };
export type SquadUpTicketAvailabilityWindow =
  | number
  | ((
      context: SquadUpTenantContext & {
        event: JSONObject;
        ticket: JSONObject;
      },
    ) => number);

export type SquadUpPluginConfig = SquadUpCredentials & {
  baseUrl?: string;
  defaultPageSize?: number;
  maxPageSize?: number;
  emailCache?: false | { ttlMs?: number; maxEntries?: number };
  ticketAvailabilityWindowMs?: SquadUpTicketAvailabilityWindow;
  enableDebugLogs?: boolean;
};

export type SquadUpPluginNormalisedConfig = SquadUpCredentials & {
  baseUrl: string;
  defaultPageSize: number;
  maxPageSize: number;
  emailCache: false | { ttlMs: number; maxEntries: number };
  ticketAvailabilityWindowMs: SquadUpTicketAvailabilityWindow;
  enableDebugLogs?: boolean;
};

export type SquadUpTicketData = JSONObject;

export type SquadUpEventData = JSONObject & {
  tickets: SquadUpTicketData[];
};

export type SquadUpTicketsResponse = {
  status: "OK";
  events: SquadUpEventData[];
};

export type SquadUpErrorResponse = {
  status: "BAD_INPUT_ERROR" | "ERROR";
  message: string;
  code?: number;
};
