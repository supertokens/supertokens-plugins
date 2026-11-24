import { isDeepStrictEqual } from "node:util";
import type { JSONObject } from "supertokens-node/types";
import { resolveCanonicalEmailForTenant } from "./canonical-email";
import { getConfigForUserContext, getPluginConfig } from "./config";
import { orphanCheckpointKey } from "./migration-orphan-checkpoint";
import { OWNER_PLAN_KEY, readOwnerPlanCheckpoint } from "./migration-owner-plan";
import type { ProfileReader } from "./profile-read";
import { invalidateReconciliationReads } from "./reconciliation-reads";
import {
  reconciliationSuperTokens as SuperTokens,
  reconciliationUserMetadata as UserMetadata,
} from "./reconciliation-sdk";
import {
  buildConfiguredSessionClaims,
  buildRowndSessionClaimPayload,
  buildStandardOAuthClaims,
  getAuthoritativeProfileFields,
  getCanonicalPresentationMetadata,
  getRawUserMetadata,
  inspectLinkedUserMetadata,
  isCanonicalReservedMetadataKey,
  isDualWriteMetadataMode,
  isIdentityField,
  isInternalMetadataField,
  type LinkedUserMetadataInspection,
  type RowndMetadata,
  type SuperTokensUser,
} from "./rownd-compatibility";
import { assembleUserProfile } from "./supertokens-repository";
import type { MigrationTelemetry } from "./telemetry/migrationTelemetry";
import type { RowndPluginNormalisedConfig } from "./types";
import { clearSuperTokensCoreCallCache, isJsonRecord, type JsonRecord } from "./utils";

export type CanonicalRepublishResult =
  | { status: "UNCHANGED" }
  | { status: "PUBLISHED"; keys: string[] }
  | { status: "SKIPPED"; reason: string };

/** An owner state the offline canonical copy would also refuse to publish. */
export class CanonicalRepublishRefusal extends Error {
  constructor(readonly reason: string) {
    super(`Canonical republish refused: ${reason}`);
  }
}

function refuse(reason: string): never {
  throw new CanonicalRepublishRefusal(reason);
}

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const nonEmptyText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

// Core stores JSON losslessly only for these values; anything else would not round-trip.
function assertSafeJson(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
  if (Array.isArray(value)) return value.forEach(assertSafeJson);
  if (isJsonRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    for (const [key, entry] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) refuse("unsupported-json-key");
      assertSafeJson(entry);
    }
    return;
  }
  refuse("unsupported-json");
}

function validateRecord(metadata: RowndMetadata, primaryUserId: string) {
  assertSafeJson(metadata);
  if (Object.keys(metadata).some(isCanonicalReservedMetadataKey)) refuse("reserved-metadata-collision");
  const plan = metadata[OWNER_PLAN_KEY];
  if ((isJsonRecord(plan) && own(plan, "retiredAliases")) ||
      own(metadata, "rownd_migration_superseded") || own(metadata, orphanCheckpointKey)) {
    refuse("retirement-dependent");
  }
  const authority = metadata.rownd_profile_authoritative_fields as unknown;
  if (authority !== undefined && (!Array.isArray(authority) || authority.some((key) => !nonEmptyText(key) ||
    key.startsWith("rownd_migration_") || key.startsWith("rownd_pending_") || isInternalMetadataField(key) ||
    isCanonicalReservedMetadataKey(key) || isIdentityField(key)) || new Set(authority).size !== authority.length)) {
    refuse("invalid-authority");
  }
  const original = metadata.original_rownd_user as unknown;
  if (original !== undefined) {
    if (!isJsonRecord(original) || !isJsonRecord(original.data) || !nonEmptyText(original.data.user_id) ||
      ["meta", "verified_data", "attributes"].some((key) => original[key] !== undefined && !isJsonRecord(original[key])) ||
      (original.groups !== undefined && (!Array.isArray(original.groups) || original.groups.some((group) => !isJsonRecord(group)))) ||
      ["auth_level", "state"].some((key) => original[key] !== undefined && typeof original[key] !== "string")) {
      refuse("invalid-original");
    }
  }
  const pending = metadata.rownd_pending_verification as unknown;
  if (pending !== undefined && (!Array.isArray(pending) || pending.length > 0)) refuse("pending-verification");
  if (metadata.rownd_email_metadata_version !== undefined && metadata.rownd_email_metadata_version !== 1) {
    refuse("unsupported-email-version");
  }
  for (const key of Object.keys(metadata)) {
    if (!key.startsWith("rownd_migration_") || key === "rownd_migration_complete") continue;
    if (key === OWNER_PLAN_KEY) {
      let checkpoint: ReturnType<typeof readOwnerPlanCheckpoint>;
      try {
        checkpoint = readOwnerPlanCheckpoint(metadata);
      } catch {
        refuse("unsupported-checkpoint");
      }
      if (!checkpoint || checkpoint.status !== "COMPLETE" || checkpoint.cursor !== checkpoint.operations.length ||
        checkpoint.target !== primaryUserId) refuse("unsupported-checkpoint");
    } else if (key === "rownd_migration_target" || key === "rownd_migration_canonical_target") {
      if (metadata[key] !== primaryUserId) refuse("conflicting-target");
    } else refuse("unsupported-checkpoint");
  }
  if (metadata.rownd_migration_complete !== undefined && metadata.rownd_migration_complete !== true) {
    refuse("migration-incomplete");
  }
}

function ownerRecords(inspection: LinkedUserMetadataInspection, destination: RowndMetadata) {
  const records = [{ userId: inspection.primaryUserId, metadata: inspection.primaryMetadata }, ...inspection.linkedMetadata];
  if (!records.some(({ userId }) => userId === inspection.user!.id)) {
    records.push({ userId: inspection.user!.id, metadata: destination });
  }
  return records;
}

// The runtime subset of the offline admission rules. Ownership-graph proofs that
// need extra Core reads per address are left to the final pre-switch check.
function validateOwner(inspection: LinkedUserMetadataInspection, destination: RowndMetadata) {
  const user = inspection.user;
  if (!user) refuse("owner-not-found");
  if (inspection.mapping && (inspection.mapping.externalUserId !== user.id ||
    inspection.mapping.superTokensUserId !== inspection.primaryUserId)) refuse("invalid-primary-mapping");
  if (!inspection.mapping && user.id !== inspection.primaryUserId) refuse("missing-primary-mapping");
  const records = ownerRecords(inspection, destination);
  if (new Set(records.map(({ userId }) => userId)).size !== records.length) refuse("invalid-source-set");
  if (inspection.rowndMetadataSourceUserId !== undefined && !records.some(({ userId, metadata }) =>
    userId === inspection.rowndMetadataSourceUserId && isDeepStrictEqual(metadata, inspection.rowndMetadataSourceMetadata))) {
    refuse("invalid-provenance");
  }
  for (const { metadata } of records) validateRecord(metadata, inspection.primaryUserId);
  validateRecord(inspection.combinedMetadata, inspection.primaryUserId);
  const ownsEmailMethod = (id: unknown, tenantId?: string) => nonEmptyText(id) && user.loginMethods.some((method) =>
    method.recipeUserId.getAsString() === id && method.email && (tenantId === undefined || method.tenantIds.includes(tenantId)));
  for (const { metadata } of records) {
    const pointers = metadata.rownd_email_recipe_user_ids as unknown;
    if (pointers !== undefined && (!isJsonRecord(pointers) ||
      Object.entries(pointers).some(([tenantId, id]) => !ownsEmailMethod(id, tenantId)))) refuse("invalid-email-pointers");
    if (metadata.rownd_email_recipe_user_id !== undefined && !ownsEmailMethod(metadata.rownd_email_recipe_user_id)) {
      refuse("invalid-email-pointers");
    }
  }
  const selectedId = inspection.mapping?.externalUserId ?? inspection.combinedMetadata.original_rownd_user?.data?.user_id;
  const selected = records.filter(({ metadata }) => metadata.original_rownd_user !== undefined &&
    metadata.original_rownd_user.data?.user_id === selectedId)
    .map(({ metadata }) => getCanonicalPresentationMetadata({ original_rownd_user: metadata.original_rownd_user! }).original_rownd_user);
  if (selected.some((original) => !isDeepStrictEqual(original, selected[0]))) refuse("ambiguous-original");
  const combinedAuthority = getAuthoritativeProfileFields(inspection.combinedMetadata);
  for (const { metadata } of records) {
    for (const key of getAuthoritativeProfileFields(metadata)) {
      if (!combinedAuthority.includes(key) || own(metadata, key) !== own(inspection.combinedMetadata, key) ||
        !isDeepStrictEqual(metadata[key], inspection.combinedMetadata[key])) refuse("conflicting-authority");
    }
  }
  for (const tenantId of user.tenantIds) {
    const resolution = resolveCanonicalEmailForTenant({ user, metadata: inspection.combinedMetadata, tenantId });
    if (resolution.status === "AMBIGUOUS" || resolution.status === "INVALID_CANONICAL") refuse("ambiguous-email");
  }
}

/**
 * Computes the patch that makes the SDK-visible record's presentation equal the
 * compatibility presentation. The patch only touches presentation keys: stale
 * keys are deleted with null, operational members of the record are preserved.
 */
export function planCanonicalRepublish(inspection: LinkedUserMetadataInspection, destination: RowndMetadata): JsonRecord {
  validateOwner(inspection, destination);
  const presentation = structuredClone(getCanonicalPresentationMetadata(inspection.combinedMetadata));
  const patch: JsonRecord = {};
  for (const [key, value] of Object.entries(presentation)) {
    // Core deletes a key written as null, so a literal null survives only if already stored.
    if (value === null) {
      if (destination[key] !== null) refuse("unrepresentable-top-level-null");
    } else patch[key] = value;
  }
  for (const key of Object.keys(getCanonicalPresentationMetadata(destination))) {
    if (!own(presentation, key)) patch[key] = null;
  }
  const existingOriginal = destination.original_rownd_user;
  if (existingOriginal !== undefined) {
    const projectedOriginal = getCanonicalPresentationMetadata(destination).original_rownd_user!;
    const desiredOriginal = presentation.original_rownd_user;
    if (desiredOriginal !== undefined && isDeepStrictEqual(projectedOriginal, desiredOriginal)) {
      // Literal meta/security members stay available to operational validators.
      delete patch.original_rownd_user;
    } else if (Object.keys(existingOriginal).some((key) => !own(projectedOriginal, key))) {
      const source = inspection.rowndMetadataSourceMetadata?.original_rownd_user;
      if (desiredOriginal === undefined || source === undefined ||
        inspection.rowndMetadataSourceUserId !== inspection.user!.id || !isDeepStrictEqual(source, existingOriginal) ||
        desiredOriginal.data.user_id !== existingOriginal.data.user_id) refuse("existing-original-operational-conflict");
      patch.original_rownd_user = { ...structuredClone(existingOriginal), ...desiredOriginal } as JsonRecord;
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (isCanonicalReservedMetadataKey(key)) refuse("reserved-metadata-collision");
    if (value === null ? !own(destination, key) : isDeepStrictEqual(destination[key], value)) delete patch[key];
  }
  return patch;
}

function applyPatch(metadata: RowndMetadata, patch: JsonRecord): RowndMetadata {
  const next = structuredClone(metadata);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = structuredClone(value);
  }
  return next;
}

/** Everything a client observes from presentation metadata: profiles, claims and email selection. */
export function projectPresentation(user: SuperTokensUser, metadata: RowndMetadata, config: RowndPluginNormalisedConfig,
  mode: "compatibility" | "canonical") {
  const scoped = { ...config, metadataMode: mode };
  return {
    profiles: Object.fromEntries(user.tenantIds.map((tenantId) => [tenantId,
      assembleUserProfile(user.id, tenantId, user, metadata, scoped, "profile")])),
    configuredClaims: buildConfiguredSessionClaims(metadata, scoped),
    sessionClaims: buildRowndSessionClaimPayload({ userId: user.id, user, metadata, pluginConfig: scoped }),
    standardOAuthClaims: buildStandardOAuthClaims(user, ["email", "phone", "profile"], metadata, scoped),
    emails: Object.fromEntries(user.tenantIds.map((tenantId) => [tenantId,
      resolveCanonicalEmailForTenant({ user, metadata, tenantId })])),
  };
}

function recordingReader() {
  const reads = new Map<string, unknown>();
  const key = (kind: string, id: string) => JSON.stringify([kind, id]);
  const record: ProfileReader = async (kind, id, load) => {
    const value = await load();
    reads.set(key(kind, id), value);
    return value;
  };
  // Replays the recorded owner graph with one record replaced, without Core reads.
  const replay = (replacedUserId: string, replacement: RowndMetadata): ProfileReader => async <T>(kind: string, id: string) => {
    if (kind === "metadata" && id === replacedUserId) return replacement as T;
    if (!reads.has(key(kind, id))) refuse("unobserved-owner-graph");
    return structuredClone(reads.get(key(kind, id))) as T;
  };
  return { record, replay };
}

/**
 * Republishes one owner's compatibility presentation onto the SDK-visible record
 * that canonical mode reads. Reads are fresh; the write is a minimal top-level patch.
 */
export async function republishCanonicalPresentation(input: {
  userId: string;
  userContext: Record<string, any>;
  config?: RowndPluginNormalisedConfig;
}): Promise<CanonicalRepublishResult> {
  const config = input.config ?? getConfigForUserContext(input.userContext) ?? getPluginConfig();
  if (!config) throw new Error("Rownd plugin config is not initialized");
  clearSuperTokensCoreCallCache(input.userContext);
  invalidateReconciliationReads();
  const reader = recordingReader();
  try {
    const user = await SuperTokens.getUser(input.userId, input.userContext);
    if (!user) refuse("owner-not-found");
    const inspection = await inspectLinkedUserMetadata(user.id, input.userContext, user, reader.record);
    const recorded = [{ userId: inspection.primaryUserId, metadata: inspection.primaryMetadata }, ...inspection.linkedMetadata]
      .find(({ userId }) => userId === user.id)?.metadata;
    const destination = recorded ?? await reader.record("metadata", user.id, () => getRawUserMetadata(user.id, input.userContext));
    const patch = planCanonicalRepublish(inspection, destination);
    const expectedDestination = applyPatch(destination, patch);
    const expected = await inspectLinkedUserMetadata(user.id, {}, user, reader.replay(user.id, expectedDestination));
    validateOwner(expected, expectedDestination);
    const compatibility = projectPresentation(user, inspection.combinedMetadata, config, "compatibility");
    if (!isDeepStrictEqual(projectPresentation(user, expected.combinedMetadata, config, "compatibility"), compatibility)) {
      refuse("compatibility-drift");
    }
    if (!isDeepStrictEqual(projectPresentation(user, expectedDestination, config, "canonical"), compatibility)) {
      refuse("projection-mismatch");
    }
    if (Object.keys(patch).length === 0) return { status: "UNCHANGED" };
    await UserMetadata.updateUserMetadata(user.id, patch as JSONObject, input.userContext);
    return { status: "PUBLISHED", keys: Object.keys(patch).sort() };
  } catch (error) {
    if (error instanceof CanonicalRepublishRefusal) return { status: "SKIPPED", reason: error.reason };
    throw error;
  }
}

/**
 * Dual-write convergence after migration writes. The migration outcome is already
 * committed in Core and compatibility reads stay authoritative until the switch,
 * so a refusal or failure here is logged and never fails the caller; the final
 * pre-switch check republishes or reports every owner that did not converge.
 */
export async function republishAfterMigration(input: {
  userId: string;
  userContext: Record<string, any>;
  config?: RowndPluginNormalisedConfig;
  telemetry?: MigrationTelemetry;
}): Promise<CanonicalRepublishResult | { status: "FAILED" } | undefined> {
  if (!isDualWriteMetadataMode(input.config ?? getPluginConfig())) return undefined;
  if (input.telemetry) input.telemetry.stage = "canonical_republish";
  try {
    const result = await republishCanonicalPresentation(input);
    if (result.status === "SKIPPED") {
      console.warn(`RowndMigrationPlugin: dual-write canonical republish skipped (${result.reason}); owner is left for the final canonical check.`);
      input.telemetry?.emit("transition", `canonical_republish_skipped:${result.reason}`, "skipped");
    } else if (result.status === "PUBLISHED") {
      input.telemetry?.emit("transition", "canonical_republish_published");
    }
    return result;
  } catch (error) {
    // Error messages can carry Core identifiers; log only the error class.
    console.warn(`RowndMigrationPlugin: dual-write canonical republish failed (${error instanceof Error ? error.name : "unknown"}); owner is left for the final canonical check.`);
    input.telemetry?.emit("transition", "canonical_republish_failed", "error",
      new Error(`Canonical republish failed (${error instanceof Error ? error.name : "unknown"})`));
    return { status: "FAILED" };
  }
}
