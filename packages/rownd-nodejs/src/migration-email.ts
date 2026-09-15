import type { RowndMigrationEmailRetirement, RowndUser, SuperTokensUserImport } from "./types";
import { isDeepStrictEqual } from "node:util";
import { reconciliationSuperTokens as SuperTokens, reconciliationPasswordless as Passwordless, reconciliationUserMetadata as UserMetadata } from "./reconciliation-sdk";
import Session from "supertokens-node/recipe/session";
import type { RowndMetadata, RowndPendingVerification, SuperTokensUser } from "./rownd-compatibility";
import { getCombinedUserMetadata, isSuperTokensFakeEmail, mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { fetchOptionalRowndUserInfo, validateRowndToken } from "./rownd-repository";
import { assertMigrationMapping, assertMigrationSourceActive } from "./migration-mapping";
import { migrationTelemetry } from "./telemetry/migrationTelemetry";
import { clearSuperTokensCoreCallCache, isRecord, type JsonRecord } from "./utils";
import { RowndLegacyUserNotFoundError, RowndMigrationPolicyError } from "./errors";
import { normalizeOptionalRowndIdentities, resolveRowndProviderSubject } from "./provider-identity";
import { assertAdministrativeElection } from "./migration-election";

type AuthenticatedMigration = Readonly<{
  rowndUserId: string;
  tenantId: string;
  email?: string;
  contactEmail?: string;
  identities: string;
}>;

const authenticatedMigrations = new WeakMap<SuperTokensUserImport, AuthenticatedMigration>();
const administrativeMigrations = new WeakMap<SuperTokensUserImport, AuthenticatedMigration>();
const administrativeSourceGuards = new WeakMap<SuperTokensUserImport, () => Promise<void>>();

function verifiedProfileEmail(profile: RowndUser) {
  const email = profile.data.email?.toLowerCase();
  const verified = profile.verified_data?.email;
  return email && !isSuperTokensFakeEmail(email) &&
    (verified === true || (typeof verified === "string" && verified.toLowerCase() === email)) ? email : undefined;
}

export function assertRowndSourcePayload(profile: RowndUser) {
  const invalid: string[] = [];
  if (!isRecord(profile) || !isRecord(profile.data)) {
    throw new RowndMigrationPolicyError("SOURCE_PAYLOAD_INVALID: data");
  }
  profile = normalizeOptionalRowndIdentities(profile);
  for (const container of ["data", "verified_data"] as const) {
    const values = profile[container];
    if (values == null) continue;
    if (!isRecord(values)) { invalid.push(container); continue; }
    for (const field of ["user_id", "email", "phone_number", "google_id", "apple_id"]) {
      const value = values[field];
      if (value === undefined || value === null) continue;
      const marker = container === "verified_data" && typeof value === "boolean";
      if (!marker && (typeof value !== "string" || !value.trim() ||
          (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) ||
          (field === "phone_number" && !/^\+[1-9]\d{1,14}$/.test(value)))) {
        invalid.push(`${container}.${field}`);
      }
    }
  }
  if (typeof profile.data.user_id !== "string" || !profile.data.user_id.trim()) invalid.push("data.user_id");
  if (invalid.length) throw new RowndMigrationPolicyError(`SOURCE_PAYLOAD_INVALID: ${[...new Set(invalid)].join(", ")}`);
}

// Server-only factory: arbitrary import objects and userContext flags cannot mint proof.
export async function fetchAdministrativeMigrationSource(rowndUserId: string, tenantId: string, userContext: JsonRecord) {
  await assertMigrationSourceActive(rowndUserId, userContext);
  let profile: RowndUser | undefined;
  try {
    profile = await fetchOptionalRowndUserInfo(rowndUserId);
  } catch (error) {
    if (isRecord(error) && isRecord(error.response) && error.response.statusCode === 404) return undefined;
    throw error;
  }
  if (!profile) return undefined;
  assertRowndSourcePayload(profile);
  if (profile.data?.user_id !== rowndUserId || !isRowndMigrationProfileActive(profile)) {
    throw new RowndMigrationPolicyError("Rownd source is not the requested enabled user");
  }
  const source = mapRowndUserToSuperTokens(profile, tenantId);
  const email = verifiedProfileEmail(profile);
  const contactEmail = profile.data.email?.toLowerCase();
  administrativeMigrations.set(source, Object.freeze({ rowndUserId, tenantId, email,
    contactEmail: contactEmail && !isSuperTokensFakeEmail(contactEmail) ? contactEmail : undefined, identities: migrationIdentities(source) }));
  return source;
}

export function isRowndMigrationProfileActive(profile: RowndUser) {
  // Older Rownd fetch responses omit state; explicit inactive states still deny migration.
  return profile.state === undefined || profile.state === "enabled";
}

function migrationIdentities(source: SuperTokensUserImport) {
  return JSON.stringify(source.loginMethods.map((method) =>
    method.recipeId === "passwordless" && method.email !== undefined
      ? { ...method, email: method.email.toLowerCase(), isVerified: false } : method));
}

// Token authorization can prove the current contact even without a verified_data
// marker. Administrative contact ownership is separate from verification proof.
export async function authenticateRowndMigration(token: string, tenantId: string, userContext: JsonRecord) {
  if (!tenantId) throw new Error("Authenticated Rownd migration requires a tenant");
  const rowndUserId = await validateRowndToken(token);
  if (typeof rowndUserId !== "string" || !rowndUserId.trim()) {
    throw new Error("Validated Rownd token has no user ID");
  }
  const telemetry = migrationTelemetry(userContext);
  if (telemetry) telemetry.rowndUserId = rowndUserId;
  await assertMigrationSourceActive(rowndUserId, userContext);
  if (telemetry) telemetry.stage = "rownd_lookup";
  let rowndUser: RowndUser | undefined;
  try {
    rowndUser = await fetchOptionalRowndUserInfo(rowndUserId);
  } catch (error) {
    // Only the requested profile's definitive HTTP 404 can establish absence.
    // Other optional lookups and ambiguous SDK responses retain their semantics.
    if (isRecord(error) && isRecord(error.response) && error.response.statusCode === 404) {
      clearSuperTokensCoreCallCache(userContext);
      const existingUser = await SuperTokens.getUser(rowndUserId, userContext);
      if (existingUser === undefined) throw new RowndLegacyUserNotFoundError();
      if (telemetry) telemetry.superTokensUserId = existingUser?.id;
    }
    throw error;
  }
  if (!rowndUser) throw new Error("Rownd profile lookup returned no authoritative result");
  assertRowndSourcePayload(rowndUser);
  if (rowndUser.data?.user_id !== rowndUserId || !isRowndMigrationProfileActive(rowndUser)) {
    throw new Error("Rownd profile does not match an enabled validated token user ID");
  }
  const source = mapRowndUserToSuperTokens(rowndUser, tenantId);
  const email = typeof rowndUser.data.email === "string" && rowndUser.data.email.trim() &&
    !isSuperTokensFakeEmail(rowndUser.data.email.toLowerCase())
    ? rowndUser.data.email.toLowerCase() : undefined;
  authenticatedMigrations.set(source, Object.freeze({
    rowndUserId, tenantId, email, identities: migrationIdentities(source),
  }));
  for (const method of source.loginMethods) {
    if (method.recipeId === "passwordless" && email && method.email?.toLowerCase() === email) {
      method.isVerified = true;
    }
  }
  return { rowndUserId, source };
}

export function getAuthenticatedMigrationEmail(source: SuperTokensUserImport, tenantId: string) {
  const proof = authenticatedMigrations.get(source) ?? administrativeMigrations.get(source);
  if (!proof) return undefined;
  if (proof.rowndUserId !== source.externalUserId || proof.tenantId !== tenantId ||
      proof.identities !== migrationIdentities(source)) {
    throw new RowndMigrationPolicyError("Authenticated Rownd migration binding changed");
  }
  return proof.email;
}

export function isAdministrativeMigration(source: SuperTokensUserImport, tenantId: string) {
  getAuthenticatedMigrationEmail(source, tenantId);
  return administrativeMigrations.has(source);
}

export function getMigrationContactEmail(source: SuperTokensUserImport, tenantId: string) {
  const verifiedEmail = getAuthenticatedMigrationEmail(source, tenantId);
  return administrativeMigrations.get(source)?.contactEmail ?? verifiedEmail;
}

export function bindAdministrativeSourceGuard(source: SuperTokensUserImport, tenantId: string, guard: () => Promise<void>) {
  if (!isAdministrativeMigration(source, tenantId)) throw new RowndMigrationPolicyError("Administrative source guard requires private authorization");
  administrativeSourceGuards.set(source, guard);
}

export async function assertAuthenticatedMigrationSource(source: SuperTokensUserImport, tenantId: string) {
  const proof = authenticatedMigrations.get(source) ?? administrativeMigrations.get(source);
  if (!proof) return undefined;
  getAuthenticatedMigrationEmail(source, tenantId);
  await assertAdministrativeElection(source);
  const fresh = await fetchOptionalRowndUserInfo(proof.rowndUserId);
  assertAuthenticatedProfile(fresh, proof);
  if (administrativeMigrations.has(source) && verifiedProfileEmail(fresh) !== proof.email) {
    throw new RowndMigrationPolicyError("Rownd verified email proof changed before reconciliation completion");
  }
  await administrativeSourceGuards.get(source)?.();
  return fresh;
}

function assertAuthenticatedProfile(fresh: RowndUser | undefined, proof: AuthenticatedMigration): asserts fresh is RowndUser {
  if (fresh) assertRowndSourcePayload(fresh);
  if (!fresh || !isRowndMigrationProfileActive(fresh) || fresh.data?.user_id !== proof.rowndUserId ||
      migrationIdentities(mapRowndUserToSuperTokens(fresh, proof.tenantId)) !== proof.identities) {
    throw new RowndMigrationPolicyError("Rownd source identity changed before migration completion");
  }
}

export type MigrationEmailPlan = RowndPendingVerification & {
  migrationSource: RowndMigrationEmailRetirement["source"];
};

export function isCurrentRowndEmailReconciliationPlan(plan: RowndPendingVerification) {
  // Routing only; neither the prefix nor the presence of provenance authorizes cleanup.
  return plan.id.startsWith("migration-email-") || "migrationSource" in plan;
}

function assertMigrationEmailPlan(plan: RowndPendingVerification, tenantId: string): asserts plan is MigrationEmailPlan {
  const source: unknown = Reflect.get(plan, "migrationSource");
  if (!tenantId || plan.tenantId !== tenantId || plan.field !== "email" ||
      plan.status !== "COMMITTING" || plan.purpose !== "UPDATE_PASSWORDLESS" ||
      typeof plan.created_at !== "string" || !Number.isFinite(Date.parse(plan.created_at)) ||
      typeof plan.value !== "string" || !plan.value.trim() || isSuperTokensFakeEmail(plan.value.trim()) ||
      typeof plan.targetCanonicalRecipeUserId !== "string" || !plan.targetCanonicalRecipeUserId ||
      plan.id !== `migration-email-${plan.targetCanonicalRecipeUserId}` ||
      !isRecord(source) || typeof source.rowndUserId !== "string" || !source.rowndUserId ||
      (source.providerId !== "apple" && source.providerId !== "google") ||
      typeof source.providerUserId !== "string" || !source.providerUserId ||
      typeof source.providerRecipeUserId !== "string" || !source.providerRecipeUserId ||
      typeof source.previousEmail !== "string" || !source.previousEmail.trim() ||
      isSuperTokensFakeEmail(source.previousEmail.trim()) ||
      source.previousEmail.toLowerCase() === plan.value.toLowerCase() ||
      !Array.isArray(plan.retiredMethods) || plan.retiredMethods.length === 0 ||
      plan.retiredMethods.some((method) => !isRecord(method) ||
        typeof method.recipeUserId !== "string" || !method.recipeUserId ||
        method.recipeUserId === plan.targetCanonicalRecipeUserId ||
        typeof method.email !== "string" || method.email.toLowerCase() !== (source.previousEmail as string).toLowerCase()) ||
      new Set(plan.retiredMethods.map((method) => method.recipeUserId)).size !== plan.retiredMethods.length) {
    throw new RowndMigrationPolicyError("Current Rownd email cleanup provenance is invalid");
  }
}

function retirementCheckpoint(plan: MigrationEmailPlan): RowndMigrationEmailRetirement {
  return {
    version: 1,
    planId: plan.id,
    tenantId: plan.tenantId!,
    targetRecipeUserId: plan.targetCanonicalRecipeUserId!,
    targetEmail: plan.value.toLowerCase(),
    source: { ...plan.migrationSource },
    retiredMethods: plan.retiredMethods!.map((method) => ({ ...method }))
      .sort((a, b) => a.recipeUserId.localeCompare(b.recipeUserId)),
  };
}

export async function checkpointCurrentRowndEmailRetirement(input: {
  internalUserId: string;
  plan: MigrationEmailPlan;
  tenantId: string;
  userContext: JsonRecord;
}) {
  const { internalUserId, plan, tenantId, userContext } = input;
  assertMigrationEmailPlan(plan, tenantId);
  clearSuperTokensCoreCallCache(userContext);
  await assertMigrationMapping(internalUserId, plan.migrationSource.rowndUserId, userContext);
  const metadata = await getCombinedUserMetadata(internalUserId, userContext);
  const snapshot = metadata.original_rownd_user;
  if (snapshot?.data.user_id !== plan.migrationSource.rowndUserId ||
      snapshot.data.email?.toLowerCase() !== plan.migrationSource.previousEmail ||
      resolveRowndProviderSubject(snapshot, plan.migrationSource.providerId) !== plan.migrationSource.providerUserId) {
    throw new RowndMigrationPolicyError("Original Rownd retirement snapshot changed before checkpoint");
  }
  const primary = (await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata as RowndMetadata;
  const checkpoints = primary.rownd_migration_email_retirements;
  if (checkpoints !== undefined && !isRecord(checkpoints)) {
    throw new RowndMigrationPolicyError("Current Rownd retirement checkpoints are invalid");
  }
  const expected = retirementCheckpoint(plan);
  const existing = checkpoints?.[tenantId];
  if (existing !== undefined && !isDeepStrictEqual(existing, expected)) {
    throw new RowndMigrationPolicyError("Current Rownd retirement checkpoint changed");
  }
  // This independent checkpoint precedes snapshot replacement and is never rebuilt
  // from a persisted cleanup plan. Privileged writes to both records remain trusted.
  if (existing === undefined) {
    await UserMetadata.updateUserMetadata(internalUserId, {
      rownd_migration_email_retirements: { ...checkpoints, [tenantId]: expected },
    }, userContext);
  }
  clearSuperTokensCoreCallCache(userContext);
  const saved = (await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata as RowndMetadata;
  if (!isDeepStrictEqual(saved.rownd_migration_email_retirements?.[tenantId], expected)) {
    throw new RowndMigrationPolicyError("Current Rownd retirement checkpoint was not persisted");
  }
  return saved.rownd_migration_email_retirements!;
}

export async function validateCurrentRowndEmailReconciliation(input: {
  internalUserId: string;
  plan: RowndPendingVerification;
  tenantId: string;
  userContext: JsonRecord;
}) {
  const { internalUserId, plan, tenantId, userContext } = input;
  assertMigrationEmailPlan(plan, tenantId);
  clearSuperTokensCoreCallCache(userContext);
  await assertMigrationMapping(internalUserId, plan.migrationSource.rowndUserId, userContext);
  const { metadata } = await UserMetadata.getUserMetadata(internalUserId, userContext);
  const stored = metadata as RowndMetadata;
  if (!isDeepStrictEqual(stored.rownd_migration_email_retirements?.[tenantId], retirementCheckpoint(plan))) {
    throw new RowndMigrationPolicyError("Current Rownd email cleanup does not match its retirement checkpoint");
  }
  const user = await SuperTokens.getUser(internalUserId, userContext);
  const target = user?.loginMethods.find((method) => method.recipeUserId.getAsString() === plan.targetCanonicalRecipeUserId);
  const targetOwner = await SuperTokens.getUser(plan.targetCanonicalRecipeUserId!, userContext);
  const tenantPlans = Array.isArray(stored.rownd_pending_verification)
    ? stored.rownd_pending_verification.filter((entry) => isRecord(entry) &&
      (entry.tenantId ?? "public") === tenantId &&
      (entry.status === "COMMITTING" || "targetCanonicalRecipeUserId" in entry || "retiredMethods" in entry))
    : [];
  const provider = user?.loginMethods.find((method) =>
    method.recipeId === "thirdparty" && method.tenantIds.includes(tenantId) &&
    method.recipeUserId.getAsString() === plan.migrationSource.providerRecipeUserId &&
    method.hasSameThirdPartyInfoAs({ id: plan.migrationSource.providerId, userId: plan.migrationSource.providerUserId }));
  const snapshot = stored.original_rownd_user;
  // Completion is published after cleanup. The independent retirement checkpoint,
  // canonical method, source snapshot, and persisted plan authorize this step.
  if (!user || !target || target.recipeId !== "passwordless" || !target.verified ||
      !target.tenantIds.includes(tenantId) || !target.hasSameEmailAs(plan.value) ||
      targetOwner?.id !== user.id || !provider ||
      !isRecord(snapshot?.data) || snapshot.data.user_id !== plan.migrationSource.rowndUserId ||
      stored.rownd_email_recipe_user_ids?.[tenantId] !== target.recipeUserId.getAsString() ||
      tenantPlans.length !== 1 || JSON.stringify(tenantPlans[0]) !== JSON.stringify(plan)) {
    throw new RowndMigrationPolicyError("Current Rownd email cleanup plan changed");
  }
  const snapshotMethods = mapRowndUserToSuperTokens(snapshot!, tenantId).loginMethods;
  if (!isRowndMigrationProfileActive(snapshot!) ||
      !snapshotMethods.some((method) => method.recipeId === "thirdparty" &&
      provider.hasSameThirdPartyInfoAs({ id: method.thirdPartyId, userId: method.thirdPartyUserId })) ||
       !snapshotMethods.some((method) => method.recipeId === "passwordless" &&
        method.email?.toLowerCase() === plan.value.toLowerCase())) {
    throw new RowndMigrationPolicyError("Current Rownd email cleanup source changed");
  }
  // Validate the whole retirement set before any destructive call. Unlike native
  // replacement, migration only retires snapshot-proven emails, never placeholders.
  for (const retired of plan.retiredMethods!) {
    const owner = await SuperTokens.getUser(retired.recipeUserId, userContext);
    if (!owner) continue;
    const method = owner.loginMethods.find((entry) => entry.recipeUserId.getAsString() === retired.recipeUserId);
    if (owner.id !== user.id || !method || method.recipeId !== "passwordless" ||
        !method.hasSameEmailAs(retired.email)) {
      throw new RowndMigrationPolicyError("Current Rownd email cleanup ownership changed");
    }
  }
  return {
    user,
    pendingVerification: plan,
    retiredMethods: plan.retiredMethods!,
    targetRecipeUserId: plan.targetCanonicalRecipeUserId!,
    normalizedEmail: plan.value.toLowerCase(),
  };
}

export async function finishCurrentRowndEmailReconciliation(input: {
  internalUserId: string;
  plan: RowndPendingVerification;
  tenantId: string;
  userContext: JsonRecord;
  removeMethod: (recipeUserId: string, tenantId: string, sdkUserId: string) => Promise<void>;
}) {
  const { internalUserId, plan, tenantId, userContext } = input;
  const { user, retiredMethods } = await validateCurrentRowndEmailReconciliation(input);
  for (const retired of retiredMethods) {
    await validateCurrentRowndEmailReconciliation(input);
    const result = await Passwordless.revokeAllCodes({ email: retired.email, tenantId, userContext });
    if (result.status !== "OK") throw new Error("Failed to revoke retired Rownd email codes");
    await input.removeMethod(retired.recipeUserId, tenantId, user.id);
  }
  await Session.revokeAllSessionsForUser(internalUserId, true, tenantId, userContext);
  clearSuperTokensCoreCallCache(userContext);
  const { user: finalUser } = await validateCurrentRowndEmailReconciliation(input);
  if (finalUser.loginMethods.some((method) => (method.tenantIds.includes(tenantId) || method.tenantIds.length === 0) &&
      retiredMethods.some((retired) => retired.recipeUserId === method.recipeUserId.getAsString()))) {
    throw new RowndMigrationPolicyError("Current Rownd email cleanup postcondition failed");
  }
  const finalMetadata = (await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata as RowndMetadata;
  await UserMetadata.updateUserMetadata(internalUserId, {
    rownd_migration_email_retirements: Object.fromEntries(
      Object.entries(finalMetadata.rownd_migration_email_retirements!).filter(([key]) => key !== tenantId),
    ),
    rownd_pending_verification: finalMetadata.rownd_pending_verification!.filter((entry) =>
      entry.id !== plan.id || (entry.tenantId ?? "public") !== tenantId),
  }, userContext);
}

export async function prepareCurrentRowndEmailReconciliation(
  source: SuperTokensUserImport,
  user: SuperTokensUser,
  metadata: RowndMetadata,
  tenantId: string,
) {
  const plan = inspectCurrentRowndEmailReconciliation(source, user, metadata, tenantId);
  await plan?.assertFreshSource();
  return plan;
}

export function inspectCurrentRowndEmailReconciliation(
  source: SuperTokensUserImport,
  user: SuperTokensUser,
  metadata: RowndMetadata,
  tenantId: string,
) {
  const emails = source.loginMethods.filter((method) =>
    method.recipeId === "passwordless" && method.email !== undefined &&
    !isSuperTokensFakeEmail(method.email));
  if (emails.length !== 1) return undefined;
  const requested = emails[0]!;
  if (requested.recipeId !== "passwordless" || !requested.email) return undefined;
  const email = requested.email.toLowerCase();
  const snapshot = metadata.original_rownd_user;
  const scopedMethods = user.loginMethods.filter((method) => method.tenantIds.includes(tenantId));
  const emailMethods = scopedMethods.filter((method) => method.recipeId === "passwordless" && method.email);
  const snapshotEmail = typeof snapshot?.data.email === "string" ? snapshot.data.email.toLowerCase() : undefined;
  const provider = scopedMethods.find((method) => method.thirdParty &&
    ["apple", "google"].includes(method.thirdParty.id) &&
    source.loginMethods.some((expected) => expected.recipeId === "thirdparty" &&
      method.hasSameThirdPartyInfoAs({ id: expected.thirdPartyId, userId: expected.thirdPartyUserId })));
  if (!snapshot || snapshot.data.user_id !== source.externalUserId ||
      !snapshotEmail || isSuperTokensFakeEmail(snapshotEmail)) return undefined;
  if (!provider?.thirdParty) {
    if (scopedMethods.some((method) => method.thirdParty?.id === "apple") && snapshotEmail !== email) {
      throw new RowndMigrationPolicyError("Current Rownd provider does not match the migrated Apple identity");
    }
    return undefined;
  }
  const snapshotMethods = mapRowndUserToSuperTokens(snapshot, tenantId).loginMethods;
  const snapshotProvider = snapshotMethods.find((method) => method.recipeId === "thirdparty" &&
    provider.hasSameThirdPartyInfoAs({ id: method.thirdPartyId, userId: method.thirdPartyUserId }));
  if (!snapshotProvider || snapshotProvider.recipeId !== "thirdparty") return undefined;

  // A fake-domain suffix alone is not proof that a credential is a provider placeholder.
  const placeholderIds = emailMethods.filter((method) => method.hasSameEmailAs(snapshotProvider.email) &&
    provider.hasSameEmailAs(snapshotProvider.email))
    .map((method) => method.recipeUserId.getAsString());
  const assertCompatibleMethods = (candidate: SuperTokensUser) => {
    if (candidate.loginMethods.some((method) => method.tenantIds.includes(tenantId) &&
        ["passwordless", "emailpassword"].includes(method.recipeId) && method.email &&
        !method.hasSameEmailAs(email) && !method.hasSameEmailAs(snapshotEmail) &&
        !(placeholderIds.includes(method.recipeUserId.getAsString()) &&
          method.hasSameEmailAs(snapshotProvider.email)))) {
      throw new RowndMigrationPolicyError("Migrated email methods are ambiguous without a canonical method");
    }
  };
  assertCompatibleMethods(user);
  if (snapshotEmail === email) return undefined;
  if (!emailMethods.some((method) => method.hasSameEmailAs(snapshotEmail))) return undefined;
  if (!requested.isVerified) {
    if (isAdministrativeMigration(source, tenantId)) return undefined;
    throw new RowndMigrationPolicyError("Current Rownd email is not verified");
  }
  const assertFreshSource = async () => {
    const fresh = await fetchOptionalRowndUserInfo(source.externalUserId!);
    const currentSubject = fresh && resolveRowndProviderSubject(fresh, provider.thirdParty!.id);
    if (!fresh || !isRowndMigrationProfileActive(fresh) || fresh.data.user_id !== source.externalUserId ||
        typeof fresh.data.email !== "string" || fresh.data.email.toLowerCase() !== email ||
        currentSubject !== provider.thirdParty!.userId ||
        !(getAuthenticatedMigrationEmail(source, tenantId) === email ||
          mapRowndUserToSuperTokens(fresh, tenantId).loginMethods.some((method) =>
            method.recipeId === "passwordless" && method.email?.toLowerCase() === email && method.isVerified))) {
      throw new RowndMigrationPolicyError("Current Rownd email or provider identity changed before reconciliation");
    }
  };
  return {
    email, placeholderIds, assertFreshSource, assertCompatibleMethods,
    migrationSource: {
      rowndUserId: source.externalUserId!,
      providerId: provider.thirdParty.id,
      providerUserId: provider.thirdParty.userId,
      providerRecipeUserId: provider.recipeUserId.getAsString(),
      previousEmail: snapshotEmail,
    },
  };
}
