import SuperTokens from "supertokens-node";
import EmailVerification from "supertokens-node/recipe/emailverification";
import { assertAuthenticatedMigrationSource, getAuthenticatedMigrationEmail, getMigrationContactEmail, isCurrentRowndEmailReconciliationPlan, prepareCurrentRowndEmailReconciliation } from "./migration-email";
import { assertMigrationOwnerGraph } from "./migration-postconditions";
import { inspectProviderMigrationCheckpoints } from "./migration-provider";
import { assertMigrationContactElection, classifyMigrationForeignOwner, getCanonicalEmailRecipeUserId, getMigrationImportMethods, getPendingVerifications, getUserMetadata, inspectMigrationMethods, matchesImportLoginMethod } from "./supertokens-repository";
import { getRawUserMetadata } from "./rownd-compatibility";
import { isProtectedDuplicateMapping } from "./migration-mapping";
import type { SuperTokensUserImport } from "./types";
import type { JsonRecord } from "./utils";

type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type Method = SuperTokensUserImport["loginMethods"][number];

export type ReconcilePreviewAction = {
  action: "import_user" | "restore_mapping" | "create_mapping" | "create_primary" | "create_method" |
    "link_method" | "verify_email" | "update_migration_metadata" | "review_provider_retirement" | "review_email_retirement";
  method?: Method;
  recipeUserId?: string;
  supertokens_user_id?: string;
  email?: string;
  conditional?: boolean;
};
export type ReconcilePreviewIssue = { code: string; recipeUserId?: string; supertokens_user_id?: string };
export type ReconcilePreview = {
  status: "PREVIEW" | "BLOCKED";
  dryRun: true;
  changed: false;
  actions: string[];
  canReconcile: boolean;
  matchesSource: boolean;
  proposedActions: ReconcilePreviewAction[];
  blockers: ReconcilePreviewIssue[];
  requiresExecutionProof: ReconcilePreviewIssue[];
  missingMethods: Method[];
  snapshotOnly: true;
  supertokens_user_id?: string;
  recipe_user_ids?: string[];
};

export async function previewReconciliation(input: {
  source: SuperTokensUserImport; selected?: User; internalId?: string; restoreMapping: boolean;
  tenantId: string; userContext: JsonRecord;
  plannedOwnerIds?: Set<string>;
}): Promise<ReconcilePreview> {
  const { source, selected, restoreMapping, tenantId, userContext } = input;
  const result: ReconcilePreview = { status: "PREVIEW", dryRun: true, changed: false, actions: [], canReconcile: false,
    matchesSource: false, proposedActions: [], blockers: [], requiresExecutionProof: [], missingMethods: [], snapshotOnly: true };
  const email = getMigrationContactEmail(source, tenantId);
  const verifiedEmail = getAuthenticatedMigrationEmail(source, tenantId);
  const inspections = await inspectMigrationMethods(source, source.loginMethods, tenantId, userContext);
  const owners = new Map(inspections.flatMap(({ owners }) => owners.map(({ user }) => [user.id, user] as const)));
  for (const user of owners.values()) await assertMigrationOwnerGraph(user, tenantId, userContext);
  const provider = inspections.find(({ importMethod, match }) => importMethod.recipeId === "thirdparty" && match)?.match;
  const match = provider ?? inspections.find(({ reconciliationMatch }) => reconciliationMatch)?.reconciliationMatch;
  const target = selected ?? match?.user;
  if (!target) {
    if (inspections.some(({ owners }) => owners.length > 0)) result.blockers.push({ code: "IDENTITY_RESERVED_BY_OTHER_OWNER" });
    else result.proposedActions.push({ action: "import_user" });
    result.missingMethods = source.loginMethods;
  } else {
    await assertMigrationOwnerGraph(target, tenantId, userContext);
    assertMigrationContactElection(source, tenantId, target, selected ? target.loginMethods[0]! : match!.loginMethod, selected !== undefined, provider !== undefined);
    const mapping = await SuperTokens.getUserIdMapping({ userId: target.id, userIdType: "EXTERNAL", userContext });
    const id = input.internalId ?? (mapping.status === "OK" ? mapping.superTokensUserId : target.id);
    result.supertokens_user_id = id;
    result.recipe_user_ids = target.loginMethods.map((method) => method.recipeUserId.getAsString());
    const metadata = await getUserMetadata(id, userContext);
    const canonicalId = getCanonicalEmailRecipeUserId(metadata, tenantId);
    const pendingPlans = getPendingVerifications(metadata).filter((entry) => entry.field === "email" && (entry.tenantId ?? "public") === tenantId);
    const pending = pendingPlans.length > 0;
    const committingMigration = pendingPlans.some((entry) => entry.status === "COMMITTING" && isCurrentRowndEmailReconciliationPlan(entry));
    if (committingMigration) {
      result.proposedActions.push({ action: "review_email_retirement", conditional: true });
      result.requiresExecutionProof.push({ code: "EMAIL_RETIREMENT_CHECKPOINT_REQUIRED" });
    }
    const currentEmail = source.loginMethods.find((method) => method.recipeId === "passwordless" && method.email);
    const importMethods = getMigrationImportMethods(source, tenantId, selected, canonicalId, pending);
    const activeInspections = inspections.filter(({ importMethod }) => importMethods.includes(importMethod));
    const foreignOwners = activeInspections.flatMap(({ importMethod, owners }) => owners
      .filter(({ user }) => user.id !== target.id && !input.plannedOwnerIds?.has(user.id)).map((owner) => ({ ...owner, importMethod })));
    for (const owner of foreignOwners) {
      const eligible = classifyMigrationForeignOwner(owner, selected, email, tenantId);
      if (!eligible.provider && !eligible.phone && !eligible.authenticatedContact) {
        result.blockers.push({ code: "FOREIGN_OWNER_NOT_ELIGIBLE", recipeUserId: owner.loginMethod.recipeUserId.getAsString() });
      }
    }
    if (foreignOwners.length > 0 || activeInspections.some(({ match }) => !match)) {
      for (const { user } of activeInspections.flatMap(({ incidentalEmailOwners }) => incidentalEmailOwners)) {
        if (user.id !== target.id && !input.plannedOwnerIds?.has(user.id)) result.blockers.push({ code: "INCIDENTAL_CONTACT_CONFLICT", supertokens_user_id: user.id });
      }
    }
    if (!committingMigration && currentEmail?.recipeId === "passwordless" && ((canonicalId && !target.loginMethods.some((method) =>
      method.recipeUserId.getAsString() === canonicalId && method.tenantIds.includes(tenantId) && method.hasSameEmailAs(currentEmail.email!))) || pending)) {
      result.blockers.push({ code: "CANONICAL_EMAIL_POLICY" });
    }
    if (!canonicalId && !pending && selected) {
      const emailPlan = await prepareCurrentRowndEmailReconciliation(source, target, metadata, tenantId);
      if (emailPlan) {
        result.proposedActions.push({ action: "review_email_retirement", conditional: true, email: emailPlan.email });
        result.requiresExecutionProof.push({ code: "EMAIL_RETIREMENT_CHECKPOINT_REQUIRED" });
      }
    }
    if (restoreMapping) result.proposedActions.push({ action: "restore_mapping", supertokens_user_id: id });
    else if (!selected && id !== source.externalUserId) {
      result.proposedActions.push({ action: "create_mapping", supertokens_user_id: id, conditional: true });
      if (mapping.status !== "OK") {
        // Core has no read-only mapping eligibility API. Ancillary recipe state
        // can reject non-force publication even when identity ownership is proven.
        const stored = await getRawUserMetadata(id, userContext);
        result.requiresExecutionProof.push({ code: Object.keys(stored).length > 0
          ? "MAPPING_METADATA_REQUIRES_EXECUTION_PROOF" : "NATIVE_MAPPING_PUBLICATION_REQUIRES_EXECUTION_PROOF", supertokens_user_id: id });
      }
    }
    if (mapping.status === "OK" && mapping.externalUserId !== source.externalUserId) {
      result.requiresExecutionProof.push({ code: "DUPLICATE_SOURCE_PROOF_REQUIRED", supertokens_user_id: id });
    }
    const contactOnly = email !== undefined && source.loginMethods.length === 1 && target.loginMethods.length === 1 &&
      target.loginMethods[0]!.recipeId === "passwordless" && target.loginMethods[0]!.hasSameEmailAs(email);
    if (!target.isPrimaryUser && !contactOnly && (metadata.rownd_migration_complete !== true || activeInspections.length > 0)) {
      result.proposedActions.push({ action: "create_primary", supertokens_user_id: id });
    }
    for (const inspection of inspections) {
      const expected = inspection.importMethod;
      if (target.loginMethods.some((method) => method.tenantIds.includes(tenantId) && matchesImportLoginMethod(method, expected))) continue;
      result.missingMethods.push(expected);
      if (!importMethods.includes(expected)) {
        if (!committingMigration && !result.blockers.some(({ code }) => code === "CANONICAL_EMAIL_POLICY")) {
          result.blockers.push({ code: "MISSING_METHOD_EXCLUDED_BY_POLICY" });
        }
        continue;
      }
      const existing = inspection.match;
      if (!existing) {
        if (expected.recipeId === "emailpassword") result.blockers.push({ code: "UNSUPPORTED_METHOD_CREATION" });
        else result.proposedActions.push({ action: "create_method", method: expected });
      } else {
        if (input.plannedOwnerIds?.has(existing.user.id)) continue;
        const recipeUserId = existing.loginMethod.recipeUserId.getAsString();
        const eligible = classifyMigrationForeignOwner({ ...existing, importMethod: expected }, selected, email, tenantId);
        if (eligible.provider || eligible.phone || eligible.authenticatedContact) {
          const donorMapping = await SuperTokens.getUserIdMapping({ userId: recipeUserId, userIdType: "ANY", userContext });
          if (donorMapping.status === "OK" && donorMapping.externalUserId !== source.externalUserId && await isProtectedDuplicateMapping({
            source, duplicateId: donorMapping.externalUserId, ownerInternalId: donorMapping.superTokensUserId, targetInternalId: id, tenantId, userContext,
          })) result.blockers.push({ code: "PUBLISHED_DONOR_OWNERSHIP_PROTECTED", recipeUserId });
          const donor = await getRawUserMetadata(donorMapping.status === "OK" ? donorMapping.superTokensUserId : recipeUserId, userContext);
          const conditional = donorMapping.status === "OK" || donor.original_rownd_user !== undefined || existing.loginMethod.tenantIds.length !== 1;
          result.proposedActions.push({ action: "link_method", recipeUserId, method: expected, conditional });
          if (conditional) result.requiresExecutionProof.push({ code: "DONOR_OWNERSHIP_PROOF_REQUIRED", recipeUserId });
        }
      }
    }
    for (const method of target.loginMethods.filter((method) => method.tenantIds.includes(tenantId))) {
      const recipeMapping = await SuperTokens.getUserIdMapping({ userId: method.recipeUserId.getAsString(), userIdType: "ANY", userContext });
      const verificationId = restoreMapping && method.recipeUserId.getAsString() === id
        ? SuperTokens.convertToRecipeUserId(source.externalUserId!) : recipeMapping.status === "OK"
          ? SuperTokens.convertToRecipeUserId(recipeMapping.externalUserId) : method.recipeUserId;
      if (verifiedEmail !== undefined && method.hasSameEmailAs(verifiedEmail) && !await EmailVerification.isEmailVerified(verificationId, verifiedEmail, userContext)) {
        result.proposedActions.push({ action: "verify_email", recipeUserId: verificationId.getAsString(), email: verifiedEmail });
      }
      if (method.thirdParty && ["apple", "google"].includes(method.thirdParty.id) && source.loginMethods.some((expected) =>
        expected.recipeId === "thirdparty" && expected.thirdPartyId === method.thirdParty!.id && expected.thirdPartyUserId !== method.thirdParty!.userId)) {
        result.proposedActions.push({ action: "review_provider_retirement", recipeUserId: method.recipeUserId.getAsString(), conditional: true });
        result.requiresExecutionProof.push({ code: "PROVIDER_RETIREMENT_PROOF_REQUIRED", recipeUserId: method.recipeUserId.getAsString() });
      }
    }
    if (metadata.rownd_migration_complete !== true) result.proposedActions.push({ action: "update_migration_metadata" });
    if (await inspectProviderMigrationCheckpoints(id, source.externalUserId!, tenantId, userContext)) {
      result.requiresExecutionProof.push({ code: "MIGRATION_CHECKPOINT_REVIEW_REQUIRED" });
    }
    result.matchesSource = result.missingMethods.length === 0 && result.proposedActions.length === 0 && result.requiresExecutionProof.length === 0 && result.blockers.length === 0;
  }
  await assertAuthenticatedMigrationSource(source, tenantId);
  result.canReconcile = result.blockers.length === 0 && result.requiresExecutionProof.length === 0;
  if (result.blockers.length) result.status = "BLOCKED";
  return result;
}
