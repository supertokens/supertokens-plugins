import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import { errorHandler, middleware } from "supertokens-node/framework/express";
import { getUserContext } from "supertokens-node/lib/build/utils";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import type { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from "testcontainers";
import { createSessionHandoffLink, init, isSessionHandoff } from "./index";
import { SUPERTOKENS_FAKE_EMAIL_DOMAIN } from "./canonical-email";
import { RowndSessionHandoffError } from "./errors";
import { logDebugMessage } from "./logger";
import { SESSION_HANDOFF_CARRIER_CLAIM } from "./session-handoff-carrier";
import { buildRowndSessionAndAnonymousClaims, getUserById, RowndIsAnonymousClaim } from "./supertokens-repository";
import type { RowndTelemetryEvent } from "./types";

vi.setConfig({ testTimeout: 30_000 });
vi.mock("./logger", async (importOriginal) => {
  const original = await importOriginal<typeof import("./logger")>();
  return { ...original, logDebugMessage: vi.fn(original.logDebugMessage) };
});

const events: RowndTelemetryEvent[] = [];
const route = "/auth/plugin/rownd/session-handoff/consume";
const userRoute = "/auth/plugin/rownd/user";
const headerMode = { "rid": "session", "st-auth-mode": "header", "fdi-version": "1.18" };
const destination = { redirectToPath: "/profile", clientDomain: "browser", appVariantId: "brand" };
let allowedRedirectPaths = ["/profile", "/other"];
let allowAutomaticLinking = false;
let network: StartedNetwork, postgres: StartedTestContainer, core: StartedTestContainer, server: Server;
let baseUrl: string;

beforeAll(async () => {
  expect(process.env.TEST_MODE).toBe("testing");
  network = await new Network().start();
  postgres = await new GenericContainer("postgres:14").withNetwork(network).withNetworkAliases("postgres")
    .withEnvironment({ POSTGRES_USER: "supertokens", POSTGRES_PASSWORD: "somepassword", POSTGRES_DB: "supertokens" })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections")).start();
  core = await new GenericContainer("supertokens/supertokens-postgresql").withNetwork(network)
    .withEnvironment({ POSTGRESQL_CONNECTION_URI: "postgresql://supertokens:somepassword@postgres:5432/supertokens" })
    .withExposedPorts(3567).withWaitStrategy(Wait.forHttp("/hello", 3567)).start();
  const connectionURI = `http://${core.getHost()}:${core.getMappedPort(3567)}`;
  expect((await fetch(`${connectionURI}/ee/license`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ licenseKey: "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V" }),
  })).ok).toBe(true);

  const app = express();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  baseUrl = `http://localhost:${address.port}`;
  SuperTokens.init({
    supertokens: { connectionURI },
    appInfo: { appName: "Session handoff", apiDomain: baseUrl, websiteDomain: "https://app.example.com" },
    recipeList: [
      AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({
        shouldAutomaticallyLink: allowAutomaticLinking, shouldRequireVerification: false,
      }) }),
      Session.init({ cookieSecure: true }), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
      Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }),
      ThirdParty.init({ signInAndUpFeature: { providers: [{
        config: { thirdPartyId: "google", clients: [{ clientId: "test", clientSecret: "test" }] },
        override: (original) => original.type !== "oauth2" ? original : ({
          ...original,
          getUserInfo: async ({ oAuthTokens }: { oAuthTokens: { subject: string; email: string } }) => ({
            thirdPartyUserId: oAuthTokens.subject,
            email: { id: oAuthTokens.email, isVerified: true },
            rawUserInfoFromProvider: { fromUserInfoAPI: oAuthTokens },
          }),
        }),
      }] } }),
    ],
    experimental: { plugins: [init({
      rowndAppKey: "test-key", rowndAppSecret: "test-secret", rowndJwtAudience: "app:test-app",
      clientDomains: { browser: "https://browser.example.com", other: "https://other.example.com", http: "http://insecure.example.com" },
      emailChange: { maxSessionAgeSeconds: null },
      resolveConfig: async () => ({ crossDeviceConfirmationBypass: { allowedRedirectPaths } }),
      telemetry: { provider: "custom", factory: () => ({ recordEvent: (event) => { events.push(event); } }) },
    })] },
  });
  app.use(middleware(), errorHandler());
}, 120_000);

afterEach(() => {
  allowedRedirectPaths = ["/profile", "/other"];
  allowAutomaticLinking = false;
  events.length = 0;
  vi.mocked(logDebugMessage).mockClear();
  vi.restoreAllMocks();
});

afterAll(async () => {
  try { await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()); } finally {
    try { await core?.stop(); } finally { try { await postgres?.stop(); } finally { await network?.stop(); } }
  }
});

async function socialUser(provider = "apple") {
  const id = randomUUID();
  const result = await ThirdParty.manuallyCreateOrUpdateUser("public", provider, id, `${id}@${SUPERTOKENS_FAKE_EMAIL_DOMAIN}`, true);
  if (result.status !== "OK") throw new Error("Fixture creation failed");
  return result;
}

async function verify(accessToken: string) {
  return Session.getSessionWithoutRequestResponse(accessToken, undefined, { checkDatabase: true, antiCsrfCheck: false });
}

async function seed(provider?: string) {
  const { recipeUserId } = await socialUser(provider);
  const session = await Session.createNewSessionWithoutRequestResponse("public", recipeUserId);
  return verify(session.getAccessToken());
}

async function mint(session: SessionContainerInterface) {
  const url = new URL(await createSessionHandoffLink({ session, ...destination, displayContext: "customer_web_view" }));
  const token = url.hash.slice(1);
  return { url, token, handle: token.split(".")[0]! };
}

function post(path: string, body: object, accessToken?: string, rid = "session", fdi = "1.18") {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...headerMode, rid, "fdi-version": fdi, "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(body),
  });
}

function consume(token: string, overrides: Record<string, unknown> = {}, accessToken?: string) {
  return post(route, { token, ...destination, ...overrides }, accessToken);
}

async function expectRejected(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ status: "ERROR", message: "Invalid or expired handoff link" });
  expect(response.headers.get("st-access-token")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
}

function expectNoSessionHeaders(response: Response) {
  for (const header of ["st-access-token", "st-refresh-token", "front-token", "set-cookie"]) {
    expect(response.headers.get(header)).toBeNull();
  }
}

async function expectConfirmation(response: Response) {
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "CONFIRMATION_REQUIRED" });
  expectNoSessionHeaders(response);
}

it("hands off an Apple-only user with no existing browser session or contact", async () => {
  const source = await seed();
  expect(isSessionHandoff(source)).toBe(false);
  const { url, token, handle } = await mint(source);
  expect(url.origin + url.pathname).toBe("https://browser.example.com/account/login");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    rownd_handoff: "1", appKey: "test-key", apiDomain: baseUrl, apiBasePath: "/auth",
    ...destination, displayContext: "customer_web_view",
  });
  expect(url.search).not.toContain(handle);
  const carrier = await Session.getSessionInformation(handle);
  const secret = token.split(".")[1]!;
  expect(carrier?.sessionDataInDatabase).toMatchObject({
    kind: "rownd_session_handoff", version: 1, secretHash: createHash("sha256").update(secret).digest("hex"),
    userId: source.getUserId(), sourceSessionHandle: source.getHandle(),
  });
  expect(JSON.stringify(carrier?.sessionDataInDatabase)).not.toContain(secret);
  expect(carrier?.customClaimsInAccessTokenPayload[SESSION_HANDOFF_CARRIER_CLAIM]).toBe(true);
  expect(carrier?.customClaimsInAccessTokenPayload.auth_level).toBeUndefined();

  const response = await consume(token, { redirectToPath: "https://browser.example.com/profile" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "OK", redirectToPath: "/profile" });
  const web = await verify(response.headers.get("st-access-token")!);
  expect(isSessionHandoff(web)).toBe(true);
  expect(web.getUserId()).toBe(source.getUserId());
  expect(web.getRecipeUserId().getAsString()).toBe(source.getRecipeUserId().getAsString());
  expect(web.getHandle()).not.toBe(source.getHandle());
  expect(web.getAccessTokenPayload()).toMatchObject({
    rownd_session_authentication: "handoff",
    aud: "app_variant:brand",
    auth_level: source.getAccessTokenPayload().auth_level,
    is_verified_user: source.getAccessTokenPayload().is_verified_user,
  });
  expect(await web.getClaimValue(RowndIsAnonymousClaim)).toBe(false);
  expect(await verify(source.getAccessToken())).toBeDefined();
  await expectRejected(await consume(token));
  expect(events.map((event) => event.handoffEvent)).toEqual(["mint", "consume_ok", "reject"]);
});

it("consumes the link without replacing an existing session for the same primary user", async () => {
  const source = await seed();
  const browser = await Session.createNewSessionWithoutRequestResponse("public", source.getRecipeUserId());
  const { token } = await mint(source);
  const response = await consume(token, {}, browser.getAccessToken());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "OK", redirectToPath: "/profile" });
  expectNoSessionHeaders(response);
  expect(isSessionHandoff(await verify(browser.getAccessToken()))).toBe(false);
  expect(await Session.getAllSessionHandlesForUser(source.getUserId())).toEqual(
    expect.arrayContaining([source.getHandle(), browser.getHandle()]),
  );
  expect(await Session.getAllSessionHandlesForUser(source.getUserId())).toHaveLength(2);
  await expectRejected(await consume(token, {}, browser.getAccessToken()));
});

it("leaves a mismatched cookie session and link intact until the browser confirms a switch", async () => {
  const source = await seed();
  const browser = await seed();
  const { token, handle } = await mint(source);
  const submit = (extra: { confirmSwitch?: boolean } = {}) => fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      ...headerMode, "st-auth-mode": "cookie", "content-type": "application/json",
      cookie: `sAccessToken=${browser.getAccessToken()}`,
    },
    body: JSON.stringify({ token, ...destination, ...extra }),
  });
  await expectConfirmation(await submit());
  expect(await Session.getSessionInformation(handle)).toBeDefined();
  expect(await verify(browser.getAccessToken())).toBeDefined();
  expect(events).toContainEqual(expect.objectContaining({ handoffEvent: "confirmation_required", outcome: "success" }));

  const confirmed = await submit({ confirmSwitch: true });
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toEqual({ status: "OK", redirectToPath: "/profile" });
  const accessTokenCookie = confirmed.headers.getSetCookie().find((cookie) => cookie.startsWith("sAccessToken="));
  const accessToken = accessTokenCookie?.split(";")[0]?.slice("sAccessToken=".length);
  expect((await verify(accessToken!)).getUserId()).toBe(source.getUserId());
  expect(await Session.getSessionInformation(browser.getHandle())).toBeUndefined();
  expect(await verify(source.getAccessToken())).toBeDefined();
  await expectRejected(await submit({ confirmSwitch: true }));
});

it("leaves the current browser session valid if a switch is cancelled and the link expires", async () => {
  const browser = await seed();
  const { token, handle } = await mint(await seed());
  const before = await Session.getSessionInformation(handle);
  await expectConfirmation(await consume(token, { confirmSwitch: false }, browser.getAccessToken()));
  const prompted = await Session.getSessionInformation(handle);
  expect(prompted?.sessionDataInDatabase).toEqual(before?.sessionDataInDatabase);

  const now = vi.spyOn(Date, "now").mockReturnValue(before!.sessionDataInDatabase.expiresAt + 1);
  try {
    await expectRejected(await consume(token, { confirmSwitch: true }, browser.getAccessToken()));
  } finally {
    now.mockRestore();
  }
  expect(await verify(browser.getAccessToken())).toBeDefined();
});

it("returns the uniform 401 without probing the browser session for an invalid link or confirmation flag", async () => {
  const browser = await seed();
  const { token } = await mint(await seed());
  const probe = vi.spyOn(Session, "getSession");
  await expectRejected(await consume("invalid", {}, browser.getAccessToken()));
  await expectRejected(await consume(token, { confirmSwitch: "true" }, browser.getAccessToken()));
  expect(probe).not.toHaveBeenCalled();
  expect(await verify(browser.getAccessToken())).toBeDefined();
});

it.each([false, true])("requires a browser session refresh with confirmSwitch=%s if the SDK cannot identify the account", async (confirmSwitch) => {
  const browser = await seed();
  const { token, handle } = await mint(await seed());
  const before = await Session.getSessionInformation(handle);
  vi.spyOn(Session, "getSession").mockImplementationOnce(async (_req, res) => {
    res.setHeader("front-token", "discarded", false);
    throw new Session.Error({ type: Session.Error.TRY_REFRESH_TOKEN, message: "Access token expired" });
  });
  const refresh = await consume(token, { confirmSwitch }, browser.getAccessToken());
  expect(refresh.status).toBe(200);
  expect(await refresh.json()).toEqual({ status: "SESSION_REFRESH_REQUIRED" });
  expectNoSessionHeaders(refresh);
  expect(await Session.getSessionInformation(handle)).toMatchObject({
    sessionHandle: handle, expiry: before?.expiry, sessionDataInDatabase: before?.sessionDataInDatabase,
  });
  expect(await verify(browser.getAccessToken())).toBeDefined();
  await expectConfirmation(await consume(token, {}, browser.getAccessToken()));
  expect((await consume(token, { confirmSwitch: true }, browser.getAccessToken())).status).toBe(200);
});

it("rejects a simple cross-site request without reading or consuming its carrier", async () => {
  const browser = await seed();
  const { token, handle } = await mint(await seed());
  const load = vi.spyOn(Session, "getSessionInformation");
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "text/plain", origin: "https://elsewhere.example.com", cookie: `sAccessToken=${browser.getAccessToken()}` },
    body: JSON.stringify({ token, ...destination, confirmSwitch: true }),
  });
  await expectRejected(response);
  expectNoSessionHeaders(response);
  expect(load).not.toHaveBeenCalled();
  expect(await Session.getSessionInformation(handle)).toBeDefined();
  expect(await verify(browser.getAccessToken())).toBeDefined();

  const json = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { ...headerMode, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ token, ...destination }),
  });
  expect(json.status).toBe(200);
  expect(await json.json()).toMatchObject({ status: "OK" });
});

it.each(["guest", "instant"])("replaces a %s browser session without confirmation", async (provider) => {
  const browser = await seed(provider);
  const source = await seed();
  const { token } = await mint(source);
  const response = await consume(token, {}, browser.getAccessToken());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "OK", redirectToPath: "/profile" });
  expect((await verify(response.headers.get("st-access-token")!)).getUserId()).toBe(source.getUserId());
  expect(await Session.getSessionInformation(browser.getHandle())).toBeUndefined();
});

it("ignores a revoked browser session", async () => {
  const browser = await seed();
  const { token } = await mint(await seed());
  await browser.revokeSession();
  const response = await consume(token, {}, browser.getAccessToken());
  expect(await response.json()).toMatchObject({ status: "OK" });
});

it("publishes cookies when the browser requests cookie mode", async () => {
  const { token } = await mint(await seed());
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { ...headerMode, "st-auth-mode": "cookie", "content-type": "application/json" },
    body: JSON.stringify({ token, ...destination }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("st-access-token")).toBeNull();
  expect(response.headers.get("set-cookie")).toContain("sAccessToken=");
  expect(response.headers.get("set-cookie")).toContain("sRefreshToken=");
});

it("preserves the SDK identity of a user with a Rownd ID mapping", async () => {
  const { user, recipeUserId } = await socialUser();
  const browser = await Session.createNewSessionWithoutRequestResponse("public", recipeUserId);
  const alias = `rownd-${randomUUID()}`;
  expect(await SuperTokens.createUserIdMapping({
    superTokensUserId: user.id, externalUserId: alias, force: true,
  })).toMatchObject({ status: "OK" });
  const source = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(alias));
  const { token } = await mint(await verify(source.getAccessToken()));
  const response = await consume(token, {}, browser.getAccessToken());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "OK", redirectToPath: "/profile" });
  expectNoSessionHeaders(response);
  expect((await verify(browser.getAccessToken())).getHandle()).toBe(browser.getHandle());
});

it("keeps the previous real sign-in time and method when a handoff becomes the latest activity", async () => {
  const source = await seed();
  const profile = (session: SessionContainerInterface) => fetch(`${baseUrl}${userRoute}?include_activity=true`, {
    headers: { ...headerMode, authorization: `Bearer ${session.getAccessToken()}` },
  });
  const before = await (await profile(source)).json();
  const { token } = await mint(source);
  const response = await consume(token);
  const web = await verify(response.headers.get("st-access-token")!);
  expect(await Session.getAllSessionHandlesForUser(source.getUserId())).toEqual(
    expect.arrayContaining([source.getHandle(), web.getHandle()]),
  );
  expect(Date.parse(before.meta.last_sign_in)).toBeLessThan(await web.getTimeCreated());
  expect(await (await profile(web)).json()).toMatchObject({
    meta: {
      last_sign_in: before.meta.last_sign_in,
      last_sign_in_method: before.meta.last_sign_in_method,
      last_active: new Date(await web.getTimeCreated()).toISOString(),
    },
  });
});

it("allows exactly one concurrent consumer", async () => {
  const { token } = await mint(await seed());
  const responses = await Promise.all(Array.from({ length: 8 }, () => consume(token)));
  expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  await Promise.all(responses.filter((response) => response.status !== 200).map(expectRejected));
  expect(events.filter((event) => event.handoffEvent === "consume_ok")).toHaveLength(1);
  expect(events.filter((event) => event.handoffEvent === "replay").length).toBeGreaterThan(0);
});

it.each(["expired", "source revoked", "all revoked", "redirect", "domain", "variant", "malformed target", "config changed", "wrong secret"] as const)(
  "rejects %s with a uniform response and leaves no pending carrier", async (reason) => {
    const source = await seed();
    const { token, handle } = await mint(source);
    const target: Record<string, unknown> = {};
    let submittedToken = token;
    if (reason === "expired") {
      const info = await Session.getSessionInformation(handle);
      await Session.updateSessionDataInDatabase(handle, { ...info?.sessionDataInDatabase, expiresAt: Date.now() - 1 });
    }
    if (reason === "source revoked") {
      await source.revokeSession();
      await expect(mint(source)).rejects.toMatchObject({ reason: "inactive_source" });
    }
    if (reason === "all revoked") await Session.revokeAllSessionsForUser(source.getUserId());
    if (reason === "redirect") target.redirectToPath = "/other";
    if (reason === "domain") target.clientDomain = "other";
    if (reason === "variant") target.appVariantId = "different";
    if (reason === "malformed target") target.clientDomain = 123;
    if (reason === "config changed") allowedRedirectPaths = ["/other"];
    if (reason === "wrong secret") {
      const offset = handle.length + 1;
      submittedToken = token.slice(0, offset) + (token[offset] === "A" ? "B" : "A") + token.slice(offset + 1);
    }
    await expectRejected(await consume(submittedToken, target));
    expect(await Session.getSessionInformation(handle)).toBeUndefined();
  },
);

it("rejects a pending link if the source recipe user is unlinked from the minted owner", async () => {
  const primary = await socialUser();
  const secondary = await socialUser("google");
  expect(await AccountLinking.createPrimaryUser(primary.recipeUserId)).toMatchObject({ status: "OK" });
  expect(await AccountLinking.linkAccounts(secondary.recipeUserId, primary.user.id)).toMatchObject({ status: "OK" });
  const source = await Session.createNewSessionWithoutRequestResponse("public", secondary.recipeUserId);
  expect(source.getUserId()).toBe(primary.user.id);
  const { token, handle } = await mint(source);

  expect(await AccountLinking.unlinkAccount(secondary.recipeUserId)).toMatchObject({ status: "OK", wasLinked: true });
  expect((await SuperTokens.getUser(primary.user.id))?.loginMethods.map((method) => method.recipeUserId.getAsString()))
    .not.toContain(secondary.recipeUserId.getAsString());
  await expectRejected(await consume(token));
  expect(await Session.getSessionInformation(handle)).toBeUndefined();
});

it("logs internal consume failure details without logging the token or secret", async () => {
  const { token, handle } = await mint(await seed());
  const secret = token.split(".")[1]!;
  vi.spyOn(Session, "createNewSession").mockRejectedValueOnce(new TypeError(`unexpected Core response: ${token}, ${secret}`));
  await expectRejected(await consume(token));
  expect(logDebugMessage).toHaveBeenCalledWith("Session handoff consume failed: TypeError: unexpected Core response: [redacted], [redacted]");
  expect(JSON.stringify(vi.mocked(logDebugMessage).mock.calls)).not.toContain(secret);
  expect(await Session.getSessionInformation(handle)).toBeUndefined();
});

it("rejects malformed tokens and never revokes a non-carrier handle", async () => {
  const source = await seed();
  for (const token of ["", "handle.secret", `${source.getHandle()}.${"A".repeat(43)}`, null]) {
    await expectRejected(await post(route, { token, ...destination }));
  }
  expect(await verify(source.getAccessToken())).toBeDefined();
  await expect(createSessionHandoffLink({ session: source, redirectToPath: "/forbidden" })).rejects.toThrow("not allowed");
  allowedRedirectPaths = ["//elsewhere.example.com"];
  await expect(createSessionHandoffLink({
    session: source, redirectToPath: "https://app.example.com//elsewhere.example.com",
  })).rejects.toThrow("schemaless");
  expect(await Session.getAllSessionHandlesForUser(source.getUserId())).toEqual([source.getHandle()]);
});

it.each(["guest", "instant"])("cannot mint from a %s session", async (provider) => {
  await expect(mint(await seed(provider))).rejects.toThrow(RowndSessionHandoffError);
  expect(events).toEqual([expect.objectContaining({
    operation: "session_handoff", handoffEvent: "mint_reject", outcome: "error", reason: "anonymous_source",
  })]);
});

it.each([
  [{ tenantId: "other-tenant" }, "tenant_mismatch", "Session handoff tenant must match the source session"],
  [{ clientDomain: "http" }, "insecure_client_domain", "Session handoff requires an HTTPS client domain"],
] as const)("rejects mint with %j before creating a carrier", async (input, reason, message) => {
  const session = await seed();
  await expect(createSessionHandoffLink({ session, ...destination, ...input })).rejects.toMatchObject({ reason, message });
  expect(events).toEqual([expect.objectContaining({ handoffEvent: "mint_reject", reason })]);
  expect(await Session.getAllSessionHandlesForUser(session.getUserId())).toEqual([session.getHandle()]);
});

it("cannot mint from an instant session after linking to a real login method", async () => {
  const instant = await socialUser("instant");
  expect(await AccountLinking.createPrimaryUser(instant.recipeUserId)).toMatchObject({ status: "OK" });
  const source = await Session.createNewSessionWithoutRequestResponse("public", instant.recipeUserId);
  const apple = await socialUser();
  expect(await AccountLinking.linkAccounts(apple.recipeUserId, source.getUserId())).toMatchObject({ status: "OK" });
  await expect(mint(source)).rejects.toMatchObject({ reason: "anonymous_source" });
});

it("hides carriers from activity, refuses carrier credentials, and prunes replaced and expired carriers", async () => {
  const source = await seed();
  const capture = vi.spyOn(Session, "createNewSessionWithoutRequestResponse");
  const { handle: expired } = await mint(source);
  const issued = await capture.mock.results[0]!.value as SessionContainerInterface;
  await expect(verify(issued.getAccessToken())).rejects.toThrow("Invalid session");
  await expect(Session.refreshSessionWithoutRequestResponse(
    issued.getAllSessionTokensDangerously().refreshToken!, true,
  )).rejects.toThrow("Invalid session");
  const profile = await getUserById(source.getUserId(), "public", undefined, { includeActivity: true });
  expect(profile.meta.last_sign_in).toBe(new Date(await source.getTimeCreated()).toISOString());

  const info = await Session.getSessionInformation(expired);
  await Session.updateSessionDataInDatabase(expired, { ...info?.sessionDataInDatabase, expiresAt: Date.now() - 1 });
  const otherSource = await Session.createNewSessionWithoutRequestResponse("public", source.getRecipeUserId());
  const first = await mint(otherSource);
  expect(await Session.getSessionInformation(expired)).toBeUndefined();
  const second = await mint(otherSource);
  expect(await Session.getSessionInformation(first.handle)).toBeUndefined();
  expect(await Session.getSessionInformation(second.handle)).toBeDefined();
});

it("limits carrier cleanup to four concurrent session detail reads", async () => {
  const source = await seed();
  await Promise.all(Array.from({ length: 8 }, () =>
    Session.createNewSessionWithoutRequestResponse("public", source.getRecipeUserId())));
  const load = Session.getSessionInformation.bind(Session);
  let active = 0;
  let peak = 0;
  vi.spyOn(Session, "getSessionInformation").mockImplementation(async (...args) => {
    peak = Math.max(peak, ++active);
    try { return await load(...args); } finally { active--; }
  });
  await mint(source);
  expect(peak).toBe(4);
});

it("revokes the new session without publishing credentials if source validation fails after creation", async () => {
  const source = await seed();
  const { token } = await mint(source);
  const create = Session.createNewSession.bind(Session);
  let createdHandle: string | undefined;
  vi.spyOn(Session, "createNewSession").mockImplementationOnce(async (...args) => {
    const created = await create(...args);
    createdHandle = created.getHandle();
    await source.revokeSession();
    return created;
  });
  await expectRejected(await consume(token));
  expect(createdHandle).toBeDefined();
  expect(await Session.getSessionInformation(createdHandle!)).toBeUndefined();
});

it("keeps the handoff origin through refresh and claim rebuild, but replaces it after real sign-in", async () => {
  const email = `${randomUUID()}@example.com`;
  const native = await Passwordless.signInUp({ tenantId: "public", email });
  const source = await Session.createNewSessionWithoutRequestResponse("public", native.recipeUserId);
  const { token } = await mint(source);
  const response = await consume(token);
  expect(response.status).toBe(200);
  const web = await Session.refreshSessionWithoutRequestResponse(response.headers.get("st-refresh-token")!, true);
  const claims = await buildRowndSessionAndAnonymousClaims(
    web.getUserId(), web.getAccessTokenPayload(), destination.appVariantId, getUserContext(), web.getRecipeUserId().getAsString(),
  );
  await web.mergeIntoAccessTokenPayload({ ...claims.rowndSessionClaims, ...claims.rowndIsAnonymousClaim });
  expect(isSessionHandoff(web)).toBe(true);
  await expect(mint(web)).rejects.toMatchObject({ reason: "handoff_source" });
  expect(events).toContainEqual(expect.objectContaining({ handoffEvent: "mint_reject", reason: "handoff_source" }));
  for (const [path, body] of [
    [userRoute, { data: { email: "other@example.com" } }],
    [`${userRoute}/field?field=email`, { value: "other@example.com" }],
  ] as const) {
    const update = await fetch(`${baseUrl}${path}`, {
      method: "PUT",
      headers: { ...headerMode, authorization: `Bearer ${web.getAccessToken()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(update.status).toBe(403);
    expect(await update.json()).toMatchObject({ error_code: "EMAIL_CHANGE_REAUTHENTICATION_REQUIRED" });
  }
  const deletion = await fetch(`${baseUrl}${userRoute}`, {
    method: "DELETE", headers: { ...headerMode, authorization: `Bearer ${web.getAccessToken()}` },
  });
  expect(deletion.status).toBe(403);

  const code = await Passwordless.createCode({ tenantId: "public", email });
  if (code.status !== "OK") throw new Error("Could not create sign-in code");
  const signIn = { preAuthSessionId: code.preAuthSessionId, linkCode: code.linkCode };
  const linking = await post("/auth/signinup/code/consume", { ...signIn, shouldTryLinkingWithSessionUser: true },
    web.getAccessToken(), "passwordless", "3.1");
  expect(await linking.json()).toMatchObject({ status: "SIGN_IN_UP_NOT_ALLOWED" });
  const result = await post("/auth/signinup/code/consume", signIn, web.getAccessToken(), "passwordless");
  expect(await result.json()).toMatchObject({ status: "OK" });
  const reauthenticated = await verify(result.headers.get("st-access-token")!);
  expect(reauthenticated.getHandle()).not.toBe(web.getHandle());
  expect(reauthenticated.getUserId()).toBe(web.getUserId());
  expect(isSessionHandoff(reauthenticated)).toBe(false);
  expect(reauthenticated.getAccessTokenPayload().rownd_session_authentication).toBe("authenticated");
});

it("rejects third-party sign-in-up requesting account linking from a handoff session", async () => {
  const source = await seed();
  const { token } = await mint(source);
  const response = await consume(token);
  expect(response.status).toBe(200);
  allowAutomaticLinking = true;
  const result = await post("/auth/signinup", {
    thirdPartyId: "google", oAuthTokens: { subject: randomUUID(), email: `${randomUUID()}@example.com` },
    shouldTryLinkingWithSessionUser: true,
  }, response.headers.get("st-access-token")!, "thirdparty", "3.1");
  expect(await result.json()).toMatchObject({ status: "SIGN_IN_UP_NOT_ALLOWED" });
  expect(result.headers.get("st-access-token")).toBeNull();
  expect((await SuperTokens.getUser(source.getUserId()))?.loginMethods).toHaveLength(1);
});
