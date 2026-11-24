import express from "express";
import { createServer, type Server } from "node:http";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import Passwordless from "supertokens-node/recipe/passwordless";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import EmailVerification from "supertokens-node/recipe/emailverification";
import { middleware, errorHandler } from "supertokens-node/framework/express";
import { ProcessState } from "supertokens-node/lib/build/processState";
import { Querier } from "supertokens-node/lib/build/querier";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import PasswordlessRaw from "supertokens-node/lib/build/recipe/passwordless/recipe";
import ThirdPartyRaw from "supertokens-node/lib/build/recipe/thirdparty/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import EmailVerificationRaw from "supertokens-node/lib/build/recipe/emailverification/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import { init } from "./plugin";
import { updateUserMetadata } from "./supertokens-repository";
import { buildConfiguredSessionClaims, getAuthoritativeProfileFields, getCanonicalPresentationMetadata,
  ROWND_APP_VARIANTS_KEY, ROWND_PROFILE_AUTHORITY_PREFIX, type RowndCompatUserResponse, type RowndMetadata } from "./rownd-compatibility";
import { getPluginConfig, setPluginConfig } from "./config";
import { logDebugMessage } from "./logger";
import { createHash } from "node:crypto";
import type { JsonRecord } from "./utils";

vi.mock("./logger", () => ({ logDebugMessage: vi.fn(), enableDebugLogs: vi.fn() }));

type Json = Record<string, unknown>;
type Attempt = { method: string; path: string; params: URLSearchParams; body: Json };
type ProfileResponse = RowndCompatUserResponse & { status: "OK" };
type MetadataResponse = { status: "OK"; id: string; meta: JsonRecord };

async function profileJson(response: Response): Promise<ProfileResponse> {
  return await response.json() as ProfileResponse;
}

async function metadataJson(response: Response): Promise<MetadataResponse> {
  return await response.json() as MetadataResponse;
}

function resetSDK() {
  ProcessState.getInstance().reset();
  SessionRaw.reset();
  PasswordlessRaw.reset();
  ThirdPartyRaw.reset();
  UserMetadataRaw.reset();
  UserRolesRaw.reset();
  AccountLinkingRaw.reset();
  EmailVerificationRaw.reset();
  MultitenancyRaw.reset();
  SuperTokensRaw.reset();
  Querier.reset();
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server | undefined) {
  if (!server) return;
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// CDI 5.4 fixture for the installed SDK, not a Core/database integration test or
// supported-SDK matrix. Only HTTP is faked; handlers, verification and caches run normally.
describe("complete protected route Core budgets (installed SDK)", () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwk: Awaited<ReturnType<typeof exportJWK>>;
  let coreServer: Server | undefined;
  let appServer: Server | undefined;
  let coreUrl: string;
  let appUrl: string;
  let mapped: boolean;
  let revoked: boolean;
  let attempts: Attempt[];
  let unexpected: string[];
  let metadata: Map<string, RowndMetadata>;
  let metadataFailure: boolean;
  let metadataWriteFailureId: string | undefined;
  let beforeMetadataWrite: (() => Promise<void>) | undefined;
  let extraWritableIds: string[];
  let sessionSelector: string | undefined;
  let signInRecipe: "passwordless" | "thirdparty" | undefined;
  const internalId = "core-owner";
  const externalId = "rownd-owner";
  const email = "owner@example.com";
  const device = { email, preAuthSessionId: "budget-device", failedCodeInputAttemptCount: 0 };
  const provider = { id: "rownd-offline", userId: "budget-provider-user" };
  const loginCode = "budget-link-code";
  const sdkId = () => mapped ? externalId : internalId;
  const storedActivity = {
    last_sign_in: "2000-01-01T00:00:00.000Z",
    last_active: "2000-01-02T00:00:00.000Z",
    last_sign_in_method: "stored-method",
  };

  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
    jwk = { ...await exportJWK(keys.publicKey), kid: "d-budget-test", alg: "RS256", use: "sig" };
  });

  function initSDK(disableCoreCallCache = false, metadataMode?: "compatibility" | "dual-write" | "canonical") {
    resetSDK();
    SuperTokens.init({
      telemetry: false,
      supertokens: {
        connectionURI: coreUrl,
        disableCoreCallCache,
        networkInterceptor: (request) => {
          if (new URL(request.url).origin !== coreUrl) {
            unexpected.push(`External SDK traffic: ${request.url}`);
            throw new Error(`External SDK traffic: ${request.url}`);
          }
          return request;
        },
      },
      appInfo: { appName: "Core call budgets", apiDomain: appUrl, websiteDomain: "http://localhost:3000" },
      recipeList: [Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }),
        ...(signInRecipe === "thirdparty" ? [ThirdParty.init({ signInAndUpFeature: { providers: [{
          config: {
            thirdPartyId: provider.id, clients: [{ clientId: "disposable-only" }],
            authorizationEndpoint: "https://provider.invalid/authorize", tokenEndpoint: "https://provider.invalid/token",
            userInfoEndpoint: "https://provider.invalid/userinfo",
          },
          override: (original) => original.type === "oauth2" ? {
            ...original,
            getUserInfo: async () => ({ thirdPartyUserId: provider.userId,
              email: { id: email, isVerified: true }, rawUserInfoFromProvider: {} }),
          } : original,
        }] } })] : [])],
      experimental: { plugins: [init({
        disableRowndUserMigration: true, metadataMode,
        subBrands: { existing: { variant: { id: "existing" } }, added: { variant: { id: "added" } } },
      })] },
    });
  }

  beforeEach(async () => {
    resetSDK();
    mapped = false;
    revoked = false;
    metadataFailure = false;
    metadataWriteFailureId = undefined;
    beforeMetadataWrite = undefined;
    extraWritableIds = [];
    sessionSelector = undefined;
    signInRecipe = undefined;
    attempts = [];
    unexpected = [];
    metadata = new Map([
      [internalId, { first_name: "Profile", preference: "preserved", ...storedActivity }],
      [externalId, { first_name: "Alias", alias_only: "fallback" }],
    ]);
    coreServer = createServer(async (req, res) => {
      const url = new URL(req.url!, coreUrl);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Json : {};
      const attempt = { method: req.method!, path: url.pathname, params: url.searchParams, body };
      attempts.push(attempt);
      res.setHeader("content-type", "application/json");
      const reply = (value: unknown) => res.end(JSON.stringify(value));
      const reject = () => {
        unexpected.push(`${attempt.method} ${url.pathname}${url.search}`);
        res.statusCode = 500;
        reply({ message: "Unexpected fake Core request" });
      };
      // Core serializes the mapped recipe ID during sign-in, including session creation.
      const recipeUserId = signInRecipe ? sdkId() : internalId;
      const thirdParty = signInRecipe === "thirdparty" ? provider : undefined;
      const user = {
        id: sdkId(), isPrimaryUser: false, timeJoined: 1000, tenantIds: ["public"],
        emails: [email], phoneNumbers: [], thirdParty: thirdParty ? [thirdParty] : [],
        loginMethods: [{ recipeUserId, recipeId: signInRecipe ?? "passwordless", email, thirdParty,
          verified: true, timeJoined: 1000, tenantIds: ["public"] }],
      };
      const session = (userDataInJWT: Json) => ({
        handle: "budget-session", userId: sessionSelector ?? sdkId(), recipeUserId, tenantId: "public", userDataInJWT,
      });
      const token = async (payload: Json) => ({
        token: await signToken(payload, recipeUserId),
        createdTime: Date.now(), expiry: Date.now() + 3_600_000,
      });
      switch (`${attempt.method} ${url.pathname}`) {
        case "GET /apiversion":
          return reply({ versions: ["5.4"] });
        case "GET /.well-known/jwks.json":
          return reply({ keys: [jwk] });
        case "POST /recipe/session/verify":
          if (body.checkDatabase !== true || typeof body.accessToken !== "string") return reject();
          return reply(revoked ? { status: "UNAUTHORISED", message: "Session revoked" } : {
            status: "OK", session: session({}),
          });
        case "POST /public/recipe/session": {
          if (!signInRecipe || body.userId !== recipeUserId) return reject();
          const payload = body.userDataInJWT as Json;
          return reply({ status: "OK", session: session(payload), accessToken: await token(payload),
            refreshToken: { token: "budget-refresh", createdTime: Date.now(), expiry: Date.now() + 3_600_000 } });
        }
        case "POST /recipe/session/regenerate": {
          if (!signInRecipe || typeof body.accessToken !== "string") return reject();
          const payload = body.userDataInJWT as Json;
          return reply({ status: "OK", session: session(payload), accessToken: await token(payload) });
        }
        case "POST /recipe/session/remove": {
          if (signInRecipe !== "thirdparty" || !metadataWriteFailureId || !Array.isArray(body.sessionHandles)) return reject();
          return reply({ status: "OK", sessionHandlesRevoked: body.sessionHandles });
        }
        case "GET /user/id":
          if (![internalId, sdkId()].includes(url.searchParams.get("userId")!)) return reject();
          return reply({ status: "OK", user });
        case "GET /public/users/by-accountinfo": {
          if (!signInRecipe) return reject();
          const emailMatches = url.searchParams.has("email") ? url.searchParams.get("email") === email : undefined;
          const providerMatches = url.searchParams.has("thirdPartyId")
            ? url.searchParams.get("thirdPartyId") === thirdParty?.id &&
              url.searchParams.get("thirdPartyUserId") === thirdParty?.userId
            : undefined;
          const filters = [emailMatches, providerMatches].filter((match) => match !== undefined);
          const matches = url.searchParams.get("doUnionOfAccountInfo") === "true" ? filters.some(Boolean) : filters.every(Boolean);
          return reply({ status: "OK", users: matches ? [user] : [] });
        }
        case "GET /public/recipe/multitenancy/tenant/v2":
          if (!signInRecipe) return reject();
          return reply({ status: "OK", tenantId: "public", thirdParty: { providers: [] } });
        case "GET /public/recipe/signinup/codes":
          if (signInRecipe !== "passwordless" || url.searchParams.get("preAuthSessionId") !== device.preAuthSessionId) return reject();
          return reply({ status: "OK", devices: [{ ...device, codes: [
            { codeId: "budget-code", timeCreated: String(Date.now()), codeLifetime: 900_000 },
          ] }] });
        case "GET /recipe/user/email/verify":
          if (!signInRecipe || url.searchParams.get("email") !== email) return reject();
          return reply({ status: "OK", isVerified: true });
        case "POST /public/recipe/signinup/code/consume":
          if (signInRecipe !== "passwordless" || body.linkCode !== loginCode || body.preAuthSessionId !== device.preAuthSessionId) return reject();
          return reply({ status: "OK", createdNewUser: false, user, recipeUserId, consumedDevice: device });
        case "POST /public/recipe/signinup":
          if (!thirdParty || body.thirdPartyId !== thirdParty.id || body.thirdPartyUserId !== thirdParty.userId) return reject();
          return reply({ status: "OK", createdNewUser: false, user, recipeUserId });
        case "GET /recipe/userid/map": {
          const id = url.searchParams.get("userId");
          const type = url.searchParams.get("userIdType");
          if (![internalId, sdkId()].includes(id!) || !["SUPERTOKENS", "EXTERNAL"].includes(type!)) return reject();
          return reply(mapped && ((id === internalId && type === "SUPERTOKENS") ||
            (id === externalId && type === "EXTERNAL"))
            ? { status: "OK", superTokensUserId: internalId, externalUserId: externalId }
            : { status: "UNKNOWN_MAPPING_ERROR" });
        }
        case "GET /recipe/user/metadata": {
          const id = url.searchParams.get("userId")!;
          if (signInRecipe === "thirdparty" && thirdParty && id === `rownd_dsi:${createHash("sha256")
            .update(JSON.stringify(["public", thirdParty.id, thirdParty.userId])).digest("hex")}`) {
            return reply({ status: "OK", metadata: {} });
          }
          if (![internalId, externalId].includes(id)) return reject();
          if (metadataFailure) {
            res.statusCode = 500;
            return reply({ message: "Metadata unavailable" });
          }
          return reply({ status: "OK", metadata: metadata.get(id) ?? {} });
        }
        case "PUT /recipe/user/metadata": {
          const writableIds = getPluginConfig()?.metadataMode === "dual-write" ? [internalId, sdkId()]
            : [getPluginConfig()?.metadataMode === "canonical" || signInRecipe ? sdkId() : internalId, ...extraWritableIds];
          if (!writableIds.includes(body.userId as string) ||
            typeof body.metadataUpdate !== "object" || !body.metadataUpdate) return reject();
          if (body.userId === metadataWriteFailureId) {
            res.statusCode = 500;
            return reply({ message: `Metadata write failed for ${email}` });
          }
          await beforeMetadataWrite?.();
          const next = { ...metadata.get(body.userId as string) };
          for (const [key, value] of Object.entries(body.metadataUpdate as JsonRecord)) {
            if (value === null) delete next[key];
            else next[key] = value;
          }
          metadata.set(body.userId as string, next);
          return reply({ status: "OK", metadata: next });
        }
        default:
          return reject();
      }
    });
    coreUrl = await listen(coreServer);
    const app = express();
    appServer = createServer(app);
    appUrl = await listen(appServer);
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, options) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (![appUrl, coreUrl].includes(url.origin)) {
        unexpected.push(`External fetch: ${url}`);
        throw new Error(`External fetch: ${url}`);
      }
      return originalFetch(input, options);
    });
    initSDK();
    app.use(middleware());
    app.use(errorHandler());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await close(appServer);
    await close(coreServer);
    resetSDK();
    expect(unexpected).toEqual([]);
  });

  function observeSDK() {
    const user = vi.spyOn(SuperTokens, "getUser");
    const mapping = vi.spyOn(SuperTokens, "getUserIdMapping");
    const metadataGet = vi.spyOn(UserMetadata, "getUserMetadata");
    const metadataPut = vi.spyOn(UserMetadata, "updateUserMetadata");
    const verify = vi.spyOn(SessionRaw.getInstanceOrThrowError().recipeInterfaceImpl, "getSession");
    return () => ({ user: user.mock.calls.length, mapping: mapping.mock.calls.length,
      metadataGet: metadataGet.mock.calls.length, metadataPut: metadataPut.mock.calls.length,
      verify: verify.mock.calls.length });
  }

  function steady() {
    return attempts.filter(({ path }) => path !== "/apiversion" && path !== "/.well-known/jwks.json");
  }

  function countCoreCalls(calls = steady()) {
    const counts: Record<string, number> = {};
    for (const { method, path } of calls) {
      const key = `${method} ${path}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  function bootstrap() {
    return {
      cdi: attempts.filter(({ path }) => path === "/apiversion").length,
      signingKeys: attempts.filter(({ path }) => path === "/.well-known/jwks.json").length,
    };
  }

  function signToken(payload: Json, recipeId = internalId, signingKey = keys.privateKey) {
    return new SignJWT({ ...payload, sessionHandle: "budget-session", refreshTokenHash1: "hash",
      rsub: recipeId, tId: "public", stt: 0 })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "d-budget-test", version: "5" })
      .setSubject(sessionSelector ?? sdkId()).setIssuedAt().setExpirationTime("1h").sign(signingKey);
  }

  async function request(path: string, body?: Json, signingKey = keys.privateKey) {
    const token = await signToken({}, internalId, signingKey);
    return fetch(`${appUrl}/auth/plugin/rownd/${path}`, {
      method: body === undefined ? "GET" : "PUT",
      headers: { Authorization: `Bearer ${token}`, rid: "session", "fdi-version": "1.18",
        "st-auth-mode": "header", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  const readCases = [false, true].flatMap((isMapped) =>
    ["user", "user/meta", "user/field?field=first_name"].map((path) => ({ isMapped, path })));

  function publishCanonicalFixture() {
    metadata.set(sdkId(), getCanonicalPresentationMetadata({
      first_name: "Published", preference: "canonical", custom: { old: true, removed: true },
      ...storedActivity,
      original_rownd_user: { data: { user_id: sdkId(), first_name: "Original" },
        state: "enabled", auth_level: "verified", verified_data: {} },
    }));
  }

  function expectCanonicalReads(start = 0) {
    const reads = steady().slice(start);
    expect(reads.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /recipe/session/verify", "GET /user/id", "GET /recipe/user/metadata",
    ]);
    expect(reads[2]?.params.get("userId")).toBe(sdkId());
  }

  function expectCanonicalWrite(start: number, field: string, value: unknown) {
    const writes = steady().slice(start);
    expect(writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /recipe/session/verify", "GET /user/id", "PUT /recipe/user/metadata",
      "GET /user/id", "GET /recipe/user/metadata",
    ]);
    expect(writes[2]?.body).toMatchObject({ userId: sdkId(), metadataUpdate: {
      [field]: value, [`${ROWND_PROFILE_AUTHORITY_PREFIX}${field}`]: true,
    } });
    expect(writes[2]?.body.metadataUpdate).not.toHaveProperty("rownd_profile_authoritative_fields");
    expect(writes[4]?.params.get("userId")).toBe(sdkId());
  }

  function expectPrivateAuthority(record: Json) {
    expect(Object.keys(record).some((key) => key.startsWith(ROWND_PROFILE_AUTHORITY_PREFIX) ||
      key === "rownd_profile_authoritative_fields")).toBe(false);
  }

  it.each([
    { mode: "compatibility", recipe: "passwordless", variant: "existing", baseline: [2, 6, 7], policy: [0, 0, 2] },
    { mode: "compatibility", recipe: "passwordless", variant: "added", baseline: [3, 8, 9], policy: [0, 0, 2] },
    { mode: "compatibility", recipe: "thirdparty", variant: "existing", baseline: [2, 4, 5], policy: [0, 0, 3] },
    { mode: "compatibility", recipe: "thirdparty", variant: "added", baseline: [3, 6, 7], policy: [0, 0, 2] },
    { mode: "canonical", recipe: "passwordless", variant: "existing", baseline: [2, 4, 6], policy: [0, 2, 3] },
    { mode: "canonical", recipe: "passwordless", variant: "added", baseline: [2, 4, 7], policy: [1, 4, 4] },
    { mode: "canonical", recipe: "thirdparty", variant: "existing", baseline: [1, 0, 2], policy: [0, 1, 4] },
    { mode: "canonical", recipe: "thirdparty", variant: "added", baseline: [1, 0, 3], policy: [0, 1, 4] },
  ] as const)("budgets $recipe sign-in with $variant variant in $mode mode", async ({ mode, recipe, variant, baseline, policy }) => {
    mapped = true;
    signInRecipe = recipe;
    initSDK(false, mode);
    metadata.set(sdkId(), { original_rownd_user: {
      data: { user_id: sdkId(), first_name: "Stored" },
      verified_data: { email },
      attributes: { "rownd:app_variants": ["existing"], other: "retained" },
    } });
    const passwordless = recipe === "passwordless";
    const canonical = mode === "canonical";
    const write = variant === "added";
    const path = passwordless ? "signinup/code/consume" : "signinup";
    const authPath = `/public/recipe/${path}`;
    const response = await signIn(recipe, variant);
    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 200, body: { status: "OK", createdNewRecipeUser: false, user: { id: sdkId() } },
    });
    const accessToken = response.headers.get("st-access-token");
    expect(accessToken).not.toBeNull();
    expect(decodeJwt(accessToken!)).toMatchObject({ rownd_session_authentication: "authenticated", auth_level: "verified" });
    const calls = steady();
    const authIndex = calls.findIndex(({ path }) => path === authPath);
    const createIndex = calls.findIndex(({ path }) => path === "/public/recipe/session");
    expect(createIndex).toBeGreaterThan(authIndex);
    expect(calls[createIndex]?.body).toMatchObject({
      userDataInJWT: { rownd_session_authentication: "authenticated" },
    });
    expect(calls.slice(authIndex + 1, createIndex).filter(({ path }) => path === "/recipe/userid/map")
      .map(({ params }) => params.get("userIdType"))).toEqual(canonical ? ["EXTERNAL"] : ["EXTERNAL", "SUPERTOKENS"]);
    const variants = write ? ["existing", "added"] : ["existing"];
    expect(metadata.get(sdkId())).toMatchObject({ original_rownd_user: { attributes: {
      "rownd:app_variants": canonical ? ["existing"] : variants, other: "retained",
    } } });
    expect(metadata.get(sdkId())?.[ROWND_APP_VARIANTS_KEY])
      .toEqual(canonical && write ? { public: variants } : undefined);

    const [userReads, mappings, metadataReads] = baseline.map((count, index) => count + policy[index]!);
    expect(countCoreCalls(calls)).toEqual({
      "GET /public/recipe/multitenancy/tenant/v2": 1,
      "GET /public/users/by-accountinfo": passwordless ? 2 : canonical ? 4 : 5,
      "GET /recipe/user/email/verify": 1,
      "GET /user/id": userReads,
      "GET /recipe/user/metadata": metadataReads,
      ...(mappings ? { "GET /recipe/userid/map": mappings } : {}),
      "POST /public/recipe/session": 1,
      "POST /recipe/session/regenerate": 1,
      [`POST ${authPath}`]: 1,
      ...(passwordless ? { "GET /public/recipe/signinup/codes": 1 } : {}),
      ...(write ? { "PUT /recipe/user/metadata": 1 } : {}),
    });
  });

  async function signIn(recipe: "passwordless" | "thirdparty", variant: string) {
    const passwordless = recipe === "passwordless";
    const path = passwordless ? "signinup/code/consume" : "signinup";
    const body = passwordless
      ? { preAuthSessionId: device.preAuthSessionId, linkCode: loginCode }
      : { thirdPartyId: provider.id, oAuthTokens: { thirdPartyUserId: provider.userId, email } };
    return fetch(`${appUrl}/auth/${path}?app_variant_id=${variant}`, {
      method: "POST",
      headers: { rid: recipe, "fdi-version": "1.18", "st-auth-mode": "header", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it.each((["passwordless", "thirdparty"] as const).flatMap((recipe) =>
    ["existing", "added"].map((variant) => ({ recipe, variant }))))(
    "handles a failed mirror on $recipe sign-in with an $variant variant", async ({ recipe, variant }) => {
      mapped = true;
      signInRecipe = recipe;
      initSDK(false, "dual-write");
      metadata.set(internalId, { original_rownd_user: {
        data: { user_id: externalId }, verified_data: { email },
        attributes: { "rownd:app_variants": ["existing"] },
      } });
      metadataWriteFailureId = externalId;
      vi.mocked(logDebugMessage).mockClear();

      const response = await signIn(recipe, variant);
      expect(steady().filter(({ method }) => method === "PUT").map(({ body }) => body.userId))
        .toEqual(variant === "existing" ? [externalId] : [internalId, externalId]);
      if (variant === "existing") {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "OK", user: { id: externalId } });
        expect(response.headers.has("st-access-token")).toBe(true);
        expect(logDebugMessage).toHaveBeenCalledWith("Rownd app variant mirror replay failed");
        expect(vi.mocked(logDebugMessage).mock.calls.flat().join(" ")).not.toContain(email);
      } else {
        expect(response.status).toBe(500);
        expect(metadata.get(internalId)?.original_rownd_user?.attributes?.["rownd:app_variants"])
          .toEqual(["existing", "added"]);
      }
    },
  );

  it.each((["passwordless", "thirdparty"] as const).flatMap((recipe) => ["existing", "added"].flatMap((variant) =>
    ([["internal", true, false], ["internal", false, false], ["sdk", true, false], ["sdk", true, true]] as const)
      .map(([source, published, staleAuthority]) => ({ recipe, variant, source, published, staleAuthority })))))(
    "budgets dual-write $recipe sign-in with $variant variant at $source (published=$published, stale authority=$staleAuthority)",
    async ({ recipe, variant, source, published, staleAuthority }) => {
      mapped = true;
      signInRecipe = recipe;
      // Compatibility records variants at whichever record sources the Rownd user.
      if (source === "internal") extraWritableIds = [internalId];
      const original = { data: { user_id: externalId, first_name: "Stored" }, verified_data: { email },
        attributes: { "rownd:app_variants": ["existing"] } };
      const run = async (mode: "compatibility" | "dual-write") => {
        initSDK(false, mode);
        attempts = [];
        metadata.set(internalId, { ...(source === "internal" ? { original_rownd_user: original } : {}),
          ...(staleAuthority ? { rownd_profile_authoritative_fields: ["last_name"] } : {}) });
        metadata.set(externalId, { first_name: "Alias", ...(published ? { original_rownd_user: original } : {}),
          ...(staleAuthority ? { rownd_profile_authoritative_fields: ["first_name"] } : {}) });
        const response = await signIn(recipe, variant);
        expect({ status: response.status, body: await response.json() }).toMatchObject({
          status: 200, body: { status: "OK", user: { id: sdkId() } },
        });
        return { counts: countCoreCalls(), puts: steady().filter(({ method }) => method === "PUT").map(({ body }) => body) };
      };
      const compatibility = await run("compatibility");
      const dualWrite = await run("dual-write");
      const mirrorsOriginal = source === "internal" && (variant === "added" || !published);
      const mirrored = mirrorsOriginal || staleAuthority;
      const compatibilityPuts = compatibility.counts["PUT /recipe/user/metadata"] ?? 0;
      expect(compatibilityPuts).toBe(variant === "added" ? 1 : 0);
      const { "PUT /recipe/user/metadata": _ignored, ...compatibilityReads } = compatibility.counts;
      // A repair PUT clears the request's Core cache, so session claims re-read the
      // owner exactly as they do after a compatibility variant write.
      const repairReads = mirrored && !compatibilityPuts;
      expect(dualWrite.counts).toEqual({ ...compatibilityReads,
        ...(repairReads ? {
          "GET /user/id": compatibilityReads["GET /user/id"]! + 1,
          "GET /recipe/userid/map": compatibilityReads["GET /recipe/userid/map"]! + 2,
          "GET /recipe/user/metadata": compatibilityReads["GET /recipe/user/metadata"]! + 2,
        } : {}),
        ...(compatibilityPuts + Number(mirrored) ? { "PUT /recipe/user/metadata": compatibilityPuts + Number(mirrored) } : {}) });
      expect(dualWrite.puts.slice(0, compatibility.puts.length)).toEqual(compatibility.puts);
      if (mirrored) {
        expect(dualWrite.puts[dualWrite.puts.length - 1]).toEqual({ userId: externalId, metadataUpdate: {
          ...(mirrorsOriginal ? { original_rownd_user: metadata.get(internalId)?.original_rownd_user } : {}),
          ...(staleAuthority ? { rownd_profile_authoritative_fields: ["last_name"] } : {}),
        } });
        if (mirrorsOriginal) expect(metadata.get(externalId)?.original_rownd_user).toEqual(metadata.get(internalId)?.original_rownd_user);
      }
    },
  );

  it.each([false, true])("budgets dual-write profile PUT as compatibility plus one mirror for mapped owners (mapped=%s)", async (isMapped) => {
    mapped = isMapped;
    const run = async (mode: "compatibility" | "dual-write") => {
      initSDK(false, mode);
      attempts = [];
      metadata.set(internalId, { first_name: "Profile" });
      metadata.set(externalId, { first_name: "Alias" });
      const response = await request("user", { data: { first_name: "Edited" } });
      expect({ status: response.status, body: await profileJson(response) }).toMatchObject({
        status: 200, body: { status: "OK", data: { user_id: sdkId(), first_name: "Edited" } },
      });
      return { counts: countCoreCalls(), puts: steady().filter(({ method }) => method === "PUT").map(({ body }) => body) };
    };
    const compatibility = await run("compatibility");
    const dualWrite = await run("dual-write");
    expect(dualWrite.counts).toEqual({ ...compatibility.counts,
      "PUT /recipe/user/metadata": isMapped ? 2 : 1 });
    expect(dualWrite.puts[0]).toEqual(compatibility.puts[0]);
    if (isMapped) {
      expect(dualWrite.puts[1]).toEqual({ userId: externalId, metadataUpdate: {
        first_name: "Edited", rownd_profile_authoritative_fields: ["first_name"],
      } });
    }
  });

  it.each(readCases)("reads GET $path in dual-write mode exactly as compatibility (mapped=$isMapped)", async ({ isMapped, path }) => {
    mapped = isMapped;
    const run = async (mode: "compatibility" | "dual-write") => {
      initSDK(false, mode);
      attempts = [];
      const response = await request(path);
      expect(response.status).toBe(200);
      // Linked metadata reads are concurrent, so only their multiset is stable.
      return { body: await response.json(), calls: steady().map(({ method, path: corePath, params }) =>
        `${method} ${corePath}?${params}`).sort() };
    };
    expect(await run("dual-write")).toEqual(await run("compatibility"));
  });

  it.each(["compatibility", "canonical"] as const)("budgets matching expected-owner profile PUT in %s mode", async (mode) => {
    mapped = true;
    initSDK(false, mode);
    const response = await request("user", {
      data: { first_name: "Edited" },
      context: { rowndExpectedUserId: internalId, rowndExpectedTenantId: "public" },
    });
    expect({ status: response.status, body: await profileJson(response) }).toMatchObject({
      status: 200, body: { status: "OK", data: { user_id: sdkId(), first_name: "Edited" } },
    });
    expect(steady().slice(0, 3).map(({ path }) => path)).toEqual(["/recipe/session/verify", "/user/id", "/user/id"]);
    expect(countCoreCalls()).toEqual({
      "POST /recipe/session/verify": 1,
      "GET /user/id": 3,
      "GET /recipe/user/metadata": mode === "canonical" ? 1 : 3,
      ...(mode === "compatibility" ? { "GET /recipe/userid/map": 4 } : {}),
      "PUT /recipe/user/metadata": 1,
    });
  });

  it.each(readCases)("uses exactly three real Core attempts for canonical GET $path (mapped=$isMapped)", async ({ isMapped, path }) => {
    mapped = isMapped;
    initSDK(false, "canonical");
    publishCanonicalFixture();
    const calls = observeSDK();
    const response = await request(path);
    expect(response.status).toBe(200);
    const body = await response.json();
    if (path === "user") {
      expect(body).toMatchObject({ status: "OK", rownd_user: sdkId(),
        data: { user_id: sdkId(), first_name: "Published", email: "owner@example.com" },
        meta: { preference: "canonical", last_sign_in: null, last_active: null, last_sign_in_method: null } });
    } else if (path === "user/meta") {
      expect(body).toEqual({ status: "OK", id: sdkId(), meta: {
        first_name: "Published", preference: "canonical", custom: { old: true, removed: true }, ...storedActivity,
      } });
    } else expect(body).toEqual({ status: "OK", value: "Published" });
    expect(calls()).toEqual({ user: 1, mapping: 0, metadataGet: 1, metadataPut: 0, verify: 1 });
    expectCanonicalReads();
    expect(bootstrap()).toEqual({ cdi: 1, signingKeys: 1 });

    const warm = await request(path);
    expect(warm.status).toBe(200);
    expect(await warm.json()).toEqual(body);
    expect(calls()).toEqual({ user: 2, mapping: 0, metadataGet: 2, metadataPut: 0, verify: 2 });
    expectCanonicalReads(3);
    expect(bootstrap()).toEqual({ cdi: 1, signingKeys: 1 });
  });

  it.each(readCases.flatMap((entry) => ["missing", "empty"].map((kind) => ({ ...entry, kind }))))(
    "does not fall back from $kind canonical metadata for GET $path (mapped=$isMapped)", async ({ isMapped, path, kind }) => {
      mapped = isMapped;
      initSDK(false, "canonical");
      if (kind === "missing") metadata.delete(sdkId());
      else metadata.set(sdkId(), {});
      const calls = observeSDK();
      const response = await request(path);
      const body = await response.json();
      if (path === "user") {
        const profile = body as ProfileResponse;
        expect(response.status).toBe(200);
        expect(profile.data.first_name).toBe("");
        expect(profile.data.user_id).toBe(sdkId());
        expect(profile.meta).not.toHaveProperty("alias_only");
        expect(profile.meta).not.toHaveProperty("preference");
      } else if (path === "user/meta") {
        expect(response.status).toBe(200);
        expect(body).toEqual({ status: "OK", id: sdkId(), meta: {} });
      } else {
        expect(response.status).toBe(200);
        expect(body).toEqual({ status: "OK", value: "" });
      }
      expect(calls().mapping).toBe(0);
      expectCanonicalReads();
    },
  );

  it.each(readCases)("does not mask canonical metadata failures for GET $path (mapped=$isMapped)", async ({ isMapped, path }) => {
    mapped = isMapped;
    initSDK(false, "canonical");
    metadataFailure = true;
    const calls = observeSDK();
    const response = await request(path);
    expect(response.status).toBe(500);
    await response.text();
    expect(calls()).toEqual({ user: 1, mapping: 0, metadataGet: 1, metadataPut: 0, verify: 1 });
    expectCanonicalReads();
  });

  it.each(readCases)("rejects revoked canonical GET $path before metadata (mapped=$isMapped)", async ({ isMapped, path }) => {
    mapped = isMapped;
    initSDK(false, "canonical");
    revoked = true;
    metadataFailure = true;
    const calls = observeSDK();
    const response = await request(path);
    expect(response.status).toBe(401);
    expect(calls()).toEqual({ user: 0, mapping: 0, metadataGet: 0, metadataPut: 0, verify: 1 });
    expect(steady().map(({ method, path }) => `${method} ${path}`)).toEqual(["POST /recipe/session/verify"]);
    expect(bootstrap()).toEqual({ cdi: 1, signingKeys: 1 });
  });

  it.each(readCases)("rejects invalid canonical GET $path before metadata (mapped=$isMapped)", async ({ isMapped, path }) => {
    mapped = isMapped;
    initSDK(false, "canonical");
    metadataFailure = true;
    const untrusted = await generateKeyPair("RS256");
    const calls = observeSDK();
    expect((await request(path, undefined, untrusted.privateKey)).status).toBe(401);
    expect(calls()).toEqual({ user: 0, mapping: 0, metadataGet: 0, metadataPut: 0, verify: 1 });
    expect(steady()).toEqual([]);
    expect(bootstrap()).toEqual({ cdi: 0, signingKeys: 1 });
  });

  it.each([false, true].flatMap((isMapped) => [false, true].map((disableCache) => ({ isMapped, disableCache }))))(
    "keeps published canonical writes fresh across edits/deletions/replacements (mapped=$isMapped, disableCache=$disableCache)", async ({ isMapped, disableCache }) => {
      mapped = isMapped;
      initSDK(disableCache, "canonical");
      publishCanonicalFixture();
      const calls = observeSDK();
      for (const first_name of ["Edited", null, "Restored"]) {
        const start = steady().length;
        const response = await request("user", { data: { first_name } });
        expect(response.status).toBe(200);
        const body = await profileJson(response);
        expect(body.rownd_user).toBe(sdkId());
        expect(body.data.user_id).toBe(sdkId());
        expect(body.data.first_name).toBe(first_name ?? undefined);
        expectPrivateAuthority(body.data);
        expectPrivateAuthority(body.meta);
        expectCanonicalWrite(start, "first_name", first_name);
        const read = await request("user");
        expect(read.status).toBe(200);
        expect((await profileJson(read)).data.first_name).toBe(first_name ?? undefined);
      }
      for (const custom of [{ replacement: true, nested_null: null }, {}, null]) {
        const start = steady().length;
        const response = await request("user/meta", { meta: { custom } });
        expect(response.status).toBe(200);
        const body = await metadataJson(response);
        expect(body.id).toBe(sdkId());
        expect(body.meta.custom).toEqual(custom ?? undefined);
        expectPrivateAuthority(body.meta);
        expectCanonicalWrite(start, "custom", custom);
        const read = await request("user/meta");
        expect(read.status).toBe(200);
        expect((await metadataJson(read)).meta.custom).toEqual(custom ?? undefined);
      }
      expect(calls().mapping).toBe(0);
      expect(calls()).toEqual({ user: 18, mapping: 0, metadataGet: 12, metadataPut: 6, verify: 12 });
      expect(steady()).toHaveLength(48);
      expect(steady().filter(({ path }) => path === "/recipe/user/metadata")
        .every(({ params, body, method }) => (method === "PUT" ? body.userId : params.get("userId")) === sdkId())).toBe(true);
      expect(bootstrap()).toEqual({ cdi: 1, signingKeys: 1 });
    },
  );

  it.each([false, true].flatMap((isMapped) => [false, true].map((disableCache) => ({ isMapped, disableCache }))))(
    "retains a deletion during concurrent different-field canonical writes (mapped=$isMapped, disableCache=$disableCache)", async ({ isMapped, disableCache }) => {
      mapped = isMapped;
      initSDK(disableCache, "canonical");
      publishCanonicalFixture();
      const calls = observeSDK();
      let release!: () => void;
      let arrivals = 0;
      const bothWrites = new Promise<void>((resolve) => { release = resolve; });
      // Hold Core commits until both plugin writes arrive, exposing any stale shared-array RMW.
      beforeMetadataWrite = async () => {
        if (++arrivals === 2) release();
        await bothWrites;
      };
      const responses = await Promise.all([
        request("user", { data: { first_name: null } }),
        request("user", { data: { last_name: "Concurrent edit" } }),
      ]);
      beforeMetadataWrite = undefined;
      expect(responses.map(({ status }) => status)).toEqual([200, 200]);
      for (const response of responses) {
        const body = await profileJson(response);
        expect(body.data.user_id).toBe(sdkId());
        expect(body.data).not.toHaveProperty("first_name");
        expect(body.data.last_name).toBe("Concurrent edit");
        expectPrivateAuthority(body.data);
        expectPrivateAuthority(body.meta);
      }
      expect(calls()).toEqual({ user: 4, mapping: 0, metadataGet: 2, metadataPut: 2, verify: 2 });
      expect(steady()).toHaveLength(10);
      const writes = steady().filter(({ method }) => method === "PUT");
      expect(writes.map(({ body }) => body.metadataUpdate)).toEqual(expect.arrayContaining([
        { first_name: null, [`${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`]: true },
        { last_name: "Concurrent edit", [`${ROWND_PROFILE_AUTHORITY_PREFIX}last_name`]: true },
      ]));
      const stored = metadata.get(sdkId())!;
      expect(getAuthoritativeProfileFields(stored).sort()).toEqual(["first_name", "last_name"]);
      expect(buildConfiguredSessionClaims(stored, { ...getPluginConfig()!, schema: {
        first_name: { display_name: "First name", type: "string", user_visible: true, include_in_session_claims: true },
        last_name: { display_name: "Last name", type: "string", user_visible: true, include_in_session_claims: true },
      } })).toEqual({ last_name: "Concurrent edit" });
      const start = steady().length;
      const fresh = await request("user");
      expect(fresh.status).toBe(200);
      const profile = await profileJson(fresh);
      expect(profile.data).not.toHaveProperty("first_name");
      expect(profile.data.last_name).toBe("Concurrent edit");
      expectCanonicalReads(start);
      const publicMeta = await metadataJson(await request("user/meta"));
      expect(publicMeta.id).toBe(sdkId());
      expectPrivateAuthority(publicMeta.meta);
      expect(publicMeta.meta).not.toHaveProperty("first_name");
      // The second request may reuse the CDI version cached by the first.
      const { cdi, signingKeys } = bootstrap();
      expect([1, 2]).toContain(cdi);
      expect(signingKeys).toBe(1);
    },
  );

  it("switches static metadata modes without a hidden presentation cache", async () => {
    mapped = true;
    const calls = observeSDK();
    expect((await profileJson(await request("user"))).data.first_name).toBe("Profile");
    const compatibilityConfig = getPluginConfig()!;
    setPluginConfig({ ...compatibilityConfig, metadataMode: "canonical" });
    publishCanonicalFixture();
    const start = steady().length;
    expect((await profileJson(await request("user"))).data.first_name).toBe("Published");
    expectCanonicalReads(start);
    metadata.set(externalId, { first_name: "Remote edit" });
    expect((await profileJson(await request("user"))).data.first_name).toBe("Remote edit");
    setPluginConfig(compatibilityConfig);
    expect((await profileJson(await request("user"))).data.first_name).toBe("Profile");
    expect(calls().mapping).toBe(4);
    expect(bootstrap()).toEqual({ cdi: 1, signingKeys: 1 });
  });

  it.each(readCases)("database-verifies GET $path before compatibility reads (mapped=$isMapped)", async ({ isMapped, path }) => {
    mapped = isMapped;
    const calls = observeSDK();
    const response = await request(path);
    expect(response.status).toBe(200);
    const body = await response.json();
    if (path === "user") {
      expect(body).toMatchObject({ status: "OK", rownd_user: sdkId(),
        data: { user_id: sdkId(), email: "owner@example.com", first_name: "Profile" },
        verified_data: { email: "owner@example.com" }, state: "enabled", auth_level: "verified",
        meta: { preference: "preserved", last_sign_in: null, last_active: null, last_sign_in_method: null } });
    } else if (path === "user/meta") {
      expect(body).toMatchObject({ status: "OK", id: sdkId(),
        meta: { first_name: "Profile", preference: "preserved", ...storedActivity } });
    } else {
      expect(body).toEqual({ status: "OK", value: "Profile" });
    }
    expect(calls()).toEqual({ user: 1, mapping: 2, metadataGet: mapped ? 2 : 1, metadataPut: 0, verify: 1 });
    expect(steady()).toHaveLength(mapped ? 6 : 5);
    expect(steady().slice(0, 4).map(({ method, path: corePath }) => `${method} ${corePath}`)).toEqual([
      "POST /recipe/session/verify", "GET /user/id", "GET /recipe/userid/map", "GET /recipe/userid/map",
    ]);
    expect(steady().filter(({ path: corePath }) => corePath === "/recipe/userid/map")
      .map(({ params }) => params.get("userIdType"))).toEqual(["SUPERTOKENS", "EXTERNAL"]);
    expect(steady().slice(4).map(({ params }) => params.get("userId")).sort())
      .toEqual((mapped ? [internalId, externalId] : [internalId]).sort());
    expect(bootstrap()).toEqual({ cdi: 1, signingKeys: 1 });

    const warm = await request(path);
    expect(warm.status).toBe(200);
    expect(await warm.json()).toEqual(body);
    expect(calls()).toEqual({ user: 2, mapping: 4, metadataGet: mapped ? 4 : 2, metadataPut: 0, verify: 2 });
    expect(steady()).toHaveLength(mapped ? 12 : 10);
    expect(bootstrap()).toEqual({ cdi: 1, signingKeys: 1 });
  });

  it.each(readCases)("rejects revoked GET $path before any user/mapping/metadata access (mapped=$isMapped)", async ({ isMapped, path }) => {
    mapped = isMapped;
    revoked = true;
    const calls = observeSDK();
    const response = await request(path);
    expect(response.status).toBe(401);
    expect(calls()).toEqual({ user: 0, mapping: 0, metadataGet: 0, metadataPut: 0, verify: 1 });
    expect(steady().map(({ method, path: corePath }) => `${method} ${corePath}`)).toEqual(["POST /recipe/session/verify"]);
    expect(bootstrap()).toEqual({ cdi: 1, signingKeys: 1 });
  });

  it("rejects an invalid signature through real SDK verification before calling Core verify", async () => {
    const untrusted = await generateKeyPair("RS256");
    const calls = observeSDK();
    const response = await request("user", undefined, untrusted.privateKey);
    expect(response.status).toBe(401);
    expect(calls()).toEqual({ user: 0, mapping: 0, metadataGet: 0, metadataPut: 0, verify: 1 });
    expect(steady()).toEqual([]);
    expect(bootstrap()).toEqual({ cdi: 0, signingKeys: 1 });
  });

  it.each([false, true].flatMap((isMapped) =>
    [{}, { last_sign_in: null, last_active: "echo", last_sign_in_method: "echo" }]
      .map((patch) => ({ isMapped, patch }))))(
    "skips metadata PUT and duplicate discovery for no-op $patch (1A; mapped=$isMapped)", async ({ isMapped, patch }) => {
      mapped = isMapped;
      const calls = observeSDK();
      const response = await request("user/meta", { meta: patch });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "OK", id: sdkId(),
        meta: { first_name: "Profile", preference: "preserved", ...storedActivity } });
      expect(calls()).toEqual({ user: 1, mapping: 2, metadataGet: mapped ? 2 : 1, metadataPut: 0, verify: 1 });
      expect(steady()).toHaveLength(mapped ? 6 : 5);
      expect(steady().every(({ method }) => method !== "PUT")).toBe(true);
      expect(metadata.get(internalId)).toMatchObject(storedActivity);
    },
  );

  it.each([false, true].flatMap((isMapped) =>
    [null, {}, { replacement: "value", nested_null: null }].map((custom) => ({ isMapped, custom }))))(
    "treats custom=$custom as a real replacement/deletion (mapped=$isMapped)", async ({ isMapped, custom }) => {
      mapped = isMapped;
      metadata.set(internalId, { ...metadata.get(internalId), custom: { old: "value" } });
      metadata.set(externalId, { ...metadata.get(externalId), custom: { alias: "must not return" } });
      const calls = observeSDK();
      const response = await request("user/meta", { meta: { custom } });
      expect(response.status).toBe(200);
      const body = await response.json() as { meta: Json };
      expect(body).toMatchObject({ status: "OK", id: sdkId(), meta: storedActivity });
      if (custom === null) expect(body.meta).not.toHaveProperty("custom");
      else expect(body.meta.custom).toEqual(custom);
      expect(calls()).toEqual({ user: 2, mapping: 4, metadataGet: mapped ? 3 : 2, metadataPut: 1, verify: 1 });
      expect(steady()).toHaveLength(mapped ? 11 : 10);
      expect(steady().filter(({ method }) => method === "PUT")).toHaveLength(1);
      expect(metadata.get(internalId)?.custom).toEqual(custom === null ? undefined : custom);
    },
  );

  it("does not classify an own undefined custom key as a no-op before JSON serialization", async () => {
    const calls = observeSDK();
    await updateUserMetadata(internalId, { custom: undefined }, {});
    expect(calls().metadataPut).toBe(1);
    expect(steady().filter(({ method }) => method === "PUT")).toHaveLength(1);
    expect(bootstrap()).toEqual({ cdi: 1, signingKeys: 0 });
  });

  it.each([false, true])("keeps one fresh profile read for an empty user patch (mapped=%s)", async (isMapped) => {
    mapped = isMapped;
    const calls = observeSDK();
    const response = await request("user", { data: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "OK", data: { user_id: sdkId(), first_name: "Profile" },
      meta: { last_sign_in: null, last_active: null, last_sign_in_method: null } });
    expect(calls()).toEqual({ user: 1, mapping: 2, metadataGet: mapped ? 2 : 1, metadataPut: 0, verify: 1 });
    expect(steady()).toHaveLength(mapped ? 6 : 5);
  });

  it.each(["compatibility", "canonical"] as const)("preserves the full profile response selector in %s mode", async (mode) => {
    mapped = true;
    sessionSelector = internalId;
    initSDK(false, mode);
    const calls = observeSDK();
    const canonical = mode === "canonical";

    for (const patch of [undefined, { data: {} }, { data: { first_name: "After full PUT" } }]) {
      const response = await request("user", patch);
      expect(response.status).toBe(200);
      expect(await profileJson(response)).toMatchObject({
        rownd_user: internalId,
        data: { user_id: internalId, first_name: patch?.data.first_name ?? (canonical ? "Alias" : "Profile") },
      });
    }

    const response = await request("user/field?field=first_name", { value: "After field PUT" });
    expect(response.status).toBe(200);
    expect(await profileJson(response)).toMatchObject({
      rownd_user: externalId, data: { user_id: externalId, first_name: "After field PUT" },
    });

    expect(steady().filter(({ path }) => path === "/user/id").map(({ params }) => params.get("userId")))
      .toEqual([internalId, internalId, internalId, internalId, internalId, externalId]);
    const writeId = canonical ? externalId : internalId;
    expect(steady().filter(({ method }) => method === "PUT").map(({ body }) => body.userId)).toEqual([writeId, writeId]);
    expect(calls()).toEqual({ user: 6, mapping: canonical ? 0 : 12, metadataGet: canonical ? 4 : 10, metadataPut: 2, verify: 4 });
    expect(steady()).toHaveLength(canonical ? 16 : 34);
  });

  it.each([false, true].flatMap((isMapped) => [false, true].map((disableCache) => ({ isMapped, disableCache }))))(
    "returns the mutation profile once (1B; mapped=$isMapped, disableCache=$disableCache)", async ({ isMapped, disableCache }) => {
      mapped = isMapped;
      initSDK(disableCache);
      const calls = observeSDK();
      const response = await request("user", { data: { first_name: "After" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "OK", rownd_user: sdkId(),
        data: { user_id: sdkId(), first_name: "After", email: "owner@example.com" },
        meta: { last_sign_in: null, last_active: null, last_sign_in_method: null } });
      expect(calls()).toEqual({ user: 2, mapping: 4, metadataGet: mapped ? 3 : 2, metadataPut: 1, verify: 1 });
      expect(steady()).toHaveLength(mapped ? 11 : 10);
      const writeIndex = steady().findIndex(({ method }) => method === "PUT");
      expect(writeIndex).toBe(5);
      expect(steady().slice(0, writeIndex + 1).map(({ method, path }) => `${method} ${path}`)).toEqual([
        "POST /recipe/session/verify", "GET /user/id", "GET /recipe/userid/map", "GET /recipe/userid/map",
        "GET /recipe/user/metadata", "PUT /recipe/user/metadata",
      ]);
      expect(steady().slice(writeIndex + 1, writeIndex + 4).map(({ path }) => path)).toEqual([
        "/user/id", "/recipe/userid/map", "/recipe/userid/map",
      ]);
      expect(steady().slice(writeIndex + 1).map(({ method }) => method).every((method) => method === "GET")).toBe(true);
      expect(metadata.get(internalId)?.first_name).toBe("After");
      expect(bootstrap()).toEqual({ cdi: 1, signingKeys: 1 });
    },
  );

  it.each([false, true])("keeps actual SDK GET cache/invalidation behavior (disableCache=%s)", async (disableCache) => {
    initSDK(disableCache);
    const calls = observeSDK();
    const context = {};
    await UserMetadata.getUserMetadata(internalId, context);
    await UserMetadata.getUserMetadata(internalId, context);
    expect(calls().metadataGet).toBe(2);
    expect(steady()).toHaveLength(disableCache ? 2 : 1);
    await UserMetadata.updateUserMetadata(internalId, { first_name: "Fresh" }, context);
    expect(await UserMetadata.getUserMetadata(internalId, context)).toMatchObject({ metadata: { first_name: "Fresh" } });
    expect(calls()).toEqual({ user: 0, mapping: 0, metadataGet: 3, metadataPut: 1, verify: 0 });
    expect(steady()).toHaveLength(disableCache ? 4 : 3);
    expect(bootstrap()).toEqual({ cdi: 1, signingKeys: 0 });
  });
});
