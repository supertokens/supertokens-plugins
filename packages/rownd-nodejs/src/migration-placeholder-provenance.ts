import { isDeepStrictEqual } from "node:util";
import { reconciliationUserMetadata as UserMetadata } from "./reconciliation-sdk";
import { RowndMigrationPolicyError } from "./errors";
import { assertAuthenticatedMigrationSource } from "./migration-email";
import { assertMigrationMapping } from "./migration-mapping";
import { getRawUserMetadata, mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { isRecord, type JsonRecord } from "./utils";
import type { RowndUser, SuperTokensUserImport } from "./types";

const auditKey = "rownd_migration_placeholder_provenance_override";
type OverrideAudit = {
  version: 1; sourceId: string; target: string; tenantId: string; recordedAt: string;
  original_rownd_user: RowndUser; completedAt?: string;
};

export function isInternalIdPlaceholder(profile: RowndUser | undefined, internalId: string, tenantId: string) {
  if (!profile || profile.data.user_id !== internalId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(internalId)) return false;
  const methods = mapRowndUserToSuperTokens(profile, tenantId).loginMethods;
  return methods.length === 1 && methods[0]!.recipeId === "thirdparty" &&
    methods[0]!.thirdPartyId === "instant" && methods[0]!.thirdPartyUserId === internalId;
}

export async function inspectPlaceholderProvenanceOverride(id: string, source: SuperTokensUserImport, tenantId: string, userContext: JsonRecord) {
  const metadata = await getRawUserMetadata(id, userContext);
  const placeholder = isInternalIdPlaceholder(metadata.original_rownd_user, id, tenantId);
  const existing = metadata[auditKey];
  if (existing !== undefined) {
    if (!isRecord(existing) || existing.version !== 1 || existing.sourceId !== source.externalUserId || existing.target !== id ||
        existing.tenantId !== tenantId || typeof existing.recordedAt !== "string" ||
        (existing.completedAt !== undefined && typeof existing.completedAt !== "string") ||
        !isRecord(existing.original_rownd_user) || !isRecord(existing.original_rownd_user.data) ||
        !isInternalIdPlaceholder(existing.original_rownd_user as unknown as RowndUser, id, tenantId) ||
        (placeholder && !isDeepStrictEqual(existing.original_rownd_user, metadata.original_rownd_user)) ||
        (existing.completedAt === undefined && ![id, source.externalUserId].includes(metadata.original_rownd_user?.data.user_id))) {
      throw new RowndMigrationPolicyError("Placeholder provenance override evidence changed");
    }
  }
  return { metadata, placeholder, audit: existing as OverrideAudit | undefined };
}

export async function archivePlaceholderProvenance(id: string, source: SuperTokensUserImport, tenantId: string, userContext: JsonRecord) {
  const { metadata, placeholder, audit } = await inspectPlaceholderProvenanceOverride(id, source, tenantId, userContext);
  if (!placeholder || audit) return;
  await UserMetadata.updateUserMetadata(id, { [auditKey]: {
    version: 1, sourceId: source.externalUserId, target: id, tenantId, recordedAt: new Date().toISOString(),
    original_rownd_user: metadata.original_rownd_user,
  } }, userContext);
}

export async function completePlaceholderProvenanceOverride(id: string, source: SuperTokensUserImport, tenantId: string, userContext: JsonRecord) {
  const { audit } = await inspectPlaceholderProvenanceOverride(id, source, tenantId, userContext);
  if (!audit || audit.completedAt !== undefined) return;
  const profile = await assertAuthenticatedMigrationSource(source, tenantId);
  if (!profile) throw new RowndMigrationPolicyError("Placeholder provenance override requires a live administrative source");
  await assertMigrationMapping(id, source.externalUserId!, userContext);
  await UserMetadata.updateUserMetadata(id, {
    original_rownd_user: profile, [auditKey]: { ...audit, completedAt: new Date().toISOString() },
  }, userContext);
}
