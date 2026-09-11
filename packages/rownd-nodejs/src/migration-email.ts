import type { RowndMigrationEmailRetirement, RowndUser, SuperTokensUserImport } from "./types";
import { isDeepStrictEqual } from "node:util";
import SuperTokens from "supertokens-node";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import type { RowndMetadata, RowndPendingVerification, SuperTokensUser } from "./rownd-compatibility";
import { getCombinedUserMetadata, isSuperTokensFakeEmail, mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { fetchOptionalRowndUserInfo, validateRowndToken } from "./rownd-repository";
import { assertMigrationMapping, assertMigrationSourceActive } from "./migration-mapping";
import { migrationTelemetry } from "./telemetry/migrationTelemetry";
import { clearSuperTokensCoreCallCache, isRecord, type JsonRecord } from "./utils";

type AuthenticatedMigration = Readonly<{
  rowndUserId: string;
  tenantId: string;
  email?: string;
  identities: string;
}>;

const authenticatedMigrations = new WeakMap<SuperTokensUserImport, AuthenticatedMigration>();

export function isRowndMigrationProfileActive(profile: RowndUser) {
  // Older Rownd fetch responses omit state; explicit inactive states still deny migration.
  return profile.state === undefined || profile.state === "enabled";
}

function migrationIdentities(source: SuperTokensUserImport) {
  return JSON.stringify(source.loginMethods.map((method) =>
    method.recipeId === "passwordless" && method.email !== undefined
      ? { ...method, email: method.email.toLowerCase(), isVerified: false } : method));
}

// Only this token-validating factory can mint contact ownership proof. Import
// flags, userContext values, and arbitrary fetched profiles cannot reproduce it.
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
  const rowndUser = await fetchOptionalRowndUserInfo(rowndUserId);
  if (!rowndUser) return { rowndUserId };
  if (rowndUser.data?.user_id !== rowndUserId || !isRowndMigrationProfileActive(rowndUser)) {
    throw new Error("Rownd profile does not match an enabled validated token user ID");
  }
  const source = mapRowndUserToSuperTokens(structuredClone(rowndUser), tenantId);
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
  const proof = authenticatedMigrations.get(source);
  if (!proof) return undefined;
  if (proof.rowndUserId !== source.externalUserId || proof.tenantId !== tenantId ||
      proof.identities !== migrationIdentities(source)) {
    throw new Error("Authenticated Rownd migration binding changed");
  }
  return proof.email;
}

export async function assertAuthenticatedMigrationSource(source: SuperTokensUserImport, tenantId: string) {
  const proof = authenticatedMigrations.get(source);
  if (!proof) return undefined;
  getAuthenticatedMigrationEmail(source, tenantId);
  const fresh = await fetchOptionalRowndUserInfo(proof.rowndUserId);
  assertAuthenticatedProfile(fresh, proof);
  return fresh;
}

function assertAuthenticatedProfile(fresh: RowndUser | undefined, proof: AuthenticatedMigration): asserts fresh is RowndUser {
  if (!fresh || !isRowndMigrationProfileActive(fresh) || fresh.data?.user_id !== proof.rowndUserId ||
      migrationIdentities(mapRowndUserToSuperTokens(fresh, proof.tenantId)) !== proof.identities) {
    throw new Error("Rownd source identity changed before migration completion");
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
    throw new Error("Current Rownd email cleanup provenance is invalid");
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
  const field = `${plan.migrationSource.providerId}_id`;
  if (snapshot?.data.user_id !== plan.migrationSource.rowndUserId ||
      snapshot.data.email?.toLowerCase() !== plan.migrationSource.previousEmail ||
      (snapshot.data[field] ?? snapshot.verified_data?.[field]) !== plan.migrationSource.providerUserId ||
      (typeof snapshot.verified_data?.[field] === "string" && snapshot.verified_data[field] !== plan.migrationSource.providerUserId)) {
    throw new Error("Original Rownd retirement snapshot changed before checkpoint");
  }
  const primary = (await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata as RowndMetadata;
  const checkpoints = primary.rownd_migration_email_retirements;
  if (checkpoints !== undefined && !isRecord(checkpoints)) {
    throw new Error("Current Rownd retirement checkpoints are invalid");
  }
  const expected = retirementCheckpoint(plan);
  const existing = checkpoints?.[tenantId];
  if (existing !== undefined && !isDeepStrictEqual(existing, expected)) {
    throw new Error("Current Rownd retirement checkpoint changed");
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
    throw new Error("Current Rownd retirement checkpoint was not persisted");
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
    throw new Error("Current Rownd email cleanup does not match its retirement checkpoint");
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
  if (!user || !target || target.recipeId !== "passwordless" || !target.verified ||
      !target.tenantIds.includes(tenantId) || !target.hasSameEmailAs(plan.value) ||
      targetOwner?.id !== user.id || !provider || stored.rownd_migration_complete !== true ||
      !isRecord(snapshot?.data) || snapshot.data.user_id !== plan.migrationSource.rowndUserId ||
      stored.rownd_email_recipe_user_ids?.[tenantId] !== target.recipeUserId.getAsString() ||
      tenantPlans.length !== 1 || JSON.stringify(tenantPlans[0]) !== JSON.stringify(plan)) {
    throw new Error("Current Rownd email cleanup plan changed");
  }
  const snapshotMethods = mapRowndUserToSuperTokens(snapshot!, tenantId).loginMethods;
  const verifiedProvider = snapshot!.verified_data?.[`${plan.migrationSource.providerId}_id`];
  if (!isRowndMigrationProfileActive(snapshot!) ||
       (typeof verifiedProvider === "string" && verifiedProvider !== plan.migrationSource.providerUserId) ||
      !snapshotMethods.some((method) => method.recipeId === "thirdparty" &&
      provider.hasSameThirdPartyInfoAs({ id: method.thirdPartyId, userId: method.thirdPartyUserId })) ||
       !snapshotMethods.some((method) => method.recipeId === "passwordless" &&
        method.email?.toLowerCase() === plan.value.toLowerCase())) {
    throw new Error("Current Rownd email cleanup source changed");
  }
  // Validate the whole retirement set before any destructive call. Unlike native
  // replacement, migration only retires snapshot-proven emails, never placeholders.
  for (const retired of plan.retiredMethods!) {
    const owner = await SuperTokens.getUser(retired.recipeUserId, userContext);
    if (!owner) continue;
    const method = owner.loginMethods.find((entry) => entry.recipeUserId.getAsString() === retired.recipeUserId);
    if (owner.id !== user.id || !method || method.recipeId !== "passwordless" ||
        !method.hasSameEmailAs(retired.email)) {
      throw new Error("Current Rownd email cleanup ownership changed");
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
    throw new Error("Current Rownd email cleanup postcondition failed");
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
      throw new Error("Current Rownd provider does not match the migrated Apple identity");
    }
    return undefined;
  }
  const snapshotMethods = mapRowndUserToSuperTokens(snapshot, tenantId).loginMethods;
  const snapshotProvider = snapshotMethods.find((method) => method.recipeId === "thirdparty" &&
    provider.hasSameThirdPartyInfoAs({ id: method.thirdPartyId, userId: method.thirdPartyUserId }));
  if (!snapshotProvider || snapshotProvider.recipeId !== "thirdparty") return undefined;
  const snapshotVerifiedProvider = snapshot.verified_data?.[`${provider.thirdParty.id}_id`];
  if (typeof snapshotVerifiedProvider === "string" && snapshotVerifiedProvider !== provider.thirdParty.userId) {
    throw new Error("Original Rownd snapshot has contradictory provider identities");
  }

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
      throw new Error("Migrated email methods are ambiguous without a canonical method");
    }
  };
  assertCompatibleMethods(user);
  if (snapshotEmail === email) return undefined;
  if (!emailMethods.some((method) => method.hasSameEmailAs(snapshotEmail))) return undefined;
  if (!requested.isVerified) {
    throw new Error("Current Rownd email is not verified");
  }
  const assertFreshSource = async () => {
    const fresh = await fetchOptionalRowndUserInfo(source.externalUserId!);
    const field = `${provider.thirdParty!.id}_id`;
    const currentSubject = fresh?.data[field] ?? fresh?.verified_data?.[field];
    const verifiedSubject = fresh?.verified_data?.[field];
    if (!fresh || !isRowndMigrationProfileActive(fresh) || fresh.data.user_id !== source.externalUserId ||
        typeof fresh.data.email !== "string" || fresh.data.email.toLowerCase() !== email ||
        currentSubject !== provider.thirdParty!.userId ||
        (typeof verifiedSubject === "string" && verifiedSubject !== currentSubject) ||
        !(getAuthenticatedMigrationEmail(source, tenantId) === email ||
          mapRowndUserToSuperTokens(fresh, tenantId).loginMethods.some((method) =>
            method.recipeId === "passwordless" && method.email?.toLowerCase() === email && method.isVerified))) {
      throw new Error("Current Rownd email or provider identity changed before reconciliation");
    }
  };
  await assertFreshSource();
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
