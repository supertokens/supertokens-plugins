import SuperTokens from "supertokens-node";
import { RowndMigrationPolicyError } from "./errors";
import { assertAuthenticatedMigrationSource, getAuthenticatedMigrationEmail, isAdministrativeMigration } from "./migration-email";
import EmailVerification from "supertokens-node/recipe/emailverification";
import { getCombinedUserMetadata } from "./rownd-compatibility";
import { assertMigrationMapping } from "./migration-mapping";
import { migrationTelemetry } from "./telemetry/migrationTelemetry";
import type { SuperTokensUserImport } from "./types";
import { clearSuperTokensCoreCallCache, type JsonRecord } from "./utils";

type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type ImportMethod = SuperTokensUserImport["loginMethods"][number];
type Failure = "missing_user" | "unexpected_owner" | "missing_method" |
  "missing_tenant" | "unverified_authenticated_email";

export async function assertMigrationOwnerGraph(user: User, tenantId: string, userContext: JsonRecord) {
  if (!user.loginMethods.length || (!user.isPrimaryUser && user.loginMethods.length !== 1) ||
      !user.loginMethods.some((method) => method.tenantIds.includes(tenantId)) ||
      user.tenantIds.some((tenant) => !user.loginMethods.some((method) => method.tenantIds.includes(tenant))) ||
      user.loginMethods.some((method) => method.tenantIds.some((tenant) => !user.tenantIds.includes(tenant)))) {
    throw new RowndMigrationPolicyError("OWNER_MEMBERSHIP_INCONSISTENT: invalid primary or tenant membership");
  }
  for (const method of user.loginMethods) {
    const member = await SuperTokens.getUser(method.recipeUserId.getAsString(), userContext);
    if (!member || member.id !== user.id || member.isPrimaryUser !== user.isPrimaryUser ||
        !member.loginMethods.some((fresh) => fresh.recipeUserId.getAsString() === method.recipeUserId.getAsString() &&
          fresh.recipeId === method.recipeId && JSON.stringify([...fresh.tenantIds].sort()) === JSON.stringify([...method.tenantIds].sort()))) {
      throw new RowndMigrationPolicyError("OWNER_MEMBERSHIP_INCONSISTENT: recipe owner could not be confirmed");
    }
  }
}

export async function reconcileAdministrativeEmailVerification(input: {
  internalUserId: string; source: SuperTokensUserImport; tenantId: string; userContext: JsonRecord;
}) {
  const { internalUserId, source, tenantId, userContext } = input;
  if (!isAdministrativeMigration(source, tenantId)) return;
  const email = getAuthenticatedMigrationEmail(source, tenantId);
  if (email === undefined) return;
  await assertAuthenticatedMigrationSource(source, tenantId);
  clearSuperTokensCoreCallCache(userContext);
  await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
  const user = await SuperTokens.getUser(internalUserId, userContext);
  if (!user) throw new RowndMigrationPolicyError("MAPPING_TARGET_MISSING: verification owner is missing");
  await assertMigrationOwnerGraph(user, tenantId, userContext);
  const metadata = await getCombinedUserMetadata(internalUserId, userContext);
  const canonicalId = metadata.rownd_email_recipe_user_ids?.[tenantId];
  if ((canonicalId && !user.loginMethods.some((method) => method.recipeUserId.getAsString() === canonicalId && method.hasSameEmailAs(email))) ||
      metadata.rownd_pending_verification?.some((entry) => entry.field === "email" && (entry.tenantId ?? "public") === tenantId)) {
    throw new RowndMigrationPolicyError("Current Rownd email verification is blocked by canonical policy");
  }
  for (const method of user.loginMethods.filter((method) => method.tenantIds.includes(tenantId) && method.hasSameEmailAs(email) &&
    ["passwordless", "thirdparty", "emailpassword"].includes(method.recipeId))) {
    await assertAuthenticatedMigrationSource(source, tenantId);
    clearSuperTokensCoreCallCache(userContext);
    await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
    const mapping = await SuperTokens.getUserIdMapping({ userId: method.recipeUserId.getAsString(), userIdType: "ANY", userContext });
    const recipeUserId = mapping.status === "OK" ? SuperTokens.convertToRecipeUserId(mapping.externalUserId) : method.recipeUserId;
    const assertRecipeOwner = async () => {
      clearSuperTokensCoreCallCache(userContext);
      const currentMapping = await SuperTokens.getUserIdMapping({ userId: recipeUserId.getAsString(), userIdType: "EXTERNAL", userContext });
      const fresh = await SuperTokens.getUser(recipeUserId.getAsString(), userContext);
      if ((mapping.status === "OK" ? currentMapping.status !== "OK" || currentMapping.superTokensUserId !== mapping.superTokensUserId : currentMapping.status === "OK") ||
          !fresh || fresh.id !== user.id || !fresh.loginMethods.some((entry) => entry.recipeUserId.getAsString() === recipeUserId.getAsString() &&
            entry.tenantIds.includes(tenantId) && entry.hasSameEmailAs(email))) {
        throw new RowndMigrationPolicyError("The reconciliation target changed before email verification");
      }
    };
    await assertRecipeOwner();
    if (await EmailVerification.isEmailVerified(recipeUserId, email, userContext)) continue;
    await assertAuthenticatedMigrationSource(source, tenantId);
    const token = await EmailVerification.createEmailVerificationToken(tenantId, recipeUserId, email, userContext);
    if (token.status === "OK") {
      await assertAuthenticatedMigrationSource(source, tenantId);
      await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
      await assertRecipeOwner();
      const verified = await EmailVerification.verifyEmailUsingToken(tenantId, token.token, false, userContext);
      if (verified.status !== "OK") throw new RowndMigrationPolicyError("SOURCE_VERIFICATION_DRIFT: email verification failed");
    }
  }
  clearSuperTokensCoreCallCache(userContext);
}

export async function assertMigrationPostconditions(input: {
  internalUserId: string;
  source: SuperTokensUserImport;
  importMethods: ImportMethod[];
  tenantId: string;
  authenticatedEmail?: string;
  userContext: JsonRecord;
  matchesMethod: (existing: User["loginMethods"][number], expected: ImportMethod) => boolean;
}) {
  const { internalUserId, source, importMethods, tenantId, authenticatedEmail, userContext, matchesMethod } = input;
  const telemetry = migrationTelemetry(userContext);
  if (telemetry) telemetry.stage = "migration_postcondition";

  const observe = (user: User | undefined): Failure | undefined => {
    if (!user) return "missing_user";
    // Mapping validation proves the current alias. A retired SDK alias is not
    // ownership proof, even when an earlier snapshot resolved it to this target.
    if (user.id !== internalUserId && user.id !== source.externalUserId) return "unexpected_owner";
    for (const expected of importMethods) {
      const matches = user.loginMethods.filter((method) => matchesMethod(method, expected));
      if (matches.length === 0) return "missing_method";
      const scoped = matches.filter((method) => method.tenantIds.includes(tenantId));
      if (scoped.length === 0) return "missing_tenant";
      if (expected.recipeId === "passwordless" && authenticatedEmail !== undefined &&
          expected.email?.toLowerCase() === authenticatedEmail && !scoped.some((method) => method.verified)) {
        return "unverified_authenticated_email";
      }
    }
    if (isAdministrativeMigration(source, tenantId) && authenticatedEmail !== undefined &&
        user.loginMethods.some((method) => method.tenantIds.includes(tenantId) && method.hasSameEmailAs(authenticatedEmail) && !method.verified)) {
      return "unverified_authenticated_email";
    }
    return undefined;
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      clearSuperTokensCoreCallCache(userContext);
      await assertAuthenticatedMigrationSource(source, tenantId);
    }
    await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
    const user = await SuperTokens.getUser(internalUserId, userContext);
    if (user && isAdministrativeMigration(source, tenantId)) await assertMigrationOwnerGraph(user, tenantId, userContext);
    let failure = observe(user);
    if (failure === undefined && user && isAdministrativeMigration(source, tenantId) && authenticatedEmail !== undefined) {
      for (const method of user.loginMethods.filter((method) => method.tenantIds.includes(tenantId) && method.hasSameEmailAs(authenticatedEmail))) {
        if (!await EmailVerification.isEmailVerified(method.recipeUserId, authenticatedEmail, userContext)) failure = "unverified_authenticated_email";
      }
    }
    if (failure === undefined) {
      if (attempt > 0) {
        await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
        telemetry?.emit("transition", "migration_postcondition_recovered");
      }
      return;
    }
    const error = new RowndMigrationPolicyError(`Migrated login method postcondition failed: ${failure}`);
    telemetry?.emit("transition", `migration_postcondition_${failure}`, "error", error);
    if (attempt === 1) throw error;
  }
}
