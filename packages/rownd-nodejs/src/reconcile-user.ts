import { isDeepStrictEqual } from "node:util";
import { reconciliationSuperTokens as SuperTokens } from "./reconciliation-sdk";
import { invalidateReconciliationReads, reconciliationProgress, withReconciliationReads, type ReconciliationProgress } from "./reconciliation-reads";
import { getPluginConfig, getSuperTokensConfig, resolvePluginConfigSnapshot } from "./config";
import { assertAuthenticatedMigrationSource, assertRowndSourcePayload, fetchAdministrativeMigrationSource, getAuthenticatedMigrationEmail, getMigrationContactEmail } from "./migration-email";
import { assertMigrationPostconditions, assertMigrationOwnerGraph, reconcileAdministrativeEmailVerification } from "./migration-postconditions";
import { findExistingImportMethodUsers, getUserMetadata, importUser, isBulkImportDuplicateIdentityError, matchesImportLoginMethod, reconcileRowndUserWithExistingLoginMethods } from "./supertokens-repository";
import { assertMigrationMapping, assertMigrationSourceActive, assertSelectorNamespace, getMigrationTarget } from "./migration-mapping";
import { clearSuperTokensCoreCallCache, isRecord, type JsonRecord } from "./utils";
import { getRawUserMetadata, mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { RowndMigrationPolicyError } from "./errors";
import { fetchOptionalRowndUserInfo, findRowndUserIdsByEmail, withFreshRowndReads } from "./rownd-repository";
import { previewReconciliation, type ReconcilePreview } from "./reconcile-preview";
import { AmbiguousAdministrativeElection, bindAdministrativeElection, inspectAdministrativeElection, isAdministrativeElectionCandidate, type ActivityCandidate } from "./migration-election";
import { prepareOwnerConsolidation, readConsolidationCheckpoint, readOwnerRecoveryCheckpoint, UnresolvedConsolidationOwners } from "./migration-consolidation";
import { readOwnerPlanCheckpoint } from "./migration-owner-plan";
import { assertFreshAliasVerification, completeMappingPublication, inspectMappingPublication, publishFreshMapping } from "./migration-publication";
import { assertAdministrativeMetadataBackfilled } from "./migration-admin-metadata";
import { recoverProviderRevocations } from "./migration-provider";
import type { MethodPlan } from "./migration-method-plan";
import { resolveRowndProviderSubject } from "./provider-identity";

export type ReconcileUserInput = (
  | { rownd_user_id: string; email?: never; supertokens_user_id?: never }
  | { email: string; rownd_user_id?: never; supertokens_user_id?: never }
  | { supertokens_user_id: string; rownd_user_id?: never; email?: never }
) & { tenantId?: string; userContext?: JsonRecord; dryRun?: boolean; onProgress?: (event: ReconciliationProgress) => void };

export type ReconcileCandidate = { rownd_user_id: string; supertokens_user_id: string };
export type ReconcileUserResult = {
  status: "OK" | "NOT_FOUND" | "AMBIGUOUS" | "BLOCKED" | "ERROR" | "PREVIEW";
  changed: boolean | null;
  actions: string[];
  rownd_user_id?: string;
  requested_rownd_user_id?: string;
  requested_supertokens_user_id?: string;
  unresolved_owners?: ActivityCandidate[];
  election?: { candidates: ActivityCandidate[]; basis: "latest_valid_activity"; canonical_rownd_user_id?: string };
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
  constructor(readonly candidates: ActivityCandidate[]) {
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
  const candidates: ActivityCandidate[] = [];
  const requiredMembers = new Map<string, ActivityCandidate>();
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
    const ownerPlan = readOwnerPlanCheckpoint(await getRawUserMetadata(id, userContext));
    if (ownerPlan) {
      for (const member of ownerPlan.candidates) {
        const mapping = await SuperTokens.getUserIdMapping({ userId: member.rownd_user_id, userIdType: "EXTERNAL", userContext });
        const candidate = { rownd_user_id: member.rownd_user_id,
          ...(mapping.status === "OK" ? { supertokens_user_id: mapping.superTokensUserId } :
            member.supertokens_user_id ? { supertokens_user_id: member.supertokens_user_id } : {}) };
        requiredMembers.set(candidate.rownd_user_id, candidate);
        if (!candidates.some((entry) => entry.rownd_user_id === candidate.rownd_user_id && entry.supertokens_user_id === candidate.supertokens_user_id)) candidates.push(candidate);
      }
    }
  }
  const active: ActivityCandidate[] = [];
  const normalized = [...new Map(candidates.map((candidate) => {
    const entry = requiredMembers.get(candidate.rownd_user_id) ?? candidate;
    return [`${entry.rownd_user_id}:${entry.supertokens_user_id ?? ""}`, entry] as const;
  })).values()];
  for (const candidate of normalized) {
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
    if (candidate.supertokens_user_id && !owners.has(candidate.supertokens_user_id)) {
      const owner = await SuperTokens.getUser(candidate.supertokens_user_id, userContext);
      if (owner) owners.set(candidate.supertokens_user_id, owner);
    }
  }
  return { owners, candidates: active.sort((a, b) => a.rownd_user_id.localeCompare(b.rownd_user_id) || (a.supertokens_user_id ?? "").localeCompare(b.supertokens_user_id ?? "")) };
}

async function assertUnambiguousSource(user: User, rowndId: string, userContext: JsonRecord, provenRecovery?: ReconcileCandidate, source?: Source) {
  const { candidates } = await discover([user], userContext, provenRecovery, true);
  if (candidates.some((candidate) => candidate.rownd_user_id !== rowndId && !isAdministrativeElectionCandidate(source, candidate.rownd_user_id))) {
    throw new AmbiguousReconciliationSource(candidates);
  }
}

async function selectSurvivor(users: User[], tenantId: string, userContext: JsonRecord, email?: string) {
  const owners = new Map<string, User>();
  for (const user of users) {
    if (email && !user.loginMethods.some((method) => method.tenantIds.includes(tenantId) && method.hasSameEmailAs(email))) continue;
    owners.set(await internalOwner(user, userContext), user);
  }
  const rank = (user: User) => [Number(user.isPrimaryUser), user.loginMethods.length,
    Number(user.loginMethods.some((method) => method.recipeId === "passwordless" && method.email && (!email || method.hasSameEmailAs(email))))];
  const ranked = [...owners.values()].sort((a, b) => {
    const left = rank(a), right = rank(b);
    return right[0]! - left[0]! || right[1]! - left[1]! || right[2]! - left[2]!;
  });
  if (!ranked.length) return undefined;
  const tied = ranked.filter((user) => isDeepStrictEqual(rank(user), rank(ranked[0]!)));
  if (tied.length === 1) return tied[0];
  const canonical: User[] = [];
  for (const user of tied) {
    const id = await internalOwner(user, userContext);
    const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext });
    if (mapping.status === "OK") canonical.push(user);
  }
  if (canonical.length === 1) return canonical[0];
  throw new AmbiguousReconciliationSource((await discover(tied, userContext, undefined, true)).candidates);
}

async function survivorCanonicalId(user: User | undefined, userContext: JsonRecord) {
  if (!user) return undefined;
  const id = await internalOwner(user, userContext);
  const checkpoint = readOwnerPlanCheckpoint(await getRawUserMetadata(id, userContext));
  if (checkpoint) return checkpoint.sourceId;
  const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext });
  return mapping.status === "OK" ? mapping.externalUserId : undefined;
}

async function inspectSourceElection(source: Source, selected: User | undefined, tenantId: string, userContext: JsonRecord, initialCandidates: ActivityCandidate[] = [], contactEmail?: string) {
  const users = selected ? [selected] : [];
  const checkpoint = readOwnerPlanCheckpoint(await getRawUserMetadata(source.externalUserId!, userContext)) ??
    (selected ? readOwnerPlanCheckpoint(await getRawUserMetadata(await internalOwner(selected, userContext), userContext)) : undefined);
  if (checkpoint) {
    for (const id of new Set(checkpoint.initial.graph.map((entry) => entry.owner))) {
      const user = await SuperTokens.getUser(id, userContext);
      if (!user) throw new UnresolvedConsolidationOwners(checkpoint.candidates, "a checkpoint owner disappeared");
      users.push(user);
    }
  }
  for (const method of source.loginMethods) {
    const accountInfo = method.recipeId === "passwordless" && method.email ? { email: method.email } :
      method.recipeId === "passwordless" && method.phoneNumber ? { phoneNumber: method.phoneNumber } :
      method.recipeId === "thirdparty" && ["google", "apple"].includes(method.thirdPartyId)
        ? { thirdParty: { id: method.thirdPartyId, userId: method.thirdPartyUserId } } : undefined;
    if (accountInfo) users.push(...await SuperTokens.listUsersByAccountInfo(tenantId, accountInfo, false, userContext));
  }
  let provenRecovery: ReconcileCandidate | undefined;
  if (selected) {
    const id = await internalOwner(selected, userContext);
    const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext });
    if (id !== source.externalUserId && mapping.status !== "OK" &&
      (await getRawUserMetadata(id, userContext)).original_rownd_user?.data.user_id === source.externalUserId &&
      !readOwnerPlanCheckpoint(await getRawUserMetadata(id, userContext))) {
      await assertPinnedMappingProvenance(id, source, tenantId, userContext);
      provenRecovery = { rownd_user_id: source.externalUserId!, supertokens_user_id: id };
    }
  }
  const { candidates } = await discover(users, userContext, provenRecovery, true);
  const entries: ActivityCandidate[] = [...new Map([...initialCandidates, ...candidates].map((candidate) =>
    [`${candidate.rownd_user_id}:${candidate.supertokens_user_id}`, candidate])).values()];
  if (!entries.some((candidate) => candidate.rownd_user_id === source.externalUserId)) {
    const mapping = await SuperTokens.getUserIdMapping({ userId: source.externalUserId!, userIdType: "EXTERNAL", userContext });
    entries.push({ rownd_user_id: source.externalUserId!, ...(mapping.status === "OK" ? { supertokens_user_id: mapping.superTokensUserId } :
      provenRecovery ? { supertokens_user_id: provenRecovery.supertokens_user_id } : {}) });
  }
  const email = getMigrationContactEmail(source, tenantId);
  const survivor = checkpoint ? await SuperTokens.getUser(checkpoint.target, userContext) :
    (email ? await selectSurvivor(users, tenantId, userContext, email) : undefined) ?? selected;
  const canonicalRowndId = await survivorCanonicalId(survivor, userContext);
  const election = await inspectAdministrativeElection(entries, { canonicalRowndId, contactEmail });
  const ownerIds = new Set<string>();
  for (const user of users) {
    const id = await internalOwner(user, userContext);
    if (user === survivor || (email && user.loginMethods.some((method) => method.tenantIds.includes(tenantId) &&
      ["passwordless", "emailpassword"].includes(method.recipeId) && method.hasSameEmailAs(email))) ||
      entries.some((candidate) => candidate.supertokens_user_id === id)) ownerIds.add(id);
  }
  return { election, survivor, canonicalRowndId, ownerIds: [...ownerIds] };
}

async function assertElectionOwners(election: Awaited<ReturnType<typeof inspectAdministrativeElection>>, tenantId: string, userContext: JsonRecord) {
  clearSuperTokensCoreCallCache(userContext);
  for (const candidate of election.candidates) {
    if (!candidate.supertokens_user_id) {
      if (candidate.rownd_user_id !== election.winner.rownd_user_id &&
        ((await SuperTokens.getUserIdMapping({ userId: candidate.rownd_user_id, userIdType: "EXTERNAL", userContext })).status === "OK" ||
          await SuperTokens.getUser(candidate.rownd_user_id, userContext))) throw new RowndMigrationPolicyError("Rownd election owner changed");
      continue;
    }
    const id = candidate.supertokens_user_id;
    const user = await SuperTokens.getUser(id, userContext);
    const mapping = await SuperTokens.getUserIdMapping({ userId: candidate.rownd_user_id, userIdType: "EXTERNAL", userContext });
    if (!user) throw new RowndMigrationPolicyError("Rownd election owner changed");
    await assertMigrationOwnerGraph(user, tenantId, userContext);
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
  let conflictingHistory = false;
  if (stored.original_rownd_user && stored.original_rownd_user.data.user_id !== source.externalUserId) {
    try { conflictingHistory = !!await fetchOptionalRowndUserInfo(stored.original_rownd_user.data.user_id); } catch (error) {
      if (!(isRecord(error) && isRecord(error.response) && error.response.statusCode === 404)) throw error;
    }
  }
  if ((external.status === "OK" && external.superTokensUserId !== id) ||
      (internal.status === "OK" && internal.externalUserId !== source.externalUserId) ||
      (target !== undefined && target !== id)) throw new RowndMigrationPolicyError("The reconciliation target changed");
  if (!user || await internalOwner(user, userContext) !== id ||
      conflictingHistory || stored.rownd_migration_superseded !== undefined ||
      (getMigrationTarget(stored) !== undefined && getMigrationTarget(stored) !== id) ||
      !user.loginMethods.some((method) => method.tenantIds.includes(tenantId) &&
        source.loginMethods.some((expected) => matchesImportLoginMethod(method, expected)) &&
        (stored.original_rownd_user === undefined || mapRowndUserToSuperTokens(stored.original_rownd_user, tenantId).loginMethods.some((expected) => matchesImportLoginMethod(method, expected))))) {
    throw new RowndMigrationPolicyError("Missing mapping cannot be restored without matching live identity and migration provenance");
  }
  if (metadata.original_rownd_user && stored.original_rownd_user && !isDeepStrictEqual(
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
  if (id !== source.externalUserId) await publishFreshMapping(id, source, tenantId, userContext);
  clearSuperTokensCoreCallCache(userContext);
  await assertMigrationMapping(id, source.externalUserId!, userContext);
}

/** Reconcile one live Rownd identity using the initialized server configuration. */
export function reconcileUser(input: ReconcileUserInput): Promise<ReconcileUserResult> {
  return withReconciliationReads(() => withFreshRowndReads(() => reconcileUserWithFreshSources(input)), input?.onProgress);
}

async function discoverEmailSources(email: string, userContext: JsonRecord): Promise<ActivityCandidate[]> {
  const candidates: ActivityCandidate[] = [];
  for (const id of await findRowndUserIdsByEmail(email)) {
    const profile = await fetchOptionalRowndUserInfo(id);
    if (!profile) throw new RowndMigrationPolicyError("Rownd email discovery source disappeared; retry discovery");
    assertRowndSourcePayload(profile);
    if (profile.data.user_id !== id) throw new RowndMigrationPolicyError("SOURCE_ID_MISMATCH: email discovery returned another Rownd user");
    if ((profile.state !== undefined && profile.state !== "enabled") || profile.data.email?.toLowerCase() !== email) continue;
    await assertSelectorNamespace(id, userContext);
    const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext });
    candidates.push({ rownd_user_id: id, ...(mapping.status === "OK" ? { supertokens_user_id: mapping.superTokensUserId } : {}) });
  }
  if (!candidates.length) throw new RowndMigrationPolicyError("ROWND_EMAIL_LOOKUP_NO_MATCH: no enabled exact-email source found through verified-value lookup; use a Rownd user ID for other profiles");
  return candidates;
}

async function reconcileUserWithFreshSources(input: ReconcileUserInput): Promise<ReconcileUserResult> {
  const result: ReconcileUserResult = { status: "ERROR", changed: false, actions: [], ...(input?.dryRun === true ? {
    dryRun: true as const, canReconcile: false, matchesSource: false, proposedActions: [], blockers: [], requiresExecutionProof: [], missingMethods: [], snapshotOnly: true as const,
  } : {}) };
  let mutationStarted = false;
  let revocationProgress = false;
  try {
    validateReconcileSelector(input);
    reconciliationProgress({ stage: "discovery" });
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
    let constrainedOwner: string | undefined;
    let resolvedElection: Awaited<ReturnType<typeof inspectAdministrativeElection>> | undefined;
    let discoveredEmail: string | undefined;
    let consolidation: Awaited<ReturnType<typeof prepareOwnerConsolidation>>;
    let rowndId = input.rownd_user_id;
    if (!rowndId) {
      const selectorEmail = input.email?.trim().toLowerCase();
      const users = selectorEmail !== undefined
        ? await SuperTokens.listUsersByAccountInfo(tenantId, { email: selectorEmail }, false, userContext)
        : [await SuperTokens.getUser(input.supertokens_user_id!, userContext)].filter((user): user is User => user !== undefined);
      const discovered = await discover(users, userContext);
      const { owners } = discovered;
      let candidates = discovered.candidates;
      if (candidates.length === 0) {
        if (selectorEmail === undefined) return { ...result, status: "BLOCKED", message: "No Rownd source mapping or metadata found in SuperTokens" };
        if (!users.length) return { ...result, status: "BLOCKED", message: "No existing SuperTokens email owner found; use a Rownd user ID to import a user" };
        discoveredEmail = selectorEmail;
        candidates = await discoverEmailSources(selectorEmail, userContext);
      }
      selected = await selectSurvivor(users, tenantId, userContext, selectorEmail);
      constrainedOwner = input.supertokens_user_id && users[0] ? await internalOwner(users[0], userContext) : undefined;
      const elected = candidates.length > 1 || discoveredEmail !== undefined
        ? await inspectAdministrativeElection(candidates, { canonicalRowndId: await survivorCanonicalId(selected, userContext), contactEmail: discoveredEmail }) : undefined;
      resolvedElection = elected;
      const candidate = elected?.winner ?? candidates[0]!;
      rowndId = candidate.rownd_user_id;
      selected ??= owners.get(candidate.supertokens_user_id!);
      selectedOwner = selected ? await internalOwner(selected, userContext) : undefined;
      if (elected) result.election = { candidates: elected.candidates, basis: "latest_valid_activity", canonical_rownd_user_id: elected.canonicalRowndId };
    }
    result.rownd_user_id = rowndId;
    result.requested_rownd_user_id ??= rowndId;
    await assertSelectorNamespace(rowndId, userContext);
    const sourceMetadata = await getRawUserMetadata(rowndId, userContext);
    const sourcePlan = readOwnerPlanCheckpoint(sourceMetadata) ?? await readOwnerRecoveryCheckpoint(sourceMetadata, rowndId, userContext);
    let source = await fetchAdministrativeMigrationSource(rowndId, tenantId, userContext);
    if (!source) {
      const mapped = await SuperTokens.getUser(rowndId, userContext);
      const mappedPlan = mapped ? readOwnerPlanCheckpoint(await getRawUserMetadata(await internalOwner(mapped, userContext), userContext)) : undefined;
      if (mappedPlan && mappedPlan.status !== "COMPLETE") throw new UnresolvedConsolidationOwners(mappedPlan.candidates, "a checkpoint source disappeared");
      if (sourcePlan && sourcePlan.status !== "COMPLETE") throw new UnresolvedConsolidationOwners(sourcePlan.candidates, "a checkpoint source disappeared");
      const legacyPlan = readConsolidationCheckpoint(sourceMetadata);
      if (legacyPlan && legacyPlan.status !== "COMPLETE") throw new UnresolvedConsolidationOwners(legacyPlan.members, "a checkpoint source disappeared");
      return { ...result, status: "NOT_FOUND", message: "Live Rownd user not found" };
    }
    if (!input.dryRun) {
      const mapping = await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL", userContext });
      if (mapping.status === "OK") await recoverProviderRevocations(mapping.superTokensUserId, rowndId, tenantId, userContext, () => {
        mutationStarted = true;
        result.changed = true;
        if (!revocationProgress) result.actions.push("provider_revocations_recovered");
        revocationProgress = true;
      });
    }
    if (discoveredEmail !== undefined && getMigrationContactEmail(source, tenantId) !== discoveredEmail) throw new RowndMigrationPolicyError("Rownd email discovery source changed");
    let sourceOwner = await SuperTokens.getUser(rowndId, userContext);
    const sourceTarget = getMigrationTarget(await assertMigrationSourceActive(rowndId, userContext));
    if (sourceTarget !== undefined) {
      const pinned = await SuperTokens.getUser(sourceTarget, userContext);
      if (!pinned) throw new RowndMigrationPolicyError("MAPPING_TARGET_MISSING: reconciliation target does not exist");
      if (!sourcePlan && sourceOwner && await internalOwner(sourceOwner, userContext) !== await internalOwner(pinned, userContext)) {
        throw new RowndMigrationPolicyError("The reconciliation target changed");
      }
      sourceOwner ??= pinned;
    }
    if (sourcePlan) sourceOwner = await SuperTokens.getUser(sourcePlan.target, userContext);
    sourceOwner ??= await findRecoveryOwner(source, tenantId, userContext, true);
    const initialSourceOwner = sourceOwner ? await internalOwner(sourceOwner, userContext) : undefined;
    const initialSourceMapping = await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL", userContext });
    const inspection = await inspectSourceElection(source, sourceOwner, tenantId, userContext, resolvedElection?.candidates, discoveredEmail);
    clearSuperTokensCoreCallCache(userContext);
    if (!isDeepStrictEqual(initialSourceMapping, await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL", userContext }))) {
      result.supertokens_user_id = initialSourceOwner;
      throw new RowndMigrationPolicyError("Rownd election owner changed");
    }
    const { election } = inspection;
    selected = inspection.survivor ?? selected;
    selectedOwner = selected ? await internalOwner(selected, userContext) : undefined;
    if (election.candidates.length > 1) result.election = { candidates: election.candidates, basis: "latest_valid_activity", canonical_rownd_user_id: election.canonicalRowndId };
    {
      if (election.winner.rownd_user_id !== rowndId) {
        result.requested_rownd_user_id = rowndId;
        rowndId = election.winner.rownd_user_id;
        result.rownd_user_id = rowndId;
        await assertSelectorNamespace(rowndId, userContext);
        source = await fetchAdministrativeMigrationSource(rowndId, tenantId, userContext);
        if (!source) throw new RowndMigrationPolicyError("Rownd election source disappeared");
      }
      if (!selected && election.winner.supertokens_user_id) {
        selectedOwner = election.winner.supertokens_user_id;
        selected = await SuperTokens.getUser(selectedOwner, userContext);
      }
      result.supertokens_user_id = selectedOwner;
      if (constrainedOwner !== undefined && constrainedOwner !== selectedOwner) {
        throw new RowndMigrationPolicyError("The SuperTokens selector belongs to a different canonical Rownd owner");
      }
      if (inspection.survivor && await survivorCanonicalId(inspection.survivor, userContext) !== inspection.canonicalRowndId) {
        throw new RowndMigrationPolicyError("The survivor canonical mapping changed during election");
      }
      if (selectedOwner) {
        await inspectMappingPublication(selectedOwner, source, tenantId, userContext);
        const metadata = await getRawUserMetadata(selectedOwner, userContext);
        const mapping = await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL", userContext });
        const primaryProvider = selected?.loginMethods.find((method) => method.recipeUserId.getAsString() === selectedOwner)?.thirdParty;
        if (mapping.status !== "OK" && primaryProvider && metadata.original_rownd_user?.data.user_id === rowndId &&
          [metadata.original_rownd_user.data[`${primaryProvider.id}_id`], resolveRowndProviderSubject(metadata.original_rownd_user, primaryProvider.id)].includes(primaryProvider.userId) &&
          source.loginMethods.some((method) => method.recipeId === "thirdparty" && method.thirdPartyId === primaryProvider.id && method.thirdPartyUserId !== primaryProvider.userId)) {
          throw new RowndMigrationPolicyError("Provider retirement would delete the immutable primary recipe");
        }
        const literalSource = await getRawUserMetadata(rowndId, userContext);
        if (mapping.status !== "OK" && !readOwnerPlanCheckpoint(metadata) && literalSource.original_rownd_user && metadata.original_rownd_user &&
          literalSource.original_rownd_user.data.user_id !== metadata.original_rownd_user.data.user_id) {
          throw new RowndMigrationPolicyError("Contradictory historical snapshots cannot authorize mapping restoration");
        }
        const needsOwnerPlan = metadata.rownd_migration_owner_consolidation !== undefined || election.candidates.length > 1 ||
          inspection.ownerIds.length > 1;
        if (needsOwnerPlan) consolidation = await prepareOwnerConsolidation({ source, candidates: election.candidates,
          target: selectedOwner, ownerIds: inspection.ownerIds, tenantId, userContext });
      }
      if (!consolidation) await assertElectionOwners(election, tenantId, userContext);
      bindAdministrativeElection(source, tenantId, election, consolidation ? () => consolidation!.assertOwners() : () => assertElectionOwners(election, tenantId, userContext));
    }
    selected ??= await findRecoveryOwner(source, tenantId, userContext);
    const beforeId = selectedOwner ?? (selected ? await internalOwner(selected, userContext) : undefined);
    const publication = beforeId ? await inspectMappingPublication(beforeId, source, tenantId, userContext) : undefined;
    if (!beforeId) await assertFreshAliasVerification(source, tenantId, userContext);
    const canonicalTarget = getMigrationTarget(await assertMigrationSourceActive(rowndId, userContext));
    if (!consolidation?.managesMapping && canonicalTarget !== undefined && canonicalTarget !== beforeId) throw new RowndMigrationPolicyError("The reconciliation target changed");
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
    const restoreMapping = !consolidation?.managesMapping && beforeId !== undefined && beforeId !== rowndId && before?.mapping.status !== "OK";
    if (input.rownd_user_id && selected && !restoreMapping) {
      await assertUnambiguousSource(selected, rowndId, userContext, consolidation?.managesMapping && beforeId
        ? { rownd_user_id: rowndId, supertokens_user_id: beforeId } : undefined, source);
    }
    let methodPlan: MethodPlan | undefined;
    if (!input.dryRun) {
      const preflight = await previewReconciliation({ source, selected, internalId: beforeId, restoreMapping, tenantId, userContext,
        plannedOwnerIds: consolidation?.plannedOwnerIds, mappingPlanned: consolidation?.managesMapping,
        onMethodPlan: (plan) => { methodPlan = plan; } });
      if (preflight.blockers.length) throw new RowndMigrationPolicyError(preflight.blockers.map((entry) => entry.code).join(", "));
    }
    if (input.dryRun) {
      await assertAuthenticatedMigrationSource(source, tenantId);
      clearSuperTokensCoreCallCache(userContext);
      if (restoreMapping) selected = await inspectPinnedMappingPublication(beforeId!, source, tenantId, userContext);
      else if (beforeId && !consolidation?.managesMapping) await assertMigrationMapping(beforeId, rowndId, userContext);
      // The preview only enters read-only inspection; reconciliation and cleanup are never invoked.
      const preview = await previewReconciliation({ source, selected, internalId: beforeId, restoreMapping, tenantId, userContext,
        plannedOwnerIds: consolidation?.plannedOwnerIds, mappingPlanned: consolidation?.managesMapping });
      if (consolidation?.proposedActions.length) {
        preview.proposedActions = [...consolidation.proposedActions, ...preview.proposedActions.filter((action) => !consolidation!.proposedActions.some((existing) =>
          existing.action === action.action && existing.recipeUserId === action.recipeUserId && existing.supertokens_user_id === action.supertokens_user_id && existing.rownd_user_id === action.rownd_user_id))];
        preview.matchesSource = false;
      }
      clearSuperTokensCoreCallCache(userContext);
      if (restoreMapping) await inspectPinnedMappingPublication(beforeId!, source, tenantId, userContext);
      else if (beforeId && !consolidation?.managesMapping) await assertMigrationMapping(beforeId, rowndId, userContext);
      if (consolidation) await consolidation.assertOwners();
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
      if (publication) await publishFreshMapping(beforeId!, source, tenantId, userContext);
      const reconciled = await reconcileRowndUserWithExistingLoginMethods(source, tenantId, userContext,
        { repairUser: selected, expectedInternalUserId, onTargetSelected: pinOwner, methodPlan });
      if (!reconciled) {
        await assertAuthenticatedMigrationSource(source, tenantId);
        try {
          // With externalUserId, Core externalizes even recipe IDs in its response.
          // Import without the alias so ownership is pinned before publishing it.
          const imported = await importUser({ ...source, externalUserId: undefined }, core).finally(() => {
            for (const kind of ["user", "mapping", "metadata", "search", "verification"] as const) invalidateReconciliationReads(kind);
            clearSuperTokensCoreCallCache(userContext);
          });
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
      reconciliationProgress({ stage: "verification" });
      invalidateReconciliationReads();
      clearSuperTokensCoreCallCache(userContext);
      await assertAuthenticatedMigrationSource(source, tenantId);
      const missing = source.loginMethods.filter((expected) => !user.loginMethods.some((method) =>
        method.tenantIds.includes(tenantId) && matchesImportLoginMethod(method, expected)));
      if (missing.length) throw new RowndMigrationPolicyError("Current Rownd methods remain missing or blocked by canonical policy");
      // Administrative success requires every current Rownd method, including
      // methods the unauthenticated legacy engine may skip.
      await assertMigrationPostconditions({ internalUserId: id, source, importMethods: source.loginMethods,
        tenantId, userContext, authenticatedEmail: getAuthenticatedMigrationEmail(source, tenantId), matchesMethod: matchesImportLoginMethod });
      await assertAdministrativeMetadataBackfilled({ source, tenantId, internalUserId: id, userContext });
      if (consolidation) await consolidation.complete();
      await completeMappingPublication(id, source, tenantId, userContext);
      result.status = "OK";
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    try {
      if (operationFailed) for (const kind of ["user", "mapping", "metadata", "verification"] as const) invalidateReconciliationReads(kind);
      clearSuperTokensCoreCallCache(userContext);
      const current = await SuperTokens.getUser(rowndId, userContext);
      const id = operationFailed && consolidation?.managesMapping ? expectedInternalUserId :
        current ? await internalOwner(current, userContext) : expectedInternalUserId;
      if (id !== undefined) pinOwner(id);
      if (!current && result.status === "OK") throw new RowndMigrationPolicyError("Reconciled user disappeared during final observation");
      const after = await snapshot(id);
      if (id !== undefined && after?.user === null) throw new RowndMigrationPolicyError("Pinned reconciliation owner disappeared during final observation");
      if (after?.mapping.status === "OK" && after.mapping.superTokensUserId !== expectedInternalUserId) {
        throw new RowndMigrationPolicyError("The reconciliation target changed during final observation");
      }
      if (result.status === "OK" && expectedInternalUserId) {
        await assertMigrationMapping(expectedInternalUserId, rowndId, userContext);
        await assertAdministrativeMetadataBackfilled({ source, tenantId, internalUserId: expectedInternalUserId, userContext });
        if (consolidation) {
          await assertAuthenticatedMigrationSource(source, tenantId);
          await consolidation.assertOwners(true);
        }
      }
      if (beforeId === undefined && expectedInternalUserId !== undefined && !importedNewUser) {
        result.changed = revocationProgress ? true : null;
      } else {
        result.changed = revocationProgress || !isDeepStrictEqual(before, after);
        if (!isDeepStrictEqual(before?.user, after?.user)) result.actions.push(before ? "login_methods_reconciled" : "user_imported_or_linked");
        if (!isDeepStrictEqual(before?.mapping, after?.mapping)) result.actions.push("external_mapping_updated");
        if (!isDeepStrictEqual(before?.metadata, after?.metadata)) result.actions.push("migration_metadata_updated");
      }
    } catch (error) {
      result.changed = revocationProgress ? true : null;
      result.observationError = error instanceof Error ? error.message : "Final observation failed";
      if (!operationFailed) { operationFailed = true; operationError = error; }
    }
    if (operationFailed) throw operationError;
    return result;
  } catch (error) {
    if (revocationProgress) result.partialProgress = true;
    if (error instanceof UnresolvedConsolidationOwners) return { ...result, status: "BLOCKED", unresolved_owners: error.owners,
      ...(result.dryRun ? { blockers: [{ code: "OWNER_CONSOLIDATION_BLOCKED" }] } : {}),
      message: error.message, partialProgress: mutationStarted };
    if (error instanceof AmbiguousAdministrativeElection) return { ...result, status: "AMBIGUOUS",
      candidates: error.candidates.filter((candidate): candidate is ReconcileCandidate => candidate.supertokens_user_id !== undefined),
      election: { candidates: error.candidates, basis: "latest_valid_activity" }, message: error.message };
    if (error instanceof AmbiguousReconciliationSource) return { ...result, status: "AMBIGUOUS", candidates: error.candidates.filter((candidate): candidate is ReconcileCandidate => candidate.supertokens_user_id !== undefined) };
    const message = error instanceof Error ? error.message : "Reconciliation failed";
    return { ...result, status: error instanceof RowndMigrationPolicyError ? "BLOCKED" : "ERROR",
      ...(result.election ? { unresolved_owners: result.election.candidates } : {}),
      ...(result.dryRun ? { blockers: [{ code: message === "CANONICAL_EMAIL_POLICY" ? message : error instanceof RowndMigrationPolicyError ? "POLICY_BLOCKED" : "OBSERVATION_FAILED" }] } : {}),
      message, partialProgress: mutationStarted };
  }
}
