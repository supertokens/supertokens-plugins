import { reconciliationSuperTokens as SuperTokens } from "./reconciliation-sdk";
import { combineLinkedMetadata, getRawUserMetadata } from "./rownd-compatibility";
import { getCanonicalEmailRecipeUserId, getMigrationImportMethods, getPendingVerifications } from "./supertokens-repository";
import type { SuperTokensUserImport } from "./types";
import { inspectCurrentRowndEmailReconciliation } from "./migration-email";
import {
  inspectProviderMigrationCheckpoints,
  readRetirements,
  selectRowndProviderRetirements,
} from "./migration-provider";
import { isRecord, type JsonRecord } from "./utils";

type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type Mapping = Awaited<ReturnType<typeof SuperTokens.getUserIdMapping>>;
export type MigrationIdDiscovery = {
  sourceId: string;
  tenantId: string;
  user?: User;
  mapping: Mapping;
  reverse?: Mapping;
  metadata: JsonRecord[];
  metadataById: ReadonlyMap<string, JsonRecord>;
  pendingProviderOperations?: boolean;
};
export type MigrationPlan =
  | { status: "NOOP"; user: User; internalUserId: string; recipeUserId: string }
  | { status: "PLAN"; action: { kind: "reconcile"; repairUser?: User } }
  | { status: "BLOCKED"; reason: string };

function pending(
  metadata: JsonRecord,
  tenantId: string,
  sourceId: string,
  target: string,
) {
  for (const key of [
    "rownd_migration_mapping_publication",
    "rownd_migration_provider_introduction",
    "rownd_migration_owner_recovery",
  ]) {
    if (metadata[key] !== undefined && metadata[key] !== null) return true;
  }
  for (const key of ["rownd_migration_provider_introductions"]) {
    const value = metadata[key];
    if (
      value !== undefined &&
      value !== null &&
      (!Array.isArray(value) || value.length > 0)
    )
      return true;
  }
  const consolidation = metadata.rownd_migration_owner_consolidation;
  if (
    consolidation !== undefined &&
    (!isRecord(consolidation) || consolidation.status !== "COMPLETE")
  )
    return true;
  const reconciliation = metadata.rownd_migration_reconciliation;
  if (
    reconciliation !== undefined &&
    (!isRecord(reconciliation) ||
      reconciliation.rowndUserId !== sourceId ||
      reconciliation.targetUserId !== target)
  )
    return true;
  const emailRetirements = metadata.rownd_migration_email_retirements;
  if (
    emailRetirements !== undefined &&
    (!isRecord(emailRetirements) || emailRetirements[tenantId] !== undefined)
  )
    return true;
  const verifications = metadata.rownd_pending_verification;
  if (
    verifications !== undefined &&
    (!Array.isArray(verifications) ||
      verifications.some(
        (entry) =>
          !isRecord(entry) ||
          ((entry.tenantId ?? "public") === tenantId &&
            entry.status === "COMMITTING"),
      ))
  )
    return true;
  return false;
}

export function hasPendingMigrationById(input: MigrationIdDiscovery): boolean {
  const target = input.mapping.status === "OK" ? input.mapping.superTokensUserId : input.sourceId;
  for (const metadata of input.metadata) readRetirements(metadata.rownd_migration_provider_retirements);
  return input.pendingProviderOperations === true || input.metadata.some((metadata) =>
    pending(metadata, input.tenantId, input.sourceId, target));
}

// This stage only follows IDs. Contact and exact provider-subject discovery is
// deferred to reconciliation when the completed mapping cannot satisfy login.
export async function discoverMigrationById(
  sourceId: string,
  tenantId: string,
  context: JsonRecord,
): Promise<MigrationIdDiscovery> {
  const mapping = await SuperTokens.getUserIdMapping({
    userId: sourceId,
    userIdType: "EXTERNAL",
    userContext: context,
  });
  const [user, reverse] = await Promise.all([SuperTokens.getUser(
    mapping.status === "OK" ? mapping.superTokensUserId : sourceId,
    context,
  ),
  mapping.status === "OK"
    ? SuperTokens.getUserIdMapping({
      userId: mapping.superTokensUserId,
      userIdType: "SUPERTOKENS",
      userContext: context,
    })
    : undefined]);
  const ids = new Set([
    ...(mapping.status === "OK" ? [mapping.superTokensUserId] : []),
    sourceId,
    ...(user
      ? [
        user.id,
        ...user.loginMethods.map((method) =>
          method.recipeUserId.getAsString(),
        ),
      ]
      : []),
  ]);
  const metadata: JsonRecord[] = [];
  const uniqueIds = [...ids];
  for (let index = 0; index < uniqueIds.length; index += 16) {
    metadata.push(...await Promise.all(uniqueIds.slice(index, index + 16).map((id) => getRawUserMetadata(id, context))));
  }
  const metadataById = new Map([...ids].map((id, index) => [id, metadata[index]!]));
  const pendingProviderOperations =
    mapping.status === "OK" && user && [sourceId, mapping.superTokensUserId].includes(user.id)
      ? await inspectProviderMigrationCheckpoints(
        mapping.superTokensUserId,
        sourceId,
        tenantId,
        context,
        { user, metadataById },
      )
      : false;
  return {
    sourceId,
    tenantId,
    user,
    mapping,
    reverse,
    metadata,
    metadataById,
    pendingProviderOperations,
  };
}

export function planMigration(input: MigrationIdDiscovery, source: SuperTokensUserImport): MigrationPlan {
  const { sourceId, tenantId, user, mapping, reverse, metadata } = input;
  try {
    for (const entry of metadata)
      readRetirements(entry.rownd_migration_provider_retirements);
  } catch (error) {
    return {
      status: "BLOCKED",
      reason:
        error instanceof Error
          ? error.message
          : "Invalid provider retirement history",
    };
  }
  if (mapping.status === "OK") {
    if (!user)
      return {
        status: "BLOCKED",
        reason: "MAPPING_TARGET_MISSING: reconciliation target does not exist",
      };
    if (
      reverse?.status !== "OK" ||
      reverse.superTokensUserId !== mapping.superTokensUserId ||
      reverse.externalUserId !== sourceId ||
      mapping.externalUserId !== sourceId
    ) {
      return {
        status: "BLOCKED",
        reason:
          "The authenticated Rownd mapping has conflicting reverse ownership",
      };
    }
    const method = user.loginMethods.find((method) =>
      method.tenantIds.includes(tenantId),
    );
    // Only the immutable owner and its authenticated alias can establish completion.
    const complete =
      [input.metadataById.get(mapping.superTokensUserId), input.metadataById.get(sourceId)]
        .filter((entry): entry is JsonRecord => entry !== undefined)
        .find((entry) => entry.rownd_migration_complete !== undefined)
        ?.rownd_migration_complete === true;
    if (
      [sourceId, mapping.superTokensUserId].includes(user.id) &&
      method &&
      complete &&
      !input.pendingProviderOperations &&
      !needsMethodRepair(input, source, mapping.superTokensUserId) &&
      !metadata.some((entry) =>
        pending(entry, tenantId, sourceId, mapping.superTokensUserId),
      )
    ) {
      return {
        status: "NOOP",
        user,
        internalUserId: mapping.superTokensUserId,
        recipeUserId: method.recipeUserId.getAsString(),
      };
    }
  }
  return {
    status: "PLAN",
    action: { kind: "reconcile", ...(user ? { repairUser: user } : {}) },
  };
}

function needsMethodRepair(input: MigrationIdDiscovery, source: SuperTokensUserImport, internalUserId: string) {
  const metadata = combineLinkedMetadata({
    primaryUserId: internalUserId,
    primaryMetadata: input.metadataById.get(internalUserId) ?? {},
    linkedMetadata: [...input.metadataById].filter(([id]) => id !== internalUserId)
      .map(([userId, metadata]) => ({ userId, metadata })),
    canonicalRowndUserId: input.sourceId,
  }).combinedMetadata;
  const canonical = getCanonicalEmailRecipeUserId(metadata, input.tenantId);
  const pendingEmail = getPendingVerifications(metadata).some((entry) => entry.field === "email" &&
    (entry.tenantId ?? "public") === input.tenantId);
  if (getMigrationImportMethods(source, input.tenantId, input.user, canonical, pendingEmail).length) return true;
  if (input.user && selectRowndProviderRetirements(source, input.user, metadata)
    .some((entry) => entry.tenantIds.includes(input.tenantId))) return true;
  if (!canonical && !pendingEmail && input.user) {
    try {
      return inspectCurrentRowndEmailReconciliation(source, input.user, metadata, input.tenantId) !== undefined;
    } catch {
      // Let the repair path report incompatible source/history without publishing a session.
      return true;
    }
  }
  return false;
}
