import SuperTokens from "supertokens-node";
import type { PluginRouteHandler } from "supertokens-node/types";
import {
  SquadUpErrorResponse,
  SquadUpEventData,
  SquadUpPluginNormalisedConfig,
  SquadUpTicketData,
  SquadUpTicketsResponse,
} from "./types";
import { logDebugMessage } from "./logger";

type SuperTokensRequest = Parameters<PluginRouteHandler["handler"]>[0];
type SuperTokensSession = Parameters<PluginRouteHandler["handler"]>[2];
type SuperTokensUserContext = Parameters<PluginRouteHandler["handler"]>[3];
type RequiredSuperTokensSession = NonNullable<SuperTokensSession>;

type ListTicketsResult = SquadUpTicketsResponse | SquadUpErrorResponse;

type SquadUpAttendee = {
  event?: Record<string, unknown>;
  attendee_guests?: Array<{
    ticket?: Record<string, unknown> & {
      event?: {
        start_at?: string;
      };
      pdf_url?: string | null;
      qrcode_str?: string | null;
    };
  }>;
};

export function handleListTickets(config: SquadUpPluginNormalisedConfig) {
  return async (
    req: SuperTokensRequest,
    _res: unknown,
    session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ): Promise<ListTicketsResult> => {
    if (!session) {
      return {
        status: "ERROR",
        message: "Session not found",
        code: 401,
      };
    }

    const email = await getEmailFromSession(session, userContext);
    if (!email) {
      return {
        status: "BAD_INPUT_ERROR",
        message: "User does not have a supported verified email",
      };
    }

    const pageSizeResult = await parsePageSize(req, config.defaultPageSize);
    if (typeof pageSizeResult !== "number") {
      return pageSizeResult;
    }

    return listTickets(config, email, pageSizeResult);
  };
}

export async function getEmailFromSession(
  session: RequiredSuperTokensSession,
  userContext?: SuperTokensUserContext,
): Promise<string | undefined> {
  const user = await SuperTokens.getUser(session.getUserId(), userContext);
  const loginMethods = user?.loginMethods ?? [];

  const authMethod = loginMethods.find(
    (method: any) =>
      (method.recipeId === "passwordless" &&
        typeof method.email === "string") ||
      (method.recipeId === "thirdparty" &&
        method.verified === true &&
        typeof method.email === "string"),
  ) as { email?: string } | undefined;

  return authMethod?.email;
}

export async function listTickets(
  config: SquadUpPluginNormalisedConfig,
  email: string,
  pageSize = config.defaultPageSize,
): Promise<ListTicketsResult> {
  try {
    const url = new URL("/api/v3/attendees/search", config.baseUrl);
    url.searchParams.set("access_token", config.apiKey);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email,
        page_size: pageSize,
      }),
    });

    const body = (await response.json()) as { attendees?: SquadUpAttendee[] };

    return {
      status: "OK",
      events: mapSquadUpAttendeesToEvents(
        body.attendees ?? [],
        config.ticketAvailabilityWindowMs,
      ),
    };
  } catch (err) {
    logDebugMessage(
      `Failed to list SquadUp tickets: ${(err as Error).message}`,
    );
    return {
      status: "ERROR",
      message: "Failed to list SquadUp tickets",
      code: 502,
    };
  }
}

export function mapSquadUpAttendeesToEvents(
  attendees: SquadUpAttendee[],
  ticketAvailabilityWindowMs: number,
): SquadUpEventData[] {
  return attendees.map((attendee) => ({
    ...(attendee.event ?? {}),
    tickets: (attendee.attendee_guests ?? []).map((guest) =>
      mapSquadUpTicket(guest, ticketAvailabilityWindowMs),
    ),
  })) as SquadUpEventData[];
}

export function mapSquadUpTicket(
  guest: NonNullable<SquadUpAttendee["attendee_guests"]>[number],
  ticketAvailabilityWindowMs: number,
): SquadUpTicketData {
  const ticket = guest.ticket ?? {};
  const ticketStart = ticket.event?.start_at;
  const isFutureTicket =
    typeof ticketStart === "string" &&
    new Date(ticketStart).getTime() > Date.now() + ticketAvailabilityWindowMs;

  return {
    ...ticket,
    pdf_url: isFutureTicket ? null : (ticket.pdf_url ?? null),
    qrcode_str: isFutureTicket ? null : (ticket.qrcode_str ?? null),
  } as SquadUpTicketData;
}

export async function parsePageSize(
  req: SuperTokensRequest,
  defaultPageSize: number,
): Promise<number | SquadUpErrorResponse> {
  const rawPageSize = req.getKeyValueFromQuery("pageSize");
  if (!rawPageSize) {
    return defaultPageSize;
  }

  const pageSize = Number(rawPageSize);
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    return {
      status: "BAD_INPUT_ERROR",
      message: "pageSize must be a positive integer",
    };
  }

  return pageSize;
}
