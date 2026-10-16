import { reconciliationSuperTokens as SuperTokens, reconciliationEmailVerification as EmailVerification } from "./reconciliation-sdk";
import { inspectAdministrativeMetadataBackfill, inspectPublicMetadataPublication } from "./migration-admin-metadata";
import { inspectAdministrativeProviderIntroductions } from "./migration-admin-provider";
import { assertAuthenticatedMigrationSource, getAuthenticatedMigrationEmail, isCurrentRowndEmailReconciliationPlan, prepareCurrentRowndEmailReconciliation } from "./migration-email";
import { assertMigrationOwnerGraph } from "./migration-postconditions";
import { inspectProviderMigrationCheckpoints } from "./migration-provider";
import { discoverMethodSnapshot, getCanonicalEmailRecipeUserId, getMigrationImportMethods, getPendingVerifications, inspectMigrationMethods, matchesImportLoginMethod } from "./supertokens-repository";
import { planMethods, type MethodPlan } from "./migration-method-plan";
import { getRawUserMetadata } from "./rownd-compatibility";
import { isProtectedDuplicateMapping } from "./migration-mapping";
import { getAdministrativeRepairMetadata, inspectAdministrativeEmailPolicy } from "./migration-admin-email";
import { assertVerificationCellInheritance } from "./migration-verification";
import type { SuperTokensUserImport } from "./types";
import type { JsonRecord } from "./utils";

type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type Method = SuperTokensUserImport["loginMethods"][number];

export type ReconcilePreviewAction = {
  action: "import_user" | "restore_mapping" | "create_mapping" | "remove_mapping" | "create_primary" | "create_method" |
    "link_method" | "unlink_method" | "verify_email" | "set_canonical_email" | "update_migration_metadata" | "review_provider_retirement" | "review_email_retirement" | "override_placeholder_provenance" | "publish_public_metadata";
  method?: Method;
  recipeUserId?: string;
  supertokens_user_id?: string;
  rownd_user_id?: string;
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
  mappingPlanned?: boolean;
  onMethodPlan?: (plan: MethodPlan) => void;
}): Promise<ReconcilePreview> {
  const { source, selected, restoreMapping, tenantId, userContext } = input;
  const result: ReconcilePreview = { status: "PREVIEW", dryRun: true, changed: false, actions: [], canReconcile: false,
    matchesSource: false, proposedActions: [], blockers: [], requiresExecutionProof: [], missingMethods: [], snapshotOnly: true };
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
    const mapping = await SuperTokens.getUserIdMapping({ userId: target.id, userIdType: "EXTERNAL", userContext });
    const id = input.internalId ?? (mapping.status === "OK" ? mapping.superTokensUserId : target.id);
    result.supertokens_user_id = id;
    result.recipe_user_ids = target.loginMethods.map((method) => method.recipeUserId.getAsString());
    const metadata = await getAdministrativeRepairMetadata(id, source.externalUserId!, userContext);
    const canonicalId = getCanonicalEmailRecipeUserId(metadata, tenantId);
    const administrativeEmail = await inspectAdministrativeEmailPolicy(source, target, metadata, tenantId, userContext);
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
    const methodPlan = planMethods(await discoverMethodSnapshot({ source, tenantId, userContext, preferred: selected,
      inspections: activeInspections, plannedOwnerIds: input.plannedOwnerIds }));
    input.onMethodPlan?.(methodPlan);
    if (methodPlan.status === "BLOCKED") result.blockers.push({ code: methodPlan.code });
    if (!administrativeEmail && !committingMigration && currentEmail?.recipeId === "passwordless" && ((canonicalId && !target.loginMethods.some((method) =>
      method.recipeUserId.getAsString() === canonicalId && method.tenantIds.includes(tenantId) && method.hasSameEmailAs(currentEmail.email!))) || pending)) {
      result.blockers.push({ code: "CANONICAL_EMAIL_POLICY" });
    }
    if (administrativeEmail?.changesCanonical) result.proposedActions.push({ action: "set_canonical_email", email: administrativeEmail.email, supertokens_user_id: id });
    if (!canonicalId && !pending && selected && !administrativeEmail?.changesCanonical) {
      const emailPlan = await prepareCurrentRowndEmailReconciliation(source, target, metadata, tenantId);
      if (emailPlan) {
        result.proposedActions.push({ action: "review_email_retirement", conditional: true, email: emailPlan.email });
        result.requiresExecutionProof.push({ code: "EMAIL_RETIREMENT_CHECKPOINT_REQUIRED" });
      }
    }
    if (restoreMapping) result.proposedActions.push({ action: "create_mapping", supertokens_user_id: id });
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
    if (!input.mappingPlanned && mapping.status === "OK" && mapping.externalUserId !== source.externalUserId) {
      result.requiresExecutionProof.push({ code: "DUPLICATE_SOURCE_PROOF_REQUIRED", supertokens_user_id: id });
    }
    if (methodPlan.status !== "BLOCKED" && methodPlan.actions.some((action) => action.kind === "ENSURE_PRIMARY")) {
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
        if (methodPlan.status !== "BLOCKED" && methodPlan.actions.some((action) => (action.kind === "CREATE_THIRDPARTY" || action.kind === "CREATE_PASSWORDLESS") && action.method === expected)) {
          result.proposedActions.push({ action: "create_method", method: expected });
        }
      } else {
        if (input.plannedOwnerIds?.has(existing.user.id)) continue;
        const recipeUserId = existing.loginMethod.recipeUserId.getAsString();
        if (methodPlan.status !== "BLOCKED" && methodPlan.actions.some((action) => action.kind === "LINK" && action.method === expected)) {
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
      if (restoreMapping && method.recipeUserId.getAsString() === id) {
        const emails = new Set([...(method.email ? [method.email] : []), ...source.loginMethods.flatMap((entry) => "email" in entry && entry.email ? [entry.email] : [])]);
        for (const email of emails) {
          const baseline = method.email === email && await EmailVerification.isEmailVerified(method.recipeUserId, email, userContext);
          const effective = await EmailVerification.isEmailVerified(verificationId, email, userContext);
          assertVerificationCellInheritance(email, baseline, effective, verifiedEmail);
          if (baseline && !effective && email !== verifiedEmail) result.proposedActions.push({ action: "verify_email", recipeUserId: verificationId.getAsString(), email });
        }
      }
      if (verifiedEmail !== undefined && method.hasSameEmailAs(verifiedEmail) && !await EmailVerification.isEmailVerified(verificationId, verifiedEmail, userContext)) {
        result.proposedActions.push({ action: "verify_email", recipeUserId: verificationId.getAsString(), email: verifiedEmail });
      }
      if (method.thirdParty && ["apple", "google"].includes(method.thirdParty.id) && source.loginMethods.some((expected) =>
        expected.recipeId === "thirdparty" && expected.thirdPartyId === method.thirdParty!.id && expected.thirdPartyUserId !== method.thirdParty!.userId)) {
        result.proposedActions.push({ action: "review_provider_retirement", recipeUserId: method.recipeUserId.getAsString(), conditional: true });
        result.requiresExecutionProof.push({ code: "PROVIDER_RETIREMENT_PROOF_REQUIRED", recipeUserId: method.recipeUserId.getAsString() });
      }
    }
    if (metadata.rownd_migration_complete !== true || Object.keys(await inspectAdministrativeMetadataBackfill({
      source, tenantId, internalUserId: id, userContext,
    })).length > 0) result.proposedActions.push({ action: "update_migration_metadata", supertokens_user_id: id });
    if (Object.keys(await inspectPublicMetadataPublication({ source, tenantId, internalUserId: id, userContext })).length) {
      result.proposedActions.push({ action: "publish_public_metadata", supertokens_user_id: id, rownd_user_id: source.externalUserId });
    }
    await inspectAdministrativeProviderIntroductions(source, tenantId, id, userContext);
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
