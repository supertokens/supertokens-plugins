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
import { setRowndTokenValidator } from "./rownd-repository";
import { reconcileUser } from "./reconcile-user";
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
    appInfo: { appName: "Owner lineage", apiDomain: "http://localhost:3001", websiteDomain: "http://localhost:3000" },
    recipeList: [AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
      Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
      Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }), ThirdParty.init()],
    experimental: { plugins: [init({ rowndAppKey: "test", rowndAppSecret: "test", rowndJwtAudience: "app:test-app" })] } });
  setRowndTokenValidator(rownd.validateToken);
}, 120000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try { await core?.stop(); } finally { try { await postgres?.stop(); } finally { await network?.stop(); } }
});

async function lineage() {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const subject = randomUUID(), email = `${randomUUID()}@example.com`;
  const profiles = new Map(ids.map((id, index): [string, RowndUser] => [id, {
    data: { user_id: id, apple_id: subject, email }, meta: { last_active: `${2020 + index}-01-01T00:00:00.000Z` },
  }]));
  rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => profiles.get(user_id));
  const apple = await ThirdParty.manuallyCreateOrUpdateUser("public", "apple", subject, email, false);
  if (apple.status !== "OK") throw new Error(apple.status);
  const target = apple.user.id;
  expect(await SuperTokens.createUserIdMapping({ superTokensUserId: target, externalUserId: ids[0]!, force: true })).toMatchObject({ status: "OK" });
  for (const id of [target, ids[0]!]) await UserMetadata.updateUserMetadata(id, { original_rownd_user: profiles.get(ids[0]!), rownd_migration_complete: true });
  const first = await reconcileUser({ rownd_user_id: ids[1]! });
  expect(first, JSON.stringify(first)).toMatchObject({ status: "OK" });
  const replay = await reconcileUser({ rownd_user_id: ids[1]! });
  expect(replay, JSON.stringify(replay)).toMatchObject({ status: "OK", changed: false });
  return { ids, target, profiles };
}

it.each([false, true])("chains a completed retirement into a new election and replays without changes (interrupted: %s)", async (interrupt) => {
  const { ids, target, profiles } = await lineage();
  const preview = await reconcileUser({ rownd_user_id: ids[2]!, dryRun: true });
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true });
  expect(preview.election?.candidates.map((entry) => entry.rownd_user_id)).not.toContain(ids[0]);
  if (interrupt) {
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    let lost = false;
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
      const result = await update(...args);
      if (!lost && args[0] === target && args[1].rownd_migration_owner_consolidation?.status === "RECONCILING") {
        lost = true;
        throw new Error("Lost chained election response");
      }
      return result;
    });
    const interrupted = await reconcileUser({ rownd_user_id: ids[2]! });
    expect(interrupted, JSON.stringify(interrupted)).toMatchObject({ status: "ERROR", message: "Lost chained election response" });
    vi.restoreAllMocks();
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => profiles.get(user_id));
  }
  const result = await reconcileUser({ rownd_user_id: ids[2]! });
  expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: target });
  expect((await UserMetadata.getUserMetadata(ids[0]!)).metadata.rownd_migration_superseded).toEqual({ rowndUserId: ids[2], targetUserId: target });
  const retry = await reconcileUser({ rownd_user_id: ids[2]! });
  expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false, actions: [] });
});

it.each(["remap", "marker"])("rejects completed retirement %s drift", async (drift) => {
  const { ids } = await lineage();
  if (drift === "marker") await UserMetadata.updateUserMetadata(ids[0]!, { rownd_migration_superseded: { rowndUserId: "tampered", targetUserId: "tampered" } });
  else {
    const other = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@example.com` });
    await SuperTokens.createUserIdMapping({ superTokensUserId: other.user.id, externalUserId: ids[0]!, force: true });
  }
  for (const dryRun of [true, false]) {
    const result = await reconcileUser({ rownd_user_id: ids[2]!, dryRun });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
  }
});

it.each([false, true])("recovers pointerless historical email after snapshot overwrite (provider drift: %s)", async (drift) => {
  const old = randomUUID(), winner = randomUUID(), subject = randomUUID();
  const historical = `${randomUUID()}@privaterelay.appleid.com`, email = `${randomUUID()}@example.com`;
  const profiles = new Map<string, RowndUser>([
    [old, { data: { user_id: old, apple_id: subject, email: historical }, verified_data: { email: historical, apple_id: subject }, meta: { last_active: "2020-01-01T00:00:00.000Z" } }],
    [winner, { data: { user_id: winner, apple_id: subject, email }, verified_data: { email, apple_id: subject }, meta: { last_active: "2021-01-01T00:00:00.000Z" } }],
  ]);
  rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => profiles.get(user_id));
  const apple = await ThirdParty.manuallyCreateOrUpdateUser("public", "apple", subject, historical, false);
  if (apple.status !== "OK") throw new Error(apple.status);
  const target = apple.user.id;
  expect(await AccountLinking.createPrimaryUser(apple.recipeUserId)).toMatchObject({ status: "OK" });
  const pwl = await Passwordless.signInUp({ tenantId: "public", email: historical });
  await EmailVerification.unverifyEmail(pwl.recipeUserId, historical);
  expect(await AccountLinking.linkAccounts(pwl.recipeUserId, target)).toMatchObject({ status: "OK" });
  const current = await Passwordless.signInUp({ tenantId: "public", email });
  expect(await AccountLinking.linkAccounts(current.recipeUserId, target)).toMatchObject({ status: "OK" });
  await SuperTokens.createUserIdMapping({ superTokensUserId: target, externalUserId: old, force: true });
  for (const id of [target, old, pwl.user.id]) await UserMetadata.updateUserMetadata(id, { original_rownd_user: profiles.get(old), rownd_migration_complete: true });
  profiles.set(old, { ...profiles.get(old)!, data: { user_id: old, apple_id: subject, email }, verified_data: { email, apple_id: subject } });
  const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
  let interrupted = false;
  vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (!interrupted && args[0] === target && args[1].rownd_migration_owner_consolidation?.status === "RECONCILING") {
      interrupted = true;
      throw new Error("Lost reconciling checkpoint response");
    }
    return result;
  });
  const first = await reconcileUser({ rownd_user_id: winner });
  expect(first, JSON.stringify(first)).toMatchObject({ status: "ERROR", message: "Lost reconciling checkpoint response" });
  expect(interrupted).toBe(true);
  vi.restoreAllMocks();
  rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => profiles.get(user_id));
  expect((await UserMetadata.getUserMetadata(target)).metadata.original_rownd_user.data.email).toBe(email);
  if (drift) profiles.get(winner)!.verified_data!.apple_id = randomUUID();
  const preview = await reconcileUser({ rownd_user_id: winner, dryRun: true });
  if (drift) {
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "BLOCKED", changed: false });
    return;
  }
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true });
  const resumed = await reconcileUser({ rownd_user_id: winner });
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: "OK" });
  const retry = await reconcileUser({ rownd_user_id: winner });
  expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false });
});

it.each(["resume", "remap", "pointer drift"])("validates the recorded canonical alias during a lost mapping-deletion response (%s)", async (mode) => {
  const winner = randomUUID(), old = randomUUID(), email = `${randomUUID()}@example.com`, historical = `${randomUUID()}@example.com`;
  const profile = (id: string, year: number): RowndUser => ({ data: { user_id: id, email }, verified_data: { email }, meta: { last_active: `${year}-01-01T00:00:00.000Z` } });
  const profiles = new Map([[winner, profile(winner, 2021)], [old, profile(old, 2020)]]);
  rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => profiles.get(user_id));
  const current = await Passwordless.signInUp({ tenantId: "public", email });
  expect(await AccountLinking.createPrimaryUser(current.recipeUserId)).toMatchObject({ status: "OK" });
  const donor = await Passwordless.signInUp({ tenantId: "public", email: historical });
  await EmailVerification.unverifyEmail(donor.recipeUserId, historical);
  expect(await AccountLinking.linkAccounts(donor.recipeUserId, current.user.id)).toMatchObject({ status: "OK" });
  await SuperTokens.createUserIdMapping({ superTokensUserId: current.user.id, externalUserId: old, force: true });
  await SuperTokens.createUserIdMapping({ superTokensUserId: donor.user.id, externalUserId: winner, force: true });
  for (const id of [current.user.id, old]) await UserMetadata.updateUserMetadata(id, { original_rownd_user: profiles.get(old), rownd_migration_complete: true });
  for (const id of [donor.user.id, winner]) await UserMetadata.updateUserMetadata(id, {
    original_rownd_user: { ...profiles.get(winner), data: { user_id: winner, email: historical }, verified_data: { email: historical } },
    rownd_migration_complete: true, rownd_email_recipe_user_id: winner,
  });
  const remove = SuperTokens.deleteUserIdMapping.bind(SuperTokens);
  let interrupted = false;
  vi.spyOn(SuperTokens, "deleteUserIdMapping").mockImplementation(async (...args) => {
    const result = await remove(...args);
    if (!interrupted && args[0].userId === winner) { interrupted = true; throw new Error("Lost canonical alias deletion response"); }
    return result;
  });
  const first = await reconcileUser({ rownd_user_id: winner });
  expect(first, JSON.stringify(first)).toMatchObject({ status: "ERROR", message: "Lost canonical alias deletion response" });
  expect(interrupted).toBe(true);
  vi.restoreAllMocks();
  rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => profiles.get(user_id));
  expect((await SuperTokens.getUserIdMapping({ userId: winner, userIdType: "EXTERNAL" })).status).toBe("UNKNOWN_MAPPING_ERROR");
  if (mode !== "resume") {
    const unrelated = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@example.com` });
    if (mode === "remap") await SuperTokens.createUserIdMapping({ superTokensUserId: unrelated.user.id, externalUserId: winner, force: true });
    else await UserMetadata.updateUserMetadata(winner, { rownd_email_recipe_user_id: unrelated.user.id });
    for (const dryRun of [true, false]) {
      const result = await reconcileUser({ rownd_user_id: winner, dryRun });
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    }
    return;
  }
  const preview = await reconcileUser({ rownd_user_id: winner, dryRun: true });
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true });
  const resumed = await reconcileUser({ rownd_user_id: winner });
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: "OK", supertokens_user_id: current.user.id });
  const retry = await reconcileUser({ rownd_user_id: winner });
  expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false });
});

it.each(["same", "different", "lost response", "lost primary response", "validation addition", "validation change"])("aligns literal pending email preview and execution (%s)", async (mode) => {
  const different = mode === "different";
  const rowndId = randomUUID(), email = `${randomUUID()}@example.com`, historical = `${randomUUID()}@example.com`, subject = randomUUID();
  const profile: RowndUser = { data: { user_id: rowndId, email, google_id: subject }, verified_data: { email, google_id: subject } };
  rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
  const google = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", subject, historical, false);
  if (google.status !== "OK") throw new Error(google.status);
  expect(await AccountLinking.createPrimaryUser(google.recipeUserId)).toMatchObject({ status: "OK" });
  const current = await Passwordless.signInUp({ tenantId: "public", email });
  await EmailVerification.unverifyEmail(current.recipeUserId, email);
  expect(await AccountLinking.linkAccounts(current.recipeUserId, google.user.id)).toMatchObject({ status: "OK" });
  await SuperTokens.createUserIdMapping({ superTokensUserId: google.user.id, externalUserId: rowndId, force: true });
  await UserMetadata.updateUserMetadata(google.user.id, { original_rownd_user: profile, rownd_migration_complete: true });
  const pending = { id: randomUUID(), field: "email", value: different ? `${randomUUID()}@example.com` : email,
    created_at: new Date().toISOString(), tenantId: "public", purpose: "ADD_PASSWORDLESS", status: "PENDING", verificationRecipeUserId: mode === "same" ? google.user.id : rowndId };
  const unrelated = { ...pending, id: randomUUID(), tenantId: "other-tenant", value: `${randomUUID()}@example.com` };
  const duplicate = mode === "lost primary response";
  const duringValidation = mode.startsWith("validation ");
  const initialUnrelated = duplicate || mode === "validation change" ? [unrelated] : [];
  await UserMetadata.updateUserMetadata(rowndId, { original_rownd_user: profile, rownd_pending_verification: [pending, ...initialUnrelated] });
  if (duplicate) await UserMetadata.updateUserMetadata(google.user.id, { rownd_pending_verification: [pending] });
  const preview = await reconcileUser({ rownd_user_id: rowndId, dryRun: true });
  let lost = false;
  const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
  if (mode === "lost response" || duplicate) vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (!lost && args[0] === (duplicate ? google.user.id : rowndId) && Array.isArray(args[1].rownd_pending_verification) && !args[1].rownd_pending_verification.length) {
      lost = true;
      throw new Error("Lost pending cleanup response");
    }
    return result;
  });
  if (mode === "lost response" || duplicate) {
    const interrupted = await reconcileUser({ rownd_user_id: rowndId });
    expect(interrupted, JSON.stringify(interrupted)).toMatchObject({ status: "ERROR", message: "Lost pending cleanup response" });
    expect(lost).toBe(true);
    if (duplicate) {
      expect((await UserMetadata.getUserMetadata(google.user.id)).metadata.rownd_pending_verification).toEqual([]);
      expect((await UserMetadata.getUserMetadata(rowndId)).metadata.rownd_pending_verification).toEqual([pending, unrelated]);
      const retryPreview = await reconcileUser({ rownd_user_id: rowndId, dryRun: true });
      expect(retryPreview, JSON.stringify(retryPreview)).toMatchObject({ status: "PREVIEW", canReconcile: true });
    }
  }
  let injected = false;
  if (duringValidation) {
    const authorization = await import("./migration-email");
    const authenticate = authorization.assertAuthenticatedMigrationSource;
    const revoke = EmailVerification.revokeEmailVerificationTokens.bind(EmailVerification);
    let cleanupStarted = false;
    vi.spyOn(EmailVerification, "revokeEmailVerificationTokens").mockImplementation(async (...args) => {
      const result = await revoke(...args);
      cleanupStarted = true;
      return result;
    });
    vi.spyOn(authorization, "assertAuthenticatedMigrationSource").mockImplementation(async (...args) => {
      const authentication = await authenticate(...args);
      if (!cleanupStarted || injected) return authentication;
      injected = true;
      const latest = (await UserMetadata.getUserMetadata(rowndId)).metadata;
      const records = latest.rownd_pending_verification as Array<typeof pending>;
      unrelated.value = `${randomUUID()}@example.com`;
      await update(rowndId, { rownd_pending_verification: [...records.filter((entry) => entry.id !== unrelated.id), unrelated] });
      return authentication;
    });
  }
  const result = await reconcileUser({ rownd_user_id: rowndId });
  if (different) {
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "BLOCKED", canReconcile: false });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    expect((await UserMetadata.getUserMetadata(rowndId)).metadata.rownd_pending_verification).toEqual([pending]);
  } else {
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK" });
    expect(await EmailVerification.isEmailVerified(current.recipeUserId, email)).toBe(true);
    expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(rowndId), historical)).toBe(false);
    if (duringValidation) expect(injected).toBe(true);
    expect((await UserMetadata.getUserMetadata(rowndId)).metadata.rownd_pending_verification).toEqual(duplicate || duringValidation ? [unrelated] : []);
    if (duplicate) expect((await UserMetadata.getUserMetadata(google.user.id)).metadata.rownd_pending_verification).toEqual([]);
    const retry = await reconcileUser({ rownd_user_id: rowndId });
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false });
  }
});
