import { createHash } from "node:crypto";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { reconciliationSuperTokens as ReconciliationCore, reconciliationUserMetadata as PolicyMetadata } from "./reconciliation-sdk";
import { assertReconciliationWritesAllowed } from "./reconciliation-reads";
import { clearSuperTokensCoreCallCache, isRecord } from "./utils";
import { GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID } from "./constants";
import { readOwnerPlanCheckpoint } from "./migration-owner-plan";
import { RowndMigrationPolicyError } from "./errors";
import { logSignInMethodPolicy } from "./sign-in-method-policy-log";

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
const indexField = "rownd_disconnected_sign_in_identity_index";

export class DisconnectedSignInMethodError extends Error {
  constructor(
    readonly code: "SIGN_IN_METHOD_DISCONNECTED" | "DISCONNECT_POLICY_INVALID" | "DISCONNECT_OWNER_CHANGED" | "DISCONNECT_RESTORATION_BLOCKED",
    readonly ownerId?: string,
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

type Identity = Pick<DisconnectedSignInMethod, "tenantId" | "providerId" | "providerUserId">;

function checkpointKey(method: Identity) {
  return prefix + createHash("sha256")
    .update(JSON.stringify([method.tenantId, method.providerId, method.providerUserId]))
    .digest("hex");
}

function completionKey(method: Pick<DisconnectedSignInMethod, "tenantId" | "providerId" | "providerUserId">) {
  return completionPrefix + checkpointKey(method).slice(prefix.length);
}

function identityIndexId(identity: Identity) {
  return `rownd_dsi:${checkpointKey(identity).slice(prefix.length)}`;
}

export async function assertSignInIdentityNotIndexed(identity: Identity, userContext?: Context) {
  if (!realProvider(identity.providerId)) return;
  const { metadata } = await UserMetadata.getUserMetadata(identityIndexId(identity), userContext);
  if (!Object.prototype.hasOwnProperty.call(metadata ?? {}, indexField)) return;
  const entry = metadata[indexField];
  logSignInMethodPolicy("warn", "rownd_disconnect_index_denied", {
    code: "SIGN_IN_METHOD_DISCONNECTED", step: "signin", tenantId: identity.tenantId,
    providerId: identity.providerId, ownerId: isRecord(entry) && nonempty(entry.ownerId) ? entry.ownerId : undefined,
  });
  throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED",
    isRecord(entry) && nonempty(entry.ownerId) ? entry.ownerId : undefined);
}

async function writeIdentityIndex(method: DisconnectedSignInMethod, userContext?: Context) {
  const { userId: ownerId, tenantId, providerId } = method;
  const id = identityIndexId(method);
  const { metadata } = await UserMetadata.getUserMetadata(id, uncachedContext(userContext));
  if (Object.prototype.hasOwnProperty.call(metadata ?? {}, indexField)) return;
  const result = await PolicyMetadata.updateUserMetadata(id, {
    [indexField]: { version: 1, ownerId, tenantId, providerId, at: Date.now() },
  }, userContext);
  if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function realProvider(value: unknown): value is string {
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

function inspectPolicyRow(userId: string, metadata: Record<string, unknown>) {
  const methods = new Map<string, DisconnectedSignInMethod>();
  const completions = new Map<string, DisconnectedSignInMethod>();
  const fences: Array<{ key: string; previousOwnerId: string }> = [];
  const invalid: Array<{ key: string; reason: string; removable: boolean }> = [];
  const unknown: Array<{ key: string; identity?: Identity }> = [];
  const malformed = (key: string, reason: string, removable = true) => invalid.push({ key, reason, removable });
  for (const [key, value] of Object.entries(metadata)) {
    if (!isDisconnectedSignInMethodMetadataKey(key)) continue;
    if (isRecord(value) && "version" in value && value.version !== 1) {
      const identity = (value.userId === userId || value.userId === undefined) && nonempty(value.tenantId) &&
        realProvider(value.providerId) && nonempty(value.providerUserId)
        ? { tenantId: value.tenantId, providerId: value.providerId, providerUserId: value.providerUserId }
        : undefined;
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
      !realProvider(value.providerId) || !nonempty(value.providerUserId)) {
      malformed(key, "Invalid version 1 record fields");
      continue;
    }
    const identity: DisconnectedSignInMethod = { version: 1, userId: value.userId, tenantId: value.tenantId,
      recipeUserId: value.recipeUserId, providerId: value.providerId, providerUserId: value.providerUserId };
    if (key.startsWith(completionPrefix)) {
      if (key !== completionKey(identity) || value.completed !== true) {
        malformed(key, "Invalid completion key or marker");
        continue;
      }
      completions.set(key, identity);
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
      intent.providerId !== completion.providerId || intent.providerUserId !== completion.providerUserId ||
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
  const result = await PolicyMetadata.updateUserMetadata(userId, { [key]: fence }, userContext);
  if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  logSignInMethodPolicy("warn", "rownd_disconnect_fence_written", {
    code: "DISCONNECT_OWNER_CHANGED", ownerId: userId, step: "fence",
  });
  const { metadata } = await UserMetadata.getUserMetadata(userId, uncachedContext(userContext));
  const saved = metadata?.[key];
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

async function protectedOwnerRows(owner: Owner, metadata: Record<string, unknown>, userContext?: Context, strict = false) {
  const rows = new Map<string, boolean>();
  for (const method of owner.user?.loginMethods ?? []) {
    const id = method.recipeUserId.getAsString();
    if (id === owner.id || id === owner.mapping?.externalUserId) continue;
    const mapping = strict ? await mappingFor(id, userContext) :
      await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext });
    if (mapping?.status === "OK") rows.set(mapping.superTokensUserId, false);
    rows.set(id, false);
  }
  for (const id of pinnedOwners(owner.id, metadata)) rows.set(id, true);
  rows.delete(owner.id);
  return rows;
}

async function assertProtectedOwnerGraph(owner: Owner, metadata: Record<string, unknown>, userContext?: Context, strict = false) {
  const rows = await protectedOwnerRows(owner, metadata, userContext, strict);
  for (const [id, pinnedOwner] of rows) {
    const { metadata: literal } = await UserMetadata.getUserMetadata(id, userContext);
    const entries = Object.entries(literal ?? {}).filter(([key]) => isDisconnectedSignInMethodMetadataKey(key));
    // Copied linked snapshots are not authority. A live Core member must have
    // a self-bound checkpoint; a validated plan already proves its pinned owner.
    if (!entries.length || (!pinnedOwner && !entries.some(([, value]) => isRecord(value) && value.userId === id))) continue;
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED", owner.id);
  }
  return rows.size > 0;
}

async function readPolicy(owner: Owner, userContext?: Context): Promise<DisconnectedSignInMethod[]> {
  const { metadata } = await UserMetadata.getUserMetadata(owner.id, userContext);
  const policy = parsePolicy(owner.id, metadata ?? {});
  if (owner.mapping) await mappingFor(owner.mapping.externalUserId, userContext);
  const readSecondary = await assertProtectedOwnerGraph(owner, metadata ?? {}, userContext, true);
  if (!readSecondary) return policy.methods;
  return parsePolicy(owner.id, (await UserMetadata.getUserMetadata(owner.id, uncachedContext(userContext))).metadata ?? {}).methods;
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

function assertMethodAllowed(method: User["loginMethods"][number], tenantId: string, policy: Identity[], ownerId: string) {
  if (policy.some((entry) => entry.tenantId === tenantId && method.recipeId === "thirdparty" &&
    entry.providerId === method.thirdParty?.id && entry.providerUserId === method.thirdParty.userId)) {
    throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED", ownerId);
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
    await writeIdentityIndex(existing, userContext);
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
  const result = await PolicyMetadata.updateUserMetadata(owner.id, { [checkpointKey(checkpoint)]: checkpoint }, userContext);
  if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  await writeIdentityIndex(checkpoint, userContext);
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
    const result = await PolicyMetadata.updateUserMetadata(owner.id, { [completionKey(existing)]: { ...existing, completed: true } }, userContext);
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

function hasPolicy(metadata: Record<string, unknown>) {
  return Object.keys(metadata ?? {}).some(isDisconnectedSignInMethodMetadataKey);
}

async function lenientOwner(id: string, userContext: Context | undefined, user?: User) {
  const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext });
  return { id: mapping.status === "OK" ? mapping.superTokensUserId : id, user,
    mapping: mapping.status === "OK" ? mapping : undefined };
}

type Gate = {
  reference: string;
  owner: Owner;
  literalIds: string[];
  policy?: ReturnType<typeof parsePolicy>;
};

async function assertLiteralReferences(literalIds: string[], userContext?: Context) {
  for (const id of literalIds) {
    const { metadata } = await UserMetadata.getUserMetadata(id, userContext);
    if (!hasPolicy(metadata)) continue;
    const internal = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext });
    if (internal.status === "OK" || Object.entries(metadata).some(([key, value]) =>
      isDisconnectedSignInMethodMetadataKey(key) && isRecord(value) && value.userId === id)) {
      throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
    }
  }
}

export async function readPolicyGate(
  reference: string, userContext: Context | undefined,
  options: { scope: "session" | "signin"; user?: User; previous?: Gate },
): Promise<Gate> {
  const previous = options.previous?.reference === reference ? options.previous : undefined;
  let owner = previous?.owner ?? await lenientOwner(reference, userContext);
  const literalIds = new Set(previous?.literalIds);
  if (reference !== owner.id) literalIds.add(reference);
  await assertLiteralReferences([...literalIds], previous ? uncachedContext(userContext) : userContext);
  let activeContext = previous ? uncachedContext(userContext) : userContext;
  let { metadata } = await UserMetadata.getUserMetadata(owner.id, activeContext);
  if (!previous && options.scope === "signin") {
    const user = options.user ?? await SuperTokens.getUser(reference, userContext);
    if (user && user.id !== reference) {
      const primary = await lenientOwner(user.id, userContext, user);
      if (primary.id !== owner.id) {
        if (hasPolicy(metadata)) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
        literalIds.add(owner.id);
        ({ metadata } = await UserMetadata.getUserMetadata(primary.id, userContext));
      }
      owner = primary;
    } else {
      owner = { ...owner, user };
    }
    literalIds.delete(owner.id);
    const scanned = await assertProtectedOwnerGraph(owner, metadata ?? {}, userContext);
    if (scanned && !hasPolicy(metadata)) {
      activeContext = uncachedContext(userContext);
      ({ metadata } = await UserMetadata.getUserMetadata(owner.id, activeContext));
    }
  }
  if (hasPolicy(metadata)) {
    const policy = parsePolicy(owner.id, metadata ?? {}, "auth");
    // Unknown versions alone must never turn legacy graph anomalies into lockouts.
    if (policy.methods.length || !policy.unknown) {
      const strict = await ownerFor(reference, activeContext);
      if (strict.id !== owner.id || !strict.user) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
      await assertProtectedOwnerGraph(strict, metadata ?? {}, activeContext, true);
      owner = strict;
    }
    return { reference, owner, literalIds: [...literalIds], policy };
  }
  if (!previous && options.scope === "session" && pinnedOwners(owner.id, metadata ?? {}).length) {
    await assertProtectedOwnerGraph(owner, metadata, userContext);
  }
  return { reference, owner, literalIds: [...literalIds] };
}

export async function checkSignInMethodAuthentication(
  userId: string, recipeUserId: RecipeUserId, tenantId: string, userContext?: Context,
  options: Parameters<typeof readPolicyGate>[2] = { scope: "signin" },
) {
  const gate = await readPolicyGate(userId, userContext, options);
  let method: User["loginMethods"][number] | undefined;
  if (gate.policy) {
    if (gate.policy.unknown && !gate.policy.methods.length) {
      const user = gate.owner.user ?? await SuperTokens.getUser(userId, userContext);
      method = await lenientRecipeMethod({ ...gate.owner, user }, recipeUserId, userContext);
    } else {
      method = await recipeMethod(gate.owner, recipeUserId, userContext);
      if (!method.tenantIds.includes(tenantId)) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
    }
    if (method) assertMethodAllowed(method, tenantId, gate.policy.identities, gate.owner.id);
  }
  return { gate, method, policy: gate.policy?.methods ?? [] };
}

export async function assertSignInMethodAuthenticationAllowed(
  userId: string, recipeUserId: RecipeUserId, tenantId: string, userContext?: Context,
): Promise<{ policy: DisconnectedSignInMethod[]; method?: User["loginMethods"][number] }> {
  const { method, policy } = await checkSignInMethodAuthentication(userId, recipeUserId, tenantId, userContext);
  return method ? { method, policy } : { policy };
}

export async function assertSignInMethodLinkAllowed(
  primaryUserId: string, recipeUserId: RecipeUserId, userContext?: Context,
): Promise<void> {
  const owner = await readPolicyGate(primaryUserId, userContext, { scope: "signin" });
  const candidate = await readPolicyGate(recipeUserId.getAsString(), userContext, { scope: "signin" });
  if (candidate.owner.id !== owner.owner.id && candidate.policy) {
    throw new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
  }
  const { policy } = await readPolicyGate(primaryUserId, userContext, { scope: "signin", previous: owner });
  const sameOwner = candidate.owner.id === owner.owner.id;
  const linkedMethod = sameOwner ? await lenientRecipeMethod(candidate.owner, recipeUserId, userContext) : undefined;
  const methods = sameOwner ? (linkedMethod ? [linkedMethod] : []) : candidate.owner.user?.loginMethods ?? [];
  if (!methods.length && policy && !policy.unknown) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  for (const method of methods) {
    for (const tenantId of method.tenantIds) {
      if (policy) assertMethodAllowed(method, tenantId, policy.identities, owner.owner.id);
      if (!sameOwner) await assertRecipeIdentityNotIndexed(method, tenantId, userContext);
    }
  }
}

export async function assertSignInMethodTenantAssociationAllowed(
  recipeUserId: RecipeUserId, tenantId: string, userContext?: Context,
): Promise<void> {
  const gate = await readPolicyGate(recipeUserId.getAsString(), userContext, { scope: "signin" });
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
  if (!hasPolicy(metadata)) return;
  parsePolicy(ownerId, metadata ?? {});
  throw new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
}

export async function assertNoDisconnectedSignInMethodsAtInternalOwner(
  internalOwnerId: string, userContext?: Context, transitionTargetUserId?: string,
  options: { fresh?: boolean; allowFence?: boolean } = {},
): Promise<void> {
  const { metadata } = options.fresh
    ? await UserMetadata.getUserMetadata(internalOwnerId, uncachedContext(userContext))
    : await PolicyMetadata.getUserMetadata(internalOwnerId, userContext);
  if (!hasPolicy(metadata)) return;
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
  if (!options.allowFence && !transitionTargetUserId) throw failure;
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

export async function inspectSignInMethodPolicy(input: { userId: string; tenantId?: string }) {
  const { userId, tenantId } = input;
  if (!nonempty(userId)) throw new TypeError("A user ID is required");
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
  const linked = await protectedOwnerRows(owner, metadata ?? {}, context);
  const ids = new Set([owner.id, userId, ...linked.keys(),
    ...(external.status === "OK" ? [external.superTokensUserId] : []),
    ...(internal.status === "OK" ? [internal.superTokensUserId] : [])]);
  const rows = await Promise.all([...ids].map(async (id) => {
    const { metadata: literal } = id === owner.id ? { metadata } : await UserMetadata.getUserMetadata(id, context);
    const parsed = inspectPolicyRow(id, literal ?? {});
    const forTenant = (identity: Identity) => tenantId === undefined || identity.tenantId === tenantId;
    return { ownerId: id, ...parsed, intents: parsed.intents.filter(forTenant), completions: parsed.completions.filter(forTenant),
      reassociated: linked.has(id) && Object.entries(literal ?? {}).some(([key, value]) =>
        isDisconnectedSignInMethodMetadataKey(key) && (linked.get(id) || (isRecord(value) && value.userId === id))) };
  }));
  return { userId, ownerId: owner.id, dualMapping, pinnedOwnerIds: [...linked].filter(([, pinned]) => pinned).map(([id]) => id), rows };
}

export async function repairSignInMethodPolicy(input: {
  userId: string;
  remove: Array<"fences" | "invalid">;
  dryRun: boolean;
}) {
  if (typeof input.dryRun !== "boolean" || !Array.isArray(input.remove) ||
    input.remove.some((item) => item !== "fences" && item !== "invalid")) {
    throw new TypeError("Specify dryRun and the policy record types to remove");
  }
  const state = await inspectSignInMethodPolicy(input);
  if (state.dualMapping || state.rows.some((row) => row.ownerId === input.userId && row.reassociated) ||
    input.userId.startsWith("rownd_dsi:")) {
    throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
  }
  const context = {};
  const { metadata } = await UserMetadata.getUserMetadata(state.ownerId, context);
  const row = inspectPolicyRow(state.ownerId, metadata ?? {});
  const keys = [
    ...(input.remove.includes("fences") ? row.fences.map(({ key }) => key) : []),
    ...(input.remove.includes("invalid") ? row.invalid.filter(({ removable }) => removable).map(({ key }) => key) : []),
  ];
  if (!input.dryRun && keys.length) {
    // Metadata has no compare-and-swap. Operators must pause writers while repairing.
    const result = await PolicyMetadata.updateUserMetadata(state.ownerId,
      Object.fromEntries(keys.map((key) => [key, null])), context);
    if (result.status !== "OK") throw new DisconnectedSignInMethodError("DISCONNECT_POLICY_INVALID");
  }
  logSignInMethodPolicy("info", "rownd_disconnect_policy_repair", {
    code: "OK", ownerId: state.ownerId, step: input.dryRun ? "preview" : "repair", count: keys.length,
  });
  return { ownerId: state.ownerId, dryRun: input.dryRun, keys };
}
