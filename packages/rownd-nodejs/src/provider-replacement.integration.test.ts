import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from "testcontainers";
import { init } from "./plugin";
import { mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { importUser, reconcileRowndUserWithExistingLoginMethods } from "./supertokens-repository";
import { authenticateRowndMigration } from "./migration-email";
import type { RowndUser } from "./types";
import { Querier } from "supertokens-node/lib/build/querier";
import SessionRecipe from "supertokens-node/lib/build/recipe/session/recipe";
import { prepareRowndProviderRetirement } from "./migration-provider";

const rownd = vi.hoisted(() => ({ validateToken: vi.fn(), fetchUserInfo: vi.fn() }));
vi.mock("@rownd/node", () => ({ createInstance: () => rownd }));

describe("verified Rownd provider replacement", () => {
  let network: StartedNetwork;
  let postgres: StartedTestContainer;
  let core: StartedTestContainer;
  let connectionURI: string;
  beforeAll(async () => {
    network = await new Network().start();
    postgres = await new GenericContainer("postgres:14").withNetwork(network).withNetworkAliases("postgres")
      .withEnvironment({ POSTGRES_USER: "supertokens", POSTGRES_PASSWORD: "somepassword", POSTGRES_DB: "supertokens" })
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections")).start();
    core = await new GenericContainer("supertokens/supertokens-postgresql").withNetwork(network)
      .withEnvironment({ POSTGRESQL_CONNECTION_URI: "postgresql://supertokens:somepassword@postgres:5432/supertokens" })
      .withExposedPorts(3567).withWaitStrategy(Wait.forHttp("/hello", 3567)).start();
    connectionURI = `http://${core.getHost()}:${core.getMappedPort(3567)}`;
    await fetch(`${connectionURI}/ee/license`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V" }) });
    SuperTokens.init({
      supertokens: { connectionURI },
      appInfo: { appName: "Provider repair", apiDomain: "http://localhost:3001", websiteDomain: "http://localhost:3000" },
      recipeList: [AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
        Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }), ThirdParty.init()],
      experimental: { plugins: [init({ rowndAppKey: "test-key", rowndAppSecret: "test-secret" })] },
    });
  }, 120000);
  afterAll(async () => { await core?.stop(); await postgres?.stop(); await network?.stop(); });

  async function seed(provider: "google" | "apple", multiTenant = false, withEmail = true) {
    const rowndId = `rownd-${randomUUID()}`;
    const oldSubject = `old-${randomUUID()}`;
    const subject = `verified-${randomUUID()}`;
    const original: RowndUser = { state: "enabled", auth_level: "verified",
      data: { user_id: rowndId, [`${provider}_id`]: oldSubject, ...(withEmail ? { email: `${randomUUID()}@example.com` } : {}) },
      verified_data: { [`${provider}_id`]: oldSubject, email: true } };
    const imported = await importUser(mapRowndUserToSuperTokens(original, "public"), { connectionURI });
    const mapping = await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL" });
    if (mapping.status !== "OK") throw new Error("Missing mapping");
    const internalId = mapping.superTokensUserId;
    const current: RowndUser = { ...original, verified_data: { ...original.verified_data, [`${provider}_id`]: subject } };
    await UserMetadata.updateUserMetadata(internalId, { original_rownd_user: current, rownd_migration_complete: true, customer_value: "preserved" });
    let otherTenant: string | undefined;
    if (multiTenant) {
      otherTenant = `tenant-${randomUUID()}`;
      await Multitenancy.createOrUpdateTenant(otherTenant, { firstFactors: ["thirdparty", "otp-email"] });
      await Multitenancy.associateUserToTenant(otherTenant, SuperTokens.convertToRecipeUserId(internalId));
    }
    rownd.validateToken.mockResolvedValue({ user_id: rowndId });
    rownd.fetchUserInfo.mockResolvedValue(current);
    const repair = async (tenant = "public") => {
      const { source } = await authenticateRowndMigration("token", tenant, {});
      const user = await SuperTokens.getUser(internalId);
      if (!user) throw new Error("Missing target");
      return reconcileRowndUserWithExistingLoginMethods(source, tenant, {}, { repairUser: user });
    };
    return { rowndId, internalId, oldSubject, subject, current, original, imported, otherTenant, repair };
  }

  it.each(["google", "apple"] as const)("replaces %s primary anchor and preserves mapping, contact and metadata", async (provider) => {
    const fixture = await seed(provider);
    await fixture.repair();
    await fixture.repair();
    const user = await SuperTokens.getUser(fixture.internalId);
    expect(user?.id).toBe(fixture.rowndId);
    expect(user?.loginMethods.filter((method) => method.thirdParty?.id === provider).map((method) => method.thirdParty?.userId)).toEqual([fixture.subject]);
    expect(user?.loginMethods.some((method) => method.email === fixture.current.data.email)).toBe(true);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.customer_value).toBe("preserved");
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.rowndId, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.internalId });
  });

  it("retains the old recipe in another tenant and resumes after snapshot refresh", async () => {
    const fixture = await seed("google", true);
    await fixture.repair();
    let user = await SuperTokens.getUser(fixture.internalId);
    expect(user?.loginMethods.find((method) => method.thirdParty?.userId === fixture.oldSubject)?.tenantIds).toEqual([fixture.otherTenant]);
    await UserMetadata.updateUserMetadata(fixture.internalId, { original_rownd_user: {
      ...fixture.current, data: { ...fixture.current.data, google_id: fixture.subject },
    } });
    await fixture.repair(fixture.otherTenant);
    user = await SuperTokens.getUser(fixture.internalId);
    expect(user?.loginMethods.some((method) => method.thirdParty?.userId === fixture.oldSubject)).toBe(false);
    expect(user?.loginMethods.some((method) => method.thirdParty?.userId === fixture.subject && method.tenantIds.includes(fixture.otherTenant!))).toBe(true);
  });

  it("retries a failure after linking without losing the old identity or creating another replacement", async () => {
    const fixture = await seed("google");
    const failure = vi.spyOn(Multitenancy, "disassociateUserFromTenant").mockRejectedValueOnce(new Error("interrupted"));
    await expect(fixture.repair()).rejects.toThrow("interrupted");
    failure.mockRestore();
    expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.filter((method) => method.thirdParty?.id === "google")).toHaveLength(1);
    await fixture.repair();
    expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.filter((method) => method.thirdParty?.id === "google")).toHaveLength(1);
  });

  it("rejects replacement owned by another primary account before retiring the old subject", async () => {
    const fixture = await seed("google");
    const foreign = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", fixture.subject, `${randomUUID()}@example.com`, false);
    if (foreign.status !== "OK") throw new Error("Foreign seed failed");
    await AccountLinking.createPrimaryUser(foreign.recipeUserId);
    await expect(fixture.repair()).rejects.toThrow(/different SuperTokens user/);
    expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.some((method) => method.thirdParty?.userId === fixture.oldSubject)).toBe(true);
  });

  it("resumes orphan cleanup after tenant removal committed and the snapshot was refreshed", async () => {
    const fixture = await seed("google");
    const failure = vi.spyOn(SuperTokens, "deleteUser").mockRejectedValueOnce(new Error("delete interrupted"));
    try { await expect(fixture.repair()).rejects.toThrow("delete interrupted"); }
    finally { failure.mockRestore(); }
    const orphan = (await SuperTokens.getUser(fixture.internalId))?.loginMethods.find((method) => method.thirdParty?.userId === fixture.oldSubject);
    expect(orphan?.tenantIds).toEqual([]);
    await UserMetadata.updateUserMetadata(fixture.internalId, { original_rownd_user: {
      ...fixture.current, data: { ...fixture.current.data, google_id: fixture.subject },
    } });
    await fixture.repair();
    expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.some((method) => method.thirdParty?.userId === fixture.oldSubject)).toBe(false);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_migration_provider_retirements).toEqual([]);
  });

  it("links an existing standalone replacement and keeps unrelated native providers", async () => {
    const fixture = await seed("google");
    const replacement = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", fixture.subject, `${randomUUID()}@example.com`, false);
    const nativeSubject = `native-${randomUUID()}`;
    const native = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", nativeSubject, `${randomUUID()}@example.com`, false);
    if (replacement.status !== "OK" || native.status !== "OK") throw new Error("Provider seed failed");
    await AccountLinking.linkAccounts(native.recipeUserId, fixture.internalId);
    await fixture.repair();
    const user = await SuperTokens.getUser(fixture.internalId);
    expect(user?.loginMethods.filter((method) => method.thirdParty?.id === "google").map((method) => method.thirdParty?.userId).sort())
      .toEqual([fixture.subject, nativeSubject].sort());
    expect(user?.loginMethods.some((method) => method.recipeUserId.getAsString() === replacement.recipeUserId.getAsString())).toBe(true);
  });

  it("refuses retirement if verified Rownd ownership changes after the replacement was linked", async () => {
    const fixture = await seed("google");
    const link = AccountLinking.linkAccounts.bind(AccountLinking);
    const mutation = vi.spyOn(AccountLinking, "linkAccounts").mockImplementation(async (...args) => {
      const result = await link(...args);
      rownd.fetchUserInfo.mockResolvedValue({ ...fixture.current,
        verified_data: { ...fixture.current.verified_data, google_id: "changed-after-link" } });
      return result;
    });
    try {
      await expect(fixture.repair()).rejects.toThrow(/source identity changed|provider changed/);
      expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.some((method) => method.thirdParty?.userId === fixture.oldSubject)).toBe(true);
      expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.some((method) =>
        method.thirdParty?.userId === fixture.subject && method.tenantIds.includes("public"))).toBe(false);
    } finally { mutation.mockRestore(); }
    rownd.fetchUserInfo.mockResolvedValue(fixture.current);
    await fixture.repair();
    expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.some((method) => method.thirdParty?.userId === fixture.oldSubject)).toBe(false);
  });

  it.each(["before link", "after link"])("quarantines a newly added provider when its source changes %s", async (stage) => {
    const fixture = await seed("google");
    const appleSubject = `apple-${randomUUID()}`;
    const profile: RowndUser = { ...fixture.original, verified_data: { ...fixture.original.verified_data, apple_id: appleSubject } };
    rownd.fetchUserInfo.mockResolvedValue(profile);
    const changed = () => rownd.fetchUserInfo.mockResolvedValue({ ...profile, verified_data: { ...profile.verified_data, apple_id: "changed" } });
    const create = ThirdParty.manuallyCreateOrUpdateUser.bind(ThirdParty);
    const link = AccountLinking.linkAccounts.bind(AccountLinking);
    const creation = vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser").mockImplementation(async (...args) => {
      const result = await create(...args);
      if (stage === "before link") changed();
      return result;
    });
    const linking = vi.spyOn(AccountLinking, "linkAccounts").mockImplementation(async (...args) => {
      const result = await link(...args);
      if (stage === "after link") changed();
      return result;
    });
    try {
      await expect(fixture.repair()).rejects.toThrow(/source identity changed|provider changed/);
      if (stage === "before link") expect(linking).not.toHaveBeenCalled();
      expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.some((method) => method.thirdParty?.userId === appleSubject && method.tenantIds.includes("public"))).toBe(false);
      expect(await SuperTokens.listUsersByAccountInfo("public", { thirdParty: { id: "apple", userId: appleSubject } })).toEqual([]);
    } finally { creation.mockRestore(); linking.mockRestore(); }
    rownd.fetchUserInfo.mockResolvedValue(profile);
    await fixture.repair();
    expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.some((method) => method.thirdParty?.userId === appleSubject && method.tenantIds.includes("public"))).toBe(true);
  });

  it("revokes sessions issued while obsolete tenant membership is being removed", async () => {
    const fixture = await seed("google", true);
    let handle: string | undefined;
    const remove = Multitenancy.disassociateUserFromTenant.bind(Multitenancy);
    const removal = vi.spyOn(Multitenancy, "disassociateUserFromTenant").mockImplementation(async (...args) => {
      if (args[0] === "public" && args[1].getAsString() === fixture.internalId) {
        handle = (await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.rowndId))).getHandle();
      }
      return remove(...args);
    });
    try { await fixture.repair(); } finally { removal.mockRestore(); }
    expect(handle).toBeDefined();
    expect(await Session.getSessionInformation(handle!)).toBeUndefined();
    await expect(Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.rowndId))).rejects.toThrow(/no longer a member/);
  });

  it("durably retries post-removal revocation without removing another tenant", async () => {
    const fixture = await seed("google", true);
    const other = await Session.createNewSessionWithoutRequestResponse(fixture.otherTenant!, SuperTokens.convertToRecipeUserId(fixture.rowndId));
    const failure = vi.spyOn(Session, "revokeAllSessionsForUser").mockRejectedValue(new Error("revocation interrupted"));
    try { await expect(fixture.repair()).rejects.toThrow("revocation interrupted"); }
    finally { failure.mockRestore(); }
    const checkpoint = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_migration_provider_retirements as Array<{ pendingTenantIds: string[] }>;
    expect(checkpoint[0]!.pendingTenantIds).toContain("public");
    expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.find((method) => method.thirdParty?.userId === fixture.oldSubject)?.tenantIds).toEqual([fixture.otherTenant]);
    const revocation = vi.spyOn(Session, "revokeAllSessionsForUser");
    try { await fixture.repair(); expect(revocation).toHaveBeenCalledWith(fixture.internalId, true, "public", expect.anything()); }
    finally { revocation.mockRestore(); }
    expect(await Session.getSessionInformation(other.getHandle())).toBeDefined();
    const completed = (await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_migration_provider_retirements as Array<{ pendingTenantIds: string[] }>;
    expect(completed[0]!.pendingTenantIds).not.toContain("public");
  });

  it("rejects and revokes an in-flight provider session minted across tenant removal", async () => {
    const fixture = await seed("google", true);
    const querier = Reflect.get(SessionRecipe.getInstanceOrThrowError(), "querier") as Querier;
    const send = querier.sendPostRequest.bind(querier);
    let handle: string | undefined;
    const race = vi.spyOn(querier, "sendPostRequest").mockImplementation(async (...args) => {
      const result = await send(...args);
      if (typeof args[0] === "object" && args[0].path === "/<tenantId>/recipe/session") {
        handle = result.session.handle;
        await Multitenancy.disassociateUserFromTenant("public", SuperTokens.convertToRecipeUserId(fixture.internalId));
      }
      return result;
    });
    try { await expect(Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.rowndId))).rejects.toThrow(/no longer a member/); }
    finally { race.mockRestore(); }
    expect(handle).toBeDefined();
    expect(await Session.getSessionInformation(handle!)).toBeUndefined();
  });

  it("keeps a failed quarantine durable and blocks sessions until a changed-source retry removes it", async () => {
    const fixture = await seed("google");
    const nextSubject = `next-${randomUUID()}`;
    const next = { ...fixture.current, verified_data: { ...fixture.current.verified_data, google_id: nextSubject } };
    const link = AccountLinking.linkAccounts.bind(AccountLinking);
    let recipeId: string | undefined;
    const race = vi.spyOn(AccountLinking, "linkAccounts").mockImplementation(async (...args) => {
      const result = await link(...args);
      recipeId = args[0].getAsString();
      rownd.fetchUserInfo.mockResolvedValue(next);
      return result;
    });
    const unavailable = vi.spyOn(Multitenancy, "disassociateUserFromTenant").mockRejectedValue(new Error("quarantine unavailable"));
    try { await expect(fixture.repair()).rejects.toThrow("quarantine unavailable"); }
    finally { race.mockRestore(); unavailable.mockRestore(); }
    expect(recipeId).toBeDefined();
    await expect(Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(recipeId!))).rejects.toThrow(/not yet committed/);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_migration_provider_introductions).toMatchObject([{ recipeUserId: recipeId, tenantId: "public" }]);
    // A competing account-metadata write must not erase the recipe's quarantine.
    await UserMetadata.updateUserMetadata(fixture.internalId, { rownd_migration_provider_introductions: [] });
    await expect(Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(recipeId!))).rejects.toThrow(/not yet committed/);
    await fixture.repair();
    const user = await SuperTokens.getUser(fixture.internalId);
    expect(user?.loginMethods.filter((method) => method.thirdParty?.id === "google").map((method) => method.thirdParty?.userId)).toEqual([nextSubject]);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.rownd_migration_provider_introductions).toEqual([]);
  });

  it("restores an existing native donor when Rownd changes after linking", async () => {
    const fixture = await seed("google");
    const donor = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", fixture.subject, `${randomUUID()}@example.com`, false);
    if (donor.status !== "OK") throw new Error("Donor seed failed");
    const link = AccountLinking.linkAccounts.bind(AccountLinking);
    const race = vi.spyOn(AccountLinking, "linkAccounts").mockImplementation(async (...args) => {
      const result = await link(...args);
      rownd.fetchUserInfo.mockResolvedValue({ ...fixture.current, verified_data: { ...fixture.current.verified_data, google_id: "changed" } });
      return result;
    });
    try { await expect(fixture.repair()).rejects.toThrow(/source identity changed|provider changed/); }
    finally { race.mockRestore(); }
    const restored = await SuperTokens.getUser(donor.recipeUserId.getAsString());
    expect(restored?.id).toBe(donor.user.id);
    expect(restored?.isPrimaryUser).toBe(false);
    expect(restored?.loginMethods[0]?.tenantIds).toContain("public");
    expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.some((method) => method.thirdParty?.userId === fixture.subject)).toBe(false);
  });

  it("recovers tenant A revocation debt after tenant B overwrites its stale shared checkpoint and deletes the old anchor", async () => {
    const fixture = await seed("google", true);
    for (const tenant of ["public", fixture.otherTenant!]) {
      const replacement = await ThirdParty.manuallyCreateOrUpdateUser(tenant, "google", fixture.subject, `${randomUUID()}@example.com`, false);
      if (replacement.status !== "OK") throw new Error("Replacement seed failed");
      await AccountLinking.linkAccounts(replacement.recipeUserId, fixture.internalId);
    }
    const user = (await SuperTokens.getUser(fixture.internalId))!;
    const contact = user.loginMethods.find((method) => method.recipeId === "passwordless")!;
    const sessionA = await Session.createNewSessionWithoutRequestResponse("public", contact.recipeUserId);
    let releaseB!: () => void;
    let readB!: () => void;
    const pausedB = new Promise<void>((resolve) => { readB = resolve; });
    const resumeB = new Promise<void>((resolve) => { releaseB = resolve; });
    const read = UserMetadata.getUserMetadata.bind(UserMetadata);
    let paused = false;
    const metadataRead = vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (...args) => {
      const result = await read(...args);
      if (!paused && args[0] === fixture.internalId && args[1]?.worker === "B") {
        paused = true;
        readB();
        await resumeB;
      }
      return result;
    });
    const prepareB = prepareRowndProviderRetirement({ source: mapRowndUserToSuperTokens(fixture.current, fixture.otherTenant!),
      user, metadata: { original_rownd_user: fixture.current }, internalUserId: fixture.internalId,
      tenantId: fixture.otherTenant!, userContext: { worker: "B" } });
    await pausedB;
    const revoke = Session.revokeAllSessionsForUser.bind(Session);
    const failure = vi.spyOn(Session, "revokeAllSessionsForUser").mockImplementation(async (...args) => {
      if (args[2] === "public") throw new Error("tenant A revocation unavailable");
      return revoke(...args);
    });
    try {
      const finishA = await prepareRowndProviderRetirement({ source: mapRowndUserToSuperTokens(fixture.current, "public"),
        user, metadata: { original_rownd_user: fixture.current }, internalUserId: fixture.internalId,
        tenantId: "public", userContext: { worker: "A" } });
      await expect(finishA!()).rejects.toThrow("tenant A revocation unavailable");
      expect((await read(fixture.internalId)).metadata.rownd_migration_provider_retirements).toMatchObject([{ pendingTenantIds: ["public"] }]);
      releaseB();
      const finishB = await prepareB;
      await finishB!();
    } finally { releaseB(); metadataRead.mockRestore(); failure.mockRestore(); }
    expect((await SuperTokens.getUser(fixture.internalId))?.loginMethods.some((method) => method.thirdParty?.userId === fixture.oldSubject)).toBe(false);
    expect((await read(fixture.internalId)).metadata.rownd_migration_provider_retirements).toEqual([]);
    expect(await Session.getSessionInformation(sessionA.getHandle())).toBeDefined();
    // No surviving recipe, array entry, or profile subject can rediscover A's debt.
    await UserMetadata.updateUserMetadata(fixture.internalId, { original_rownd_user: {
      ...fixture.current, data: { ...fixture.current.data, google_id: fixture.subject },
    } });
    await fixture.repair();
    expect(await Session.getSessionInformation(sessionA.getHandle())).toBeUndefined();
  });

  it.each([false, true])("quarantines the last uncommitted recipe without deleting a provider-only pinned account (existing donor=%s)", async (existingDonor) => {
    const fixture = await seed("google", false, false);
    if (existingDonor) {
      const donor = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", fixture.subject, `${randomUUID()}@example.com`, false);
      if (donor.status !== "OK") throw new Error("Donor seed failed");
    }
    const remove = SuperTokens.deleteUser.bind(SuperTokens);
    let anchorRetired = false;
    const failure = vi.spyOn(SuperTokens, "deleteUser").mockImplementation(async (...args) => {
      const result = await remove(...args);
      if (args[0] === fixture.internalId) {
        anchorRetired = true;
        rownd.fetchUserInfo.mockRejectedValue(new Error("Rownd unavailable after anchor retirement"));
      }
      return result;
    });
    try { await expect(fixture.repair()).rejects.toThrow("Rownd unavailable after anchor retirement"); }
    finally { failure.mockRestore(); }
    expect(anchorRetired).toBe(true);
    const quarantined = await SuperTokens.getUser(fixture.internalId);
    expect(quarantined?.id).toBe(fixture.rowndId);
    expect(quarantined?.loginMethods).toHaveLength(1);
    expect(quarantined?.loginMethods[0]?.tenantIds).toEqual([]);
    expect((await UserMetadata.getUserMetadata(fixture.internalId)).metadata.customer_value).toBe("preserved");
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.rowndId, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.internalId });
    rownd.fetchUserInfo.mockResolvedValue(fixture.current);
    await expect(fixture.repair()).resolves.toBe(true);
    const recovered = await SuperTokens.getUser(fixture.internalId);
    expect(recovered?.id).toBe(fixture.rowndId);
    const active = recovered?.loginMethods.find((method) => method.thirdParty?.userId === fixture.subject && method.tenantIds.includes("public"));
    expect(active).toBeDefined();
    expect((await Session.createNewSessionWithoutRequestResponse("public", active!.recipeUserId)).getUserId()).toBe(fixture.rowndId);
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.rowndId, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.internalId });
  });

  it("creates a distinct recipe for an expected provider in another tenant and rolls back only the new tenant on source change", async () => {
    const fixture = await seed("google", true);
    const existing = await ThirdParty.manuallyCreateOrUpdateUser(fixture.otherTenant!, "google", fixture.subject, `${randomUUID()}@example.com`, false);
    if (existing.status !== "OK") throw new Error("Other-tenant seed failed");
    await AccountLinking.linkAccounts(existing.recipeUserId, fixture.internalId);
    const nativeSession = await Session.createNewSessionWithoutRequestResponse(fixture.otherTenant!, existing.recipeUserId);
    const create = ThirdParty.manuallyCreateOrUpdateUser.bind(ThirdParty);
    let newRecipeId: string | undefined;
    let createdNewRecipeUser: boolean | undefined;
    const creation = vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser").mockImplementation(async (...args) => {
      const result = await create(...args);
      if (args[0] === "public" && args[2] === fixture.subject && result.status === "OK") {
        newRecipeId = result.recipeUserId.getAsString();
        createdNewRecipeUser = result.createdNewRecipeUser;
      }
      return result;
    });
    const link = AccountLinking.linkAccounts.bind(AccountLinking);
    const race = vi.spyOn(AccountLinking, "linkAccounts").mockImplementation(async (...args) => {
      const result = await link(...args);
      rownd.fetchUserInfo.mockResolvedValue({ ...fixture.current, verified_data: { ...fixture.current.verified_data, google_id: "changed" } });
      return result;
    });
    try { await expect(fixture.repair()).rejects.toThrow(/source identity changed|provider changed/); }
    finally { creation.mockRestore(); race.mockRestore(); }
    expect(createdNewRecipeUser).toBe(true);
    expect(newRecipeId).toBeDefined();
    expect(newRecipeId).not.toBe(existing.recipeUserId.getAsString());
    const user = await SuperTokens.getUser(fixture.internalId);
    expect(user?.loginMethods.find((method) => method.recipeUserId.getAsString() === existing.recipeUserId.getAsString())?.tenantIds).toEqual([fixture.otherTenant]);
    expect(user?.loginMethods.some((method) => method.thirdParty?.userId === fixture.subject && method.tenantIds.includes("public"))).toBe(false);
    expect(await Session.getSessionInformation(nativeSession.getHandle())).toBeDefined();
    expect(await SuperTokens.listUsersByAccountInfo("public", { thirdParty: { id: "google", userId: fixture.subject } })).toEqual([]);
  });
});
