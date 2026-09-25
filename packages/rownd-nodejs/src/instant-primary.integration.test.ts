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
import { inspectInstantPrimaryProof } from "./migration-instant-election";
import { buildRowndSessionAndAnonymousClaims, RowndIsAnonymousClaim } from "./supertokens-repository";
import { withProvenSessionAuthentication } from "./session-authentication";
import { buildConfiguredSessionClaims } from "./rownd-compatibility";
import { getPluginConfig } from "./config";
import { readOwnerPlanCheckpoint } from "./migration-owner-plan";
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
    appInfo: { appName: "Instant primary", apiDomain: "http://localhost:3001", websiteDomain: "http://localhost:3000" },
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

async function fixture(separate = false, aliasOnly = false, unverifiedNative = false) {
  const instant = randomUUID(), authenticated = randomUUID(), subject = randomUUID(), email = `${randomUUID()}@example.com`;
  const profiles = new Map<string, RowndUser>([
    [instant, { data: { user_id: instant }, auth_level: "instant" }],
    [authenticated, { data: { user_id: authenticated, google_id: subject, email }, verified_data: { google_id: subject, email }, meta: { last_active: "2025-01-01T00:00:00.000Z" } }],
  ]);
  rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => structuredClone(profiles.get(user_id)));
  const primary = await ThirdParty.manuallyCreateOrUpdateUser("public", "instant", instant, `${instant}@anonymous.local`, false);
  const google = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", subject, email, false);
  if (primary.status !== "OK" || google.status !== "OK") throw new Error("fixture creation failed");
  expect(await AccountLinking.createPrimaryUser(primary.recipeUserId)).toMatchObject({ status: "OK" });
  if (!separate) expect(await AccountLinking.linkAccounts(google.recipeUserId, primary.user.id)).toMatchObject({ status: "OK" });
  if (aliasOnly) {
    const native = await Passwordless.signInUp({ tenantId: "public", email });
    if (unverifiedNative) await EmailVerification.unverifyEmail(native.recipeUserId, email);
    expect(await AccountLinking.linkAccounts(native.recipeUserId, primary.user.id)).toMatchObject({ status: "OK" });
  }
  for (const [alias, id] of [[instant, primary.user.id], [authenticated, google.user.id]] as const) {
    await SuperTokens.createUserIdMapping({ superTokensUserId: id, externalUserId: alias, force: true });
    for (const literal of aliasOnly && alias === authenticated ? [alias] : [alias, id]) await UserMetadata.updateUserMetadata(literal, {
      original_rownd_user: profiles.get(alias), rownd_migration_complete: true, rownd_migration_canonical_target: id,
    });
  }
  return { instant, authenticated, profiles, target: primary.user.id, secondary: google.user.id };
}

it.each(["normal", "lost metadata", "lost mapping", "identity drift", "graph drift", "mapping drift"])("previews, executes and retries alias-only authenticated provenance (%s)", async (mode) => {
  const { instant, authenticated, target, secondary, profiles } = await fixture(false, true, mode === "lost metadata");
  const preview = await reconcileUser({ rownd_user_id: authenticated, dryRun: true });
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true });
  expect(preview.election?.candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({ rownd_user_id: instant, supertokens_user_id: target }),
    expect.objectContaining({ rownd_user_id: authenticated, supertokens_user_id: secondary }),
  ]));
  let lost = false;
  if (mode === "lost metadata" || mode.endsWith("drift")) {
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
      const result = await update(...args);
      if (!lost && args[0] === target && args[1].rownd_migration_owner_consolidation?.status === "RECONCILING") {
        lost = true; throw new Error("lost instant response");
      }
      return result;
    });
  }
  if (mode === "lost mapping") {
    const remove = SuperTokens.deleteUserIdMapping.bind(SuperTokens);
    vi.spyOn(SuperTokens, "deleteUserIdMapping").mockImplementation(async (...args) => {
      const result = await remove(...args);
      if (!lost && args[0].userId === authenticated) { lost = true; throw new Error("lost instant response"); }
      return result;
    });
  }
  const executed = await reconcileUser({ rownd_user_id: authenticated });
  expect(executed, JSON.stringify(executed)).toMatchObject({ status: mode === "normal" ? "OK" : "ERROR" });
  if (mode !== "normal") {
    expect(lost).toBe(true);
    vi.restoreAllMocks();
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => profiles.get(user_id));
    if (mode === "identity drift") profiles.get(instant)!.data.email = "acquired@example.com";
    if (mode === "graph drift") await AccountLinking.unlinkAccount(SuperTokens.convertToRecipeUserId(secondary));
    if (mode === "mapping drift") {
      const unrelated = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@example.com` });
      await SuperTokens.deleteUserIdMapping({ userId: instant, userIdType: "EXTERNAL", force: true });
      await SuperTokens.createUserIdMapping({ superTokensUserId: unrelated.user.id, externalUserId: instant, force: true });
    }
    if (mode.endsWith("drift")) {
      for (const dryRun of [true, false]) {
        const rejected = await reconcileUser({ rownd_user_id: authenticated, dryRun });
        expect(["BLOCKED", "AMBIGUOUS"], JSON.stringify(rejected)).toContain(rejected.status);
      }
      return;
    }
    const resumedPreview = await reconcileUser({ rownd_user_id: authenticated, dryRun: true });
    expect(resumedPreview, JSON.stringify(resumedPreview)).toMatchObject({ status: "PREVIEW", canReconcile: true });
    const resume = await reconcileUser({ rownd_user_id: authenticated });
    expect(resume, JSON.stringify(resume)).toMatchObject({ status: "OK" });
  }
  expect(await SuperTokens.getUserIdMapping({ userId: authenticated, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: target });
  expect(await SuperTokens.getUserIdMapping({ userId: instant, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: secondary });
  const completed = await SuperTokens.getUser(target);
  expect(completed?.loginMethods).toHaveLength(3);
  expect(completed?.loginMethods.some((method) => method.thirdParty?.id === "instant" && method.thirdParty.userId === instant)).toBe(true);
  expect((await UserMetadata.getUserMetadata(target)).metadata.original_rownd_user.data.user_id).toBe(authenticated);
  const retry = await reconcileUser({ rownd_user_id: authenticated });
  expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false });
});

it.each(["identity", "missing auth level", "stored identity", "provider mismatch", "unverified email", "conflicting alias", "missing stored"])("blocks unproven instant election: %s", async (mode) => {
  const { instant, authenticated, profiles, target, secondary } = await fixture();
  if (mode === "identity") profiles.get(instant)!.data.email = "new@example.com";
  if (mode === "missing auth level") delete profiles.get(instant)!.auth_level;
  if (mode === "stored identity") await UserMetadata.updateUserMetadata(target, { original_rownd_user: { ...profiles.get(instant), data: { user_id: instant, email: "old@example.com" } } });
  if (mode === "provider mismatch") profiles.get(authenticated)!.data.google_id = randomUUID();
  if (mode === "unverified email") delete profiles.get(authenticated)!.verified_data!.email;
  if (mode === "conflicting alias") await UserMetadata.updateUserMetadata(authenticated, { original_rownd_user: { ...profiles.get(authenticated), data: { ...profiles.get(authenticated)!.data, google_id: randomUUID() } } });
  if (mode === "missing stored") for (const id of [authenticated, secondary]) await UserMetadata.updateUserMetadata(id, { original_rownd_user: null });
  const result = await reconcileUser({ supertokens_user_id: target, dryRun: true });
  expect(["AMBIGUOUS", "BLOCKED"]).toContain(result.status);
  expect((await SuperTokens.getUserIdMapping({ userId: authenticated, userIdType: "EXTERNAL" })).status).toBe("OK");
});

it("does not authorize separate owners", async () => {
  const { instant, authenticated, target, secondary, profiles } = await fixture(true);
  expect(await inspectInstantPrimaryProof([
    { rownd_user_id: instant, supertokens_user_id: target },
    { rownd_user_id: authenticated, supertokens_user_id: secondary },
  ], "public", {})).toBeUndefined();
  const native = await Passwordless.signInUp({ tenantId: "public", email: profiles.get(authenticated)!.data.email! });
  expect(await AccountLinking.linkAccounts(native.recipeUserId, target)).toMatchObject({ status: "OK" });
  const result = await reconcileUser({ rownd_user_id: authenticated, dryRun: true });
  expect(["BLOCKED", "AMBIGUOUS"], JSON.stringify(result)).toContain(result.status);
});

it.each(["raw provider", "instant level", "missing instant level", "instant verified flag"])("rejects fresh same-call evidence drift at completion: %s", async (mode) => {
  const { instant, authenticated, target, profiles } = await fixture(false, true);
  const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
  let changed = false;
  vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (!changed && args[0] === target && args[1].rownd_migration_owner_consolidation?.status === "RECONCILING") {
      changed = true;
      if (mode === "raw provider") profiles.get(authenticated)!.data.google_id = randomUUID();
      if (mode === "instant level") profiles.get(instant)!.auth_level = "verified";
      if (mode === "missing instant level") delete profiles.get(instant)!.auth_level;
      if (mode === "instant verified flag") profiles.get(instant)!.verified_data = { email: true };
    }
    return result;
  });
  const result = await reconcileUser({ rownd_user_id: authenticated });
  expect(changed).toBe(true);
  expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED" });
  expect((await UserMetadata.getUserMetadata(target)).metadata.rownd_migration_owner_consolidation.status).not.toBe("COMPLETE");
});

it.each([false, true])("preserves instant session assurance across alias verification-cell relocation (legacy payload: %s)", async (legacy) => {
  const { instant, authenticated, target, secondary, profiles } = await fixture(false, true);
  const anonymous = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(instant));
  const google = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(authenticated));
  expect(anonymous.getAccessTokenPayload()).toMatchObject({ auth_level: "instant", is_verified_user: false });
  if (legacy) await anonymous.mergeIntoAccessTokenPayload({ rownd_session_authentication: null });
  expect(google.getAccessTokenPayload()).toMatchObject({ auth_level: "verified", is_verified_user: true });
  const result = await reconcileUser({ rownd_user_id: authenticated });
  expect(result, JSON.stringify(result)).toMatchObject({ status: "OK" });
  expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(instant), profiles.get(authenticated)!.data.email!)).toBe(true);
  for (const [session, level] of [[anonymous, "instant"], [google, "verified"]] as const) {
    const refreshed = await Session.refreshSessionWithoutRequestResponse(session.getAllSessionTokensDangerously().refreshToken!, true);
    const claims = await buildRowndSessionAndAnonymousClaims(refreshed.getUserId(), refreshed.getAccessTokenPayload(), undefined, {}, refreshed.getRecipeUserId().getAsString());
    await refreshed.mergeIntoAccessTokenPayload({ ...claims.rowndSessionClaims, ...claims.rowndIsAnonymousClaim });
    await refreshed.fetchAndSetClaim(RowndIsAnonymousClaim);
    expect(refreshed.getAccessTokenPayload()).toMatchObject({ auth_level: level, is_verified_user: level === "verified" });
    expect(await refreshed.getClaimValue(RowndIsAnonymousClaim)).toBe(level === "instant");
  }
  expect(await SuperTokens.getUserIdMapping({ userId: instant, userIdType: "EXTERNAL" })).toMatchObject({ superTokensUserId: secondary });
  const secondarySession = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(instant),
    { auth_level: "instant", rownd_session_authentication: "instant" });
  expect(secondarySession.getAccessTokenPayload()).toMatchObject({ auth_level: "verified", is_verified_user: true });
  const instantSession = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(authenticated));
  expect(instantSession.getAccessTokenPayload()).toMatchObject({ auth_level: "instant", is_verified_user: false });
  const migrated = await withProvenSessionAuthentication(() => Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(authenticated)));
  expect(migrated.getAccessTokenPayload()).toMatchObject({ auth_level: "verified", is_verified_user: true });
  const migratedClaims = await buildRowndSessionAndAnonymousClaims(migrated.getUserId(), migrated.getAccessTokenPayload(), undefined, {}, migrated.getRecipeUserId().getAsString());
  expect(migratedClaims.rowndSessionClaims).toMatchObject({ auth_level: "verified", is_verified_user: true });
  await migrated.fetchAndSetClaim(RowndIsAnonymousClaim);
  expect(await migrated.getClaimValue(RowndIsAnonymousClaim)).toBe(false);
});

it("requires fresh authentication for legacy verified sessions on relocated aliases without downgrading unaffected authentication", async () => {
  const { instant, authenticated, target } = await fixture(false, true);
  const anonymous = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(instant));
  // Reproduce the signed payload issued by the old aggregate-based implementation.
  await anonymous.mergeIntoAccessTokenPayload({ auth_level: "verified", is_verified_user: true,
    "https://auth.rownd.io/auth_level": "verified", "https://auth.rownd.io/is_verified_user": true,
    "https://auth.rownd.io/is_anonymous": null, is_anonymous: { v: false, t: Date.now() }, rownd_session_authentication: null });
  const secondary = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(authenticated));
  const user = await SuperTokens.getUser(target);
  const nativeRecipe = user!.loginMethods.find((method) => method.recipeId === "passwordless")!.recipeUserId;
  const unaffected = await Session.createNewSessionWithoutRequestResponse("public", nativeRecipe);
  await unaffected.mergeIntoAccessTokenPayload({ rownd_session_authentication: null });
  expect(anonymous.getAccessTokenPayload()).toMatchObject({ auth_level: "verified", is_verified_user: true });
  expect(anonymous.getAccessTokenPayload()).not.toHaveProperty("rownd_session_authentication");
  expect(await reconcileUser({ rownd_user_id: authenticated })).toMatchObject({ status: "OK" });
  await UserMetadata.updateUserMetadata(target, { rownd_session_authentication: "authenticated", attacker: "authenticated" });
  const config = getPluginConfig()!;
  expect(buildConfiguredSessionClaims({ rownd_session_authentication: "authenticated", attacker: "authenticated" }, {
    ...config, schema: { ...config.schema, attacker: { type: "string", owned_by: "user", include_in_session_claims: true, session_claim_name: "rownd_session_authentication" } },
  })).not.toHaveProperty("rownd_session_authentication");

  const refreshed = await Session.refreshSessionWithoutRequestResponse(anonymous.getAllSessionTokensDangerously().refreshToken!, true);
  const failedSignIn = (init({ rowndAppKey: "test", rowndAppSecret: "test", rowndJwtAudience: "app:test-app" }) as any).overrideMap.thirdparty.apis({
    signInUpPOST: async () => ({ status: "GENERAL_ERROR", message: "credentials rejected" }),
  });
  expect(await failedSignIn.signInUpPOST({ provider: { id: "google" }, tenantId: "public", session: refreshed,
    options: { req: { getKeyValueFromQuery: () => undefined } }, userContext: {} })).toMatchObject({ status: "GENERAL_ERROR" });
  expect(refreshed.getAccessTokenPayload()).not.toHaveProperty("rownd_session_authentication");
  for (const [session, expected] of [[refreshed, "instant"], [secondary, "verified"], [unaffected, "verified"]] as const) {
    const claims = await buildRowndSessionAndAnonymousClaims(session.getUserId(), session.getAccessTokenPayload(), undefined, {}, session.getRecipeUserId().getAsString());
    expect(claims.rowndSessionClaims).toMatchObject({ auth_level: expected, is_verified_user: expected === "verified" });
    await session.mergeIntoAccessTokenPayload({ ...claims.rowndSessionClaims, ...claims.rowndIsAnonymousClaim });
    await session.fetchAndSetClaim(RowndIsAnonymousClaim);
    expect(await session.getClaimValue(RowndIsAnonymousClaim)).toBe(expected === "instant");
  }
  const upgraded = await withProvenSessionAuthentication(() => buildRowndSessionAndAnonymousClaims(
    refreshed.getUserId(), refreshed.getAccessTokenPayload(), undefined, {}, refreshed.getRecipeUserId().getAsString(), true));
  expect(upgraded.rowndSessionClaims).toMatchObject({ auth_level: "verified", rownd_session_authentication: "authenticated" });
});

it("retains ambiguous legacy-session alias provenance when a later election replaces its checkpoint", async () => {
  const { instant, authenticated, target, secondary, profiles } = await fixture(false, true);
  const untouched = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(instant));
  await untouched.mergeIntoAccessTokenPayload({ auth_level: "verified", is_verified_user: true,
    "https://auth.rownd.io/auth_level": "verified", "https://auth.rownd.io/is_verified_user": true,
    "https://auth.rownd.io/is_anonymous": null, is_anonymous: { v: false, t: Date.now() }, rownd_session_authentication: null });
  expect(await reconcileUser({ rownd_user_id: authenticated })).toMatchObject({ status: "OK" });
  const first = readOwnerPlanCheckpoint((await UserMetadata.getUserMetadata(target)).metadata)!;
  expect(first.legacySessionAliasHistory?.aliases).toContain(instant);
  const next = randomUUID(), source = profiles.get(authenticated)!;
  // A later real identity makes the instant alias an ordinary election candidate.
  profiles.set(instant, { ...structuredClone(source), data: { ...source.data, user_id: instant }, meta: { last_active: "2024-01-01T00:00:00.000Z" } });
  profiles.set(next, { ...structuredClone(source), data: { ...source.data, user_id: next }, meta: { last_active: "2026-01-01T00:00:00.000Z" } });
  const preview = await reconcileUser({ rownd_user_id: next, dryRun: true });
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true });
  const result = await reconcileUser({ rownd_user_id: next });
  expect(result, JSON.stringify(result)).toMatchObject({ status: "OK" });
  const replacement = readOwnerPlanCheckpoint((await UserMetadata.getUserMetadata(target)).metadata)!;
  expect(replacement.id).not.toBe(first.id);
  expect(replacement.sourceId).toBe(next);
  expect(replacement.aliases.find((alias) => alias.id === instant)).toMatchObject({ from: secondary, to: secondary });
  expect(replacement.legacySessionAliasHistory).toMatchObject({ instantRecipeId: target, aliases: expect.arrayContaining(first.legacySessionAliasHistory!.aliases) });
  expect(await reconcileUser({ rownd_user_id: next })).toMatchObject({ status: "OK", changed: false });
  expect(untouched.getAccessTokenPayload()).not.toHaveProperty("rownd_session_authentication");
  const refreshed = await Session.refreshSessionWithoutRequestResponse(untouched.getAllSessionTokensDangerously().refreshToken!, true);
  const rebuild = () => buildRowndSessionAndAnonymousClaims(refreshed.getUserId(), refreshed.getAccessTokenPayload(), undefined, {}, refreshed.getRecipeUserId().getAsString());
  expect((await rebuild()).rowndSessionClaims).toMatchObject({ auth_level: "instant", is_verified_user: false });
  const upgraded = await withProvenSessionAuthentication(() => buildRowndSessionAndAnonymousClaims(
    refreshed.getUserId(), refreshed.getAccessTokenPayload(), undefined, {}, refreshed.getRecipeUserId().getAsString(), true));
  expect(upgraded.rowndSessionClaims).toMatchObject({ auth_level: "verified", rownd_session_authentication: "authenticated" });
  for (const invalid of [
    { ...replacement.legacySessionAliasHistory, instantRecipeId: secondary },
    { ...replacement.legacySessionAliasHistory, instantRecipeIdentity: "unrelated" },
    { ...replacement.legacySessionAliasHistory, aliases: ["unrelated-alias"] },
    { ...replacement.legacySessionAliasHistory, aliases: [instant, instant] },
  ]) expect(() => readOwnerPlanCheckpoint({ rownd_migration_owner_consolidation: { ...replacement, legacySessionAliasHistory: invalid } })).toThrow();
});
