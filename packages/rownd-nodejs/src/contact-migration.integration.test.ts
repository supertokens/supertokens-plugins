import express from "express";
import { reconcileUser } from "./reconcile-user";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import Passwordless from "supertokens-node/recipe/passwordless";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
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
import { setRowndTokenValidator } from "./rownd-repository";
import { getCombinedUserMetadata, mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { reconcileRowndUserWithExistingLoginMethods } from "./supertokens-repository";
import type { RowndUser } from "./types";
import { authenticateRowndMigration, fetchAdministrativeMigrationSource } from "./migration-email";
import { bindAdministrativeElection, inspectAdministrativeElection } from "./migration-election";
import { assertMigrationMapping, retireDuplicateMapping } from "./migration-mapping";

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

describe("authenticated Rownd contact reconciliation", () => {
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
    expect({ status: response.status, body: await response.text() }).toMatchObject({ status: 200 });
  }, 120000);
  afterAll(async () => { await core?.stop(); await postgres?.stop(); await network?.stop(); });
  beforeEach(async () => {
    resetST();
    vi.resetAllMocks();
    const app = express();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://localhost:${address.port}`;
    SuperTokens.init({
      supertokens: { connectionURI: `http://${core.getHost()}:${core.getMappedPort(3567)}` },
      appInfo: { appName: "Contact migration", apiDomain: baseUrl, websiteDomain: "http://localhost:3000" },
      recipeList: [
        AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
        Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }), ThirdParty.init(),
      ],
      experimental: { plugins: [init({ rowndAppKey: "test-key", rowndAppSecret: "test-secret", rowndJwtAudience: "app:test-app" })] },
    });
    setRowndTokenValidator(rownd.validateToken);
    app.use(middleware());
    app.use(errorHandler());
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetST();
    vi.restoreAllMocks();
  });

  async function seed() {
    const a = `rownd-a-${randomUUID()}`;
    const b = `rownd-b-${randomUUID()}`;
    const googleId = `google-${randomUUID()}`;
    const email = `maja-${randomUUID()}@gmail.com`;
    const profileA: RowndUser = {
      state: "enabled", auth_level: "instant", data: { user_id: a, google_id: googleId, email }, verified_data: {},
    };
    const profileB: RowndUser = {
      state: "enabled", auth_level: "instant", data: { user_id: b, email }, verified_data: {},
    };
    const google = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", googleId, email, true);
    if (google.status !== "OK") throw new Error("Could not seed Google");
    const passwordless = await Passwordless.signInUp({ tenantId: "public", email, userContext: { rowndDisableAutomaticAccountLinking: true } });
    await EmailVerification.unverifyEmail(passwordless.recipeUserId, email);
    const internalA = google.recipeUserId.getAsString();
    const internalB = passwordless.recipeUserId.getAsString();
    expect((await SuperTokens.createUserIdMapping({ superTokensUserId: internalA, externalUserId: a })).status).toBe("OK");
    expect((await SuperTokens.createUserIdMapping({ superTokensUserId: internalB, externalUserId: b })).status).toBe("OK");
    expect((await SuperTokens.getUser(b))!.isPrimaryUser).toBe(false);
    await UserMetadata.updateUserMetadata(internalA, { original_rownd_user: profileA, preference: "A", dataA: { preserved: true } });
    await UserMetadata.updateUserMetadata(internalB, { original_rownd_user: profileB, preference: "B", dataB: { preserved: true } });
    await UserMetadata.updateUserMetadata(b, { aliasDataB: "preserved" });
    const profiles = new Map([[a, profileA], [b, profileB]]);
    rownd.validateToken.mockImplementation(async (token: string) => {
      if (!profiles.has(token)) throw new Error("Invalid fixture token");
      return { user_id: token };
    });
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => profiles.get(user_id));
    return { a, b, internalA, internalB, email, googleId, profiles, profileA, profileB };
  }

  async function migrate(token?: string) {
    return fetch(`${baseUrl}/auth/plugin/rownd/migrate`, {
      method: "POST", headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "st-auth-mode": "header", rid: "session", "fdi-version": "1.18",
      },
    });
  }

  async function expectSession(response: Response, rowndId: string) {
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { status: "OK" } });
    const session = await Session.getSessionWithoutRequestResponse(response.headers.get("st-access-token")!);
    expect(session.getUserId()).toBe(rowndId);
  }

  it.each([undefined, null, ""])("migrates and retries email-only profiles with absent optional identities %j", async (absent) => {
    const id = randomUUID();
    const profile = { data: { user_id: id, email: `${id}@example.com`, phone_number: absent, google_id: absent, apple_id: absent },
      verified_data: { phone_number: absent, google_id: absent, apple_id: absent } };
    const original = structuredClone(profile);
    rownd.validateToken.mockResolvedValue({ user_id: id });
    rownd.fetchUserInfo.mockResolvedValue(profile);
    await expectSession(await migrate(id), id);
    const search = vi.spyOn(SuperTokens, "listUsersByAccountInfo");
    const create = vi.spyOn(Passwordless, "signInUp");
    const link = vi.spyOn(AccountLinking, "linkAccounts");
    await expectSession(await migrate(id), id);
    expect(search).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(id))?.loginMethods).toHaveLength(1);
    expect(profile).toEqual(original);
  });

  it("adds Apple to a completed Google-only owner with empty contact fields", async () => {
    const id = randomUUID();
    const profile: RowndUser = { data: { user_id: id, email: "", phone_number: "", google_id: "", apple_id: "" }, verified_data: { google_id: randomUUID() } };
    rownd.validateToken.mockResolvedValue({ user_id: id });
    rownd.fetchUserInfo.mockResolvedValue(profile);
    await expectSession(await migrate(id), id);
    profile.verified_data!.apple_id = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expectSession(await migrate(id), id);
      const owner = await SuperTokens.getUser(id);
      expect(owner?.loginMethods).toHaveLength(2);
      expect(owner?.loginMethods.map((method) => method.thirdParty?.id).sort()).toEqual(["apple", "google"]);
    }
  });

  it("retires a snapshot-proven provider when its replacement is already attached", async () => {
    const id = randomUUID();
    const profile: RowndUser = { data: { user_id: id, email: "" }, verified_data: { google_id: randomUUID(), apple_id: randomUUID() } };
    rownd.validateToken.mockResolvedValue({ user_id: id });
    rownd.fetchUserInfo.mockResolvedValue(profile);
    await expectSession(await migrate(id), id);
    const previous = profile.verified_data!.apple_id;
    const subject = randomUUID();
    profile.verified_data!.apple_id = subject;
    const method = mapRowndUserToSuperTokens(profile).loginMethods.find((entry) => entry.recipeId === "thirdparty" && entry.thirdPartyId === "apple")!;
    const replacement = await ThirdParty.manuallyCreateOrUpdateUser("public", "apple", subject, method.email!, false);
    if (replacement.status !== "OK") throw new Error("Missing replacement Apple fixture");
    await AccountLinking.linkAccounts(replacement.recipeUserId, id);
    // The replacement already exists, but the snapshot-proven old method still
    // needs retirement even without an introduction or retirement checkpoint.
    await expectSession(await migrate(id), id);
    const owner = await SuperTokens.getUser(id);
    expect(owner?.loginMethods).toHaveLength(2);
    expect(owner?.loginMethods.some((entry) => entry.thirdParty?.userId === previous)).toBe(false);
    expect(owner?.loginMethods.some((entry) => entry.thirdParty?.userId === subject)).toBe(true);
  });

  it.each([{ email: "bad" }, { phone_number: " " }, { apple_id: 123 }, { user_id: "" }])("rejects malformed initial profiles before writes: %j", async (invalid) => {
    const id = randomUUID();
    rownd.validateToken.mockResolvedValue({ user_id: id });
    rownd.fetchUserInfo.mockResolvedValue({ data: { user_id: id, email: `${id}@example.com`, ...invalid } });
    const metadata = vi.spyOn(UserMetadata, "updateUserMetadata");
    const passwordless = vi.spyOn(Passwordless, "signInUp");
    const provider = vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser");
    expect((await migrate(id)).status).toBeGreaterThanOrEqual(400);
    expect(metadata).not.toHaveBeenCalled();
    expect(passwordless).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(await SuperTokens.getUser(id)).toBeUndefined();
  });

  it.each(["canonical", "pending"])("keeps %s native email authoritative during completed migration", async (protection) => {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const profile = { data: { user_id: id, email } };
    rownd.validateToken.mockResolvedValue({ user_id: id });
    rownd.fetchUserInfo.mockResolvedValue(profile);
    await expectSession(await migrate(id), id);
    const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL" });
    if (mapping.status !== "OK") throw new Error("Missing native fixture mapping");
    const metadata = protection === "canonical" ? { rownd_email_recipe_user_ids: { public: id } } : {
      rownd_pending_verification: [{ id: randomUUID(), field: "email", value: `pending-${email}`, tenantId: "public", status: "PENDING", created_at: new Date().toISOString() }],
    };
    await UserMetadata.updateUserMetadata(mapping.superTokensUserId, metadata);
    const before = (await SuperTokens.getUser(id))!.toJson();
    profile.data.email = `stale-${email}`;
    const search = vi.spyOn(SuperTokens, "listUsersByAccountInfo");
    const create = vi.spyOn(Passwordless, "signInUp");
    await expectSession(await migrate(id), id);
    expect(search).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(id))!.toJson()).toEqual(before);
    expect((await UserMetadata.getUserMetadata(mapping.superTokensUserId)).metadata).toMatchObject(metadata);
  });

  it.each(["missing", "stale"])("links Maja's standalone B contact into token A with %s verification flags", async (flags) => {
    const fixture = await seed();
    if (flags === "stale") fixture.profileA.verified_data.email = "old@example.com";
    await expectSession(await migrate(fixture.a), fixture.a);
    const user = (await SuperTokens.getUser(fixture.a))!;
    expect(user.loginMethods).toHaveLength(2);
    expect(user.loginMethods.find((method) => method.recipeId === "passwordless")).toMatchObject({ verified: true, email: fixture.email });
    expect(user.loginMethods.find((method) => method.recipeId === "thirdparty")!.thirdParty).toEqual({ id: "google", userId: fixture.googleId });
    expect((await SuperTokens.getUser(fixture.internalB))!.id).toBe(fixture.a);
    expect((await SuperTokens.getUser(fixture.internalA))!.id).toBe(fixture.a);
    expect((await SuperTokens.getUserIdMapping({ userId: fixture.a, userIdType: "EXTERNAL" }))).toMatchObject({ superTokensUserId: fixture.internalA });
    expect((await SuperTokens.getUserIdMapping({ userId: fixture.b, userIdType: "EXTERNAL" })).status).toBe("UNKNOWN_MAPPING_ERROR");
    expect(await getCombinedUserMetadata(fixture.a)).toMatchObject({ preference: "A", dataA: { preserved: true }, dataB: { preserved: true }, aliasDataB: "preserved", original_rownd_user: { data: { user_id: fixture.a } } });
    expect((await UserMetadata.getUserMetadata(fixture.internalB)).metadata).toMatchObject({ preference: "B", dataB: { preserved: true } });
    const beforeRetry = user.toJson();
    await expectSession(await migrate(fixture.a), fixture.a);
    expect((await SuperTokens.getUser(fixture.a))!.toJson()).toEqual(beforeRetry);
    const superseded = await migrate(fixture.b);
    expect(superseded.status).not.toBe(200);
    expect(superseded.headers.get("st-access-token")).toBeNull();
  });

  it("admin retains the verified email owner while electing the newer source without a token", async () => {
    const fixture = await seed();
    fixture.profileA.verified_data.email = true;
    fixture.profileA.meta = { last_active: "2020-01-02T00:00:00.000Z" };
    fixture.profileB.meta = { last_active: "2020-01-01T00:00:00.000Z" };
    const result = await reconcileUser({ rownd_user_id: fixture.a });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: fixture.internalB });
    expect((await SuperTokens.getUser(fixture.internalB))!.id).toBe(fixture.a);
    expect((await SuperTokens.getUser(fixture.a))!.loginMethods.find((method) => method.recipeId === "passwordless")).toMatchObject({ verified: true, email: fixture.email });
    expect(rownd.validateToken).not.toHaveBeenCalled();
    expect(await reconcileUser({ email: fixture.email })).toMatchObject({ status: "OK", changed: false });
  }, 30000);

  it("admin revalidates activity before retiring a duplicate mapping after reservation", async () => {
    const fixture = await seed();
    fixture.profileA.meta = { last_active: "2020-01-02T00:00:00.000Z" };
    fixture.profileB.meta = { last_active: "2020-01-01T00:00:00.000Z" };
    const source = (await fetchAdministrativeMigrationSource(fixture.a, "public", {}))!;
    const election = await inspectAdministrativeElection([
      { rownd_user_id: fixture.a, supertokens_user_id: fixture.internalA },
      { rownd_user_id: fixture.b, supertokens_user_id: fixture.internalB },
    ]);
    bindAdministrativeElection(source, "public", election, () => assertMigrationMapping(fixture.internalA, fixture.a, {}));
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, data, context) => {
      const result = await update(id, data, context);
      if (id === fixture.a && data.rownd_migration_target === fixture.internalA) {
        fixture.profileB.meta = { last_active: "2020-01-03T00:00:00.000Z" };
      }
      return result;
    });
    const writes = [vi.spyOn(SuperTokens, "deleteUserIdMapping"), vi.spyOn(AccountLinking, "linkAccounts"),
      vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(EmailVerification, "verifyEmailUsingToken")];
    await expect(retireDuplicateMapping({ source, ownerInternalId: fixture.internalB, targetInternalId: fixture.internalA,
      tenantId: "public", userContext: {} })).rejects.toThrow("Rownd activity election changed before reconciliation completion");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.b, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.internalB });
    expect((await UserMetadata.getUserMetadata(fixture.b)).metadata.rownd_migration_superseded).toBeUndefined();
    expect((await SuperTokens.getUser(fixture.b))!.loginMethods).toHaveLength(1);
  });

  it("the retirement primitive retains its bound-admin exception for an older published contact", async () => {
    const fixture = await seed();
    fixture.profileA.meta = { last_active: "2020-01-02T00:00:00.000Z" };
    fixture.profileB.meta = { last_active: "2020-01-01T00:00:00.000Z" };
    await UserMetadata.updateUserMetadata(fixture.b, { rownd_migration_canonical_target: fixture.internalB });
    const source = (await fetchAdministrativeMigrationSource(fixture.a, "public", {}))!;
    const election = await inspectAdministrativeElection([
      { rownd_user_id: fixture.a, supertokens_user_id: fixture.internalA },
      { rownd_user_id: fixture.b, supertokens_user_id: fixture.internalB },
    ]);
    bindAdministrativeElection(source, "public", election, () => assertMigrationMapping(fixture.internalA, fixture.a, {}));
    await retireDuplicateMapping({ source, ownerInternalId: fixture.internalB, targetInternalId: fixture.internalA, tenantId: "public", userContext: {} });
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.b, userIdType: "EXTERNAL" })).toMatchObject({ status: "UNKNOWN_MAPPING_ERROR" });
  });

  it.each([false, true])("keeps token B on B without absorbing same-email Google A (primary=%s), and preserves that published election", async (primary) => {
    const fixture = await seed();
    fixture.profileA.meta = { last_active: "2020-01-02T00:00:00.000Z" };
    fixture.profileB.meta = { last_active: "2020-01-01T00:00:00.000Z" };
    if (primary) await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(fixture.internalA));
    const googleBefore = (await SuperTokens.getUser(fixture.a))!.toJson();
    await expectSession(await migrate(fixture.b), fixture.b);
    expect((await SuperTokens.getUser(fixture.b))!.loginMethods).toHaveLength(1);
    expect((await SuperTokens.getUser(fixture.b))!.loginMethods[0]!.verified).toBe(true);
    expect((await SuperTokens.getUser(fixture.a))!.toJson()).toEqual(googleBefore);
    expect((await SuperTokens.getUserIdMapping({ userId: fixture.b, userIdType: "EXTERNAL" }))).toMatchObject({ superTokensUserId: fixture.internalB });
    const attemptA = await migrate(fixture.a);
    expect(attemptA.status).not.toBe(200);
    expect(attemptA.headers.get("st-access-token")).toBeNull();
    await expectSession(await migrate(fixture.b), fixture.b);
  });

  it("does not elect an unmapped Google primary solely from token B's email proof", async () => {
    const rowndId = `rownd-${randomUUID()}`;
    const email = `${randomUUID()}@example.com`;
    const provider = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", randomUUID(), email, true);
    if (provider.status !== "OK") throw new Error("Missing Google primary");
    await AccountLinking.createPrimaryUser(provider.recipeUserId);
    const internalId = provider.recipeUserId.getAsString();
    rownd.validateToken.mockResolvedValue({ user_id: rowndId });
    rownd.fetchUserInfo.mockResolvedValue({ state: "enabled", auth_level: "instant", data: { user_id: rowndId, email }, verified_data: {} });
    const before = (await SuperTokens.getUser(internalId))!.toJson();
    const response = await migrate(rowndId);
    expect((await SuperTokens.getUser(internalId))!.toJson()).toEqual(before);
    expect((await SuperTokens.getUserIdMapping({ userId: internalId, userIdType: "SUPERTOKENS" })).status).toBe("UNKNOWN_MAPPING_ERROR");
    if (response.status === 200) {
      await expectSession(response, rowndId);
      const user = (await SuperTokens.getUser(rowndId))!;
      expect(user.loginMethods).toHaveLength(1);
      expect(user.loginMethods[0]!.recipeId).toBe("passwordless");
    } else expect(response.headers.get("st-access-token")).toBeNull();
  });

  it("retires a selected standalone contact target's old mapping when the token has no existing mapping", async () => {
    const fixture = await seed();
    await SuperTokens.deleteUserIdMapping({ userId: fixture.a, userIdType: "EXTERNAL", force: true });
    delete fixture.profileA.data.google_id;
    await expectSession(await migrate(fixture.a), fixture.a);
    expect((await SuperTokens.getUserIdMapping({ userId: fixture.a, userIdType: "EXTERNAL" }))).toMatchObject({ superTokensUserId: fixture.internalB });
    expect((await SuperTokens.getUser(fixture.a))!.loginMethods).toHaveLength(1);
    expect((await SuperTokens.getUser(fixture.internalA))!.id).toBe(fixture.internalA);
    expect((await migrate(fixture.b)).status).not.toBe(200);
  });

  it("retries contact linking after durable retirement without replacing either recipe ID or application metadata", async () => {
    const fixture = await seed();
    const link = vi.spyOn(AccountLinking, "linkAccounts").mockRejectedValueOnce(new Error("Injected link failure"));
    const interrupted = await migrate(fixture.a);
    expect(interrupted.status).not.toBe(200);
    expect(interrupted.headers.get("st-access-token")).toBeNull();
    expect((await SuperTokens.getUserIdMapping({ userId: fixture.b, userIdType: "EXTERNAL" })).status).toBe("UNKNOWN_MAPPING_ERROR");
    expect((await UserMetadata.getUserMetadata(fixture.b)).metadata).toMatchObject({ rownd_migration_superseded: { rowndUserId: fixture.a, targetUserId: fixture.internalA } });
    link.mockRestore();
    await expectSession(await migrate(fixture.a), fixture.a);
    expect((await SuperTokens.getUser(fixture.internalB))!.id).toBe(fixture.a);
    expect(await getCombinedUserMetadata(fixture.a)).toMatchObject({ dataA: { preserved: true }, dataB: { preserved: true }, aliasDataB: "preserved" });
  });

  it("repairs a completed mapping's eligible current email and retires its historical contact", async () => {
    const fixture = await seed();
    const oldEmail = `old-${randomUUID()}@example.com`;
    await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(fixture.internalA));
    const old = await Passwordless.signInUp({ tenantId: "public", email: oldEmail, userContext: { rowndDisableAutomaticAccountLinking: true } });
    await AccountLinking.linkAccounts(old.recipeUserId, fixture.internalA);
    await UserMetadata.updateUserMetadata(fixture.internalA, {
      rownd_migration_complete: true,
      original_rownd_user: { ...fixture.profileA, data: { ...fixture.profileA.data, email: oldEmail } },
    });
    await expectSession(await migrate(fixture.a), fixture.a);
    expect(await SuperTokens.getUser(old.recipeUserId.getAsString())).toBeUndefined();
    const user = (await SuperTokens.getUser(fixture.a))!;
    expect(user.loginMethods).toHaveLength(2);
    expect(user.loginMethods.find((method) => method.recipeId === "passwordless")!.recipeUserId.getAsString()).toBe(fixture.internalB);
    expect((await SuperTokens.getUserIdMapping({ userId: fixture.b, userIdType: "EXTERNAL" }))).toMatchObject({ status: "UNKNOWN_MAPPING_ERROR" });
    expect((await UserMetadata.getUserMetadata(fixture.internalA)).metadata).toMatchObject({ preference: "A" });
  });

  it("rejects completed migration when ownership changes after ID discovery without issuing credentials or sessions", async () => {
    const id = randomUUID();
    const profile = { data: { user_id: id, email: `${id}@example.com` } };
    rownd.validateToken.mockResolvedValue({ user_id: id });
    rownd.fetchUserInfo.mockResolvedValue(profile);
    await expectSession(await migrate(id), id);
    const originalMapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL" });
    if (originalMapping.status !== "OK") throw new Error("Missing completed fixture mapping");
    await Session.revokeAllSessionsForUser(id, true, "public");

    const foreign = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@foreign.example.com`,
      userContext: { rowndDisableAutomaticAccountLinking: true } });
    expect((await AccountLinking.createPrimaryUser(foreign.recipeUserId)).status).toBe("OK");
    const ownerIds = [originalMapping.superTokensUserId, foreign.user.id];
    for (const owner of ownerIds) expect(await Session.getAllSessionHandlesForUser(owner, true, "public")).toEqual([]);
    const coreURI = `http://${core.getHost()}:${core.getMappedPort(3567)}`;
    const cdiVersion = await Querier.getNewInstanceOrThrowError(SuperTokensRaw.getInstanceOrThrowError()).getAPIVersion({});

    const discoveryModule = await import("./migration-plan");
    const discover = discoveryModule.discoverMigrationById;
    let reassignedAfterDiscovery = false;
    let discoveryError: unknown;
    vi.spyOn(discoveryModule, "discoverMigrationById").mockImplementationOnce(async (...args) => {
      try {
        const snapshot = await discover(...args);
        expect(snapshot.mapping).toMatchObject(originalMapping);
        expect(snapshot.user?.id).toBe(id);
        expect(snapshot.metadataById.get(id)?.rownd_migration_complete).toBe(true);
        // Direct Core writes model another process without invalidating this SDK's
        // caches; the request must reject its captured snapshot using fresh checks.
        for (const [path, body] of [
          ["/recipe/userid/map/remove", { userId: id, userIdType: "EXTERNAL", force: true }],
          ["/recipe/userid/map", { superTokensUserId: foreign.user.id, externalUserId: id, force: true }],
        ] as const) {
          const mutation = await fetch(`${coreURI}${path}`, { method: "POST",
            headers: { "Content-Type": "application/json", "cdi-version": cdiVersion }, body: JSON.stringify(body) });
          expect(mutation.status).toBe(200);
          expect(await mutation.json()).toMatchObject({ status: "OK" });
        }
        reassignedAfterDiscovery = true;
        return snapshot;
      } catch (error) {
        // The endpoint catches hook failures; surface them outside its error handler.
        discoveryError = error;
        throw error;
      }
    });

    const response = await migrate(id);
    if (discoveryError) throw discoveryError;
    expect(reassignedAfterDiscovery).toBe(true);
    expect(response.status).toBeGreaterThanOrEqual(400);
    for (const header of ["st-access-token", "st-refresh-token", "front-token", "set-cookie"]) {
      expect(response.headers.get(header), header).toBeNull();
    }
    for (const owner of ownerIds) expect(await Session.getAllSessionHandlesForUser(owner, true, "public")).toEqual([]);
    expect(await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL" })).toMatchObject({
      status: "OK", superTokensUserId: foreign.user.id,
    });
  });

  it.each(["verification flags", "email"])("revalidates policy-relevant %s before publishing a session", async (change) => {
    const fixture = await seed();
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, metadata, context) => {
      const result = await update(id, metadata, context);
      if (id === fixture.internalA && metadata.rownd_migration_complete === true) {
        fixture.profileA.auth_level = "verified";
        fixture.profileA.verified_data.email = "stale@example.com";
        if (change === "email") fixture.profileA.data.email = "changed@example.com";
      }
      return result;
    });
    const response = await migrate(fixture.a);
    if (change === "verification flags") await expectSession(response, fixture.a);
    else {
      expect(response.status).not.toBe(200);
      expect(response.headers.get("st-access-token")).toBeNull();
      expect((await UserMetadata.getUserMetadata(fixture.a)).metadata.rownd_migration_canonical_target).toBeUndefined();
    }
  });

  it("does not copy a donor alias's native email workflow into the token target", async () => {
    const fixture = await seed();
    await UserMetadata.updateUserMetadata(fixture.b, {
      rownd_email_recipe_user_ids: { public: fixture.internalB },
      rownd_pending_verification: [{ id: "donor-native", field: "email", value: "pending@example.com", created_at: new Date().toISOString() }],
    });
    await expectSession(await migrate(fixture.a), fixture.a);
    const metadata = await getCombinedUserMetadata(fixture.a);
    expect(metadata.rownd_pending_verification).toBeUndefined();
    expect(metadata.rownd_email_recipe_user_ids).toBeUndefined();
    expect((await UserMetadata.getUserMetadata(fixture.b)).metadata.rownd_pending_verification).toHaveLength(1);
  });

  it.each(["tenant", "subject", "email", "copied source"])("rejects an authenticated proof's %s mismatch", async (change) => {
    const fixture = await seed();
    const authenticated = await authenticateRowndMigration(fixture.a, "public", {});
    let source = authenticated.source!;
    if (change === "subject") source.externalUserId = fixture.b;
    if (change === "email") {
      const method = source.loginMethods.find((method) => method.recipeId === "passwordless");
      if (method?.recipeId === "passwordless") method.email = "changed@example.com";
    }
    if (change === "copied source") source = structuredClone(source);
    await expect(reconcileRowndUserWithExistingLoginMethods(source, change === "tenant" ? "another-tenant" : "public", {})).rejects.toThrow();
    expect((await SuperTokens.getUser(fixture.internalB))!.id).toBe(fixture.b);
  });

  it("leaves another tenant's contact mapping untouched", async () => {
    const fixture = await seed();
    const tenantId = `tenant-${randomUUID()}`;
    await Multitenancy.createOrUpdateTenant(tenantId, { firstFactors: ["link-email"] });
    await Multitenancy.associateUserToTenant(tenantId, SuperTokens.convertToRecipeUserId(fixture.internalB));
    await Multitenancy.disassociateUserFromTenant("public", SuperTokens.convertToRecipeUserId(fixture.internalB));
    await expectSession(await migrate(fixture.a), fixture.a);
    expect((await SuperTokens.getUser(fixture.b))!.id).toBe(fixture.b);
    expect((await SuperTokens.getUser(fixture.b))!.loginMethods[0]!.tenantIds).toEqual([tenantId]);
  });

  it("rejects retiring a contact shared with another tenant without changing its mapping or membership", async () => {
    const fixture = await seed();
    const tenantId = `tenant-${randomUUID()}`;
    await Multitenancy.createOrUpdateTenant(tenantId, { firstFactors: ["link-email"] });
    await Multitenancy.associateUserToTenant(tenantId, SuperTokens.convertToRecipeUserId(fixture.internalB));
    const before = (await SuperTokens.getUser(fixture.b))!.toJson();
    const metadataBefore = (await UserMetadata.getUserMetadata(fixture.internalB)).metadata;
    const response = await migrate(fixture.a);
    expect(response.status).toBe(400);
    expect(response.headers.get("st-access-token")).toBeNull();
    expect((await SuperTokens.getUser(fixture.b))!.toJson()).toEqual(before);
    expect((await UserMetadata.getUserMetadata(fixture.internalB)).metadata).toEqual(metadataBefore);
    expect((await SuperTokens.getUserIdMapping({ userId: fixture.b, userIdType: "EXTERNAL" }))).toMatchObject({ superTokensUserId: fixture.internalB });
  });

  it.each(["foreign primary", "wrong source", "disabled source", "wrong duplicate", "changed duplicate email", "invalid token", "no token"])("rejects %s before contact retirement", async (failure) => {
    const fixture = await seed();
    if (failure === "foreign primary") await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(fixture.internalB));
    if (failure === "wrong source") fixture.profileA.data.user_id = fixture.b;
    if (failure === "disabled source") fixture.profileA.state = "disabled";
    if (failure === "wrong duplicate") fixture.profileB.data.user_id = fixture.a;
    if (failure === "changed duplicate email") fixture.profileB.data.email = "different@example.com";
    const snapshot = async () => Promise.all([fixture.internalA, fixture.internalB, fixture.a, fixture.b].map(async (id) => ({
      user: (await SuperTokens.getUser(id))?.toJson(), metadata: (await UserMetadata.getUserMetadata(id)).metadata,
    })));
    const before = await snapshot();
    const response = await migrate(failure === "invalid token" ? "invalid" : failure === "no token" ? undefined : fixture.a);
    expect(response.status).not.toBe(200);
    expect(response.headers.get("st-access-token")).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it("does not authorize contact mapping retirement for an arbitrary imported profile", async () => {
    const fixture = await seed();
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.profileA, "public"), "public", {})).rejects.toThrow();
    expect((await SuperTokens.getUser(fixture.internalB))!.id).toBe(fixture.b);
    expect(mapRowndUserToSuperTokens(fixture.profileA, "public").loginMethods.find((method) => method.recipeId === "passwordless")).toMatchObject({ isVerified: false });
  });
});
