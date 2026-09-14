import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import Session from "supertokens-node/recipe/session";
import EmailVerification from "supertokens-node/recipe/emailverification";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import { middleware, errorHandler } from "supertokens-node/framework/express";
import { ProcessState } from "supertokens-node/lib/build/processState";
import { Querier } from "supertokens-node/lib/build/querier";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import EmailVerificationRaw from "supertokens-node/lib/build/recipe/emailverification/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import PasswordlessRaw from "supertokens-node/lib/build/recipe/passwordless/recipe";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import ThirdPartyRaw from "supertokens-node/lib/build/recipe/thirdparty/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from "testcontainers";
import { init } from "./plugin";
import { reconcileUser } from "./reconcile-user";
import type { RowndUser } from "./types";

const rownd = { validateToken: vi.fn(), fetchUserInfo: vi.fn() };
vi.mock("@rownd/node", () => ({ createInstance: () => rownd }));

function resetST() {
  ProcessState.getInstance().reset();
  SessionRaw.reset();
  UserMetadataRaw.reset();
  UserRolesRaw.reset();
  AccountLinkingRaw.reset();
  PasswordlessRaw.reset();
  ThirdPartyRaw.reset();
  EmailVerificationRaw.reset();
  MultitenancyRaw.reset();
  SuperTokensRaw.reset();
  Querier.reset();
}

describe("administrative reconciliation with concurrent native sessions", { timeout: 60000, sequential: true }, () => {
  let network: StartedNetwork;
  let postgres: StartedTestContainer;
  let core: StartedTestContainer;
  let server: Server;
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
    expect((await fetch(`http://${core.getHost()}:${core.getMappedPort(3567)}/ee/license`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V" }),
    })).ok).toBe(true);
  }, 120000);

  afterAll(async () => {
    try { await core?.stop(); } finally {
      try { await postgres?.stop(); } finally { await network?.stop(); }
    }
  });

  async function start() {
    const app = express();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://localhost:${address.port}`;
    SuperTokens.init({
      supertokens: { connectionURI: `http://${core.getHost()}:${core.getMappedPort(3567)}` },
      appInfo: { appName: "Admin donor sessions", apiDomain: baseUrl, websiteDomain: "http://localhost:3000" },
      recipeList: [AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
        Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }), ThirdParty.init()],
      experimental: { plugins: [init({ rowndAppKey: "test-key", rowndAppSecret: "test-secret" })] },
    });
    app.use(middleware());
    app.post("/native", async (req, res) => {
      try {
        await Session.createNewSession(req, res, "public", SuperTokens.convertToRecipeUserId(req.header("x-recipe-id")!));
        res.json({ status: "OK" });
      } catch (error) {
        res.status(409).json({ status: "ERROR", message: error instanceof Error ? error.message : "Failed" });
      }
    });
    app.use(errorHandler());
  }

  beforeEach(async () => { resetST(); vi.resetAllMocks(); await start(); });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    vi.restoreAllMocks();
    resetST();
  });

  async function seed() {
    const alias = `rownd-${randomUUID()}`;
    const email = `${randomUUID()}@example.com`;
    const subject = randomUUID();
    const target = await Passwordless.signInUp({ tenantId: "public", email });
    expect(await AccountLinking.createPrimaryUser(target.recipeUserId)).toMatchObject({ status: "OK" });
    expect(await SuperTokens.createUserIdMapping({ superTokensUserId: target.recipeUserId.getAsString(), externalUserId: alias, force: true })).toMatchObject({ status: "OK" });
    const original: RowndUser = { state: "enabled", auth_level: "verified", data: { user_id: alias, email }, verified_data: { email: true } };
    await UserMetadata.updateUserMetadata(target.recipeUserId.getAsString(), { original_rownd_user: original, rownd_migration_complete: true });
    const current = { ...original, data: { ...original.data, google_id: subject }, verified_data: { email: true, google_id: subject } };
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => user_id === alias ? structuredClone(current) : undefined);
    rownd.validateToken.mockResolvedValue({ user_id: alias });
    const donor = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", subject, `${randomUUID()}@example.com`, false);
    if (donor.status !== "OK") throw new Error("Failed to seed donor");
    return { alias, targetId: target.recipeUserId.getAsString(), donorId: donor.recipeUserId.getAsString(), donor, current,
      run: () => reconcileUser({ rownd_user_id: alias }) };
  }

  it("keeps pre-mapping access and refresh credentials authenticatable for a native primary owner", async () => {
    const alias = `rownd-${randomUUID()}`;
    const target = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@example.com` });
    const nativeId = target.recipeUserId.getAsString();
    expect(await AccountLinking.createPrimaryUser(target.recipeUserId)).toMatchObject({ status: "OK" });
    await UserMetadata.updateUserMetadata(nativeId, { literalOwner: "native" });
    await UserMetadata.updateUserMetadata(alias, { literalOwner: "rownd" });
    const issued = await Session.createNewSessionWithoutRequestResponse("public", target.recipeUserId, { applicationUserId: nativeId });
    const tokens = issued.getAllSessionTokensDangerously();
    expect(issued.getUserId()).toBe(nativeId);
    expect(tokens.refreshToken !== undefined).toBe(true);
    for (const checkDatabase of [false, true]) {
      const verified = await Session.getSessionWithoutRequestResponse(tokens.accessToken, undefined, { checkDatabase, antiCsrfCheck: false });
      expect(verified.getUserId()).toBe(nativeId);
    }

    expect(await SuperTokens.createUserIdMapping({ superTokensUserId: nativeId, externalUserId: alias, force: true })).toMatchObject({ status: "OK" });
    expect((await SuperTokens.getUser(nativeId))?.id).toBe(alias);
    expect((await SuperTokens.getUser(alias))?.id).toBe(alias);
    for (const checkDatabase of [false, true]) {
      const verified = await Session.getSessionWithoutRequestResponse(tokens.accessToken, undefined, { checkDatabase, antiCsrfCheck: false });
      expect(verified.getHandle()).toBe(issued.getHandle());
      expect(verified.getUserId()).toBe(nativeId);
      expect(verified.getRecipeUserId().getAsString()).toBe(nativeId);
      expect(verified.getAccessTokenPayload()).toMatchObject({ sub: nativeId, applicationUserId: nativeId });
    }
    const refreshed = await Session.refreshSessionWithoutRequestResponse(tokens.refreshToken!, true);
    expect(refreshed.getHandle()).toBe(issued.getHandle());
    // Refresh resolves the current primary mapping; existing JWTs retain their issued subject.
    expect(refreshed.getUserId()).toBe(alias);
    expect(refreshed.getRecipeUserId().getAsString()).toBe(nativeId);
    for (const checkDatabase of [false, true]) {
      const verified = await Session.getSessionWithoutRequestResponse(refreshed.getAccessToken(), undefined, { checkDatabase, antiCsrfCheck: false });
      expect(verified.getUserId()).toBe(alias);
      expect(verified.getAccessTokenPayload()).toMatchObject({ sub: alias, applicationUserId: nativeId });
    }
    // EmailVerification's claim builder matches the current (mapped) recipe ID literally.
    await expect(Session.createNewSessionWithoutRequestResponse("public", target.recipeUserId)).rejects.toThrow("UNKNOWN_USER_ID");
    const fresh = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(alias));
    expect(fresh.getUserId()).toBe(alias);
    expect((await UserMetadata.getUserMetadata(nativeId)).metadata).toEqual({ literalOwner: "native" });
    expect((await UserMetadata.getUserMetadata(alias)).metadata).toEqual({ literalOwner: "rownd" });
  });

  it("publishes a fresh mapping while the native owner has an active session", async () => {
    const alias = `rownd-${randomUUID()}`;
    const email = `${randomUUID()}@example.com`;
    const target = await Passwordless.signInUp({ tenantId: "public", email });
    const session = await Session.createNewSessionWithoutRequestResponse("public", target.recipeUserId);
    const tokens = session.getAllSessionTokensDangerously();
    const profile: RowndUser = { state: "enabled", auth_level: "verified", data: { user_id: alias, email }, verified_data: { email: true } };
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => user_id === alias ? structuredClone(profile) : undefined);
    const mapping = vi.spyOn(SuperTokens, "createUserIdMapping");
    const scan = vi.spyOn(Session, "getAllSessionHandlesForUser");
    const revoke = vi.spyOn(Session, "revokeAllSessionsForUser");
    expect(await reconcileUser({ rownd_user_id: alias })).toMatchObject({ status: "OK" });
    expect(mapping).toHaveBeenCalledWith(expect.objectContaining({ superTokensUserId: target.recipeUserId.getAsString(), externalUserId: alias, force: true }));
    expect(scan).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
    for (const checkDatabase of [false, true]) {
      const verified = await Session.getSessionWithoutRequestResponse(tokens.accessToken, undefined, { checkDatabase, antiCsrfCheck: false });
      expect(verified.getUserId()).toBe(target.recipeUserId.getAsString());
    }
    const refreshed = await Session.refreshSessionWithoutRequestResponse(tokens.refreshToken!, true);
    expect(refreshed.getUserId()).toBe(alias);
    expect(refreshed.getHandle()).toBe(session.getHandle());
    const verified = await Session.getSessionWithoutRequestResponse(refreshed.getAccessToken(), undefined, { checkDatabase: true, antiCsrfCheck: false });
    expect(verified.getUserId()).toBe(alias);
  });

  it.each(["malformed", { version: 1, status: "RESERVED", sourceId: "foreign", target: "missing" }, { version: 1, status: "COMPLETE" }])(
    "ignores legacy donor metadata during preview, linking, and native issuance: %j", async (legacy) => {
      const fixture = await seed();
      for (const id of [fixture.targetId, fixture.donorId, fixture.alias]) await UserMetadata.updateUserMetadata(id, { rownd_migration_admin_donor_sessions: legacy });
      const session = await Session.createNewSessionWithoutRequestResponse("public", fixture.donor.recipeUserId);
      expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
      const scan = vi.spyOn(Session, "getAllSessionHandlesForUser");
      const revoke = vi.spyOn(Session, "revokeAllSessionsForUser");
      expect(await reconcileUser({ rownd_user_id: fixture.alias, dryRun: true })).toMatchObject({ status: "PREVIEW" });
      expect(await fixture.run()).toMatchObject({ status: "OK" });
      expect(scan).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect((await SuperTokens.getUser(fixture.donorId))?.id).toBe(fixture.alias);
      expect((await UserMetadata.getUserMetadata(fixture.targetId)).metadata.rownd_migration_admin_donor_sessions).toEqual(legacy);
      const native = await fetch(`${baseUrl}/native`, { method: "POST", headers: { "x-recipe-id": fixture.donorId } });
      expect(await native.json()).toMatchObject({ status: "OK" });
    },
  );

  it.each([false, true])("recovers already-linked provider introductions with active sessions (per-recipe-only=%s)", async (perRecipeOnly) => {
    const fixture = await seed();
    expect(await AccountLinking.linkAccounts(fixture.donor.recipeUserId, fixture.alias)).toMatchObject({ status: "OK" });
    const session = await Session.createNewSessionWithoutRequestResponse("public", fixture.donor.recipeUserId);
    const introduction = { rowndUserId: fixture.alias, internalUserId: fixture.targetId, recipeUserId: fixture.donorId,
      provider: "google", subject: fixture.current.data.google_id, tenantId: "public", created: false };
    if (!perRecipeOnly) await UserMetadata.updateUserMetadata(fixture.targetId, { rownd_migration_provider_introductions: [introduction] });
    await UserMetadata.updateUserMetadata(fixture.donorId, { rownd_migration_provider_introduction: introduction });
    expect(await fixture.run()).toMatchObject({ status: "OK" });
    expect((await UserMetadata.getUserMetadata(fixture.donorId)).metadata.rownd_migration_provider_introduction).toBeUndefined();
    expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
  });

  it("repairs obsolete providers even when every current method is already linked", async () => {
    const fixture = await seed();
    expect(await AccountLinking.linkAccounts(fixture.donor.recipeUserId, fixture.alias)).toMatchObject({ status: "OK" });
    const old = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", randomUUID(), `${randomUUID()}@example.com`, false);
    if (old.status !== "OK") throw new Error("Failed to seed old provider");
    expect(await AccountLinking.linkAccounts(old.recipeUserId, fixture.alias)).toMatchObject({ status: "OK" });
    await UserMetadata.updateUserMetadata(fixture.targetId, { original_rownd_user: { ...fixture.current,
      data: { ...fixture.current.data, google_id: old.user.thirdParty[0]!.userId },
      verified_data: { email: true, google_id: old.user.thirdParty[0]!.userId } } });
    expect(await fixture.run()).toMatchObject({ status: "OK" });
    expect(await SuperTokens.getUser(old.recipeUserId.getAsString())).toBeUndefined();
    expect((await SuperTokens.getUser(fixture.alias))?.loginMethods.some((method) => method.thirdParty?.userId === fixture.current.data.google_id)).toBe(true);
  });

  it("does not enforce completed snapshot identities on native session issuance", async () => {
    const fixture = await seed();
    await UserMetadata.updateUserMetadata(fixture.targetId, { rownd_migration_owner_consolidation: { version: 2, status: "COMPLETE", completion: "old snapshot" },
      rownd_migration_provider_retirements: "obsolete malformed guard data" });
    expect(await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.alias))).toBeDefined();
    expect(await (await fetch(`${baseUrl}/native`, { method: "POST", headers: { "x-recipe-id": fixture.alias } })).json()).toMatchObject({ status: "OK" });
  });

  it("uses the completed /migrate mapping without contact discovery while admin still repairs it", async () => {
    const fixture = await seed();
    const search = vi.spyOn(SuperTokens, "listUsersByAccountInfo");
    const link = vi.spyOn(AccountLinking, "linkAccounts");
    const response = await fetch(`${baseUrl}/auth/plugin/rownd/migrate`, {
      method: "POST", headers: { Authorization: "Bearer fixture-token", "st-auth-mode": "header", rid: "session", "fdi-version": "1.18" },
    });
    expect(await response.json()).toMatchObject({ status: "OK" });
    expect(search).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    const session = await Session.getSessionWithoutRequestResponse(response.headers.get("st-access-token")!);
    expect(session.getUserId()).toBe(fixture.alias);
    expect(session.getTenantId()).toBe("public");
    expect(await fixture.run()).toMatchObject({ status: "OK" });
    expect((await SuperTokens.getUser(fixture.donorId))?.id).toBe(fixture.alias);
  });

  it("does not reconcile /migrate for retirement history confined to another tenant", async () => {
    const engine = vi.spyOn(await import("./supertokens-repository"), "reconcileRowndUserWithExistingLoginMethods");
    const fixture = await seed();
    const tenantId = `other-${randomUUID()}`;
    expect(await Multitenancy.createOrUpdateTenant(tenantId, { firstFactors: ["thirdparty"] })).toMatchObject({ status: "OK" });
    const oldSubject = randomUUID();
    const old = await ThirdParty.manuallyCreateOrUpdateUser(tenantId, "google", oldSubject, `${randomUUID()}@example.com`, false);
    if (old.status !== "OK") throw new Error("Failed to seed other-tenant provider");
    expect(await AccountLinking.linkAccounts(old.recipeUserId, fixture.alias)).toMatchObject({ status: "OK" });
    await UserMetadata.updateUserMetadata(fixture.targetId, { rownd_migration_provider_retirements: [{ rowndUserId: fixture.alias,
      recipeUserId: old.recipeUserId.getAsString(), provider: "google", subject: oldSubject, pendingTenantIds: [tenantId] }] });
    const search = vi.spyOn(SuperTokens, "listUsersByAccountInfo");
    const link = vi.spyOn(AccountLinking, "linkAccounts");
    const response = await fetch(`${baseUrl}/auth/plugin/rownd/migrate`, {
      method: "POST", headers: { Authorization: "Bearer fixture-token", "st-auth-mode": "header", rid: "session", "fdi-version": "1.18" },
    });
    expect(await response.json()).toMatchObject({ status: "OK" });
    expect(engine).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    const session = await Session.getSessionWithoutRequestResponse(response.headers.get("st-access-token")!);
    expect(session.getTenantId()).toBe("public");
  });

  it.each(["rownd_migration_provider_introduction", "rownd_migration_provider_introductions"])("recovers a lost %s cleanup response after SDK restart", async (field) => {
    const fixture = await seed();
    expect(await AccountLinking.linkAccounts(fixture.donor.recipeUserId, fixture.alias)).toMatchObject({ status: "OK" });
    const introduction = { rowndUserId: fixture.alias, internalUserId: fixture.targetId, recipeUserId: fixture.donorId,
      provider: "google", subject: fixture.current.data.google_id, tenantId: "public", created: false };
    await UserMetadata.updateUserMetadata(fixture.targetId, { rownd_migration_provider_introductions: [introduction] });
    await UserMetadata.updateUserMetadata(fixture.donorId, { rownd_migration_provider_introduction: introduction });
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    let interrupted = false;
    const spy = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
      const result = await update(...args);
      if (!interrupted && (args[1][field] === null || Array.isArray(args[1][field]) && args[1][field].length === 0)) {
        interrupted = true;
        throw new Error("Lost cleanup response");
      }
      return result;
    });
    expect(await fixture.run()).toMatchObject({ status: "ERROR" });
    expect(interrupted).toBe(true);
    spy.mockRestore();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetST();
    await start();
    expect(await fixture.run()).toMatchObject({ status: "OK" });
    expect((await UserMetadata.getUserMetadata(fixture.donorId)).metadata.rownd_migration_provider_introduction).toBeUndefined();
    expect((await UserMetadata.getUserMetadata(fixture.targetId)).metadata.rownd_migration_provider_introductions).toEqual([]);
  });
});
