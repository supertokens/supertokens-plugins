import {
  reconciliationSuperTokens as SuperTokens,
  reconciliationUserMetadata as UserMetadata,
} from "./reconciliation-sdk";
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
import { readOwnerPlanCheckpoint } from "./migration-owner-plan";
import { invalidateReconciliationReads } from "./reconciliation-reads";

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
  const pending = getPendingVerifications(metadata);
  if (
    metadata.rownd_pending_verification !== undefined &&
    (!Array.isArray(metadata.rownd_pending_verification) ||
      metadata.rownd_pending_verification.length !== pending.length)
  )
    fail();
  for (const entry of pending.filter(
    (value) =>
      value.field === "email" && (value.tenantId ?? "public") === tenantId,
  )) {
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
  const immutable = async (id: string) => {
    const mapping = await SuperTokens.getUserIdMapping({
      userId: id,
      userIdType: "EXTERNAL",
      userContext: context,
    });
    return mapping.status === "OK" ? mapping.superTokensUserId : id;
  };
  const canonicalInternal = canonicalId && (await immutable(canonicalId));
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
  const plan = readOwnerPlanCheckpoint(metadata);
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
    changesCanonical: !!(
      email &&
      ((canonicalId && !canonical!.hasSameEmailAs(email)) ||
        (!canonicalId && priorCanonical))
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
      await getUserMetadata(internalId, context),
      tenantId,
      context,
    );
    if (
      latest?.canonicalId !== policy.canonicalId &&
      (publishedId === undefined || latest?.canonicalId !== publishedId)
    )
      throw new RowndMigrationPolicyError(
        "Administrative canonical email changed",
      );
  };
  if (policy.canonicalId)
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
