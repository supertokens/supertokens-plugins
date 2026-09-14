import SuperTokens from "supertokens-node";
import { isDeepStrictEqual } from "node:util";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { RowndMigrationPolicyError } from "./errors";
import { assertAuthenticatedMigrationSource, assertRowndSourcePayload, getAuthenticatedMigrationEmail, getMigrationContactEmail, isAdministrativeMigration, isRowndMigrationProfileActive } from "./migration-email";
import { isAdministrativeElectionCandidate, type ActivityCandidate } from "./migration-election";
import { assertMigrationMapping, assertSelectorNamespace } from "./migration-mapping";
import { assertMigrationOwnerGraph } from "./migration-postconditions";
import { getRawUserMetadata, mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { fetchOptionalRowndUserInfo } from "./rownd-repository";
import { matchesImportLoginMethod } from "./supertokens-repository";
import { clearSuperTokensCoreCallCache, isRecord, type JsonRecord } from "./utils";
import type { SuperTokensUserImport } from "./types";
import type { ReconcilePreviewAction } from "./reconcile-preview";

type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type Member = { rownd_user_id: string; supertokens_user_id: string; identity: string; unverifiedEmail?: string };
// Retain discovery across partial links; retries still require a fresh private election.
type Checkpoint = { version: 1; winner: string; target: string; members: Member[]; status: "LINKING" | "COMPLETE" };
const key = "rownd_migration_owner_consolidation";

export class UnresolvedConsolidationOwners extends RowndMigrationPolicyError {
  constructor(readonly owners: ActivityCandidate[], reason: string) {
    super(`Duplicate owner consolidation blocked: ${reason}`);
  }
}

export function readConsolidationCheckpoint(metadata: JsonRecord): Checkpoint | undefined {
  const record = metadata[key];
  if (record === undefined) return undefined;
  if (!isRecord(record) || record.version !== 1 || typeof record.winner !== "string" || typeof record.target !== "string" ||
    !["LINKING", "COMPLETE"].includes(String(record.status)) || !Array.isArray(record.members) || record.members.length < 2 ||
    record.members.some((member) => !isRecord(member) || typeof member.rownd_user_id !== "string" ||
      typeof member.supertokens_user_id !== "string" || typeof member.identity !== "string" ||
      (member.unverifiedEmail !== undefined && typeof member.unverifiedEmail !== "string"))) {
    throw new RowndMigrationPolicyError("Invalid duplicate owner consolidation checkpoint");
  }
  const checkpoint = record as Checkpoint;
  if (new Set(checkpoint.members.map((member) => member.rownd_user_id)).size !== checkpoint.members.length ||
    new Set(checkpoint.members.map((member) => member.supertokens_user_id)).size !== checkpoint.members.length ||
    !checkpoint.members.some((member) => member.rownd_user_id === checkpoint.winner && member.supertokens_user_id === checkpoint.target)) {
    throw new RowndMigrationPolicyError("Invalid duplicate owner consolidation checkpoint");
  }
  return checkpoint;
}

async function recipeMethod(user: User, internalId: string, userContext: JsonRecord) {
  for (const method of user.loginMethods) {
    const mapping = await SuperTokens.getUserIdMapping({ userId: method.recipeUserId.getAsString(), userIdType: "ANY", userContext });
    if ((mapping.status === "OK" ? mapping.superTokensUserId : method.recipeUserId.getAsString()) === internalId) {
      return method;
    }
  }
  return undefined;
}

async function recipeIdentity(user: User, internalId: string, userContext: JsonRecord) {
  const method = await recipeMethod(user, internalId, userContext);
  return method && JSON.stringify([method.recipeId, method.email, method.phoneNumber, method.thirdParty, [...method.tenantIds].sort()]);
}

export async function assertConsolidationSessionMembership(userId: string, recipeUserId: string, tenantId: string, userContext: JsonRecord) {
  clearSuperTokensCoreCallCache(userContext);
  const user = await SuperTokens.getUser(userId, userContext);
  const recipeOwner = await SuperTokens.getUser(recipeUserId, userContext);
  const ids = new Set([userId, recipeUserId, ...[user, recipeOwner].flatMap((owner) => owner
    ? [owner.id, ...owner.loginMethods.map((method) => method.recipeUserId.getAsString())] : [])]);
  const checkpoints: Checkpoint[] = [];
  for (const id of ids) {
    const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "ANY", userContext });
    if (mapping.status === "OK") {
      ids.add(mapping.superTokensUserId);
      ids.add(mapping.externalUserId);
    }
    const checkpoint = readConsolidationCheckpoint(await getRawUserMetadata(id, userContext));
    if (checkpoint) checkpoints.push(checkpoint);
  }
  if (!checkpoints.length) return;
  const checkpoint = checkpoints[0]!;
  const fail = (): never => { throw new RowndMigrationPolicyError("Owner consolidation is incomplete or session membership changed"); };
  if (checkpoints.some((entry) => entry.status !== "COMPLETE" || !isDeepStrictEqual(entry, checkpoint)) ||
    !user || !recipeOwner || userId !== checkpoint.winner || user.id !== checkpoint.winner || recipeOwner.id !== user.id || !user.isPrimaryUser) fail();
  const recipeMapping = await SuperTokens.getUserIdMapping({ userId: recipeUserId, userIdType: "ANY", userContext });
  const method = await recipeMethod(user!, recipeMapping.status === "OK" ? recipeMapping.superTokensUserId : recipeUserId, userContext);
  if (!method?.tenantIds.includes(tenantId)) fail();
  for (const member of checkpoint.members) {
    await assertSelectorNamespace(member.rownd_user_id, userContext);
    await assertSelectorNamespace(member.supertokens_user_id, userContext);
    await assertMigrationMapping(member.supertokens_user_id, member.rownd_user_id, userContext);
    const owner = await SuperTokens.getUser(member.supertokens_user_id, userContext);
    if (!owner || owner.id !== checkpoint.winner || !owner.isPrimaryUser ||
      await recipeIdentity(owner, member.supertokens_user_id, userContext) !== member.identity) fail();
  }
  await assertMigrationOwnerGraph(user!, tenantId, userContext);
  if (!isDeepStrictEqual(readConsolidationCheckpoint(await getRawUserMetadata(checkpoint.target, userContext)), checkpoint)) fail();
}

export async function resolveConsolidatedTokenOwner(source: SuperTokensUserImport, tenantId: string, userContext: JsonRecord) {
  const alias = source.externalUserId!;
  clearSuperTokensCoreCallCache(userContext);
  const user = await SuperTokens.getUser(alias, userContext);
  if (!user) return undefined;
  const mapping = await SuperTokens.getUserIdMapping({ userId: user.id, userIdType: "EXTERNAL", userContext });
  const target = mapping.status === "OK" ? mapping.superTokensUserId : user.id;
  const metadata = await getRawUserMetadata(target, userContext);
  const checkpoint = readConsolidationCheckpoint(metadata);
  // Existing, unrelated linked aliases still use their original migration path.
  if (!checkpoint) return undefined;
  const fail = (): never => { throw new RowndMigrationPolicyError("Consolidated Rownd alias ownership could not be verified"); };
  if (tenantId !== "public" || checkpoint.status !== "COMPLETE" || checkpoint.target !== target || checkpoint.winner !== user.id ||
    metadata.original_rownd_user?.data.user_id !== user.id || !checkpoint.members.some((member) => member.rownd_user_id === alias)) fail();
  await assertAuthenticatedMigrationSource(source, tenantId);
  for (const member of checkpoint.members) {
    await assertSelectorNamespace(member.rownd_user_id, userContext);
    await assertSelectorNamespace(member.supertokens_user_id, userContext);
    await assertMigrationMapping(member.supertokens_user_id, member.rownd_user_id, userContext);
    const owner = await SuperTokens.getUser(member.rownd_user_id, userContext);
    if (!owner || owner.id !== user.id || await recipeIdentity(owner, member.supertokens_user_id, userContext) !== member.identity) fail();
  }
  await assertMigrationOwnerGraph(user, tenantId, userContext);
  if (JSON.stringify(readConsolidationCheckpoint(await getRawUserMetadata(target, userContext))) !== JSON.stringify(checkpoint)) fail();
  if (user.id === alias) return undefined;
  const canonical = await fetchOptionalRowndUserInfo(checkpoint.winner);
  if (!canonical) fail();
  assertRowndSourcePayload(canonical!);
  if (canonical!.data.user_id !== checkpoint.winner || !isRowndMigrationProfileActive(canonical!)) fail();
  const email = getMigrationContactEmail(source, tenantId);
  const methods = mapRowndUserToSuperTokens(canonical!, tenantId).loginMethods;
  const shared = (email !== undefined && canonical!.data.email?.toLowerCase() === email) || source.loginMethods.some((method) =>
    method.recipeId === "thirdparty" && ["google", "apple"].includes(method.thirdPartyId) && methods.some((other) =>
      other.recipeId === "thirdparty" && other.thirdPartyId === method.thirdPartyId && other.thirdPartyUserId === method.thirdPartyUserId));
  if (!shared || !user.isPrimaryUser || [...source.loginMethods, ...methods].some((expected) => !user.loginMethods.some((method) =>
    method.tenantIds.includes(tenantId) && matchesImportLoginMethod(method, expected)))) fail();
  return { user, target, canonicalRowndId: checkpoint.winner, recipeUserId: SuperTokens.convertToRecipeUserId(alias) };
}

export async function prepareOwnerConsolidation(input: {
  source: SuperTokensUserImport; candidates: ActivityCandidate[]; target: string; tenantId: string; userContext: JsonRecord;
}) {
  const { source, candidates, target, tenantId, userContext } = input;
  if (!isAdministrativeMigration(source, tenantId) || candidates.length < 2) return undefined;
  const fail = (reason: string): never => { throw new UnresolvedConsolidationOwners(candidates, reason); };
  if (tenantId !== "public") fail("whole-owner consolidation requires the public tenant");
  const winner = source.externalUserId!;
  const existing = readConsolidationCheckpoint(await getRawUserMetadata(target, userContext));
  if (existing && (existing.target !== target || existing.winner !== winner)) fail("the checkpoint target changed");
  const members: Member[] = [];
  const initiallyLinked = new Set<string>();
  for (const candidate of candidates) {
    const id = candidate.supertokens_user_id;
    if (!id) fail("a source has no immutable recipe owner");
    const user = await SuperTokens.getUser(id!, userContext);
    if (!user) fail("an owner disappeared");
    const identity = await recipeIdentity(user!, id!, userContext);
    if (!identity) fail("a mapping does not identify a recipe member");
    const stored = existing?.members.find((member) => member.rownd_user_id === candidate.rownd_user_id);
    if (existing && (!stored || stored.supertokens_user_id !== id || stored.identity !== identity)) fail("checkpoint membership changed");
    const method = (await recipeMethod(user!, id!, userContext))!;
    // SDK linking can verify the donor. A retry must not mistake that write for pre-existing verification.
    const unverifiedEmail = stored?.unverifiedEmail ?? (id !== target && !method.verified ? method.email : undefined);
    if (unverifiedEmail !== undefined && !method.hasSameEmailAs(unverifiedEmail)) fail("checkpoint email changed");
    members.push({ rownd_user_id: candidate.rownd_user_id, supertokens_user_id: id!, identity: identity!,
      ...(unverifiedEmail !== undefined ? { unverifiedEmail } : {}) });
    if (user!.id === winner) initiallyLinked.add(id!);
  }
  if (existing && existing.members.length !== members.length) fail("checkpoint sources are missing");
  if (!members.some((member) => member.rownd_user_id === winner && member.supertokens_user_id === target)) fail("the winner is not the pinned primary recipe");
  const checkpoint: Checkpoint = { version: 1, winner, target, members, status: "LINKING" };
  let expectedCheckpoint = existing;
  const permittedLinks = new Set([...initiallyLinked, target]);
  let promotionAllowed = false;
  const initialWinner = await SuperTokens.getUser(target, userContext);
  if (!initialWinner) fail("the winner disappeared");
  const wasPrimary = initialWinner!.isPrimaryUser;
  const initialWinnerMapping = await SuperTokens.getUserIdMapping({ userId: winner, userIdType: "EXTERNAL", userContext });
  let restoringWinnerAllowed = initialWinnerMapping.status !== "OK";
  const confirmedLinks = new Set(initiallyLinked);
  const initialMethods = new Set(initialWinner!.loginMethods.map((method) => method.recipeUserId.getAsString()));
  let reconcilingMethods = false;

  const assertOwners = async (complete = false) => {
    clearSuperTokensCoreCallCache(userContext);
    if (JSON.stringify(readConsolidationCheckpoint(await getRawUserMetadata(target, userContext))) !== JSON.stringify(expectedCheckpoint)) {
      fail("the consolidation checkpoint changed");
    }
    for (const member of members) {
      const id = member.supertokens_user_id;
      await assertSelectorNamespace(id, userContext);
      await assertSelectorNamespace(member.rownd_user_id, userContext);
      const user = await SuperTokens.getUser(id, userContext);
      const mapping = await SuperTokens.getUserIdMapping({ userId: member.rownd_user_id, userIdType: "EXTERNAL", userContext });
      const reverse = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext });
      const restoringWinner = restoringWinnerAllowed && id === target && mapping.status !== "OK" && reverse.status !== "OK" &&
        (await getRawUserMetadata(id, userContext)).original_rownd_user?.data.user_id === winner;
      if (!restoringWinner && (mapping.status !== "OK" || mapping.superTokensUserId !== id || reverse.status !== "OK" || reverse.externalUserId !== member.rownd_user_id)) {
        fail("an alias mapping changed");
      }
      if (id === target && mapping.status === "OK") restoringWinnerAllowed = false;
      if (!user || await recipeIdentity(user, id, userContext) !== member.identity ||
        !user.loginMethods.some((method) => method.tenantIds.includes(tenantId))) fail("recipe identity or membership changed");
      if (expectedCheckpoint?.status !== "COMPLETE" && member.unverifiedEmail !== undefined && member.unverifiedEmail.toLowerCase() !== getAuthenticatedMigrationEmail(source, tenantId) &&
        (await recipeMethod(user!, id, userContext))?.verified) fail("linking verified an email without matching source proof");
      for (const metadata of [await getRawUserMetadata(id, userContext), await getRawUserMetadata(member.rownd_user_id, userContext)]) {
        if (metadata.original_rownd_user?.data.user_id !== undefined && metadata.original_rownd_user.data.user_id !== member.rownd_user_id) {
          fail("an owner's source provenance changed");
        }
        if ([metadata.rownd_migration_target, metadata.rownd_migration_canonical_target].some((value) => value !== undefined && value !== id) ||
          metadata.rownd_migration_superseded !== undefined) fail("an owner has conflicting migration markers");
      }
      const linked = user!.id === winner;
      if (id === target) {
        if ((!linked && !(restoringWinner && user!.id === target)) ||
          ((wasPrimary || promotionAllowed) ? !user!.isPrimaryUser : user!.isPrimaryUser)) fail("the winner changed");
        for (const method of user!.loginMethods) {
          const recipeId = method.recipeUserId.getAsString();
          const planned = members.some((member) => permittedLinks.has(member.supertokens_user_id) &&
            (recipeId === member.rownd_user_id || recipeId === member.supertokens_user_id));
          if (!initialMethods.has(recipeId) && !planned && !(reconcilingMethods && source.loginMethods.some((expected) =>
            matchesImportLoginMethod(method, expected)))) fail("an unexpected recipe joined the winner");
        }
      } else if (linked) {
        if (!permittedLinks.has(id) || !user!.isPrimaryUser) fail("an unplanned owner transition occurred");
        confirmedLinks.add(id);
      } else {
        if (confirmedLinks.has(id)) fail("a linked donor left the pinned owner");
        const method = user!.loginMethods[0]!;
        if (complete || user!.id !== member.rownd_user_id || user!.isPrimaryUser || user!.loginMethods.length !== 1 ||
          method.tenantIds.length !== 1 || !(method.recipeId === "passwordless" ||
            (method.recipeId === "thirdparty" && ["google", "apple"].includes(method.thirdParty!.id)))) fail("a donor is not an eligible standalone owner");
        if (method.email && !method.verified && method.email.toLowerCase() !== getAuthenticatedMigrationEmail(source, tenantId)) {
          const primary = await SuperTokens.getUser(target, userContext);
          if (primary?.loginMethods.some((other) => other.verified && other.hasSameEmailAs(method.email!))) fail("linking would verify an unverified email");
        }
      }
      await assertMigrationOwnerGraph(user!, tenantId, userContext);
    }
  };
  await assertOwners();
  const pending = members.filter((member) => member.supertokens_user_id !== target && !initiallyLinked.has(member.supertokens_user_id));
  if (!wasPrimary && pending.length && (await AccountLinking.canCreatePrimaryUser(SuperTokens.convertToRecipeUserId(target), userContext)).status !== "OK") {
    fail("Core cannot promote the pinned winner");
  }
  if (wasPrimary) {
    for (const member of pending) {
      if ((await AccountLinking.canLinkAccounts(SuperTokens.convertToRecipeUserId(member.rownd_user_id), target, userContext)).status !== "OK") {
        fail("Core cannot link a donor to the pinned winner");
      }
    }
  }
  const proposedActions: ReconcilePreviewAction[] = [
    ...(!wasPrimary && pending.length ? [{ action: "create_primary" as const, supertokens_user_id: target }] : []),
    ...pending.map((member) => ({ action: "link_method" as const, recipeUserId: member.supertokens_user_id, supertokens_user_id: target })),
    ...(existing?.status !== "COMPLETE" ? [{ action: "update_migration_metadata" as const, supertokens_user_id: target }] : []),
  ];
  const assertFresh = async (complete = false) => {
    if (members.some((member) => !isAdministrativeElectionCandidate(source, member.rownd_user_id))) fail("the private election binding is missing");
    await assertAuthenticatedMigrationSource(source, tenantId);
    await assertOwners(complete);
    await assertMigrationMapping(target, winner, userContext);
  };
  return {
    assertOwners, proposedActions, plannedOwnerIds: new Set(members.flatMap((member) => [member.rownd_user_id, member.supertokens_user_id])),
    async beginMethodReconciliation() {
      await assertFresh(true);
      reconcilingMethods = true;
    },
    async execute() {
      await assertFresh();
      if (!pending.length) return;
      expectedCheckpoint = checkpoint;
      await UserMetadata.updateUserMetadata(target, { [key]: checkpoint }, userContext);
      await assertFresh();
      if (!wasPrimary) {
        promotionAllowed = true;
        const promoted = await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(target), userContext);
        if (promoted.status !== "OK" && promoted.status !== "RECIPE_USER_ID_ALREADY_LINKED_WITH_PRIMARY_USER_ID_ERROR") fail("primary promotion failed");
        await assertFresh();
      }
      for (const member of pending) {
        await assertFresh();
        if ((await AccountLinking.canLinkAccounts(SuperTokens.convertToRecipeUserId(member.rownd_user_id), target, userContext)).status !== "OK") {
          fail("Core cannot link a donor to the pinned winner");
        }
        await assertFresh();
        permittedLinks.add(member.supertokens_user_id);
        // SDK post-link checks use Core's externalized recipe ID. Fresh mapping checks pin its immutable recipe owner.
        const result = await AccountLinking.linkAccounts(SuperTokens.convertToRecipeUserId(member.rownd_user_id), target, userContext);
        if (result.status !== "OK") fail("donor linking failed");
        confirmedLinks.add(member.supertokens_user_id);
        await assertFresh();
      }
      await assertFresh(true);
    },
    async complete() {
      await assertFresh(true);
      if (existing?.status !== "COMPLETE") {
        expectedCheckpoint = { ...checkpoint, status: "COMPLETE" };
        await UserMetadata.updateUserMetadata(target, { [key]: expectedCheckpoint }, userContext);
        await assertFresh(true);
      }
    },
  };
}
