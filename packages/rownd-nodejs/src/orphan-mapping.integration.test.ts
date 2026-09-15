import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from "testcontainers";
import { init } from "./plugin";
import { reconcileUser } from "./reconcile-user";
import { assertMappingPublicationSessionMembership } from "./migration-publication";
import { recoverOrphanMapping } from "./migration-orphan-mapping";
import type { RowndUser } from "./types";

const rownd = { validateToken: vi.fn(), fetchUserInfo: vi.fn() };
vi.mock("@rownd/node", () => ({ createInstance: () => rownd }));
let network: StartedNetwork, postgres: StartedTestContainer, core: StartedTestContainer;
beforeAll(async () => {
  expect(process.env.TEST_MODE).toBe("testing");
  network = await new Network().start();
  postgres = await new GenericContainer("postgres:14").withNetwork(network).withNetworkAliases("postgres")
    .withEnvironment({ POSTGRES_USER: "supertokens", POSTGRES_PASSWORD: "somepassword", POSTGRES_DB: "supertokens" })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections")).start();
  core = await new GenericContainer("supertokens/supertokens-postgresql").withNetwork(network)
    .withEnvironment({ POSTGRESQL_CONNECTION_URI: "postgresql://supertokens:somepassword@postgres:5432/supertokens" })
    .withExposedPorts(3567).withWaitStrategy(Wait.forHttp("/hello", 3567)).start();
  const connectionURI = `http://${core.getHost()}:${core.getMappedPort(3567)}`;
  expect((await fetch(`${connectionURI}/ee/license`, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ licenseKey: "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V" }) })).ok).toBe(true);
  SuperTokens.init({ supertokens: { connectionURI },
    appInfo: { appName: "Orphan recovery", apiDomain: "http://localhost:3001", websiteDomain: "http://localhost:3000" },
    recipeList: [AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
      Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
      Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }), ThirdParty.init()],
    experimental: { plugins: [init({ rowndAppKey: "test", rowndAppSecret: "test" })] } });
}, 120000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try { await core?.stop(); } finally { try { await postgres?.stop(); } finally { await network?.stop(); } }
});

async function fixture(mapped = false) {
  const sourceId = `rownd-${randomUUID()}`, absentId = randomUUID(), alias = `rownd-${randomUUID()}`;
  const email = `${randomUUID()}@example.com`, subject = randomUUID();
  const profile: RowndUser = { state: "enabled", auth_level: "verified", data: { user_id: sourceId, email, google_id: "stale-raw-subject" },
    verified_data: { email, google_id: subject } };
  const canonical: RowndUser = { state: "enabled", data: { user_id: alias, email, google_id: subject },
    verified_data: { email: "historical@example.com", google_id: subject } };
  const profiles = new Map([[sourceId, profile], ...(mapped ? [[alias, canonical] as const] : [])]);
  rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => profiles.get(user_id));
  const google = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", subject, email, true);
  if (google.status !== "OK") throw new Error(google.status);
  const target = google.user.id;
  expect(await AccountLinking.createPrimaryUser(google.recipeUserId)).toMatchObject({ status: "OK" });
  const passwordless = await Passwordless.signInUp({ tenantId: "public", email });
  expect(await AccountLinking.linkAccounts(passwordless.recipeUserId, target)).toMatchObject({ status: "OK" });
  if (mapped) {
    expect(await SuperTokens.createUserIdMapping({ superTokensUserId: target, externalUserId: alias, force: true })).toMatchObject({ status: "OK" });
    for (const id of [target, alias]) await UserMetadata.updateUserMetadata(id, { original_rownd_user: canonical, rownd_migration_complete: true });
    const token = await EmailVerification.createEmailVerificationToken("public", SuperTokens.convertToRecipeUserId(alias), email);
    if (token.status === "OK") await EmailVerification.verifyEmailUsingToken("public", token.token);
  }
  // Public APIs cannot create an orphan. Seed only this invalid historical row
  // directly in the disposable database; all recovery operations go through Core.
  const seeded = await postgres.exec(["psql", "-U", "supertokens", "-c",
    `INSERT INTO app_id_to_user_id SELECT (jsonb_populate_record(NULL::app_id_to_user_id, to_jsonb(t) || jsonb_build_object('user_id', '${absentId}', 'primary_or_recipe_user_id', '${absentId}'))).* FROM app_id_to_user_id t WHERE user_id = '${target}'; INSERT INTO userid_mapping (app_id, supertokens_user_id, external_user_id) VALUES ('public', '${absentId}', '${sourceId}')`]);
  expect(seeded.exitCode, seeded.output).toBe(0);
  const literal = await Promise.all([
    SuperTokens.getUserIdMapping({ userId: sourceId, userIdType: "EXTERNAL" }),
    SuperTokens.getUserIdMapping({ userId: absentId, userIdType: "SUPERTOKENS" }),
    SuperTokens.getUser(sourceId), SuperTokens.getUser(absentId),
  ]);
  expect(literal, JSON.stringify(literal)).toEqual([
    expect.objectContaining({ status: "OK", superTokensUserId: absentId, externalUserId: sourceId }),
    expect.objectContaining({ status: "OK", superTokensUserId: absentId, externalUserId: sourceId }), undefined, undefined,
  ]);
  const remove = SuperTokens.deleteUserIdMapping.bind(SuperTokens);
  const deletion = vi.spyOn(SuperTokens, "deleteUserIdMapping").mockImplementation(remove);
  return { sourceId, absentId, target, alias, profile, profiles, email, subject, deletion, emailRecipe: passwordless.recipeUserId };
}

it.each([false, true])("previews read-only and executes exact verified provider recovery (existing alias: %s)", async (mapped) => {
  const f = await fixture(mapped);
  const writes = [vi.spyOn(UserMetadata, "updateUserMetadata"), vi.spyOn(SuperTokens, "createUserIdMapping"), f.deletion,
    vi.spyOn(EmailVerification, "unverifyEmail"), vi.spyOn(EmailVerification, "verifyEmailUsingToken")];
  const preview = await reconcileUser({ rownd_user_id: f.sourceId, dryRun: true });
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: false, changed: false, supertokens_user_id: f.target,
    rownd_user_id: mapped ? f.alias : f.sourceId });
  expect(preview.requiresExecutionProof).toContainEqual({ code: "ORPHAN_MAPPING_HANDOFF_REQUIRES_EXECUTION_PROOF", supertokens_user_id: f.target });
  for (const write of writes) expect(write).not.toHaveBeenCalled();
  const result = await reconcileUser({ rownd_user_id: f.sourceId });
  expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", changed: true, supertokens_user_id: f.target, rownd_user_id: mapped ? f.alias : f.sourceId });
  expect((await SuperTokens.getUserIdMapping({ userId: f.absentId, userIdType: "SUPERTOKENS" })).status).toBe("UNKNOWN_MAPPING_ERROR");
  expect((await UserMetadata.getUserMetadata(f.sourceId)).metadata.rownd_migration_orphan_mapping_repair).toMatchObject({ phase: "COMPLETE", absentId: f.absentId, target: f.target });
  const retry = await reconcileUser({ rownd_user_id: f.sourceId });
  expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false, supertokens_user_id: f.target });
  await expect(assertMappingPublicationSessionMembership(mapped ? f.alias : f.sourceId, mapped ? f.alias : f.sourceId, {})).resolves.toBeUndefined();
});

it("honors newer requested activity and lets the owner executor relocate the existing alias", async () => {
  const f = await fixture(true);
  f.profile.meta = { last_active: "2025-01-01T00:00:00.000Z" };
  const preview = await reconcileUser({ rownd_user_id: f.sourceId, dryRun: true });
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", rownd_user_id: f.sourceId });
  expect(preview.proposedActions).toContainEqual({ action: "remove_mapping", rownd_user_id: f.alias, supertokens_user_id: f.target, conditional: true });
  const result = await reconcileUser({ rownd_user_id: f.sourceId });
  expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: f.sourceId, supertokens_user_id: f.target });
  const displaced = await SuperTokens.getUserIdMapping({ userId: f.alias, userIdType: "EXTERNAL" });
  expect(displaced.status).toBe("OK");
  if (displaced.status !== "OK") throw new Error(displaced.status);
  expect(displaced.superTokensUserId).not.toBe(f.target);
  expect((await SuperTokens.getUser(displaced.superTokensUserId))?.id).toBe(f.sourceId);
  expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "OK", changed: false });
});

it("allows a later normal election after orphan repair completes", async () => {
  const f = await fixture(true);
  f.profile.meta = { last_active: "2025-01-01T00:00:00.000Z" };
  expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "OK", rownd_user_id: f.sourceId, supertokens_user_id: f.target });
  const receipt = (await UserMetadata.getUserMetadata(f.sourceId)).metadata.rownd_migration_orphan_mapping_repair;
  expect(receipt).toMatchObject({ phase: "COMPLETE", winner: f.sourceId });
  f.profiles.get(f.alias)!.meta = { last_active: "2026-01-01T00:00:00.000Z" };
  const preview = await reconcileUser({ rownd_user_id: f.sourceId, dryRun: true });
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", rownd_user_id: f.alias, supertokens_user_id: f.target });
  const result = await reconcileUser({ rownd_user_id: f.sourceId });
  expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: f.alias, requested_rownd_user_id: f.sourceId, supertokens_user_id: f.target });
  expect(await SuperTokens.getUserIdMapping({ userId: f.alias, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: f.target });
  const retry = await reconcileUser({ rownd_user_id: f.sourceId });
  expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false, rownd_user_id: f.alias, supertokens_user_id: f.target });
  expect((await UserMetadata.getUserMetadata(f.sourceId)).metadata.rownd_migration_orphan_mapping_repair).toEqual(receipt);
});

it.each(["PREPARED", "HANDOFF"])("keeps the election pinned while orphan repair is %s", async (phase) => {
  const f = await fixture(true);
  f.profile.meta = { last_active: "2025-01-01T00:00:00.000Z" };
  const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
  const lost = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[1].rownd_migration_orphan_mapping_repair?.phase === phase) throw new Error("checkpoint response lost");
    return result;
  });
  expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "ERROR" });
  lost.mockRestore();
  f.profiles.get(f.alias)!.meta = { last_active: "2026-01-01T00:00:00.000Z" };
  const nested = vi.fn(), mutation = vi.fn();
  for (const dryRun of [true, false]) await expect(recoverOrphanMapping({ sourceId: f.sourceId, tenantId: "public", userContext: {}, dryRun,
    onMutation: mutation, reconcile: nested })).rejects.toThrow(/checkpoint evidence changed|handoff alias source changed/);
  expect(nested).not.toHaveBeenCalled();
  expect(mutation).not.toHaveBeenCalled();
});

it.each(["mapping", "canonical-target", "missing-mapping"])("validates recovered ownership on COMPLETE retry after %s drift", async (drift) => {
  const f = await fixture(true);
  f.profile.meta = { last_active: "2025-01-01T00:00:00.000Z" };
  expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "OK" });
  if (drift === "canonical-target") await UserMetadata.updateUserMetadata(f.sourceId, { rownd_migration_canonical_target: randomUUID() });
  else {
    await SuperTokens.deleteUserIdMapping({ userId: f.sourceId, userIdType: "EXTERNAL", force: true });
    if (drift === "mapping") {
      const other = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@example.com` });
      expect(await SuperTokens.createUserIdMapping({ superTokensUserId: other.user.id, externalUserId: f.sourceId, force: true })).toMatchObject({ status: "OK" });
    }
  }
  const nested = vi.fn(), mutation = vi.fn();
  for (const dryRun of [true, false]) await expect(recoverOrphanMapping({ sourceId: f.sourceId, tenantId: "public", userContext: {}, dryRun,
    onMutation: mutation, reconcile: nested })).rejects.toThrow(/requested source/);
  expect(nested).not.toHaveBeenCalled();
  expect(mutation).not.toHaveBeenCalled();
});

it("does not borrow the losing source's verified email for an unverified credential of the canonical alias", async () => {
  const f = await fixture(true);
  await EmailVerification.unverifyEmail(f.emailRecipe, f.email);
  const preview = await reconcileUser({ rownd_user_id: f.sourceId, dryRun: true });
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", rownd_user_id: f.alias });
  expect(preview.proposedActions?.some((action) => action.action === "verify_email")).toBe(false);
  const result = await reconcileUser({ rownd_user_id: f.sourceId });
  expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: f.alias });
  expect(await EmailVerification.isEmailVerified(f.emailRecipe, f.email)).toBe(false);
});

it.each([false, true])("requires elected exact email proof before creating a missing credential (requested wins: %s)", async (wins) => {
  const f = await fixture(true);
  await AccountLinking.unlinkAccount(f.emailRecipe);
  await SuperTokens.deleteUser(f.emailRecipe.getAsString(), false);
  if (wins) f.profile.meta = { last_active: "2025-01-01T00:00:00.000Z" };
  const preview = await reconcileUser({ rownd_user_id: f.sourceId, dryRun: true });
  if (!wins) {
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "BLOCKED" });
    expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "BLOCKED", changed: false });
    expect(f.deletion).not.toHaveBeenCalled();
    return;
  }
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", rownd_user_id: f.sourceId });
  const result = await reconcileUser({ rownd_user_id: f.sourceId });
  expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: f.target });
  expect((await SuperTokens.getUser(f.target))?.loginMethods).toEqual(expect.arrayContaining([
    expect.objectContaining({ recipeId: "passwordless", email: f.email, verified: true }),
  ]));
  expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "OK", changed: false });
});

it.each([false, true].flatMap((mapped) => ["checkpoint", "deletion", "handoff", "publication"].map((crash) => ({ mapped, crash }))))("resumes a lost $crash response through the normal executor (existing alias: $mapped)", async ({ mapped, crash }) => {
  const f = await fixture(mapped);
  if (mapped) f.profile.meta = { last_active: "2025-01-01T00:00:00.000Z" };
  let interrupted = false;
  const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
  const updateSpy = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (!interrupted && args[0] === f.sourceId &&
      args[1].rownd_migration_orphan_mapping_repair?.phase === (crash === "checkpoint" ? "PREPARED" : crash === "handoff" ? "HANDOFF" : "never")) {
      interrupted = true; throw new Error(`lost ${crash} response`);
    }
    return result;
  });
  if (crash === "deletion") {
    const remove = f.deletion.getMockImplementation()!;
    f.deletion.mockImplementation(async (input) => {
      const result = await remove(input);
      if (!interrupted) { interrupted = true; throw new Error("lost deletion response"); }
      return result;
    });
  }
  const publish = SuperTokens.createUserIdMapping.bind(SuperTokens);
  const publishSpy = vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementation(async (input) => {
    const result = await publish(input);
    if (!interrupted && crash === "publication") { interrupted = true; throw new Error("lost publication response"); }
    return result;
  });
  const first = await reconcileUser({ rownd_user_id: f.sourceId });
  expect(first, JSON.stringify(first)).toMatchObject({ status: "ERROR" });
  expect(interrupted).toBe(true);
  if (crash === "publication") await expect(assertMappingPublicationSessionMembership(f.sourceId, f.sourceId, {})).rejects.toThrow(/incomplete/);
  updateSpy.mockRestore();
  publishSpy.mockRestore();
  const writes = [vi.spyOn(UserMetadata, "updateUserMetadata"), vi.spyOn(SuperTokens, "createUserIdMapping")];
  f.deletion.mockClear();
  const preview = await reconcileUser({ rownd_user_id: f.sourceId, dryRun: true });
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", changed: false, canReconcile: false, matchesSource: false });
  expect(preview.proposedActions?.some((action) => action.action === "remove_mapping" && action.supertokens_user_id === f.absentId)).toBe(crash === "checkpoint");
  for (const write of writes) expect(write).not.toHaveBeenCalled();
  expect(f.deletion).not.toHaveBeenCalled();
  const resumed = await reconcileUser({ rownd_user_id: f.sourceId });
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: "OK", supertokens_user_id: f.target });
  expect((await UserMetadata.getUserMetadata(f.sourceId)).metadata.rownd_migration_orphan_mapping_repair.phase).toBe("COMPLETE");
});

it.each(["provider", "email", "additional-owner", "lookup-error"])("keeps insufficient or uncertain %s proof blocked without writes", async (reason) => {
  const f = await fixture();
  if (reason === "provider") f.profile.verified_data!.google_id = "different-authoritative-subject";
  if (reason === "email") f.profile.verified_data!.email = "historical@example.com";
  if (reason === "additional-owner") {
    const other = await ThirdParty.manuallyCreateOrUpdateUser("public", "apple", randomUUID(), f.email, false);
    if (other.status !== "OK") throw new Error(other.status);
    await AccountLinking.unlinkAccount(other.recipeUserId);
  }
  if (reason === "lookup-error") {
    const getUser = SuperTokens.getUser.bind(SuperTokens);
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id, context) => { if (id === f.absentId) throw new Error("Core unavailable"); return getUser(id, context); });
  }
  const update = vi.spyOn(UserMetadata, "updateUserMetadata");
  for (const dryRun of [true, false]) {
    const result = await reconcileUser({ rownd_user_id: f.sourceId, dryRun });
    expect(result, JSON.stringify(result)).toMatchObject({ status: reason === "lookup-error" ? "ERROR" : "BLOCKED", changed: false });
  }
  expect(update).not.toHaveBeenCalled();
  expect(f.deletion).not.toHaveBeenCalled();
});

it.each(["source", "metadata", "verification", "reappearance", "graph", "mapping-info"])("rejects %s drift after a durable checkpoint without deleting the orphan", async (drift) => {
  const f = await fixture();
  const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
  const checkpoint = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[1].rownd_migration_orphan_mapping_repair?.phase === "PREPARED") throw new Error("checkpoint response lost");
    return result;
  });
  expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "ERROR", partialProgress: true, changed: null });
  checkpoint.mockRestore();
  if (drift === "source") f.profile.verified_data!.google_id = randomUUID();
  if (drift === "metadata") await UserMetadata.updateUserMetadata(f.target, { unrelated: "concurrent write" });
  if (drift === "mapping-info") await SuperTokens.updateOrDeleteUserIdMappingInfo({ userId: f.sourceId, userIdType: "EXTERNAL", externalUserIdInfo: "concurrent change" });
  if (drift === "verification") await EmailVerification.unverifyEmail(SuperTokens.convertToRecipeUserId(f.target), f.email);
  if (drift === "graph") {
    const extra = await ThirdParty.manuallyCreateOrUpdateUser("public", "apple", randomUUID(), `${randomUUID()}@example.com`, false);
    if (extra.status !== "OK") throw new Error(extra.status);
    await AccountLinking.linkAccounts(extra.recipeUserId, f.target);
  }
  if (drift === "reappearance") {
    const lookup = SuperTokens.getUser.bind(SuperTokens);
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id, context) => lookup(id === f.absentId ? f.target : id, context));
  }
  for (const dryRun of [true, false]) expect(await reconcileUser({ rownd_user_id: f.sourceId, dryRun })).toMatchObject({ status: "BLOCKED" });
  expect(f.deletion).not.toHaveBeenCalled();
});

it("rejects immutable graph drift after deletion and before the normal executor resumes", async () => {
  const f = await fixture();
  const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
  const checkpoint = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[1].rownd_migration_orphan_mapping_repair?.phase === "HANDOFF") throw new Error("handoff response lost");
    return result;
  });
  expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "ERROR", partialProgress: true });
  checkpoint.mockRestore();
  const extra = await ThirdParty.manuallyCreateOrUpdateUser("public", "apple", randomUUID(), `${randomUUID()}@example.com`, false);
  if (extra.status !== "OK") throw new Error(extra.status);
  await AccountLinking.linkAccounts(extra.recipeUserId, f.target);
  const publish = vi.spyOn(SuperTokens, "createUserIdMapping");
  expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "BLOCKED", message: expect.stringContaining("immutable recipe graph changed") });
  expect(publish).not.toHaveBeenCalled();
});

it.each(["PREPARED", "HANDOFF"])("upgrades a matching earlier %s checkpoint without discarding its evidence", async (phase) => {
  const f = await fixture(phase === "HANDOFF");
  if (phase === "HANDOFF") f.profile.meta = { last_active: "2025-01-01T00:00:00.000Z" };
  const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
  const checkpoint = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[1].rownd_migration_orphan_mapping_repair?.phase === phase) throw new Error("response lost");
    return result;
  });
  expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "ERROR" });
  checkpoint.mockRestore();
  const old = (await UserMetadata.getUserMetadata(f.sourceId)).metadata.rownd_migration_orphan_mapping_repair;
  delete old.absence;
  const profile = JSON.parse(old.sourceIdentity);
  old.sourceIdentity = JSON.stringify([profile.data, profile.verified_data, profile.state, profile.auth_level, profile.meta]);
  const evidence = JSON.parse(old.evidence);
  evidence.sourceIdentity = old.sourceIdentity;
  delete evidence.mappings;
  old.evidence = JSON.stringify(evidence);
  await UserMetadata.updateUserMetadata(f.sourceId, { rownd_migration_orphan_mapping_repair: old,
    ...(phase === "HANDOFF" ? { rownd_migration_target: f.target } : {}) });
  const write = vi.spyOn(UserMetadata, "updateUserMetadata");
  const preview = await reconcileUser({ rownd_user_id: f.sourceId, dryRun: true });
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: false, changed: false });
  expect(write).not.toHaveBeenCalled();
  const result = await reconcileUser({ rownd_user_id: f.sourceId });
  expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: f.target });
  const completed = (await UserMetadata.getUserMetadata(f.sourceId)).metadata.rownd_migration_orphan_mapping_repair;
  expect(completed.phase).toBe("COMPLETE");
  expect(JSON.parse(completed.previousCheckpoint)).toEqual(old);
});

it.each(["canonical-target", "provisional-target", "source-namespace", "application-metadata"])("blocks requested loser %s drift on HANDOFF retry before nested reconciliation", async (drift) => {
  const f = await fixture(true);
  const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
  const lost = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[1].rownd_migration_orphan_mapping_repair?.phase === "HANDOFF") throw new Error("handoff response lost");
    return result;
  });
  expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "ERROR" });
  lost.mockRestore();
  if (drift === "canonical-target") await UserMetadata.updateUserMetadata(f.sourceId, { rownd_migration_canonical_target: randomUUID() });
  if (drift === "provisional-target") await UserMetadata.updateUserMetadata(f.sourceId, { rownd_migration_target: f.target });
  if (drift === "application-metadata") await UserMetadata.updateUserMetadata(f.sourceId, { unexpected: "concurrent source write" });
  if (drift === "source-namespace") {
    const lookup = SuperTokens.getUserIdMapping.bind(SuperTokens);
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async (input) => input.userId === f.sourceId && input.userIdType === "SUPERTOKENS"
      ? { status: "OK", superTokensUserId: f.sourceId, externalUserId: "foreign-alias" } : lookup(input));
  }
  const nested = vi.fn(), mutation = vi.fn(), write = vi.spyOn(UserMetadata, "updateUserMetadata");
  for (const dryRun of [true, false]) await expect(recoverOrphanMapping({ sourceId: f.sourceId, tenantId: "public", userContext: {}, dryRun,
    onMutation: mutation, reconcile: nested })).rejects.toThrow(/requested source/);
  expect(nested).not.toHaveBeenCalled();
  expect(mutation).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect((await UserMetadata.getUserMetadata(f.sourceId)).metadata.rownd_migration_orphan_mapping_repair.phase).toBe("HANDOFF");
});

it.each(["PREPARED", "HANDOFF", "COMPLETE"])("rejects incomplete current and legacy %s evidence before a nested callback", async (phase) => {
  const f = await fixture(true);
  f.profile.meta = { last_active: "2025-01-01T00:00:00.000Z" };
  expect(await reconcileUser({ rownd_user_id: f.sourceId })).toMatchObject({ status: "OK" });
  const complete = (await UserMetadata.getUserMetadata(f.sourceId)).metadata.rownd_migration_orphan_mapping_repair;
  for (const legacy of [false, true]) {
    const original = structuredClone(complete);
    original.phase = phase;
    const originalEvidence = JSON.parse(original.evidence);
    if (legacy) {
      delete original.absence;
      const profile = JSON.parse(original.sourceIdentity);
      original.sourceIdentity = JSON.stringify([profile.data, profile.verified_data, profile.state, profile.auth_level, profile.meta]);
      originalEvidence.sourceIdentity = original.sourceIdentity;
      delete originalEvidence.mappings;
    }
    const changes: Array<[string, (record: any, evidence: any) => void]> = [
      ...["primary", "recipes", "aliases", "metadata", "profiles", "verifications", "election", "target", "winner", "sourceIdentity", ...(legacy ? [] : ["mappings"])].map((field): [string, (record: any, evidence: any) => void] =>
        [`missing ${field}`, (_record, evidence) => { delete evidence[field]; }]),
      ...["recipes", "aliases", "election", "verifications", ...(legacy ? [] : ["mappings"])].map((field): [string, (record: any, evidence: any) => void] =>
        [`empty ${field}`, (_record, evidence) => { evidence[field] = []; }]),
      ["empty metadata", (_record, evidence) => { evidence.metadata = {}; }],
      ["empty profiles", (_record, evidence) => { evidence.profiles = {}; }],
      ...[f.sourceId, f.absentId, f.target].map((id): [string, (record: any, evidence: any) => void] =>
        [`missing literal ${id}`, (_record, evidence) => { delete evidence.metadata[id]; }]),
      ["missing primary recipe", (_record, evidence) => { evidence.recipes = evidence.recipes.filter((recipe: any) => recipe.id !== f.target); }],
      ["partial verification coverage", (_record, evidence) => { evidence.verifications.pop(); }],
      ["truncated recipe", (_record, evidence) => { evidence.recipes[0] = { id: evidence.recipes[0].id }; }],
      ["wrong alias recipe", (_record, evidence) => { evidence.aliases[0][1] = "foreign-recipe"; }],
      ["foreign winner", (record, evidence) => { record.winner = evidence.winner = "foreign-source"; }],
      ["unelected member winner", (record, evidence) => { record.winner = evidence.winner = f.alias; }],
      ["missing source election membership", (_record, evidence) => { evidence.election = evidence.election.filter((candidate: any) => candidate.rownd_user_id !== f.sourceId); }],
      ["arbitrary prior checkpoint", (record) => { record.previousCheckpoint = "arbitrary"; }],
      ["empty prior checkpoint", (record) => { record.previousCheckpoint = "{}"; }],
    ];
    for (const [label, change] of changes) {
      const record = structuredClone(original), evidence = structuredClone(originalEvidence);
      change(record, evidence);
      record.evidence = JSON.stringify(evidence);
      await UserMetadata.updateUserMetadata(f.sourceId, { rownd_migration_orphan_mapping_repair: record });
      const nested = vi.fn(), mutation = vi.fn();
      for (const dryRun of [true, false]) await expect(recoverOrphanMapping({ sourceId: f.sourceId, tenantId: "public", userContext: {}, dryRun,
        onMutation: mutation, reconcile: nested }), `${legacy ? "legacy" : "current"} ${phase}: ${label}`).rejects.toThrow("invalid durable checkpoint");
      expect(nested).not.toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();
    }
  }
});
