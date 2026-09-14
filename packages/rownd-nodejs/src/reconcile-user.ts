import { isDeepStrictEqual } from "node:util";
import SuperTokens from "supertokens-node";
import { getPluginConfig, getSuperTokensConfig, resolvePluginConfigSnapshot } from "./config";
import { assertAuthenticatedMigrationSource, assertRowndSourcePayload, fetchAdministrativeMigrationSource, getAuthenticatedMigrationEmail } from "./migration-email";
import { assertMigrationPostconditions, assertMigrationOwnerGraph, reconcileAdministrativeEmailVerification } from "./migration-postconditions";
import { createRowndUserIdMapping, findExistingImportMethodUsers, getUserMetadata, importUser, isBulkImportDuplicateIdentityError, matchesImportLoginMethod, reconcileRowndUserWithExistingLoginMethods } from "./supertokens-repository";
import { assertMigrationMapping, assertMigrationSourceActive, assertSelectorNamespace, getMigrationTarget } from "./migration-mapping";
import { clearSuperTokensCoreCallCache, isRecord, type JsonRecord } from "./utils";
import { getRawUserMetadata, mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { RowndMigrationPolicyError } from "./errors";
import { fetchOptionalRowndUserInfo } from "./rownd-repository";
import { previewReconciliation, type ReconcilePreview } from "./reconcile-preview";
import { AmbiguousAdministrativeElection, bindAdministrativeElection, inspectAdministrativeElection, isAdministrativeElectionCandidate, type ActivityCandidate } from "./migration-election";
import { prepareOwnerConsolidation, readConsolidationCheckpoint, UnresolvedConsolidationOwners } from "./migration-consolidation";

export type ReconcileUserInput = (
  | { rownd_user_id: string; email?: never; supertokens_user_id?: never }
  | { email: string; rownd_user_id?: never; supertokens_user_id?: never }
  | { supertokens_user_id: string; rownd_user_id?: never; email?: never }
) & { tenantId?: string; userContext?: JsonRecord; dryRun?: boolean };

export type ReconcileCandidate = { rownd_user_id: string; supertokens_user_id: string };
export type ReconcileUserResult = {
  status: "OK" | "NOT_FOUND" | "AMBIGUOUS" | "BLOCKED" | "ERROR" | "PREVIEW";
  changed: boolean | null;
  actions: string[];
  rownd_user_id?: string;
  requested_rownd_user_id?: string;
  requested_supertokens_user_id?: string;
  unresolved_owners?: ActivityCandidate[];
  election?: { candidates: ActivityCandidate[]; basis: "latest_valid_activity" };
  supertokens_user_id?: string;
  recipe_user_ids?: string[];
  candidates?: ReconcileCandidate[];
  message?: string;
  observationError?: string;
  partialProgress?: boolean;
} & Partial<Pick<ReconcilePreview, "dryRun" | "canReconcile" | "matchesSource" | "proposedActions" | "blockers" | "requiresExecutionProof" | "missingMethods" | "snapshotOnly">>;

export function validateReconcileSelector(input: unknown): asserts input is ReconcileUserInput {
  const selectors = ["rownd_user_id", "email", "supertokens_user_id"];
  if (!isRecord(input) || selectors.filter((key) => Object.prototype.hasOwnProperty.call(input, key)).length !== 1 ||
      !selectors.some((key) => typeof input[key] === "string" && (input[key] as string).trim()) ||
      (input.tenantId !== undefined && (typeof input.tenantId !== "string" || !input.tenantId.trim())) ||
      (input.dryRun !== undefined && typeof input.dryRun !== "boolean") ||
      (input.userContext !== undefined && !isRecord(input.userContext))) {
    throw new Error("Provide exactly one non-empty rownd_user_id, email, or supertokens_user_id selector");
  }
}

type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type Source = NonNullable<Awaited<ReturnType<typeof fetchAdministrativeMigrationSource>>>;

class AmbiguousReconciliationSource extends Error {
  constructor(readonly candidates: ReconcileCandidate[]) {
    super("Multiple live Rownd sources identify the reconciliation owner");
  }
}

async function internalOwner(user: User, userContext: JsonRecord) {
  const mapping = await SuperTokens.getUserIdMapping({ userId: user.id, userIdType: "EXTERNAL", userContext });
  return mapping.status === "OK" ? mapping.superTokensUserId : user.id;
}

async function discover(users: User[], userContext: JsonRecord, provenRecovery?: ReconcileCandidate, validateLive = false) {
  const owners = new Map<string, User>();
  for (const user of users) owners.set(await internalOwner(user, userContext), user);
  const candidates: ReconcileCandidate[] = [];
  const requiredMembers = new Map<string, ReconcileCandidate>();
  const unprovenAliases = new Set<string>();
  for (const [id, user] of owners) {
    const sources = new Set<string>();
    const aliases = new Set<string>();
    const ids = new Set([id, user.id, ...user.loginMethods.map((method) => method.recipeUserId.getAsString())]);
    for (const alias of ids) {
      const mapping = await SuperTokens.getUserIdMapping({ userId: alias, userIdType: "ANY", userContext });
      if (mapping.status === "OK") {
        aliases.add(mapping.externalUserId);
        ids.add(mapping.superTokensUserId);
        ids.add(mapping.externalUserId);
      }
      // Discovery must not merge away conflicting secondary provenance.
      const metadata = await getRawUserMetadata(alias, userContext);
      const rowndId = metadata.original_rownd_user?.data.user_id;
      if (rowndId) sources.add(rowndId);
    }
    for (const rowndId of new Set([...sources, ...aliases])) {
      const metadata = await getRawUserMetadata(rowndId, userContext);
      const retirement = metadata.rownd_migration_superseded;
      if (isRecord(retirement) && retirement.targetUserId === id &&
          typeof retirement.rowndUserId === "string" && retirement.rowndUserId !== rowndId) {
        const canonical = await SuperTokens.getUserIdMapping({ userId: retirement.rowndUserId, userIdType: "EXTERNAL", userContext });
        const retired = await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL", userContext });
        if (retired.status !== "OK" && ((canonical.status === "OK" && canonical.superTokensUserId === id) ||
            (canonical.status !== "OK" && provenRecovery?.supertokens_user_id === id && provenRecovery.rownd_user_id === retirement.rowndUserId))) continue;
      }
      if (!sources.has(rowndId)) unprovenAliases.add(rowndId);
      const recipeMapping = await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL", userContext });
      const recipeId = recipeMapping.status === "OK" ? recipeMapping.superTokensUserId : id;
      candidates.push({ rownd_user_id: rowndId, supertokens_user_id: recipeId });
    }
    const checkpoint = readConsolidationCheckpoint(await getRawUserMetadata(id, userContext));
    if (checkpoint) {
      if (checkpoint.target !== id) throw new RowndMigrationPolicyError("Invalid duplicate owner consolidation checkpoint");
      for (const member of checkpoint.members) {
        const candidate = { rownd_user_id: member.rownd_user_id, supertokens_user_id: member.supertokens_user_id };
        requiredMembers.set(member.rownd_user_id, candidate);
        if (!candidates.some((entry) => entry.rownd_user_id === member.rownd_user_id && entry.supertokens_user_id === member.supertokens_user_id)) candidates.push(candidate);
      }
    }
  }
  const active: ReconcileCandidate[] = [];
  for (const candidate of candidates) {
    // Historical snapshots and unrelated linked aliases cannot establish a live conflict.
    if (validateLive || candidates.length > 1 || unprovenAliases.has(candidate.rownd_user_id)) {
      let live;
      try { live = await fetchOptionalRowndUserInfo(candidate.rownd_user_id); } catch (error) {
        if (!(isRecord(error) && isRecord(error.response) && error.response.statusCode === 404)) throw error;
      }
      if (!live) {
        if (requiredMembers.has(candidate.rownd_user_id)) throw new UnresolvedConsolidationOwners([...requiredMembers.values()], "a checkpoint source disappeared");
        continue;
      }
      assertRowndSourcePayload(live);
      if (live.data?.user_id !== candidate.rownd_user_id) throw new RowndMigrationPolicyError("SOURCE_ID_MISMATCH: discovery returned another Rownd user");
      if (live.state !== undefined && live.state !== "enabled") {
        if (requiredMembers.has(candidate.rownd_user_id)) throw new UnresolvedConsolidationOwners([...requiredMembers.values()], "a checkpoint source is inactive");
        continue;
      }
    }
    active.push(candidate);
  }
  for (const candidate of active) {
    if (!owners.has(candidate.supertokens_user_id)) {
      const owner = await SuperTokens.getUser(candidate.supertokens_user_id, userContext);
      if (owner) owners.set(candidate.supertokens_user_id, owner);
    }
  }
  return { owners, candidates: active.sort((a, b) => a.rownd_user_id.localeCompare(b.rownd_user_id) || a.supertokens_user_id.localeCompare(b.supertokens_user_id)) };
}

async function assertUnambiguousSource(user: User, rowndId: string, userContext: JsonRecord, provenRecovery?: ReconcileCandidate, source?: Source) {
  const { candidates } = await discover([user], userContext, provenRecovery);
  if (candidates.some((candidate) => candidate.rownd_user_id !== rowndId && !isAdministrativeElectionCandidate(source, candidate.rownd_user_id))) {
    throw new AmbiguousReconciliationSource(candidates);
  }
}

async function inspectSourceElection(source: Source, selected: User | undefined, tenantId: string, userContext: JsonRecord, initialCandidates: ActivityCandidate[] = []) {
  const users = selected ? [selected] : [];
  for (const method of source.loginMethods) {
    const accountInfo = method.recipeId === "passwordless" && method.email ? { email: method.email } :
      method.recipeId === "thirdparty" && ["google", "apple"].includes(method.thirdPartyId)
        ? { thirdParty: { id: method.thirdPartyId, userId: method.thirdPartyUserId } } : undefined;
    if (accountInfo) users.push(...await SuperTokens.listUsersByAccountInfo(tenantId, accountInfo, false, userContext));
  }
  let provenRecovery: ReconcileCandidate | undefined;
  if (selected) {
    const id = await internalOwner(selected, userContext);
    const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext });
    if (id !== source.externalUserId && mapping.status !== "OK") {
      await assertPinnedMappingProvenance(id, source, tenantId, userContext);
      provenRecovery = { rownd_user_id: source.externalUserId!, supertokens_user_id: id };
    }
  }
  const { candidates } = await discover(users, userContext, provenRecovery, true);
  const entries: ActivityCandidate[] = [...new Map([...initialCandidates, ...candidates].map((candidate) =>
    [`${candidate.rownd_user_id}:${candidate.supertokens_user_id}`, candidate])).values()];
  if (!entries.some((candidate) => candidate.rownd_user_id === source.externalUserId)) entries.push({ rownd_user_id: source.externalUserId!,
    ...(selected ? { supertokens_user_id: await internalOwner(selected, userContext) } : {}) });
  return entries.length > 1 ? inspectAdministrativeElection(entries) : undefined;
}

async function assertElectionOwners(election: Awaited<ReturnType<typeof inspectAdministrativeElection>>, tenantId: string, userContext: JsonRecord) {
  clearSuperTokensCoreCallCache(userContext);
  for (const candidate of election.candidates) {
    if (!candidate.supertokens_user_id) continue;
    const id = candidate.supertokens_user_id;
    const user = await SuperTokens.getUser(id, userContext);
    const mapping = await SuperTokens.getUserIdMapping({ userId: candidate.rownd_user_id, userIdType: "EXTERNAL", userContext });
    if (!user || !user.loginMethods.some((method) => method.tenantIds.includes(tenantId))) {
      throw new RowndMigrationPolicyError("Rownd election owner changed");
    }
    if (mapping.status === "OK") {
      if (mapping.superTokensUserId !== id || await internalOwner(user, userContext) !== id) {
        throw new RowndMigrationPolicyError("Rownd election owner changed");
      }
    } else {
      const stored = await getRawUserMetadata(id, userContext);
      const metadata = await getRawUserMetadata(candidate.rownd_user_id, userContext);
      const retirement = metadata.rownd_migration_superseded;
      // A retirement performed by this election can legitimately remove a donor
      // mapping and then move its recipe under the winner during linking.
      const winnerTarget = election.winner.supertokens_user_id ??
        getMigrationTarget(await getRawUserMetadata(election.winner.rownd_user_id, userContext));
      const retiredByWinner = isRecord(retirement) && retirement.rowndUserId === election.winner.rownd_user_id &&
        winnerTarget !== undefined && retirement.targetUserId === winnerTarget;
      const internal = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext });
      if (internal.status === "OK" && internal.externalUserId !== candidate.rownd_user_id &&
        !(retiredByWinner && internal.externalUserId === election.winner.rownd_user_id)) {
        throw new RowndMigrationPolicyError("Rownd election owner changed");
      }
      if (!retiredByWinner && (stored.original_rownd_user?.data.user_id !== candidate.rownd_user_id ||
        await internalOwner(user, userContext) !== id)) throw new RowndMigrationPolicyError("Rownd election owner changed");
    }
  }
}

async function findRecoveryOwner(source: Source, tenantId: string, userContext: JsonRecord, matchingOnly = false) {
  clearSuperTokensCoreCallCache(userContext);
  const owners: Array<{ user: User; rowndId: string | undefined }> = [];
  for (const user of await findExistingImportMethodUsers(source, tenantId, userContext)) {
    const id = await internalOwner(user, userContext);
    const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext });
    const metadata = await getRawUserMetadata(id, userContext);
    if (mapping.status !== "OK" && metadata.original_rownd_user !== undefined) {
      owners.push({ user, rowndId: metadata.original_rownd_user?.data.user_id });
    }
  }
  const matching = owners.filter((owner) => owner.rowndId === source.externalUserId);
  const candidates = matching.length || matchingOnly ? matching : owners;
  if (candidates.length > 1) throw new AmbiguousReconciliationSource((await discover(candidates.map(({ user }) => user), userContext)).candidates);
  return candidates[0]?.user;
}

async function assertPinnedMappingProvenance(id: string, source: Source, tenantId: string, userContext: JsonRecord) {
  await assertAuthenticatedMigrationSource(source, tenantId);
  clearSuperTokensCoreCallCache(userContext);
  await assertSelectorNamespace(source.externalUserId!, userContext);
  const metadata = await assertMigrationSourceActive(source.externalUserId!, userContext);
  const target = getMigrationTarget(metadata);
  const [user, stored, external, internal] = await Promise.all([
    SuperTokens.getUser(id, userContext), getRawUserMetadata(id, userContext),
    SuperTokens.getUserIdMapping({ userId: source.externalUserId!, userIdType: "EXTERNAL", userContext }),
    SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext }),
  ]);
  if ((external.status === "OK" && external.superTokensUserId !== id) ||
      (internal.status === "OK" && internal.externalUserId !== source.externalUserId) ||
      (target !== undefined && target !== id)) throw new RowndMigrationPolicyError("The reconciliation target changed");
  if (!user || await internalOwner(user, userContext) !== id ||
      stored.original_rownd_user?.data.user_id !== source.externalUserId || stored.rownd_migration_superseded !== undefined ||
      (getMigrationTarget(stored) !== undefined && getMigrationTarget(stored) !== id) ||
      !user.loginMethods.some((method) => method.tenantIds.includes(tenantId) &&
        source.loginMethods.some((expected) => matchesImportLoginMethod(method, expected)) &&
        mapRowndUserToSuperTokens(stored.original_rownd_user!, tenantId).loginMethods.some((expected) => matchesImportLoginMethod(method, expected)))) {
    throw new RowndMigrationPolicyError("Missing mapping cannot be restored without matching live identity and migration provenance");
  }
  if (metadata.original_rownd_user && !isDeepStrictEqual(
    mapRowndUserToSuperTokens(metadata.original_rownd_user, tenantId).loginMethods,
    mapRowndUserToSuperTokens(stored.original_rownd_user!, tenantId).loginMethods,
  )) throw new RowndMigrationPolicyError("Contradictory historical snapshots cannot authorize mapping restoration");
  await assertMigrationOwnerGraph(user, tenantId, userContext);
  return user;
}

async function inspectPinnedMappingPublication(id: string, source: Source, tenantId: string, userContext: JsonRecord) {
  const user = await assertPinnedMappingProvenance(id, source, tenantId, userContext);
  await assertUnambiguousSource(user, source.externalUserId!, userContext, { rownd_user_id: source.externalUserId!, supertokens_user_id: id }, source);
  return assertPinnedMappingProvenance(id, source, tenantId, userContext);
}

async function publishPinnedMapping(id: string, source: Source, tenantId: string, userContext: JsonRecord) {
  await inspectPinnedMappingPublication(id, source, tenantId, userContext);
  // Core's force flag bypasses ancillary recipe data checks, not mapping uniqueness.
  // Bulk import already writes UserMetadata under this proven, pinned internal ID.
  if (id !== source.externalUserId) await createRowndUserIdMapping(id, source.externalUserId!, userContext, true);
  clearSuperTokensCoreCallCache(userContext);
  await assertMigrationMapping(id, source.externalUserId!, userContext);
}

/** Reconcile one live Rownd identity using the initialized server configuration. */
export async function reconcileUser(input: ReconcileUserInput): Promise<ReconcileUserResult> {
  const result: ReconcileUserResult = { status: "ERROR", changed: false, actions: [], ...(input?.dryRun === true ? {
    dryRun: true as const, canReconcile: false, matchesSource: false, proposedActions: [], blockers: [], requiresExecutionProof: [], missingMethods: [], snapshotOnly: true as const,
  } : {}) };
  let mutationStarted = false;
  try {
    validateReconcileSelector(input);
    result.requested_rownd_user_id = input.rownd_user_id;
    result.requested_supertokens_user_id = input.supertokens_user_id;
    const config = getPluginConfig();
    const core = getSuperTokensConfig()?.supertokens;
    if (!config || !core) throw new Error("Initialize SuperTokens with the Rownd plugin before calling reconcileUser");
    const tenantId = input.tenantId ?? "public";
    const { userContext } = await resolvePluginConfigSnapshot(config, { tenantId, userContext: input.userContext ?? {} });
    clearSuperTokensCoreCallCache(userContext);
    if (input.supertokens_user_id) await assertSelectorNamespace(input.supertokens_user_id, userContext);
    if (input.rownd_user_id) await assertSelectorNamespace(input.rownd_user_id, userContext);
    let selected: User | undefined;
    let selectedOwner: string | undefined;
    let resolvedElection: Awaited<ReturnType<typeof inspectAdministrativeElection>> | undefined;
    let consolidation: Awaited<ReturnType<typeof prepareOwnerConsolidation>>;
    let rowndId = input.rownd_user_id;
    if (!rowndId) {
      const users = input.email !== undefined
        ? await SuperTokens.listUsersByAccountInfo(tenantId, { email: input.email }, false, userContext)
        : [await SuperTokens.getUser(input.supertokens_user_id!, userContext)].filter((user): user is User => user !== undefined);
      const { owners, candidates } = await discover(users, userContext);
      if (candidates.length === 0) return { ...result, status: "BLOCKED", message: "No Rownd source mapping or metadata found in SuperTokens" };
      const elected = candidates.length > 1 ? await inspectAdministrativeElection(candidates) : undefined;
      resolvedElection = elected;
      const candidate = elected?.winner ?? candidates[0]!;
      rowndId = candidate.rownd_user_id;
      selected = owners.get(candidate.supertokens_user_id!);
      selectedOwner = candidate.supertokens_user_id;
      if (elected) result.election = { candidates: elected.candidates, basis: "latest_valid_activity" };
      if (input.supertokens_user_id && users[0] && await internalOwner(users[0], userContext) !== selectedOwner) {
        result.rownd_user_id = rowndId;
        throw new RowndMigrationPolicyError("The SuperTokens selector belongs to a different canonical Rownd owner");
      }
    }
    result.rownd_user_id = rowndId;
    result.requested_rownd_user_id ??= rowndId;
    await assertSelectorNamespace(rowndId, userContext);
    let source = await fetchAdministrativeMigrationSource(rowndId, tenantId, userContext);
    if (!source) return { ...result, status: "NOT_FOUND", message: "Live Rownd user not found" };
    selected ??= await SuperTokens.getUser(rowndId, userContext);
    selectedOwner ??= selected ? await internalOwner(selected, userContext) : undefined;
    const sourceTarget = getMigrationTarget(await assertMigrationSourceActive(rowndId, userContext));
    if (sourceTarget !== undefined) {
      const pinned = await SuperTokens.getUser(sourceTarget, userContext);
      if (!pinned) throw new RowndMigrationPolicyError("MAPPING_TARGET_MISSING: reconciliation target does not exist");
      if (selected && await internalOwner(selected, userContext) !== await internalOwner(pinned, userContext)) {
        throw new RowndMigrationPolicyError("The reconciliation target changed");
      }
      selected ??= pinned;
    }
    selected ??= await findRecoveryOwner(source, tenantId, userContext, true);
    selectedOwner ??= selected ? await internalOwner(selected, userContext) : undefined;
    result.supertokens_user_id = selectedOwner;
    const election = await inspectSourceElection(source, selected, tenantId, userContext, resolvedElection?.candidates);
    if (election) {
      result.election = { candidates: election.candidates, basis: "latest_valid_activity" };
      if (election.winner.rownd_user_id !== rowndId) {
        result.requested_rownd_user_id = rowndId;
        rowndId = election.winner.rownd_user_id;
        result.rownd_user_id = rowndId;
        result.supertokens_user_id = election.winner.supertokens_user_id;
        if (input.supertokens_user_id && selected && await internalOwner(selected, userContext) !== election.winner.supertokens_user_id) {
          throw new RowndMigrationPolicyError("The SuperTokens selector belongs to a different canonical Rownd owner");
        }
        await assertSelectorNamespace(rowndId, userContext);
        source = await fetchAdministrativeMigrationSource(rowndId, tenantId, userContext);
        if (!source) throw new RowndMigrationPolicyError("Rownd election source disappeared");
        selectedOwner = election.winner.supertokens_user_id;
        selected = await SuperTokens.getUser(selectedOwner ?? rowndId, userContext);
      }
      if (!selected && election.winner.supertokens_user_id) {
        selectedOwner = election.winner.supertokens_user_id;
        selected = await SuperTokens.getUser(selectedOwner, userContext);
      }
      if (!election.winner.supertokens_user_id) throw new UnresolvedConsolidationOwners(election.candidates, "the winner has no immutable owner to consolidate into");
      consolidation = await prepareOwnerConsolidation({ source, candidates: election.candidates,
        target: election.winner.supertokens_user_id, tenantId, userContext });
      if (!consolidation) await assertElectionOwners(election, tenantId, userContext);
      bindAdministrativeElection(source, tenantId, election, consolidation ? () => consolidation!.assertOwners() : () => assertElectionOwners(election, tenantId, userContext));
    }
    selected ??= await findRecoveryOwner(source, tenantId, userContext);
    const beforeId = selectedOwner ?? (selected ? await internalOwner(selected, userContext) : undefined);
    const canonicalTarget = getMigrationTarget(await assertMigrationSourceActive(rowndId, userContext));
    if (canonicalTarget !== undefined && canonicalTarget !== beforeId) throw new RowndMigrationPolicyError("The reconciliation target changed");
    if (selected && beforeId === rowndId && (await getUserMetadata(beforeId, userContext)).original_rownd_user?.data.user_id !== rowndId &&
        !selected.loginMethods.some((method) => source.loginMethods.some((expected) => matchesImportLoginMethod(method, expected)))) {
      throw new RowndMigrationPolicyError("Rownd user ID collides with an unrelated internal account");
    }
    let expectedInternalUserId = beforeId;
    const pinOwner = (id: string) => {
      if (expectedInternalUserId !== undefined && expectedInternalUserId !== id) throw new RowndMigrationPolicyError("The reconciliation target changed");
      expectedInternalUserId = id;
      result.supertokens_user_id = id;
    };
    result.supertokens_user_id = beforeId;
    const snapshot = async (id: string | undefined) => id ? {
      user: JSON.parse(JSON.stringify(await SuperTokens.getUser(id, userContext) ?? null)) as unknown,
      metadata: await getUserMetadata(id, userContext),
      mapping: await SuperTokens.getUserIdMapping({ userId: id, userIdType: "ANY", userContext }),
    } : undefined;
    const before = await snapshot(beforeId);
    const restoreMapping = beforeId !== undefined && beforeId !== rowndId && before?.mapping.status !== "OK";
    if (input.rownd_user_id && selected && !restoreMapping) {
      await assertUnambiguousSource(selected, rowndId, userContext, undefined, source);
    }
    if (input.dryRun) {
      await assertAuthenticatedMigrationSource(source, tenantId);
      clearSuperTokensCoreCallCache(userContext);
      if (restoreMapping) selected = await inspectPinnedMappingPublication(beforeId!, source, tenantId, userContext);
      else if (beforeId) await assertMigrationMapping(beforeId, rowndId, userContext);
      // The preview only enters read-only inspection; reconciliation and cleanup are never invoked.
      const preview = await previewReconciliation({ source, selected, internalId: beforeId, restoreMapping, tenantId, userContext,
        plannedOwnerIds: consolidation?.plannedOwnerIds });
      if (consolidation?.proposedActions.length) {
        preview.proposedActions.push(...consolidation.proposedActions.filter((action) => !preview.proposedActions.some((existing) =>
          existing.action === action.action && existing.recipeUserId === action.recipeUserId && existing.supertokens_user_id === action.supertokens_user_id)));
        preview.matchesSource = false;
      }
      clearSuperTokensCoreCallCache(userContext);
      if (restoreMapping) await inspectPinnedMappingPublication(beforeId!, source, tenantId, userContext);
      else if (beforeId) await assertMigrationMapping(beforeId, rowndId, userContext);
      return { ...result, ...preview };
    }
    let operationError: unknown;
    let operationFailed = false;
    let importedNewUser = false;
    try {
      await assertAuthenticatedMigrationSource(source, tenantId);
      mutationStarted = true;
      if (restoreMapping) {
        await publishPinnedMapping(beforeId!, source, tenantId, userContext);
      }
      if (consolidation) {
        await consolidation.execute();
        await consolidation.beginMethodReconciliation();
        selected = await SuperTokens.getUser(beforeId!, userContext);
      }
      const reconciled = await reconcileRowndUserWithExistingLoginMethods(source, tenantId, userContext,
        { repairUser: selected, expectedInternalUserId, onTargetSelected: pinOwner });
      if (!reconciled) {
        await assertAuthenticatedMigrationSource(source, tenantId);
        try {
          // With externalUserId, Core externalizes even recipe IDs in its response.
          // Import without the alias so ownership is pinned before publishing it.
          const imported = await importUser({ ...source, externalUserId: undefined }, core);
          if (!imported.id || imported.id === rowndId) throw new Error("Bulk import returned no immutable internal user ID");
          pinOwner(imported.id);
          importedNewUser = true;
          await assertAuthenticatedMigrationSource(source, tenantId);
          clearSuperTokensCoreCallCache(userContext);
          const mapping = await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL", userContext });
          if (mapping.status === "OK") pinOwner(mapping.superTokensUserId);
          await publishPinnedMapping(imported.id, source, tenantId, userContext);
        } catch (error) {
          if (!isBulkImportDuplicateIdentityError(error)) throw error;
          const recovered = await findRecoveryOwner(source, tenantId, userContext);
          if (recovered) {
            const recoveredId = await internalOwner(recovered, userContext);
            pinOwner(recoveredId);
            await publishPinnedMapping(recoveredId, source, tenantId, userContext);
          }
          if (!await reconcileRowndUserWithExistingLoginMethods(source, tenantId, userContext,
            { repairUser: recovered, expectedInternalUserId, onTargetSelected: pinOwner })) throw error;
        }
      }
      clearSuperTokensCoreCallCache(userContext);
      const user = await SuperTokens.getUser(rowndId, userContext);
      if (!user) throw new RowndMigrationPolicyError("Reconciled user could not be resolved");
      const id = await internalOwner(user, userContext);
      pinOwner(id);
      result.recipe_user_ids = user.loginMethods.map((method) => method.recipeUserId.getAsString());
      await assertAuthenticatedMigrationSource(source, tenantId);
      await reconcileAdministrativeEmailVerification({ internalUserId: id, source, tenantId, userContext });
      const missing = source.loginMethods.filter((expected) => !user.loginMethods.some((method) =>
        method.tenantIds.includes(tenantId) && matchesImportLoginMethod(method, expected)));
      if (missing.length) throw new RowndMigrationPolicyError("Current Rownd methods remain missing or blocked by canonical policy");
      // The login engine intentionally preserves native canonical choices. Admin
      // success additionally requires every current Rownd method, including those it skips.
      await assertMigrationPostconditions({ internalUserId: id, source, importMethods: source.loginMethods,
        tenantId, userContext, authenticatedEmail: getAuthenticatedMigrationEmail(source, tenantId), matchesMethod: matchesImportLoginMethod });
      if (consolidation) await consolidation.complete();
      result.status = "OK";
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    try {
      clearSuperTokensCoreCallCache(userContext);
      const current = await SuperTokens.getUser(rowndId, userContext);
      const id = current ? await internalOwner(current, userContext) : expectedInternalUserId;
      if (id !== undefined) pinOwner(id);
      if (!current && result.status === "OK") throw new RowndMigrationPolicyError("Reconciled user disappeared during final observation");
      const after = await snapshot(id);
      if (id !== undefined && after?.user === null) throw new RowndMigrationPolicyError("Pinned reconciliation owner disappeared during final observation");
      if (after?.mapping.status === "OK" && after.mapping.superTokensUserId !== expectedInternalUserId) {
        throw new RowndMigrationPolicyError("The reconciliation target changed during final observation");
      }
      if (result.status === "OK" && expectedInternalUserId) {
        await assertMigrationMapping(expectedInternalUserId, rowndId, userContext);
        if (consolidation) {
          await assertAuthenticatedMigrationSource(source, tenantId);
          await consolidation.assertOwners(true);
        }
      }
      if (beforeId === undefined && expectedInternalUserId !== undefined && !importedNewUser) {
        result.changed = null;
      } else {
        result.changed = !isDeepStrictEqual(before, after);
        if (!isDeepStrictEqual(before?.user, after?.user)) result.actions.push(before ? "login_methods_reconciled" : "user_imported_or_linked");
        if (!isDeepStrictEqual(before?.mapping, after?.mapping)) result.actions.push("external_mapping_updated");
        if (!isDeepStrictEqual(before?.metadata, after?.metadata)) result.actions.push("migration_metadata_updated");
      }
    } catch (error) {
      result.changed = null;
      result.observationError = error instanceof Error ? error.message : "Final observation failed";
      if (!operationFailed) { operationFailed = true; operationError = error; }
    }
    if (operationFailed) throw operationError;
    return result;
  } catch (error) {
    if (error instanceof UnresolvedConsolidationOwners) return { ...result, status: "BLOCKED", unresolved_owners: error.owners,
      ...(result.dryRun ? { blockers: [{ code: "OWNER_CONSOLIDATION_BLOCKED" }] } : {}),
      message: error.message, partialProgress: mutationStarted };
    if (error instanceof AmbiguousAdministrativeElection) return { ...result, status: "AMBIGUOUS",
      candidates: error.candidates.filter((candidate): candidate is ReconcileCandidate => candidate.supertokens_user_id !== undefined),
      election: { candidates: error.candidates, basis: "latest_valid_activity" }, message: error.message };
    if (error instanceof AmbiguousReconciliationSource) return { ...result, status: "AMBIGUOUS", candidates: error.candidates };
    const message = error instanceof Error ? error.message : "Reconciliation failed";
    return { ...result, status: error instanceof RowndMigrationPolicyError ? "BLOCKED" : "ERROR",
      ...(result.election ? { unresolved_owners: result.election.candidates } : {}),
      ...(result.dryRun ? { blockers: [{ code: error instanceof RowndMigrationPolicyError ? "POLICY_BLOCKED" : "OBSERVATION_FAILED" }] } : {}),
      message, partialProgress: mutationStarted };
  }
}
