import { isDeepStrictEqual } from "node:util";
import { reconciliationSuperTokens as SuperTokens, reconciliationEmailVerification as EmailVerification, reconciliationUserMetadata as UserMetadata } from "./reconciliation-sdk";
import { RowndMigrationPolicyError } from "./errors";
import { assertAuthenticatedMigrationSource, getAuthenticatedMigrationEmail, isAdministrativeMigration } from "./migration-email";
import { assertSelectorNamespace } from "./migration-mapping";
import { assertMigrationOwnerGraph } from "./migration-postconditions";
import { assertVerificationCellInheritance } from "./migration-verification";
import { createRowndUserIdMapping, matchesImportLoginMethod } from "./supertokens-repository";
import { getRawUserMetadata } from "./rownd-compatibility";
import type { SuperTokensUserImport } from "./types";
import { clearSuperTokensCoreCallCache, isRecord, type JsonRecord } from "./utils";

const key = "rownd_migration_mapping_publication";
type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
// Keep the pre-mapping literal baseline until reconciliation completes. Mapped
// login methods expose alias-keyed verification, including after a lost response.
type Publication = { version: 1; target: string; sourceId: string; sourceIdentity: string; tenantId: string;
  recipes: { id: string; identity: string; email?: string; verified: boolean }[] };

function fail(): never { throw new RowndMigrationPolicyError("Fresh mapping publication evidence changed"); }

function read(value: unknown): Publication | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.version !== 1 || [value.target, value.sourceId, value.sourceIdentity, value.tenantId].some((entry) => typeof entry !== "string" || !entry) ||
    !Array.isArray(value.recipes) || !value.recipes.length || value.recipes.some((entry) => !isRecord(entry) ||
      typeof entry.id !== "string" || !entry.id || typeof entry.identity !== "string" || !entry.identity || typeof entry.verified !== "boolean" ||
      (entry.email !== undefined && (typeof entry.email !== "string" || !entry.email)))) fail();
  const plan = value as Publication;
  if (new Set(plan.recipes.map((entry) => entry.id)).size !== plan.recipes.length || !plan.recipes.some((entry) => entry.id === plan.target)) fail();
  return plan;
}

async function immutable(id: string, context: JsonRecord) {
  await assertSelectorNamespace(id, context);
  const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext: context });
  return mapping.status === "OK" ? mapping.superTokensUserId : id;
}

function identity(method: User["loginMethods"][number]) {
  return JSON.stringify([method.recipeId, method.email, method.phoneNumber, method.thirdParty, [...method.tenantIds].sort(), method.timeJoined, method.webauthn]);
}

function emails(source: SuperTokensUserImport) {
  return [...new Set(source.loginMethods.flatMap((method) => "email" in method && method.email ? [method.email] : []))];
}

export async function assertFreshAliasVerification(source: SuperTokensUserImport, tenantId: string, context: JsonRecord) {
  if (!isAdministrativeMigration(source, tenantId) || !source.externalUserId) fail();
  await assertAuthenticatedMigrationSource(source, tenantId);
  clearSuperTokensCoreCallCache(context);
  for (const email of emails(source)) assertVerificationCellInheritance(email, false,
    await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(source.externalUserId), email, context), getAuthenticatedMigrationEmail(source, tenantId));
}

export async function inspectMappingPublication(id: string, source: SuperTokensUserImport, tenantId: string, context: JsonRecord) {
  const plan = read((await getRawUserMetadata(id, context))[key]);
  if (!plan) return undefined;
  if (!isAdministrativeMigration(source, tenantId) || plan.target !== id || plan.sourceId !== source.externalUserId ||
    plan.sourceIdentity !== JSON.stringify(source.loginMethods) || plan.tenantId !== tenantId) fail();
  clearSuperTokensCoreCallCache(context);
  const user = await SuperTokens.getUser(id, context);
  if (!user || await immutable(user.id, context) !== id || user.loginMethods.length < plan.recipes.length) fail();
  await assertMigrationOwnerGraph(user, tenantId, context);
  const mapping = await SuperTokens.getUserIdMapping({ userId: plan.sourceId, userIdType: "EXTERNAL", userContext: context });
  if (mapping.status === "OK" && mapping.superTokensUserId !== id) fail();
  const proof = getAuthenticatedMigrationEmail(source, tenantId);
  const observedRecipes = new Set<string>();
  for (const method of user.loginMethods) {
    const recipeId = await immutable(method.recipeUserId.getAsString(), context);
    const recipe = plan.recipes.find((entry) => entry.id === recipeId);
    if (!recipe) continue;
    observedRecipes.add(recipeId);
    if (recipe.identity !== identity(method) || recipe.email !== method.email) fail();
    const recipeMapping = await SuperTokens.getUserIdMapping({ userId: recipeId, userIdType: "SUPERTOKENS", userContext: context });
    if (recipeMapping.status === "OK" && (recipeId !== id || recipeMapping.externalUserId !== plan.sourceId)) fail();
    if (recipe.email) {
      const baseline = await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(recipeId), recipe.email, context);
      if (baseline !== recipe.verified) fail();
      const effective = await EmailVerification.isEmailVerified(method.recipeUserId, recipe.email, context);
      assertVerificationCellInheritance(recipe.email, recipe.verified, effective, proof);
      if (method.verified !== effective) fail();
    } else if (method.verified !== recipe.verified) fail();
  }
  if (observedRecipes.size !== plan.recipes.length) fail();
  const primary = plan.recipes.find((recipe) => recipe.id === id)!;
  for (const email of emails(source)) assertVerificationCellInheritance(email, primary.email === email && primary.verified,
    await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(plan.sourceId), email, context), proof);
  return plan;
}

export async function publishFreshMapping(id: string, source: SuperTokensUserImport, tenantId: string, context: JsonRecord) {
  if (!isAdministrativeMigration(source, tenantId) || !source.externalUserId) fail();
  await assertAuthenticatedMigrationSource(source, tenantId);
  let plan = await inspectMappingPublication(id, source, tenantId, context);
  if (!plan) {
    const user = await SuperTokens.getUser(id, context);
    const mapping = await SuperTokens.getUserIdMapping({ userId: source.externalUserId, userIdType: "EXTERNAL", userContext: context });
    if (!user || user.id !== id || mapping.status === "OK" || !user.loginMethods.some((method) =>
      source.loginMethods.some((expected) => matchesImportLoginMethod(method, expected)))) fail();
    await assertMigrationOwnerGraph(user, tenantId, context);
    const recipes: Publication["recipes"] = [];
    for (const method of user.loginMethods) {
      const recipeId = method.recipeUserId.getAsString();
      if ((await SuperTokens.getUserIdMapping({ userId: recipeId, userIdType: "SUPERTOKENS", userContext: context })).status === "OK") fail();
      const verified = method.email ? await EmailVerification.isEmailVerified(method.recipeUserId, method.email, context) : method.verified;
      if (verified !== method.verified) fail();
      recipes.push({ id: recipeId, identity: identity(method), ...(method.email ? { email: method.email } : {}), verified });
    }
    plan = { version: 1, target: id, sourceId: source.externalUserId, sourceIdentity: JSON.stringify(source.loginMethods), tenantId, recipes };
    const primary = recipes.find((recipe) => recipe.id === id);
    if (!primary) fail();
    for (const email of emails(source)) assertVerificationCellInheritance(email, primary.email === email && primary.verified,
      await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(source.externalUserId), email, context), getAuthenticatedMigrationEmail(source, tenantId));
    await assertAuthenticatedMigrationSource(source, tenantId);
    if ((await getRawUserMetadata(id, context))[key] !== undefined) fail();
    await UserMetadata.updateUserMetadata(id, { [key]: plan }, context);
  }
  const assertFresh = async () => {
    await assertAuthenticatedMigrationSource(source, tenantId);
    if (!isDeepStrictEqual(await inspectMappingPublication(id, source, tenantId, context), plan)) fail();
  };
  await assertFresh();
  if ((await SuperTokens.getUserIdMapping({ userId: plan.sourceId, userIdType: "EXTERNAL", userContext: context })).status !== "OK") {
    for (const email of emails(source)) {
      await assertFresh();
      if ((await EmailVerification.revokeEmailVerificationTokens(tenantId, SuperTokens.convertToRecipeUserId(plan.sourceId), email, context)).status !== "OK") fail();
    }
    await assertFresh();
    await createRowndUserIdMapping(id, plan.sourceId, context, true);
  }
  await assertFresh();
  const primary = plan.recipes.find((recipe) => recipe.id === id)!;
  if (primary.email && primary.verified && !await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(plan.sourceId), primary.email, context)) {
    const token = await EmailVerification.createEmailVerificationToken(tenantId, SuperTokens.convertToRecipeUserId(plan.sourceId), primary.email, context);
    await assertFresh();
    if (token.status === "OK" && (await EmailVerification.verifyEmailUsingToken(tenantId, token.token, false, context)).status !== "OK") fail();
    await assertFresh();
  }
}

export async function completeMappingPublication(id: string, source: SuperTokensUserImport, tenantId: string, context: JsonRecord) {
  await assertAuthenticatedMigrationSource(source, tenantId);
  const plan = await inspectMappingPublication(id, source, tenantId, context);
  if (!plan) return;
  const mapping = await SuperTokens.getUserIdMapping({ userId: plan.sourceId, userIdType: "EXTERNAL", userContext: context });
  if (mapping.status !== "OK" || mapping.superTokensUserId !== id) fail();
  const primary = plan.recipes.find((recipe) => recipe.id === id)!;
  if (primary.email && primary.verified && !await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(plan.sourceId), primary.email, context)) fail();
  await UserMetadata.updateUserMetadata(id, { [key]: null }, context);
  clearSuperTokensCoreCallCache(context);
  if ((await getRawUserMetadata(id, context))[key] !== undefined) fail();
}

export async function assertMappingPublicationSessionMembership(userId: string, recipeId: string, context: JsonRecord) {
  for (const id of new Set([userId, recipeId, await immutable(userId, context), await immutable(recipeId, context)])) {
    const metadata = await getRawUserMetadata(id, context);
    if (read(metadata[key])) throw new RowndMigrationPolicyError("Fresh mapping publication is incomplete");
    const orphan = metadata.rownd_migration_orphan_mapping_repair;
    if (orphan !== undefined && (!isRecord(orphan) || orphan.phase !== "COMPLETE")) {
      throw new RowndMigrationPolicyError("Orphan mapping recovery is incomplete");
    }
  }
}
