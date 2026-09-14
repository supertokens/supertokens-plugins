import { reconciliationSuperTokens as SuperTokens } from "./reconciliation-sdk";
import { getRawUserMetadata } from "./rownd-compatibility";
import {
  inspectProviderMigrationCheckpoints,
  readRetirements,
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
  const user = await SuperTokens.getUser(
    mapping.status === "OK" ? mapping.superTokensUserId : sourceId,
    context,
  );
  const reverse =
    mapping.status === "OK"
      ? await SuperTokens.getUserIdMapping({
          userId: mapping.superTokensUserId,
          userIdType: "SUPERTOKENS",
          userContext: context,
        })
      : undefined;
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
  const metadata = await Promise.all(
    [...ids].map((id) => getRawUserMetadata(id, context)),
  );
  const pendingProviderOperations =
    mapping.status === "OK" && user?.id === sourceId
      ? await inspectProviderMigrationCheckpoints(
          mapping.superTokensUserId,
          sourceId,
          tenantId,
          context,
        )
      : false;
  return {
    sourceId,
    tenantId,
    user,
    mapping,
    reverse,
    metadata,
    pendingProviderOperations,
  };
}

export function planMigration(input: MigrationIdDiscovery): MigrationPlan {
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
      metadata
        .slice(0, sourceId === mapping.superTokensUserId ? 1 : 2)
        .find((entry) => entry.rownd_migration_complete !== undefined)
        ?.rownd_migration_complete === true;
    if (
      [sourceId, mapping.superTokensUserId].includes(user.id) &&
      method &&
      complete &&
      !input.pendingProviderOperations &&
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
