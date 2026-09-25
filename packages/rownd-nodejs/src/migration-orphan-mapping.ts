import { isDeepStrictEqual } from "node:util";
import { reconciliationSuperTokens as SuperTokens, reconciliationUserMetadata as UserMetadata, reconciliationEmailVerification as EmailVerification } from "./reconciliation-sdk";
import { RowndMigrationPolicyError } from "./errors";
import { fetchAdministrativeMigrationSource, getAuthenticatedMigrationEmail } from "./migration-email";
import { inspectAdministrativeElection, bindAdministrativeElection, type ActivityCandidate } from "./migration-election";
import { assertMigrationOwnerGraph } from "./migration-postconditions";
import { assertSelectorNamespace } from "./migration-mapping";
import { OWNER_POLICY_MARKER_KEYS, ownerStateAt, readOwnerPlanCheckpoint, sameOwnerPlan } from "./migration-owner-plan";
import { inspectMappingPublication } from "./migration-publication";
import { orphanCheckpointKey as key, readOrphanCheckpoint as read, sameOrphanSourceIdentity as sameSourceIdentity, sameEarlierOrphanEvidence, type OrphanRepair as Repair } from "./migration-orphan-checkpoint";
import { assertVerificationCellInheritance } from "./migration-verification";
import { getRawUserMetadata, mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { fetchOptionalRowndUserInfo, withFreshRowndReads } from "./rownd-repository";
import { previewReconciliation } from "./reconcile-preview";
import { invalidateReconciliationReads } from "./reconciliation-reads";
import { clearSuperTokensCoreCallCache, isRecord, type JsonRecord } from "./utils";
import type { ReconcileUserResult } from "./reconcile-user";

type Source = NonNullable<Awaited<ReturnType<typeof fetchAdministrativeMigrationSource>>>;
type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;

function fail(reason: string): never {
  throw new RowndMigrationPolicyError(`MAPPING_TARGET_MISSING: ORPHAN_MAPPING_RECOVERY_BLOCKED: ${reason}`);
}

function fresh(context: JsonRecord) {
  invalidateReconciliationReads();
  clearSuperTokensCoreCallCache(context);
}

function legacyEvidenceMatches(plan: Repair, observation: Awaited<ReturnType<typeof inspect>>) {
  return sameEarlierOrphanEvidence(plan, { ...plan, target: observation.target, winner: observation.election.winner.rownd_user_id,
    evidence: observation.evidence, sourceIdentity: observation.sourceIdentity });
}

async function immutable(id: string, context: JsonRecord) {
  const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext: context });
  return mapping.status === "OK" ? mapping.superTokensUserId : id;
}

async function sourceProof(id: string, tenantId: string, context: JsonRecord) {
  const profile = await fetchOptionalRowndUserInfo(id);
  const source = await fetchAdministrativeMigrationSource(id, tenantId, context);
  if (!profile || profile.data.user_id !== id || profile.state !== "enabled" || !source || !getAuthenticatedMigrationEmail(source, tenantId) ||
    !source.loginMethods.some((method) => method.recipeId === "thirdparty" && ["google", "apple"].includes(method.thirdPartyId))) {
    fail("an enabled source with exact verified current email and authoritative provider identity is required");
  }
  return { source, identity: JSON.stringify(profile) };
}

function exactProvider(source: Source, user: User, tenantId: string) {
  return source.loginMethods.some((method) => method.recipeId === "thirdparty" && ["google", "apple"].includes(method.thirdPartyId) &&
    user.loginMethods.some((existing) => existing.tenantIds.includes(tenantId) && existing.hasSameThirdPartyInfoAs({ id: method.thirdPartyId, userId: method.thirdPartyUserId })));
}

async function assertAbsent(plan: Pick<Repair, "sourceId" | "absentId" | "oldMapping">, context: JsonRecord, allowDeleted: boolean) {
  const external = await SuperTokens.getUserIdMapping({ userId: plan.sourceId, userIdType: "EXTERNAL", userContext: context });
  const internal = await SuperTokens.getUserIdMapping({ userId: plan.absentId, userIdType: "SUPERTOKENS", userContext: context });
  const collision = await SuperTokens.getUserIdMapping({ userId: plan.sourceId, userIdType: "SUPERTOKENS", userContext: context });
  const absentAlias = await SuperTokens.getUserIdMapping({ userId: plan.absentId, userIdType: "EXTERNAL", userContext: context });
  if (collision.status === "OK" || absentAlias.status === "OK" || await SuperTokens.getUser(plan.absentId, context)) fail("the old target reappeared or the selector namespace changed");
  const matches = (mapping: typeof external) => mapping.status === "OK" &&
    mapping.superTokensUserId === plan.oldMapping.superTokensUserId && mapping.externalUserId === plan.oldMapping.externalUserId &&
    mapping.externalUserIdInfo === plan.oldMapping.externalUserIdInfo;
  if (external.status === "OK" || internal.status === "OK") {
    if (!matches(external)) fail("the external orphan mapping changed");
    if (!matches(internal)) fail("the internal orphan mapping changed");
    if (await SuperTokens.getUser(plan.sourceId, context)) fail("the orphan selector now resolves to a live user");
    return true;
  }
  if (!allowDeleted || await SuperTokens.getUser(plan.sourceId, context)) fail("the orphan mapping disappeared without a checkpoint");
  return false;
}

async function inspect(sourceId: string, absentId: string, tenantId: string, context: JsonRecord) {
  if (tenantId !== "public") fail("recovery requires the public tenant");
  const { source, identity: sourceIdentity } = await sourceProof(sourceId, tenantId, context);
  const email = getAuthenticatedMigrationEmail(source, tenantId)!;
  const users = new Map<string, User>();
  for (const info of [{ email }, ...source.loginMethods.flatMap((method) => method.recipeId === "thirdparty" && ["google", "apple"].includes(method.thirdPartyId)
    ? [{ thirdParty: { id: method.thirdPartyId, userId: method.thirdPartyUserId } }] : [])]) {
    for (const user of await SuperTokens.listUsersByAccountInfo(tenantId, info, false, context)) users.set(await immutable(user.id, context), user);
  }
  if (users.size !== 1) fail("exact identity discovery requires one live owner");
  const [target, user] = [...users.entries()][0]!;
  if (!user.isPrimaryUser || target === absentId || !exactProvider(source, user, tenantId) || !user.loginMethods.some((method) =>
    method.tenantIds.includes(tenantId) && method.verified && method.hasSameEmailAs(email))) fail("the live owner does not match the authoritative provider and verified current email");
  await assertMigrationOwnerGraph(user, tenantId, context);
  const ids = new Set([target, user.id, sourceId, absentId]);
  const aliases = new Map<string, string>();
  const recipes = [];
  for (const method of user.loginMethods) {
    const id = await immutable(method.recipeUserId.getAsString(), context);
    if (method.tenantIds.length !== 1 || method.tenantIds[0] !== tenantId) fail("recipe tenant membership changed");
    ids.add(id);
    recipes.push({ id, recipeId: method.recipeId, email: method.email, phoneNumber: method.phoneNumber,
      thirdParty: method.thirdParty, verified: method.verified, tenantIds: method.tenantIds, timeJoined: method.timeJoined, webauthn: method.webauthn });
    const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext: context });
    if (mapping.status === "OK") {
      const forward = await SuperTokens.getUserIdMapping({ userId: mapping.externalUserId, userIdType: "EXTERNAL", userContext: context });
      if (!isDeepStrictEqual(forward, mapping)) fail("recipe alias is not bidirectional");
      aliases.set(mapping.externalUserId, id);
      ids.add(mapping.externalUserId);
    }
  }
  const metadata: Record<string, JsonRecord> = {};
  const mappings = [];
  for (const id of ids) {
    if (id !== sourceId && id !== absentId) {
      await assertSelectorNamespace(id, context);
      mappings.push({ id, external: await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext: context }),
        internal: await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext: context }) });
    }
    const stored = { ...await getRawUserMetadata(id, context) };
    delete stored[key];
    if (stored.rownd_migration_superseded !== undefined || stored.rownd_migration_owner_consolidation !== undefined ||
      stored.rownd_migration_mapping_publication !== undefined ||
      (id === sourceId && stored.rownd_migration_canonical_target !== undefined) ||
      (stored.rownd_migration_canonical_target !== undefined && stored.rownd_migration_canonical_target !== target) ||
      (stored.rownd_migration_target !== undefined && ![target, ...(id === sourceId ? [absentId] : [])].includes(stored.rownd_migration_target as string))) fail("conflicting migration metadata requires separate recovery");
    metadata[id] = stored;
  }
  const candidates: ActivityCandidate[] = [{ rownd_user_id: sourceId }];
  const profiles: Record<string, unknown> = {};
  for (const id of new Set([...aliases.keys(), ...Object.values(metadata).flatMap((stored) => {
    const historical = isRecord(stored.original_rownd_user) && isRecord(stored.original_rownd_user.data) ? stored.original_rownd_user.data.user_id : undefined;
    return typeof historical === "string" ? [historical] : [];
  })])) {
    if (id === sourceId) continue;
    if (!aliases.has(id)) fail("unmapped historical replacement provenance requires separate recovery");
    const profile = await fetchOptionalRowndUserInfo(id);
    const other = await fetchAdministrativeMigrationSource(id, tenantId, context);
    if (!profile || profile.state !== "enabled" || !other || !exactProvider(other, user, tenantId)) fail("replacement alias or provenance lacks live exact provider proof");
    profiles[id] = profile;
    candidates.push({ rownd_user_id: id, ...(aliases.has(id) ? { supertokens_user_id: aliases.get(id)! } : {}) });
  }
  const canonical = [...aliases].find(([, id]) => id === target)?.[0];
  const election = await inspectAdministrativeElection(candidates, { canonicalRowndId: canonical });
  const elected = election.winner.rownd_user_id === sourceId ? source : await fetchAdministrativeMigrationSource(election.winner.rownd_user_id, tenantId, context);
  if (!elected) fail("elected source disappeared");
  bindAdministrativeElection(elected, tenantId, election, async () => {});
  const verifications = [];
  const emails = new Set([email, ...recipes.flatMap((method) => method.email ? [method.email] : [])]);
  for (const id of ids) for (const address of emails) verifications.push({ id, email: address,
    verified: await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(id), address, context) });
  const primary = recipes.find((recipe) => recipe.id === target);
  if (!primary) fail("immutable primary recipe is missing");
  for (const address of emails) {
    const baseline = primary.email === address && primary.verified;
    const effective = verifications.find((cell) => cell.id === election.winner.rownd_user_id && cell.email === address)!.verified;
    assertVerificationCellInheritance(address, baseline, effective, getAuthenticatedMigrationEmail(elected, tenantId));
  }
  const preview = await previewReconciliation({ source: elected, selected: user, internalId: target, restoreMapping: false,
    mappingPlanned: true, plannedOwnerIds: new Set(ids), tenantId, userContext: context });
  if (preview.blockers.length) fail(preview.blockers.map((entry) => entry.code).join(", "));
  const newEmailProof = getAuthenticatedMigrationEmail(elected, tenantId);
  const checkpointedEmailCreation = canonical !== undefined && election.winner.rownd_user_id === sourceId &&
    preview.missingMethods.every((method) => method.recipeId === "passwordless" && method.email === newEmailProof && newEmailProof !== undefined);
  if ((preview.missingMethods.length && !checkpointedEmailCreation) || preview.proposedActions.some((action) => ["review_provider_retirement", "review_email_retirement"].includes(action.action))) {
    fail("method creation or retirement requires separate recovery before orphan retargeting");
  }
  const orphan = await SuperTokens.getUserIdMapping({ userId: sourceId, userIdType: "EXTERNAL", userContext: context });
  if (orphan.status === "OK" && orphan.superTokensUserId === absentId) {
    preview.proposedActions.unshift({ action: "remove_mapping", rownd_user_id: sourceId, supertokens_user_id: absentId });
  }
  if (canonical !== election.winner.rownd_user_id) {
    if (canonical) {
      preview.proposedActions.push({ action: "remove_mapping", rownd_user_id: canonical, supertokens_user_id: target, conditional: true });
      preview.proposedActions.push({ action: "restore_mapping", rownd_user_id: canonical, conditional: true });
    }
    preview.proposedActions.push({ action: "create_mapping", rownd_user_id: election.winner.rownd_user_id, supertokens_user_id: target, conditional: true });
  }
  preview.proposedActions.push({ action: "update_migration_metadata", rownd_user_id: sourceId, supertokens_user_id: target });
  preview.requiresExecutionProof.push({ code: "ORPHAN_MAPPING_HANDOFF_REQUIRES_EXECUTION_PROOF", supertokens_user_id: target });
  preview.canReconcile = false;
  preview.matchesSource = false;
  return { target, election, preview, sourceIdentity, evidence: JSON.stringify({ sourceIdentity, target, primary: user.isPrimaryUser,
    recipes, aliases: [...aliases], mappings, metadata, profiles, verifications, election: election.candidates, winner: election.winner.rownd_user_id }) };
}

async function assertRequestedHandoffOwnership(plan: Repair, context: JsonRecord) {
  const external = await SuperTokens.getUserIdMapping({ userId: plan.sourceId, userIdType: "EXTERNAL", userContext: context });
  const internal = await SuperTokens.getUserIdMapping({ userId: plan.sourceId, userIdType: "SUPERTOKENS", userContext: context });
  const absentExternal = await SuperTokens.getUserIdMapping({ userId: plan.absentId, userIdType: "EXTERNAL", userContext: context });
  const absentInternal = await SuperTokens.getUserIdMapping({ userId: plan.absentId, userIdType: "SUPERTOKENS", userContext: context });
  if (internal.status === "OK" || absentExternal.status === "OK" || absentInternal.status === "OK" ||
    await SuperTokens.getUser(plan.absentId, context)) fail("requested source namespace changed during handoff");
  if (external.status === "OK") {
    const reverse = await SuperTokens.getUserIdMapping({ userId: external.superTokensUserId, userIdType: "SUPERTOKENS", userContext: context });
    if (!isDeepStrictEqual(external, reverse)) fail("requested source ownership changed during handoff");
    if (plan.phase === "COMPLETE") {
      const owner = await SuperTokens.getUser(external.superTokensUserId, context);
      if (!owner || await immutable(owner.id, context) !== plan.target) fail("completed requested source ownership changed");
    } else if (plan.winner !== plan.sourceId || external.superTokensUserId !== plan.target) fail("requested source ownership changed during handoff");
  } else if (await SuperTokens.getUser(plan.sourceId, context)) fail("requested source namespace changed during handoff");
  const stored = await getRawUserMetadata(plan.sourceId, context);
  if (!isDeepStrictEqual(read(stored), plan)) fail("requested source checkpoint changed during handoff");
  const baseline = JSON.parse(plan.evidence) as { metadata: Record<string, JsonRecord> };
  const expected = { ...baseline.metadata[plan.sourceId]! };
  delete expected.rownd_migration_target;
  const actual = { ...stored };
  delete actual[key];
  const recipeTarget = plan.phase === "COMPLETE" && external.status === "OK" ? external.superTokensUserId : plan.target;
  if ((actual.rownd_migration_target !== undefined && ![plan.target, recipeTarget].includes(actual.rownd_migration_target as string)) ||
    (actual.rownd_migration_canonical_target !== undefined && actual.rownd_migration_canonical_target !== plan.target)) fail("requested source ownership markers changed during handoff");
  if (plan.phase === "COMPLETE") {
    if (external.status === "OK") return plan.sourceId;
    const retirement = actual.rownd_migration_superseded;
    if (!isRecord(retirement) || typeof retirement.rowndUserId !== "string" || retirement.rowndUserId === plan.sourceId ||
      retirement.targetUserId !== plan.target) fail("completed requested source retirement changed");
    const canonical = await SuperTokens.getUserIdMapping({ userId: retirement.rowndUserId, userIdType: "EXTERNAL", userContext: context });
    const reverse = await SuperTokens.getUserIdMapping({ userId: plan.target, userIdType: "SUPERTOKENS", userContext: context });
    if (canonical.status !== "OK" || canonical.superTokensUserId !== plan.target || !isDeepStrictEqual(canonical, reverse)) fail("completed requested source retirement changed");
    return retirement.rowndUserId;
  }
  if (isDeepStrictEqual(actual, expected)) return;
  const owner = readOwnerPlanCheckpoint(await getRawUserMetadata(plan.target, context));
  if (owner && owner.sourceId === plan.winner && owner.target === plan.target && owner.candidates.some((candidate) => candidate.rownd_user_id === plan.sourceId)) {
    const fields = ["original_rownd_user", "rownd_migration_target", "rownd_migration_canonical_target", "rownd_migration_superseded", "rownd_migration_reconciliation", ...OWNER_POLICY_MARKER_KEYS];
    const initial = owner.initial.markers.find((marker) => marker.id === plan.sourceId);
    const initialExpected = Object.fromEntries(fields.filter((field) => expected[field] !== undefined).map((field) => [field, expected[field]]));
    if (!initial || !isDeepStrictEqual(initial.values, initialExpected)) fail("normal owner receipt does not match requested source baseline");
    const reservation = readOwnerPlanCheckpoint(stored);
    if (actual.rownd_migration_owner_consolidation !== undefined && (!reservation || reservation.reservation !== true || !sameOwnerPlan(owner, reservation))) fail("requested source reservation changed");
    const states = owner.status === "COMPLETE" && owner.completion ? [owner.completion.state] : [ownerStateAt(owner),
      ...(owner.cursor < owner.operations.length && owner.operations[owner.cursor]?.kind === "metadata" ? [ownerStateAt(owner, owner.cursor + 1)] : [])];
    for (const state of states) {
      const marker = state.markers.find((entry) => entry.id === plan.sourceId);
      if (!marker) continue;
      const receipted = { ...expected };
      for (const field of fields) { delete receipted[field]; if (marker.values[field] !== undefined) receipted[field] = marker.values[field]; }
      if (reservation) receipted.rownd_migration_owner_consolidation = actual.rownd_migration_owner_consolidation;
      if (actual.rownd_migration_owner_recovery !== undefined && isDeepStrictEqual(actual.rownd_migration_owner_recovery, { target: owner.target, planId: owner.id })) {
        receipted.rownd_migration_owner_recovery = actual.rownd_migration_owner_recovery;
      }
      if (isDeepStrictEqual(receipted, actual)) return;
    }
  }
  if (plan.winner === plan.sourceId) {
    const source = await fetchAdministrativeMigrationSource(plan.sourceId, plan.tenantId, context);
    if (source && await inspectMappingPublication(plan.target, source, plan.tenantId, context)) {
      const receipted = { ...expected };
      for (const field of ["rownd_migration_target", "rownd_migration_canonical_target"]) if (actual[field] === plan.target) receipted[field] = plan.target;
      if (isDeepStrictEqual(receipted, actual)) return;
    }
  }
  fail("requested source metadata changed without a matching normal checkpoint receipt");
}

async function handoffSnapshot(plan: Repair, context: JsonRecord) {
  fresh(context);
  await assertRequestedHandoffOwnership(plan, context);
  if (await SuperTokens.getUser(plan.absentId, context)) fail("the absent recipe reappeared during handoff");
  if (!sameSourceIdentity(plan.sourceIdentity, (await sourceProof(plan.sourceId, plan.tenantId, context)).identity)) fail("handoff requested source changed");
  const baseline: unknown = JSON.parse(plan.evidence);
  if (!isRecord(baseline) || !Array.isArray(baseline.recipes) || !isRecord(baseline.metadata) || !isRecord(baseline.profiles)) fail("invalid handoff evidence");
  const user = await SuperTokens.getUser(plan.target, context);
  if (!user || !user.isPrimaryUser || await immutable(user.id, context) !== plan.target) fail("handoff primary ownership changed");
  const recipes = [];
  for (const method of user.loginMethods) recipes.push({ id: await immutable(method.recipeUserId.getAsString(), context), recipeId: method.recipeId,
    email: method.email, phoneNumber: method.phoneNumber, thirdParty: method.thirdParty, tenantIds: method.tenantIds,
    timeJoined: method.timeJoined, webauthn: method.webauthn });
  const stable = (entries: unknown[]) => entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") fail("invalid recipe evidence");
    const copy = { ...entry };
    delete copy.verified;
    return copy;
  }).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const originalIds = new Set(baseline.recipes.map((recipe) => isRecord(recipe) ? recipe.id : undefined));
  if (JSON.stringify(stable(recipes.filter((recipe) => originalIds.has(recipe.id)))) !== JSON.stringify(stable(baseline.recipes))) fail("handoff immutable recipe graph changed");
  const extras = recipes.filter((recipe) => !originalIds.has(recipe.id));
  if (extras.length) {
    const ownerPlan = readOwnerPlanCheckpoint(await getRawUserMetadata(plan.target, context));
    if (!ownerPlan || ownerPlan.sourceId !== plan.winner || ownerPlan.target !== plan.target || extras.some((recipe) =>
      !ownerPlan.createdRecipes?.some((created) => created.id === recipe.id && created.identity === JSON.stringify([
        recipe.recipeId, recipe.email, recipe.phoneNumber, recipe.thirdParty, [...recipe.tenantIds].sort(), recipe.timeJoined, recipe.webauthn,
      ])))) fail("handoff immutable recipe graph changed without a normal creation receipt");
  }
  await assertMigrationOwnerGraph(user, plan.tenantId, context);
  for (const [id, expected] of Object.entries(baseline.profiles)) {
    if (!isDeepStrictEqual(await fetchOptionalRowndUserInfo(id), expected)) fail("handoff alias source changed");
  }
  const state = [];
  for (const id of Object.keys(baseline.metadata)) state.push({ id, metadata: await getRawUserMetadata(id, context),
    external: await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext: context }),
    internal: await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext: context }) });
  const verifications = [];
  if (!Array.isArray(baseline.verifications)) fail("invalid verification evidence");
  for (const cell of baseline.verifications) {
    if (!isRecord(cell) || typeof cell.id !== "string" || typeof cell.email !== "string") fail("invalid verification evidence");
    verifications.push({ id: cell.id, email: cell.email,
      verified: await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(cell.id), cell.email, context) });
  }
  return JSON.stringify({ state, user, verifications });
}

/** Only administrative entry calls this; normal mapping and donor guards stay strict. */
export async function recoverOrphanMapping(input: {
  sourceId: string; tenantId: string; userContext: JsonRecord; dryRun?: boolean;
  onMutation: () => void; reconcile: (sourceId: string, target: string, assertReady: () => Promise<void>, pinnedWinner?: string) => Promise<ReconcileUserResult>;
}): Promise<ReconcileUserResult | undefined> {
  const { sourceId, tenantId, userContext: context } = input;
  fresh(context);
  let plan = read(await getRawUserMetadata(sourceId, context));
  const mapping = await SuperTokens.getUserIdMapping({ userId: sourceId, userIdType: "EXTERNAL", userContext: context });
  if (!plan && (mapping.status !== "OK" || await SuperTokens.getUser(mapping.superTokensUserId, context))) return undefined;
  if (plan && (plan.sourceId !== sourceId || plan.tenantId !== tenantId)) fail("checkpoint selector changed");
  if (plan && plan.absence === undefined) {
    const legacy = plan;
    await assertAbsent(plan, context, true);
    const observed = await withFreshRowndReads(() => inspect(sourceId, legacy.absentId, tenantId, context));
    if (!legacyEvidenceMatches(plan, observed)) fail("earlier checkpoint evidence changed; automatic upgrade is not proven");
    if (input.dryRun) return { ...observed.preview, rownd_user_id: plan.winner, requested_rownd_user_id: sourceId,
      election: { candidates: observed.election.candidates, basis: "latest_valid_activity", canonical_rownd_user_id: observed.election.canonicalRowndId } };
    fresh(context);
    const rechecked = await withFreshRowndReads(() => inspect(sourceId, legacy.absentId, tenantId, context));
    if (!legacyEvidenceMatches(plan, rechecked) || !isDeepStrictEqual(read(await getRawUserMetadata(sourceId, context)), plan)) fail("earlier checkpoint changed before upgrade");
    await assertAbsent(plan, context, true);
    const upgraded: Repair = { ...plan, absence: { externalSelector: true, internalTarget: true }, previousCheckpoint: JSON.stringify(plan),
      evidence: rechecked.evidence, sourceIdentity: rechecked.sourceIdentity };
    input.onMutation();
    await UserMetadata.updateUserMetadata(sourceId, { [key]: upgraded, ...(plan.phase === "HANDOFF" ? { rownd_migration_target: null } : {}) }, context);
    plan = upgraded;
  }
  if (!plan || plan.phase === "PREPARED") {
    const oldMapping = plan?.oldMapping ?? (mapping.status === "OK" ? { superTokensUserId: mapping.superTokensUserId,
      externalUserId: mapping.externalUserId, ...(mapping.externalUserIdInfo !== undefined ? { externalUserIdInfo: mapping.externalUserIdInfo } : {}) } : fail("missing orphan mapping"));
    const absentId = oldMapping.superTokensUserId;
    await assertAbsent({ sourceId, absentId, oldMapping }, context, plan !== undefined);
    const observation = await withFreshRowndReads(() => inspect(sourceId, absentId, tenantId, context));
    const next: Repair = { version: 1, sourceId, absentId, oldMapping, target: observation.target, tenantId,
      winner: observation.election.winner.rownd_user_id, phase: "PREPARED", absence: { externalSelector: true, internalTarget: true },
      ...(plan?.previousCheckpoint ? { previousCheckpoint: plan.previousCheckpoint } : {}),
      evidence: observation.evidence, sourceIdentity: observation.sourceIdentity };
    if (plan && !isDeepStrictEqual(plan, next)) fail("checkpoint evidence changed before retirement");
    if (input.dryRun) return { ...observation.preview, rownd_user_id: next.winner, requested_rownd_user_id: sourceId,
      election: { candidates: observation.election.candidates, basis: "latest_valid_activity", canonical_rownd_user_id: observation.election.canonicalRowndId } };
    if (!plan) {
      input.onMutation();
      await UserMetadata.updateUserMetadata(sourceId, { [key]: next }, context);
      plan = next;
    }
    fresh(context);
    const rechecked = await withFreshRowndReads(() => inspect(sourceId, absentId, tenantId, context));
    if (rechecked.evidence !== plan.evidence || !isDeepStrictEqual(read(await getRawUserMetadata(sourceId, context)), plan)) fail("durable evidence changed before retirement");
    // Core has no compare-and-delete. Check both literal directions and absence
    // immediately before deleting by external ID, never by the missing recipe ID.
    fresh(context);
    if (await assertAbsent(plan, context, true)) {
      input.onMutation();
      await SuperTokens.deleteUserIdMapping({ userId: sourceId, userIdType: "EXTERNAL", force: true, userContext: context });
    }
    fresh(context);
    if (await assertAbsent(plan, context, true)) fail("mapping retirement incomplete");
    const retired = await withFreshRowndReads(() => inspect(sourceId, absentId, tenantId, context));
    if (retired.evidence !== plan.evidence || !isDeepStrictEqual(read(await getRawUserMetadata(sourceId, context)), plan)) fail("evidence changed after orphan retirement");
    plan = { ...plan, phase: "HANDOFF" };
    input.onMutation();
    await UserMetadata.updateUserMetadata(sourceId, { [key]: plan, rownd_migration_target: null }, context);
  }
  fresh(context);
  const requestedSource = await assertRequestedHandoffOwnership(plan, context) ?? plan.winner;
  if (await SuperTokens.getUser(plan.absentId, context)) fail("the absent recipe reappeared during handoff");
  const currentMapping = await SuperTokens.getUserIdMapping({ userId: sourceId, userIdType: "EXTERNAL", userContext: context });
  if (plan.phase !== "COMPLETE" && currentMapping.status === "OK" && (plan.winner !== sourceId || currentMapping.superTokensUserId !== plan.target)) fail("the retired alias was remapped");
  const target = await SuperTokens.getUser(plan.target, context);
  if (!target || !target.isPrimaryUser || await immutable(target.id, context) !== plan.target) fail("the replacement owner changed during handoff");
  if (plan.phase !== "COMPLETE") {
    const proof = await withFreshRowndReads(() => sourceProof(sourceId, tenantId, context));
    if (!sameSourceIdentity(plan.sourceIdentity, proof.identity) || !exactProvider(proof.source, target, tenantId)) fail("source identity changed during handoff");
  } else if (currentMapping.status !== "OK") {
    const profile = await withFreshRowndReads(() => fetchOptionalRowndUserInfo(sourceId));
    const email = profile?.data.email;
    const verifiedEmail = profile?.verified_data?.email;
    if (!profile || profile.state !== "enabled" || profile.data.user_id !== sourceId || !email ||
      !(verifiedEmail === true || (typeof verifiedEmail === "string" && verifiedEmail.toLowerCase() === email.toLowerCase())) ||
      !target.loginMethods.some((method) => method.verified && method.hasSameEmailAs(email)) ||
      !exactProvider(mapRowndUserToSuperTokens(profile, tenantId), target, tenantId)) fail("completed recovery source ownership changed");
  }
  const handoff = plan.phase !== "COMPLETE" ? await withFreshRowndReads(() => handoffSnapshot(plan, context)) : undefined;
  const assertReady = async () => {
    if (handoff !== undefined && await withFreshRowndReads(() => handoffSnapshot(plan, context)) !== handoff) fail("handoff evidence changed before normal execution");
    if (plan.phase === "COMPLETE") {
      fresh(context);
      if (await assertRequestedHandoffOwnership(plan, context) !== requestedSource) fail("completed requested source ownership changed before normal execution");
    }
  };
  // Once handed off, publication/owner checkpoints own their graph transitions.
  // The orphan checkpoint never manufactures an absent recipe in those graphs.
  // Completed receipts retain the recovered owner, not a permanent activity winner.
  const result = await input.reconcile(requestedSource, plan.target, assertReady, plan.phase !== "COMPLETE" ? plan.winner : undefined);
  if (input.dryRun && plan.phase !== "COMPLETE") return { ...result, requested_rownd_user_id: sourceId, canReconcile: false, matchesSource: false,
    proposedActions: [...(result.proposedActions ?? []), { action: "update_migration_metadata", rownd_user_id: sourceId, supertokens_user_id: plan.target }],
    requiresExecutionProof: [...(result.requiresExecutionProof ?? []), { code: "ORPHAN_MAPPING_HANDOFF_REQUIRES_EXECUTION_PROOF", supertokens_user_id: plan.target }] };
  if (result.status === "OK" && (result.supertokens_user_id !== plan.target || (plan.phase !== "COMPLETE" && result.rownd_user_id !== plan.winner))) fail("the normal reconciliation changed the pinned owner election");
  if (!input.dryRun && result.status === "OK" && plan.phase !== "COMPLETE") {
    fresh(context);
    await assertRequestedHandoffOwnership(plan, context);
    input.onMutation();
    await UserMetadata.updateUserMetadata(sourceId, { [key]: { ...plan, phase: "COMPLETE" },
      ...(plan.winner !== sourceId ? { rownd_migration_superseded: { rowndUserId: plan.winner, targetUserId: plan.target } } : {}) }, context);
  }
  return { ...result, requested_rownd_user_id: sourceId,
    ...(!input.dryRun && plan.phase !== "COMPLETE" ? { changed: result.status === "OK" ? true : null,
      partialProgress: result.status !== "OK", actions: ["orphan_mapping_retired", ...result.actions] } : {}) };
}
