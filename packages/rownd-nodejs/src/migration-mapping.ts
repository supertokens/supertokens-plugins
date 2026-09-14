import SuperTokens from "supertokens-node";
import { RowndMigrationPolicyError } from "./errors";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import {
  getRawUserMetadata,
  isInternalMetadataField,
  mapRowndUserToSuperTokens,
  mergeMissingValues,
} from "./rownd-compatibility";
import { fetchOptionalRowndUserInfo } from "./rownd-repository";
import { migrationTelemetry } from "./telemetry/migrationTelemetry";
import { assertAuthenticatedMigrationSource, getMigrationContactEmail, isAdministrativeMigration, isRowndMigrationProfileActive } from "./migration-email";
import { assertAdministrativeDuplicateWinner, isAdministrativeElectionCandidate } from "./migration-election";
import type { SuperTokensUserImport } from "./types";
import {
  clearSuperTokensCoreCallCache,
  isRecord,
  type JsonRecord,
} from "./utils";

export function getMigrationTarget(metadata: JsonRecord) {
  // Only session publication writes the canonical field. Retirement workers may
  // overwrite a provisional target, but cannot change a published target.
  const target = metadata.rownd_migration_canonical_target ?? metadata.rownd_migration_target;
  if (target !== undefined && typeof target !== "string") {
    throw new RowndMigrationPolicyError("Invalid migration target record");
  }
  return target;
}

async function hasCanonicalMapping(
  rowndUserId: string,
  metadata: JsonRecord,
  userContext: JsonRecord,
) {
  const target = getMigrationTarget(metadata);
  if (target === undefined) return false;
  clearSuperTokensCoreCallCache(userContext);
  const [external, internal] = await Promise.all([
    SuperTokens.getUserIdMapping({ userId: rowndUserId, userIdType: "EXTERNAL", userContext }),
    SuperTokens.getUserIdMapping({ userId: target, userIdType: "SUPERTOKENS", userContext }),
  ]);
  if (external.status === "OK" && internal.status === "OK") {
    return external.superTokensUserId === target && external.externalUserId === rowndUserId &&
      internal.superTokensUserId === target && internal.externalUserId === rowndUserId;
  }
  if (target === rowndUserId && external.status !== "OK" && internal.status !== "OK") {
    return (await SuperTokens.getUser(target, userContext))?.id === rowndUserId;
  }
  return false;
}

export async function isProtectedDuplicateMapping(input: {
  source: SuperTokensUserImport; duplicateId: string; ownerInternalId: string; targetInternalId: string; tenantId: string; userContext: JsonRecord;
}) {
  const { source, duplicateId, ownerInternalId, targetInternalId, tenantId, userContext } = input;
  const metadata = await getRawUserMetadata(duplicateId, userContext);
  const canonical = await hasCanonicalMapping(duplicateId, metadata, userContext);
  if (!isAdministrativeMigration(source, tenantId)) return canonical;
  const stored = await getRawUserMetadata(ownerInternalId, userContext);
  if ([metadata, stored].some((record) => [record.rownd_migration_canonical_target, record.rownd_migration_target]
    .some((target) => target !== undefined && target !== ownerInternalId))) {
    throw new RowndMigrationPolicyError("Duplicate mapping changed before retirement");
  }
  if (!canonical || !isAdministrativeElectionCandidate(source, duplicateId)) return canonical;
  await assertAdministrativeDuplicateWinner(source, tenantId, duplicateId);
  clearSuperTokensCoreCallCache(userContext);
  const winnerMapping = await SuperTokens.getUserIdMapping({ userId: source.externalUserId!, userIdType: "EXTERNAL", userContext });
  const winnerTarget = getMigrationTarget(await getRawUserMetadata(source.externalUserId!, userContext));
  if ((winnerMapping.status === "OK" && winnerMapping.superTokensUserId !== targetInternalId) ||
    (winnerTarget !== undefined && winnerTarget !== targetInternalId)) throw new RowndMigrationPolicyError("The reconciliation target changed");
  const owner = await SuperTokens.getUser(ownerInternalId, userContext);
  if (!owner || owner.isPrimaryUser || owner.loginMethods.length !== 1 ||
    owner.loginMethods[0]!.tenantIds.length !== 1 || !owner.loginMethods[0]!.tenantIds.includes(tenantId)) return true;
  const method = owner.loginMethods[0]!;
  const duplicate = await fetchOptionalRowndUserInfo(duplicateId);
  const email = getMigrationContactEmail(source, tenantId);
  const contact = method.recipeId === "passwordless" && email !== undefined && method.hasSameEmailAs(email) &&
    duplicate?.data.email?.toLowerCase() === email;
  const provider = method.recipeId === "thirdparty" && duplicate &&
    source.loginMethods.some((expected) => expected.recipeId === "thirdparty" && ["google", "apple"].includes(expected.thirdPartyId) &&
      method.hasSameThirdPartyInfoAs({ id: expected.thirdPartyId, userId: expected.thirdPartyUserId }) &&
      mapRowndUserToSuperTokens(duplicate, tenantId).loginMethods.some((other) => other.recipeId === "thirdparty" &&
        other.thirdPartyId === expected.thirdPartyId && other.thirdPartyUserId === expected.thirdPartyUserId));
  if (!contact && !provider) return true;
  await assertMigrationMapping(ownerInternalId, duplicateId, userContext);
  // Published ownership is replaceable only by this live, privately bound admin
  // election. Token migrations retain the first-published-owner protection.
  await assertAdministrativeDuplicateWinner(source, tenantId, duplicateId);
  return false;
}

export async function assertMigrationSourceActive(
  rowndUserId: string,
  userContext: JsonRecord,
) {
  clearSuperTokensCoreCallCache(userContext);
  const metadata = await getRawUserMetadata(rowndUserId, userContext);
  if (metadata.rownd_migration_superseded !== undefined) {
    // Retirement and reservation writes are provisional. A stale losing worker
    // cannot invalidate the elected owner of the current bidirectional mapping.
    // Keep the tombstone: it must reject this ID if its mapping was actually retired.
    if (await hasCanonicalMapping(rowndUserId, metadata, userContext)) return metadata;
    const marker = metadata.rownd_migration_superseded;
    const telemetry = migrationTelemetry(userContext);
    if (telemetry && isRecord(marker)) {
      telemetry.conflictingRowndUserId = rowndUserId;
      if (typeof marker.rowndUserId === "string")
        telemetry.canonicalRowndUserId = marker.rowndUserId;
      if (typeof marker.targetUserId === "string") {
        const electedMapping = await SuperTokens.getUserIdMapping({
          userId: marker.targetUserId,
          userIdType: "SUPERTOKENS",
          userContext,
        });
        if (electedMapping.status === "OK")
          telemetry.canonicalRowndUserId = electedMapping.externalUserId;
      }
    }
    throw new RowndMigrationPolicyError("The requested Rownd user has been superseded");
  }
  return metadata;
}

export async function assertSelectorNamespace(id: string, userContext: JsonRecord) {
  const [external, internal] = await Promise.all([
    SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext }),
    SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext }),
  ]);
  if (external.status === "OK" && internal.status === "OK" && external.superTokensUserId !== internal.superTokensUserId) {
    throw new RowndMigrationPolicyError("EXTERNAL_ALIAS_AMBIGUOUS: selector identifies different internal and external owners");
  }
  if (external.status === "OK" && !await SuperTokens.getUser(external.superTokensUserId, userContext)) {
    throw new RowndMigrationPolicyError("MAPPING_TARGET_MISSING: external mapping target does not exist");
  }
}

export async function assertMigrationMapping(
  internalUserId: string,
  rowndUserId: string,
  userContext: JsonRecord,
) {
  const metadata = await assertMigrationSourceActive(rowndUserId, userContext);
  if (
    metadata.rownd_migration_canonical_target !== undefined &&
    metadata.rownd_migration_canonical_target !== internalUserId
  ) {
    throw new RowndMigrationPolicyError("The canonical reconciliation target changed");
  }
  const [external, internal] = await Promise.all([
    SuperTokens.getUserIdMapping({
      userId: rowndUserId,
      userIdType: "EXTERNAL",
      userContext,
    }),
    SuperTokens.getUserIdMapping({
      userId: internalUserId,
      userIdType: "SUPERTOKENS",
      userContext,
    }),
  ]);
  if (
    internalUserId === rowndUserId &&
    external.status !== "OK" &&
    internal.status !== "OK"
  )
    return;
  if (
    external.status !== "OK" ||
    internal.status !== "OK" ||
    external.superTokensUserId !== internalUserId ||
    internal.externalUserId !== rowndUserId
  ) {
    throw new RowndMigrationPolicyError("Migrated user mapping postcondition failed");
  }
}

// Metadata is stored under the literal ID supplied to Core. External-ID retirement
// records therefore survive mapping deletion; account metadata stays on internal IDs.
export async function retireDuplicateMapping(input: {
  source: SuperTokensUserImport;
  ownerInternalId: string;
  targetInternalId: string;
  tenantId: string;
  userContext: JsonRecord;
}) {
  const { source, ownerInternalId, targetInternalId, tenantId, userContext } =
    input;
  const requestedId = source.externalUserId!;
  const requestedMetadata = await assertMigrationSourceActive(
    requestedId,
    userContext,
  );
  if (
    requestedMetadata.rownd_migration_canonical_target !== undefined &&
    requestedMetadata.rownd_migration_canonical_target !== targetInternalId
  ) {
    throw new RowndMigrationPolicyError(
      "The requested Rownd user has a different reconciliation target",
    );
  }
  const mapping = await SuperTokens.getUserIdMapping({
    userId: ownerInternalId,
    userIdType: "SUPERTOKENS",
    userContext,
  });
  const ownerMetadata = await getRawUserMetadata(ownerInternalId, userContext);
  const plan = ownerMetadata.rownd_migration_reconciliation;
  if (mapping.status === "OK" && mapping.externalUserId === requestedId) {
    if (ownerInternalId !== targetInternalId) {
      throw new RowndMigrationPolicyError("The requested Rownd mapping has a different target");
    }
    await assertMigrationMapping(ownerInternalId, requestedId, userContext);
    return;
  }
  if (
    plan !== undefined &&
    (!isRecord(plan) ||
      typeof plan.rowndUserId !== "string" ||
      typeof plan.targetUserId !== "string" ||
      typeof plan.previousExternalUserId !== "string")
  ) {
    throw new RowndMigrationPolicyError("The login method has an invalid reconciliation record");
  }
  if (mapping.status !== "OK" && !isRecord(plan)) return;
  // A competing reservation is not ownership. If the old mapping is gone, its
  // persisted ID is only a hint: verify the source, duplicate if present, and provider again.
  const previousExternalId = isRecord(plan) && typeof plan.previousExternalUserId === "string"
    ? plan.previousExternalUserId : undefined;
  const duplicateId = mapping.status === "OK" ? mapping.externalUserId : previousExternalId;
  if (duplicateId === undefined) return;
  if (duplicateId === requestedId) {
    throw new RowndMigrationPolicyError("A retired Rownd mapping cannot authorize its own replacement");
  }
  const telemetry = migrationTelemetry(userContext);
  if (telemetry) {
    telemetry.canonicalRowndUserId = requestedId;
    telemetry.conflictingRowndUserId = duplicateId;
  }
  const duplicateMetadata = await getRawUserMetadata(duplicateId, userContext);
  const protectedDuplicate = () => isProtectedDuplicateMapping({ source, duplicateId, ownerInternalId, targetInternalId, tenantId, userContext });
  if (await protectedDuplicate()) {
    throw new RowndMigrationPolicyError(
      "The duplicate mapping already has an elected canonical Rownd user",
    );
  }
  const [duplicate, freshSource] = await Promise.all([
    fetchOptionalRowndUserInfo(duplicateId).catch((error: unknown) => {
      // @rownd/node propagates Got's HTTPError. Only a definitive missing duplicate
      // permits source-only proof; requested-user failures must still propagate.
      if (
        isRecord(error) && error.name === "HTTPError" &&
        error.code === "ERR_NON_2XX_3XX_RESPONSE" &&
        isRecord(error.response) && error.response.statusCode === 404
      ) return undefined;
      throw error;
    }),
    fetchOptionalRowndUserInfo(requestedId),
  ]);
  if (duplicate && duplicate.data?.user_id !== duplicateId) {
    throw new RowndMigrationPolicyError("Duplicate Rownd profile could not be verified");
  }
  if (!freshSource || freshSource.data?.user_id !== requestedId) {
    throw new RowndMigrationPolicyError("Requested Rownd source identity could not be verified");
  }
  const freshMethods = mapRowndUserToSuperTokens(
    freshSource,
    tenantId,
  ).loginMethods;
  const duplicateMethods = duplicate
    ? mapRowndUserToSuperTokens(duplicate, tenantId).loginMethods
    : undefined;
  clearSuperTokensCoreCallCache(userContext);
  const owner = await SuperTokens.getUser(ownerInternalId, userContext);
  const authenticatedEmail = getMigrationContactEmail(source, tenantId);
  const hasContactProof = () => authenticatedEmail !== undefined &&
    isRowndMigrationProfileActive(freshSource) && freshSource.data.email?.toLowerCase() === authenticatedEmail &&
    duplicate !== undefined && isRowndMigrationProfileActive(duplicate) && duplicate.data.email?.toLowerCase() === authenticatedEmail &&
    owner !== undefined && !owner.isPrimaryUser && owner.loginMethods.length === 1 &&
    owner.loginMethods[0]!.recipeId === "passwordless" &&
    owner.loginMethods[0]!.tenantIds.length === 1 &&
    owner.loginMethods[0]!.tenantIds.includes(tenantId) &&
    owner.loginMethods[0]!.hasSameEmailAs(authenticatedEmail);
  if (!duplicate && (
    freshSource.state !== "enabled" || freshSource.auth_level !== "verified" ||
    !owner || owner.isPrimaryUser || owner.loginMethods.length !== 1
  )) {
    throw new RowndMigrationPolicyError("Missing duplicate Rownd profile requires a verified source and standalone provider owner");
  }
  const exactProof = source.loginMethods.some(
    (method) =>
      method.recipeId === "thirdparty" &&
      ["google", "apple"].includes(method.thirdPartyId) &&
      freshMethods.some(
        (fresh) =>
          fresh.recipeId === "thirdparty" &&
          fresh.thirdPartyId === method.thirdPartyId &&
          fresh.thirdPartyUserId === method.thirdPartyUserId,
      ) &&
      (duplicateMethods ? duplicateMethods.some(
        (other) =>
          other.recipeId === "thirdparty" &&
          other.thirdPartyId === method.thirdPartyId &&
          other.thirdPartyUserId === method.thirdPartyUserId,
      ) : freshSource.verified_data?.[`${method.thirdPartyId}_id`] === method.thirdPartyUserId) &&
      owner?.loginMethods.some(
        (existing) =>
          existing.tenantIds.includes(tenantId) &&
          existing.hasSameThirdPartyInfoAs({
            id: method.thirdPartyId,
            userId: method.thirdPartyUserId,
          }),
      ),
  );
  const contactProof = hasContactProof();
  if (!exactProof && !contactProof)
    throw new RowndMigrationPolicyError(
      "Duplicate Rownd mapping has no exact provider identity proof",
    );
  if (ownerInternalId !== targetInternalId && owner?.isPrimaryUser) {
    throw new RowndMigrationPolicyError("Cannot safely merge a duplicate primary account");
  }
  if (isAdministrativeMigration(source, tenantId) && duplicate && mapping.status === "OK" &&
    !isAdministrativeElectionCandidate(source, duplicateId)) {
    throw new RowndMigrationPolicyError("Rownd activity election changed before reconciliation completion");
  }
  if (contactProof || isAdministrativeMigration(source, tenantId)) await assertAuthenticatedMigrationSource(source, tenantId);
  if (duplicate) await assertAdministrativeDuplicateWinner(source, tenantId, duplicateId);

  const assertRetirable = async () => {
    if (await protectedDuplicate()) throw new RowndMigrationPolicyError("Concurrent canonical election prevents safe mapping retirement");
  };
  await assertRetirable();

  await UserMetadata.updateUserMetadata(
    requestedId,
    { rownd_migration_target: targetInternalId },
    userContext,
  );
  // Preserve application metadata written under either storage convention. Internal
  // values take precedence; the canonical source profile is merged by reconciliation.
  if (duplicate) await assertAdministrativeDuplicateWinner(source, tenantId, duplicateId);
  await assertRetirable();
  await UserMetadata.updateUserMetadata(
    ownerInternalId,
    {
      ...mergeMissingValues(ownerMetadata, contactProof
        ? Object.fromEntries(Object.entries(duplicateMetadata).filter(([key]) => !isInternalMetadataField(key)))
        : duplicateMetadata),
      rownd_migration_reconciliation: {
        rowndUserId: requestedId,
        targetUserId: targetInternalId,
        previousExternalUserId: duplicateId,
      },
    },
    userContext,
  );
  if (duplicate) await assertAdministrativeDuplicateWinner(source, tenantId, duplicateId);
  await assertRetirable();
  await UserMetadata.updateUserMetadata(
    duplicateId,
    {
      rownd_migration_superseded: {
        rowndUserId: requestedId,
        targetUserId: targetInternalId,
      },
    },
    userContext,
  );

  await assertMigrationSourceActive(requestedId, userContext);
  const durableDuplicateMetadata = await getRawUserMetadata(
    duplicateId,
    userContext,
  );
  const durableRequestedMetadata = await getRawUserMetadata(
    requestedId,
    userContext,
  );
  const retirement = durableDuplicateMetadata.rownd_migration_superseded;
  if (
    !isRecord(retirement) ||
    retirement.rowndUserId !== requestedId ||
    retirement.targetUserId !== targetInternalId ||
    (await protectedDuplicate()) ||
    getMigrationTarget(durableRequestedMetadata) !== targetInternalId
  ) {
    throw new RowndMigrationPolicyError(
      "Concurrent canonical election prevents safe mapping retirement",
    );
  }
  const [freshExternal, freshInternal] = await Promise.all([
    SuperTokens.getUserIdMapping({
      userId: duplicateId,
      userIdType: "EXTERNAL",
      userContext,
    }),
    SuperTokens.getUserIdMapping({
      userId: ownerInternalId,
      userIdType: "SUPERTOKENS",
      userContext,
    }),
  ]);
  if (duplicate) await assertAdministrativeDuplicateWinner(source, tenantId, duplicateId);
  if (freshExternal.status === "OK") {
    if (
      freshExternal.superTokensUserId !== ownerInternalId ||
      freshInternal.status !== "OK" ||
      freshInternal.externalUserId !== duplicateId
    ) {
      throw new RowndMigrationPolicyError("Duplicate mapping changed before retirement");
    }
    if (contactProof) {
      await assertAuthenticatedMigrationSource(source, tenantId);
      clearSuperTokensCoreCallCache(userContext);
      const latestOwner = await SuperTokens.getUser(ownerInternalId, userContext);
      const latestDuplicate = await fetchOptionalRowndUserInfo(duplicateId);
      if (!latestOwner || latestOwner.id !== owner!.id || latestOwner.isPrimaryUser ||
          latestOwner.loginMethods.length !== 1 ||
          latestOwner.loginMethods[0]!.recipeId !== "passwordless" ||
          latestOwner.loginMethods[0]!.tenantIds.length !== 1 ||
          !latestOwner.loginMethods[0]!.tenantIds.includes(tenantId) ||
          !latestOwner.loginMethods[0]!.hasSameEmailAs(authenticatedEmail!) ||
          !latestDuplicate || !isRowndMigrationProfileActive(latestDuplicate) || latestDuplicate.data.user_id !== duplicateId ||
          latestDuplicate.data.email?.toLowerCase() !== authenticatedEmail) {
        throw new RowndMigrationPolicyError("Duplicate Rownd contact ownership changed before retirement");
      }
    }
    // Never delete by internal ID: another worker may already have installed A.
    // Core has no compare-and-delete API. Another migration or external writer
    // can still race the final election/mapping reads and this deletion.
    await assertRetirable();
    await SuperTokens.deleteUserIdMapping({
      userId: duplicateId,
      userIdType: "EXTERNAL",
      force: true,
      userContext,
    });
  }
  clearSuperTokensCoreCallCache(userContext);
  const retired = await SuperTokens.getUserIdMapping({
    userId: duplicateId,
    userIdType: "EXTERNAL",
    userContext,
  });
  if (retired.status === "OK")
    throw new RowndMigrationPolicyError("Duplicate mapping retirement incomplete");
  telemetry?.emit("transition", "duplicate_mapping_retired");
}
