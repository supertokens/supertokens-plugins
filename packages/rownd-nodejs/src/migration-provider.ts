import SuperTokens from "supertokens-node";
import MultiTenancy from "supertokens-node/recipe/multitenancy";
import Session from "supertokens-node/recipe/session";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import { createHash, randomUUID } from "node:crypto";
import { assertMigrationMapping } from "./migration-mapping";
import { assertAuthenticatedMigrationSource, isRowndMigrationProfileActive } from "./migration-email";
import { resolveRowndProviderSubject } from "./provider-identity";
import { fetchOptionalRowndUserInfo } from "./rownd-repository";
import type { RowndMetadata, SuperTokensUser } from "./rownd-compatibility";
import type { SuperTokensUserImport } from "./types";
import { clearSuperTokensCoreCallCache, isRecord, type JsonRecord } from "./utils";
import { RowndMigrationPolicyError } from "./errors";

type Retirement = { rowndUserId: string; recipeUserId: string; provider: string; subject: string; pendingTenantIds?: string[] };
const key = "rownd_migration_provider_retirements";

function revocationLedgerId(internalUserId: string, tenantId: string) {
  return `rownd-provider-revocations-${createHash("sha256").update(JSON.stringify([internalUserId, tenantId])).digest("hex")}`;
}

// This literal metadata ID survives recipe deletion. Each attempt writes/removes
// only its own top-level key: Core shallow-merges these updates transactionally.
// Neither a stale account snapshot nor another tenant can overwrite this debt.
async function checkpointProviderRevocation(internalUserId: string, tenantId: string, retired: Retirement, userContext: JsonRecord) {
  const id = randomUUID();
  const ledgerId = revocationLedgerId(internalUserId, tenantId);
  await UserMetadata.updateUserMetadata(ledgerId, { [id]: { ...retired, internalUserId, tenantId } }, userContext);
  return async () => {
    await UserMetadata.updateUserMetadata(ledgerId, { [id]: null }, userContext);
  };
}

async function recoverProviderRevocations(internalUserId: string, rowndUserId: string, tenantId: string, userContext: JsonRecord) {
  const ledgerId = revocationLedgerId(internalUserId, tenantId);
  const ledger = await inspectProviderRevocations(internalUserId, rowndUserId, tenantId, userContext);
  const unfinished: Retirement[] = [];
  for (const [id, retired] of ledger) {
    await assertMigrationMapping(internalUserId, rowndUserId, userContext);
    const owner = await SuperTokens.getUser(retired.recipeUserId, userContext);
    const method = owner?.loginMethods.find((entry) => entry.hasSameThirdPartyInfoAs({ id: retired.provider, userId: retired.subject }));
    if (method?.tenantIds.includes(tenantId)) {
      // A sibling may still be between its checkpoint and disassociation. Do not
      // acknowledge that worker's debt before membership has actually disappeared.
      unfinished.push(retired);
      continue;
    }
    await Session.revokeAllSessionsForUser(internalUserId, true, tenantId, userContext);
    await UserMetadata.updateUserMetadata(ledgerId, { [id]: null }, userContext);
  }
  return unfinished;
}

async function inspectProviderRevocations(internalUserId: string, rowndUserId: string, tenantId: string, userContext: JsonRecord) {
  clearSuperTokensCoreCallCache(userContext);
  const ledger = (await UserMetadata.getUserMetadata(revocationLedgerId(internalUserId, tenantId), userContext)).metadata;
  return Object.entries(ledger).map(([id, value]) => {
    if (!isRecord(value) || value.internalUserId !== internalUserId || value.tenantId !== tenantId || value.rowndUserId !== rowndUserId) {
      throw new RowndMigrationPolicyError("Provider revocation checkpoint target changed");
    }
    return [id, readRetirements([value])[0]!] as const;
  });
}

export async function inspectProviderMigrationCheckpoints(internalUserId: string, rowndUserId: string, tenantId: string, userContext: JsonRecord) {
  const ledger = await inspectProviderRevocations(internalUserId, rowndUserId, tenantId, userContext);
  const metadata = (await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata;
  const retired = readRetirements(metadata[key]);
  let pending = ledger.length > 0 || (await inspectProviderIntroductions(internalUserId, userContext)).length > 0;
  for (const entry of retired) {
    const owner = await SuperTokens.getUser(entry.recipeUserId, userContext);
    if (entry.pendingTenantIds?.includes(tenantId) || owner?.loginMethods.some((method) => method.tenantIds.includes(tenantId) &&
        method.hasSameThirdPartyInfoAs({ id: entry.provider, userId: entry.subject }))) pending = true;
  }
  return pending;
}

function readRetirements(value: unknown): Retirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry) ||
      [entry.rowndUserId, entry.recipeUserId, entry.subject].some((field) => typeof field !== "string" || !field) ||
      !["google", "apple"].includes(entry.provider as string) ||
      (entry.pendingTenantIds !== undefined && (!Array.isArray(entry.pendingTenantIds) || entry.pendingTenantIds.some((id) => typeof id !== "string"))))) {
    throw new RowndMigrationPolicyError("Invalid Rownd provider retirement checkpoint");
  }
  return value as Retirement[];
}

// Preserve historical proof across snapshot refreshes and tenant-by-tenant retries.
export async function prepareRowndProviderRetirement(input: {
  source: SuperTokensUserImport; user: SuperTokensUser; metadata: RowndMetadata;
  internalUserId: string; tenantId: string; userContext: JsonRecord;
}) {
  const { source, user, metadata, internalUserId, tenantId, userContext } = input;
  const stored = (await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata;
  const retirements = readRetirements(stored[key]);
  const unfinished = await recoverProviderRevocations(internalUserId, source.externalUserId!, tenantId, userContext);
  for (const retired of unfinished) {
    if (!retirements.some((entry) => entry.recipeUserId === retired.recipeUserId)) retirements.push(retired);
  }
  const snapshot = metadata.original_rownd_user;
  if (snapshot && snapshot.data.user_id === source.externalUserId) {
    for (const method of user.loginMethods) {
      const provider = method.thirdParty;
      if (!provider || !["google", "apple"].includes(provider.id)) continue;
      const expected = source.loginMethods.find((entry) => entry.recipeId === "thirdparty" && entry.thirdPartyId === provider.id);
      if (!expected || expected.recipeId !== "thirdparty" || expected.thirdPartyUserId === provider.userId) continue;
      // Legacy imports selected data first, even in contradictory snapshots.
      if (![snapshot.data[`${provider.id}_id`], resolveRowndProviderSubject(snapshot, provider.id)].includes(provider.userId)) continue;
      const mapping = await SuperTokens.getUserIdMapping({ userId: method.recipeUserId.getAsString(), userIdType: "EXTERNAL", userContext });
      const recipeUserId = mapping.status === "OK" ? mapping.superTokensUserId : method.recipeUserId.getAsString();
      if (!retirements.some((entry) => entry.recipeUserId === recipeUserId)) {
        retirements.push({ rowndUserId: source.externalUserId!, recipeUserId, provider: provider.id, subject: provider.userId });
      }
    }
  }
  if (retirements.length === 0) return undefined;
  await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
  await UserMetadata.updateUserMetadata(internalUserId, { [key]: retirements }, userContext);

  return async () => {
    for (const retired of retirements) {
      // Revocation is owed even if the Rownd subject changed again after a
      // previous attempt removed membership. It does not require new identity proof.
      if (retired.pendingTenantIds?.includes(tenantId)) {
        await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
        await Session.revokeAllSessionsForUser(internalUserId, true, tenantId, userContext);
        const pending = readRetirements((await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata[key]);
        await UserMetadata.updateUserMetadata(internalUserId, { [key]: pending.map((entry) =>
          entry.recipeUserId === retired.recipeUserId ? {
            ...entry, pendingTenantIds: (entry.pendingTenantIds ?? []).filter((id) => id !== tenantId),
          } : entry) }, userContext);
        retired.pendingTenantIds = retired.pendingTenantIds.filter((id) => id !== tenantId);
      }
      const expected = source.loginMethods.find((method) => method.recipeId === "thirdparty" && method.thirdPartyId === retired.provider);
      if (!expected || expected.recipeId !== "thirdparty" || expected.thirdPartyUserId === retired.subject) continue;
      if (retired.rowndUserId !== source.externalUserId) throw new RowndMigrationPolicyError("Rownd provider retirement source changed");
      await assertAuthenticatedMigrationSource(source, tenantId);
      const fresh = await fetchOptionalRowndUserInfo(source.externalUserId!);
      if (!fresh || fresh.data.user_id !== source.externalUserId || !isRowndMigrationProfileActive(fresh) ||
          resolveRowndProviderSubject(fresh, retired.provider) !== expected.thirdPartyUserId) {
        throw new RowndMigrationPolicyError("Rownd provider changed before retirement");
      }
      clearSuperTokensCoreCallCache(userContext);
      await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
      const checkpoint = readRetirements((await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata[key]);
      if (!checkpoint.some((entry) => entry.recipeUserId === retired.recipeUserId && entry.subject === retired.subject &&
          entry.provider === retired.provider && entry.rowndUserId === retired.rowndUserId)) {
        throw new RowndMigrationPolicyError("Rownd provider retirement checkpoint changed");
      }
      const current = await SuperTokens.getUser(internalUserId, userContext);
      const matchesReplacement = (method: SuperTokensUser["loginMethods"][number]) =>
        method.recipeId === "thirdparty" && method.tenantIds.includes(tenantId) &&
        method.hasSameThirdPartyInfoAs({ id: retired.provider, userId: expected.thirdPartyUserId });
      if (!current?.loginMethods.some(matchesReplacement)) throw new RowndMigrationPolicyError("Rownd replacement provider is not linked to the pinned account");
      const owner = await SuperTokens.getUser(retired.recipeUserId, userContext);
      const obsolete = owner?.loginMethods.find((method) => method.recipeUserId.getAsString() === retired.recipeUserId ||
        (retired.recipeUserId === internalUserId && method.recipeUserId.getAsString() === source.externalUserId));
      if (!obsolete) {
        // Resume checkpoint cleanup even when the recipe deletion already committed.
        await Session.revokeAllSessionsForUser(internalUserId, true, tenantId, userContext);
        continue;
      }
      if (owner!.id !== current.id || obsolete.recipeId !== "thirdparty" ||
          !obsolete.hasSameThirdPartyInfoAs({ id: retired.provider, userId: retired.subject })) {
        throw new RowndMigrationPolicyError("Rownd obsolete provider ownership changed");
      }
      if (!obsolete.tenantIds.includes(tenantId) && obsolete.tenantIds.length > 0 &&
          !retired.pendingTenantIds?.includes(tenantId)) continue;
      retired.pendingTenantIds = [...new Set([...(retired.pendingTenantIds ?? []), tenantId])];
      const acknowledgeRevocation = await checkpointProviderRevocation(internalUserId, tenantId, retired, userContext);
      const beforeRemoval = readRetirements((await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata[key]);
      await UserMetadata.updateUserMetadata(internalUserId, {
        [key]: beforeRemoval.map((entry) => entry.recipeUserId === retired.recipeUserId ? {
          ...entry, pendingTenantIds: [...new Set([...(entry.pendingTenantIds ?? []), tenantId])],
        } : entry),
      }, userContext);
      if (obsolete.tenantIds.includes(tenantId)) {
        const result = await MultiTenancy.disassociateUserFromTenant(tenantId, SuperTokens.convertToRecipeUserId(retired.recipeUserId), userContext);
        if (result.status !== "OK") throw new Error(`Failed to retire Rownd provider tenant: ${result.status}`);
      }
      clearSuperTokensCoreCallCache(userContext);
      const after = await SuperTokens.getUser(internalUserId, userContext);
      const remaining = after?.loginMethods.find((method) => method.hasSameThirdPartyInfoAs({ id: retired.provider, userId: retired.subject }));
      if (!after?.loginMethods.some(matchesReplacement) || remaining?.tenantIds.includes(tenantId)) {
        throw new RowndMigrationPolicyError("Rownd provider tenant retirement failed");
      }
      if (remaining?.tenantIds.length === 0) {
        await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
        // Recipe-only deletion retains the primary ID and mapping even for its anchor.
        await SuperTokens.deleteUser(retired.recipeUserId, false, userContext);
      }
      await Session.revokeAllSessionsForUser(internalUserId, true, tenantId, userContext);
      await acknowledgeRevocation();
      const afterRevocation = readRetirements((await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata[key]);
      await UserMetadata.updateUserMetadata(internalUserId, {
        [key]: afterRevocation.map((entry) => entry.recipeUserId === retired.recipeUserId ? {
          ...entry, pendingTenantIds: (entry.pendingTenantIds ?? []).filter((id) => id !== tenantId),
        } : entry),
      }, userContext);
      clearSuperTokensCoreCallCache(userContext);
      await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
      const final = await SuperTokens.getUser(internalUserId, userContext);
      if (!final?.loginMethods.some(matchesReplacement) || final.loginMethods.some((method) =>
        method.tenantIds.includes(tenantId) && method.hasSameThirdPartyInfoAs({ id: retired.provider, userId: retired.subject }))) {
        throw new RowndMigrationPolicyError("Rownd provider retirement postcondition failed");
      }
    }
    clearSuperTokensCoreCallCache(userContext);
    const completed = new Set<string>();
    for (const retired of retirements) {
      const owner = await SuperTokens.getUser(retired.recipeUserId, userContext);
      if (!owner?.loginMethods.some((method) => method.hasSameThirdPartyInfoAs({ id: retired.provider, userId: retired.subject }))) {
        completed.add(retired.recipeUserId);
      }
    }
    const latest = (await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata;
    await UserMetadata.updateUserMetadata(internalUserId, {
      [key]: readRetirements(latest[key]).filter((entry) => !completed.has(entry.recipeUserId) || (entry.pendingTenantIds?.length ?? 0) > 0),
    }, userContext);
  };
}

const introductionKey = "rownd_migration_provider_introductions";
const recipeIntroductionKey = "rownd_migration_provider_introduction";
export type ProviderIntroduction = Retirement & { tenantId: string; created: boolean; internalUserId: string };

function introductions(value: unknown): ProviderIntroduction[] {
  const entries = readRetirements(value);
  if (entries.some((entry) => typeof Reflect.get(entry, "tenantId") !== "string" ||
      typeof Reflect.get(entry, "created") !== "boolean")) throw new RowndMigrationPolicyError("Invalid provider introduction checkpoint");
  return entries as ProviderIntroduction[];
}

export async function assertCurrentRowndProviders(source: SuperTokensUserImport, tenantId: string) {
  await assertAuthenticatedMigrationSource(source, tenantId);
  const providers = source.loginMethods.filter((method) => method.recipeId === "thirdparty" && ["google", "apple"].includes(method.thirdPartyId));
  if (providers.length === 0) return;
  const fresh = await fetchOptionalRowndUserInfo(source.externalUserId!);
  if (!fresh || fresh.data.user_id !== source.externalUserId || !isRowndMigrationProfileActive(fresh) ||
      providers.some((method) => method.recipeId === "thirdparty" &&
        resolveRowndProviderSubject(fresh, method.thirdPartyId) !== method.thirdPartyUserId)) {
    throw new RowndMigrationPolicyError("Rownd provider changed before linking or migration completion");
  }
}

export async function checkpointProviderIntroduction(input: {
  source: SuperTokensUserImport; internalUserId: string; recipeUserId: string; tenantId: string;
  provider: string; subject: string; created: boolean; userContext: JsonRecord; introduced: ProviderIntroduction[];
}) {
  if (!["google", "apple"].includes(input.provider)) return;
  const { internalUserId, userContext } = input;
  const introduction: ProviderIntroduction = { rowndUserId: input.source.externalUserId!, recipeUserId: input.recipeUserId,
    provider: input.provider, subject: input.subject, tenantId: input.tenantId, created: input.created, internalUserId };
  input.introduced.push(introduction);
  await assertMigrationMapping(internalUserId, input.source.externalUserId!, userContext);
  // Per-recipe records survive concurrent updates to the account's discovery index.
  // The request also retains its own records so sibling recovery cannot hide a
  // link that was still in flight when it removed a checkpoint.
  await UserMetadata.updateUserMetadata(input.recipeUserId, { [recipeIntroductionKey]: introduction }, userContext);
  const metadata = (await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata;
  const pending = introductions(metadata[introductionKey]);
  if (!pending.some((entry) => entry.recipeUserId === input.recipeUserId && entry.tenantId === input.tenantId)) {
    pending.push(introduction);
    await UserMetadata.updateUserMetadata(internalUserId, { [introductionKey]: pending }, userContext);
  }
}

async function inspectProviderIntroductions(internalUserId: string, userContext: JsonRecord) {
  const metadata = (await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata;
  const pending = introductions(metadata[introductionKey]);
  const target = await SuperTokens.getUser(internalUserId, userContext);
  for (const method of target?.loginMethods ?? []) {
    const recipeId = method.recipeUserId.getAsString();
    const stored = (await UserMetadata.getUserMetadata(recipeId, userContext)).metadata[recipeIntroductionKey];
    if (stored === undefined) continue;
    const entry = introductions([stored])[0]!;
    if (entry.internalUserId === internalUserId && !pending.some((candidate) => candidate.recipeUserId === entry.recipeUserId)) pending.push(entry);
  }
  return pending;
}

export async function finishProviderIntroductions(internalUserId: string, rowndUserId: string, userContext: JsonRecord, rollback: boolean, introduced?: ProviderIntroduction[]) {
  clearSuperTokensCoreCallCache(userContext);
  const pending = introduced ?? await inspectProviderIntroductions(internalUserId, userContext);
  if (pending.length === 0) return;
  await assertMigrationMapping(internalUserId, rowndUserId, userContext);
  for (const entry of pending) {
    if (entry.rowndUserId !== rowndUserId) throw new RowndMigrationPolicyError("Provider introduction target changed");
    if (!rollback) continue;
    clearSuperTokensCoreCallCache(userContext);
    const owner = await SuperTokens.getUser(entry.recipeUserId, userContext);
    const target = await SuperTokens.getUser(internalUserId, userContext);
    const method = owner?.loginMethods.find((candidate) => candidate.recipeUserId.getAsString() === entry.recipeUserId);
    const preservePinnedDonor = !entry.created && owner?.id === target?.id && owner?.loginMethods.length === 1;
    if (method) {
      if (!method.hasSameThirdPartyInfoAs({ id: entry.provider, userId: entry.subject }) ||
          (owner!.isPrimaryUser && owner!.id !== target?.id)) throw new RowndMigrationPolicyError("Provider introduction ownership changed");
      // Unlinking the sole donor also destroys the pinned primary. Quarantine
      // its introduced tenant instead and retain the per-recipe recovery record.
      if (entry.created || preservePinnedDonor) {
        if (method.tenantIds.includes(entry.tenantId)) {
          const removed = await MultiTenancy.disassociateUserFromTenant(entry.tenantId, method.recipeUserId, userContext);
          if (removed.status !== "OK") throw new Error("Failed to quarantine introduced provider");
        }
      } else if (owner!.id === target?.id) {
        // Restore a pre-existing standalone donor instead of deleting its native credential.
        await AccountLinking.unlinkAccount(method.recipeUserId, userContext);
      }
    }
    if (!entry.created) {
      // After unlinking, the primary-account lookup no longer includes sessions
      // minted through the donor while it was temporarily linked.
      await Session.revokeAllSessionsForUser(entry.recipeUserId, false, undefined, userContext);
    }
    await Session.revokeAllSessionsForUser(internalUserId, true, entry.tenantId, userContext);
    clearSuperTokensCoreCallCache(userContext);
    const after = await SuperTokens.getUser(entry.recipeUserId, userContext);
    const remaining = after?.loginMethods.find((candidate) => candidate.recipeUserId.getAsString() === entry.recipeUserId);
    if ((entry.created || preservePinnedDonor) && remaining?.tenantIds.includes(entry.tenantId)) throw new RowndMigrationPolicyError("Provider quarantine postcondition failed");
    if (entry.created && remaining?.tenantIds.length === 0) {
      if (entry.recipeUserId === internalUserId) throw new RowndMigrationPolicyError("Cannot quarantine the primary anchor");
      // Once the obsolete anchor is retired, this uncommitted recipe can be the
      // last member of the pinned account. Keep it quarantined and retain its
      // per-recipe checkpoint; deleting the last member deletes the primary too.
      if (after!.id !== target?.id || after!.loginMethods.length > 1) {
        await SuperTokens.deleteUser(entry.recipeUserId, false, userContext);
      }
    }
  }
  if (!rollback) {
    for (const entry of pending) {
      await UserMetadata.updateUserMetadata(entry.recipeUserId, { [recipeIntroductionKey]: null }, userContext);
    }
  }
  const latest = (await UserMetadata.getUserMetadata(internalUserId, userContext)).metadata;
  await UserMetadata.updateUserMetadata(internalUserId, {
    [introductionKey]: introductions(latest[introductionKey]).filter((entry) => !pending.some((completed) =>
      completed.recipeUserId === entry.recipeUserId && completed.tenantId === entry.tenantId)),
  }, userContext);
}

export async function assertProviderSessionMembership(userId: string, recipeUserId: string, tenantId: string, userContext: JsonRecord) {
  clearSuperTokensCoreCallCache(userContext);
  const user = await SuperTokens.getUser(userId, userContext);
  if (!user) return;
  const mapping = await SuperTokens.getUserIdMapping({ userId: user.id, userIdType: "EXTERNAL", userContext });
  const internalId = mapping.status === "OK" ? mapping.superTokensUserId : user.id;
  const primary = (await UserMetadata.getUserMetadata(internalId, userContext)).metadata;
  const alias = user.id !== internalId ? (await UserMetadata.getUserMetadata(user.id, userContext)).metadata : primary;
  if (!primary.original_rownd_user && !alias.original_rownd_user && primary.rownd_migration_complete !== true &&
      alias.rownd_migration_complete !== true && !primary[introductionKey] && !primary[key]) return;
  const method = user.loginMethods.find((entry) => entry.recipeUserId.getAsString() === recipeUserId ||
    (recipeUserId === internalId && entry.recipeUserId.getAsString() === user.id));
  if (!method || (method.recipeId === "thirdparty" && ["google", "apple"].includes(method.thirdParty!.id) &&
      !method.tenantIds.includes(tenantId))) throw new RowndMigrationPolicyError("Migrated provider is no longer a member of this tenant");
  const recipeMetadata = (await UserMetadata.getUserMetadata(recipeUserId, userContext)).metadata;
  const pending = recipeMetadata[recipeIntroductionKey] === undefined
    ? introductions(primary[introductionKey]) : [...introductions(primary[introductionKey]), ...introductions([recipeMetadata[recipeIntroductionKey]])];
  if (pending.some((entry) => entry.recipeUserId === recipeUserId &&
      (entry.internalUserId === undefined || entry.internalUserId === internalId) &&
      (!entry.created || entry.tenantId === tenantId))) {
    throw new RowndMigrationPolicyError("Migrated provider introduction is not yet committed");
  }
}
