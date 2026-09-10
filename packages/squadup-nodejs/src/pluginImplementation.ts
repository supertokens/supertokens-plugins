import SuperTokens from "supertokens-node";
import type {
  JSONObject,
  JSONValue,
  PluginRouteHandler,
} from "supertokens-node/types";
import type {
  SquadUpErrorResponse,
  SquadUpEventData,
  SquadUpPluginNormalisedConfig,
  SquadUpTicketData,
  SquadUpTicketsResponse,
  SquadUpTenantContext,
  SquadUpTicketAvailabilityWindow,
} from "./types";
import { logDebugMessage } from "./logger";
import { createEmailCache } from "./email-cache";

type Request = Parameters<PluginRouteHandler["handler"]>[0];
type Session = NonNullable<Parameters<PluginRouteHandler["handler"]>[2]>;
type ListTicketsResult = SquadUpTicketsResponse | SquadUpErrorResponse;

export function handleListTickets(config: SquadUpPluginNormalisedConfig) {
  const getEmail = createEmailCache(config.emailCache);
  return async (
    req: Request,
    _res: unknown,
    session: Session | undefined,
    userContext: SquadUpTenantContext["userContext"],
  ): Promise<ListTicketsResult> => {
    if (!session)
      return { status: "ERROR", message: "Session not found", code: 401 };
    const pageSize = await parsePageSize(
      req,
      config.defaultPageSize,
      config.maxPageSize,
    );
    if (typeof pageSize !== "number") return pageSize;
    const context = { tenantId: session.getTenantId(), userContext };
    try {
      const apiKey = config.resolveApiKey
        ? await config.resolveApiKey(context)
        : config.apiKey;
      if (apiKey === undefined)
        return {
          status: "ERROR",
          message: "SquadUp integration is not configured for this tenant",
          code: 503,
        };
      if (typeof apiKey !== "string" || !apiKey.trim())
        throw new Error("Invalid credentials");
      const email = await getEmail(context.tenantId, session.getUserId(), () =>
        getEmailFromSession(session, context.userContext),
      );
      if (!email)
        return {
          status: "BAD_INPUT_ERROR",
          message: "User does not have a supported verified email",
        };
      return listTickets(config, email, apiKey, context, pageSize);
    } catch {
      logDebugMessage("Failed to prepare SquadUp ticket request");
      return {
        status: "ERROR",
        message: "Failed to prepare SquadUp ticket request",
        code: 500,
      };
    }
  };
}

export async function getEmailFromSession(
  session: Pick<Session, "getUserId" | "getTenantId">,
  userContext?: SquadUpTenantContext["userContext"],
): Promise<string | undefined> {
  const user = await SuperTokens.getUser(session.getUserId(), userContext);
  const tenantId = session.getTenantId();
  return user?.loginMethods.find(
    (method) =>
      method.tenantIds.includes(tenantId) &&
      (method.recipeId === "passwordless" ||
        (method.recipeId === "thirdparty" && method.verified)) &&
      typeof method.email === "string" &&
      method.email.length > 0,
  )?.email;
}

export async function listTickets(
  config: SquadUpPluginNormalisedConfig,
  email: string,
  apiKey: string,
  context: SquadUpTenantContext,
  pageSize = config.defaultPageSize,
): Promise<ListTicketsResult> {
  let attendees: JSONValue[];
  try {
    const url = new URL("/api/v3/attendees/search", config.baseUrl);
    url.searchParams.set("access_token", apiKey);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, page_size: pageSize }),
    });
    if (response.status === 404) return { status: "OK", events: [] };
    if (!response.ok) throw new Error("Upstream request failed");
    const body: unknown = await response.json();
    if (!isObject(body) || !Array.isArray(body.attendees))
      throw new Error("Invalid attendees");
    attendees = body.attendees;
    validateAttendees(attendees);
  } catch {
    logDebugMessage("Failed to list SquadUp tickets");
    return {
      status: "ERROR",
      message: "Failed to list SquadUp tickets",
      code: 502,
    };
  }
  try {
    return {
      status: "OK",
      events: mapSquadUpAttendeesToEvents(
        attendees,
        config.ticketAvailabilityWindowMs,
        context,
      ),
    };
  } catch {
    logDebugMessage("Failed to apply SquadUp ticket visibility policy");
    return {
      status: "ERROR",
      message: "Failed to apply SquadUp ticket visibility policy",
      code: 500,
    };
  }
}

function isObject(value: unknown): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAttendees(attendees: JSONValue[]): void {
  for (const attendee of attendees) {
    if (
      !isObject(attendee) ||
      !isObject(attendee.event) ||
      !Array.isArray(attendee.attendee_guests)
    )
      throw new Error("Invalid attendee");
    const event = attendee.event;
    if (
      !optionalString(event.start_at) ||
      ![event.id, event.name, event.end_at, event.location_type].every(
        (value) => typeof value === "string",
      ) ||
      !isObject(event.image) ||
      ![event.image.thumbnail_url, event.image.default_url].every(
        nullableString,
      ) ||
      !isObject(event.location) ||
      typeof event.location.name !== "string" ||
      typeof event.location.address_line_1 !== "string"
    )
      throw new Error("Invalid event");
    for (const guest of attendee.attendee_guests) {
      if (!isObject(guest) || !isObject(guest.ticket))
        throw new Error("Invalid ticket");
      const ticket = guest.ticket;
      if (
        typeof ticket.id !== "string" ||
        typeof ticket.type !== "string" ||
        !optionalString(ticket.pdf_url) ||
        !optionalString(ticket.qrcode_str) ||
        (ticket.event !== undefined &&
          ticket.event !== null &&
          (!isObject(ticket.event) || !optionalString(ticket.event.start_at)))
      )
        throw new Error("Invalid ticket fields");
    }
  }
}
function nullableString(value: unknown) {
  return value === null || typeof value === "string";
}
function optionalString(value: unknown) {
  return value === undefined || nullableString(value);
}

function parseEventStart(value: JSONValue | undefined): number {
  if (typeof value !== "string") return NaN;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || match[0] !== value) return NaN;
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction = "",
    zone,
    offsetHour,
    offsetMinute,
  ] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > daysInMonth[m - 1] ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    zone === "-00:00" ||
    (zone !== "Z" && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
  )
    return NaN;
  // Date.parse normalizes impossible dates and truncates sub-millisecond fractions.
  // Validate calendar components first and round up to avoid revealing tickets early.
  return Date.parse(value) + (/[1-9]/.test(fraction.slice(3)) ? 1 : 0);
}

export function mapSquadUpAttendeesToEvents(
  attendees: JSONValue[],
  window: SquadUpTicketAvailabilityWindow,
  context: SquadUpTenantContext,
): SquadUpEventData[] {
  validateAttendees(attendees);
  const now = Date.now();
  return attendees.map((value) => {
    const attendee = value as JSONObject;
    const event = attendee.event as JSONObject;
    const tickets = (attendee.attendee_guests as JSONObject[]).map((guest) => {
      const ticket = guest.ticket as JSONObject;
      const duration =
        typeof window === "function"
          ? window({ ...context, event, ticket })
          : window;
      if (
        typeof duration !== "number" ||
        !Number.isFinite(duration) ||
        duration < 0
      )
        throw new Error("Invalid availability window");
      const start =
        (isObject(ticket.event) ? ticket.event.start_at : undefined) ??
        event.start_at;
      const timestamp = parseEventStart(start);
      const visible = Number.isFinite(timestamp) && timestamp - now <= duration;
      return {
        ...ticket,
        pdf_url: visible ? (ticket.pdf_url ?? null) : null,
        qrcode_str: visible ? (ticket.qrcode_str ?? null) : null,
      } as SquadUpTicketData;
    });
    return { ...event, tickets } as SquadUpEventData;
  });
}

export async function parsePageSize(
  req: Pick<Request, "getKeyValueFromQuery">,
  defaultPageSize: number,
  maxPageSize = 100,
): Promise<number | SquadUpErrorResponse> {
  const raw = req.getKeyValueFromQuery("pageSize");
  if (raw === undefined) return defaultPageSize;
  const size = Number(raw);
  if (!Number.isInteger(size) || size <= 0 || size > maxPageSize)
    return {
      status: "BAD_INPUT_ERROR",
      message: `pageSize must be a positive integer <= ${maxPageSize}`,
    };
  return size;
}
