import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import SuperTokens from "supertokens-node";
import SuperTokensError from "supertokens-node/lib/build/error";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import type { RecipeInterface as AccountLinkingRecipe } from "supertokens-node/recipe/accountlinking/types";
import type { JSONObject } from "supertokens-node/types";
import { reconciliationSuperTokens as ReconciliationCore, reconciliationUserMetadata as PolicyMetadata } from "./reconciliation-sdk";
import { assertReconciliationWritesAllowed } from "./reconciliation-reads";
import { clearSuperTokensCoreCallCache, isRecord } from "./utils";
import { GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID } from "./constants";
import { readOwnerPlanCheckpoint } from "./migration-owner-plan";
import { RowndMigrationPolicyError } from "./errors";
import { logSignInMethodPolicy } from "./sign-in-method-policy-log";
import { inspectUserPresentationMetadata, type PolicyPresence } from "./rownd-compatibility";

type RecipeUserId = ReturnType<typeof SuperTokens.convertToRecipeUserId>;
type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type Context = Record<string, any>;

export type DisconnectedSignInMethod = {
  version: 1;
  userId: string;
  tenantId: string;
  recipeUserId: string;
  providerId: string;
  identityHash: string;
  completed?: true;
};

const prefix = "rownd_disconnected_sign_in_identity_";
const conflictPrefix = `${prefix}owner_transition_conflict_`;
const completionPrefix = `${prefix}completion_`;
const indexField = "rownd_disconnected_sign_in_identity_index";
const indexPrefix = "rownd_dsi:";
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export class DisconnectedSignInMethodError extends SuperTokensError {
  constructor(
    readonly code: "SIGN_IN_METHOD_DISCONNECTED" | "DISCONNECT_POLICY_INVALID" | "DISCONNECT_OWNER_CHANGED" | "DISCONNECT_RESTORATION_BLOCKED",
    readonly ownerId?: string,
  ) {
    super({ type: SuperTokensError.BAD_INPUT_ERROR, message: {
      SIGN_IN_METHOD_DISCONNECTED: "This sign-in method is disconnected from this account",
      DISCONNECT_POLICY_INVALID: "Sign-in method policy requires account review",
      DISCONNECT_OWNER_CHANGED: "Sign-in method ownership changed; retry after account review",
      DISCONNECT_RESTORATION_BLOCKED: "Migration and reconciliation are unavailable for accounts with disconnected sign-in methods",
    }[code] });
    this.name = "DisconnectedSignInMethodError";
  }
}

export function isDisconnectedSignInMethodMetadataKey(key: string) {
  return key.startsWith(prefix);
}

type Identity = { tenantId: string; providerId: string; providerUserId: string };
type DisconnectInput = Omit<DisconnectedSignInMethod, "version" | "completed" | "identityHash"> &
  ({ providerUserId: string } | { identityHash: string });

export function signInIdentityHash(method: Identity) {
  return createHash("sha256")
    .update(JSON.stringify([method.tenantId, method.providerId, method.providerUserId]))
    .digest("hex");
}

function checkpointKey({ identityHash }: Pick<DisconnectedSignInMethod, "identityHash">) {
  return prefix + identityHash;
}

function completionKey({ identityHash }: Pick<DisconnectedSignInMethod, "identityHash">) {
  return completionPrefix + identityHash;
}

function ownerIndexKey(ownerId: string) {
  return `${indexField}:${createHash("sha256").update(ownerId).digest("hex")}`;
}

function readIndexEntries(metadata: Record<string, unknown>) {
  return Object.entries(metadata ?? {}).filter(([key]) => key === indexField || key.startsWith(`${indexField}:`))
    .map(([key, value]) => ({
      key,
      entry: isRecord(value) && value.version === 1 && nonempty(value.ownerId) &&
        nonempty(value.tenantId) && realProvider(value.providerId) &&
        (key === indexField || key === ownerIndexKey(value.ownerId))
        ? { ownerId: value.ownerId, tenantId: value.tenantId, providerId: value.providerId } : undefined,
    }));
}

export async function assertSignInIdentityNotIndexed(identity: Identity, userContext?: Context) {
  if (!realProvider(identity.providerId)) return;
  const { metadata } = await UserMetadata.getUserMetadata(indexPrefix + signInIdentityHash(identity), userContext);
  for (const { entry } of readIndexEntries(metadata)) {
    if (entry && entry.tenantId === identity.tenantId && entry.providerId === identity.providerId &&
      await confirmedAbsentOwner(entry.ownerId, userContext).catch(() => false)) continue;
    logSignInMethodPolicy("warn", "rownd_disconnect_index_denied", {
      code: "SIGN_IN_METHOD_DISCONNECTED", step: "signin", tenantId: identity.tenantId,
      providerId: identity.providerId, ownerId: entry?.ownerId,
    });
    throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED", entry?.ownerId);
  }
}

async function writeIdentityIndex(method: DisconnectedSignInMethod, userContext?: Context) {
  const { userId: ownerId, tenantId, providerId } = method;
  const id = indexPrefix + method.identityHash;
  const key = ownerIndexKey(ownerId);
  const { metadata } = await UserMetadata.getUserMetadata(id, userContext);
  if (readIndexEntries(metadata).some(({ entry }) => entry?.ownerId === ownerId &&
    entry.tenantId === tenantId && entry.providerId === providerId)) return;
  // A new account can later disconnect the same subject. Its entry must not
  // share a key with a deleted owner's cleanup, since Core has no compare-and-swap.
  const result = await PolicyMetadata.updateUserMetadata(id, {
    [key]: { version: 1, ownerId, tenantId, providerId, at: Date.now() },
  }, userContext);
  if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function realProvider(value: unknown): value is string {
  return nonempty(value) && value !== GUEST_AUTH_METHOD_ID && value !== INSTANT_AUTH_METHOD_ID;
}

function fresh(userContext?: Context) {
  clearSuperTokensCoreCallCache(userContext ?? {});
}

function uncachedContext(userContext?: Context): Context {
  const detached = { ...userContext, _default: { ...userContext?._default } };
  fresh(detached);
  return detached;
}

async function mappingFor(id: string, userContext?: Context) {
  const [internal, external] = await Promise.all([
    SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext }),
    SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext }),
  ]);
  if (internal.status === "OK" && external.status === "OK" &&
    (internal.superTokensUserId !== external.superTokensUserId || internal.externalUserId !== external.externalUserId)) {
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  }
  return internal.status === "OK" ? internal : external.status === "OK" ? external : undefined;
}

async function confirmedAbsentOwner(ownerId: string, context?: Context) {
  // A live primary still resolves by its internal anchor after recipe-only deletion.
  if (await SuperTokens.getUser(ownerId, context)) return false;
  if (await mappingFor(ownerId, context)) return false;
  const { metadata } = await UserMetadata.getUserMetadata(ownerId, context);
  return [metadata?.rownd_migration_canonical_target, metadata?.rownd_migration_target]
    .every((target) => target === undefined || target === ownerId);
}

type Owner = { id: string; user: User | undefined; mapping: Awaited<ReturnType<typeof mappingFor>> };

async function ownerFor(userId: string, userContext?: Context, visited = new Set<string>()): Promise<Owner> {
  if (!nonempty(userId)) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  if (visited.has(userId)) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  visited.add(userId);
  const [inputMapping, user] = await Promise.all([mappingFor(userId, userContext), SuperTokens.getUser(userId, userContext)]);
  if (!user) {
    // Missing legacy graphs remain discoverable for repair; authentication and
    // mutation helpers still require a live owner before granting permission.
    if (inputMapping) return { id: inputMapping.superTokensUserId, user: undefined, mapping: inputMapping };
    const { metadata } = await UserMetadata.getUserMetadata(userId, userContext);
    const target = metadata?.rownd_migration_canonical_target ?? metadata?.rownd_migration_target;
    if (target !== undefined) {
      if (!nonempty(target) || target === userId) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
      return ownerFor(target, userContext, visited);
    }
    return { id: userId, user: undefined, mapping: undefined };
  }
  const mapping = user.id === userId ? inputMapping : await mappingFor(user.id, userContext);
  const id = mapping?.superTokensUserId ?? user.id;
  // A mapping for an input recipe can differ from the primary's mapping after
  // linking. Its recipe must still be a member of the live primary graph.
  if (inputMapping && inputMapping.superTokensUserId !== id &&
    !user.loginMethods.some((method) => [inputMapping.superTokensUserId, inputMapping.externalUserId]
      .includes(method.recipeUserId.getAsString()))) {
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  }
  return { id, user, mapping };
}

function conflictKey(previousOwnerId: string) {
  return conflictPrefix + createHash("sha256").update(previousOwnerId).digest("hex");
}

function inspectPolicyRow(userId: string, metadata: Record<string, unknown>) {
  const methods = new Map<string, DisconnectedSignInMethod>();
  const completions = new Map<string, DisconnectedSignInMethod>();
  const fences: Array<{ key: string; previousOwnerId: string }> = [];
  const invalid: Array<{ key: string; reason: string; removable: boolean }> = [];
  const unknown: Array<{ key: string; identity?: { tenantId: string; identityHash: string } }> = [];
  const malformed = (key: string, reason: string, removable = true) => invalid.push({ key, reason, removable });
  for (const [key, value] of Object.entries(metadata)) {
    if (!isDisconnectedSignInMethodMetadataKey(key)) continue;
    if (isRecord(value) && "version" in value && value.version !== 1) {
      let identity: { tenantId: string; identityHash: string } | undefined;
      if ((value.userId === userId || value.userId === undefined) && nonempty(value.tenantId) && realProvider(value.providerId)) {
        if (nonempty(value.providerUserId)) {
          identity = { tenantId: value.tenantId, identityHash: signInIdentityHash({
            tenantId: value.tenantId, providerId: value.providerId, providerUserId: value.providerUserId,
          }) };
        } else if (isHash(value.identityHash) && (key === checkpointKey({ identityHash: value.identityHash }) ||
          key === completionKey({ identityHash: value.identityHash }))) {
          identity = { tenantId: value.tenantId, identityHash: value.identityHash };
        }
      }
      unknown.push({ key, identity });
      continue;
    }
    if (key.startsWith(conflictPrefix)) {
      if (!isRecord(value) || value.version !== 1 || value.userId !== userId ||
        !nonempty(value.previousOwnerId) || key !== conflictKey(value.previousOwnerId)) {
        malformed(key, "Invalid owner-transition fence");
      } else {
        fences.push({ key, previousOwnerId: value.previousOwnerId });
      }
      continue;
    }
    if (!isRecord(value) || value.version !== 1 || value.userId !== userId ||
      !nonempty(value.tenantId) || !nonempty(value.recipeUserId) ||
       !realProvider(value.providerId)) {
      malformed(key, "Invalid version 1 record fields");
      continue;
    }
    const identityHash = isHash(value.identityHash) && !("providerUserId" in value) ? value.identityHash :
      value.identityHash === undefined && nonempty(value.providerUserId) ? signInIdentityHash({
        tenantId: value.tenantId, providerId: value.providerId, providerUserId: value.providerUserId,
      }) : undefined;
    if (!identityHash) {
      malformed(key, "Invalid sign-in identity hash");
      continue;
    }
    const identity: DisconnectedSignInMethod = { version: 1, userId: value.userId, tenantId: value.tenantId,
      recipeUserId: value.recipeUserId, providerId: value.providerId, identityHash };
    if (key.startsWith(completionPrefix)) {
      if (key !== completionKey(identity) || value.completed !== true) {
        malformed(key, "Invalid completion key or marker");
        continue;
      }
      completions.set(key, { ...identity, completed: true });
    } else {
      if (key !== checkpointKey(identity) || "completed" in value) {
        malformed(key, "Invalid intent key or marker");
        continue;
      }
      methods.set(key, identity);
    }
  }
  for (const [key, completion] of completions) {
    const intentKey = checkpointKey(completion);
    const intent = methods.get(intentKey);
    if (!intent || intent.userId !== completion.userId || intent.tenantId !== completion.tenantId ||
      intent.providerId !== completion.providerId || intent.identityHash !== completion.identityHash ||
      intent.recipeUserId !== completion.recipeUserId) {
      if (!unknown.some((entry) => entry.key === intentKey)) {
        malformed(key, "Completion has no matching version 1 intent", false);
      }
      continue;
    }
    methods.set(intentKey, { ...intent, completed: true });
  }
  return { intents: [...methods.values()], completions: [...completions.values()], fences, invalid, unknown };
}

function parsePolicy(userId: string, metadata: Record<string, unknown>, scope: "management" | "auth" = "management") {
  const row = inspectPolicyRow(userId, metadata);
  if (row.unknown.length) {
    logSignInMethodPolicy("warn", "rownd_disconnect_unknown_version", {
      code: "DISCONNECT_POLICY_INVALID", ownerId: userId, step: scope, count: row.unknown.length,
    });
  }
  if (row.invalid.length || (scope === "management" && row.unknown.length)) {
    throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID", userId);
  }
  if (row.fences.length) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED", userId);
  return {
    methods: row.intents,
    identities: [...row.intents, ...row.completions, ...row.unknown.flatMap(({ identity }) => identity ? [identity] : [])],
    unknown: row.unknown.length > 0,
  };
}

async function fenceOwnerTransition(userId: string, previousOwnerId: string, userContext?: Context) {
  if (userId === previousOwnerId) return;
  // Read-only previews still deny the conflict, without mutating the account.
  try {
    assertReconciliationWritesAllowed();
  } catch {
    return;
  }
  const key = conflictKey(previousOwnerId);
  const fence = { version: 1, userId, previousOwnerId };
  const owner = await ownerFor(userId, userContext);
  if (!owner.user || owner.id !== userId) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED", userId);
  await persistOwnerPolicy(owner, key, fence, userContext);
  logSignInMethodPolicy("warn", "rownd_disconnect_fence_written", {
    code: "DISCONNECT_OWNER_CHANGED", ownerId: userId, step: "fence",
  });
  // Re-read both rows after writing the fence.
  const saved = (await readOwnerPolicyRows(owner, uncachedContext(userContext)))[key];
  if (!isRecord(saved) || saved.version !== 1 || saved.userId !== userId || saved.previousOwnerId !== previousOwnerId) {
    throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  }
}

function pinnedOwners(ownerId: string, metadata: Record<string, unknown>): string[] {
  // Only a validated checkpoint on the canonical owner's literal row may pin
  // historical owners that no longer appear in Core's live recipe graph.
  let plan: ReturnType<typeof readOwnerPlanCheckpoint>;
  if (isRecord(metadata.rownd_migration_owner_consolidation) && metadata.rownd_migration_owner_consolidation.version === 2) {
    try {
      plan = readOwnerPlanCheckpoint(metadata as Parameters<typeof readOwnerPlanCheckpoint>[0]);
    } catch (error) {
      if (!(error instanceof RowndMigrationPolicyError)) throw error;
    }
  }
  return plan && plan.target === ownerId && !plan.reservation ? plan.initial.graph.map((member) => member.owner) : [];
}

async function protectedOwnerRows(owner: Owner, userContext?: Context, verifyBothNamespaces = false) {
  const rows = new Map<string, string | true>();
  const ids = [...new Set(owner.user?.loginMethods.map((method) => method.recipeUserId.getAsString()))]
    .filter((id) => id !== owner.id && id !== owner.mapping?.externalUserId);
  const mappings = await Promise.all(ids.map((userId) =>
    verifyBothNamespaces ? mappingFor(userId, userContext) :
      SuperTokens.getUserIdMapping({ userId, userIdType: "EXTERNAL", userContext })));
  for (const [i, id] of ids.entries()) {
    const mapping = mappings[i];
    const internal = mapping?.status === "OK" ? mapping.superTokensUserId : id;
    rows.set(internal, internal);
    rows.set(id, internal);
  }
  return rows;
}

async function assertProtectedOwnerGraph(owner: Owner, metadata: Record<string, unknown>,
  linkedRows: Awaited<ReturnType<typeof protectedOwnerRows>>, userContext?: Context) {
  const rows = new Map(linkedRows);
  for (const id of pinnedOwners(owner.id, metadata)) rows.set(id, true);
  rows.delete(owner.id);
  await Promise.all([...rows].map(async ([id, binding]) => {
    const { metadata: literal } = await UserMetadata.getUserMetadata(id, userContext);
    // Copied linked snapshots are not authority. A live Core member must have
    // a self-bound checkpoint; a validated plan already proves its pinned owner.
    if (Object.values(signInMethodPolicyFields(literal)).some((value) =>
      binding === true || (isRecord(value) && (value.userId === id || value.userId === binding)))) {
      throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED", owner.id);
    }
  }));
}

async function readPolicy(owner: Owner, userContext?: Context): Promise<DisconnectedSignInMethod[]> {
  const metadata = await readOwnerPolicyRows(owner, userContext);
  if (owner.mapping) await mappingFor(owner.mapping.externalUserId, userContext);
  await assertProtectedOwnerGraph(owner, metadata, await protectedOwnerRows(owner, userContext, true), userContext);
  return parsePolicy(owner.id, metadata).methods;
}

export function signInMethodPolicyFields(metadata: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => isDisconnectedSignInMethodMetadataKey(key)));
}

export function mergeSignInMethodPolicy(ownerId: string, primary: Record<string, unknown>, published: Record<string, unknown>) {
  const policy = signInMethodPolicyFields(primary);
  for (const [key, value] of Object.entries(signInMethodPolicyFields(published))) {
    if (Object.prototype.hasOwnProperty.call(policy, key) && !isDeepStrictEqual(policy[key], value)) {
      throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID", ownerId);
    }
    policy[key] = value;
  }
  return policy;
}

async function readOwnerPolicyRows(owner: Owner, context?: Context) {
  const { metadata } = await UserMetadata.getUserMetadata(owner.id, context);
  const alias = owner.mapping?.externalUserId;
  if (!alias || alias === owner.id) return metadata ?? {};
  const published = (await UserMetadata.getUserMetadata(alias, context)).metadata;
  return { ...metadata, ...mergeSignInMethodPolicy(owner.id, metadata, published) };
}

async function persistOwnerPolicy(owner: Owner, key: string, value: JSONObject, context?: Context) {
  // Write the SDK row first: canonical readers do not consult the internal row.
  for (const id of new Set([owner.mapping?.externalUserId ?? owner.id, owner.id])) {
    const result = await PolicyMetadata.updateUserMetadata(id, { [key]: value }, context);
    if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  }
}

/** Backfills an earlier internal-only checkpoint before enabling canonical mode. */
export async function publishSignInMethodPolicy(input: { userId: string; dryRun: boolean }) {
  if (typeof input.dryRun !== "boolean") throw new TypeError("Specify dryRun");
  const context = {};
  const owner = await ownerFor(input.userId, context);
  assertPrimaryReference(owner, input.userId);
  if (!owner.user) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED", owner.id);
  const { id, user } = owner;
  if (id === user.id) return { userId: user.id, keys: [] };
  const { metadata: legacy } = await UserMetadata.getUserMetadata(id, context);
  const { metadata: canonical } = await UserMetadata.getUserMetadata(user.id, context);
  const merged = mergeSignInMethodPolicy(id, legacy, canonical);
  const keys = Object.keys(merged).filter((key) => !Object.prototype.hasOwnProperty.call(canonical, key));
  if (!keys.length) return { userId: user.id, keys };
  if (keys.some((key) => merged[key] === null || (isRecord(merged[key]) && "providerUserId" in merged[key]))) {
    throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID", id);
  }
  await assertProtectedOwnerGraph(owner, legacy, await protectedOwnerRows(owner, context, true), context);
  if (!input.dryRun) {
    const patch = Object.fromEntries(keys.map((key) => [key, merged[key]])) as JSONObject;
    const result = await PolicyMetadata.updateUserMetadata(user.id, patch, context);
    if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID", id);
    // Verify the exact copied values and mapping after publication.
    const verification = uncachedContext(context);
    assertSameOwner(owner, await ownerFor(input.userId, verification));
    const { metadata } = await UserMetadata.getUserMetadata(user.id, verification);
    if (keys.some((key) => !isDeepStrictEqual(metadata[key], patch[key]))) {
      throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID", id);
    }
  }
  return { userId: user.id, keys };
}

async function recipeMethod(owner: Owner, recipeUserId: RecipeUserId, userContext?: Context) {
  const id = recipeUserId.getAsString();
  const mapping = await mappingFor(id, userContext);
  const method = owner.user?.loginMethods.find((candidate) => {
    const candidateId = candidate.recipeUserId.getAsString();
    return candidateId === id || mapping !== undefined &&
      [mapping.superTokensUserId, mapping.externalUserId].includes(candidateId);
  });
  if (!method) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  return method;
}

async function lenientRecipeMethod(owner: Owner, recipeUserId: RecipeUserId, userContext?: Context) {
  const id = recipeUserId.getAsString();
  const exact = owner.user?.loginMethods.find((method) => method.recipeUserId.getAsString() === id);
  if (exact || !owner.user) return exact;
  const { id: internalId } = await lenientOwner(id, userContext);
  return owner.user.loginMethods.find((method) => method.recipeUserId.getAsString() === internalId);
}

function assertSameOwner(expected: Owner, current: Owner) {
  if (expected.id !== current.id || !current.user ||
    expected.mapping?.externalUserId !== current.mapping?.externalUserId) {
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  }
}

function assertPrimaryReference(owner: Owner, userId: string) {
  if (userId !== owner.id && userId !== owner.mapping?.externalUserId) {
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  }
}

type PolicyIdentities = ReadonlyArray<{ tenantId: string; identityHash: string }>;

export function assertIdentityAllowedByOwner(identity: Identity, policy: PolicyIdentities, ownerId: string) {
  const hash = signInIdentityHash(identity);
  if (policy.some((entry) => entry.tenantId === identity.tenantId && entry.identityHash === hash)) {
    throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED", ownerId);
  }
}

function assertMethodAllowed(method: User["loginMethods"][number], tenantId: string, policy: PolicyIdentities, ownerId: string) {
  if (method.recipeId === "thirdparty" && method.thirdParty) {
    assertIdentityAllowedByOwner({ tenantId, providerId: method.thirdParty.id, providerUserId: method.thirdParty.userId }, policy, ownerId);
  }
}

async function assertRecipeIdentityNotIndexed(method: User["loginMethods"][number], tenantId: string, userContext?: Context) {
  if (method.recipeId === "thirdparty" && method.thirdParty && realProvider(method.thirdParty.id)) {
    await assertSignInIdentityNotIndexed({
      tenantId, providerId: method.thirdParty.id, providerUserId: method.thirdParty.userId,
    }, userContext);
  }
}

export async function getDisconnectedSignInMethods(userId: string, userContext?: Context): Promise<DisconnectedSignInMethod[]> {
  const context = uncachedContext(userContext);
  return readPolicy(await ownerFor(userId, context), context);
}

export async function recordDisconnectedSignInMethod(
  input: DisconnectInput,
  userContext?: Context,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  const identityHash = "identityHash" in input ? input.identityHash :
    nonempty(input.providerUserId) ? signInIdentityHash(input) : undefined;
  if (!nonempty(input.userId) || !nonempty(input.tenantId) || !nonempty(input.recipeUserId) ||
    !realProvider(input.providerId) || !isHash(identityHash)) {
    throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  }
  fresh(userContext);
  const owner = await ownerFor(input.userId, userContext);
  assertPrimaryReference(owner, input.userId);
  const policy = await readPolicy(owner, userContext);
  const recipeMapping = await mappingFor(input.recipeUserId, userContext);
  const recipeId = recipeMapping?.superTokensUserId ?? input.recipeUserId;
  const existing = policy.find((entry) => entry.identityHash === identityHash && entry.tenantId === input.tenantId &&
    entry.providerId === input.providerId);
  if (existing) {
    if (existing.recipeUserId !== recipeId) throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED");
    fresh(userContext);
    const currentOwner = await ownerFor(input.userId, userContext);
    assertSameOwner(owner, currentOwner);
    if (!(await readPolicy(currentOwner, userContext)).some((entry) =>
      entry.identityHash === identityHash && entry.recipeUserId === recipeId)) {
      throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
    }
    await beforeCommit?.();
    if (currentOwner.mapping) {
      const fields = signInMethodPolicyFields(await readOwnerPolicyRows(currentOwner, userContext));
      for (const id of [currentOwner.mapping.externalUserId, currentOwner.id]) {
        const { metadata } = await UserMetadata.getUserMetadata(id, userContext);
        const missing = Object.fromEntries(Object.entries(fields).filter(([key]) => !Object.prototype.hasOwnProperty.call(metadata, key)));
        if (Object.keys(missing).length) {
          const result = await PolicyMetadata.updateUserMetadata(id, missing as JSONObject, userContext);
          if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
        }
      }
    }
    await writeIdentityIndex(existing, userContext);
    return;
  }
  const candidate = await ownerFor(input.recipeUserId, userContext);
  const method = await recipeMethod(owner, SuperTokens.convertToRecipeUserId(input.recipeUserId), userContext);
  if (!owner.user || candidate.id !== owner.id || method.recipeId !== "thirdparty" ||
    !method.tenantIds.includes(input.tenantId) || method.thirdParty?.id !== input.providerId ||
    signInIdentityHash({ tenantId: input.tenantId, providerId: method.thirdParty.id, providerUserId: method.thirdParty.userId }) !== identityHash) {
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  }
  const checkpoint: DisconnectedSignInMethod = { version: 1, userId: owner.id, recipeUserId: recipeId,
    tenantId: input.tenantId, providerId: input.providerId, identityHash };
  // Independent top-level fields avoid lost updates between different identities.
  await beforeCommit?.();
  await persistOwnerPolicy(owner, checkpointKey(checkpoint), checkpoint, userContext);
  await writeIdentityIndex(checkpoint, userContext);
  // Verify the intent and owner after publishing both metadata rows and the index.
  fresh(userContext);
  const currentOwner = await ownerFor(input.userId, userContext);
  assertSameOwner(owner, currentOwner);
  if (!(await readPolicy(currentOwner, userContext)).some((entry) =>
    checkpointKey(entry) === checkpointKey(checkpoint) && entry.recipeUserId === checkpoint.recipeUserId)) {
    // Intent is never rolled back after an ambiguous graph or persistence result.
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  }
}

export async function completeDisconnectedSignInMethod(
  input: DisconnectInput,
  userContext?: Context,
): Promise<void> {
  fresh(userContext);
  const owner = await ownerFor(input.userId, userContext);
  assertPrimaryReference(owner, input.userId);
  if (!owner.user) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  const recipeId = (await mappingFor(input.recipeUserId, userContext))?.superTokensUserId ?? input.recipeUserId;
  const hash = "identityHash" in input ? input.identityHash : signInIdentityHash(input);
  const existing = (await readPolicy(owner, userContext)).find((entry) =>
    entry.identityHash === hash && entry.tenantId === input.tenantId && entry.providerId === input.providerId);
  if (!existing || existing.recipeUserId !== recipeId) throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  if (!existing.completed) {
    // A delayed first-time intent write must never replace completion state.
    await persistOwnerPolicy(owner, completionKey(existing), { ...existing, completed: true }, userContext);
  }
  // Verify completion and ownership after the write.
  fresh(userContext);
  const current = await ownerFor(input.userId, userContext);
  assertSameOwner(owner, current);
  if (!(await readPolicy(current, userContext)).some((entry) => entry.identityHash === hash &&
    entry.recipeUserId === recipeId && entry.completed === true)) {
    throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  }
}

export function hasSignInMethodPolicy(metadata: Record<string, unknown>) {
  return Object.keys(metadata ?? {}).some(isDisconnectedSignInMethodMetadataKey);
}

async function lenientOwner(id: string, userContext: Context | undefined, user?: User) {
  const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext });
  return { id: mapping.status === "OK" ? mapping.superTokensUserId : id, user,
    mapping: mapping.status === "OK" ? mapping : undefined };
}

type Gate = {
  owner: Owner;
  policy?: ReturnType<typeof parsePolicy>;
  linkedRows?: Awaited<ReturnType<typeof protectedOwnerRows>>;
};

type GateOptions = {
  user?: User;
  presence?: PolicyPresence;
  previous?: Gate;
};

function isRetiredPrimaryRecipe(gate: Gate, recipeId: string) {
  return (recipeId === gate.owner.id || recipeId === gate.owner.mapping?.externalUserId) &&
    gate.policy?.methods.some((entry) => entry.recipeUserId === gate.owner.id);
}

export async function assertNotRetiredPrimaryRecipe(recipeId: string, user: User, userContext: Context) {
  const gate = await readPolicyGate(user.id, userContext, { user });
  if (isRetiredPrimaryRecipe(gate, recipeId)) {
    throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED", gate.owner.id);
  }
}

export async function readPolicyGate(
  reference: string, userContext: Context | undefined,
  options: GateOptions = {},
): Promise<Gate> {
  const { user, primaryUserId, primaryMetadata, linkedMetadata = [] } = options.presence ??
    await inspectUserPresentationMetadata(reference, userContext, options.user);
  const sdkId = user?.id ?? reference;
  const published = linkedMetadata.find(({ userId }) => userId === sdkId)?.metadata ?? {};
  for (const { userId, metadata } of linkedMetadata) {
    if (userId !== sdkId && Object.values(signInMethodPolicyFields(metadata)).some((value) =>
      isRecord(value) && value.userId === userId)) {
      throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED", primaryUserId);
    }
  }
  if (!hasSignInMethodPolicy(primaryMetadata) && !hasSignInMethodPolicy(published)) {
    return { owner: { id: primaryUserId, user, mapping: undefined } };
  }
  const previous = options.previous?.policy && options.previous.owner.user?.id === sdkId &&
    (linkedMetadata.length === 0 || primaryUserId === options.previous.owner.id)
    ? options.previous : undefined;
  // The publication check reuses address resolution, never the policy or live login methods.
  const live = previous && await SuperTokens.getUser(reference, userContext);
  const ids = (snapshot: User | undefined) => snapshot?.loginMethods.map((method) => method.recipeUserId.getAsString()).sort();
  const sameGraph = previous && live && live.id === sdkId && isDeepStrictEqual(ids(previous.owner.user), ids(live));
  const owner = sameGraph ? { ...previous.owner, user: live } : await ownerFor(reference, userContext);
  if (!owner.user || owner.user.id !== sdkId) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED", owner.id);
  const ownerMetadata = { ...primaryMetadata, ...mergeSignInMethodPolicy(owner.id, primaryMetadata, published) };
  const policy = parsePolicy(owner.id, ownerMetadata, "auth");
  // Unknown versions alone must never turn legacy graph anomalies into lockouts.
  if (!policy.methods.length && policy.unknown) return { owner, policy };
  const linkedRows = (sameGraph && previous.linkedRows) || await protectedOwnerRows(owner, userContext);
  await assertProtectedOwnerGraph(owner, ownerMetadata, linkedRows, userContext);
  return { owner, policy, linkedRows };
}

export async function checkSignInMethodAuthentication(
  userId: string, recipeUserId: RecipeUserId, tenantId: string, userContext?: Context,
  options: GateOptions = {},
) {
  const gate = await readPolicyGate(userId, userContext, options);
  let method: User["loginMethods"][number] | undefined;
  if (gate.policy) {
    if (gate.policy.unknown && !gate.policy.methods.length) {
      const user = gate.owner.user ?? await SuperTokens.getUser(userId, userContext);
      method = await lenientRecipeMethod({ ...gate.owner, user }, recipeUserId, userContext);
    } else {
      const recipeId = recipeUserId.getAsString();
      if (isRetiredPrimaryRecipe(gate, recipeId) || gate.policy.methods.some((entry) =>
        entry.tenantId === tenantId && entry.recipeUserId === recipeId)) {
        // A primary ID can survive as an account anchor, not as a credential.
        throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED", gate.owner.id);
      }
      method = gate.owner.user?.loginMethods.find((candidate) => candidate.recipeUserId.getAsString() === recipeId) ??
        await recipeMethod(gate.owner, recipeUserId, userContext);
      if (!method.tenantIds.includes(tenantId)) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
    }
    if (method) assertMethodAllowed(method, tenantId, gate.policy.identities, gate.owner.id);
  }
  return { gate, method };
}

export async function assertSignInMethodLinkAllowed(
  primaryUserId: string, recipeUserId: RecipeUserId, userContext?: Context,
): Promise<{ confirm: (user: User) => Promise<void> } | undefined> {
  const recipeId = recipeUserId.getAsString();
  const candidateUser = await SuperTokens.getUser(recipeId, userContext);
  if (!candidateUser) return;
  if (!candidateUser.isPrimaryUser) await assertStandaloneLinkCandidateHasNoPolicy(candidateUser.id, userContext);
  const methods = candidateUser.loginMethods.filter((method) => method.recipeId === "thirdparty" &&
    realProvider(method.thirdParty?.id));
  const couldCarryPolicy = candidateUser.isPrimaryUser;
  if (!methods.length && !couldCarryPolicy) return;
  const presence = await inspectUserPresentationMetadata(primaryUserId, userContext);
  const owner = await readPolicyGate(primaryUserId, userContext, { presence });
  const sameOwner = candidateUser.id === owner.owner.user?.id;
  if (sameOwner && isRetiredPrimaryRecipe(owner, recipeId)) {
    throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED", owner.owner.id);
  }
  if (!sameOwner && couldCarryPolicy && (await readPolicyGate(recipeId, userContext, { user: candidateUser })).policy) {
    throw new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
  }
  const { policy } = owner;
  for (const method of methods) {
    if (sameOwner && method.recipeUserId.getAsString() !== recipeId) continue;
    for (const tenantId of method.tenantIds) {
      if (policy) assertMethodAllowed(method, tenantId, policy.identities, owner.owner.id);
      if (!sameOwner) await assertRecipeIdentityNotIndexed(method, tenantId, userContext);
    }
  }
  if (!policy && !methods.length) return;
  const sdkId = presence.user?.id;
  const checkedMethods = sameOwner
    ? methods.filter((method) => method.recipeUserId.getAsString() === recipeId) : methods;
  return { confirm: async (user) => {
    if (user.id !== sdkId) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
    const rows = [...new Set([presence.primaryUserId, user.id])];
    const metadata = await Promise.all(rows.map((id) => UserMetadata.getUserMetadata(id, userContext)));
    const fields = mergeSignInMethodPolicy(owner.owner.id, metadata[0]?.metadata ?? {}, metadata[1]?.metadata ?? {});
    if (!hasSignInMethodPolicy(fields)) return;
    const confirmedOwner = owner.policy ? owner.owner : await ownerFor(user.id, userContext);
    const updated = parsePolicy(confirmedOwner.id, fields, "auth");
    for (const method of checkedMethods) {
      for (const tenant of method.tenantIds) assertMethodAllowed(method, tenant, updated.identities, owner.owner.id);
    }
  } };
}

export async function assertStandaloneLinkCandidateHasNoPolicy(recipeId: string, context?: Context) {
  const check = async (id: string) => {
    const { metadata } = await UserMetadata.getUserMetadata(id, context);
    if (hasSignInMethodPolicy(metadata)) throw new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
  };
  // A detached mapped anchor can still carry policy written by internal-only builds.
  const [, mapping] = await Promise.all([check(recipeId),
    SuperTokens.getUserIdMapping({ userId: recipeId, userIdType: "EXTERNAL", userContext: context })]);
  if (mapping.status === "OK" && mapping.superTokensUserId !== recipeId) await check(mapping.superTokensUserId);
}

export async function assertSignInMethodTenantAssociationAllowed(
  recipeUserId: RecipeUserId, tenantId: string, userContext?: Context,
): Promise<void> {
  const id = recipeUserId.getAsString();
  const user = await SuperTokens.getUser(id, userContext);
  if (!user) return;
  const exact = user.loginMethods.find((candidate) => candidate.recipeUserId.getAsString() === id);
  if (exact && !realProvider(exact.thirdParty?.id)) return;
  const gate = await readPolicyGate(id, userContext, { user });
  if (isRetiredPrimaryRecipe(gate, id)) {
    throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED", gate.owner.id);
  }
  const method = gate.policy && !gate.policy.unknown ? await recipeMethod(gate.owner, recipeUserId, userContext)
    : await lenientRecipeMethod(gate.owner, recipeUserId, userContext);
  if (!method) return;
  if (gate.policy) assertMethodAllowed(method, tenantId, gate.policy.identities, gate.owner.id);
  await assertRecipeIdentityNotIndexed(method, tenantId, userContext);
}

export async function assertNoDisconnectedSignInMethods(userId: string, userContext?: Context, visited = new Set<string>()): Promise<void> {
  if (visited.has(userId)) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  visited.add(userId);
  const mapping = await ReconciliationCore.getUserIdMapping({ userId, userIdType: "EXTERNAL", userContext });
  const ownerId = mapping.status === "OK" ? mapping.superTokensUserId : userId;
  const { metadata } = await PolicyMetadata.getUserMetadata(ownerId, userContext);
  assertNoPolicyInMetadata(ownerId, metadata);
  for (const id of pinnedOwners(ownerId, metadata ?? {})) {
    if (id !== ownerId) await assertNoDisconnectedSignInMethodsAtInternalOwner(id, userContext);
  }
  const target = metadata?.rownd_migration_canonical_target ?? metadata?.rownd_migration_target;
  if (nonempty(target) && target !== userId && target !== ownerId) await assertNoDisconnectedSignInMethods(target, userContext, visited);
}

export function assertNoPolicyInMetadata(ownerId: string, metadata: Record<string, unknown>) {
  if (!hasSignInMethodPolicy(metadata)) return;
  parsePolicy(ownerId, metadata ?? {});
  throw new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
}

export async function assertNoDisconnectedSignInMethodsAtInternalOwner(
  internalOwnerId: string, userContext?: Context, transitionTargetUserId?: string,
  options: { fresh?: boolean } = {},
): Promise<void> {
  const { metadata } = options.fresh
    ? await UserMetadata.getUserMetadata(internalOwnerId, uncachedContext(userContext))
    : await PolicyMetadata.getUserMetadata(internalOwnerId, userContext);
  if (!hasSignInMethodPolicy(metadata)) return;
  let failure: DisconnectedSignInMethodError;
  try {
    parsePolicy(internalOwnerId, metadata ?? {});
    failure = new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
  } catch (error) {
    if (!(error instanceof DisconnectedSignInMethodError)) throw error;
    failure = error;
  }
  // This argument is a pinned internal metadata row, not a selector to redirect
  // through today's primary. Its checkpoint remains evidence after reassociation.
  if (!transitionTargetUserId) throw failure;
  let current: Owner | undefined;
  try {
    current = await ownerFor(internalOwnerId, userContext);
  } catch (error) {
    if (!(error instanceof DisconnectedSignInMethodError)) throw error;
  }
  if (current?.user) await fenceOwnerTransition(current.id, internalOwnerId, userContext);
  if (transitionTargetUserId && (!current?.user || current.id !== internalOwnerId)) {
    const target = await ownerFor(transitionTargetUserId, userContext);
    if (target.user && target.id !== current?.id) await fenceOwnerTransition(target.id, internalOwnerId, userContext);
  }
  throw failure;
}

function ownerIndexIds(metadata: Record<string, unknown>) {
  return Object.keys(metadata ?? {}).flatMap((key) => {
    if (!isDisconnectedSignInMethodMetadataKey(key)) return [];
    const hash = key.slice(key.startsWith(completionPrefix) ? completionPrefix.length : prefix.length);
    return isHash(hash) ? [indexPrefix + hash] : [];
  });
}

async function readOwnedIndexKeys(indexId: string, ownerId: string, context: Context) {
  const { metadata } = await UserMetadata.getUserMetadata(indexId, uncachedContext(context));
  return readIndexEntries(metadata).filter(({ entry }) => entry?.ownerId === ownerId).map(({ key }) => key);
}

async function removePolicyKeys(id: string, keys: string[], context: Context) {
  if (!keys.length) return;
  const result = await PolicyMetadata.updateUserMetadata(id, Object.fromEntries(keys.map((key) => [key, null])), context);
  if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
}

type DeleteUser = AccountLinkingRecipe["deleteUser"];

export async function deleteUserAndSignInMethodPolicy(input: Parameters<DeleteUser>[0], deleteUser: DeleteUser) {
  if (!input.removeAllLinkedAccounts || !SuperTokens.isRecipeInitialized("usermetadata")) return deleteUser(input);
  const context = uncachedContext(input.userContext);
  const user = await SuperTokens.getUser(input.userId, context);
  const mapping = await mappingFor(user?.id ?? input.userId, context);
  const ownerId = mapping?.superTokensUserId ?? user?.id ?? input.userId;
  const rows = [...new Set([ownerId, mapping?.externalUserId ?? user?.id ?? input.userId])];
  const indexIds = new Set<string>();
  let sawPolicy = false;
  for (const id of rows) {
    const { metadata } = await UserMetadata.getUserMetadata(id, context);
    sawPolicy ||= hasSignInMethodPolicy(metadata);
    for (const indexId of ownerIndexIds(metadata)) indexIds.add(indexId);
  }
  const result = await deleteUser(input);
  try {
    const remaining = await Promise.all(rows.map(async (id) => ({
      id, metadata: (await UserMetadata.getUserMetadata(id, uncachedContext(context))).metadata,
    })));
    for (const { metadata } of remaining) {
      sawPolicy ||= hasSignInMethodPolicy(metadata);
      for (const indexId of ownerIndexIds(metadata)) indexIds.add(indexId);
    }
    if (sawPolicy) {
      // Do not reuse the owner lookup from before deletion.
      const verification = uncachedContext(context);
      if (!await confirmedAbsentOwner(ownerId, verification)) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED", ownerId);
      for (const indexId of indexIds) {
        await removePolicyKeys(indexId, await readOwnedIndexKeys(indexId, ownerId, context), context);
      }
      for (const { id, metadata } of remaining) {
        if (id !== ownerId && !await confirmedAbsentOwner(id, verification)) continue;
        // Mapped deletes can leave the literal internal metadata, including old
        // migration snapshots with provider subjects, behind in Core.
        if (Object.keys(metadata ?? {}).length) await PolicyMetadata.clearUserMetadata(id, context);
      }
      logSignInMethodPolicy("info", "rownd_disconnect_policy_erased", { code: "OK", ownerId, step: "delete_user" });
    }
  } catch (error) {
    logSignInMethodPolicy("error", "rownd_disconnect_policy_erasure_failed", {
      code: "DISCONNECT_POLICY_INVALID", ownerId, step: "delete_user",
    });
    throw error;
  }
  return result;
}

export async function inspectSignInMethodPolicy(input: { userId: string; tenantId?: string; indexId?: string }) {
  const { userId, tenantId } = input;
  if (!nonempty(userId)) throw new TypeError("A user ID is required");
  if (userId.startsWith(indexPrefix) || (input.indexId !== undefined &&
    (!input.indexId.startsWith(indexPrefix) || !isHash(input.indexId.slice(indexPrefix.length))))) {
    throw new TypeError("Use an owner ID and, optionally, a valid index ID");
  }
  const context = {};
  const [internal, external, user] = await Promise.all([
    SuperTokens.getUserIdMapping({ userId, userIdType: "SUPERTOKENS", userContext: context }),
    SuperTokens.getUserIdMapping({ userId, userIdType: "EXTERNAL", userContext: context }),
    SuperTokens.getUser(userId, context),
  ]);
  const dualMapping = internal.status === "OK" && external.status === "OK" &&
    (internal.superTokensUserId !== external.superTokensUserId || internal.externalUserId !== external.externalUserId);
  const owner = await lenientOwner(user?.id ?? userId, context, user);
  const { metadata } = await UserMetadata.getUserMetadata(owner.id, context);
  const linked = await protectedOwnerRows(owner, context);
  for (const id of pinnedOwners(owner.id, metadata ?? {})) if (id !== owner.id) linked.set(id, true);
  const ids = new Set([owner.id, userId, ...(user ? [user.id] : []), ...linked.keys(),
    ...(external.status === "OK" ? [external.superTokensUserId] : []),
    ...(internal.status === "OK" ? [internal.superTokensUserId] : [])]);
  const rows = await Promise.all([...ids].map(async (id) => {
    const { metadata: literal } = id === owner.id ? { metadata } : await UserMetadata.getUserMetadata(id, context);
    const parsed = inspectPolicyRow(id === user?.id ? owner.id : id, literal ?? {});
    const forTenant = (identity: { tenantId: string }) => tenantId === undefined || identity.tenantId === tenantId;
    return { ownerId: id, ...parsed, intents: parsed.intents.filter(forTenant), completions: parsed.completions.filter(forTenant),
      indexIds: ownerIndexIds(literal),
      reassociated: linked.has(id) && Object.entries(literal ?? {}).some(([key, value]) =>
        isDisconnectedSignInMethodMetadataKey(key) && (linked.get(id) === true ||
          (isRecord(value) && (value.userId === id || value.userId === linked.get(id))))) };
  }));
  const indexIds = new Set(rows.filter((row) => row.ownerId === owner.id || row.ownerId === user?.id)
    .flatMap((row) => row.indexIds));
  if (input.indexId) indexIds.add(input.indexId);
  const indexes = await Promise.all([...indexIds].map(async (indexId) => ({
    indexId, ownerEntryKeys: await readOwnedIndexKeys(indexId, owner.id, context),
  })));
  const ownerAbsent = !dualMapping && !user && await confirmedAbsentOwner(owner.id, context);
  return { userId, ownerId: owner.id, sdkUserId: user?.id, ownerAbsent, dualMapping, indexes,
    pinnedOwnerIds: [...linked].filter(([, pinned]) => pinned === true).map(([id]) => id), rows };
}

export async function repairSignInMethodPolicy(input: {
  userId: string;
  indexId?: string;
  remove: Array<"fences" | "invalid" | "deleted-owner">;
  dryRun: boolean;
}) {
  if (typeof input.dryRun !== "boolean" || !Array.isArray(input.remove) ||
    input.remove.some((item) => item !== "fences" && item !== "invalid" && item !== "deleted-owner")) {
    throw new TypeError("Specify dryRun and the policy record types to remove");
  }
  const state = await inspectSignInMethodPolicy(input);
  const erase = input.remove.includes("deleted-owner");
  if (state.dualMapping || state.rows.some((row) => row.ownerId === input.userId && row.reassociated) ||
    (erase && (!state.ownerAbsent || state.ownerId !== input.userId))) {
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  }
  const context = {};
  const addresses = new Set([state.ownerId, state.sdkUserId ?? state.ownerId]);
  const removals = await Promise.all([...addresses].map(async (id) => {
    const { metadata } = await UserMetadata.getUserMetadata(id, context);
    const row = inspectPolicyRow(state.ownerId, metadata ?? {});
    const keys = erase ? Object.keys(metadata ?? {}) : [
      ...(input.remove.includes("fences") ? row.fences.map(({ key }) => key) : []),
      ...(input.remove.includes("invalid") ? row.invalid.filter(({ removable }) => removable).map(({ key }) => key) : []),
    ];
    return { id, keys };
  }));
  const keys = [...new Set(removals.flatMap((row) => row.keys))];
  const indexIds = erase ? state.indexes.filter(({ ownerEntryKeys }) => ownerEntryKeys.length).map(({ indexId }) => indexId) : [];
  if (!input.dryRun) {
    // Metadata has no compare-and-swap. Operators must pause writers while repairing.
    if (erase && !await confirmedAbsentOwner(state.ownerId, context)) {
      throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
    }
    for (const indexId of indexIds) {
      await removePolicyKeys(indexId, await readOwnedIndexKeys(indexId, state.ownerId, context), context);
    }
    if (erase && keys.length) await PolicyMetadata.clearUserMetadata(state.ownerId, context);
    if (!erase) {
      for (const row of removals) await removePolicyKeys(row.id, row.keys, context);
    }
  }
  logSignInMethodPolicy("info", "rownd_disconnect_policy_repair", {
    code: "OK", ownerId: state.ownerId, step: input.dryRun ? "preview" : erase ? "deleted_owner" : "repair",
    count: keys.length + indexIds.length,
  });
  return { ownerId: state.ownerId, dryRun: input.dryRun, keys, ...(erase ? { indexIds } : {}) };
}
