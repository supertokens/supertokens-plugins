import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import Session from "supertokens-node/recipe/session";
import EmailVerification from "supertokens-node/recipe/emailverification";
import UserMetadata from "supertokens-node/recipe/usermetadata";
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
import { fetchAdministrativeMigrationSource } from "./migration-email";
import { backfillAdministrativeMetadata, inspectAdministrativeMetadataBackfill } from "./migration-admin-metadata";
import { buildRowndUserMetadata, getRawUserMetadata, mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { importUser, reconcileRowndUserWithExistingLoginMethods } from "./supertokens-repository";
import type { RowndUser, SuperTokensUserImport } from "./types";
import type { JsonRecord } from "./utils";

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

describe("administrative custom metadata backfill", { timeout: 60000, sequential: true }, () => {
  let network: StartedNetwork;
  let postgres: StartedTestContainer;
  let core: StartedTestContainer;
  let connectionURI: string;

  beforeAll(async () => {
    expect(process.env.TEST_MODE).toBe("testing");
    network = await new Network().start();
    postgres = await new GenericContainer("postgres:14").withNetwork(network).withNetworkAliases("postgres")
      .withEnvironment({ POSTGRES_USER: "supertokens", POSTGRES_PASSWORD: "somepassword", POSTGRES_DB: "supertokens" })
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections")).start();
    core = await new GenericContainer("supertokens/supertokens-postgresql").withNetwork(network)
      .withEnvironment({ POSTGRESQL_CONNECTION_URI: "postgresql://supertokens:somepassword@postgres:5432/supertokens" })
      .withExposedPorts(3567).withWaitStrategy(Wait.forHttp("/hello", 3567)).start();
    connectionURI = `http://${core.getHost()}:${core.getMappedPort(3567)}`;
    expect((await fetch(`${connectionURI}/ee/license`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V" }),
    })).ok).toBe(true);
  }, 120000);

  afterAll(async () => {
    try { await core?.stop(); } finally {
      try { await postgres?.stop(); } finally { await network?.stop(); }
    }
  });

  beforeEach(() => {
    resetST();
    vi.resetAllMocks();
    SuperTokens.init({ supertokens: { connectionURI },
      appInfo: { appName: "Admin metadata", apiDomain: "http://localhost:3001", websiteDomain: "http://localhost:3000" },
      recipeList: [AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
        Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }), ThirdParty.init()],
      experimental: { plugins: [init({ rowndAppKey: "test-key", rowndAppSecret: "test-secret" })] },
    });
  });
  afterEach(() => { vi.restoreAllMocks(); resetST(); });

  async function seed(existing: JsonRecord = {}, mapped = true) {
    const alias = `rownd-${randomUUID()}`;
    const email = `${randomUUID()}@example.com`;
    const profile: RowndUser = { state: "enabled", auth_level: "verified", data: { user_id: alias, email }, verified_data: { email: true } };
    const imported = await importUser({ userMetadata: existing as SuperTokensUserImport["userMetadata"],
      loginMethods: [{ recipeId: "passwordless", email, isVerified: true, tenantIds: ["public"] }] }, { connectionURI });
    const internalId = imported.id;
    expect(await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(internalId))).toMatchObject({ status: "OK" });
    if (mapped) {
      expect(await SuperTokens.createUserIdMapping({ superTokensUserId: internalId, externalUserId: alias, force: true })).toMatchObject({ status: "OK" });
      const token = await EmailVerification.createEmailVerificationToken("public", SuperTokens.convertToRecipeUserId(alias), email);
      if (token.status === "OK") expect(await EmailVerification.verifyEmailUsingToken("public", token.token, false)).toMatchObject({ status: "OK" });
      await UserMetadata.updateUserMetadata(internalId, { original_rownd_user: structuredClone(profile), rownd_migration_complete: true });
    }
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => user_id === alias ? structuredClone(profile) : undefined);
    return { alias, email, internalId, profile, run: () => reconcileUser({ rownd_user_id: alias }) };
  }

  function authWrites() {
    return [vi.spyOn(AccountLinking, "createPrimaryUser"), vi.spyOn(AccountLinking, "linkAccounts"), vi.spyOn(AccountLinking, "unlinkAccount"),
      vi.spyOn(SuperTokens, "createUserIdMapping"), vi.spyOn(SuperTokens, "deleteUserIdMapping"), vi.spyOn(SuperTokens, "deleteUser"),
      vi.spyOn(Passwordless, "signInUp"), vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser"),
      vi.spyOn(EmailVerification, "createEmailVerificationToken"), vi.spyOn(EmailVerification, "verifyEmailUsingToken"),
      vi.spyOn(Session, "revokeAllSessionsForUser")];
  }

  it("previews metadata-only work without writes, publishes a minimal primary patch, then becomes a write-free no-op", async () => {
    const fixture = await seed({ existing: "preserved" });
    fixture.profile.meta = { missingMeta: "from meta", precedence: "meta" };
    fixture.profile.data.precedence = "data";
    fixture.profile.data.missingData = 0;
    const auth = authWrites();
    const writes = vi.spyOn(UserMetadata, "updateUserMetadata");
    expect(await reconcileUser({ rownd_user_id: fixture.alias, dryRun: true })).toMatchObject({ status: "PREVIEW", matchesSource: false, canReconcile: true,
      proposedActions: [{ action: "update_migration_metadata", supertokens_user_id: fixture.internalId }] });
    expect(writes).not.toHaveBeenCalled();
    auth.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    expect(await fixture.run()).toMatchObject({ status: "OK", changed: true });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith(fixture.internalId, { missingMeta: "from meta", precedence: "data", missingData: 0 }, expect.anything());
    expect((await getRawUserMetadata(fixture.internalId)).existing).toBe("preserved");
    writes.mockClear();
    expect(await fixture.run()).toMatchObject({ status: "OK", changed: false });
    expect(writes).not.toHaveBeenCalled();
    auth.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it("preserves existing false, zero, empty, null, arrays and opaque objects", async () => {
    const existing = { flag: false, count: 0, empty: "", nil: null, array: [], object: { keep: "native" } };
    const fixture = await seed(existing);
    expect(await getRawUserMetadata(fixture.internalId)).toMatchObject(existing);
    fixture.profile.meta = { flag: true, count: 10, empty: "Rownd", nil: "Rownd", array: ["Rownd"], object: { add: "Rownd" }, added: "new" };
    expect(await fixture.run()).toMatchObject({ status: "OK", changed: true });
    expect(await getRawUserMetadata(fixture.internalId)).toMatchObject({ ...existing, added: "new" });
    expect((await getRawUserMetadata(fixture.internalId)).object).toEqual(existing.object);
  });

  it("repairs a missing original snapshot even when the completion flag and all credentials already match", async () => {
    const fixture = await seed({ existing: false });
    await UserMetadata.updateUserMetadata(fixture.internalId, { original_rownd_user: null });
    const auth = authWrites();
    const writes = vi.spyOn(UserMetadata, "updateUserMetadata");
    const preview = await reconcileUser({ rownd_user_id: fixture.alias, dryRun: true });
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", matchesSource: false, canReconcile: true,
      proposedActions: [{ action: "update_migration_metadata", supertokens_user_id: fixture.internalId }] });
    expect(writes).not.toHaveBeenCalled();
    expect(await fixture.run()).toMatchObject({ status: "OK", changed: true });
    expect(await getRawUserMetadata(fixture.internalId)).toMatchObject({ original_rownd_user: fixture.profile, existing: false });
    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockClear();
    expect(await fixture.run()).toMatchObject({ status: "OK", changed: false });
    expect(writes).not.toHaveBeenCalled();
    auth.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it("preserves opaque custom values while publishing a changed canonical email", async () => {
    const alias = `rownd-${randomUUID()}`;
    const subject = `apple-${randomUUID()}`;
    const oldEmail = `${randomUUID()}@example.com`;
    const email = `${randomUUID()}@example.com`;
    const snapshot: RowndUser = { state: "enabled", data: { user_id: alias, email: oldEmail, apple_id: subject }, verified_data: { email: true, apple_id: subject } };
    const imported = await importUser({ userMetadata: { original_rownd_user: snapshot, rownd_migration_complete: true, nil: null, object: { nil: null, kept: false } },
      loginMethods: [
        { recipeId: "thirdparty", thirdPartyId: "apple", thirdPartyUserId: subject, email: oldEmail, isVerified: false, isPrimary: true, tenantIds: ["public"] },
        { recipeId: "passwordless", email: oldEmail, isVerified: true, tenantIds: ["public"] },
      ] }, { connectionURI });
    expect(await SuperTokens.createUserIdMapping({ superTokensUserId: imported.id, externalUserId: alias, force: true })).toMatchObject({ status: "OK" });
    const profile: RowndUser = { ...snapshot, data: { ...snapshot.data, email, additional: "Rownd" } };
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === alias ? structuredClone(profile) : undefined);
    const result = await reconcileUser({ rownd_user_id: alias });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", changed: true });
    expect(await getRawUserMetadata(imported.id)).toMatchObject({ nil: null, object: { nil: null, kept: false }, additional: "Rownd" });
  });

  it("does not shadow alias, linked-recipe or mapped linked-recipe custom values", async () => {
    const fixture = await seed();
    const secondary = await Passwordless.signInUp({ tenantId: "public", phoneNumber: "+1555" + String(Date.now()).slice(-7) });
    await AccountLinking.linkAccounts(secondary.recipeUserId, fixture.alias);
    const linkedAlias = `linked-${randomUUID()}`;
    await UserMetadata.updateUserMetadata(fixture.alias, { aliasOnly: false });
    await UserMetadata.updateUserMetadata(secondary.recipeUserId.getAsString(), { linkedOnly: { native: true } });
    await SuperTokens.createUserIdMapping({ superTokensUserId: secondary.recipeUserId.getAsString(), externalUserId: linkedAlias, force: true });
    await UserMetadata.updateUserMetadata(linkedAlias, { linkedAliasOnly: 0 });
    fixture.profile.meta = { aliasOnly: "Rownd", linkedOnly: { source: true }, linkedAliasOnly: "Rownd", newPrimary: "Rownd" };
    const source = (await fetchAdministrativeMigrationSource(fixture.alias, "public", {}))!;
    expect(await backfillAdministrativeMetadata({ source, tenantId: "public", internalUserId: fixture.internalId, userContext: {} })).toBe(true);
    const primary = await getRawUserMetadata(fixture.internalId);
    expect(primary.newPrimary).toBe("Rownd");
    expect(primary).not.toHaveProperty("aliasOnly");
    expect(primary).not.toHaveProperty("linkedOnly");
    expect(primary).not.toHaveProperty("linkedAliasOnly");
  });

  it("uses the normal mapper's precedence while ignoring injected reserved fields", async () => {
    const fixture = await seed();
    const reserved = ["original_rownd_user", "rownd_migration_complete", "rownd_email_recipe_user_ids", "rownd_pending_verification",
      "rownd_migration_owner_consolidation", "rownd_migration_admin_donor_sessions", "rownd_migration_mapping_publication",
      "rownd_migration_provider_introduction", "rownd_migration_provider_introductions", "rownd_migration_target", "rownd_migration_canonical_target"];
    fixture.profile.meta = { ...Object.fromEntries(reserved.map((key) => [key, "malicious meta"])), ordinary: "meta" };
    Object.assign(fixture.profile.data, Object.fromEntries(reserved.map((key) => [key, "malicious data"])), { ordinary: "data" });
    const before = await getRawUserMetadata(fixture.internalId);
    expect(buildRowndUserMetadata(fixture.profile).ordinary).toBe("data");
    expect(await fixture.run()).toMatchObject({ status: "OK" });
    const after = await getRawUserMetadata(fixture.internalId);
    expect(after.ordinary).toBe("data");
    for (const field of reserved) expect(after[field]).toEqual(before[field]);
  });

  it("backfills an existing unmapped native email owner selected by explicit Rownd ID", async () => {
    const fixture = await seed({ native: false, object: { keep: true } }, false);
    fixture.profile.meta = { native: "Rownd", object: { added: true }, missing: "from Rownd" };
    expect(await fixture.run()).toMatchObject({ status: "OK" });
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.alias, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.internalId });
    expect(await getRawUserMetadata(fixture.internalId)).toMatchObject({ native: false, object: { keep: true }, missing: "from Rownd" });
    expect((await getRawUserMetadata(fixture.internalId)).object).toEqual({ keep: true });
  });

  it("re-reads metadata and preserves a concurrent custom value before publication", async () => {
    const fixture = await seed();
    fixture.profile.meta = { concurrent: "Rownd", other: "Rownd" };
    const source = (await fetchAdministrativeMigrationSource(fixture.alias, "public", {}))!;
    const read = UserMetadata.getUserMetadata.bind(UserMetadata);
    let injected = false;
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (...args) => {
      const result = await read(...args);
      if (!injected && args[0] === fixture.internalId) {
        injected = true;
        await UserMetadata.updateUserMetadata(fixture.internalId, { concurrent: false });
      }
      return result;
    });
    const writes = vi.spyOn(UserMetadata, "updateUserMetadata");
    expect(await backfillAdministrativeMetadata({ source, tenantId: "public", internalUserId: fixture.internalId, userContext: {} })).toBe(true);
    expect(injected).toBe(true);
    expect(writes.mock.calls.map(([, patch]) => patch)).toEqual([{ concurrent: false }, { other: "Rownd" }]);
    expect(await getRawUserMetadata(fixture.internalId)).toMatchObject({ concurrent: false, other: "Rownd" });
  });

  it.each(["primary", "alias"])("preserves a concurrent %s value added during the final source refresh", async (location) => {
    const fixture = await seed();
    fixture.profile.meta = { concurrent: "Rownd", other: "Rownd" };
    const source = (await fetchAdministrativeMigrationSource(fixture.alias, "public", {}))!;
    let refreshes = 0;
    rownd.fetchUserInfo.mockImplementation(async () => {
      if (++refreshes === 2) await UserMetadata.updateUserMetadata(location === "primary" ? fixture.internalId : fixture.alias, { concurrent: false });
      return structuredClone(fixture.profile);
    });
    const writes = vi.spyOn(UserMetadata, "updateUserMetadata");
    expect(await backfillAdministrativeMetadata({ source, tenantId: "public", internalUserId: fixture.internalId, userContext: {} })).toBe(true);
    expect(writes.mock.calls.map(([, patch]) => patch)).toEqual([{ concurrent: false }, { other: "Rownd" }]);
    expect((await getRawUserMetadata(location === "primary" ? fixture.internalId : fixture.alias)).concurrent).toBe(false);
    if (location === "alias") expect(await getRawUserMetadata(fixture.internalId)).not.toHaveProperty("concurrent");
  });

  it("treats an absent source null as already compatible with Core patch semantics", async () => {
    const fixture = await seed();
    fixture.profile.meta = { missingNull: null };
    const source = (await fetchAdministrativeMigrationSource(fixture.alias, "public", {}))!;
    const writes = vi.spyOn(UserMetadata, "updateUserMetadata");
    expect(await backfillAdministrativeMetadata({ source, tenantId: "public", internalUserId: fixture.internalId, userContext: {} })).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])("revalidates the private source %s metadata publication", async (phase) => {
    const fixture = await seed();
    fixture.profile.meta = { missing: "Rownd" };
    const source = (await fetchAdministrativeMigrationSource(fixture.alias, "public", {}))!;
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    const writes = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
      const result = await update(...args);
      if (phase === "after") fixture.profile.state = "disabled";
      return result;
    });
    if (phase === "before") fixture.profile.state = "disabled";
    await expect(backfillAdministrativeMetadata({ source, tenantId: "public", internalUserId: fixture.internalId, userContext: {} }))
      .rejects.toThrow("source identity changed");
    expect(writes).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
  });

  it("rejects missing postconditions and leaves failed publication retryable", async () => {
    const fixture = await seed();
    fixture.profile.meta = { missing: "Rownd" };
    const source = (await fetchAdministrativeMigrationSource(fixture.alias, "public", {}))!;
    const input = { source, tenantId: "public", internalUserId: fixture.internalId, userContext: {} };
    const lost = vi.spyOn(UserMetadata, "updateUserMetadata").mockResolvedValueOnce({ status: "OK", metadata: {} });
    await expect(backfillAdministrativeMetadata(input)).rejects.toThrow("backfill is incomplete");
    lost.mockRestore();
    expect(await backfillAdministrativeMetadata(input)).toBe(true);
    expect(await inspectAdministrativeMetadataBackfill(input)).toEqual({});
  });

  it("does not expand unbound reconciliation or accept a copied administrative source", async () => {
    const fixture = await seed();
    fixture.profile.meta = { missing: "Rownd" };
    const source = (await fetchAdministrativeMigrationSource(fixture.alias, "public", {}))!;
    const writes = vi.spyOn(UserMetadata, "updateUserMetadata");
    expect(await backfillAdministrativeMetadata({ source: structuredClone(source), tenantId: "public", internalUserId: fixture.internalId, userContext: {} })).toBe(false);
    expect(await reconcileRowndUserWithExistingLoginMethods(mapRowndUserToSuperTokens(fixture.profile, "public"), "public", {})).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    expect(await getRawUserMetadata(fixture.internalId)).not.toHaveProperty("missing");
  });
});
