import { beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import { init } from "./plugin";
import {
  getEmailFromSession,
  listTickets,
  mapSquadUpAttendeesToEvents,
  parsePageSize,
} from "./pluginImplementation";
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SQUADUP_BASE_URL,
  DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
  HANDLE_BASE_PATH,
} from "./constants";
import { SquadUpPluginNormalisedConfig } from "./types";

vi.mock("supertokens-node", () => ({
  default: {
    getUser: vi.fn(),
  },
}));

const mockGetUser = vi.mocked(SuperTokens.getUser);

const baseConfig: SquadUpPluginNormalisedConfig = {
  apiKey: "squadup-api-key",
  baseUrl: DEFAULT_SQUADUP_BASE_URL,
  defaultPageSize: DEFAULT_PAGE_SIZE,
  ticketAvailabilityWindowMs: DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
};

describe("squadup-nodejs plugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("throws if apiKey is missing", () => {
    expect(() => init({ apiKey: "" })).toThrow(
      "Missing apiKey in SquadUp plugin config",
    );
  });

  it("throws if defaultPageSize is invalid", () => {
    expect(() => init({ apiKey: "key", defaultPageSize: 0 })).toThrow(
      "defaultPageSize must be a positive integer",
    );
  });

  it("throws if ticketAvailabilityWindowMs is invalid", () => {
    expect(() =>
      init({ apiKey: "key", ticketAvailabilityWindowMs: -1 }),
    ).toThrow("ticketAvailabilityWindowMs must be non-negative");
  });

  it("registers an authenticated tickets route", () => {
    const plugin = init({ apiKey: "key" });
    const routeResult = plugin.routeHandlers!({
      appInfo: {
        apiBasePath: {
          getAsStringDangerous: () => "/auth",
        },
      },
    } as any);

    expect(routeResult.status).toBe("OK");
    expect(routeResult.routeHandlers).toMatchObject([
      {
        path: `/auth${HANDLE_BASE_PATH}/tickets`,
        method: "get",
        verifySessionOptions: { sessionRequired: true },
      },
    ]);
  });

  it("uses passwordless email as the SquadUp lookup email", async () => {
    mockGetUser.mockResolvedValue({
      loginMethods: [
        {
          recipeId: "passwordless",
          email: "pass@example.com",
        },
      ],
    } as any);

    await expect(getEmailFromSession(fakeSession("user-1"))).resolves.toBe(
      "pass@example.com",
    );
  });

  it("uses verified thirdparty email as the SquadUp lookup email", async () => {
    mockGetUser.mockResolvedValue({
      loginMethods: [
        {
          recipeId: "thirdparty",
          email: "thirdparty@example.com",
          verified: true,
        },
      ],
    } as any);

    await expect(getEmailFromSession(fakeSession("user-2"))).resolves.toBe(
      "thirdparty@example.com",
    );
  });

  it("rejects unverified thirdparty email users", async () => {
    mockGetUser.mockResolvedValue({
      loginMethods: [
        {
          recipeId: "thirdparty",
          email: "thirdparty@example.com",
          verified: false,
        },
      ],
    } as any);

    await expect(
      getEmailFromSession(fakeSession("user-4")),
    ).resolves.toBeUndefined();
  });

  it("passes pageSize as page_size to SquadUp", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ attendees: [] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listTickets(baseConfig, "tickets@example.com", 25);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://www.squadup.com/api/v3/attendees/search?access_token=squadup-api-key",
    );
    expect(JSON.parse(opts.body)).toEqual({
      email: "tickets@example.com",
      page_size: 25,
    });
  });

  it("returns ERROR for non-404 SquadUp failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 500 })),
    );

    await expect(
      listTickets(baseConfig, "error@example.com"),
    ).resolves.toMatchObject({
      status: "ERROR",
      message: "Failed to list SquadUp tickets",
    });
  });

  it("hides QR and PDF URLs for future tickets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));

    const events = mapSquadUpAttendeesToEvents(
      [attendeeWithTicket("2026-05-15T15:00:01.000Z")],
      DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
    );

    expect(events[0].tickets[0].pdf_url).toBeNull();
    expect(events[0].tickets[0].qrcode_str).toBeNull();
  });

  it("keeps QR and PDF URLs for available tickets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));

    const events = mapSquadUpAttendeesToEvents(
      [attendeeWithTicket("2026-05-15T13:59:59.000Z")],
      DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
    );

    expect(events[0].tickets[0].pdf_url).toBe(
      "https://tickets.example.com/ticket.pdf",
    );
    expect(events[0].tickets[0].qrcode_str).toBe("qr-code");
  });

  it("rejects invalid pageSize query values", async () => {
    await expect(
      parsePageSize(
        {
          getKeyValueFromQuery: async () => "not-a-number",
        } as any,
        100,
      ),
    ).resolves.toEqual({
      status: "BAD_INPUT_ERROR",
      message: "pageSize must be a positive integer",
    });
  });
});

function fakeSession(userId: string) {
  return {
    getUserId: () => userId,
  } as any;
}

function attendeeWithTicket(startAt: string) {
  return {
    event: {
      id: "event-1",
      name: "Event",
      start_at: startAt,
      end_at: startAt,
      image: {
        thumbnail_url: null,
        default_url: null,
      },
      location: {
        name: "Venue",
        address_line_1: "123 Main St",
      },
      location_type: "venue",
    },
    attendee_guests: [
      {
        ticket: {
          id: "ticket-1",
          type: "General Admission",
          event: {
            start_at: startAt,
          },
          pdf_url: "https://tickets.example.com/ticket.pdf",
          qrcode_str: "qr-code",
        },
      },
    ],
  };
}
