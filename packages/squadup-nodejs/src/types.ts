import type { JSONValue } from "supertokens-node/types";

export type SquadUpPluginConfig = {
  apiKey: string;
  baseUrl?: string;
  defaultPageSize?: number;
  ticketAvailabilityWindowMs?: number;
  enableDebugLogs?: boolean;
};

export type SquadUpPluginNormalisedConfig = {
  apiKey: string;
  baseUrl: string;
  defaultPageSize: number;
  ticketAvailabilityWindowMs: number;
  enableDebugLogs?: boolean;
};

export type SquadUpTicketData = {
  id: string;
  type: string;
  qrcode_str: string | null;
  pdf_url: string | null;
  [key: string]: JSONValue;
};

export type SquadUpEventData = {
  id: string;
  name: string;
  start_at: string;
  end_at: string;
  image: {
    thumbnail_url: string | null;
    default_url: string | null;
  };
  location: {
    name: string;
    address_line_1: string;
  };
  location_type: string;
  tickets: SquadUpTicketData[];
  [key: string]: JSONValue;
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
