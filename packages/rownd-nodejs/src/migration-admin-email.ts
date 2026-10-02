import {
  reconciliationEmailVerification as EmailVerification,
  reconciliationSuperTokens as SuperTokens,
  reconciliationUserMetadata as UserMetadata,
} from "./reconciliation-sdk";
import { isDeepStrictEqual } from "node:util";
import { RowndMigrationPolicyError } from "./errors";
import {
  assertAuthenticatedMigrationSource,
  bindAdministrativeSourceGuard,
  getAuthenticatedMigrationEmail,
  getMigrationContactEmail,
  isAdministrativeMigration,
  isCurrentRowndEmailReconciliationPlan,
  validateCurrentRowndEmailReconciliation,
} from "./migration-email";
import {
  getCanonicalEmailRecipeUserId,
  getPendingVerifications,
  getUserMetadata,
} from "./supertokens-repository";
import {
  getRawUserMetadata,
  type RowndMetadata,
  type SuperTokensUser,
} from "./rownd-compatibility";
import {
  clearSuperTokensCoreCallCache,
  isRecord,
  type JsonRecord,
} from "./utils";
import type { SuperTokensUserImport } from "./types";
import { invalidateReconciliationReads } from "./reconciliation-reads";
import { checkpointEmailPointer, getOwnerEmailPlan, hasCheckpointEmailHistory } from "./migration-owner-email";

export async function getAdministrativeRepairMetadata(userId: string, sourceId: string, context: JsonRecord) {
  const requested = await getRawUserMetadata(sourceId, context);
  const primary = await getUserMetadata(userId, context);
  const sourceMetadata = requested.original_rownd_user?.data.user_id === sourceId ? requested : {};
  const combined = { ...sourceMetadata, ...primary } as RowndMetadata;
  // Pending copies can be cleared independently. A primary [] must not hide a
  // source-alias copy left behind by an interrupted cleanup.
  if (sourceMetadata.rownd_pending_verification !== undefined || primary.rownd_pending_verification !== undefined) {
    const pending = new Map<string, ReturnType<typeof getPendingVerifications>[number]>();
    for (const metadata of [primary, sourceMetadata]) for (const entry of validatedPendingEntries(metadata)) {
      const previous = pending.get(entry.id);
      if (previous && !isDeepStrictEqual(previous, entry)) throw new RowndMigrationPolicyError("Administrative pending email copies disagree");
      pending.set(entry.id, entry);
    }
    combined.rownd_pending_verification = [...pending.values()];
  }
  return combined;
}

function validatedPendingEntries(metadata: RowndMetadata) {
  const entries = getPendingVerifications(metadata);
  if (metadata.rownd_pending_verification !== undefined && (!Array.isArray(metadata.rownd_pending_verification) ||
    metadata.rownd_pending_verification.length !== entries.length || new Set(entries.map((entry) => entry.id)).size !== entries.length))
    throw new RowndMigrationPolicyError("Administrative pending email changed");
  return entries;
}

export async function inspectAdministrativeEmailPolicy(
  source: SuperTokensUserImport,
  user: SuperTokensUser,
  metadata: RowndMetadata,
  tenantId: string,
  context: JsonRecord,
) {
  if (!isAdministrativeMigration(source, tenantId)) return undefined;
  const fail = () => {
    throw new RowndMigrationPolicyError("CANONICAL_EMAIL_POLICY");
  };
  const immutable = async (id: string) => {
    const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext: context });
    return mapping.status === "OK" ? mapping.superTokensUserId : id;
  };
  const pending = getPendingVerifications(metadata);
  const completedAdditions: typeof pending = [];
  if (
    metadata.rownd_pending_verification !== undefined &&
    (!Array.isArray(metadata.rownd_pending_verification) ||
      metadata.rownd_pending_verification.length !== pending.length)
  )
    fail();
  if (new Set(pending.map((entry) => entry.id)).size !== pending.length) fail();
  for (const entry of pending.filter(
    (value) =>
      value.field === "email" && (value.tenantId ?? "public") === tenantId,
  )) {
    const email = getAuthenticatedMigrationEmail(source, tenantId);
    const current = user.loginMethods.filter((method) => method.recipeId === "passwordless" &&
      method.tenantIds.includes(tenantId) && email && method.hasSameEmailAs(email));
    const verificationId = entry.verificationRecipeUserId && await immutable(entry.verificationRecipeUserId);
    const verificationOwned = verificationId === undefined || (await Promise.all(user.loginMethods
      .filter((method) => method.tenantIds.includes(tenantId)).map(async (method) =>
        await immutable(method.recipeUserId.getAsString()) === verificationId))).some(Boolean);
    // Exact live Rownd proof can finish an already-added first email without
    // authorizing a different pending address or retiring another credential.
    if (entry.purpose === "ADD_PASSWORDLESS" && (entry.status === undefined || entry.status === "PENDING") &&
      email && entry.value.toLowerCase() === email && current.length === 1 &&
      !user.loginMethods.some((method) => method.recipeId === "passwordless" && method.email &&
        method.tenantIds.includes(tenantId) && !method.hasSameEmailAs(email)) &&
      entry.targetCanonicalRecipeUserId === undefined && entry.retiredMethods === undefined &&
      Reflect.get(entry, "migrationSource") === undefined &&
      verificationOwned) {
      completedAdditions.push(entry);
      continue;
    }
    if (
      !isCurrentRowndEmailReconciliationPlan(entry) ||
      entry.status !== "COMMITTING" ||
      entry.value.toLowerCase() !==
        getAuthenticatedMigrationEmail(source, tenantId) ||
      !isRecord(Reflect.get(entry, "migrationSource")) ||
      Reflect.get(entry, "migrationSource").rowndUserId !==
        source.externalUserId
    )
      fail();
    const mapping = await SuperTokens.getUserIdMapping({
      userId: user.id,
      userIdType: "EXTERNAL",
      userContext: context,
    });
    await validateCurrentRowndEmailReconciliation({
      internalUserId:
        mapping.status === "OK" ? mapping.superTokensUserId : user.id,
      plan: entry,
      tenantId,
      userContext: context,
    });
  }
  const pointers = metadata.rownd_email_recipe_user_ids;
  if (
    pointers !== undefined &&
    (!isRecord(pointers) ||
      (pointers[tenantId] !== undefined &&
        (typeof pointers[tenantId] !== "string" || !pointers[tenantId])))
  )
    fail();
  const canonicalId = getCanonicalEmailRecipeUserId(metadata, tenantId);
  if (
    !canonicalId &&
    metadata.rownd_email_recipe_user_id !== undefined &&
    pointers === undefined
  )
    fail();
  const validatedPlan = getOwnerEmailPlan(source);
  const resolvedCanonical = canonicalId && (await immutable(canonicalId));
  const canonicalInternal = canonicalId && resolvedCanonical === canonicalId && validatedPlan
    ? checkpointEmailPointer(validatedPlan, canonicalId) ?? resolvedCanonical : resolvedCanonical;
  if (canonicalId && resolvedCanonical === canonicalId && canonicalInternal !== canonicalId &&
    await SuperTokens.getUser(canonicalId, context)) fail();
  let canonical;
  if (canonicalInternal)
    for (const method of user.loginMethods) {
      if (
        (await immutable(method.recipeUserId.getAsString())) ===
        canonicalInternal
      )
        canonical = method;
    }
  if (
    canonicalId &&
    (canonical?.recipeId !== "passwordless" ||
      !canonical.email ||
      !canonical.tenantIds.includes(tenantId))
  )
    fail();
  const email = getMigrationContactEmail(source, tenantId);
  if (completedAdditions.length && canonicalId && !canonical!.hasSameEmailAs(email!)) fail();
  const plan = validatedPlan;
  const historicalMethods = user.loginMethods.filter((method) => method.recipeId === "passwordless" &&
    method.email && method.tenantIds.includes(tenantId) && email && !method.hasSameEmailAs(email));
  const historicalEmail = validatedPlan && email === getAuthenticatedMigrationEmail(source, tenantId) &&
    historicalMethods.length > 0 && (await Promise.all(historicalMethods.map(async (method) =>
    hasCheckpointEmailHistory(validatedPlan, source, await immutable(method.recipeUserId.getAsString()), method.email!)))).every(Boolean);
  const priorCanonical =
    email &&
    plan?.initial.markers.some(({ values }) => {
      const pointer = getCanonicalEmailRecipeUserId(values, tenantId);
      const id =
        plan.initial.mappings.find((mapping) => mapping.alias === pointer)
          ?.id ?? pointer;
      return (
        pointer &&
        plan.recipes.some(
          (recipe) =>
            recipe.id === id &&
            recipe.email &&
            recipe.email.toLowerCase() !== email,
        )
      );
    });
  return {
    email,
    canonicalId,
    completedAdditions,
    changesCanonical: !!(
      email &&
      (completedAdditions.length || (canonicalId && !canonical!.hasSameEmailAs(email)) ||
        (!canonicalId && (priorCanonical || historicalEmail)))
    ),
  };
}

export async function prepareAdministrativeCanonicalEmail(
  source: SuperTokensUserImport,
  user: SuperTokensUser,
  metadata: RowndMetadata,
  internalId: string,
  tenantId: string,
  context: JsonRecord,
) {
  const policy = await inspectAdministrativeEmailPolicy(
    source,
    user,
    metadata,
    tenantId,
    context,
  );
  if (!policy) return undefined;
  let publishedId: string | undefined;
  const assertState = async () => {
    clearSuperTokensCoreCallCache(context);
    const current = await SuperTokens.getUser(internalId, context);
    if (!current)
      throw new RowndMigrationPolicyError(
        "Administrative email owner disappeared",
      );
    const latest = await inspectAdministrativeEmailPolicy(
      source,
      current,
      await getAdministrativeRepairMetadata(internalId, source.externalUserId!, context),
      tenantId,
      context,
    );
    if (
      latest?.completedAdditions.some((entry) => !policy.completedAdditions.some((initial) => isDeepStrictEqual(initial, entry))) ||
      latest?.canonicalId !== policy.canonicalId &&
      (publishedId === undefined || latest?.canonicalId !== publishedId)
    )
      throw new RowndMigrationPolicyError(
        "Administrative canonical email changed",
      );
  };
  if (policy.canonicalId || policy.completedAdditions.length)
    bindAdministrativeSourceGuard(source, tenantId, assertState);
  return {
    ...policy,
    async publish() {
      if (!policy.changesCanonical || !policy.email) return;
      invalidateReconciliationReads("metadata", internalId);
      await assertAuthenticatedMigrationSource(source, tenantId);
      const current = await SuperTokens.getUser(internalId, context);
      const method = current?.loginMethods.find(
        (entry) =>
          entry.recipeId === "passwordless" &&
          entry.tenantIds.includes(tenantId) &&
          entry.hasSameEmailAs(policy.email!),
      );
      if (!method)
        throw new RowndMigrationPolicyError(
          "Administrative canonical email ownership was not established",
        );
      const latest = await getRawUserMetadata(internalId, context);
      await assertAuthenticatedMigrationSource(source, tenantId);
      publishedId = method.recipeUserId.getAsString();
      await UserMetadata.updateUserMetadata(
        internalId,
        {
          rownd_email_recipe_user_id: publishedId,
          rownd_email_recipe_user_ids: {
            ...latest.rownd_email_recipe_user_ids,
            [tenantId]: publishedId,
          },
        },
        context,
      );
      await assertAuthenticatedMigrationSource(source, tenantId);
      for (const pending of policy.completedAdditions) {
        if (pending.verificationRecipeUserId) await EmailVerification.revokeEmailVerificationTokens(
          tenantId, SuperTokens.convertToRecipeUserId(pending.verificationRecipeUserId), pending.value, context);
        for (const id of new Set([internalId, source.externalUserId!])) {
          await assertAuthenticatedMigrationSource(source, tenantId);
          invalidateReconciliationReads("metadata", id);
          clearSuperTokensCoreCallCache(context);
          const metadata = await getRawUserMetadata(id, context);
          const entries = validatedPendingEntries(metadata);
          const recorded = entries.find((entry) => entry.id === pending.id);
          if (!recorded) continue;
          if (!isDeepStrictEqual(recorded, pending) || (id === source.externalUserId &&
            metadata.original_rownd_user?.data.user_id !== source.externalUserId))
            throw new RowndMigrationPolicyError("Administrative pending email changed");
          // Core has no metadata compare-and-swap. Keep the final read/write
          // adjacent so source validation cannot stale the pending array.
          await UserMetadata.updateUserMetadata(id, { rownd_pending_verification: entries.filter((entry) => entry.id !== pending.id) }, context);
        }
      }
      if (
        getCanonicalEmailRecipeUserId(
          await getRawUserMetadata(internalId, context),
          tenantId,
        ) !== publishedId
      )
        throw new RowndMigrationPolicyError(
          "Administrative canonical email publication failed",
        );
    },
  };
}
