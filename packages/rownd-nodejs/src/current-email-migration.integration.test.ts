import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import EmailVerification from "supertokens-node/recipe/emailverification";
import EmailPassword from "supertokens-node/recipe/emailpassword";
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
import { getCombinedUserMetadata, isSuperTokensFakeEmail, mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { importUser, prepareEmailForPasswordlessAuth, reconcileRowndUserWithExistingLoginMethods } from "./supertokens-repository";
import type { RowndUser } from "./types";
import { associateUserLoginMethodsToTenant } from "./pluginImplementation";
import { fetchAdministrativeMigrationSource, validateCurrentRowndEmailReconciliation } from "./migration-email";
import { prepareOwnerConsolidation } from "./migration-consolidation";
import { reconcileUser, type ReconcileUserInput } from "./reconcile-user";
import { getPluginConfig, setPluginConfig } from "./config";

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

describe("Apple relay migration and explicit administrative reconciliation", { timeout: 30_000 }, () => {
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
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }), ThirdParty.init(), EmailPassword.init(),
      ],
      experimental: { plugins: [init({ rowndAppKey: "test-key", rowndAppSecret: "test-secret" })] },
    });
    app.use(middleware());
    app.post("/test/native-session", async (req, res) => {
      try {
        await Session.createNewSession(req, res, "public", SuperTokens.convertToRecipeUserId(req.header("x-recipe-user-id")!));
        res.json({ status: "OK" });
      } catch (error) {
        res.status(409).json({ status: "ERROR", message: error instanceof Error ? error.message : "Session failed" });
      }
    });
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

  async function seed(standalone = false, completed = true) {
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
    await UserMetadata.updateUserMetadata(internalId, { rownd_migration_complete: completed, original_rownd_user: original, preference: "preserved" });
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

  async function spyOnReconciliationWrites(added: Array<{ mockRestore(): void }> = []) {
    const repository = await import("./supertokens-repository");
    const provider = await import("./migration-provider");
    const email = await import("./migration-email");
    const watch = <T extends object>(object: T, key: keyof T) => {
      const existing = object[key];
      if (vi.isMockFunction(existing)) return existing;
      const spy = vi.spyOn(object, key as never);
      added.push(spy);
      return spy;
    };
    return [watch(repository, "importUser"), watch(repository, "reconcileRowndUserWithExistingLoginMethods"),
      watch(provider, "finishProviderIntroductions"), watch(provider, "prepareRowndProviderRetirement"),
      watch(email, "finishCurrentRowndEmailReconciliation"), watch(SuperTokens, "createUserIdMapping"),
      watch(SuperTokens, "deleteUserIdMapping"), watch(SuperTokens, "deleteUser"),
      watch(AccountLinking, "createPrimaryUser"), watch(AccountLinking, "linkAccounts"), watch(AccountLinking, "unlinkAccount"),
      watch(UserMetadata, "updateUserMetadata"), watch(UserMetadata, "clearUserMetadata"),
      watch(Passwordless, "signInUp"), watch(Passwordless, "updateUser"), watch(Passwordless, "revokeAllCodes"),
      watch(ThirdParty, "manuallyCreateOrUpdateUser"), watch(EmailPassword, "signUp"),
      watch(EmailVerification, "createEmailVerificationToken"), watch(EmailVerification, "verifyEmailUsingToken"),
      watch(EmailVerification, "unverifyEmail"), watch(EmailVerification, "revokeEmailVerificationTokens"),
      watch(Session, "createNewSession"), watch(Session, "createNewSessionWithoutRequestResponse"), watch(Session, "revokeAllSessionsForUser"),
      watch(Multitenancy, "associateUserToTenant"), watch(Multitenancy, "disassociateUserFromTenant")];
  }

  async function readOnlyPreview(input: ReconcileUserInput) {
    const added: Array<{ mockRestore(): void }> = [];
    const writes = await spyOnReconciliationWrites(added);
    const before = writes.map((write) => write.mock.calls.length);
    try {
      const result = await reconcileUser({ ...input, dryRun: true });
      expect(result).toMatchObject({ dryRun: true, changed: false, actions: [], snapshotOnly: true });
      writes.forEach((write, index) => expect(write.mock.calls.length).toBe(before[index]));
      return result;
    } finally {
      for (const spy of added.reverse()) spy.mockRestore();
    }
  }

  async function seedInvalidPublicCanonical() {
    const fixture = await seed(true);
    const contact = fixture.separate!;
    await AccountLinking.linkAccounts(contact.recipeUserId, fixture.internalId);
    const outsidePublic = `outside-public-${randomUUID()}`;
    await Multitenancy.createOrUpdateTenant(outsidePublic, { firstFactors: ["link-email"] });
    await Multitenancy.associateUserToTenant(outsidePublic, contact.recipeUserId);
    await Multitenancy.disassociateUserFromTenant("public", contact.recipeUserId);
    await UserMetadata.updateUserMetadata(fixture.internalId, { rownd_email_recipe_user_ids: { public: contact.recipeUserId.getAsString() } });
    return fixture;
  }

  async function seedPhoneReference(currentPhone: boolean, duplicate: boolean) {
    const rowndId = `phone-reference-${randomUUID()}`;
    const donorId = `email-reference-${randomUUID()}`;
    const email = `${randomUUID()}@example.com`;
    const phoneNumber = `+1555${Math.floor(Math.random() * 10000000).toString().padStart(7, "0")}`;
    const phone = await Passwordless.signInUp({ tenantId: "public", phoneNumber });
    const donor = await Passwordless.signInUp({ tenantId: "public", email });
    await EmailVerification.unverifyEmail(donor.recipeUserId, email);
    await SuperTokens.createUserIdMapping({ superTokensUserId: phone.user.id, externalUserId: rowndId });
    const original: RowndUser = { data: { user_id: rowndId, phone_number: phoneNumber, ...(!duplicate ? { email } : {}) }, verified_data: {} };
    const profile: RowndUser = { state: "enabled", data: { user_id: rowndId, email, ...(currentPhone ? { phone_number: phoneNumber } : {}) }, verified_data: currentPhone ? { phone_number: true } : {},
      meta: { last_sign_in: "2020-07-12T21:54:40.454Z", last_active: "2020-07-12T21:54:40.454Z" } };
    const donorProfile: RowndUser = { state: "enabled", data: { user_id: donorId, email }, verified_data: {},
      meta: { last_sign_in: "2020-07-13T10:56:04.098Z", last_active: "2020-07-13T10:56:04.098Z" } };
    await UserMetadata.updateUserMetadata(phone.user.id, { original_rownd_user: original, rownd_migration_complete: true });
    if (duplicate) {
      await SuperTokens.createUserIdMapping({ superTokensUserId: donor.user.id, externalUserId: donorId });
      await UserMetadata.updateUserMetadata(donor.user.id, { original_rownd_user: donorProfile, rownd_migration_complete: true });
    }
    const profiles = new Map([[rowndId, profile], ...(duplicate ? [[donorId, donorProfile] as const] : [])]);
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => profiles.get(user_id));
    return { rowndId, donorId, email, phone, donor, profile, donorProfile, profiles };
  }

  it.each([false, true])("admin retains the live unverified email owner and links its phone donor (currentPhone=%s)", async (currentPhone) => {
    const fixture = await seedPhoneReference(currentPhone, false);
    const preview = await readOnlyPreview({ rownd_user_id: fixture.rowndId });
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true,
      proposedActions: expect.arrayContaining([expect.objectContaining({ action: "link_method", recipeUserId: fixture.phone.user.id })]) });
    expect(preview.proposedActions?.some(({ action }) => action === "verify_email")).toBe(false);
    const ev = [vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(EmailVerification, "verifyEmailUsingToken"), vi.spyOn(EmailVerification, "unverifyEmail")];
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: fixture.donor.user.id });
    const user = (await SuperTokens.getUser(fixture.rowndId))!;
    expect(user.loginMethods).toHaveLength(2);
    expect(user.loginMethods.find((method) => method.hasSameEmailAs(fixture.email))).toMatchObject({ verified: false });
    expect(user.loginMethods.some((method) => method.recipeUserId.getAsString() === fixture.phone.user.id)).toBe(true);
    for (const write of ev) expect(write).not.toHaveBeenCalled();
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "OK", changed: false });
  });

  it("Core preserves recipe mappings when consolidating a mapped phone owner into a mapped email primary", async () => {
    const fixture = await seedPhoneReference(false, true);
    expect(await AccountLinking.createPrimaryUser(fixture.donor.recipeUserId)).toMatchObject({ status: "OK" });
    expect(await AccountLinking.linkAccounts(SuperTokens.convertToRecipeUserId(fixture.rowndId), fixture.donor.user.id)).toMatchObject({ status: "OK" });
    for (const id of [fixture.rowndId, fixture.donorId, fixture.phone.user.id, fixture.donor.user.id]) {
      expect((await SuperTokens.getUser(id))!.id).toBe(fixture.donorId);
    }
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.rowndId, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.phone.user.id });
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.donorId, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.donor.user.id });
    expect((await SuperTokens.getUser(fixture.rowndId))!.loginMethods.find((method) => method.hasSameEmailAs(fixture.email))).toMatchObject({ verified: false });
  });

  it("admin creates a missing data.email method without granting email verification", async () => {
    const fixture = await seedPhoneReference(true, false);
    await SuperTokens.deleteUser(fixture.donor.user.id);
    expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "PREVIEW", canReconcile: true });
    const tokens = [vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(EmailVerification, "verifyEmailUsingToken"), vi.spyOn(EmailVerification, "unverifyEmail")];
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK" });
    expect((await SuperTokens.getUser(fixture.rowndId))!.loginMethods.find((method) => method.hasSameEmailAs(fixture.email))).toMatchObject({ verified: false });
    for (const write of tokens) expect(write).not.toHaveBeenCalled();
  });

  it("admin rejects a live data.email change after linking without verification escalation", async () => {
    const fixture = await seedPhoneReference(true, false);
    const link = AccountLinking.linkAccounts.bind(AccountLinking);
    vi.spyOn(AccountLinking, "linkAccounts").mockImplementation(async (...args) => {
      const result = await link(...args);
      fixture.profile.data.email = `${randomUUID()}@example.com`;
      return result;
    });
    const writes = [vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(EmailVerification, "verifyEmailUsingToken")];
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", message: "Rownd source identity changed before migration completion" });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(fixture.rowndId))!.loginMethods.find((method) => method.recipeId === "passwordless" && method.hasSameEmailAs(fixture.email))).toMatchObject({ verified: false });
  });

  it.each([false, true])("admin consolidates the older phone owner under the newer email source (newerRequestedFirst=%s)", async (newerRequested) => {
    const fixture = await seedPhoneReference(false, true);
    if (newerRequested) expect(await reconcileUser({ rownd_user_id: fixture.donorId })).toMatchObject({ status: "OK" });
    expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "PREVIEW", canReconcile: true, matchesSource: false,
      rownd_user_id: fixture.donorId, supertokens_user_id: fixture.donor.user.id,
      requested_rownd_user_id: fixture.rowndId, proposedActions: expect.arrayContaining([
        expect.objectContaining({ action: "create_primary", supertokens_user_id: fixture.donor.user.id }),
        expect.objectContaining({ action: "link_method", recipeUserId: fixture.phone.user.id }),
      ]) });
    const writes = [vi.spyOn(SuperTokens, "deleteUserIdMapping"), vi.spyOn(EmailVerification, "createEmailVerificationToken"),
      vi.spyOn(EmailVerification, "verifyEmailUsingToken"), vi.spyOn(EmailVerification, "unverifyEmail")];
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", changed: true, rownd_user_id: fixture.donorId, supertokens_user_id: fixture.donor.user.id,
      requested_rownd_user_id: fixture.rowndId });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    for (const [alias, internal] of [[fixture.rowndId, fixture.phone.user.id], [fixture.donorId, fixture.donor.user.id]]) {
      expect(await SuperTokens.getUserIdMapping({ userId: alias, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: internal });
      const user = (await SuperTokens.getUser(alias!))!;
      expect(user.id).toBe(fixture.donorId);
      expect(user.loginMethods).toHaveLength(2);
      expect(user.loginMethods.find((method) => method.hasSameEmailAs(fixture.email))).toMatchObject({ verified: false });
      const retry = await reconcileUser({ rownd_user_id: alias! });
      expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false, rownd_user_id: fixture.donorId });
    }
    expect(await reconcileUser({ email: fixture.email })).toMatchObject({ status: "OK", changed: false, rownd_user_id: fixture.donorId });
  });

  it("an explicit SuperTokens owner cannot silently redirect reconciliation to a different owner", async () => {
    const fixture = await seedPhoneReference(false, true);
    const result = await readOnlyPreview({ supertokens_user_id: fixture.phone.user.id });
    expect(result).toMatchObject({ status: "BLOCKED", canReconcile: false, rownd_user_id: fixture.donorId,
      requested_rownd_user_id: fixture.rowndId, message: "The SuperTokens selector belongs to a different canonical Rownd owner" });
    const writes = await spyOnReconciliationWrites();
    expect(await reconcileUser({ supertokens_user_id: fixture.phone.user.id })).toMatchObject({ status: "BLOCKED" });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it.each(["old", "new"])("JWT migration creates a canonical session through the %s consolidated alias", async (requested) => {
    const fixture = await seedPhoneReference(false, true);
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "OK" });
    const alias = requested === "old" ? fixture.rowndId : fixture.donorId;
    rownd.validateToken.mockResolvedValue({ user_id: alias });
    const response = await fetch(`${baseUrl}/auth/plugin/rownd/migrate`, {
      method: "POST", headers: { Authorization: "Bearer actual-validated-fixture-token", "st-auth-mode": "header", rid: "session", "fdi-version": "1.18" },
    });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { status: "OK" } });
    expect(rownd.validateToken).toHaveBeenCalled();
    const session = await Session.getSessionWithoutRequestResponse(response.headers.get("st-access-token")!);
    expect(session.getUserId()).toBe(fixture.donorId);
    const profile = await fetch(`${baseUrl}/auth/plugin/rownd/user`, {
      headers: { Authorization: `Bearer ${response.headers.get("st-access-token")}`, rid: "session", "fdi-version": "1.18" },
    });
    expect(await profile.json()).toMatchObject({ status: "OK", rownd_user: fixture.donorId, data: { email: fixture.email } });
    if (requested === "old") {
      expect(session.getRecipeUserId().getAsString()).toBe(fixture.rowndId);
      expect((await SuperTokens.getUser(alias))!.loginMethods.find((method) => method.hasSameEmailAs(fixture.email))).toMatchObject({ verified: false });
    }
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "OK", changed: false, rownd_user_id: fixture.donorId });
  });

  it.each(["promotion", "second link", "after link"])("admin retries incomplete owner consolidation after failure at %s", async (failure) => {
    const fixture = await seedPhoneReference(false, true);
    const thirdId = `third-reference-${randomUUID()}`;
    const third = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", randomUUID(), fixture.email, false);
    if (third.status !== "OK") throw new Error("Third owner creation failed");
    const thirdInternal = third.recipeUserId.getAsString();
    await SuperTokens.createUserIdMapping({ superTokensUserId: thirdInternal, externalUserId: thirdId });
    const thirdProfile: RowndUser = { data: { user_id: thirdId, email: fixture.email }, verified_data: {}, meta: { last_active: "2020-07-11T00:00:00Z" } };
    fixture.profiles.set(thirdId, thirdProfile);
    await UserMetadata.updateUserMetadata(thirdInternal, { original_rownd_user: thirdProfile, rownd_migration_complete: true });
    const link = AccountLinking.linkAccounts.bind(AccountLinking);
    let interrupted = false;
    let linkCalls = 0;
    const linker = vi.spyOn(AccountLinking, "linkAccounts").mockImplementation(async (...args) => {
      linkCalls++;
      const stop = !interrupted && (failure !== "second link" || linkCalls === 2);
      if (stop && failure !== "after link") { interrupted = true; throw new Error("consolidation link interrupted"); }
      const result = await link(...args);
      if (stop) { interrupted = true; throw new Error("consolidation link response interrupted"); }
      return result;
    });
    const first = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(first, JSON.stringify(first)).toMatchObject({ status: "ERROR", changed: true, partialProgress: true });
    expect((await SuperTokens.getUser(fixture.donorId))!.isPrimaryUser).toBe(true);
    expect((await UserMetadata.getUserMetadata(fixture.donor.user.id)).metadata.rownd_migration_owner_consolidation).toMatchObject({ version: 2, status: expect.stringMatching(/^(READY|APPLYING|RECONCILING)$/) });
    if (failure !== "promotion") expect((await SuperTokens.getUser(fixture.donorId))!.loginMethods.length).toBeGreaterThan(1);
    rownd.validateToken.mockResolvedValue({ user_id: fixture.rowndId });
    if (failure !== "promotion") {
      const currentOwner = (await SuperTokens.getUser(fixture.rowndId))!.id;
      const session = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.rowndId));
      expect(session.getUserId()).toBe(currentOwner);
      const native = await fetch(`${baseUrl}/test/native-session`, {
        method: "POST", headers: { "x-recipe-user-id": fixture.rowndId, "st-auth-mode": "header" },
      });
      expect(native.status).toBe(200);
      expect(native.headers.get("st-access-token")).toBeTruthy();
      expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
      const blockedLogin = await fetch(`${baseUrl}/auth/plugin/rownd/migrate`, {
        method: "POST", headers: { Authorization: "Bearer fixture-token", "st-auth-mode": "header", rid: "session", "fdi-version": "1.18" },
      });
      expect(blockedLogin.headers.get("st-access-token")).toBeNull();
      expect(await blockedLogin.json()).toMatchObject({ status: "ERROR" });
    }
    linker.mockRestore();
    const retry = await reconcileUser({ rownd_user_id: fixture.donorId });
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: true, rownd_user_id: fixture.donorId });
    for (const [alias, id] of [[fixture.rowndId, fixture.phone.user.id], [fixture.donorId, fixture.donor.user.id], [thirdId, thirdInternal]]) {
      expect((await SuperTokens.getUser(alias!))!.id).toBe(fixture.donorId);
      expect(await SuperTokens.getUserIdMapping({ userId: alias, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: id });
    }
    expect((await SuperTokens.getUser(fixture.donorId))!.loginMethods).toHaveLength(3);
    expect((await SuperTokens.getUser(fixture.donorId))!.loginMethods.find((method) => method.recipeId === "passwordless" && method.hasSameEmailAs(fixture.email))).toMatchObject({ verified: false });
    expect((await UserMetadata.getUserMetadata(fixture.donor.user.id)).metadata.rownd_migration_owner_consolidation).toMatchObject({ status: "COMPLETE" });
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "OK", changed: false });
    expect((await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.rowndId))).getUserId()).toBe(fixture.donorId);
    for (const recipeId of [fixture.donorId, thirdId]) {
      expect((await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(recipeId))).getUserId()).toBe(fixture.donorId);
    }
  });

  it.each([["request", "before"], ["request", "after"], ["without request", "before"], ["without request", "after"]])(
    "native session creation (%s) remains independent when consolidation starts %s Core issuance", async (mode, timing) => {
    const fixture = await seedPhoneReference(false, true);
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "OK" });
    const existing = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.donorId));
    const checkpoint = (await UserMetadata.getUserMetadata(fixture.donor.user.id)).metadata.rownd_migration_owner_consolidation;
    await UserMetadata.updateUserMetadata(fixture.donor.user.id, { rownd_migration_owner_consolidation: null });
    const querier = Reflect.get(SessionRaw.getInstanceOrThrowError(), "querier") as Querier;
    const send = querier.sendPostRequest.bind(querier);
    let issued: string | undefined;
    const race = vi.spyOn(querier, "sendPostRequest").mockImplementation(async (...args) => {
      const createsSession = typeof args[0] === "object" && args[0].path === "/<tenantId>/recipe/session";
      const interrupt = () => UserMetadata.updateUserMetadata(fixture.donorId, { rownd_migration_owner_consolidation: { ...checkpoint, status: "LINKING" } });
      if (createsSession && timing === "before") await interrupt();
      const result = await send(...args);
      if (createsSession) {
        issued = result.session.handle;
        if (timing === "after") await interrupt();
      }
      return result;
    });
    try {
      if (mode === "without request") {
        expect((await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.rowndId))).getUserId()).toBe(fixture.donorId);
      } else {
        const response = await fetch(`${baseUrl}/test/native-session`, {
          method: "POST", headers: { "x-recipe-user-id": fixture.rowndId, "st-auth-mode": "header" },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("st-access-token")).toBeTruthy();
      }
    } finally { race.mockRestore(); }
    expect(issued).toBeDefined();
    expect(await Session.getSessionInformation(issued!)).toBeDefined();
    expect(await Session.getSessionInformation(existing.getHandle())).toBeDefined();
  });

  it.each(["LINKING", "COMMITTING", "malformed"])("native session creation ignores %s reconciliation checkpoints under a linked alias", async (status) => {
    const fixture = await seedPhoneReference(false, true);
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "OK" });
    const checkpoint = (await UserMetadata.getUserMetadata(fixture.donor.user.id)).metadata.rownd_migration_owner_consolidation;
    await UserMetadata.updateUserMetadata(fixture.rowndId, { rownd_migration_owner_consolidation: status === "malformed" ? {} : { ...checkpoint, status } });
    const querier = Reflect.get(SessionRaw.getInstanceOrThrowError(), "querier") as Querier;
    const writes = vi.spyOn(querier, "sendPostRequest");
    const session = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.donorId));
    expect(session.getUserId()).toBe(fixture.donorId);
    expect(writes.mock.calls.filter(([path]) => typeof path === "object" && path.path === "/<tenantId>/recipe/session")).toHaveLength(1);
    expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
    await UserMetadata.updateUserMetadata(fixture.rowndId, { rownd_migration_owner_consolidation: null });
    expect((await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.rowndId))).getUserId()).toBe(fixture.donorId);
  });

  async function seedHistoricalEmailDonor(nativeVerified: boolean) {
    const fixture = await seedPhoneReference(false, true);
    const emailB = `${randomUUID()}@example.com`;
    expect(await Passwordless.updateUser({ recipeUserId: SuperTokens.convertToRecipeUserId(fixture.rowndId), email: emailB, phoneNumber: null })).toMatchObject({ status: "OK" });
    await EmailVerification.unverifyEmail(SuperTokens.convertToRecipeUserId(fixture.rowndId), emailB);
    const verifiedB = await EmailPassword.signUp("public", emailB, "password123!");
    if (verifiedB.status !== "OK") throw new Error("Failed to create native B");
    if (nativeVerified) {
      const token = await EmailVerification.createEmailVerificationToken("public", verifiedB.recipeUserId, emailB);
      if (token.status === "OK") await EmailVerification.verifyEmailUsingToken("public", token.token);
    }
    await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(fixture.donorId));
    await AccountLinking.linkAccounts(verifiedB.recipeUserId, fixture.donorId);
    return { ...fixture, emailB, nativeB: verifiedB.recipeUserId };
  }

  it.each(["email A", "provider only", "contact only"])("consolidation cannot use %s proof to implicitly verify a historical donor email B", async (proof) => {
    const fixture = await seedHistoricalEmailDonor(true);
    fixture.donorProfile.verified_data = proof === "email A" ? { email: true } : proof === "provider only" ? { google_id: "fixture-google" } : {};
    const writes = [vi.spyOn(AccountLinking, "linkAccounts"), vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(EmailVerification, "verifyEmailUsingToken")];
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(fixture.rowndId))!.loginMethods[0]).toMatchObject({ verified: false, email: fixture.emailB });
  });

  it("unexpected implicit donor verification blocks consolidation retry without guarding native sessions", async () => {
    const fixture = await seedHistoricalEmailDonor(false);
    fixture.donorProfile.verified_data = { email: true };
    const link = AccountLinking.linkAccounts.bind(AccountLinking);
    vi.spyOn(AccountLinking, "linkAccounts").mockImplementationOnce(async (...args) => {
      const token = await EmailVerification.createEmailVerificationToken("public", fixture.nativeB, fixture.emailB);
      if (token.status === "OK") await EmailVerification.verifyEmailUsingToken("public", token.token);
      return link(...args);
    });
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: true });
    expect((await SuperTokens.getUser(fixture.rowndId))!.id).toBe(fixture.donorId);
    const checkpoint = (await UserMetadata.getUserMetadata(fixture.donor.user.id)).metadata.rownd_migration_owner_consolidation;
    expect(checkpoint).toMatchObject({ version: 2, status: expect.stringMatching(/^(READY|APPLYING|RECONCILING)$/), recipes: expect.arrayContaining([
      expect.objectContaining({ id: fixture.phone.user.id, email: fixture.emailB, verified: false }),
    ]) });
    const session = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.rowndId));
    expect(session.getUserId()).toBe(fixture.donorId);
    expect(await reconcileUser({ rownd_user_id: fixture.donorId })).toMatchObject({ status: "BLOCKED", changed: false });
    expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
  });

  it.each([false, true])("implicit donor verification requires proof for that same email (verified=%s)", async (verified) => {
    const fixture = await seedPhoneReference(false, true);
    fixture.profile.meta = { last_active: "2020-07-15T00:00:00Z" };
    fixture.profile.verified_data = verified ? { email: true } : {};
    const native = await EmailPassword.signUp("public", fixture.email, "password123!");
    if (native.status !== "OK") throw new Error("Native email creation failed");
    const token = await EmailVerification.createEmailVerificationToken("public", native.recipeUserId, fixture.email);
    if (token.status === "OK") await EmailVerification.verifyEmailUsingToken("public", token.token);
    await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(fixture.rowndId));
    await AccountLinking.linkAccounts(native.recipeUserId, fixture.rowndId);
    const writes = [vi.spyOn(AccountLinking, "linkAccounts"), vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(EmailVerification, "verifyEmailUsingToken")];
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: verified ? "OK" : "BLOCKED" });
    if (!verified) for (const write of writes) expect(write).not.toHaveBeenCalled();
    const donor = (await SuperTokens.getUser(fixture.donorId))!;
    expect(donor.loginMethods.find((method) => method.recipeUserId.getAsString() === fixture.donorId)).toMatchObject({ verified });
    expect(donor.id).toBe(verified ? fixture.rowndId : fixture.donorId);
  });

  it.each(["undefined", "404"])("required consolidation source disappearance (%s) blocks preview and execution", async (missing) => {
    const fixture = await seedPhoneReference(false, true);
    vi.spyOn(AccountLinking, "linkAccounts").mockRejectedValueOnce(new Error("link interrupted"));
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "ERROR", changed: true });
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => {
      if (user_id === fixture.rowndId) {
        if (missing === "404") throw { response: { statusCode: 404 } };
        return undefined;
      }
      return fixture.profiles.get(user_id);
    });
    const writes = await spyOnReconciliationWrites();
    const counts = writes.map((write) => write.mock.calls.length);
    for (const dryRun of [true, false]) {
      const result = await reconcileUser({ rownd_user_id: fixture.donorId, dryRun });
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false,
        unresolved_owners: expect.arrayContaining([expect.objectContaining({ rownd_user_id: fixture.rowndId })]) });
    }
    writes.forEach((write, index) => expect(write.mock.calls.length).toBe(counts[index]));
    expect((await SuperTokens.getUser(fixture.rowndId))!.id).toBe(fixture.rowndId);
    expect((await UserMetadata.getUserMetadata(fixture.donor.user.id)).metadata.rownd_migration_owner_consolidation).toMatchObject({ version: 2, status: expect.stringMatching(/^(READY|APPLYING|RECONCILING)$/) });
  });

  it.each(["activity", "mapping", "checkpoint"])("admin keeps its activity election but checks affected %s state before linking", async (drift) => {
    const fixture = await seedPhoneReference(false, true);
    const check = AccountLinking.canLinkAccounts.bind(AccountLinking);
    vi.spyOn(AccountLinking, "canLinkAccounts").mockImplementationOnce(async (...args) => {
      const result = await check(...args);
      if (drift === "activity") fixture.profile.meta = { last_active: "2020-07-15T00:00:00Z" };
      if (drift === "mapping") await SuperTokens.deleteUserIdMapping({ userId: fixture.rowndId, userIdType: "EXTERNAL", force: true });
      if (drift === "checkpoint") await UserMetadata.updateUserMetadata(fixture.donor.user.id, { rownd_migration_owner_consolidation: null });
      return result;
    });
    const link = vi.spyOn(AccountLinking, "linkAccounts");
    const verify = vi.spyOn(EmailVerification, "createEmailVerificationToken");
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    if (drift === "activity") {
      expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: fixture.donorId });
      expect(link).toHaveBeenCalled();
      expect((await SuperTokens.getUser(fixture.rowndId))!.id).toBe(fixture.donorId);
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: true, unresolved_owners: expect.any(Array) });
    expect(link).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(fixture.phone.user.id))!.isPrimaryUser).toBe(false);
  });

  it("owner consolidation cannot execute without its private fresh election", async () => {
    const fixture = await seedPhoneReference(false, true);
    const source = (await fetchAdministrativeMigrationSource(fixture.donorId, "public", {}))!;
    const input = { source, target: fixture.donor.user.id, tenantId: "public", userContext: {}, candidates: [
      { rownd_user_id: fixture.rowndId, supertokens_user_id: fixture.phone.user.id },
      { rownd_user_id: fixture.donorId, supertokens_user_id: fixture.donor.user.id },
    ] };
    const writes = await spyOnReconciliationWrites();
    expect(await prepareOwnerConsolidation({ ...input, source: { ...source } })).toBeUndefined();
    const plan = await prepareOwnerConsolidation(input);
    await expect(plan!.execute()).rejects.toThrow("the private election binding is missing");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("a winner JWT cannot publish a session while required owners are still separate", async () => {
    const fixture = await seedPhoneReference(false, true);
    vi.spyOn(AccountLinking, "linkAccounts").mockRejectedValueOnce(new Error("link interrupted"));
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "ERROR", changed: true });
    rownd.validateToken.mockResolvedValue({ user_id: fixture.donorId });
    const response = await fetch(`${baseUrl}/auth/plugin/rownd/migrate`, {
      method: "POST", headers: { Authorization: "Bearer fixture-token", "st-auth-mode": "header", rid: "session", "fdi-version": "1.18" },
    });
    expect(response.headers.get("st-access-token")).toBeNull();
    expect(await response.json()).toMatchObject({ status: "ERROR" });
    expect(await reconcileUser({ rownd_user_id: fixture.donorId })).toMatchObject({ status: "OK", changed: true });
  });

  it("admin elects a newer provenance-backed source before restoring its missing mapping", async () => {
    const fixture = await seedPhoneReference(false, true);
    await SuperTokens.deleteUserIdMapping({ userId: fixture.donorId, userIdType: "EXTERNAL", force: true });
    expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "PREVIEW", canReconcile: true,
      rownd_user_id: fixture.donorId, requested_rownd_user_id: fixture.rowndId, supertokens_user_id: fixture.donor.user.id });
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: fixture.donorId, supertokens_user_id: fixture.donor.user.id });
    expect((await SuperTokens.getUser(fixture.rowndId))!.loginMethods).toHaveLength(2);
    expect((await SuperTokens.getUser(fixture.donorId))!.loginMethods).toHaveLength(2);
  });

  it("admin checks the elected source's durable target in preview and execution", async () => {
    const fixture = await seedPhoneReference(false, true);
    await UserMetadata.updateUserMetadata(fixture.donorId, { rownd_migration_target: fixture.phone.user.id });
    expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", canReconcile: false,
      rownd_user_id: fixture.donorId, unresolved_owners: expect.any(Array) });
    const writes = await spyOnReconciliationWrites();
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", changed: false });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("admin imports an Apple source with an exact empty optional email without a Passwordless identity", async () => {
    const rowndId = `empty-email-${randomUUID()}`;
    const subject = `apple-${randomUUID()}`;
    const profile: RowndUser = { state: "enabled", data: { user_id: rowndId, email: "", apple_id: subject }, verified_data: { email: "", apple_id: subject } };
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    expect(await readOnlyPreview({ rownd_user_id: rowndId })).toMatchObject({ status: "PREVIEW", canReconcile: true });
    const result = await reconcileUser({ rownd_user_id: rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", changed: true });
    const user = (await SuperTokens.getUser(rowndId))!;
    expect(user.loginMethods).toHaveLength(1);
    expect(user.loginMethods[0]).toMatchObject({ recipeId: "thirdparty", thirdParty: { id: "apple", userId: subject }, verified: false });
    expect(isSuperTokensFakeEmail(user.loginMethods[0]!.email!)).toBe(true);
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "OK", changed: false });
  });

  it.each(["tie", "missing", "invalid", "future"])("admin ranks valid activity and uses the survivor canonical alias for a tie: %s", async (scenario) => {
    const fixture = await seedPhoneReference(false, true);
    fixture.donorProfile.meta = scenario === "missing" ? {} : { last_active: scenario === "tie" ? fixture.profile.meta!.last_active :
      scenario === "invalid" ? "2020-02-31T00:00:00.000Z" : "2999-01-01T00:00:00.000Z" };
    const winner = scenario === "tie" ? fixture.donorId : fixture.rowndId;
    expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "PREVIEW", canReconcile: true,
      rownd_user_id: winner, supertokens_user_id: fixture.donor.user.id,
      election: { candidates: expect.arrayContaining([expect.objectContaining({ rownd_user_id: fixture.rowndId }), expect.objectContaining({ rownd_user_id: fixture.donorId })]) } });
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "OK", changed: true,
      rownd_user_id: winner, supertokens_user_id: fixture.donor.user.id });
    expect(await SuperTokens.getUserIdMapping({ userId: winner, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.donor.user.id });
  });

  it.each([false, true])("admin re-elects from fresh activity after preview instead of applying a stale plan (publishedDonor=%s)", async (publishedDonor) => {
    const fixture = await seedPhoneReference(false, true);
    if (publishedDonor) await UserMetadata.updateUserMetadata(fixture.donorId, { rownd_migration_canonical_target: fixture.donor.user.id });
    expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ rownd_user_id: fixture.donorId });
    fixture.profile.meta = { last_active: "2020-07-14T00:00:00.000Z" };
    const preview = await readOnlyPreview({ rownd_user_id: fixture.rowndId });
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true, rownd_user_id: fixture.rowndId, blockers: [],
      proposedActions: expect.arrayContaining([expect.objectContaining({ action: "link_method", recipeUserId: fixture.phone.user.id })]) });
    const ev = [vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(EmailVerification, "verifyEmailUsingToken"), vi.spyOn(EmailVerification, "unverifyEmail")];
    const refreshed = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(refreshed, JSON.stringify(refreshed)).toMatchObject({ status: "OK", rownd_user_id: fixture.rowndId, supertokens_user_id: fixture.donor.user.id });
    for (const write of ev) expect(write).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(fixture.rowndId))!.loginMethods.find((method) => method.hasSameEmailAs(fixture.email))).toMatchObject({ verified: false });
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.donorId, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.phone.user.id });
  });

  it.each(["wrong target", "contradictory target"])("admin rejects a published donor with %s before dangerous writes", async (invalid) => {
    const fixture = await seedPhoneReference(false, true);
    fixture.profile.meta = { last_active: "2020-07-14T00:00:00.000Z" };
    await UserMetadata.updateUserMetadata(fixture.donorId, {
      rownd_migration_canonical_target: invalid === "wrong target" ? fixture.phone.user.id : fixture.donor.user.id,
      ...(invalid === "contradictory target" ? { rownd_migration_target: fixture.phone.user.id } : {}),
    });
    expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", canReconcile: false });
    const writes = await spyOnReconciliationWrites();
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", changed: false });
    for (const write of writes.filter((write) => !["reconcileRowndUserWithExistingLoginMethods", "finishProviderIntroductions", "prepareRowndProviderRetirement"].includes(write.getMockName()))) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.donorId, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.donor.user.id });
  });

  it.each([["activity", "reservation"], ["marker", "reservation"], ["activity", "promotion"], ["marker", "promotion"]])(
    "admin keeps its election and validates literal donor %s drift after %s", async (drift, checkpoint) => {
    const fixture = await seedPhoneReference(false, true);
    fixture.profile.meta = { last_active: "2020-07-14T00:00:00.000Z" };
    await UserMetadata.updateUserMetadata(fixture.donorId, { rownd_migration_canonical_target: fixture.donor.user.id });
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    const changeEvidence = async () => {
      if (drift === "activity") fixture.donorProfile.meta = { last_active: "2020-07-15T00:00:00.000Z" };
      else await update(fixture.donorId, { rownd_migration_canonical_target: fixture.phone.user.id });
    };
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, data, context) => {
      const result = await update(id, data, context);
      if (checkpoint === "reservation" && id === fixture.donor.user.id && data.rownd_migration_owner_consolidation !== undefined) await changeEvidence();
      return result;
    });
    const promote = AccountLinking.createPrimaryUser.bind(AccountLinking);
    vi.spyOn(AccountLinking, "createPrimaryUser").mockImplementation(async (...args) => {
      const result = await promote(...args);
      if (checkpoint === "promotion") await changeEvidence();
      return result;
    });
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: drift === "activity" ? "OK" : "BLOCKED" });
    if (drift === "activity") expect(result.rownd_user_id).toBe(fixture.rowndId);
    else expect((await UserMetadata.getUserMetadata(fixture.donor.user.id)).metadata.rownd_migration_owner_consolidation).not.toMatchObject({ status: "COMPLETE" });
  });

  it("admin executes its discovered election despite concurrent activity changes", async () => {
    const fixture = await seedPhoneReference(false, true);
    const election = await import("./migration-election");
    const assertElection = election.assertAdministrativeElection;
    vi.spyOn(election, "assertAdministrativeElection").mockImplementationOnce(async (source) => {
      fixture.profile.meta = { last_active: "2020-07-14T00:00:00.000Z" };
      await assertElection(source);
    });
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "OK", changed: true, rownd_user_id: fixture.donorId });
  });

  it.each(["identity", "owner", "tenant"])("admin detects changed affected evidence before completion: %s", async (change) => {
    const fixture = await seedPhoneReference(false, true);
    const election = await import("./migration-election");
    const assertElection = election.assertAdministrativeElection;
    vi.spyOn(election, "assertAdministrativeElection").mockImplementationOnce(async (source) => {
      if (change === "identity") fixture.profile.data.email = `${randomUUID()}@example.com`;
      else {
        const getUser = SuperTokens.getUser.bind(SuperTokens);
        vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id, context) => {
          const user = await getUser(id, context);
          if (id === fixture.phone.user.id && user) {
            if (change === "owner") user.id = "changed-owner";
            else for (const method of user.loginMethods) method.tenantIds = ["another-tenant"];
          }
          return user;
        });
      }
      await assertElection(source);
    });
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", partialProgress: true });
    expect((await UserMetadata.getUserMetadata(fixture.donor.user.id)).metadata.rownd_migration_owner_consolidation).not.toMatchObject({ status: "COMPLETE" });
  });

  it("public preview blocks a canonical pointer whose matching email method is absent from public", async () => {
    const fixture = await seedInvalidPublicCanonical();
    const before = (await SuperTokens.getUser(fixture.internalId))!.toJson();
    const metadata = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", canReconcile: false,
      blockers: [{ code: "CANONICAL_EMAIL_POLICY" }] });
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED",
      message: "CANONICAL_EMAIL_POLICY" });
    expect((await SuperTokens.getUser(fixture.internalId))!.toJson()).toEqual(before);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata).toEqual(metadata);
  });

  it.each([false, true])("public preview plans canonical publication onto a live same-email native owner (metadata=%s)", async (hasMetadata) => {
    const rowndId = `native-${randomUUID()}`;
    const email = `${randomUUID()}@example.com`;
    const native = await Passwordless.signInUp({ tenantId: "public", email });
    if (hasMetadata) await UserMetadata.updateUserMetadata(native.user.id, { native: true });
    rownd.fetchUserInfo.mockResolvedValue({ data: { user_id: rowndId, email }, verified_data: { email: true } });
    const before = (await SuperTokens.getUser(native.user.id))!.toJson();
    expect(await readOnlyPreview({ rownd_user_id: rowndId })).toMatchObject({ status: "PREVIEW", canReconcile: true,
      proposedActions: expect.arrayContaining([expect.objectContaining({ action: "create_mapping", supertokens_user_id: native.user.id })]),
      requiresExecutionProof: [] });
    expect((await SuperTokens.getUser(native.user.id))!.toJson()).toEqual(before);
    const publication = vi.spyOn(SuperTokens, "createUserIdMapping");
    const result = await reconcileUser({ rownd_user_id: rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: native.user.id });
    expect(publication).toHaveBeenCalledWith(expect.objectContaining({ superTokensUserId: native.user.id, externalUserId: rowndId, force: true }));
    if (hasMetadata) expect((await UserMetadata.getUserMetadata(native.user.id)).metadata).toMatchObject({ native: true });
  });

  it("bundled --dry-run uses only read-only Core requests, preserves profiles, and returns explicit preview exit codes", async () => {
    const exec = promisify(execFile);
    await exec("../../node_modules/.bin/tsup");
    const home = await mkdtemp(join(tmpdir(), "rownd-preview-cli-"));
    const fixture = await seed();
    const native = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@example.com` });
    await UserMetadata.updateUserMetadata(native.user.id, { native: true });
    const invalidCanonical = await seedInvalidPublicCanonical();
    const requested: Array<{ method: string; url: string }> = [];
    const proxy = createServer((req, res) => {
      requested.push({ method: req.method!, url: req.url! });
      const upstream = request(`http://${core.getHost()}:${core.getMappedPort(3567)}${req.url}`, { method: req.method, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      });
      upstream.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const run = async (args: string[], preload?: string) => {
      try {
        const output = await exec(process.execPath, ["dist/cli.js", ...args], { env: { ...process.env, TEST_MODE: "testing", HOME: home,
          ...(preload ? { NODE_OPTIONS: `--require=${preload}` } : {}) }, timeout: 15000 });
        return { ...output, code: 0 };
      } catch (error) { return error as { stdout: string; stderr: string; code: number }; }
    };
    try {
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("Missing proxy address");
      expect((await run(["profiles", "add", "--profile", "preview", "--app-id", "app", "--app-key", "preview-private-key",
        "--app-secret", "preview-private-secret", "--connection-uri", `http://127.0.0.1:${address.port}`])).code).toBe(0);
      const profilesPath = join(home, ".config", "rownd-nodejs", "profiles.json");
      await chmod(profilesPath, 0o640);
      const profiles = await readFile(profilesPath, "utf8");
      const profileStat = await stat(profilesPath);
      const preload = join(home, "rownd.cjs");
      const profilePath = join(home, "source.json");
      const rowndRequestsPath = join(home, "rownd-requests.jsonl");
      await writeFile(preload, `const Module = require('node:module');
const fs = require('node:fs');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  if (url.origin === ${JSON.stringify(`http://127.0.0.1:${address.port}`)}) return originalFetch(input, options);
  if (url.origin !== 'https://api.rownd.io' || !url.pathname.startsWith('/applications/app/users/') ||
      (options.method && options.method !== 'GET') || options.redirect !== 'error' ||
      options.headers['x-rownd-app-key'] !== 'preview-private-key' || options.headers['x-rownd-app-secret'] !== 'preview-private-secret') {
    throw new Error('unexpected administrative HTTP request');
  }
  fs.appendFileSync(${JSON.stringify(rowndRequestsPath)}, JSON.stringify({ method: options.method || 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams) }) + '\\n');
  const profile = JSON.parse(fs.readFileSync(${JSON.stringify(profilePath)}, 'utf8'));
  if (url.pathname === '/applications/app/users/data') {
    if (url.searchParams.get('lookup_filter') !== profile.data.email || url.searchParams.get('include_duplicates') !== 'true' ||
        url.searchParams.get('page_size') !== '100' || url.searchParams.get('sort') !== 'asc') throw new Error('unexpected lookup query');
    return Response.json({ total_results: 1, results: [{ data: { user_id: profile.data.user_id } }] });
  }
  return url.pathname === '/applications/app/users/' + encodeURIComponent(profile.data.user_id) + '/data'
    ? Response.json(profile) : new Response(null, { status: 404 });
};
const original = Module._load;
Module._load = function(id, ...args) {
  if (id === '@rownd/node') return { createInstance: () => ({
    validateToken: async () => { throw new Error('unexpected token'); },
    fetchUserInfo: async () => JSON.parse(require('node:fs').readFileSync(${JSON.stringify(profilePath)}, 'utf8'))
  }) };
  return original.call(this, id, ...args);
};`);
      const cases = [
        { profile: { data: { user_id: `new-${randomUUID()}`, email: `${randomUUID()}@example.com` }, verified_data: {} }, status: "PREVIEW", canReconcile: true, code: 0 },
        { profile: { ...fixture.original, verified_data: { email: true, apple_id: randomUUID() } }, status: "PREVIEW", canReconcile: false, code: 1 },
        { profile: { data: { user_id: `native-${randomUUID()}`, email: native.user.loginMethods[0].email }, verified_data: {} }, status: "PREVIEW", canReconcile: true, code: 0 },
        { profile: invalidCanonical.current, status: "BLOCKED", canReconcile: false, code: 1 },
        { profile: { data: { user_id: `native-${randomUUID()}`, email: native.user.loginMethods[0].email }, verified_data: { email: true } }, status: "PREVIEW", canReconcile: true, code: 0 },
        { profile: { data: { user_id: `email-discovery-${randomUUID()}`, email: native.user.loginMethods[0].email }, verified_data: { email: true } }, status: "PREVIEW", canReconcile: true, code: 0, emailSelector: true },
      ];
      for (const test of cases) {
        await writeFile(profilePath, JSON.stringify(test.profile));
        const selector = test.emailSelector ? ["--email", test.profile.data.email!] : ["--rownd-user-id", test.profile.data.user_id];
        const result = await run(["reconcile-user", "--profile", "preview", ...selector, "--dry-run"], preload);
        expect(result.code, result.stderr + result.stdout).toBe(test.code);
        expect(JSON.parse(result.stdout)).toMatchObject({ status: test.status, canReconcile: test.canReconcile, dryRun: true, changed: false, actions: [], snapshotOnly: true });
        expect(result.stdout + result.stderr).not.toContain("preview-private");
      }
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.filter(({ method }) => method !== "GET")).toEqual([]);
      const rowndRequests = (await readFile(rowndRequestsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(rowndRequests.every(({ method }) => method === "GET")).toBe(true);
      expect(rowndRequests.some(({ path, query }) => path === "/applications/app/users/data" && query.lookup_filter === native.user.loginMethods[0].email)).toBe(true);
      expect(await readFile(profilesPath, "utf8")).toBe(profiles);
      const after = await stat(profilesPath);
      expect(after.mode).toBe(profileStat.mode);
      expect(after.mtimeMs).toBe(profileStat.mtimeMs);
      expect(after.ctimeMs).toBe(profileStat.ctimeMs);
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }, 30000);

  it.each(["missing", "inactive", "malformed", "transport", "proof drift"])("dry run preserves failure semantics without writes: %s", async (scenario) => {
    const rowndId = `preview-${randomUUID()}`;
    const profile: RowndUser = { data: { user_id: rowndId, email: `${randomUUID()}@example.com` }, verified_data: { email: true } };
    rownd.fetchUserInfo.mockResolvedValue(profile);
    if (scenario === "missing") rownd.fetchUserInfo.mockResolvedValue(undefined);
    if (scenario === "inactive") rownd.fetchUserInfo.mockResolvedValue({ ...profile, state: "disabled" });
    if (scenario === "malformed") rownd.fetchUserInfo.mockResolvedValue({ ...profile, data: { ...profile.data, phone_number: [] } });
    if (scenario === "transport") rownd.fetchUserInfo.mockRejectedValue(new Error("Core unavailable"));
    if (scenario === "proof drift") rownd.fetchUserInfo.mockResolvedValue({ ...profile, verified_data: {} }).mockResolvedValueOnce(profile);
    expect(await readOnlyPreview({ rownd_user_id: rowndId })).toMatchObject({ canReconcile: scenario === "proof drift",
      status: scenario === "proof drift" ? "PREVIEW" : scenario === "missing" ? "NOT_FOUND" : scenario === "transport" ? "ERROR" : "BLOCKED" });
    if (scenario === "proof drift") expect(rownd.fetchUserInfo).toHaveBeenCalledOnce();
  });

  it.each([false, true])("dry run applies the shared donor linking policy (primary=%s)", async (primary) => {
    const fixture = await seed(true);
    if (primary) await AccountLinking.createPrimaryUser(fixture.separate!.recipeUserId);
    const before = (await SuperTokens.getUser(fixture.separate!.user.id))!.toJson();
    const result = await readOnlyPreview({ rownd_user_id: fixture.rowndId });
    expect(result).toMatchObject({ status: "PREVIEW", canReconcile: true, supertokens_user_id: fixture.separate!.user.id, proposedActions: expect.arrayContaining([
      expect.objectContaining({ action: "link_method", recipeUserId: fixture.internalId }),
    ]) });
    expect((await SuperTokens.getUser(fixture.separate!.user.id))!.toJson()).toEqual(before);
  });

  it("dry run proposes an import without creating any Core state", async () => {
    const rowndId = `preview-${randomUUID()}`;
    rownd.fetchUserInfo.mockResolvedValue({ data: { user_id: rowndId, email: `${randomUUID()}@example.com`, apple_id: randomUUID() }, verified_data: { email: true } });
    const writes = await spyOnReconciliationWrites();
    expect(await reconcileUser({ rownd_user_id: rowndId, dryRun: true })).toMatchObject({ status: "PREVIEW", dryRun: true, changed: false,
      actions: [], canReconcile: true, matchesSource: false, snapshotOnly: true, proposedActions: [{ action: "import_user" }], missingMethods: expect.any(Array) });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(await SuperTokens.getUser(rowndId)).toBeUndefined();
    expect((await UserMetadata.getUserMetadata(rowndId)).metadata).toEqual({});
  });

  it.each(["rownd", "email", "recipe"])("dry run reports a healthy no-op using %s selector", async (selector) => {
    const fixture = await seed();
    expect((await reconcileUser({ rownd_user_id: fixture.rowndId })).status).toBe("OK");
    const before = (await SuperTokens.getUser(fixture.internalId))!.toJson();
    const metadata = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    const writes = await spyOnReconciliationWrites();
    const input = selector === "rownd" ? { rownd_user_id: fixture.rowndId } : selector === "email" ? { email: fixture.email }
      : { supertokens_user_id: before.loginMethods.find((method) => method.recipeId === "passwordless")!.recipeUserId };
    expect(await reconcileUser({ ...input, dryRun: true })).toMatchObject({ status: "PREVIEW", canReconcile: true, matchesSource: true,
      dryRun: true, changed: false, actions: [], proposedActions: [], missingMethods: [], blockers: [] });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(fixture.internalId))!.toJson()).toEqual(before);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata).toEqual(metadata);
  });

  it("dry run proposes adding a missing method, without election, creation or linking", async () => {
    const rowndId = `preview-${randomUUID()}`;
    const profile: RowndUser = { data: { user_id: rowndId, email: `${randomUUID()}@example.com` }, verified_data: { email: true } };
    rownd.fetchUserInfo.mockResolvedValue(profile);
    expect((await reconcileUser({ rownd_user_id: rowndId })).status).toBe("OK");
    profile.data.google_id = randomUUID();
    const writes = await spyOnReconciliationWrites();
    expect(await reconcileUser({ rownd_user_id: rowndId, dryRun: true })).toMatchObject({ status: "PREVIEW", canReconcile: true,
      dryRun: true, changed: false, proposedActions: expect.arrayContaining([expect.objectContaining({ action: "create_method", method: expect.objectContaining({ thirdPartyId: "google" }) })]),
      missingMethods: [expect.objectContaining({ thirdPartyId: "google" })] });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(rowndId))!.loginMethods).toHaveLength(1);
  });

  it("dry run describes provider replacement as conditional without running retirement checkpoints or revocations", async () => {
    const fixture = await seed();
    const session = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.relayId));
    rownd.fetchUserInfo.mockResolvedValue({ ...fixture.original, verified_data: { email: true, apple_id: randomUUID() } });
    const before = (await SuperTokens.getUser(fixture.internalId))!.toJson();
    const metadata = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    const writes = await spyOnReconciliationWrites();
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId, dryRun: true })).toMatchObject({ status: "PREVIEW", canReconcile: false, changed: false,
      proposedActions: expect.arrayContaining([expect.objectContaining({ action: "review_provider_retirement", conditional: true })]),
      requiresExecutionProof: expect.arrayContaining([{ code: "PROVIDER_RETIREMENT_PROOF_REQUIRED", recipeUserId: fixture.rowndId }]) });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(fixture.internalId))!.toJson()).toEqual(before);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata).toEqual(metadata);
    expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
  });

  it.each(["revocation", "introduction"])("dry run detects outstanding provider %s checkpoints outside the primary metadata index", async (checkpoint) => {
    const fixture = await seed();
    expect((await reconcileUser({ rownd_user_id: fixture.rowndId })).status).toBe("OK");
    const ledgerId = checkpoint === "revocation" ? `rownd-provider-revocations-${createHash("sha256").update(JSON.stringify([fixture.internalId, "public"])).digest("hex")}` : fixture.rowndId;
    const ledger = { [checkpoint === "revocation" ? "pending" : "rownd_migration_provider_introduction"]: {
      internalUserId: fixture.internalId, tenantId: "public", rowndUserId: fixture.rowndId, created: false,
      recipeUserId: checkpoint === "revocation" ? randomUUID() : fixture.internalId, provider: "apple", subject: fixture.appleId } };
    await UserMetadata.updateUserMetadata(ledgerId, ledger);
    const before = (await UserMetadata.getUserMetadata(ledgerId)).metadata;
    const session = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.rowndId));
    expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "PREVIEW", canReconcile: false, matchesSource: false,
      requiresExecutionProof: [{ code: "MIGRATION_CHECKPOINT_REVIEW_REQUIRED" }] });
    expect((await UserMetadata.getUserMetadata(ledgerId)).metadata).toEqual(before);
    expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
  });

  it.each(["email", "phone"])("admin requires exact current email authority when adopting a native primary (%s)", async (contact) => {
    const email = `${randomUUID()}@example.com`;
    const phoneNumber = `+1555${Math.floor(Math.random() * 10000000).toString().padStart(7, "0")}`;
    const victim = await Passwordless.signInUp({ tenantId: "public", ...(contact === "email" ? { email } : { phoneNumber }) });
    await AccountLinking.createPrimaryUser(victim.recipeUserId);
    const profile: RowndUser = { state: "enabled", data: { user_id: `rownd-${randomUUID()}`, ...(contact === "email" ? { email } : { phone_number: phoneNumber }), google_id: randomUUID() }, verified_data: {} };
    rownd.fetchUserInfo.mockResolvedValue(profile);
    const writes = [vi.spyOn(SuperTokens, "createUserIdMapping"), vi.spyOn(AccountLinking, "createPrimaryUser"),
      vi.spyOn(AccountLinking, "linkAccounts"), vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser"), vi.spyOn(Passwordless, "signInUp")];
    const result = await reconcileUser({ rownd_user_id: profile.data.user_id });
    if (contact === "email") {
      expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", changed: true, supertokens_user_id: victim.user.id });
      expect((await SuperTokens.getUser(victim.user.id))!.loginMethods.some((method) => method.hasSameEmailAs(email))).toBe(true);
    } else {
      expect(result).toMatchObject({ status: "BLOCKED", changed: false });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
    }
    expect((await SuperTokens.getUser(victim.user.id))!.loginMethods).toHaveLength(contact === "email" ? 2 : 1);
  });

  it("admin keeps the pinned owner when its alias moves during final observation", async () => {
    const fixture = await seed();
    const other = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", randomUUID(), `${randomUUID()}@example.com`, false);
    if (other.status !== "OK") throw new Error("Failed to seed other owner");
    const otherId = other.recipeUserId.getAsString();
    const beforeOther = JSON.stringify(await SuperTokens.getUser(otherId));
    rownd.fetchUserInfo.mockResolvedValueOnce(fixture.current).mockImplementationOnce(async () => {
      await SuperTokens.deleteUserIdMapping({ userId: fixture.rowndId, userIdType: "EXTERNAL", force: true });
      await SuperTokens.createUserIdMapping({ superTokensUserId: otherId, externalUserId: fixture.rowndId });
      return fixture.current;
    });
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", supertokens_user_id: fixture.internalId, changed: null, partialProgress: true });
    expect(result.message).toBe("Migrated user mapping postcondition failed");
    await SuperTokens.deleteUserIdMapping({ userId: fixture.rowndId, userIdType: "EXTERNAL", force: true });
    expect(JSON.stringify(await SuperTokens.getUser(otherId))).toBe(beforeOther);
  });

  it("admin final alias observation cannot replace the validated owner", async () => {
    const fixture = await seed();
    await reconcileUser({ rownd_user_id: fixture.rowndId });
    const other = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@example.com` });
    const postconditions = await import("./migration-postconditions");
    const assertPostconditions = postconditions.assertMigrationPostconditions;
    vi.spyOn(postconditions, "assertMigrationPostconditions").mockImplementation(async (input) => {
      await assertPostconditions(input);
      await SuperTokens.deleteUserIdMapping({ userId: fixture.rowndId, userIdType: "EXTERNAL", force: true });
      await SuperTokens.createUserIdMapping({ superTokensUserId: other.recipeUserId.getAsString(), externalUserId: fixture.rowndId });
    });
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(result).toMatchObject({ status: "BLOCKED", supertokens_user_id: fixture.internalId, changed: null });
    expect(result.observationError).toContain("target changed");
  });

  it.each(["throws", "missing"])("admin preserves mutation failure when final observation %s", async (observation) => {
    const fixture = await seed();
    const getUser = SuperTokens.getUser.bind(SuperTokens);
    let failed = false;
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async () => {
      failed = true;
      throw new Error("original write failure");
    });
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (...args) => {
      if (failed) {
        if (observation === "missing") return undefined;
        throw new Error("observation unavailable");
      }
      return getUser(...args);
    });
    const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ERROR", changed: null, partialProgress: true, message: "original write failure",
      observationError: observation === "missing" ? "Pinned reconciliation owner disappeared during final observation" : "observation unavailable" });
  });

  it("admin reports exact no-op after reconciliation", async () => {
    const fixture = await seed();
    expect((await reconcileUser({ rownd_user_id: fixture.rowndId })).status).toBe("OK");
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "OK", changed: false, actions: [] });
    expect(rownd.validateToken).not.toHaveBeenCalled();
  });

  it("admin resolves a linked secondary recipe selector to its primary owner", async () => {
    const fixture = await seed();
    expect((await SuperTokens.getUser(fixture.rowndId))!.loginMethods[0].recipeUserId.getAsString()).not.toBe(fixture.relayId);
    const result = await reconcileUser({ supertokens_user_id: fixture.relayId });
    expect(result).toMatchObject({ status: "OK", rownd_user_id: fixture.rowndId, supertokens_user_id: fixture.internalId });
  });

  it.each(["supertokens", "rownd", "linked-alias"])("admin rejects conflicting live sources on one owner using %s selector", async (selector) => {
    const fixture = await seed();
    const conflictingId = `rownd-${randomUUID()}`;
    await UserMetadata.updateUserMetadata(fixture.relayId, { original_rownd_user: { ...fixture.original, data: { ...fixture.original.data, user_id: conflictingId } } });
    if (selector === "linked-alias") await SuperTokens.createUserIdMapping({ superTokensUserId: fixture.relayId, externalUserId: `unrelated-alias-${randomUUID()}`, force: true });
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === conflictingId
      ? { ...fixture.original, data: { ...fixture.original.data, user_id: conflictingId } } : user_id === fixture.rowndId ? fixture.current : undefined);
    const writes = [vi.spyOn(UserMetadata, "updateUserMetadata"), vi.spyOn(AccountLinking, "linkAccounts"), vi.spyOn(SuperTokens, "createUserIdMapping")];
    const result = await reconcileUser(selector === "rownd" ? { rownd_user_id: fixture.rowndId } : { supertokens_user_id: fixture.internalId });
    expect(result).toMatchObject({ status: "BLOCKED", changed: false });
    expect(result.election?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ rownd_user_id: fixture.rowndId, supertokens_user_id: fixture.internalId }),
      expect.objectContaining({ rownd_user_id: conflictingId, supertokens_user_id: fixture.internalId }),
    ]));
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("admin does not interpret failed linked-alias discovery as absence", async () => {
    const fixture = await seed();
    const alias = `linked-${randomUUID()}`;
    await SuperTokens.createUserIdMapping({ superTokensUserId: fixture.relayId, externalUserId: alias, force: true });
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => {
      if (user_id === alias) throw new Error("Rownd lookup unavailable");
      return fixture.current;
    });
    const writes = [vi.spyOn(UserMetadata, "updateUserMetadata"), vi.spyOn(AccountLinking, "linkAccounts")];
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "ERROR", changed: false, message: "Rownd lookup unavailable" });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("admin rejects a partly valid source payload before any identity or verification writes", async () => {
    const fixture = await seed();
    rownd.fetchUserInfo.mockResolvedValue({ ...fixture.current, data: { ...fixture.current.data, google_id: [] } });
    const repository = await import("./supertokens-repository");
    const writes = [vi.spyOn(repository, "importUser"), vi.spyOn(UserMetadata, "updateUserMetadata"), vi.spyOn(AccountLinking, "linkAccounts"),
      vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(SuperTokens, "createUserIdMapping")];
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", changed: false, message: "SOURCE_PAYLOAD_INVALID: data.google_id" });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("admin resolves dynamic configuration once for a non-public tenant", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    await Multitenancy.createOrUpdateTenant(tenantId, { firstFactors: ["link-email"] });
    const config = getPluginConfig()!;
    const resolveConfig = vi.fn().mockResolvedValue({});
    setPluginConfig({ ...config, resolveConfig });
    const email = `${randomUUID()}@example.com`;
    const rowndId = `rownd-${randomUUID()}`;
    rownd.fetchUserInfo.mockResolvedValue({ state: "enabled", data: { user_id: rowndId, email }, verified_data: { email: true } });
    try {
      const result = await reconcileUser({ rownd_user_id: rowndId, tenantId, userContext: { requestId: "admin-test" } });
      expect(result, result.message).toMatchObject({ status: "OK", changed: true });
      expect(resolveConfig).toHaveBeenCalledTimes(1);
      expect(resolveConfig).toHaveBeenCalledWith(expect.objectContaining({ tenantId, userContext: expect.objectContaining({ requestId: "admin-test" }) }));
      expect((await SuperTokens.getUser(rowndId))!.tenantIds).toEqual([tenantId]);
    } finally {
      setPluginConfig(config);
    }
  });

  it.each([undefined, { response: { statusCode: 404 } }])("admin reports authoritative missing Rownd source as NOT_FOUND (%j)", async (failure) => {
    if (failure) rownd.fetchUserInfo.mockRejectedValue(failure);
    else rownd.fetchUserInfo.mockResolvedValue(undefined);
    expect(await reconcileUser({ rownd_user_id: `missing-${randomUUID()}` })).toMatchObject({ status: "NOT_FOUND", changed: false });
  });

  it("admin reports an inactive source as BLOCKED before mutations", async () => {
    const fixture = await seed();
    rownd.fetchUserInfo.mockResolvedValue({ ...fixture.current, state: "disabled" });
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", changed: false, partialProgress: false });
  });

  it("admin reports a superseded source as BLOCKED before mutations", async () => {
    const rowndId = `superseded-${randomUUID()}`;
    await UserMetadata.updateUserMetadata(rowndId, { rownd_migration_superseded: { rowndUserId: "winner" } });
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "BLOCKED", changed: false, partialProgress: false });
    expect(rownd.fetchUserInfo).not.toHaveBeenCalled();
  });

  it("admin reports changed server email proof as BLOCKED", async () => {
    const fixture = await seed();
    rownd.fetchUserInfo.mockResolvedValueOnce(fixture.current).mockResolvedValue({ ...fixture.current, verified_data: { apple_id: fixture.appleId } });
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", changed: true, partialProgress: true, message: "Rownd verified email proof changed before reconciliation completion" });
  });

  it("admin never interprets a Core transport 404 as source absence", async () => {
    const error = Object.assign(new Error("Core unavailable"), { response: { statusCode: 404 } });
    vi.spyOn(UserMetadata, "getUserMetadata").mockRejectedValue(error);
    expect(await reconcileUser({ rownd_user_id: `rownd-${randomUUID()}` })).toMatchObject({ status: "ERROR", changed: false, partialProgress: false, message: "Core unavailable" });
  });

  it("admin pins the immutable bulk-import owner before a changed alias is read", async () => {
    const rowndId = `rownd-${randomUUID()}`;
    const email = `${randomUUID()}@example.com`;
    rownd.fetchUserInfo.mockResolvedValue({ state: "enabled", data: { user_id: rowndId, email }, verified_data: { email: true } });
    const other = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@example.com` });
    let otherBefore = (await SuperTokens.getUser(other.user.id))!.toJson();
    const otherMetadata = (await UserMetadata.getUserMetadata(other.user.id)).metadata;
    const repository = await import("./supertokens-repository");
    const bulkImport = repository.importUser;
    let importedId: string | undefined;
    vi.spyOn(repository, "importUser").mockImplementation(async (...args) => {
      const imported = await bulkImport(...args);
      importedId = imported.id;
      expect(importedId).not.toBe(rowndId);
      expect(await SuperTokens.getUser(rowndId)).toBeUndefined();
      await SuperTokens.createUserIdMapping({ superTokensUserId: other.recipeUserId.getAsString(), externalUserId: rowndId });
      otherBefore = (await SuperTokens.getUser(other.user.id))!.toJson();
      return imported;
    });
    const result = await reconcileUser({ rownd_user_id: rowndId });
    expect(importedId).toBeDefined();
    expect(result).toMatchObject({ status: "BLOCKED", supertokens_user_id: importedId, changed: null, message: "The reconciliation target changed" });
    expect((await SuperTokens.getUser(other.user.id))!.toJson()).toEqual(otherBefore);
    expect((await UserMetadata.getUserMetadata(other.user.id)).metadata).toEqual(otherMetadata);
  });

  it.each(["publication failure", "removed mapping"].flatMap((scenario) =>
    ["email", "phone", "email+phone", "email+provider"].flatMap((shape) =>
      [false, true].map((verified) => ({ scenario, shape, verified }))),
  ))("admin restores the same imported owner after $scenario ($shape, verified=$verified)", async ({ scenario, shape, verified }) => {
    const rowndId = `rownd-${randomUUID()}`;
    const profile: RowndUser = { data: { user_id: rowndId,
      ...(shape.includes("email") ? { email: `${randomUUID()}@example.com` } : {}),
      ...(shape.includes("phone") ? { phone_number: `+1555${Math.floor(Math.random() * 10000000).toString().padStart(7, "0")}` } : {}),
      ...(shape.includes("provider") ? { google_id: randomUUID() } : {}),
    }, verified_data: { email: verified, phone_number: verified } };
    rownd.fetchUserInfo.mockResolvedValue(profile);
    const repository = await import("./supertokens-repository");
    const bulkImport = vi.spyOn(repository, "importUser");
    if (scenario === "publication failure") vi.spyOn(SuperTokens, "createUserIdMapping").mockRejectedValueOnce(new Error("publication interrupted"));
    const first = await reconcileUser({ rownd_user_id: rowndId });
    expect(first).toMatchObject({ status: scenario === "publication failure" ? "ERROR" : "OK", supertokens_user_id: expect.any(String) });
    const internalId = first.supertokens_user_id!;
    expect(internalId).not.toBe(rowndId);
    expect((await SuperTokens.getUser(internalId))!.loginMethods).toHaveLength(shape.includes("+") ? 2 : 1);
    if (scenario === "removed mapping") await SuperTokens.deleteUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL", force: true });
    expect(await SuperTokens.getUser(rowndId)).toBeUndefined();
    const preview = await readOnlyPreview({ rownd_user_id: rowndId });
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true, supertokens_user_id: internalId,
      proposedActions: expect.arrayContaining([expect.objectContaining({ action: "create_mapping", supertokens_user_id: internalId })]) });
    const retry = await reconcileUser({ rownd_user_id: rowndId });
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", supertokens_user_id: internalId });
    expect(bulkImport).toHaveBeenCalledTimes(1);
    expect(bulkImport.mock.calls[0][0].externalUserId).toBeUndefined();
    const imported = await bulkImport.mock.results[0].value;
    const user = (await SuperTokens.getUser(rowndId))!;
    const recipeIds = await Promise.all(user.loginMethods.map(async (method) => {
      const mapping = await SuperTokens.getUserIdMapping({ userId: method.recipeUserId.getAsString(), userIdType: "EXTERNAL" });
      return mapping.status === "OK" ? mapping.superTokensUserId : method.recipeUserId.getAsString();
    }));
    expect(recipeIds.sort()).toEqual(imported.loginMethods.map((method: { recipeUserId: string }) => method.recipeUserId).sort());
    expect(await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: internalId });
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "OK", changed: false });
    expect(bulkImport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ...["live conflict", "unrelated alias", "retired donor"].map((secondary) => ({ secondary, marker: undefined, wrongProvenance: false })),
    ...["rownd_migration_target", "rownd_migration_canonical_target"].flatMap((marker) =>
      [false, true].map((wrongProvenance) => ({ secondary: "retired donor", marker, wrongProvenance }))),
  ])("admin checks linked sources before recovery: $secondary, marker=$marker, wrongProvenance=$wrongProvenance", async ({ secondary, marker, wrongProvenance }) => {
    const rowndId = `rownd-${randomUUID()}`;
    const otherRowndId = `other-${randomUUID()}`;
    const profile: RowndUser = { data: { user_id: rowndId, email: `${randomUUID()}@example.com`, google_id: randomUUID() }, verified_data: { email: true } };
    rownd.fetchUserInfo.mockResolvedValue(profile);
    const publication = vi.spyOn(SuperTokens, "createUserIdMapping").mockRejectedValueOnce(new Error("publication interrupted"));
    const first = await reconcileUser({ rownd_user_id: rowndId });
    expect(first).toMatchObject({ status: "ERROR", message: "publication interrupted" });
    const internalId = first.supertokens_user_id!;
    const user = (await SuperTokens.getUser(internalId))!;
    const recipeId = user.loginMethods.find((method) => method.recipeId === "passwordless")!.recipeUserId.getAsString();
    expect(recipeId).not.toBe(internalId);
    const otherProfile: RowndUser = { data: { user_id: otherRowndId, email: profile.data.email }, verified_data: { email: true } };
    if (secondary === "unrelated alias") await SuperTokens.createUserIdMapping({ superTokensUserId: recipeId, externalUserId: otherRowndId, force: true });
    else await UserMetadata.updateUserMetadata(recipeId, { original_rownd_user: otherProfile });
    if (secondary === "retired donor") await UserMetadata.updateUserMetadata(otherRowndId, { rownd_migration_superseded: { rowndUserId: rowndId, targetUserId: internalId } });
    if (marker) await UserMetadata.updateUserMetadata(rowndId, { [marker]: internalId });
    if (wrongProvenance) await UserMetadata.updateUserMetadata(internalId, { original_rownd_user: otherProfile });
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile :
      user_id === otherRowndId && secondary !== "unrelated alias" ? otherProfile : undefined);
    publication.mockClear();
    const repository = await import("./supertokens-repository");
    const introduction = await import("./migration-provider");
    const finishIntroductions = vi.spyOn(introduction, "finishProviderIntroductions");
    const bulkImport = vi.spyOn(repository, "importUser");
    const writes = [publication, bulkImport, vi.spyOn(UserMetadata, "updateUserMetadata"), vi.spyOn(AccountLinking, "linkAccounts"),
      vi.spyOn(SuperTokens, "deleteUserIdMapping"), vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(EmailVerification, "verifyEmailUsingToken")];
    const preview = await readOnlyPreview({ rownd_user_id: rowndId });
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: wrongProvenance || secondary === "live conflict" ? "AMBIGUOUS" : secondary === "unrelated alias" ? "BLOCKED" : "PREVIEW",
      canReconcile: !wrongProvenance && secondary !== "live conflict" && secondary !== "unrelated alias" });
    const result = await reconcileUser({ rownd_user_id: rowndId });
    if (wrongProvenance || secondary === "unrelated alias") {
      expect(result).toMatchObject({ status: wrongProvenance ? "AMBIGUOUS" : "BLOCKED", changed: false });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(finishIntroductions).not.toHaveBeenCalled();
    } else if (secondary === "live conflict") {
      expect(result, JSON.stringify(result)).toMatchObject({ status: "AMBIGUOUS", changed: false, candidates: expect.arrayContaining([
        { rownd_user_id: rowndId, supertokens_user_id: internalId },
        { rownd_user_id: otherRowndId, supertokens_user_id: internalId },
      ]) });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(finishIntroductions).not.toHaveBeenCalled();
      expect((await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL" })).status).toBe("UNKNOWN_MAPPING_ERROR");
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: internalId });
      expect(bulkImport).not.toHaveBeenCalled();
      expect((await SuperTokens.getUser(internalId))!.loginMethods).toHaveLength(2);
    }
  });

  it.each(["phone", "email+phone"])("admin requires live email authority to adopt an unverified native owner (%s)", async (shape) => {
    const rowndId = `rownd-${randomUUID()}`;
    const profile: RowndUser = { data: { user_id: rowndId,
      ...(shape.includes("email") ? { email: `${randomUUID()}@example.com` } : {}),
      ...(shape.includes("phone") ? { phone_number: `+1555${Math.floor(Math.random() * 10000000).toString().padStart(7, "0")}` } : {}),
    }, verified_data: {} };
    const native = await importUser({ ...mapRowndUserToSuperTokens(profile, "public"), externalUserId: undefined, userMetadata: { native: true } },
      { connectionURI: `http://${core.getHost()}:${core.getMappedPort(3567)}` });
    rownd.fetchUserInfo.mockResolvedValue(profile);
    const before = (await SuperTokens.getUser(native.id))!.toJson();
    const writes = [vi.spyOn(SuperTokens, "createUserIdMapping"), vi.spyOn(UserMetadata, "updateUserMetadata"), vi.spyOn(AccountLinking, "linkAccounts"),
      vi.spyOn(EmailVerification, "createEmailVerificationToken")];
    if (shape === "email+phone") {
      expect(await readOnlyPreview({ rownd_user_id: rowndId })).toMatchObject({ status: "PREVIEW", canReconcile: true });
      expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "OK", supertokens_user_id: native.id });
      expect((await SuperTokens.getUser(native.id))!.loginMethods.find((method) => method.hasSameEmailAs(profile.data.email!))).toMatchObject({ verified: false });
      expect((await UserMetadata.getUserMetadata(native.id)).metadata).toMatchObject({ native: true });
    } else {
      expect(await readOnlyPreview({ rownd_user_id: rowndId })).toMatchObject({ status: "BLOCKED", canReconcile: false });
      expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "BLOCKED", changed: false });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect((await SuperTokens.getUser(native.id))!.toJson()).toEqual(before);
    }
  });

  it.each(["owner", "historical alias"])("admin distinguishes optional deleted history from contradictory alias provenance (%s)", async (conflict) => {
    const rowndId = `rownd-${randomUUID()}`;
    const profile: RowndUser = { data: { user_id: rowndId, email: `${randomUUID()}@example.com`, google_id: randomUUID() }, verified_data: { email: true } };
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    const publication = vi.spyOn(SuperTokens, "createUserIdMapping").mockRejectedValueOnce(new Error("publication interrupted"));
    const first = await reconcileUser({ rownd_user_id: rowndId });
    expect(first).toMatchObject({ status: "ERROR", message: "publication interrupted" });
    const internalId = first.supertokens_user_id!;
    await UserMetadata.updateUserMetadata(conflict === "owner" ? internalId : rowndId, { original_rownd_user: {
      ...profile, data: { ...profile.data, ...(conflict === "owner" ? { user_id: `other-${randomUUID()}` } : { email: `${randomUUID()}@example.com` }) },
    } });
    publication.mockClear();
    const repository = await import("./supertokens-repository");
    const writes = [publication, vi.spyOn(repository, "importUser"), vi.spyOn(UserMetadata, "updateUserMetadata"),
      vi.spyOn(AccountLinking, "linkAccounts"), vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(EmailVerification, "verifyEmailUsingToken")];
    if (conflict === "owner") {
      expect(await readOnlyPreview({ rownd_user_id: rowndId })).toMatchObject({ status: "PREVIEW", canReconcile: true });
      const result = await reconcileUser({ rownd_user_id: rowndId });
      expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: internalId });
      expect(await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: internalId });
      expect(writes[1]).not.toHaveBeenCalled();
      return;
    }
    expect(await readOnlyPreview({ rownd_user_id: rowndId })).toMatchObject({ status: "BLOCKED", canReconcile: false });
    const result = await reconcileUser({ rownd_user_id: rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED",
      message: "Contradictory historical snapshots cannot authorize mapping restoration" });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect((await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL" })).status).toBe("UNKNOWN_MAPPING_ERROR");
  });

  it.each(["mapping", "provenance"])("admin blocks a dangling %s target before import or metadata writes", async (kind) => {
    const rowndId = `rownd-${randomUUID()}`;
    const missingId = randomUUID();
    rownd.fetchUserInfo.mockResolvedValue({ data: { user_id: rowndId, email: `${randomUUID()}@example.com` }, verified_data: { email: true } });
    if (kind === "provenance") await UserMetadata.updateUserMetadata(rowndId, { rownd_migration_target: missingId });
    else {
      const lookup = SuperTokens.getUserIdMapping.bind(SuperTokens);
      vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async (input) => input.userId === rowndId && input.userIdType === "EXTERNAL"
        ? { status: "OK", superTokensUserId: missingId, externalUserId: rowndId } : lookup(input));
    }
    const repository = await import("./supertokens-repository");
    const writes = [vi.spyOn(repository, "importUser"), vi.spyOn(UserMetadata, "updateUserMetadata"), vi.spyOn(SuperTokens, "createUserIdMapping")];
    expect(await readOnlyPreview({ rownd_user_id: rowndId })).toMatchObject({ status: "BLOCKED", canReconcile: false });
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "BLOCKED", changed: false, message: expect.stringContaining("MAPPING_TARGET_MISSING") });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("admin accepts a self-ID primary anchor without creating a self-mapping", async () => {
    const email = `${randomUUID()}@example.com`;
    const target = await Passwordless.signInUp({ tenantId: "public", email });
    await AccountLinking.createPrimaryUser(target.recipeUserId);
    const rowndId = target.user.id;
    const profile = { data: { user_id: rowndId, email }, verified_data: { email: true } };
    await UserMetadata.updateUserMetadata(rowndId, { original_rownd_user: profile, rownd_migration_complete: true });
    rownd.fetchUserInfo.mockResolvedValue(profile);
    const mapping = vi.spyOn(SuperTokens, "createUserIdMapping");
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "OK", supertokens_user_id: rowndId, changed: false });
    expect(mapping).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(rowndId))!.loginMethods).toHaveLength(1);
  });

  it.each(["rownd", "email", "secondary recipe"])("admin blocks dual namespace owners before writes using %s selector", async (selector) => {
    const fixture = await seed();
    const lookup = SuperTokens.getUserIdMapping.bind(SuperTokens);
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async (input) => input.userId === fixture.rowndId && input.userIdType === "SUPERTOKENS"
      ? { status: "OK", superTokensUserId: fixture.rowndId, externalUserId: "other-alias" } : lookup(input));
    expect(fixture.relayId).not.toBe(fixture.internalId);
    expect((await SuperTokens.getUser(fixture.relayId))!.id).toBe(fixture.rowndId);
    const writes = [vi.spyOn(UserMetadata, "updateUserMetadata"), vi.spyOn(AccountLinking, "linkAccounts"),
      vi.spyOn(SuperTokens, "createUserIdMapping"), vi.spyOn(SuperTokens, "deleteUserIdMapping"),
      vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(EmailVerification, "verifyEmailUsingToken"), vi.spyOn(EmailVerification, "unverifyEmail")];
    const input = selector === "rownd" ? { rownd_user_id: fixture.rowndId }
      : selector === "email" ? { email: fixture.relayEmail } : { supertokens_user_id: fixture.relayId };
    expect(await readOnlyPreview(input)).toMatchObject({ status: "BLOCKED", canReconcile: false, message: expect.stringContaining("EXTERNAL_ALIAS_AMBIGUOUS") });
    expect(await reconcileUser(input)).toMatchObject({ status: "BLOCKED", changed: false, message: expect.stringContaining("EXTERNAL_ALIAS_AMBIGUOUS") });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(rownd.fetchUserInfo).not.toHaveBeenCalled();
  });

  it.each(["standalone", "dangling", "tenant"])("admin blocks an inconsistent %s owner graph before writes", async (kind) => {
    const fixture = await seed();
    const getUser = SuperTokens.getUser.bind(SuperTokens);
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (...args) => {
      const user = await getUser(...args);
      if (!user) return user;
      if (kind === "dangling" && args[0] === fixture.relayId) return undefined;
      if (kind === "standalone") user.isPrimaryUser = false;
      if (kind === "tenant") for (const method of user.loginMethods) method.tenantIds = ["other"];
      return user;
    });
    const writes = [vi.spyOn(UserMetadata, "updateUserMetadata"), vi.spyOn(AccountLinking, "linkAccounts"), vi.spyOn(SuperTokens, "createUserIdMapping")];
    expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", canReconcile: false });
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", message: expect.stringContaining("OWNER_MEMBERSHIP_INCONSISTENT") });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it.each(["forward", "reverse", "completed"])("admin rejects duplicate exact provider owners independent of lookup ordering or completion (%s)", async (scenario) => {
    const rowndId = `rownd-${randomUUID()}`;
    const subject = randomUUID();
    const target = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", subject, `${randomUUID()}@example.com`, false);
    const other = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", randomUUID(), `${randomUUID()}@example.com`, false);
    if (target.status !== "OK" || other.status !== "OK") throw new Error("Missing providers");
    const profile = { data: { user_id: rowndId, google_id: subject }, verified_data: {} };
    rownd.fetchUserInfo.mockResolvedValue(profile);
    if (scenario === "completed") {
      await SuperTokens.createUserIdMapping({ superTokensUserId: target.user.id, externalUserId: rowndId });
      await UserMetadata.updateUserMetadata(target.user.id, { original_rownd_user: profile, rownd_migration_complete: true });
    }
    const inconsistent = (await SuperTokens.getUser(other.user.id))!;
    inconsistent.loginMethods[0].thirdParty = { id: "google", userId: subject };
    const list = SuperTokens.listUsersByAccountInfo.bind(SuperTokens);
    vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockImplementation(async (...args) => args[1].thirdParty
      ? scenario === "reverse" ? [inconsistent, target.user] : [target.user, inconsistent] : list(...args));
    const writes = [vi.spyOn(SuperTokens, "createUserIdMapping"), vi.spyOn(AccountLinking, "linkAccounts"), vi.spyOn(UserMetadata, "updateUserMetadata")];
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "BLOCKED", changed: false, message: expect.stringContaining("PROVIDER_IDENTITY_SPLIT") });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it.each(["repair", "proof drift", "alias drift", "false verification"])("admin verifies each effective recipe alias with full postconditions: %s", async (scenario) => {
    const rowndId = `rownd-${randomUUID()}`;
    const email = `${randomUUID()}@example.com`;
    const subject = randomUUID();
    const provider = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", subject, email, false);
    if (provider.status !== "OK") throw new Error("Missing provider");
    await AccountLinking.createPrimaryUser(provider.recipeUserId);
    const password = await EmailPassword.signUp("public", email, "StrongPassword123!");
    if (password.status !== "OK") throw new Error("Missing password method");
    const contact = await Passwordless.signInUp({ tenantId: "public", email });
    for (const method of [password, contact]) await AccountLinking.linkAccounts(method.recipeUserId, provider.user.id);
    const aliases = [rowndId, `password-alias-${randomUUID()}`, `contact-alias-${randomUUID()}`];
    for (const [index, method] of [provider, password, contact].entries()) {
      const token = await EmailVerification.createEmailVerificationToken("public", method.recipeUserId, email);
      if (token.status === "OK") await EmailVerification.verifyEmailUsingToken("public", token.token);
      expect((await SuperTokens.createUserIdMapping({ superTokensUserId: method.recipeUserId.getAsString(), externalUserId: aliases[index], force: true })).status).toBe("OK");
    }
    const profile: RowndUser = { data: { user_id: rowndId, email, google_id: subject }, verified_data: { email: email.toUpperCase() } };
    await UserMetadata.updateUserMetadata(provider.user.id, { original_rownd_user: profile, rownd_migration_complete: true });
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    const before = (await SuperTokens.getUser(rowndId))!;
    expect(before.loginMethods.some((method) => !method.verified)).toBe(true);
    expect(await readOnlyPreview({ rownd_user_id: rowndId })).toMatchObject({ status: "PREVIEW", canReconcile: true, matchesSource: false,
      proposedActions: aliases.map((recipeUserId) => ({ action: "verify_email", recipeUserId, email })) });
    expect((await SuperTokens.getUser(rowndId))!.toJson()).toEqual(before.toJson());
    const create = vi.spyOn(Passwordless, "signInUp");
    const createToken = EmailVerification.createEmailVerificationToken.bind(EmailVerification);
    const token = vi.spyOn(EmailVerification, "createEmailVerificationToken");
    const victim = await ThirdParty.manuallyCreateOrUpdateUser("public", "apple", randomUUID(), email, false);
    if (victim.status !== "OK") throw new Error("Missing unrelated owner");
    let victimBefore = (await SuperTokens.getUser(victim.user.id))!.toJson();
    if (scenario === "proof drift" || scenario === "alias drift") token.mockImplementation(async (...args) => {
      const result = await createToken(...args);
      if (args[1].getAsString() === aliases[1]) {
        if (scenario === "proof drift") profile.verified_data.email = false;
        else {
          await SuperTokens.deleteUserIdMapping({ userId: aliases[1], userIdType: "EXTERNAL", force: true });
          await SuperTokens.createUserIdMapping({ superTokensUserId: victim.recipeUserId.getAsString(), externalUserId: aliases[1], force: true });
          victimBefore = (await SuperTokens.getUser(victim.user.id))!.toJson();
        }
      }
      return result;
    });
    if (scenario === "false verification") {
      const verify = EmailVerification.verifyEmailUsingToken.bind(EmailVerification);
      vi.spyOn(EmailVerification, "verifyEmailUsingToken").mockImplementation(async (...args) => {
        const result = await verify(...args);
        for (const alias of aliases) await EmailVerification.unverifyEmail(SuperTokens.convertToRecipeUserId(alias), email);
        return result;
      });
    }
    const result = await reconcileUser({ rownd_user_id: rowndId });
    if (scenario !== "repair") {
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", supertokens_user_id: provider.user.id });
      expect((await SuperTokens.getUser(victim.user.id))!.toJson()).toEqual(victimBefore);
      expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(scenario === "alias drift" ? aliases[1] : victim.user.id), email)).toBe(false);
      expect(create).not.toHaveBeenCalled();
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", changed: true, supertokens_user_id: provider.user.id });
    expect(create).not.toHaveBeenCalled();
    for (const alias of aliases) expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(alias), email)).toBe(true);
    expect((await SuperTokens.getUser(rowndId))!.loginMethods).toHaveLength(3);
    expect(token.mock.calls.map((call) => call[1].getAsString())).toEqual(expect.arrayContaining(aliases));
    expect(await reconcileUser({ email })).toMatchObject({ status: "OK", changed: false });
    expect(rownd.validateToken).not.toHaveBeenCalled();
  });

  it("admin retains an elected owner after a persistent write and Core failure before mapping", async () => {
    const rowndId = `rownd-${randomUUID()}`;
    const email = `${randomUUID()}@example.com`;
    const target = await Passwordless.signInUp({ tenantId: "public", email });
    const id = target.recipeUserId.getAsString();
    expect(target.user.isPrimaryUser).toBe(false);
    rownd.fetchUserInfo.mockResolvedValue({ state: "enabled", data: { user_id: rowndId, email }, verified_data: { email: true } });
    vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementation(async () => {
      await UserMetadata.updateUserMetadata(id, { administrative_test_progress: true });
      throw Object.assign(new Error("Core mapping transport failed"), { code: "ECONNRESET" });
    });
    const result = await reconcileUser({ rownd_user_id: rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ERROR", supertokens_user_id: id, changed: true, partialProgress: true, message: "Core mapping transport failed" });
    expect(await SuperTokens.getUser(rowndId)).toBeUndefined();
    expect((await UserMetadata.getUserMetadata(id)).metadata).toMatchObject({ administrative_test_progress: true });
  });

  it.each([false, true])("completed migration leaves current-email drift untouched (standalone=%s)", async (standalone) => {
    const fixture = await seed(standalone);
    await UserMetadata.updateUserMetadata(fixture.rowndId, { rownd_migration_canonical_target: fixture.internalId });
    const before = (await SuperTokens.getUser(fixture.rowndId))!.toJson();
    const metadata = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata;
    const writes = (await spyOnReconciliationWrites()).filter((write) =>
      write !== Session.createNewSession && write !== Session.createNewSessionWithoutRequestResponse && write !== UserMetadata.updateUserMetadata);
    const response = await fetch(`${baseUrl}/auth/plugin/rownd/migrate`, {
      method: "POST", headers: { Authorization: "Bearer fixture-token", "st-auth-mode": "header", rid: "session", "fdi-version": "1.18" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "OK" });
    expect((await Session.getSessionWithoutRequestResponse(response.headers.get("st-access-token")!)).getUserId()).toBe(fixture.rowndId);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(1);
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledWith(fixture.rowndId,
      { rownd_migration_canonical_target: fixture.internalId }, expect.any(Object));
    expect((await SuperTokens.getUser(fixture.rowndId))!.toJson()).toEqual(before);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata).toEqual(metadata);
    if (fixture.separate) expect((await SuperTokens.getUser(fixture.separate.user.id))!.id).toBe(fixture.separate.user.id);
  });

  it.each([false, true])("incomplete migration publishes current email on original primary and retires relay (standalone=%s)", async (standalone) => {
    const fixture = await seed(standalone, false);
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

  it("explicit admin repairs a later verified email change after migration completed", async () => {
    const fixture = await seed();
    rownd.fetchUserInfo.mockResolvedValue(fixture.original);
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.original, "public"), "public", {})).resolves.toBe(true);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_email_recipe_user_ids).toBeUndefined();
    rownd.fetchUserInfo.mockResolvedValue(fixture.current);
    expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "OK", changed: true });
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
    const fixture = await seed(false, false);
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
    if (state === "native canonical") expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "PREVIEW", canReconcile: true });
    else expect(await readOnlyPreview({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", canReconcile: false,
      blockers: [{ code: "CANONICAL_EMAIL_POLICY" }] });
    await expect(reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.current, "public"), "public", {})).resolves.toBe(true);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata).toEqual(metadata);
    expect((await SuperTokens.getUser(fixture.separate!.recipeUserId.getAsString()))!.toJson()).toEqual(ownerBefore);
    if (state === "native canonical") {
      const result = await reconcileUser({ rownd_user_id: fixture.rowndId });
      expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: fixture.separate!.user.id });
      const survivor = (await SuperTokens.getUser(fixture.rowndId))!;
      expect(survivor.loginMethods.find((method) => method.recipeUserId.getAsString() === fixture.relayId)).toMatchObject({ verified: true });
      const canonical = survivor.loginMethods.find((method) => method.recipeId === "passwordless" && method.hasSameEmailAs(fixture.email))!;
      expect((await UserMetadata.getUserMetadata(fixture.separate!.user.id)).metadata.rownd_email_recipe_user_ids).toMatchObject({ public: canonical.recipeUserId.getAsString() });
    } else expect(await reconcileUser({ rownd_user_id: fixture.rowndId })).toMatchObject({ status: "BLOCKED", changed: false });
  });

  it.each(["missing", "false", "stale"])("trusts authenticated current email with %s verification data and instant auth", async (verification) => {
    const fixture = await seed(true, false);
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
    const fixture = await seed(true, false);
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
    const fixture = await seed(true, false);
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
    const fixture = await seed(standalone, false);
    await UserMetadata.updateUserMetadata(fixture.internalId, {
      original_rownd_user: { ...fixture.original, data: { ...fixture.original.data, apple_id: randomUUID() } },
    });
    await migrate(fixture);
    await expectCanonical(fixture);
  });

  it("repairs an incomplete real bulk import whose migration snapshot is stored under its Rownd alias", async () => {
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
    await UserMetadata.updateUserMetadata(rowndId, { preference: "preserved", rownd_migration_complete: false });
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
    const fixture = await seed(false, false);
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
