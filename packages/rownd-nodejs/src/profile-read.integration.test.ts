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
    return { userId, email, sessions, latestCreated: new Date(latest.timeCreated).toISOString() };
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

    const response = await getProfile(fixture.sessions[0].getAccessToken());

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
    const legacy = await getProfile(fixture.sessions[0].getAccessToken());
    expect(legacy.status).toBe(200);
    const expected = await legacy.json();
    delete expected.meta.last_sign_in;
    delete expected.meta.last_active;
    delete expected.meta.last_sign_in_method;
    const list = vi.spyOn(Session, "getAllSessionHandlesForUser");
    const detail = vi.spyOn(Session, "getSessionInformation");

    const response = await getProfile(fixture.sessions[0].getAccessToken(), "?profile=lightweight-v1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(list).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });

  it.each(["", "?profile=unknown", "?profile=lightweight-v2", "?profile=Lightweight-v1", "?profile="])(
    "retains legacy activity unless the exact capability is requested (%s)", async (query) => {
      const fixture = await seed(1);
      const list = vi.spyOn(Session, "getAllSessionHandlesForUser");

      const response = await getProfile(fixture.sessions[0].getAccessToken(), query);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ meta: {
        last_sign_in: fixture.latestCreated, last_active: fixture.latestCreated, last_sign_in_method: "email",
      } });
      expect(list).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])("preserves tenant identity and profile parity (mapped=%s)", async (mapped) => {
    const tenantId = `tenant-${randomUUID()}`;
    const fixture = await seed(2, mapped, tenantId);
    const token = fixture.sessions[0].getAccessToken();
    const legacy = await getProfile(token);
    expect(legacy.status).toBe(200);
    const expected = await legacy.json();
    expect(expected).toMatchObject({
      rownd_user: fixture.userId, data: { user_id: fixture.userId, email: fixture.email },
      verified_data: { email: fixture.email },
    });
    delete expected.meta.last_sign_in;
    delete expected.meta.last_active;
    delete expected.meta.last_sign_in_method;
    const list = vi.spyOn(Session, "getAllSessionHandlesForUser");
    const detail = vi.spyOn(Session, "getSessionInformation");

    const response = await getProfile(token, "?profile=lightweight-v1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(list).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });

  it.each(["", "?profile=lightweight-v1"])("rejects a revoked token after a successful read (%s)", async (query) => {
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
});
