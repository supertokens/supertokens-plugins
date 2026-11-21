import express from "express";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import Passwordless from "supertokens-node/recipe/passwordless";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import OAuth2Provider from "supertokens-node/recipe/oauth2provider";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import EmailVerification from "supertokens-node/recipe/emailverification";
import { middleware, errorHandler } from "supertokens-node/framework/express";
import { ProcessState } from "supertokens-node/lib/build/processState";
import { Querier } from "supertokens-node/lib/build/querier";
import { getUserContext } from "supertokens-node/lib/build/utils";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import PasswordlessRaw from "supertokens-node/lib/build/recipe/passwordless/recipe";
import ThirdPartyRaw from "supertokens-node/lib/build/recipe/thirdparty/recipe";
import OAuth2ProviderRaw from "supertokens-node/lib/build/recipe/oauth2provider/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import EmailVerificationRaw from "supertokens-node/lib/build/recipe/emailverification/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import { GenericContainer, Network, Wait } from "testcontainers";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { getPluginConfig } from "./config";
import { PENDING_EMAIL_VERIFICATION_QUERY_PARAM } from "./constants";
import { init } from "./plugin";
import {
  buildConfiguredSessionClaims,
  getAuthoritativeProfileFields,
  getCanonicalPresentationMetadata,
  getRowndProfileData,
  inspectLinkedUserMetadata,
  inspectUserPresentationMetadata,
  ROWND_APP_VARIANTS_KEY,
  ROWND_PROFILE_AUTHORITY_PREFIX,
  updateUserPresentationMetadata,
  type RowndCompatUserResponse,
  type RowndMetadata,
} from "./rownd-compatibility";
import { buildRowndSessionClaims, getUserById, recordRowndAppVariantForUser, updateUserData, updateUserMetadata } from "./supertokens-repository";
import type { RowndPluginConfig } from "./types";

// Registry-verified multi-architecture 12.4.0 and 16.13 indexes; never use floating tags.
const CORE_IMAGE = "supertokens/supertokens-postgresql@sha256:d1b777a8474e3eda82d313dbfe8a80e5a32635f21001bd023f1dbf2652177831";
const POSTGRES_IMAGE = "postgres@sha256:5d143123fdf80462d1778cd4f24b9f7ca13c87174bca19141fb194c5a1ebca59";
const OFFLINE_PROVIDER_ID = "rownd-offline";
const command = promisify(execFile);
const schema: NonNullable<RowndPluginConfig["schema"]> = {
  first_name: { display_name: "First name", type: "string", user_visible: true, owned_by: "user", include_in_session_claims: true },
  last_name: { display_name: "Last name", type: "string", user_visible: true, owned_by: "user", include_in_session_claims: true },
  custom: { display_name: "Custom", type: "object", user_visible: true, owned_by: "user", include_in_session_claims: true, session_claim_name: "custom_claim" },
  deleted: { display_name: "Deleted", type: "string", user_visible: true, owned_by: "user", include_in_session_claims: true },
};

function resetSDK() {
  ProcessState.getInstance().reset();
  SessionRaw.reset();
  PasswordlessRaw.reset();
  ThirdPartyRaw.reset();
  OAuth2ProviderRaw.reset();
  UserMetadataRaw.reset();
  UserRolesRaw.reset();
  AccountLinkingRaw.reset();
  EmailVerificationRaw.reset();
  MultitenancyRaw.reset();
  SuperTokensRaw.reset();
  Querier.reset();
}

async function ensureImage(image: string) {
  try {
    await command("docker", ["image", "inspect", image], { timeout: 10_000 });
  } catch {
    await command("docker", ["pull", image], { timeout: 180_000 });
  }
  const { stdout } = await command("docker", ["image", "inspect", image, "--format", "{{json .}}"], { timeout: 10_000 });
  const inspected = JSON.parse(stdout);
  console.info("canonical integration image", JSON.stringify({ requested: image, id: inspected.Id, digests: inspected.RepoDigests, architecture: inspected.Architecture }));
}

function blockNonLoopbackRequests() {
  const attempts: string[] = [];
  function checkHost(host: string) {
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return;
    attempts.push(host);
    throw new Error(`Unexpected non-loopback HTTP request to ${host}`);
  }

  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    checkHost(new URL(input instanceof Request ? input.url : input).hostname);
    return originalFetch(input, { ...options, redirect: "error" });
  });

  function guardRequest(request: typeof http.request): typeof http.request {
    return (input: string | URL | RequestOptions, options?: RequestOptions | ((response: IncomingMessage) => void), callback?: (response: IncomingMessage) => void) => {
      if (typeof input === "string" || input instanceof URL) {
        checkHost(new URL(input).hostname);
        if (options && typeof options !== "function") {
          checkHost(options.hostname ?? options.host ?? "localhost");
          return request(input, options, callback);
        }
      } else {
        checkHost(input.hostname ?? input.host ?? "localhost");
      }
      return request(input, typeof options === "function" ? options : callback);
    };
  }

  const requestSpies = [http, https].flatMap((transport) => {
    const { request, get } = transport;
    return [
      vi.spyOn(transport, "request").mockImplementation(guardRequest(request)),
      vi.spyOn(transport, "get").mockImplementation(guardRequest(get)),
    ];
  });
  syncBuiltinESMExports();
  onTestFinished(() => {
    fetchSpy.mockRestore();
    for (const spy of requestSpies) spy.mockRestore();
    syncBuiltinESMExports();
    expect(attempts, "non-loopback HTTP requests").toEqual([]);
  });
}

describe("canonical metadata against disposable Core 12.4.0 / PostgreSQL 16.13", { timeout: 30_000 }, () => {
  let network: StartedNetwork | undefined;
  let postgres: StartedTestContainer | undefined;
  let core: StartedTestContainer | undefined;
  let server: Server | undefined;
  let baseUrl: string;
  let coreUrl: string;
  let verificationLinks: Map<string, string>;

  function configure(metadataMode?: RowndPluginConfig["metadataMode"]) {
    return init({
      disableRowndUserMigration: true, metadataMode, schema,
      appConfig: { signInMethods: [{ method: "email" }, { method: "anonymous" }] },
      subBrands: { existing: { variant: { id: "existing" } }, added: { variant: { id: "added" } } },
    });
  }

  function initialize(metadataMode?: RowndPluginConfig["metadataMode"]) {
    resetSDK();
    SuperTokens.init({
      telemetry: false,
      supertokens: { connectionURI: coreUrl },
      appInfo: { appName: "Disposable canonical metadata validation", apiDomain: baseUrl, websiteDomain: "http://localhost:3000" },
      recipeList: [
        Session.init(), UserMetadata.init(), OAuth2Provider.init(),
        EmailVerification.init({
          mode: "OPTIONAL",
          emailDelivery: {
            override: (original) => ({
              ...original,
              sendEmail: async (input) => { verificationLinks.set(input.user.email, input.emailVerifyLink); },
            }),
          },
        }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "USER_INPUT_CODE_AND_MAGIC_LINK" }),
        ThirdParty.init({
          signInAndUpFeature: {
            providers: [{
              config: {
                thirdPartyId: OFFLINE_PROVIDER_ID,
                clients: [{ clientId: "disposable-only" }],
                authorizationEndpoint: "https://provider.invalid/authorize",
                tokenEndpoint: "https://provider.invalid/token",
                userInfoEndpoint: "https://provider.invalid/userinfo",
              },
              override: (original) => original.type === "oauth2" ? {
                ...original,
                exchangeAuthCodeForOAuthTokens: async () => {
                  throw new Error("The offline provider fixture accepts OAuth tokens only");
                },
                getUserInfo: async ({ oAuthTokens }: { oAuthTokens: { thirdPartyUserId: string; email: string } }) => ({
                  thirdPartyUserId: oAuthTokens.thirdPartyUserId,
                  email: { id: oAuthTokens.email, isVerified: true },
                  rawUserInfoFromProvider: {},
                }),
              } : original,
            }],
          },
        }),
      ],
      experimental: { plugins: [configure(metadataMode)] },
    });
  }

  beforeAll(async () => {
    await Promise.all([ensureImage(CORE_IMAGE), ensureImage(POSTGRES_IMAGE)]);
    const runId = `rownd-canonical-${randomUUID()}`;
    const labels = { "rownd.canonical-integration": runId };
    network = await new Network().start();
    postgres = await new GenericContainer(POSTGRES_IMAGE)
      .withName(`${runId}-postgres`).withLabels(labels)
      .withPullPolicy({ shouldPull: () => false })
      .withNetwork(network).withNetworkAliases("canonical-postgres")
      .withEnvironment({ POSTGRES_USER: "supertokens", POSTGRES_PASSWORD: "disposable-only", POSTGRES_DB: "supertokens" })
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .withStartupTimeout(60_000).start();
    const databaseVersion = await postgres.exec(["psql", "-U", "supertokens", "-d", "supertokens", "-Atc", "SHOW server_version"]);
    expect(databaseVersion.exitCode).toBe(0);
    expect(databaseVersion.stdout.trim()).toMatch(/^16\.13(?:\s|$)/);
    core = await new GenericContainer(CORE_IMAGE)
      .withName(`${runId}-core`).withLabels(labels)
      .withPullPolicy({ shouldPull: () => false })
      .withNetwork(network)
      .withEnvironment({
        POSTGRESQL_CONNECTION_URI: "postgresql://supertokens:disposable-only@canonical-postgres:5432/supertokens",
        DISABLE_TELEMETRY: "true",
      })
      .withExposedPorts(3567).withWaitStrategy(Wait.forHttp("/hello", 3567))
      .withStartupTimeout(60_000).start();
    coreUrl = `http://${core.getHost()}:${core.getMappedPort(3567)}`;
    const coreVersion = await core.exec(["supertokens", "--version"]);
    console.info("canonical integration running versions", JSON.stringify({ core: coreVersion, postgres: databaseVersion.stdout.trim(), containers: [core.getId(), postgres.getId()] }));
    expect(coreVersion.exitCode).toBe(0);
    expect(coreVersion.stdout.trim()).toMatch(/\b12\.4\.0\b/);
    const license = await fetch(`${coreUrl}/ee/license`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ licenseKey: "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V" }),
    });
    expect({ status: license.status, body: await license.text() }).toMatchObject({ status: 200 });
  }, 340_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const [kind, resource] of [["core", core], ["postgres", postgres], ["network", network]] as const) {
      if (!resource) continue;
      try {
        await resource.stop();
        console.info(`canonical integration cleanup: ${kind} stopped`);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new Error(`Disposable integration cleanup failed: ${failures.map(String).join("; ")}`);
  }, 60_000);

  beforeEach(async () => {
    verificationLinks = new Map();
    const app = express();
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server!.address();
    if (!address || typeof address === "string") throw new Error("Missing disposable HTTP server");
    baseUrl = `http://localhost:${address.port}`;
    initialize("canonical");
    app.use(middleware());
    app.use(errorHandler());
  });

  afterEach(async () => {
    if (server) {
      const current = server;
      current.closeAllConnections();
      await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    resetSDK();
  });

  async function seed(mapped: boolean) {
    const email = `${randomUUID()}@example.com`;
    const result = await Passwordless.signInUp({ tenantId: "public", email });
    const internalId = result.user.id;
    const sdkId = mapped ? `rownd-${randomUUID()}` : internalId;
    if (mapped) expect(await SuperTokens.createUserIdMapping({ superTokensUserId: internalId, externalUserId: sdkId })).toMatchObject({ status: "OK" });
    const user = await SuperTokens.getUser(sdkId);
    if (!user) throw new Error("Seeded user missing from disposable Core");
    expect(user.id).toBe(sdkId);
    const method = user.loginMethods[0];
    if (!method) throw new Error("Seeded user has no login method");
    const original: RowndMetadata = {
      original_rownd_user: {
        data: { user_id: sdkId, first_name: "Original first", last_name: "Original last", deleted: "Do not resurrect", custom: { stale: true, nested: { old: true } } },
        state: "enabled", auth_level: "verified", verified_data: { custom: true },
        groups: [{ id: "synthetic-group" }], attributes: { synthetic: "preserved" },
      },
    };
    await UserMetadata.updateUserMetadata(sdkId, original);
    return { sdkId, internalId, email, user, original, recipeUserId: method.recipeUserId };
  }

  function request(path: string, { token, rid = "session", method = "POST", body }: {
    token?: string; rid?: string; method?: string; body?: object;
  }) {
    return fetch(`${baseUrl}/auth${path}`, {
      method, signal: AbortSignal.timeout(15_000),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        rid, "fdi-version": "1.18", "st-auth-mode": "header", "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function profileRequest(token: string, method = "GET", body?: object, suffix = "") {
    const response = await request(`/plugin/rownd/user${suffix}`, { token, method, body });
    const result = await response.json() as RowndCompatUserResponse;
    expect({ status: response.status, body: result }).toMatchObject({ status: 200 });
    return result;
  }

  async function sessionFrom(response: Response) {
    const token = response.headers.get("st-access-token");
    if (!token) throw new Error("Expected a real session in the response");
    return Session.getSessionWithoutRequestResponse(token);
  }

  async function startEmailChange(token: string, email: string, currentEmail: string) {
    expect(await profileRequest(token, "PUT", { data: { email } })).toMatchObject({
      status: "OK", email_verification_pending: true, data: { email: currentEmail },
    });
    const delivered = verificationLinks.get(email);
    if (!delivered) throw new Error("Expected a verification link for the requested email");
    const link = new URL(delivered);
    const pending = link.searchParams.get(PENDING_EMAIL_VERIFICATION_QUERY_PARAM);
    const verificationToken = link.searchParams.get("token");
    if (!pending || !verificationToken) throw new Error("Verification link is missing its pending ID or token");
    return async () => {
      const response = await request(`/user/email/verify?${PENDING_EMAIL_VERIFICATION_QUERY_PARAM}=${pending}`, {
        token, body: { method: "token", token: verificationToken },
      });
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { status: "OK" } });
      return sessionFrom(response);
    };
  }

  async function expectVerifiedEmail(userId: string, session: Awaited<ReturnType<typeof sessionFrom>>, email: string) {
    expect(session.getUserId()).toBe(userId);
    const recipeId = session.getRecipeUserId().getAsString();
    const user = await SuperTokens.getUser(recipeId);
    if (!user) throw new Error("Missing verified email method");
    expect(user.id).toBe(userId);
    const methods = user.loginMethods.filter((method) => method.recipeId === "passwordless" && method.tenantIds.includes("public"));
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ email, verified: true });
    expect(methods[0]?.recipeUserId.getAsString()).toBe(recipeId);
    expect(await OAuth2ProviderRaw.getInstanceOrThrowError().recipeInterfaceImpl.buildUserInfo({
      user, accessTokenPayload: { sub: userId }, scopes: ["email"], tenantId: "public", userContext: getUserContext(),
    }))
      .toMatchObject({ email, email_verified: true });
    const profile = await profileRequest(session.getAccessToken());
    expect(profile).toMatchObject({ data: { email }, verified_data: { email } });
    return profile;
  }

  it.each([false, true])("uses literal SDK metadata addresses without implicit aliasing (mapped=%s)", async (mapped) => {
    const fixture = await seed(mapped);
    if (mapped) await UserMetadata.updateUserMetadata(fixture.internalId, { address: "internal-only", first_name: "Stale internal" });
    await UserMetadata.updateUserMetadata(fixture.sdkId, { address: "sdk-only" });
    expect((await UserMetadata.getUserMetadata(fixture.sdkId)).metadata.address).toBe("sdk-only");
    if (mapped) expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata).toEqual({ address: "internal-only", first_name: "Stale internal" });
    for (const selector of new Set([fixture.sdkId, fixture.internalId])) {
      const inspected = await inspectUserPresentationMetadata(selector);
      expect(inspected.user?.id).toBe(fixture.sdkId);
      expect(inspected.combinedMetadata.address).toBe("sdk-only");
      expect(inspected.combinedMetadata.first_name).toBeUndefined();
    }
  });

  it.each([false, true])("persists deletion authority and top-level object replacement through the real SDK (mapped=%s)", async (mapped) => {
    const fixture = await seed(mapped);
    await UserMetadata.updateUserMetadata(fixture.sdkId, { first_name: "Live first", custom: { removed: true, nested: { old: true } } });
    const result = await updateUserPresentationMetadata(fixture.internalId, { first_name: null, custom: { replacement: { retained_null: null } } });
    expect(result.sdkUserId).toBe(fixture.sdkId);
    const stored = (await UserMetadata.getUserMetadata(fixture.sdkId)).metadata;
    expect(stored).not.toHaveProperty("first_name");
    expect(stored.custom).toEqual({ replacement: { retained_null: null } });
    expect(stored[`${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`]).toBe(true);
    expect(stored[`${ROWND_PROFILE_AUTHORITY_PREFIX}custom`]).toBe(true);
    expect(getRowndProfileData(stored)).toEqual({ user_id: fixture.sdkId, last_name: "Original last", deleted: "Do not resurrect", custom: { replacement: { retained_null: null } } });
    expect((await getUserById(fixture.sdkId)).data).not.toHaveProperty("first_name");
    await updateUserPresentationMetadata(fixture.sdkId, { custom: {} });
    expect((await UserMetadata.getUserMetadata(fixture.sdkId)).metadata.custom).toEqual({});
    await updateUserPresentationMetadata(fixture.sdkId, { custom: null });
    expect((await getUserById(fixture.sdkId)).data).not.toHaveProperty("custom");
  });

  it.each([false, true])("projects canonical public and authenticated profile writes without stale fallback (mapped=%s)", async (mapped) => {
    const fixture = await seed(mapped);
    if (mapped) await UserMetadata.updateUserMetadata(fixture.internalId, { first_name: "Stale internal", preference: "internal" });
    await updateUserMetadata(fixture.internalId, { preference: { removed: true }, last_active: null });
    const publicResult = await updateUserMetadata(fixture.sdkId, { preference: {} });
    expect(publicResult).toEqual({ id: fixture.sdkId, meta: { preference: {} } });
    await updateUserMetadata(fixture.sdkId, { preference: null });
    expect((await updateUserMetadata(fixture.sdkId, {})).meta).not.toHaveProperty("preference");
    const updated = await updateUserData(fixture.internalId, { first_name: "Repository edit" });
    expect(updated.data.first_name).toBe("Repository edit");
    const session = await Session.createNewSessionWithoutRequestResponse("public", fixture.recipeUserId, {}, {}, true);
    const token = session.getAccessToken();
    const response = await profileRequest(token, "PUT", { data: { first_name: null, custom: { endpoint: { value: null } } } });
    expect(response.data).not.toHaveProperty("first_name");
    expect(response.data.custom).toEqual({ endpoint: { value: null } });
    expect(response.meta).toMatchObject({ last_active: null, last_sign_in: null, last_sign_in_method: null });
    expect(await profileRequest(token)).toEqual(response);
    await profileRequest(token, "PUT", { meta: { preference: { endpoint: true }, last_active: null } }, "/meta");
    const stored = (await UserMetadata.getUserMetadata(fixture.sdkId)).metadata;
    expect(stored.preference).toEqual({ endpoint: true });
    expect(stored).not.toHaveProperty("last_active");
    expect(stored[`${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`]).toBe(true);
    for (const projection of [response.data, response.meta, await buildRowndSessionClaims(fixture.sdkId, { rownd_session_authentication: "authenticated" })]) {
      expect(Object.keys(projection).some((key) => key.startsWith(ROWND_PROFILE_AUTHORITY_PREFIX))).toBe(false);
    }
    if (mapped) expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata).toEqual({ first_name: "Stale internal", preference: "internal" });
  });

  it.each([false, true])("retains both field markers under concurrent real Core merges (mapped=%s)", async (mapped) => {
    for (let round = 0; round < 8; round++) {
      const fixture = await seed(mapped);
      await UserMetadata.updateUserMetadata(fixture.sdkId, { first_name: "Live first", last_name: "Live last" });
      const patches = [{ first_name: null }, { last_name: `Concurrent ${round}` }];
      if (round % 2) patches.reverse();
      await Promise.all(patches.map((patch) => updateUserPresentationMetadata(fixture.internalId, patch)));
      const stored = (await UserMetadata.getUserMetadata(fixture.sdkId)).metadata;
      expect(new Set(getAuthoritativeProfileFields(stored))).toEqual(new Set(["first_name", "last_name"]));
      expect(stored[`${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`]).toBe(true);
      expect(stored[`${ROWND_PROFILE_AUTHORITY_PREFIX}last_name`]).toBe(true);
      expect(stored).not.toHaveProperty("first_name");
      expect(stored.last_name).toBe(`Concurrent ${round}`);
      const profile = await getUserById(fixture.sdkId);
      expect(profile.data).not.toHaveProperty("first_name");
      expect(profile.data.last_name).toBe(`Concurrent ${round}`);
    }
  });

  it.each([false, true])("preserves compatibility profile/configured-claim parity after full publication (mapped=%s)", async (mapped) => {
    const fixture = await seed(mapped);
    const primary: RowndMetadata = {
      first_name: "Current first", custom: { replacement: { nested_null: null } }, public_array: ["synthetic", { null: null }],
      rownd_profile_authoritative_fields: ["deleted", "custom"],
      rownd_email_metadata_version: 1, rownd_email_recipe_user_ids: { public: fixture.recipeUserId.getAsString() },
      rownd_migration_complete: true,
      ...(mapped ? {} : fixture.original),
    };
    await UserMetadata.updateUserMetadata(fixture.internalId, primary);
    if (mapped) await UserMetadata.updateUserMetadata(fixture.sdkId, { alias_only: "Preserved alias value" });
    configure("compatibility");
    const inspection = await inspectLinkedUserMetadata(fixture.sdkId);
    const expectedProfile = await getUserById(fixture.sdkId);
    const expectedConfiguredClaims = buildConfiguredSessionClaims(inspection.combinedMetadata, getPluginConfig());
    const expectedSessionClaims = await buildRowndSessionClaims(fixture.sdkId, { rownd_session_authentication: "authenticated" });
    const publication = getCanonicalPresentationMetadata(inspection.combinedMetadata);
    expect(publication.custom).toEqual({ replacement: { nested_null: null } });
    expect(publication).not.toHaveProperty("rownd_migration_complete");
    await UserMetadata.updateUserMetadata(fixture.sdkId, publication);
    configure("canonical");
    const canonical = await inspectUserPresentationMetadata(fixture.internalId);
    expect(await getUserById(fixture.sdkId)).toEqual(expectedProfile);
    expect(buildConfiguredSessionClaims(canonical.combinedMetadata, getPluginConfig())).toEqual(expectedConfiguredClaims);
    expect(await buildRowndSessionClaims(fixture.sdkId, { rownd_session_authentication: "authenticated" })).toEqual(expectedSessionClaims);
    expect(expectedProfile.data).not.toHaveProperty("deleted");
    expect(expectedConfiguredClaims).not.toHaveProperty("deleted");
    expect(expectedConfiguredClaims.custom_claim).toEqual({ replacement: { nested_null: null } });
  });

  it.each([undefined, "compatibility"] as const)("preserves existing mapped resolver/writer addresses in mode %s", async (mode) => {
    initialize(mode);
    expect(getPluginConfig()?.metadataMode).toBe("compatibility");
    const fixture = await seed(true);
    await UserMetadata.updateUserMetadata(fixture.internalId, { first_name: "Internal legacy", preference: "internal" });
    await UserMetadata.updateUserMetadata(fixture.sdkId, { preference: "external" });
    expect((await inspectUserPresentationMetadata(fixture.sdkId)).combinedMetadata.preference).toBe("internal");
    await updateUserData(fixture.sdkId, { first_name: "Compatibility edit" });
    await updateUserMetadata(fixture.sdkId, { preference: "Compatibility preference" });
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata).toMatchObject({ first_name: "Compatibility edit", preference: "Compatibility preference" });
    expect((await UserMetadata.getUserMetadata(fixture.sdkId)).metadata.preference).toBe("external");
    expect((await UserMetadata.getUserMetadata(fixture.sdkId)).metadata).not.toHaveProperty("first_name");
  });

  it.each(["variant", "email"] as const)("preserves verified email and variants with the %s PUT paused after reading metadata", async (delayed) => {
    const fixture = await seed(false);
    const original = fixture.original.original_rownd_user!;
    await UserMetadata.updateUserMetadata(fixture.sdkId, {
      original_rownd_user: {
        ...original,
        data: { ...original.data, email: fixture.email },
        verified_data: { ...original.verified_data, email: fixture.email },
        attributes: { ...original.attributes, "rownd:app_variants": ["existing"] },
      },
    });
    const session = await Session.createNewSessionWithoutRequestResponse("public", fixture.recipeUserId, {}, {}, true);
    const email = `${randomUUID()}@example.com`;
    const verify = await startEmailChange(session.getAccessToken(), email, fixture.email);
    const variantContext = {};
    const addVariant = () => recordRowndAppVariantForUser(fixture.sdkId, "added", variantContext);
    let reachedPut!: () => void;
    let resumePut!: () => void;
    const atPut = new Promise<void>((resolve) => { reachedPut = resolve; });
    const resume = new Promise<void>((resolve) => { resumePut = resolve; });
    const realUpdate = UserMetadata.updateUserMetadata.bind(UserMetadata);
    const spy = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, patch, context) => {
      const isDelayedPut = delayed === "variant" ? context === variantContext :
        (patch.original_rownd_user as RowndMetadata["original_rownd_user"])?.data.email === email &&
        !Object.prototype.hasOwnProperty.call(patch, "rownd_pending_verification");
      if (id === fixture.sdkId && isDelayedPut) {
        reachedPut();
        await resume;
      }
      return realUpdate(id, patch, context);
    });

    const first = delayed === "variant" ? addVariant() : verify();
    let verifiedSession;
    try {
      await Promise.race([atPut, first.then(() => { throw new Error(`${delayed} completed without hitting the pause`); })]);
      if (delayed === "variant") verifiedSession = await verify();
      else await addVariant();
    } finally {
      resumePut();
      try {
        const result = await first;
        if (result) verifiedSession = result;
      } finally {
        spy.mockRestore();
      }
    }

    if (!verifiedSession) throw new Error("Missing replacement session");
    const profile = await expectVerifiedEmail(fixture.sdkId, verifiedSession, email);
    expect(profile.attributes?.["rownd:app_variants"]).toEqual(["existing", "added"]);
    expect((await UserMetadata.getUserMetadata(fixture.sdkId)).metadata).toMatchObject({
      [ROWND_APP_VARIANTS_KEY]: { public: ["existing", "added"] },
      original_rownd_user: {
        data: { email }, verified_data: { email },
        attributes: { synthetic: "preserved", "rownd:app_variants": ["existing"] },
      },
      rownd_pending_verification: [],
    });
  });

  it("explicitly adds and replaces verified email on an existing provider account in canonical mode", async () => {
    blockNonLoopbackRequests();
    const providerId = randomUUID();
    const providerEmail = `${randomUUID()}@example.com`;
    const provider = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", providerId, providerEmail, true);
    if (provider.status !== "OK") throw new Error(`Provider seed failed: ${provider.status}`);
    const userId = provider.user.id;
    await UserMetadata.updateUserMetadata(userId, {
      original_rownd_user: { data: { user_id: userId, email: providerEmail }, verified_data: { email: providerEmail } },
    });
    const originalSession = await Session.createNewSessionWithoutRequestResponse("public", provider.recipeUserId, {}, {}, true);
    const firstEmail = `${randomUUID()}@example.com`;
    const verifyAdd = await startEmailChange(originalSession.getAccessToken(), firstEmail, providerEmail);
    const added = await verifyAdd();
    await expectVerifiedEmail(userId, added, firstEmail);
    expect(await Session.getSessionInformation(originalSession.getHandle())).toBeUndefined();

    const newEmail = `${randomUUID()}@example.com`;
    const verifyReplacement = await startEmailChange(added.getAccessToken(), newEmail, firstEmail);
    const replaced = await verifyReplacement();
    await expectVerifiedEmail(userId, replaced, newEmail);
    expect(await Session.getSessionInformation(added.getHandle())).toBeUndefined();
    expect(await SuperTokens.listUsersByAccountInfo("public", { email: firstEmail }, true)).toEqual([]);
    expect((await SuperTokens.getUser(userId))?.loginMethods).toContainEqual(expect.objectContaining({
      email: providerEmail, verified: true, thirdParty: { id: "google", userId: providerId },
    }));
  });

  async function consumePasswordlessCode(email: string, token?: string) {
    const code = await Passwordless.createCode({ tenantId: "public", email });
    return request("/signinup/code/consume", {
      token, rid: "passwordless",
      body: { preAuthSessionId: code.preAuthSessionId, linkCode: code.linkCode },
    });
  }

  it.each([
    ["canonical", "passwordless"], ["compatibility", "passwordless"],
    ["canonical", "provider"], ["compatibility", "provider"],
  ] as const)("applies %s guest linking policy to an existing %s donor", async (mode, method) => {
    if (method === "provider") blockNonLoopbackRequests();
    initialize(mode);
    const guestResponse = await request("/plugin/rownd/guest", { body: { auth_level: "guest" } });
    expect({ status: guestResponse.status, body: await guestResponse.json() }).toMatchObject({ status: 200, body: { status: "OK" } });
    const guest = await sessionFrom(guestResponse);
    const guestId = guest.getUserId();
    const email = `${randomUUID()}@example.com`;
    const providerId = randomUUID();
    const donor = method === "passwordless"
      ? await Passwordless.signInUp({ tenantId: "public", email, userContext: { rowndDisableAutomaticAccountLinking: true } })
      : await ThirdParty.manuallyCreateOrUpdateUser("public", OFFLINE_PROVIDER_ID, providerId, email, true, undefined, { rowndDisableAutomaticAccountLinking: true });
    if (donor.status !== "OK" || !("user" in donor)) throw new Error(`Donor seed failed: ${donor.status}`);
    const donorId = donor.recipeUserId.getAsString();
    expect(await SuperTokens.getUser(donorId)).toMatchObject({ id: donorId, isPrimaryUser: false });
    await UserMetadata.updateUserMetadata(donorId, { preference: "donor-owned" });

    // FDI 1.18 attempts linking with a session but can fall back to standalone sign-in.
    const token = guest.getAccessToken();
    const response = method === "passwordless" ? await consumePasswordlessCode(email, token) :
      await request("/signinup", {
        token, rid: "thirdparty",
        body: { thirdPartyId: OFFLINE_PROVIDER_ID, oAuthTokens: { thirdPartyUserId: providerId, email } },
      });
    const expectedOwner = mode === "canonical" ? donorId : guestId;
    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 200, body: { status: "OK", createdNewRecipeUser: false, user: { id: expectedOwner } },
    });
    expect(await SuperTokens.getUser(donorId)).toMatchObject({ id: expectedOwner, isPrimaryUser: mode === "compatibility" });
    expect((await SuperTokens.getUser(guestId))?.loginMethods).toHaveLength(mode === "canonical" ? 1 : 2);
    expect((await UserMetadata.getUserMetadata(donorId)).metadata).toMatchObject({ preference: "donor-owned" });
    if (mode === "canonical") expect((await sessionFrom(response)).getUserId()).toBe(donorId);
  });

  it.each(["canonical", "compatibility"] as const)("characterizes historical-email passwordless sign-in in %s mode", async (mode) => {
    initialize(mode);
    const email = `${randomUUID()}@example.com`;
    const historical = await ThirdParty.manuallyCreateOrUpdateUser("public", "apple", randomUUID(), email, false);
    if (historical.status !== "OK") throw new Error(`Historical owner seed failed: ${historical.status}`);
    const ownerId = historical.user.id;
    await UserMetadata.updateUserMetadata(ownerId, {
      first_sign_in: "2026-04-09T16:12:35.600Z",
      original_rownd_user: { data: { user_id: ownerId, email } },
    });

    const response = await consumePasswordlessCode(email);
    const body = await response.json();
    if (mode === "canonical") {
      expect({ status: response.status, body }).toEqual({
        status: 200, body: { status: "SIGN_IN_UP_NOT_ALLOWED", reason: "No existing account found" },
      });
      expect(response.headers.get("st-access-token")).toBeNull();
    } else {
      expect({ status: response.status, body }).toMatchObject({ status: 200, body: { status: "OK", createdNewRecipeUser: true } });
      expect((await sessionFrom(response)).getUserId()).toBe(ownerId);
    }
    expect(await SuperTokens.listUsersByAccountInfo("public", { email }, true)).toEqual([
      expect.objectContaining({ id: ownerId, loginMethods: expect.any(Array) }),
    ]);
    expect((await SuperTokens.getUser(ownerId))?.loginMethods).toHaveLength(mode === "canonical" ? 1 : 2);
  });
});
