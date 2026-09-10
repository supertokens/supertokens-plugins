import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import { User } from "supertokens-node/lib/build/user";
import type {
  JSONObject,
  PluginRouteHandler,
  UserContext,
} from "supertokens-node/types";
import { init } from "./plugin";
import { logDebugMessage } from "./logger";
import {
  handleListTickets,
  mapSquadUpAttendeesToEvents,
} from "./pluginImplementation";
import type {
  SquadUpPluginConfig,
  SquadUpPluginNormalisedConfig,
  SquadUpTicketAvailabilityWindow,
} from "./types";
import {
  DEFAULT_SQUADUP_BASE_URL,
  DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
} from "./constants";

vi.mock("supertokens-node", () => ({ default: { getUser: vi.fn() } }));
vi.mock("./logger", () => ({
  logDebugMessage: vi.fn(),
  enableDebugLogs: vi.fn(),
}));
const getUser = vi.mocked(SuperTokens.getUser);
const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
const context = { tenantId: "tenant-a", userContext: {} as UserContext };
const baseConfig: SquadUpPluginNormalisedConfig = {
  apiKey: "static-key",
  baseUrl: DEFAULT_SQUADUP_BASE_URL,
  defaultPageSize: 100,
  maxPageSize: 100,
  emailCache: { ttlMs: 30_000, maxEntries: 1000 },
  ticketAvailabilityWindowMs: DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
};
type Request = Parameters<PluginRouteHandler["handler"]>[0];
type ResponseType = Parameters<PluginRouteHandler["handler"]>[1];
type Session = NonNullable<Parameters<PluginRouteHandler["handler"]>[2]>;
function request(pageSize?: string): Request {
  return {
    getKeyValueFromQuery: (key: string) =>
      key === "pageSize" ? pageSize : "attacker-tenant",
  } as Request;
}
function session(tenantId = "tenant-a", userId = "user-1"): Session {
  return { getUserId: () => userId, getTenantId: () => tenantId } as Session;
}
function user(
  email = "user@example.com",
  recipeId: "passwordless" | "thirdparty" | "emailpassword" = "passwordless",
  verified = true,
  tenantIds = ["tenant-a", "tenant-b"],
) {
  return new User({
    id: "user-1",
    timeJoined: 0,
    isPrimaryUser: false,
    emails: [email],
    phoneNumbers: [],
    tenantIds,
    thirdParty: [],
    webauthn: { credentialIds: [] },
    loginMethods: [
      {
        recipeId,
        recipeUserId: "user-1",
        tenantIds,
        email,
        verified,
        timeJoined: 0,
      },
    ],
  });
}
function upstream(body: unknown = { attendees: [] }, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function ticket(start?: string): JSONObject {
  return {
    id: "ticket-1",
    type: "General Admission",
    ...(start === undefined ? {} : { event: { start_at: start } }),
    pdf_url: "https://tickets.example/ticket.pdf",
    qrcode_str: "qr",
  };
}
function attendee(tickets: JSONObject[], start?: string): JSONObject {
  return {
    event: {
      id: "event-1",
      name: "Event",
      ...(start === undefined ? {} : { start_at: start }),
      end_at: "2026-05-15T18:00:00Z",
      image: { thumbnail_url: null, default_url: null },
      location: { name: "Venue", address_line_1: "123 Main" },
      location_type: "venue",
    },
    attendee_guests: tickets.map((ticket) => ({ ticket })),
  };
}
const call = (
  handler: ReturnType<typeof handleListTickets>,
  tenant = "tenant-a",
  id = "user-1",
  pageSize?: string,
) => handler(request(pageSize), {}, session(tenant, id), context.userContext);

beforeEach(() => {
  vi.resetAllMocks();
  getUser.mockResolvedValue(user());
  fetchMock.mockImplementation(async () => upstream());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("configuration", () => {
  it.each([
    {},
    { apiKey: "" },
    { apiKey: "key", resolveApiKey: async () => "key" },
    { resolveApiKey: "key" },
  ])("rejects invalid credentials %o", (config) => {
    expect(() => init(config as SquadUpPluginConfig)).toThrow("exactly one");
  });
  it.each([
    { defaultPageSize: 0 },
    { maxPageSize: 0 },
    { maxPageSize: 99 },
    { ticketAvailabilityWindowMs: Infinity },
    { ticketAvailabilityWindowMs: -1 },
    { ticketAvailabilityWindowMs: NaN },
    { emailCache: { ttlMs: -1 } },
    { emailCache: { maxEntries: 1.5 } },
  ])("rejects invalid policy %o", (config) => {
    expect(() => init({ apiKey: "key", ...config })).toThrow();
  });
  it("accepts static, resolver, disabled cache and callback configurations", () => {
    expect(init({ apiKey: "key", emailCache: false })).toBeDefined();
    expect(
      init({
        resolveApiKey: async () => undefined,
        ticketAvailabilityWindowMs: () => 0,
      }),
    ).toBeDefined();
  });
});

describe("tenant credentials and request errors", () => {
  it("selects and caches distinct linked-user emails by verified session tenant", async () => {
    const tenantA = user("a@example.com", "passwordless", true, ["tenant-a"]);
    const tenantB = user("b@example.com", "thirdparty", true, ["tenant-b"]);
    const linkedUser = new User({
      id: "linked-user",
      timeJoined: 0,
      isPrimaryUser: true,
      emails: ["a@example.com", "b@example.com"],
      phoneNumbers: [],
      tenantIds: ["tenant-a", "tenant-b"],
      thirdParty: [],
      webauthn: { credentialIds: [] },
      loginMethods: [...tenantA.loginMethods, ...tenantB.loginMethods].map(
        (method, index) => ({
          recipeId: method.recipeId,
          recipeUserId: `recipe-user-${index}`,
          tenantIds: method.tenantIds,
          email: method.email,
          verified: method.verified,
          timeJoined: 0,
        }),
      ),
    });
    getUser.mockResolvedValue(linkedUser);
    const handler = handleListTickets(baseConfig);
    await Promise.all([call(handler), call(handler, "tenant-b")]);
    await call(handler, "tenant-b");
    await call(handler);
    expect(
      fetchMock.mock.calls.map(([, options]) =>
        JSON.parse(String(options?.body)),
      ),
    ).toEqual([
      { email: "a@example.com", page_size: 100 },
      { email: "b@example.com", page_size: 100 },
      { email: "b@example.com", page_size: 100 },
      { email: "a@example.com", page_size: 100 },
    ]);
    expect(getUser).toHaveBeenCalledTimes(2);
  });
  it.each(["passwordless", "thirdparty"] as const)(
    "does not use a %s email belonging only to another tenant",
    async (recipe) => {
      getUser.mockResolvedValue(
        user("a@example.com", recipe, true, ["tenant-a"]),
      );
      expect(
        await call(handleListTickets(baseConfig), "tenant-b"),
      ).toMatchObject({ status: "BAD_INPUT_ERROR" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("uses static credentials and maps page_size", async () => {
    await call(handleListTickets(baseConfig), "tenant-a", "user-1", "25");
    const [url, options] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).searchParams.get("access_token")).toBe(
      "static-key",
    );
    expect(JSON.parse(String(options?.body))).toEqual({
      email: "user@example.com",
      page_size: 25,
    });
  });
  it("isolates concurrent tenant resolutions and ignores query tenant", async () => {
    let release!: (value: string) => void;
    const resolveApiKey = vi.fn(async ({ tenantId }: { tenantId: string }) =>
      tenantId === "tenant-a"
        ? new Promise<string>((resolve) => {
            release = resolve;
          })
        : "key-b",
    );
    const config: SquadUpPluginNormalisedConfig = {
      ...baseConfig,
      apiKey: undefined,
      resolveApiKey,
    };
    const handler = handleListTickets(config);
    const first = call(handler);
    await call(handler, "tenant-b");
    release("key-a");
    await first;
    expect(
      fetchMock.mock.calls.map(([url]) =>
        new URL(String(url)).searchParams.get("access_token"),
      ),
    ).toEqual(["key-b", "key-a"]);
    expect(resolveApiKey).toHaveBeenCalledWith(context);
    expect(config.apiKey).toBeUndefined();
  });
  it.each([undefined, new Error("https://secret?access_token=secret"), ""])(
    "stops missing or failed resolution %o",
    async (value) => {
      const handler = handleListTickets({
        ...baseConfig,
        apiKey: undefined,
        resolveApiKey: async () => {
          if (value instanceof Error) throw value;
          return value;
        },
      });
      const result = await call(handler);
      expect(result).toMatchObject({
        status: "ERROR",
        code: value === undefined ? 503 : 500,
      });
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(getUser).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(["101", "0", "-1", "1.5", "no", "", "Infinity"])(
    "rejects pageSize %s before external calls",
    async (size) => {
      const resolver = vi.fn(async () => "key");
      expect(
        await call(
          handleListTickets({
            ...baseConfig,
            apiKey: undefined,
            resolveApiKey: resolver,
          }),
          "tenant-a",
          "user-1",
          size,
        ),
      ).toMatchObject({ status: "BAD_INPUT_ERROR" });
      expect(resolver).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["thirdparty", true, "OK"],
    ["thirdparty", false, "BAD_INPUT_ERROR"],
    ["emailpassword", true, "BAD_INPUT_ERROR"],
  ] as const)("handles %s verified=%s", async (recipe, verified, status) => {
    getUser.mockResolvedValue(user("user@example.com", recipe, verified));
    expect(await call(handleListTickets(baseConfig))).toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(status === "OK" ? 1 : 0);
  });
});

describe("email cache", () => {
  it("uses a changed email after expiry", async () => {
    vi.useFakeTimers();
    const handler = handleListTickets(baseConfig);
    await call(handler);
    getUser.mockResolvedValue(user("changed@example.com"));
    await call(handler);
    vi.advanceTimersByTime(30_000);
    await call(handler);
    expect(
      fetchMock.mock.calls.map(
        ([, options]) => JSON.parse(String(options?.body)).email,
      ),
    ).toEqual(["user@example.com", "user@example.com", "changed@example.com"]);
  });
  it("caches missing users only until expiry", async () => {
    vi.useFakeTimers();
    getUser.mockResolvedValueOnce(undefined);
    const handler = handleListTickets(baseConfig);
    expect(await call(handler)).toMatchObject({ status: "BAD_INPUT_ERROR" });
    expect(await call(handler)).toMatchObject({ status: "BAD_INPUT_ERROR" });
    vi.advanceTimersByTime(30_000);
    expect(await call(handler)).toMatchObject({ status: "OK" });
    expect(getUser).toHaveBeenCalledTimes(2);
  });
  it("does not remove a replacement entry when an evicted lookup fails", async () => {
    let reject!: (reason: Error) => void;
    getUser.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const handler = handleListTickets({
      ...baseConfig,
      emailCache: { ttlMs: 30_000, maxEntries: 1 },
    });
    const pending = call(handler);
    await vi.waitFor(() => expect(getUser).toHaveBeenCalledOnce());
    await call(handler, "tenant-b");
    await call(handler);
    reject(new Error("failed"));
    await pending;
    await call(handler);
    expect(getUser).toHaveBeenCalledTimes(3);
  });
  it("refreshes email and verification at TTL boundary", async () => {
    vi.useFakeTimers();
    const handler = handleListTickets(baseConfig);
    await call(handler);
    getUser.mockResolvedValue(user("changed@example.com", "thirdparty", false));
    vi.advanceTimersByTime(29_999);
    expect(await call(handler)).toMatchObject({ status: "OK" });
    vi.advanceTimersByTime(1);
    expect(await call(handler)).toMatchObject({ status: "BAD_INPUT_ERROR" });
    expect(getUser).toHaveBeenCalledTimes(2);
  });
  it("coalesces misses and does not cache thrown failures", async () => {
    let reject!: (reason: Error) => void;
    getUser.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const handler = handleListTickets(baseConfig);
    const first = call(handler);
    const second = call(handler);
    await vi.waitFor(() => expect(getUser).toHaveBeenCalledOnce());
    reject(new Error("secret"));
    expect(await first).toMatchObject({ code: 500 });
    expect(await second).toMatchObject({ code: 500 });
    expect(await call(handler)).toMatchObject({ status: "OK" });
    expect(getUser).toHaveBeenCalledTimes(2);
  });
  it("coalesces successful misses", async () => {
    const handler = handleListTickets(baseConfig);
    await Promise.all([call(handler), call(handler), call(handler)]);
    expect(getUser).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("evicts least recently used entries at capacity", async () => {
    const handler = handleListTickets({
      ...baseConfig,
      emailCache: { ttlMs: 30_000, maxEntries: 2 },
    });
    await call(handler, "tenant-a", "1");
    await call(handler, "tenant-a", "2");
    await call(handler, "tenant-a", "1");
    await call(handler, "tenant-a", "3");
    await call(handler, "tenant-a", "2");
    expect(getUser).toHaveBeenCalledTimes(4);
  });
  it("isolates tenants, users and instances", async () => {
    const first = handleListTickets(baseConfig);
    await call(first);
    await call(first, "tenant-b");
    await call(first, "tenant-a", "other");
    await call(handleListTickets(baseConfig));
    expect(getUser).toHaveBeenCalledTimes(4);
  });
  it.each([
    false,
    { ttlMs: 0, maxEntries: 1000 },
    { ttlMs: 30_000, maxEntries: 0 },
  ] as const)("supports disabling %o", async (emailCache) => {
    const handler = handleListTickets({ ...baseConfig, emailCache });
    await call(handler);
    await call(handler);
    expect(getUser).toHaveBeenCalledTimes(2);
  });
});

describe("per-ticket visibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  it("retains mixed events/tickets and hides only QR/PDF outside the inclusive window", () => {
    const input = [
      attendee([
        ticket("2026-05-15T14:00:00Z"),
        ticket("2026-05-15T14:00:00.001Z"),
        ticket("2026-05-15T11:00:00Z"),
      ]),
    ];
    const events = mapSquadUpAttendeesToEvents(
      input,
      DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
      context,
    );
    expect(events).toHaveLength(1);
    expect(events[0].tickets.map((t) => t.qrcode_str)).toEqual([
      "qr",
      null,
      "qr",
    ]);
    expect(events[0].tickets.map((t) => t.pdf_url)).toEqual([
      "https://tickets.example/ticket.pdf",
      null,
      "https://tickets.example/ticket.pdf",
    ]);
    expect(events[0].tickets[1]).toMatchObject({
      id: "ticket-1",
      type: "General Admission",
    });
    expect(JSON.stringify(input)).not.toContain('"qrcode_str":null');
  });
  it("prefers ticket start, falls back to event start, hides unknown and invalid starts", () => {
    const events = mapSquadUpAttendeesToEvents(
      [
        attendee(
          [ticket(), ticket("bad"), ticket("2026-05-15T16:00:00Z")],
          "2026-05-15T13:00:00Z",
        ),
        attendee([ticket()]),
        attendee([ticket()], "bad"),
      ],
      DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
      context,
    );
    expect(events.flatMap((e) => e.tickets.map((t) => t.qrcode_str))).toEqual([
      "qr",
      null,
      null,
      null,
      null,
    ]);
  });
  it.each([
    "0",
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2026-04-31T00:00:00+05:30",
    "2026-00-15T00:00:00Z",
    "2026-13-15T00:00:00Z",
    "2026-05-00T00:00:00Z",
    "2026-05-15T24:00:00Z",
    "2026-05-15T12:60:00Z",
    "2026-05-15T12:00:60Z",
    "2026-05-15",
    "2026-05-15T12:00:00",
    "05/15/2026",
    "2026-05-15 12:00:00Z",
    "2026-05-15T12:00:00+24:00",
    "2026-05-15T12:00:00+01:60",
    "2026-05-15T12:00:00-00:00",
    "2026-05-15T12:00:00.Z",
    "2026-05-15T12:00:00Z ",
    "2026-05-15T12:00:00Z\n",
  ])(
    "hides QR/PDF for invalid or ambiguous timestamp %s without ticket fallback",
    async (start) => {
      fetchMock.mockResolvedValue(
        upstream({
          attendees: [
            attendee([ticket(start)], "2026-05-15T12:00:00Z"),
            attendee([ticket()], start),
          ],
        }),
      );
      const result = await call(handleListTickets(baseConfig));
      expect(result.status).toBe("OK");
      if (result.status !== "OK") throw new Error("Expected retained tickets");
      expect(result.events).toHaveLength(2);
      for (const event of result.events) {
        expect(event.tickets).toHaveLength(1);
        expect(event.tickets[0]).toMatchObject({
          qrcode_str: null,
          pdf_url: null,
        });
      }
    },
  );
  it.each([
    "2026-05-15T14:00:00Z",
    "2026-05-15T14:00:00.000000Z",
    "2026-05-15T14:00:00+00:00",
    "2026-05-15T19:30:00+05:30",
    "2026-05-15T10:00:00-04:00",
    "2026-05-15T13:59:59.1Z",
    "2026-05-15T13:59:59.123456789Z",
    "2026-05-15T09:59:59.123456-04:00",
    "2024-02-29T00:00:00Z",
    "2000-02-29T00:00:00Z",
  ])(
    "accepts valid calendar dates, explicit timezones and fractions: %s",
    (start) => {
      const events = mapSquadUpAttendeesToEvents(
        [attendee([ticket(start)])],
        DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
        context,
      );
      expect(events[0].tickets[0]).toMatchObject({
        qrcode_str: "qr",
        pdf_url: "https://tickets.example/ticket.pdf",
      });
    },
  );
  it.each([
    "2026-05-15T14:00:00.000001Z",
    "2026-05-15T19:30:00.000000001+05:30",
  ])(
    "does not truncate fractional seconds across the visibility boundary: %s",
    (start) => {
      const input = [attendee([ticket(start)])];
      expect(
        mapSquadUpAttendeesToEvents(
          input,
          DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
          context,
        )[0].tickets[0],
      ).toMatchObject({ qrcode_str: null, pdf_url: null });
      vi.advanceTimersByTime(1);
      expect(
        mapSquadUpAttendeesToEvents(
          input,
          DEFAULT_TICKET_AVAILABILITY_WINDOW_MS,
          context,
        )[0].tickets[0],
      ).toMatchObject({
        qrcode_str: "qr",
        pdf_url: "https://tickets.example/ticket.pdf",
      });
    },
  );
  it("passes typed event/ticket and tenant context to each callback", () => {
    const policy = vi.fn(
      ({
        ticket: t,
      }: Parameters<Exclude<SquadUpTicketAvailabilityWindow, number>>[0]) =>
        t.id === "later" ? 4 * 60 * 60 * 1000 : 0,
    );
    const events = mapSquadUpAttendeesToEvents(
      [
        attendee([
          ticket("2026-05-15T12:00:00Z"),
          { ...ticket("2026-05-15T16:00:00Z"), id: "later" },
        ]),
      ],
      policy,
      context,
    );
    expect(events[0].tickets.map((t) => t.qrcode_str)).toEqual(["qr", "qr"]);
    expect(policy).toHaveBeenCalledTimes(2);
    expect(policy.mock.calls[0][0]).toMatchObject({
      ...context,
      event: { id: "event-1" },
      ticket: { id: "ticket-1" },
    });
  });
  it.each([NaN, Infinity, -1])(
    "rejects invalid callback result %s",
    async (value) => {
      fetchMock.mockResolvedValue(
        upstream({ attendees: [attendee([ticket()])] }),
      );
      expect(
        await call(
          handleListTickets({
            ...baseConfig,
            ticketAvailabilityWindowMs: () => value,
          }),
        ),
      ).toMatchObject({ code: 500 });
    },
  );
  it("sanitizes thrown callback failures", async () => {
    fetchMock.mockResolvedValue(
      upstream({ attendees: [attendee([ticket()])] }),
    );
    const policy: SquadUpTicketAvailabilityWindow = () => {
      throw new Error("secret");
    };
    const result = await call(
      handleListTickets({ ...baseConfig, ticketAvailabilityWindowMs: policy }),
    );
    expect(result).toMatchObject({ code: 500 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("upstream and HTTP contract", () => {
  it.each(["", "Not Found", JSON.stringify({ error: "No tickets" })])(
    "returns no tickets for a SquadUp 404 with body %j",
    async (body) => {
      fetchMock.mockResolvedValue(new Response(body, { status: 404 }));
      expect(await call(handleListTickets(baseConfig))).toEqual({
        status: "OK",
        events: [],
      });
      expect(logDebugMessage).not.toHaveBeenCalled();
    },
  );
  it.each([401, 429, 500])("rejects JSON upstream HTTP %s", async (status) => {
    fetchMock.mockResolvedValue(upstream({ attendees: [] }, status));
    expect(await call(handleListTickets(baseConfig))).toMatchObject({
      code: 502,
    });
  });
  it.each([
    {},
    { attendees: {} },
    { attendees: [null] },
    { attendees: [{ event: {}, attendee_guests: [] }] },
    { attendees: [attendee([{ ...ticket(), pdf_url: 42 }])] },
    { attendees: [attendee([{ ...ticket(), event: "bad" }])] },
  ])("rejects invalid upstream shape %o", async (body) => {
    fetchMock.mockResolvedValue(upstream(body));
    expect(await call(handleListTickets(baseConfig))).toMatchObject({
      code: 502,
    });
  });
  it("sanitizes transport and invalid JSON failures", async () => {
    fetchMock.mockRejectedValueOnce(
      new Error("https://secret?access_token=token"),
    );
    const result = await call(handleListTickets(baseConfig));
    expect(result).toMatchObject({ code: 502 });
    expect(JSON.stringify(result)).not.toContain("token");
    expect(JSON.stringify(vi.mocked(logDebugMessage).mock.calls)).not.toContain(
      "token",
    );
    fetchMock.mockResolvedValueOnce(new Response("invalid JSON"));
    expect(await call(handleListTickets(baseConfig))).toMatchObject({
      code: 502,
    });
  });
  it.each([200, 400, 401, 500, 502, 503])(
    "sets handler HTTP status %s",
    async (status) => {
      const plugin = init(
        status === 503
          ? { resolveApiKey: async () => undefined }
          : status === 500
            ? {
                resolveApiKey: async () => {
                  throw new Error("secret");
                },
              }
            : { apiKey: "key" },
      );
      if (typeof plugin.routeHandlers !== "function")
        throw new Error("Missing route factory");
      const routes = plugin.routeHandlers(
        {
          appInfo: { apiBasePath: { getAsStringDangerous: () => "/auth" } },
        } as Parameters<typeof plugin.routeHandlers>[0],
        [],
        "23.0.1",
      );
      expect(routes.status).toBe("OK");
      if (routes.status !== "OK") throw new Error("Missing routes");
      const route = routes.routeHandlers[0];
      expect(route).toMatchObject({
        path: "/auth/plugin/squadup/tickets",
        method: "get",
        verifySessionOptions: { sessionRequired: true },
      });
      if (status === 502) fetchMock.mockResolvedValue(upstream({}, 500));
      const res = { setStatusCode: vi.fn(), sendJSONResponse: vi.fn() };
      await route.handler(
        request(status === 400 ? "101" : undefined),
        res as unknown as ResponseType,
        status === 401 ? undefined : session(),
        context.userContext,
      );
      expect(res.setStatusCode).toHaveBeenCalledWith(status);
    },
  );
});
