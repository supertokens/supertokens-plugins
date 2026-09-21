import {
  reconciliationSuperTokens as SuperTokens,
  reconciliationUserMetadata as UserMetadata,
} from "./reconciliation-sdk";
import { RowndMigrationPolicyError } from "./errors";
import {
  assertAuthenticatedMigrationSource,
  isAdministrativeMigration,
} from "./migration-email";
import {
  assertMigrationMapping,
  assertSelectorNamespace,
} from "./migration-mapping";
import { assertMigrationOwnerGraph } from "./migration-postconditions";
import {
  buildRowndUserMetadata,
  getRawUserMetadata,
  inspectLinkedUserMetadata,
  isInternalMetadataField,
} from "./rownd-compatibility";
import { clearSuperTokensCoreCallCache, type JsonRecord } from "./utils";
import type { SuperTokensUserImport } from "./types";
import { invalidateReconciliationReads } from "./reconciliation-reads";

type MetadataBackfillInput = {
  source: SuperTokensUserImport;
  tenantId: string;
  internalUserId: string;
  userContext: JsonRecord;
};

export async function inspectAdministrativeMetadataBackfill(
  input: MetadataBackfillInput,
): Promise<JsonRecord> {
  const { source, tenantId, internalUserId, userContext } = input;
  if (!isAdministrativeMigration(source, tenantId)) return {};
  const profile = await assertAuthenticatedMigrationSource(source, tenantId);
  if (!profile)
    throw new RowndMigrationPolicyError(
      "Metadata backfill requires a privately authenticated source",
    );
  clearSuperTokensCoreCallCache(userContext);
  await assertSelectorNamespace(internalUserId, userContext);
  const inspection = await inspectLinkedUserMetadata(
    internalUserId,
    userContext,
  );
  if (!inspection.user || inspection.primaryUserId !== internalUserId)
    throw new RowndMigrationPolicyError(
      "Metadata backfill target is not the immutable owner",
    );
  await assertMigrationOwnerGraph(inspection.user, tenantId, userContext);
  const occupied = new Set([
    ...Object.keys(inspection.primaryMetadata),
    ...Object.keys(inspection.combinedMetadata),
  ]);
  // The SDK externalizes linked recipe IDs. Also check their immutable storage
  // so an alias cannot hide an existing custom value from the combined view.
  for (const method of inspection.user.loginMethods) {
    const mapping = await SuperTokens.getUserIdMapping({
      userId: method.recipeUserId.getAsString(),
      userIdType: "EXTERNAL",
      userContext,
    });
    if (
      mapping.status === "OK" &&
      mapping.superTokensUserId !== internalUserId
    ) {
      for (const field of Object.keys(
        await getRawUserMetadata(mapping.superTokensUserId, userContext),
      ))
        occupied.add(field);
    }
  }
  // Keep the primary read closest to the minimal write; existing top-level
  // values, including null and opaque objects, always take precedence.
  const latestPrimary = await getRawUserMetadata(internalUserId, userContext);
  for (const field of Object.keys(latestPrimary)) occupied.add(field);
  // Core's patch API treats null as deletion; an absent null needs no addition.
  const mapped = buildRowndUserMetadata(profile);
  const patch = Object.fromEntries(
    Object.entries(mapped).filter(
      ([field, value]) =>
        !isInternalMetadataField(field) &&
        value !== undefined &&
        value !== null &&
        !occupied.has(field),
    ),
  );
  // Snapshot provenance comes only from the validated by-ID profile, never its
  // custom app fields. A completion flag alone does not supply this snapshot.
  if (
    latestPrimary.original_rownd_user === undefined &&
    inspection.combinedMetadata.original_rownd_user === undefined
  ) {
    patch.original_rownd_user = mapped.original_rownd_user;
  }
  return patch;
}

export async function assertAdministrativeMetadataBackfilled(
  input: MetadataBackfillInput,
): Promise<void> {
  if (Object.keys(await inspectAdministrativeMetadataBackfill(input)).length) {
    throw new RowndMigrationPolicyError(
      "Administrative metadata backfill is incomplete",
    );
  }
}

export async function backfillAdministrativeMetadata(
  input: MetadataBackfillInput,
): Promise<boolean> {
  if (!Object.keys(await inspectAdministrativeMetadataBackfill(input)).length)
    return false;
  const patch = await inspectAdministrativeMetadataBackfill(input);
  if (!Object.keys(patch).length) return false;
  await assertMigrationMapping(
    input.internalUserId,
    input.source.externalUserId!,
    input.userContext,
  );
  await UserMetadata.updateUserMetadata(
    input.internalUserId,
    patch,
    input.userContext,
  );
  await assertMigrationMapping(
    input.internalUserId,
    input.source.externalUserId!,
    input.userContext,
  );
  await assertAdministrativeMetadataBackfilled(input);
  return true;
}

export async function inspectPublicMetadataPublication(input: MetadataBackfillInput): Promise<JsonRecord> {
  const { source, tenantId, internalUserId, userContext } = input;
  if (!isAdministrativeMigration(source, tenantId) || source.externalUserId === internalUserId) return {};
  const profile = await assertAuthenticatedMigrationSource(source, tenantId);
  if (!profile) throw new RowndMigrationPolicyError("Metadata backfill requires a privately authenticated source");
  const inspection = await inspectLinkedUserMetadata(internalUserId, userContext);
  if (!inspection.user || inspection.primaryUserId !== internalUserId) {
    throw new RowndMigrationPolicyError("Metadata backfill target is not the immutable owner");
  }
  // Core reads metadata by literal ID even though user APIs return external IDs.
  // Publish application fields there; migration checkpoints retain one owner.
  const available = {
    ...buildRowndUserMetadata(profile),
    ...inspection.combinedMetadata,
    ...inspection.primaryMetadata,
  };
  const published = await getRawUserMetadata(source.externalUserId!, userContext);
  return Object.fromEntries(Object.entries(available).filter(([field, value]) =>
    !isInternalMetadataField(field) && value !== undefined && value !== null &&
    !Object.prototype.hasOwnProperty.call(published, field)));
}

export async function assertPublicMetadataPublished(input: MetadataBackfillInput): Promise<void> {
  if (Object.keys(await inspectPublicMetadataPublication(input)).length) {
    throw new RowndMigrationPolicyError("Public user metadata publication is incomplete");
  }
}

export async function publishPublicMetadata(input: MetadataBackfillInput): Promise<void> {
  invalidateReconciliationReads("metadata", input.internalUserId);
  invalidateReconciliationReads("metadata", input.source.externalUserId!);
  if (!Object.keys(await inspectPublicMetadataPublication(input)).length) return;
  await assertMigrationMapping(input.internalUserId, input.source.externalUserId!, input.userContext);
  invalidateReconciliationReads("metadata", input.source.externalUserId!);
  const patch = await inspectPublicMetadataPublication(input);
  if (!Object.keys(patch).length) return;
  await assertMigrationMapping(input.internalUserId, input.source.externalUserId!, input.userContext);
  await UserMetadata.updateUserMetadata(input.source.externalUserId!, patch, input.userContext);
  await assertMigrationMapping(input.internalUserId, input.source.externalUserId!, input.userContext);
  await assertPublicMetadataPublished(input);
}
