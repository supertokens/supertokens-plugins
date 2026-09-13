import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import { middleware, errorHandler } from "supertokens-node/framework/express";
import { ProcessState } from "supertokens-node/lib/build/processState";
import { Querier } from "supertokens-node/lib/build/querier";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import EmailPasswordRaw from "supertokens-node/lib/build/recipe/emailpassword/recipe";
import EmailVerificationRaw from "supertokens-node/lib/build/recipe/emailverification/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import PasswordlessRaw from "supertokens-node/lib/build/recipe/passwordless/recipe";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import ThirdPartyRaw from "supertokens-node/lib/build/recipe/thirdparty/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import { GenericContainer, Network, Wait } from "testcontainers";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { init } from "./plugin";
import { getCombinedUserMetadata, mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { importUser, prepareEmailForPasswordlessAuth, reconcileRowndUserWithExistingLoginMethods } from "./supertokens-repository";
import type { RowndUser } from "./types";
import { associateUserLoginMethodsToTenant } from "./pluginImplementation";
import { validateCurrentRowndEmailReconciliation } from "./migration-email";

const rownd = { validateToken: vi.fn(), fetchUserInfo: vi.fn() };
vi.mock("@rownd/node", () => ({ createInstance: () => rownd }));

function resetST() {
  ProcessState.getInstance().reset();
  SessionRaw.reset();
  UserMetadataRaw.reset();
  UserRolesRaw.reset();
  AccountLinkingRaw.reset();
  EmailPasswordRaw.reset();
  PasswordlessRaw.reset();
  ThirdPartyRaw.reset();
  EmailVerificationRaw.reset();
  MultitenancyRaw.reset();
  SuperTokensRaw.reset();
  Querier.reset();
}

describe("completed Apple relay migration reconciles current Rownd email", () => {
  let network: StartedNetwork;
  let postgres: StartedTestContainer;
  let core: StartedTestContainer;
  let server: Server;
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
    const response = await fetch(`http://${core.getHost()}:${core.getMappedPort(3567)}/ee/license`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V" }),
    });
    expect(response.ok).toBe(true);
  }, 120000);

  afterAll(async () => { await core?.stop(); await postgres?.stop(); await network?.stop(); });
  async function startServer() {
    const app = express();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://localhost:${address.port}`;
    SuperTokens.init({
      supertokens: { connectionURI: `http://${core.getHost()}:${core.getMappedPort(3567)}` },
      appInfo: { appName: "Current email migration", apiDomain: baseUrl, websiteDomain: "http://localhost:3000" },
      recipeList: [
        AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
        Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }), ThirdParty.init(),
      ],
      experimental: { plugins: [init({ rowndAppKey: "test-key", rowndAppSecret: "test-secret" })] },
    });
    app.use(middleware());
    app.use(errorHandler());
  }
  beforeEach(async () => {
    resetST();
    vi.resetAllMocks();
    await startServer();
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetST();
    vi.restoreAllMocks();
  });

  async function seed(standalone = false) {
    const rowndId = `rownd-${randomUUID()}`;
    const appleId = `001826.${randomUUID()}`;
    const relayEmail = `${randomUUID()}@privaterelay.appleid.com`;
    const email = `${randomUUID()}@example.com`;
    const original: RowndUser = {
      state: "enabled", auth_level: "verified",
      data: { user_id: rowndId, apple_id: appleId, email: relayEmail },
      verified_data: { apple_id: appleId, email: relayEmail },
    };
    const appleImport = mapRowndUserToSuperTokens(original, "public").loginMethods[0];
    if (appleImport.recipeId !== "thirdparty") throw new Error("Missing Apple fixture");
    const apple = await ThirdParty.manuallyCreateOrUpdateUser("public", "apple", appleId, appleImport.email, false);
    if (apple.status !== "OK") throw new Error("Failed to seed Apple");
    const internalId = apple.recipeUserId.getAsString();
    await SuperTokens.createUserIdMapping({ superTokensUserId: internalId, externalUserId: rowndId });
    await AccountLinking.createPrimaryUser(apple.recipeUserId);
    const relay = await Passwordless.signInUp({ tenantId: "public", email: relayEmail });
    await AccountLinking.linkAccounts(relay.recipeUserId, internalId);
    await UserMetadata.updateUserMetadata(internalId, { rownd_migration_complete: true, original_rownd_user: original, preference: "preserved" });
    const current: RowndUser = { ...original, data: { ...original.data, email }, verified_data: { apple_id: appleId, email } };
    rownd.validateToken.mockResolvedValue({ user_id: rowndId });
    rownd.fetchUserInfo.mockResolvedValue(current);
    const separate = standalone ? await Passwordless.signInUp({ tenantId: "public", email }) : undefined;
    return { rowndId, internalId, appleId, fakeEmail: appleImport.email, relayEmail, relayId: relay.recipeUserId.getAsString(), email, current, original, separate };
  }

  async function migrate(fixture: Awaited<ReturnType<typeof seed>>) {
    const response = await fetch(`${baseUrl}/auth/plugin/rownd/migrate`, {
      method: "POST", headers: { Authorization: "Bearer fixture-token", "st-auth-mode": "header", rid: "session", "fdi-version": "1.18" },
    });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { status: "OK" } });
    const session = await Session.getSessionWithoutRequestResponse(response.headers.get("st-access-token")!);
    expect(session.getUserId()).toBe(fixture.rowndId);
    const profile = await fetch(`${baseUrl}/auth/plugin/rownd/user`, {
      headers: { Authorization: `Bearer ${response.headers.get("st-access-token")}`, rid: "session", "fdi-version": "1.18" },
    });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({
      status: "OK", rownd_user: fixture.rowndId,
      data: { email: fixture.email }, verified_data: { email: fixture.email },
    });
  }

  async function expectCanonical(fixture: Awaited<ReturnType<typeof seed>>, extraMethods = 0) {
    const user = await SuperTokens.getUser(fixture.rowndId);
    const target = user!.loginMethods.find((method) => method.recipeId === "passwordless" && method.email === fixture.email)!;
    expect(target).toBeDefined();
    expect(target.verified).toBe(true);
    const { metadata } = await UserMetadata.getUserMetadata(fixture.internalId);
    expect(metadata).toMatchObject({ preference: "preserved", rownd_email_recipe_user_ids: { public: target.recipeUserId.getAsString() } });
    expect(user!.loginMethods).toHaveLength(2 + extraMethods);
    expect(user!.loginMethods.find((method) => method.thirdParty?.id === "apple")).toMatchObject({ email: fixture.fakeEmail, verified: false });
    expect((await SuperTokens.getUserIdMapping({ userId: fixture.rowndId, userIdType: "EXTERNAL" }))).toMatchObject({ superTokensUserId: fixture.internalId });
    return target;
  }

  it.each([false, true])("publishes current email on original primary and retires relay (standalone=%s)", async (standalone) => {
    const fixture = await seed(standalone);
    const oldSession = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.relayId));
    await migrate(fixture);
    expect(await Session.getSessionInformation(oldSession.getHandle())).toBeUndefined();
    const target = await expectCanonical(fixture);
    if (fixture.separate) expect(target.recipeUserId.getAsString()).toBe(fixture.separate.recipeUserId.getAsString());
    await migrate(fixture);
    await expectCanonical(fixture);
    const code = await Passwordless.createCode({ tenantId: "public", email: fixture.email });
    const response = await fetch(`${baseUrl}/auth/signinup/code/consume`, {
      method: "POST", headers: { "Content-Type": "application/json", "st-auth-mode": "header", rid: "passwordless", "fdi-version": "1.18" },
      body: JSON.stringify({ preAuthSessionId: code.preAuthSessionId, linkCode: code.linkCode }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "OK", user: { id: fixture.rowndId } });
    const session = await Session.getSessionWithoutRequestResponse(response.headers.get("st-access-token")!);
    expect(session.getUserId()).toBe(fixture.rowndId);
  });

  it("resumes canonical publication after linking committed but metadata storage failed", async () => {
    const fixture = await seed(true);
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    const writes = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, metadata, context) => {
      if (metadata.rownd_email_recipe_user_ids) throw new Error("Injected canonical metadata failure");
      return update(id, metadata, context);
    });
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).rejects.toThrow("Injected canonical metadata failure");
    expect((await SuperTokens.getUser(fixture.separate!.recipeUserId.getAsString()))?.id).toBe(fixture.rowndId);
    expect((await SuperTokens.getUser(fixture.rowndId))?.loginMethods).toHaveLength(3);
    const interruptedMetadata = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    expect(interruptedMetadata).toMatchObject({
      original_rownd_user: { data: { email: fixture.relayEmail } },
      rownd_migration_email_retirements: { public: { source: { previousEmail: fixture.relayEmail }, retiredMethods: [{ recipeUserId: fixture.relayId, email: fixture.relayEmail }] } },
    });
    writes.mockRestore();
    await migrate(fixture);
    await expectCanonical(fixture);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_migration_email_retirements).not.toHaveProperty("public");
  });

  it.each(["checkpoint", "finalization"])("retains retryable state when retirement %s storage fails", async (phase) => {
    const fixture = await seed(true);
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    const writes = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, metadata, context) => {
      const checkpoints = metadata.rownd_migration_email_retirements as any;
      if (checkpoints && (phase === "checkpoint" ? !metadata.rownd_email_recipe_user_ids : !Object.hasOwn(checkpoints, "public"))) {
        throw new Error(`Injected ${phase} storage failure`);
      }
      return update(id, metadata, context);
    });
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).rejects.toThrow(`Injected ${phase} storage failure`);
    const metadata = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    if (phase === "checkpoint") {
      expect(metadata.rownd_email_recipe_user_ids).toBeUndefined();
      expect(metadata.rownd_migration_email_retirements).toBeUndefined();
      expect((await SuperTokens.getUser(fixture.rowndId))!.loginMethods).toHaveLength(3);
    } else {
      expect(metadata.rownd_pending_verification).toHaveLength(1);
      expect(metadata.rownd_migration_email_retirements).toHaveProperty("public");
      expect(await SuperTokens.getUser(fixture.relayId)).toBeUndefined();
    }
    writes.mockRestore();
    await migrate(fixture);
    await expectCanonical(fixture);
    const completed = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    expect(completed.rownd_pending_verification).toEqual([]);
    expect(completed.rownd_migration_email_retirements).not.toHaveProperty("public");
  });

  it("keeps retirement checkpoints primary-only and excludes them from public metadata and writes", async () => {
    const fixture = await seed();
    const checkpoint = { public: { evidence: "private-checkpoint" } };
    await UserMetadata.updateUserMetadata(fixture.relayId, { rownd_migration_email_retirements: checkpoint });
    expect(await getCombinedUserMetadata(fixture.rowndId)).not.toHaveProperty("rownd_migration_email_retirements");
    expect(mapRowndUserToSuperTokens({ ...fixture.original, meta: { rownd_migration_email_retirements: checkpoint } }, "public").userMetadata)
      .not.toHaveProperty("rownd_migration_email_retirements");
    await UserMetadata.updateUserMetadata(fixture.internalId, { rownd_migration_email_retirements: checkpoint });
    const session = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.relayId));
    const headers = { Authorization: `Bearer ${session.getAccessToken()}`, rid: "session", "fdi-version": "1.18", "Content-Type": "application/json" };
    for (const path of ["user", "user/meta"]) {
      const response = await fetch(`${baseUrl}/auth/plugin/rownd/${path}`, { headers });
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain("rownd_migration_email_retirements");
    }
    const response = await fetch(`${baseUrl}/auth/plugin/rownd/user/meta`, {
      method: "PUT", headers, body: JSON.stringify({ meta: { rownd_migration_email_retirements: {} } }),
    });
    expect(response.status).toBe(403);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_migration_email_retirements).toEqual(checkpoint);
  });

  it("does not freeze an unchanged Rownd email before a later verified change", async () => {
    const fixture = await seed();
    rownd.fetchUserInfo.mockResolvedValue(fixture.original);
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.original, "public"), "public", {})).resolves.toBe(true);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_email_recipe_user_ids).toBeUndefined();
    rownd.fetchUserInfo.mockResolvedValue(fixture.current);
    await migrate(fixture);
    await expectCanonical(fixture);
  });

  it("withholds canonical publication and retirement when source changes after linking", async () => {
    const fixture = await seed(true);
    const changed = structuredClone(fixture.current);
    changed.data.email = `${randomUUID()}@example.com`;
    rownd.fetchUserInfo.mockResolvedValueOnce(fixture.current).mockResolvedValue(changed);
    const deletion = vi.spyOn(SuperTokens, "deleteUser");
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).rejects.toThrow("identity changed");
    expect((await SuperTokens.getUser(fixture.separate!.recipeUserId.getAsString()))!.id).toBe(fixture.rowndId);
    expect((await SuperTokens.getUser(fixture.rowndId))!.loginMethods).toHaveLength(3);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_email_recipe_user_ids).toBeUndefined();
    expect(deletion).not.toHaveBeenCalled();
    rownd.fetchUserInfo.mockResolvedValue(fixture.current);
    await migrate(fixture);
    await expectCanonical(fixture);
  });

  it("preserves exact synthetic Passwordless and Apple records while retiring the snapshot relay", async () => {
    const fixture = await seed();
    const synthetic = await Passwordless.signInUp({ tenantId: "public", email: fixture.fakeEmail });
    await AccountLinking.linkAccounts(synthetic.recipeUserId, fixture.internalId);
    await UserMetadata.updateUserMetadata(synthetic.recipeUserId.getAsString(), { syntheticPreference: "keep" });
    const before = (await SuperTokens.getUser(synthetic.recipeUserId.getAsString()))!.loginMethods
      .find((method) => method.recipeUserId.getAsString() === synthetic.recipeUserId.getAsString())!.toJson();
    await migrate(fixture);
    await expectCanonical(fixture, 1);
    const user = await SuperTokens.getUser(synthetic.recipeUserId.getAsString());
    expect(user!.loginMethods.find((method) => method.recipeUserId.getAsString() === synthetic.recipeUserId.getAsString())!.toJson()).toEqual(before);
    expect((await UserMetadata.getUserMetadata(synthetic.recipeUserId.getAsString())).metadata).toEqual({ syntheticPreference: "keep" });
    await migrate(fixture);
    await expectCanonical(fixture, 1);
  });

  it.each(["native canonical", "pending", "committing"])("preserves deliberate %s email state", async (state) => {
    const fixture = await seed(true);
    const metadata = {
      ...(await UserMetadata.getUserMetadata(fixture.internalId)).metadata,
      ...(state === "native canonical" ? { rownd_email_recipe_user_ids: { public: fixture.relayId } } : {
        rownd_pending_verification: [{
          id: "native-email-change", field: "email", value: fixture.relayEmail,
          tenantId: "public", created_at: new Date().toISOString(), purpose: "UPDATE_PASSWORDLESS",
          status: state === "committing" ? "COMMITTING" : "PENDING",
          ...(state === "committing" ? { targetCanonicalRecipeUserId: fixture.relayId, retiredMethods: [] } : {}),
        }],
      }),
    };
    await UserMetadata.updateUserMetadata(fixture.internalId, metadata);
    const ownerBefore = (await SuperTokens.getUser(fixture.separate!.recipeUserId.getAsString()))!.toJson();
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).resolves.toBe(true);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata).toEqual(metadata);
    expect((await SuperTokens.getUser(fixture.separate!.recipeUserId.getAsString()))!.toJson()).toEqual(ownerBefore);
  });

  it.each(["missing", "false", "stale"])("trusts authenticated current email with %s verification data and instant auth", async (verification) => {
    const fixture = await seed(true);
    fixture.current.auth_level = "instant";
    fixture.current.verified_data = verification === "missing" ? {} : {
      email: verification === "false" ? false : fixture.relayEmail,
    };
    rownd.fetchUserInfo.mockResolvedValue(fixture.current);
    expect(mapRowndUserToSuperTokens(fixture.current, "public").loginMethods.find(
      (method) => method.recipeId === "passwordless" && method.email === fixture.email,
    )).toMatchObject({ isVerified: false });
    await migrate(fixture);
    await expectCanonical(fixture);
    await migrate(fixture);
    await expectCanonical(fixture);
  });

  it("resumes authenticated email cleanup from its independent checkpoint after restart with stale verification flags", async () => {
    const fixture = await seed(true);
    fixture.current.auth_level = "instant";
    fixture.current.verified_data = {};
    const removal = vi.spyOn(Multitenancy, "disassociateUserFromTenant").mockRejectedValueOnce(new Error("Pause authenticated cleanup"));
    const interrupted = await fetch(`${baseUrl}/auth/plugin/rownd/migrate`, {
      method: "POST", headers: { Authorization: "Bearer fixture-token", "st-auth-mode": "header", rid: "session", "fdi-version": "1.18" },
    });
    expect(interrupted.status).toBe(400);
    expect(interrupted.headers.get("st-access-token")).toBeNull();
    removal.mockRestore();
    const metadata = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    const snapshot = metadata.original_rownd_user as unknown as RowndUser;
    snapshot.auth_level = "instant";
    snapshot.verified_data = { email: fixture.relayEmail };
    await UserMetadata.updateUserMetadata(fixture.internalId, { original_rownd_user: snapshot });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetST();
    await startServer();
    rownd.fetchUserInfo.mockClear();
    await expect(prepareEmailForPasswordlessAuth({ email: fixture.email, tenantId: "public", reconcileTarget: true, userContext: {} })).resolves.toEqual({ status: "ALLOW" });
    expect(rownd.fetchUserInfo).not.toHaveBeenCalled();
    await expectCanonical(fixture);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_pending_verification).toEqual([]);
  });

  it.each(["stale data", "missing verified subject"])("reconciles current email with %s", async (state) => {
    const fixture = await seed(true);
    if (state === "stale data") fixture.current.data.apple_id = randomUUID();
    else delete fixture.current.verified_data.apple_id;
    await migrate(fixture);
    await expectCanonical(fixture);
  });

  it.each([
    "changed email", "disabled source", "changed provider", "changed verified provider",
    "wrong user", "absent", "source error", "foreign primary", "ambiguous first-party", "unknown synthetic",
  ])("rejects %s before changing credentials or metadata", async (failure) => {
    const fixture = await seed(true);
    if (failure === "foreign primary") await AccountLinking.createPrimaryUser(fixture.separate!.recipeUserId);
    if (failure === "ambiguous first-party" || failure === "unknown synthetic") {
      const extra = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@${failure === "unknown synthetic" ? "stfakeemail.supertokens.com" : "example.com"}` });
      await AccountLinking.linkAccounts(extra.recipeUserId, fixture.internalId);
    }
    const fresh = structuredClone(fixture.current);
    if (failure === "changed email") fresh.data.email = `${randomUUID()}@example.com`;
    if (failure === "disabled source") fresh.state = "disabled";
    if (failure === "changed provider") fresh.data.apple_id = fresh.verified_data.apple_id = randomUUID();
    if (failure === "changed verified provider") fresh.verified_data.apple_id = randomUUID();
    if (failure === "wrong user") fresh.data.user_id = randomUUID();
    rownd.fetchUserInfo.mockResolvedValue(failure === "absent" ? undefined : fresh);
    if (failure === "source error") rownd.fetchUserInfo.mockRejectedValue(new Error("Injected Rownd service error"));
    const snapshot = () => Promise.all([fixture.internalId, fixture.separate!.recipeUserId.getAsString()].map(async (id) => ({
      user: (await SuperTokens.getUser(id))!.toJson(), metadata: (await UserMetadata.getUserMetadata(id)).metadata,
    })));
    const before = await snapshot();
    const mutations = [
      vi.spyOn(AccountLinking, "linkAccounts"), vi.spyOn(Passwordless, "signInUp"),
      vi.spyOn(SuperTokens, "deleteUser"), vi.spyOn(SuperTokens, "deleteUserIdMapping"),
      vi.spyOn(UserMetadata, "updateUserMetadata"),
    ];
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).rejects.toThrow();
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("resumes durable retirement after tenant removal succeeds but orphan deletion fails", async () => {
    const fixture = await seed();
    const deletion = vi.spyOn(SuperTokens, "deleteUser").mockRejectedValueOnce(new Error("Injected retirement failure"));
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).rejects.toThrow("Injected retirement failure");
    const { metadata } = await UserMetadata.getUserMetadata(fixture.internalId);
    expect(metadata).toMatchObject({ rownd_pending_verification: [expect.objectContaining({ status: "COMMITTING" })] });
    deletion.mockRestore();
    await migrate(fixture);
    await expectCanonical(fixture);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_pending_verification).toEqual([]);
  });

  it("rejects coordinated plan changes that redirect retirement to an unrelated linked email", async () => {
    const fixture = await seed();
    const removal = vi.spyOn(Multitenancy, "disassociateUserFromTenant").mockRejectedValueOnce(new Error("Pause before retirement"));
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).rejects.toThrow("Pause before retirement");
    removal.mockRestore();
    const unrelatedEmail = `${randomUUID()}@native.example.com`;
    const unrelated = await Passwordless.signInUp({ tenantId: "public", email: unrelatedEmail });
    await AccountLinking.linkAccounts(unrelated.recipeUserId, fixture.internalId);
    const metadata = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    const checkpoint = structuredClone(metadata.rownd_migration_email_retirements);
    const plan = (metadata.rownd_pending_verification as any[])[0];
    plan.migrationSource.previousEmail = unrelatedEmail;
    plan.retiredMethods = [{ email: unrelatedEmail, recipeUserId: unrelated.recipeUserId.getAsString() }];
    await UserMetadata.updateUserMetadata(fixture.internalId, { rownd_pending_verification: [plan] });
    const before = (await SuperTokens.getUser(fixture.rowndId))!.toJson();
    const mutations = [
      vi.spyOn(SuperTokens, "deleteUser"), vi.spyOn(Multitenancy, "disassociateUserFromTenant"),
      vi.spyOn(Passwordless, "revokeAllCodes"), vi.spyOn(Session, "revokeAllSessionsForUser"),
      vi.spyOn(UserMetadata, "updateUserMetadata"),
    ];
    await expect(prepareEmailForPasswordlessAuth({ email: fixture.email, tenantId: "public", reconcileTarget: true, userContext: {} })).rejects.toThrow();
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(fixture.rowndId))!.toJson()).toEqual(before);
    const after = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    expect(after.rownd_migration_email_retirements).toEqual(checkpoint);
    expect(checkpoint).toMatchObject({ public: { retiredMethods: [{ recipeUserId: fixture.relayId, email: fixture.relayEmail }] } });
  });

  it.each([false, true])("uses the original snapshot verified provider over stale data (standalone=%s)", async (standalone) => {
    const fixture = await seed(standalone);
    await UserMetadata.updateUserMetadata(fixture.internalId, {
      original_rownd_user: { ...fixture.original, data: { ...fixture.original.data, apple_id: randomUUID() } },
    });
    await migrate(fixture);
    await expectCanonical(fixture);
  });

  it("repairs a completed real bulk import whose migration snapshot is stored under its Rownd alias", async () => {
    const rowndId = `rownd-${randomUUID()}`;
    const appleId = `001924.${randomUUID()}`;
    const relayEmail = `${randomUUID()}@privaterelay.appleid.com`;
    const email = `${randomUUID()}@example.com`;
    const original: RowndUser = {
      state: "enabled", auth_level: "verified", data: { user_id: rowndId, apple_id: appleId, email: relayEmail },
      verified_data: { apple_id: appleId, email: relayEmail },
    };
    await importUser(mapRowndUserToSuperTokens(original, "public"), {
      connectionURI: `http://${core.getHost()}:${core.getMappedPort(3567)}`,
    });
    const mapping = await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL" });
    if (mapping.status !== "OK") throw new Error("Missing imported mapping");
    const user = (await SuperTokens.getUser(rowndId))!;
    const current = { ...original, data: { ...original.data, email }, verified_data: { apple_id: appleId, email } };
    const fixture = {
      rowndId, appleId, relayEmail, email, current, original, separate: undefined,
      internalId: mapping.superTokensUserId,
      fakeEmail: user.loginMethods.find((method) => method.thirdParty?.id === "apple")!.email!,
      relayId: user.loginMethods.find((method) => method.email === relayEmail)!.recipeUserId.getAsString(),
    };
    await UserMetadata.updateUserMetadata(rowndId, { preference: "preserved" });
    rownd.validateToken.mockResolvedValue({ user_id: rowndId });
    rownd.fetchUserInfo.mockResolvedValue(current);
    await migrate(fixture);
    await expectCanonical(fixture);
  });

  it.each([false, true])("does not retire email when the snapshot verified provider differs from the account (standalone=%s)", async (standalone) => {
    const fixture = await seed(standalone);
    await UserMetadata.updateUserMetadata(fixture.internalId, {
      original_rownd_user: { ...fixture.original, verified_data: { ...fixture.original.verified_data, apple_id: randomUUID() } },
    });
    const destructive = [
      vi.spyOn(SuperTokens, "deleteUser"), vi.spyOn(Multitenancy, "disassociateUserFromTenant"),
      vi.spyOn(Passwordless, "revokeAllCodes"), vi.spyOn(Session, "revokeAllSessionsForUser"),
    ];
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).resolves.toBe(true);
    for (const mutation of destructive) expect(mutation).not.toHaveBeenCalled();
    const user = (await SuperTokens.getUser(fixture.rowndId))!;
    expect(user.loginMethods.some((method) => method.recipeUserId.getAsString() === fixture.relayId && method.email === fixture.relayEmail)).toBe(true);
    expect(user.loginMethods.some((method) => method.email === fixture.email && method.recipeId === "passwordless")).toBe(true);
    const { metadata } = await UserMetadata.getUserMetadata(fixture.internalId);
    expect(metadata.rownd_email_recipe_user_ids).toBeUndefined();
    expect(metadata.rownd_migration_email_retirements).toBeUndefined();
  });

  it.each([false, null])("resumes checkpointed cleanup before completion is published (%s)", async (completion) => {
    const fixture = await seed();
    const removal = vi.spyOn(Multitenancy, "disassociateUserFromTenant").mockRejectedValueOnce(new Error("Pause before retirement"));
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).rejects.toThrow("Pause before retirement");
    removal.mockRestore();
    await UserMetadata.updateUserMetadata(fixture.internalId, { rownd_migration_complete: completion });
    rownd.fetchUserInfo.mockClear();
    await expect(prepareEmailForPasswordlessAuth({ email: fixture.email, tenantId: "public", reconcileTarget: true, userContext: {} })).resolves.toEqual({ status: "ALLOW" });
    expect(rownd.fetchUserInfo).not.toHaveBeenCalled();
    await expectCanonical(fixture);
    const { metadata } = await UserMetadata.getUserMetadata(fixture.internalId);
    expect(metadata.rownd_pending_verification).toEqual([]);
    expect(metadata.rownd_migration_email_retirements).toEqual({});
    expect(metadata.rownd_migration_complete).not.toBe(true);
  });

  it("retries scoped migration retirement after restart, preserving synthetic records and native pending state", async () => {
    const fixture = await seed();
    const synthetic = await Passwordless.signInUp({ tenantId: "public", email: fixture.fakeEmail });
    await AccountLinking.linkAccounts(synthetic.recipeUserId, fixture.internalId);
    const deletion = vi.spyOn(SuperTokens, "deleteUser").mockRejectedValueOnce(new Error("Injected retirement failure"));
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).rejects.toThrow("Injected retirement failure");
    deletion.mockRestore();
    const metadata = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    const nativePending = { id: randomUUID(), field: "email", value: "native-pending@example.com", tenantId: "public", created_at: new Date().toISOString(), status: "PENDING", purpose: "UPDATE_PASSWORDLESS" };
    await UserMetadata.updateUserMetadata(fixture.internalId, {
      rownd_pending_verification: [...metadata.rownd_pending_verification as any[], nativePending],
    });
    const code = await Passwordless.createCode({ email: fixture.email, tenantId: "public" });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetST();
    await startServer();
    rownd.fetchUserInfo.mockClear();
    // Consumption validates COMMITTING state but leaves cleanup to a preparation
    // that can revoke old sessions before issuing replacement credentials.
    const consumed = await fetch(`${baseUrl}/auth/signinup/code/consume`, {
      method: "POST", headers: { "Content-Type": "application/json", "st-auth-mode": "header", rid: "passwordless", "fdi-version": "1.18" },
      body: JSON.stringify({ preAuthSessionId: code.preAuthSessionId, linkCode: code.linkCode }),
    });
    expect(await consumed.json()).toMatchObject({ status: "OK", user: { id: fixture.rowndId } });
    const session = await Session.getSessionWithoutRequestResponse(consumed.headers.get("st-access-token")!);
    expect(session.getUserId()).toBe(fixture.rowndId);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_pending_verification).toHaveLength(2);
    expect((await SuperTokens.getUser(synthetic.recipeUserId.getAsString()))!.loginMethods.some((method) => method.recipeUserId.getAsString() === synthetic.recipeUserId.getAsString())).toBe(true);
    await prepareEmailForPasswordlessAuth({ email: fixture.email, tenantId: "public", reconcileTarget: true, userContext: {} });
    expect(rownd.fetchUserInfo).not.toHaveBeenCalled();
    await expectCanonical(fixture, 1);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_pending_verification).toEqual([nativePending]);
    expect(await Session.getSessionInformation(session.getHandle())).toBeUndefined();
    await expect(prepareEmailForPasswordlessAuth({ email: fixture.email, tenantId: "public", reconcileTarget: true, userContext: {} })).resolves.toEqual({ status: "ALLOW" });
  });

  it.each([
    "missing provenance", "wrong source", "wrong provider", "wrong provider recipe", "unproven retired email",
    "wrong target email", "duplicate retired ID", "synthetic retired method", "missing canonical pointer",
    "changed snapshot email", "changed snapshot verified provider", "target lost tenant", "provider lost tenant", "retired ownership changed",
    "wrong plan tenant", "unverified target", "missing checkpoint", "secondary checkpoint only",
  ])("rejects a durable migration plan with %s without destructive mutation", async (failure) => {
    const fixture = await seed();
    const removal = vi.spyOn(Multitenancy, "disassociateUserFromTenant").mockRejectedValueOnce(new Error("Pause before retirement"));
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).rejects.toThrow("Pause before retirement");
    removal.mockRestore();
    const metadata = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    const plan = (metadata.rownd_pending_verification as any[])[0];
    if (failure === "missing checkpoint" || failure === "secondary checkpoint only") {
      if (failure === "secondary checkpoint only") {
        await UserMetadata.updateUserMetadata(fixture.relayId, { rownd_migration_email_retirements: metadata.rownd_migration_email_retirements });
      }
      await UserMetadata.updateUserMetadata(fixture.internalId, { rownd_migration_email_retirements: null });
      delete metadata.rownd_migration_email_retirements;
    }
    if (failure === "missing provenance") delete plan.migrationSource;
    if (failure === "wrong source") plan.migrationSource.rowndUserId = randomUUID();
    if (failure === "wrong provider") plan.migrationSource.providerUserId = randomUUID();
    if (failure === "wrong provider recipe") plan.migrationSource.providerRecipeUserId = fixture.relayId;
    if (failure === "unproven retired email") plan.retiredMethods[0].email = "not-the-snapshot@example.com";
    if (failure === "wrong target email") plan.value = fixture.relayEmail;
    if (failure === "duplicate retired ID") plan.retiredMethods.push(plan.retiredMethods[0]);
    if (failure === "synthetic retired method") {
      const synthetic = await Passwordless.signInUp({ tenantId: "public", email: fixture.fakeEmail });
      await AccountLinking.linkAccounts(synthetic.recipeUserId, fixture.internalId);
      plan.migrationSource.previousEmail = fixture.fakeEmail;
      plan.retiredMethods = [{ email: fixture.fakeEmail, recipeUserId: synthetic.recipeUserId.getAsString() }];
    }
    if (failure === "missing canonical pointer") metadata.rownd_email_recipe_user_ids = {};
    if (failure === "changed snapshot email") (metadata.original_rownd_user as any).data.email = `${randomUUID()}@example.com`;
    if (failure === "changed snapshot verified provider") (metadata.original_rownd_user as any).verified_data.apple_id = randomUUID();
    if (failure === "wrong plan tenant") plan.tenantId = `tenant-${randomUUID()}`;
    if (failure === "unverified target") await EmailVerification.unverifyEmail(SuperTokens.convertToRecipeUserId(plan.targetCanonicalRecipeUserId), fixture.email);
    if (failure === "target lost tenant") await Multitenancy.disassociateUserFromTenant("public", SuperTokens.convertToRecipeUserId(plan.targetCanonicalRecipeUserId));
    if (failure === "provider lost tenant") await Multitenancy.disassociateUserFromTenant("public", SuperTokens.convertToRecipeUserId(fixture.internalId));
    if (failure === "retired ownership changed") await AccountLinking.unlinkAccount(SuperTokens.convertToRecipeUserId(fixture.relayId));
    await UserMetadata.updateUserMetadata(fixture.internalId, metadata);
    const mutations = [
      vi.spyOn(SuperTokens, "deleteUser"), vi.spyOn(Multitenancy, "disassociateUserFromTenant"),
      vi.spyOn(Passwordless, "revokeAllCodes"), vi.spyOn(Session, "revokeAllSessionsForUser"),
      vi.spyOn(UserMetadata, "updateUserMetadata"),
    ];
    const preparation = failure === "target lost tenant" || failure === "wrong plan tenant"
      ? validateCurrentRowndEmailReconciliation({ internalUserId: fixture.internalId, plan, tenantId: "public", userContext: {} })
      : prepareEmailForPasswordlessAuth({ email: fixture.email, tenantId: "public", reconcileTarget: true, userContext: {} });
    await expect(preparation).rejects.toThrow();
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  });

  it.each(["no pointer", "other-tenant legacy pointer", "explicit pointer", "invalid legacy pointer", "invalid tenant pointer"])("associates provider and phone methods with %s while respecting tenant email choices", async (state) => {
    const fixture = await seed();
    const tenantId = `tenant-${randomUUID()}`;
    await Multitenancy.createOrUpdateTenant(tenantId, { firstFactors: ["link-email", "otp-phone", "thirdparty"] });
    const phone = await Passwordless.signInUp({ tenantId: "public", phoneNumber: `+1806${Math.floor(Math.random() * 9000000 + 1000000)}` });
    await AccountLinking.linkAccounts(phone.recipeUserId, fixture.internalId);
    const target = await Passwordless.signInUp({ tenantId, email: fixture.email });
    await AccountLinking.linkAccounts(target.recipeUserId, fixture.internalId);
    if (state === "explicit pointer") {
      await UserMetadata.updateUserMetadata(fixture.internalId, { rownd_email_recipe_user_ids: { [tenantId]: target.recipeUserId.getAsString() } });
    } else if (state === "other-tenant legacy pointer") {
      await UserMetadata.updateUserMetadata(fixture.internalId, { rownd_email_recipe_user_id: fixture.relayId });
    } else if (state === "invalid legacy pointer") {
      await UserMetadata.updateUserMetadata(fixture.internalId, { rownd_email_recipe_user_id: "missing-recipe-user" });
    } else if (state === "invalid tenant pointer") {
      await UserMetadata.updateUserMetadata(fixture.internalId, { rownd_email_recipe_user_ids: { [tenantId]: fixture.relayId } });
    }
    if (state.startsWith("invalid")) {
      const association = vi.spyOn(Multitenancy, "associateUserToTenant");
      await expect(associateUserLoginMethodsToTenant((await SuperTokens.getUser(fixture.rowndId))!, tenantId, {})).rejects.toThrow("Canonical passwordless email method is invalid");
      expect(association).not.toHaveBeenCalled();
      return;
    }
    await associateUserLoginMethodsToTenant((await SuperTokens.getUser(fixture.rowndId))!, tenantId, {});
    const user = (await SuperTokens.getUser(fixture.rowndId))!;
    expect(user.loginMethods.find((method) => method.thirdParty?.id === "apple")!.tenantIds).toContain(tenantId);
    expect(user.loginMethods.find((method) => method.phoneNumber)!.tenantIds).toContain(tenantId);
    const relay = user.loginMethods.find((method) => method.email === fixture.relayEmail)!;
    expect(relay.tenantIds.includes(tenantId)).toBe(state !== "explicit pointer");
  });

  it("does not link another tenant's current-email owner or remove its relay credential", async () => {
    const fixture = await seed();
    const tenantId = `tenant-${randomUUID()}`;
    await Multitenancy.createOrUpdateTenant(tenantId, { firstFactors: ["link-email"] });
    await Multitenancy.associateUserToTenant(tenantId, SuperTokens.convertToRecipeUserId(fixture.relayId));
    const otherTenantSession = await Session.createNewSessionWithoutRequestResponse(tenantId, SuperTokens.convertToRecipeUserId(fixture.relayId));
    const separate = await Passwordless.signInUp({ tenantId, email: fixture.email });
    const otherTenantCheckpoint = { evidence: "keep-other-tenant" };
    await UserMetadata.updateUserMetadata(fixture.internalId, {
      rownd_email_recipe_user_ids: { [tenantId]: fixture.relayId },
      rownd_migration_email_retirements: { [tenantId]: otherTenantCheckpoint },
    });
    const separateBefore = separate.user.toJson();
    await migrate(fixture);
    await expectCanonical(fixture, 1);
    expect((await SuperTokens.getUser(separate.recipeUserId.getAsString()))!.toJson()).toEqual(separateBefore);
    const relay = (await SuperTokens.getUser(fixture.relayId))!.loginMethods.find((method) => method.recipeUserId.getAsString() === fixture.relayId)!;
    expect(relay.tenantIds).toEqual([tenantId]);
    expect(await Session.getSessionInformation(otherTenantSession.getHandle())).toBeDefined();
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata).toMatchObject({ rownd_email_recipe_user_ids: { [tenantId]: fixture.relayId } });
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_migration_email_retirements).toEqual({ [tenantId]: otherTenantCheckpoint });
  });
});
