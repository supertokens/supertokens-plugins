import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import Passwordless from "supertokens-node/recipe/passwordless";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import { middleware, errorHandler } from "supertokens-node/framework/express";
import { ProcessState } from "supertokens-node/lib/build/processState";
import { Querier } from "supertokens-node/lib/build/querier";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import PasswordlessRaw from "supertokens-node/lib/build/recipe/passwordless/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import EmailVerificationRaw from "supertokens-node/lib/build/recipe/emailverification/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import { GenericContainer, Network, Wait } from "testcontainers";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { init } from "./plugin";

function resetSDK() {
  ProcessState.getInstance().reset();
  SessionRaw.reset();
  PasswordlessRaw.reset();
  UserMetadataRaw.reset();
  UserRolesRaw.reset();
  AccountLinkingRaw.reset();
  EmailVerificationRaw.reset();
  MultitenancyRaw.reset();
  SuperTokensRaw.reset();
  Querier.reset();
}

describe("profile reads through authenticated middleware", { timeout: 30_000 }, () => {
  let network: StartedNetwork | undefined;
  let postgres: StartedTestContainer | undefined;
  let core: StartedTestContainer | undefined;
  let server: Server | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    network = await new Network().start();
    postgres = await new GenericContainer("postgres:14")
      .withNetwork(network).withNetworkAliases("postgres")
      .withEnvironment({ POSTGRES_USER: "supertokens", POSTGRES_PASSWORD: "somepassword", POSTGRES_DB: "supertokens" })
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections")).start();
    core = await new GenericContainer("supertokens/supertokens-postgresql")
      .withNetwork(network)
      .withEnvironment({ POSTGRESQL_CONNECTION_URI: "postgresql://supertokens:somepassword@postgres:5432/supertokens" })
      .withExposedPorts(3567).withWaitStrategy(Wait.forHttp("/hello", 3567)).start();
    const license = await fetch(`http://${core.getHost()}:${core.getMappedPort(3567)}/ee/license`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V" }),
    });
    expect({ status: license.status, body: await license.text() }).toMatchObject({ status: 200 });
  }, 120_000);

  afterAll(async () => {
    await core?.stop();
    await postgres?.stop();
    await network?.stop();
  });

  beforeEach(async () => {
    resetSDK();
    const app = express();
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string" || !core) throw new Error("Missing integration server");
    baseUrl = `http://localhost:${address.port}`;
    SuperTokens.init({
      supertokens: { connectionURI: `http://${core.getHost()}:${core.getMappedPort(3567)}` },
      appInfo: { appName: "Profile read regression", apiDomain: baseUrl, websiteDomain: "http://localhost:3000" },
      recipeList: [Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" })],
      experimental: { plugins: [init({ disableRowndUserMigration: true })] },
    });
    app.use(middleware());
    app.use(errorHandler());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    resetSDK();
  });

  async function seed(sessionCount: number, mapped = false, tenantId = "public") {
    const email = `${randomUUID()}@example.com`;
    if (tenantId !== "public") {
      expect(await Multitenancy.createOrUpdateTenant(tenantId)).toMatchObject({ status: "OK" });
    }
    const result = await Passwordless.signInUp({ tenantId, email });
    const userId = mapped ? `rownd-${randomUUID()}` : result.user.id;
    if (mapped) {
      expect(await SuperTokens.createUserIdMapping({ superTokensUserId: result.user.id, externalUserId: userId }))
        .toMatchObject({ status: "OK" });
    }
    await UserMetadata.updateUserMetadata(result.user.id, {
      first_name: "Profile", preference: "preserved",
      last_sign_in: "2000-01-01T00:00:00.000Z", last_active: "2000-01-01T00:00:00.000Z", last_sign_in_method: "stale",
    });
    if (mapped) {
      await UserMetadata.updateUserMetadata(userId, {
        last_sign_in: "1999-01-01T00:00:00.000Z", last_active: "1999-01-01T00:00:00.000Z", last_sign_in_method: "alias-stale",
        original_rownd_user: { meta: { last_sign_in: "1998-01-01T00:00:00.000Z", last_active: "1998-01-01T00:00:00.000Z", last_sign_in_method: "original-stale" } },
      });
    }
    const user = await SuperTokens.getUser(userId);
    if (!user) throw new Error("Seeded user is missing from Core");
    const sessions = [];
    for (let index = 0; index < sessionCount; index++) {
      sessions.push(await Session.createNewSessionWithoutRequestResponse(tenantId, user.loginMethods[0].recipeUserId, {}, {}, true));
    }
    const latest = await Session.getSessionInformation(sessions[sessions.length - 1].getHandle());
    if (!latest) throw new Error("Seeded session is missing from Core");
    return { userId, internalId: result.user.id, email, sessions, latestCreated: new Date(latest.timeCreated).toISOString() };
  }

  function getProfile(accessToken: string, query = "") {
    return fetch(`${baseUrl}/auth/plugin/rownd/user${query}`, {
      headers: { Authorization: `Bearer ${accessToken}`, rid: "session", "fdi-version": "1.18", "st-auth-mode": "header" },
    });
  }

  it.each([1, 5, 20])("keeps legacy newest-session activity with %i active sessions", async (count) => {
    const fixture = await seed(count);
    const list = vi.spyOn(Session, "getAllSessionHandlesForUser");
    const detail = vi.spyOn(Session, "getSessionInformation");

    const response = await getProfile(fixture.sessions[0].getAccessToken(), "?include_activity=true");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "OK", rownd_user: fixture.userId,
      data: { user_id: fixture.userId, email: fixture.email, first_name: "Profile" },
      verified_data: { email: fixture.email }, auth_level: "verified", state: "enabled",
      meta: { preference: "preserved", last_sign_in: fixture.latestCreated, last_active: fixture.latestCreated, last_sign_in_method: "email" },
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(count);
  });

  it.each([false, true].flatMap((mapped) => [1, 5, 20].map((count) => ({ mapped, count }))))(
    "preserves profile parity without session scans (mapped=$mapped, sessions=$count)", async ({ mapped, count }) => {
    const fixture = await seed(count, mapped);
    const legacy = await getProfile(fixture.sessions[0].getAccessToken(), "?include_activity=true");
    expect(legacy.status).toBe(200);
    const expected = await legacy.json();
    expected.meta.last_sign_in = null;
    expected.meta.last_active = null;
    expected.meta.last_sign_in_method = null;
    const list = vi.spyOn(Session, "getAllSessionHandlesForUser");
    const detail = vi.spyOn(Session, "getSessionInformation");

    const response = await getProfile(fixture.sessions[0].getAccessToken());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(list).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });

  it.each(["", "?include_activity=false", "?include_activity=unknown", "?include_activity=True", "?include_activity=1", "?profile=lightweight-v1", "?profile=legacy"]
    .flatMap((query) => [1, 5, 20].map((count) => ({ query, count }))))(
    "returns null activity without scans unless explicitly requested (query=$query, sessions=$count)", async ({ query, count }) => {
      const fixture = await seed(count);
      const list = vi.spyOn(Session, "getAllSessionHandlesForUser");
      const detail = vi.spyOn(Session, "getSessionInformation");

      const response = await getProfile(fixture.sessions[0].getAccessToken(), query);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ meta: {
        last_sign_in: null, last_active: null, last_sign_in_method: null,
      } });
      expect(list).not.toHaveBeenCalled();
      expect(detail).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("preserves tenant identity and profile parity (mapped=%s)", async (mapped) => {
    const tenantId = `tenant-${randomUUID()}`;
    const fixture = await seed(2, mapped, tenantId);
    const token = fixture.sessions[0].getAccessToken();
    const legacy = await getProfile(token, "?include_activity=true");
    expect(legacy.status).toBe(200);
    const expected = await legacy.json();
    expect(expected).toMatchObject({
      rownd_user: fixture.userId, data: { user_id: fixture.userId, email: fixture.email },
      verified_data: { email: fixture.email },
    });
    expected.meta.last_sign_in = null;
    expected.meta.last_active = null;
    expected.meta.last_sign_in_method = null;
    const list = vi.spyOn(Session, "getAllSessionHandlesForUser");
    const detail = vi.spyOn(Session, "getSessionInformation");

    const response = await getProfile(token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(list).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });

  it.each(["", "?include_activity=true"])("rejects a revoked token after a successful read (%s)", async (query) => {
    const fixture = await seed(2);
    const token = fixture.sessions[0].getAccessToken();
    expect((await getProfile(token, query)).status).toBe(200);
    await Session.revokeSession(fixture.sessions[0].getHandle());
    const list = vi.spyOn(Session, "getAllSessionHandlesForUser");
    const repository = await import("./supertokens-repository");
    const assemble = vi.spyOn(repository, "getUserById");

    const response = await getProfile(token, query);

    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
    expect((await getProfile(fixture.sessions[1].getAccessToken(), query)).status).toBe(200);
  });

  function putProfile(accessToken: string, suffix: string, body: object) {
    return fetch(`${baseUrl}/auth/plugin/rownd/user${suffix}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, rid: "session", "fdi-version": "1.18", "st-auth-mode": "header", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it.each([false, true])("returns null activity after profile mutation without scans (mapped=%s)", async (mapped) => {
    const fixture = await seed(5, mapped);
    const list = vi.spyOn(Session, "getAllSessionHandlesForUser");
    const detail = vi.spyOn(Session, "getSessionInformation");

    const response = await putProfile(fixture.sessions[0].getAccessToken(), "", { data: { first_name: "Updated" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "OK", data: { user_id: fixture.userId, first_name: "Updated" },
      meta: { last_sign_in: null, last_active: null, last_sign_in_method: null },
    });
    expect(list).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });

  it.each([false, true])("ignores Hub null activity placeholders without deleting stored activity (mapped=%s)", async (mapped) => {
    const fixture = await seed(5, mapped);
    const token = fixture.sessions[0].getAccessToken();
    const profile = await getProfile(token);
    expect(profile.status).toBe(200);
    const { meta } = await profile.json();
    expect(meta).toMatchObject({ last_sign_in: null, last_active: null, last_sign_in_method: null });
    const before = await UserMetadata.getUserMetadata(fixture.internalId);
    const aliasBefore = mapped ? await UserMetadata.getUserMetadata(fixture.userId) : undefined;
    const list = vi.spyOn(Session, "getAllSessionHandlesForUser");
    const detail = vi.spyOn(Session, "getSessionInformation");

    const response = await putProfile(token, "/meta", { meta: { ...meta, preference: "updated" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "OK", meta: { preference: "updated" } });
    expect(list).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
    const after = await UserMetadata.getUserMetadata(fixture.internalId);
    for (const key of ["last_sign_in", "last_active", "last_sign_in_method"]) {
      expect(after.metadata[key]).toEqual(before.metadata[key]);
    }
    if (aliasBefore) {
      const aliasAfter = await UserMetadata.getUserMetadata(fixture.userId);
      for (const key of ["last_sign_in", "last_active", "last_sign_in_method"]) {
        expect(aliasAfter.metadata[key]).toEqual(aliasBefore.metadata[key]);
      }
    }
    const enriched = await getProfile(token, "?include_activity=true");
    expect(enriched.status).toBe(200);
    expect(await enriched.json()).toMatchObject({ meta: {
      preference: "updated", last_sign_in: fixture.latestCreated, last_active: fixture.latestCreated, last_sign_in_method: "email",
    } });
  });
});
