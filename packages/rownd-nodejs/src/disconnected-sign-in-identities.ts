import { createHash } from "node:crypto";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { reconciliationUserMetadata as PolicyWrites } from "./reconciliation-sdk";
import { assertReconciliationWritesAllowed } from "./reconciliation-reads";
import { clearSuperTokensCoreCallCache, isRecord } from "./utils";
import { GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID } from "./constants";
import { readOwnerPlanCheckpoint } from "./migration-owner-plan";
import { RowndMigrationPolicyError } from "./errors";

type RecipeUserId = ReturnType<typeof SuperTokens.convertToRecipeUserId>;
type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type Context = Record<string, any>;

export type DisconnectedSignInMethod = {
  version: 1;
  userId: string;
  tenantId: string;
  recipeUserId: string;
  providerId: string;
  providerUserId: string;
  completed?: true;
};

const prefix = "rownd_disconnected_sign_in_identity_";
const conflictPrefix = `${prefix}owner_transition_conflict_`;
const completionPrefix = `${prefix}completion_`;

export class DisconnectedSignInMethodError extends Error {
  constructor(
    readonly code: "SIGN_IN_METHOD_DISCONNECTED" | "DISCONNECT_POLICY_INVALID" | "DISCONNECT_OWNER_CHANGED" | "DISCONNECT_RESTORATION_BLOCKED",
  ) {
    super({
      SIGN_IN_METHOD_DISCONNECTED: "This sign-in method is disconnected from this account",
      DISCONNECT_POLICY_INVALID: "Sign-in method policy requires account review",
      DISCONNECT_OWNER_CHANGED: "Sign-in method ownership changed; retry after account review",
      DISCONNECT_RESTORATION_BLOCKED: "Migration and reconciliation are unavailable for accounts with disconnected sign-in methods",
    }[code]);
    this.name = "DisconnectedSignInMethodError";
  }
}

export function isDisconnectedSignInMethodMetadataKey(key: string) {
  return key.startsWith(prefix);
}

function checkpointKey(method: Pick<DisconnectedSignInMethod, "tenantId" | "providerId" | "providerUserId">) {
  return prefix + createHash("sha256")
    .update(JSON.stringify([method.tenantId, method.providerId, method.providerUserId]))
    .digest("hex");
}

function completionKey(method: Pick<DisconnectedSignInMethod, "tenantId" | "providerId" | "providerUserId">) {
  return completionPrefix + checkpointKey(method).slice(prefix.length);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function realProvider(value: unknown): value is string {
  return nonempty(value) && value !== GUEST_AUTH_METHOD_ID && value !== INSTANT_AUTH_METHOD_ID;
}

function fresh(userContext?: Context) {
  // Security reads bypass invocation-local evidence instead of invalidating it.
  // Actual policy writes still use the facade to invalidate dependent evidence.
  clearSuperTokensCoreCallCache(userContext ?? {});
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

type Owner = { id: string; user: User | undefined; mapping: Awaited<ReturnType<typeof mappingFor>> };

async function ownerFor(userId: string, userContext?: Context, visited = new Set<string>()): Promise<Owner> {
  if (!nonempty(userId)) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  if (visited.has(userId)) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  visited.add(userId);
  const inputMapping = await mappingFor(userId, userContext);
  const user = await SuperTokens.getUser(userId, userContext);
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

function parsePolicy(userId: string, metadata: Record<string, unknown>): DisconnectedSignInMethod[] {
  const methods = new Map<string, DisconnectedSignInMethod>();
  const completions = new Map<string, DisconnectedSignInMethod>();
  for (const [key, value] of Object.entries(metadata)) {
    if (!isDisconnectedSignInMethodMetadataKey(key)) continue;
    if (key.startsWith(conflictPrefix)) {
      if (!isRecord(value) || value.version !== 1 || value.userId !== userId ||
        !nonempty(value.previousOwnerId) || key !== conflictKey(value.previousOwnerId)) {
        throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
      }
      throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
    }
    if (!isRecord(value) || value.version !== 1 || value.userId !== userId ||
      !nonempty(value.tenantId) || !nonempty(value.recipeUserId) ||
      !realProvider(value.providerId) || !nonempty(value.providerUserId)) {
      throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
    }
    const identity: DisconnectedSignInMethod = { version: 1, userId: value.userId, tenantId: value.tenantId,
      recipeUserId: value.recipeUserId, providerId: value.providerId, providerUserId: value.providerUserId };
    if (key.startsWith(completionPrefix)) {
      if (key !== completionKey(identity) || value.completed !== true) {
        throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
      }
      completions.set(checkpointKey(identity), identity);
    } else {
      if (key !== checkpointKey(identity) || "completed" in value) {
        throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
      }
      methods.set(key, identity);
    }
  }
  for (const [key, completion] of completions) {
    const intent = methods.get(key);
    if (!intent || intent.userId !== completion.userId || intent.tenantId !== completion.tenantId ||
      intent.providerId !== completion.providerId || intent.providerUserId !== completion.providerUserId ||
      intent.recipeUserId !== completion.recipeUserId) {
      throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
    }
    methods.set(key, { ...intent, completed: true });
  }
  return [...methods.values()];
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
  const result = await PolicyWrites.updateUserMetadata(userId, { [key]: fence }, userContext);
  if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  clearSuperTokensCoreCallCache(userContext ?? {});
  const { metadata } = await UserMetadata.getUserMetadata(userId, userContext);
  const saved = metadata?.[key];
  if (!isRecord(saved) || saved.version !== 1 || saved.userId !== userId || saved.previousOwnerId !== previousOwnerId) {
    throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  }
}

async function assertProtectedOwnerGraph(owner: Owner, metadata: Record<string, unknown>, userContext?: Context) {
  const rows = new Map<string, boolean>();
  let readSecondary = false;
  for (const method of owner.user?.loginMethods ?? []) {
    const id = method.recipeUserId.getAsString();
    if (id === owner.id || id === owner.mapping?.externalUserId) continue;
    readSecondary = true;
    rows.set((await mappingFor(id, userContext))?.superTokensUserId ?? id, false);
  }
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
  if (plan && plan.target === owner.id && !plan.reservation) {
    for (const member of plan.initial.graph) rows.set(member.owner, true);
  }
  rows.delete(owner.id);
  for (const [id, pinnedOwner] of rows) {
    readSecondary = true;
    const { metadata: literal } = await UserMetadata.getUserMetadata(id, userContext);
    const entries = Object.entries(literal ?? {}).filter(([key]) => isDisconnectedSignInMethodMetadataKey(key));
    // Copied linked snapshots are not authority. A live Core member must have
    // a self-bound checkpoint; a validated plan already proves its pinned owner.
    if (!entries.length || (!pinnedOwner && !entries.some(([, value]) => isRecord(value) && value.userId === id))) continue;
    await fenceOwnerTransition(owner.id, id, userContext);
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  }
  return readSecondary;
}

async function readPolicy(owner: Owner, userContext?: Context): Promise<DisconnectedSignInMethod[]> {
  const { metadata } = await UserMetadata.getUserMetadata(owner.id, userContext);
  const policy = parsePolicy(owner.id, metadata ?? {});
  const readSecondary = await assertProtectedOwnerGraph(owner, metadata ?? {}, userContext);
  if (!readSecondary) return policy;
  clearSuperTokensCoreCallCache(userContext ?? {});
  return parsePolicy(owner.id, (await UserMetadata.getUserMetadata(owner.id, userContext)).metadata ?? {});
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

function methodIdentity(method: User["loginMethods"][number]) {
  return JSON.stringify([method.recipeId, method.thirdParty?.id, method.thirdParty?.userId,
    method.email, method.phoneNumber, method.verified, [...method.tenantIds].sort()]);
}

async function freshMethodState(owner: Owner, candidate: Owner, recipeUserId: RecipeUserId, userContext?: Context) {
  const previousMethod = await recipeMethod(candidate, recipeUserId, userContext);
  fresh(userContext);
  const currentOwner = await ownerFor(owner.id, userContext);
  const currentCandidate = await ownerFor(recipeUserId.getAsString(), userContext);
  assertSameOwner(owner, currentOwner);
  assertSameOwner(candidate, currentCandidate);
  const method = await recipeMethod(currentCandidate, recipeUserId, userContext);
  if (methodIdentity(previousMethod) !== methodIdentity(method)) {
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  }
  // Read policy last, after resolving the live graph. Neither SDK nor invocation
  // caches may turn an earlier permission check into a commit-time decision.
  return { owner: currentOwner, candidate: currentCandidate, method,
    policy: await readPolicy(currentOwner, userContext) };
}

function assertMethodAllowed(method: User["loginMethods"][number], tenantId: string, policy: DisconnectedSignInMethod[]) {
  if (policy.some((entry) => entry.tenantId === tenantId && method.recipeId === "thirdparty" &&
    entry.providerId === method.thirdParty?.id && entry.providerUserId === method.thirdParty.userId)) {
    throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED");
  }
}

export async function getDisconnectedSignInMethods(userId: string, userContext?: Context): Promise<DisconnectedSignInMethod[]> {
  fresh(userContext);
  return readPolicy(await ownerFor(userId, userContext), userContext);
}

export async function recordDisconnectedSignInMethod(
  input: Omit<DisconnectedSignInMethod, "version" | "completed">,
  userContext?: Context,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  if (!nonempty(input.userId) || !nonempty(input.tenantId) || !nonempty(input.recipeUserId) ||
    !realProvider(input.providerId) || !nonempty(input.providerUserId)) {
    throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  }
  fresh(userContext);
  const owner = await ownerFor(input.userId, userContext);
  assertPrimaryReference(owner, input.userId);
  const policy = await readPolicy(owner, userContext);
  const recipeMapping = await mappingFor(input.recipeUserId, userContext);
  const recipeId = recipeMapping?.superTokensUserId ?? input.recipeUserId;
  const existing = policy.find((entry) => checkpointKey(entry) === checkpointKey(input));
  if (existing) {
    if (existing.recipeUserId !== recipeId) throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED");
    fresh(userContext);
    const currentOwner = await ownerFor(input.userId, userContext);
    assertSameOwner(owner, currentOwner);
    if (!(await readPolicy(currentOwner, userContext)).some((entry) =>
      checkpointKey(entry) === checkpointKey(input) && entry.recipeUserId === recipeId)) {
      throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
    }
    await beforeCommit?.();
    return;
  }
  const candidate = await ownerFor(input.recipeUserId, userContext);
  const method = await recipeMethod(owner, SuperTokens.convertToRecipeUserId(input.recipeUserId), userContext);
  if (!owner.user || candidate.id !== owner.id || method.recipeId !== "thirdparty" ||
    !method.tenantIds.includes(input.tenantId) || method.thirdParty?.id !== input.providerId ||
    method.thirdParty.userId !== input.providerUserId) {
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  }
  const checkpoint: DisconnectedSignInMethod = { version: 1, userId: owner.id, recipeUserId: recipeId,
    tenantId: input.tenantId, providerId: input.providerId, providerUserId: input.providerUserId };
  // Independent top-level fields avoid lost updates between different identities.
  await beforeCommit?.();
  const result = await PolicyWrites.updateUserMetadata(owner.id, { [checkpointKey(checkpoint)]: checkpoint }, userContext);
  if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
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
  input: Omit<DisconnectedSignInMethod, "version" | "completed">,
  userContext?: Context,
): Promise<void> {
  fresh(userContext);
  const owner = await ownerFor(input.userId, userContext);
  assertPrimaryReference(owner, input.userId);
  if (!owner.user) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  const recipeId = (await mappingFor(input.recipeUserId, userContext))?.superTokensUserId ?? input.recipeUserId;
  const existing = (await readPolicy(owner, userContext)).find((entry) => checkpointKey(entry) === checkpointKey(input));
  if (!existing || existing.recipeUserId !== recipeId) throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  if (!existing.completed) {
    // A delayed first-time intent write must never replace completion state.
    const result = await PolicyWrites.updateUserMetadata(owner.id, { [completionKey(existing)]: { ...existing, completed: true } }, userContext);
    if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  }
  fresh(userContext);
  const current = await ownerFor(input.userId, userContext);
  assertSameOwner(owner, current);
  if (!(await readPolicy(current, userContext)).some((entry) => checkpointKey(entry) === checkpointKey(input) &&
    entry.recipeUserId === recipeId && entry.completed === true)) {
    throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  }
}

export async function assertSignInMethodAuthenticationAllowed(
  userId: string, recipeUserId: RecipeUserId, tenantId: string, userContext?: Context,
): Promise<{ policy: DisconnectedSignInMethod[]; method?: User["loginMethods"][number] }> {
  fresh(userContext);
  const owner = await ownerFor(userId, userContext);
  assertPrimaryReference(owner, userId);
  const initialPolicy = await readPolicy(owner, userContext);
  if (!owner.user) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  // The empty result includes literal linked/pinned-owner checks, not just the
  // canonical row. Ordinary recipe membership remains the SDK's responsibility.
  if (!initialPolicy.length) return { policy: [] };
  const candidate = await ownerFor(recipeUserId.getAsString(), userContext);
  if (!owner.user || candidate.id !== owner.id) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  const { method, policy } = await freshMethodState(owner, candidate, recipeUserId, userContext);
  if (!method.tenantIds.includes(tenantId)) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  assertMethodAllowed(method, tenantId, policy);
  return { method, policy };
}

export async function assertSignInMethodLinkAllowed(
  primaryUserId: string, recipeUserId: RecipeUserId, userContext?: Context,
): Promise<void> {
  fresh(userContext);
  const owner = await ownerFor(primaryUserId, userContext);
  assertPrimaryReference(owner, primaryUserId);
  await readPolicy(owner, userContext);
  const candidate = await ownerFor(recipeUserId.getAsString(), userContext);
  if (!owner.user || !candidate.user) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  const current = await freshMethodState(owner, candidate, recipeUserId, userContext);
  // Linking a primary graph would transfer its policy without a supported owner
  // migration protocol. Do not discard it or promote it into the destination.
  if (candidate.id !== owner.id && (await readPolicy(current.candidate, userContext)).length > 0) {
    throw new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
  }
  // Donor reads must not leave an older destination policy as the final proof.
  clearSuperTokensCoreCallCache(userContext ?? {});
  const policy = await readPolicy(current.owner, userContext);
  const methods = candidate.id === owner.id ? [current.method] : current.candidate.user!.loginMethods;
  for (const method of methods) {
    for (const tenantId of method.tenantIds) assertMethodAllowed(method, tenantId, policy);
  }
}

export async function assertSignInMethodTenantAssociationAllowed(
  recipeUserId: RecipeUserId, tenantId: string, userContext?: Context,
): Promise<void> {
  if (!nonempty(tenantId)) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  fresh(userContext);
  const owner = await ownerFor(recipeUserId.getAsString(), userContext);
  await readPolicy(owner, userContext);
  const { method, policy } = await freshMethodState(owner, owner, recipeUserId, userContext);
  assertMethodAllowed(method, tenantId, policy);
}

export async function assertNoDisconnectedSignInMethods(userId: string, userContext?: Context): Promise<void> {
  fresh(userContext);
  const pinnedId = (await mappingFor(userId, userContext))?.superTokensUserId ?? userId;
  await assertNoDisconnectedSignInMethodsAtInternalOwner(pinnedId, userContext);
  if ((await getDisconnectedSignInMethods(userId, userContext)).length > 0) {
    throw new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
  }
}

export async function assertNoDisconnectedSignInMethodsAtInternalOwner(
  internalOwnerId: string, userContext?: Context, transitionTargetUserId?: string,
): Promise<void> {
  fresh(userContext);
  const { metadata } = await UserMetadata.getUserMetadata(internalOwnerId, userContext);
  let failure: DisconnectedSignInMethodError | undefined;
  try {
    if (!parsePolicy(internalOwnerId, metadata ?? {}).length) return;
    failure = new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
  } catch (error) {
    if (!(error instanceof DisconnectedSignInMethodError)) throw error;
    failure = error;
  }
  // This argument is a pinned internal metadata row, not a selector to redirect
  // through today's primary. Its checkpoint remains evidence after reassociation.
  let current: Owner | undefined;
  try {
    current = await ownerFor(internalOwnerId, userContext);
  } catch (error) {
    if (!(error instanceof DisconnectedSignInMethodError)) throw error;
  }
  if (current?.user) await fenceOwnerTransition(current.id, internalOwnerId, userContext);
  if (transitionTargetUserId && (!current?.user || current.id !== internalOwnerId)) {
    const target = await ownerFor(transitionTargetUserId, userContext);
    if (target.user) await fenceOwnerTransition(target.id, internalOwnerId, userContext);
  }
  throw failure;
}
