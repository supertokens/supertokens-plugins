import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bindOwnerEmailPlan, checkpointEmailPointer } from "./migration-owner-email";
import {
  reconciliationSuperTokens as SuperTokens,
  reconciliationAccountLinking as AccountLinking,
  reconciliationEmailVerification as EmailVerification,
  reconciliationUserMetadata as UserMetadata,
} from "./reconciliation-sdk";
import { RowndMigrationPolicyError } from "./errors";
import {
  assertAuthenticatedMigrationSource,
  assertRowndSourcePayload,
  getAuthenticatedMigrationEmail,
  isAdministrativeMigration,
  isRowndMigrationProfileActive,
} from "./migration-email";
import {
  isAdministrativeElectionCandidate,
  sharesAdministrativeElectionPhone,
  sharesAdministrativeInstantPrimary,
  assertAdministrativeInstantProfiles,
  hasAdministrativeInstantProof,
  type ActivityCandidate,
} from "./migration-election";
import {
  assertMigrationMapping,
  assertSelectorNamespace,
} from "./migration-mapping";
import { assertMigrationOwnerGraph } from "./migration-postconditions";
import {
  planOwnerOperations,
  OWNER_PLAN_KEY,
  OWNER_POLICY_MARKER_KEYS,
  ownerStateAt,
  readOwnerPlanCheckpoint,
  sameOwnerPlan,
  instantPrimaryAnchor,
  ambiguousOwnerSessionAliases,
  type OwnerPlanCheckpoint,
  type OwnerRecipe,
  type OwnerState,
} from "./migration-owner-plan";
import {
  getRawUserMetadata,
  mapRowndUserToSuperTokens,
} from "./rownd-compatibility";
import { fetchOptionalRowndUserInfo } from "./rownd-repository";
import {
  getCanonicalEmailRecipeUserId,
  getPendingVerifications,
  matchesImportLoginMethod,
} from "./supertokens-repository";
import { observeAdministrativeMethodCreation } from "./migration-method-receipts";
import { assertMappingPublicationSessionMembership } from "./migration-publication";
import { assertVerificationCellInheritance } from "./migration-verification";
import { resolveRowndProviderSubject } from "./provider-identity";
import {
  clearSuperTokensCoreCallCache,
  isRecord,
  type JsonRecord,
} from "./utils";
import type { RowndUser, SuperTokensUserImport } from "./types";
import type { ReconcilePreviewAction } from "./reconcile-preview";
import { invalidateReconciliationReads, reconciliationReadRevision } from "./reconciliation-reads";

type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type Method = User["loginMethods"][number];
type Member = {
  rownd_user_id: string;
  supertokens_user_id: string;
  identity: string;
  unverifiedEmail?: string;
};
type Checkpoint = {
  version: 1;
  winner: string;
  target: string;
  members: Member[];
  status: "LINKING" | "COMPLETE";
};
const key = OWNER_PLAN_KEY;
const recoveryKey = "rownd_migration_owner_recovery";

export async function readOwnerRecoveryCheckpoint(
  metadata: JsonRecord,
  sourceId: string,
  context: JsonRecord,
) {
  const recovery = metadata[recoveryKey];
  if (recovery === undefined) return undefined;
  if (
    !isRecord(recovery) ||
    typeof recovery.target !== "string" ||
    typeof recovery.planId !== "string"
  )
    throw new RowndMigrationPolicyError("Invalid owner recovery pointer");
  const plan = readOwnerPlanCheckpoint(
    await getRawUserMetadata(recovery.target, context),
  );
  if (
    !plan ||
    plan.id !== recovery.planId ||
    plan.target !== recovery.target ||
    !plan.candidates.some((candidate) => candidate.rownd_user_id === sourceId)
  ) {
    throw new RowndMigrationPolicyError(
      "Owner recovery pointer does not match its checkpoint",
    );
  }
  return plan;
}

export class UnresolvedConsolidationOwners extends RowndMigrationPolicyError {
  constructor(
    readonly owners: ActivityCandidate[],
    reason: string,
  ) {
    super(`Duplicate owner consolidation blocked: ${reason}`);
  }
}

export function readConsolidationCheckpoint(
  metadata: JsonRecord,
): Checkpoint | undefined {
  const record = metadata[key];
  if (record === undefined) return undefined;
  if (isRecord(record) && record.version === 2) {
    readOwnerPlanCheckpoint(metadata);
    return undefined;
  }
  if (
    !isRecord(record) ||
    record.version !== 1 ||
    typeof record.winner !== "string" ||
    typeof record.target !== "string" ||
    !["LINKING", "COMPLETE"].includes(String(record.status)) ||
    !Array.isArray(record.members) ||
    record.members.length < 2 ||
    record.members.some(
      (member) =>
        !isRecord(member) ||
        typeof member.rownd_user_id !== "string" ||
        typeof member.supertokens_user_id !== "string" ||
        typeof member.identity !== "string" ||
        (member.unverifiedEmail !== undefined &&
          typeof member.unverifiedEmail !== "string"),
    )
  ) {
    throw new RowndMigrationPolicyError(
      "Invalid duplicate owner consolidation checkpoint",
    );
  }
  const checkpoint = record as Checkpoint;
  if (
    new Set(checkpoint.members.map((member) => member.rownd_user_id)).size !==
      checkpoint.members.length ||
    new Set(checkpoint.members.map((member) => member.supertokens_user_id))
      .size !== checkpoint.members.length ||
    !checkpoint.members.some(
      (member) =>
        member.rownd_user_id === checkpoint.winner &&
        member.supertokens_user_id === checkpoint.target,
    )
  ) {
    throw new RowndMigrationPolicyError(
      "Invalid duplicate owner consolidation checkpoint",
    );
  }
  return checkpoint;
}

async function immutableId(sdkId: string, context: JsonRecord) {
  await assertSelectorNamespace(sdkId, context);
  const mapping = await SuperTokens.getUserIdMapping({
    userId: sdkId,
    userIdType: "EXTERNAL",
    userContext: context,
  });
  return mapping.status === "OK" ? mapping.superTokensUserId : sdkId;
}

async function sdkId(id: string, context: JsonRecord) {
  const mapping = await SuperTokens.getUserIdMapping({
    userId: id,
    userIdType: "SUPERTOKENS",
    userContext: context,
  });
  return mapping.status === "OK" ? mapping.externalUserId : id;
}

function identity(method: Method) {
  return JSON.stringify([
    method.recipeId,
    method.email,
    method.phoneNumber,
    method.thirdParty,
    [...method.tenantIds].sort(),
    method.timeJoined,
    method.webauthn,
  ]);
}

function hasNativeContactEmail(user: User, email: string) {
  return user.loginMethods.some(
    (method) =>
      (method.recipeId === "passwordless" ||
        method.recipeId === "emailpassword") &&
      method.hasSameEmailAs(email),
  );
}

async function recipeMethod(user: User, id: string, context: JsonRecord) {
  for (const method of user.loginMethods)
    if ((await immutableId(method.recipeUserId.getAsString(), context)) === id)
      return method;
  return undefined;
}

async function assertV1(checkpoint: Checkpoint, context: JsonRecord) {
  if (checkpoint.status !== "COMPLETE")
    throw new RowndMigrationPolicyError("Owner consolidation is incomplete");
  for (const member of checkpoint.members) {
    await assertSelectorNamespace(member.rownd_user_id, context);
    await assertMigrationMapping(
      member.supertokens_user_id,
      member.rownd_user_id,
      context,
    );
    const user = await SuperTokens.getUser(member.supertokens_user_id, context);
    const method =
      user && (await recipeMethod(user, member.supertokens_user_id, context));
    if (
      !user ||
      user.id !== checkpoint.winner ||
      !user.isPrimaryUser ||
      !method ||
      JSON.stringify([
        method.recipeId,
        method.email,
        method.phoneNumber,
        method.thirdParty,
        [...method.tenantIds].sort(),
      ]) !== member.identity
    ) {
      throw new RowndMigrationPolicyError(
        "Owner consolidation session membership changed",
      );
    }
    await assertMigrationOwnerGraph(user, "public", context);
  }
  if (
    !isDeepStrictEqual(
      readConsolidationCheckpoint(
        await getRawUserMetadata(checkpoint.target, context),
      ),
      checkpoint,
    )
  ) {
    throw new RowndMigrationPolicyError(
      "Owner consolidation checkpoint changed",
    );
  }
}

const markerKeys = [
  "original_rownd_user",
  "rownd_migration_target",
  "rownd_migration_canonical_target",
  "rownd_migration_superseded",
  "rownd_migration_reconciliation",
  ...OWNER_POLICY_MARKER_KEYS,
];
function markers(metadata: JsonRecord) {
  return Object.fromEntries(
    markerKeys
      .filter((field) => metadata[field] !== undefined)
      .map((field) => [field, metadata[field]]),
  );
}

async function assertOwnerEmailPolicy(
  metadata: Awaited<ReturnType<typeof getRawUserMetadata>>,
  user: User | undefined,
  email: string | undefined,
  context: JsonRecord,
  plannedRecipes?: OwnerRecipe[],
  plan?: OwnerPlanCheckpoint,
) {
  const fail = () => {
    throw new RowndMigrationPolicyError("CANONICAL_EMAIL_POLICY");
  };
  const pending = metadata.rownd_pending_verification;
  if (
    pending !== undefined &&
    (!Array.isArray(pending) ||
      pending.length !== getPendingVerifications(metadata).length)
  )
    fail();
  if (
    getPendingVerifications(metadata).some(
      (entry) =>
        entry.field === "email" && (entry.tenantId ?? "public") === "public",
    )
  )
    fail();
  for (const field of [
    "rownd_migration_email_retirements",
    "rownd_migration_provider_retirements",
    "rownd_migration_provider_introductions",
    "rownd_migration_provider_introduction",
  ] as const) {
    const value = metadata[field];
    if (
      value !== undefined &&
      ((!isRecord(value) && !Array.isArray(value)) ||
        Object.keys(value as object).length > 0)
    )
      fail();
  }
  if (
    metadata.rownd_email_recipe_user_ids !== undefined &&
    !isRecord(metadata.rownd_email_recipe_user_ids)
  )
    fail();
  if (
    metadata.rownd_email_recipe_user_ids?.public !== undefined &&
    (typeof metadata.rownd_email_recipe_user_ids.public !== "string" ||
      !metadata.rownd_email_recipe_user_ids.public)
  )
    fail();
  const pointer = getCanonicalEmailRecipeUserId(metadata, "public");
  if (pointer === undefined) return;
  if (typeof pointer !== "string" || !pointer || !email) return fail();
  const resolved = await immutableId(pointer, context);
  const id = resolved === pointer && plan ? checkpointEmailPointer(plan, pointer) ?? resolved : resolved;
  if (resolved === pointer && id !== pointer && await SuperTokens.getUser(pointer, context)) fail();
  const planned = plannedRecipes?.find((recipe) => recipe.id === id);
  const pointerOwner = planned ? await SuperTokens.getUser(id, context) : user;
  const method =
    pointerOwner && (await recipeMethod(pointerOwner, id, context));
  if (planned && method && identity(method) !== planned.identity) fail();
  if (
    !method ||
    method.recipeId !== "passwordless" ||
    !method.email ||
    !method.tenantIds.includes("public")
  )
    fail();
}

async function optionalProfile(id: string): Promise<RowndUser | undefined> {
  let profile: RowndUser | undefined;
  try {
    profile = await fetchOptionalRowndUserInfo(id);
  } catch (error) {
    if (
      !(
        isRecord(error) &&
        isRecord(error.response) &&
        error.response.statusCode === 404
      )
    )
      throw error;
  }
  if (!profile) return undefined;
  assertRowndSourcePayload(profile);
  if (profile.data.user_id !== id || !isRowndMigrationProfileActive(profile))
    throw new RowndMigrationPolicyError(
      "A required consolidation source changed",
    );
  return profile;
}

async function requiredProfile(id: string): Promise<RowndUser> {
  const profile = await optionalProfile(id);
  if (!profile)
    throw new RowndMigrationPolicyError(
      "A required consolidation source disappeared",
    );
  return profile;
}

function sharedProfile(left: RowndUser, right: RowndUser) {
  const email = left.data.email?.toLowerCase();
  if (email && right.data.email?.toLowerCase() === email) return true;
  const methods = mapRowndUserToSuperTokens(right, "public").loginMethods;
  return mapRowndUserToSuperTokens(left, "public").loginMethods.some(
    (method) =>
      method.recipeId === "thirdparty" &&
      ["google", "apple"].includes(method.thirdPartyId) &&
      methods.some(
        (other) =>
          other.recipeId === "thirdparty" &&
          other.thirdPartyId === method.thirdPartyId &&
          other.thirdPartyUserId === method.thirdPartyUserId,
      ),
  );
}

async function observe(plan: OwnerPlanCheckpoint, context: JsonRecord) {
  clearSuperTokensCoreCallCache(context);
  const state: OwnerState = {
    graph: [],
    mappings: [],
    markers: [],
    verifications: [],
  };
  const methods = new Map<string, Method>();
  const extra = new Map<string, Method>();
  const owners = new Map<string, string>();
  for (const recipe of plan.recipes) {
    await assertSelectorNamespace(recipe.id, context);
    const user = await SuperTokens.getUser(recipe.id, context);
    if (!user)
      throw new RowndMigrationPolicyError("A consolidation recipe disappeared");
    const graph = JSON.stringify([
      user.isPrimaryUser,
      user.loginMethods
        .map((method) => [method.recipeUserId.getAsString(), identity(method)])
        .sort(),
    ]);
    const earlierGraph = owners.get(user.id);
    if (earlierGraph !== undefined && earlierGraph !== graph)
      throw new RowndMigrationPolicyError(
        "Consolidation owner graph changed during observation",
      );
    if (earlierGraph === undefined) {
      await assertMigrationOwnerGraph(user, "public", context);
      owners.set(user.id, graph);
    }
    const method = await recipeMethod(user, recipe.id, context);
    if (!method || identity(method) !== recipe.identity)
      throw new RowndMigrationPolicyError(
        "Consolidation recipe identity changed",
      );
    methods.set(recipe.id, method);
    const owner = await immutableId(user.id, context);
    state.graph.push({ id: recipe.id, owner, primary: user.isPrimaryUser });
    for (const entry of user.loginMethods) {
      const id = await immutableId(entry.recipeUserId.getAsString(), context);
      if (!plan.recipes.some((planned) => planned.id === id)) {
        if (owner !== plan.target)
          throw new RowndMigrationPolicyError(
            "Unexpected recipe joined a donor",
          );
        extra.set(id, entry);
      }
    }
    const mapping = await SuperTokens.getUserIdMapping({
      userId: recipe.id,
      userIdType: "SUPERTOKENS",
      userContext: context,
    });
    state.mappings.push({
      id: recipe.id,
      ...(mapping.status === "OK"
        ? {
            alias: mapping.externalUserId,
            ...(mapping.externalUserIdInfo !== undefined
              ? { info: mapping.externalUserIdInfo }
              : {}),
          }
        : {}),
    });
    if (mapping.status === "OK") {
      await assertSelectorNamespace(mapping.externalUserId, context);
      const reverse = await SuperTokens.getUserIdMapping({
        userId: mapping.externalUserId,
        userIdType: "EXTERNAL",
        userContext: context,
      });
      if (reverse.status !== "OK" || reverse.superTokensUserId !== recipe.id)
        throw new RowndMigrationPolicyError(
          "Consolidation reverse mapping changed",
        );
    }
  }
  for (const alias of [...plan.aliases, ...(plan.retiredAliases ?? [])]) {
    const mapping = await SuperTokens.getUserIdMapping({
      userId: alias.id,
      userIdType: "EXTERNAL",
      userContext: context,
    });
    if (
      mapping.status === "OK" &&
      !state.mappings.some(
        (entry) =>
          entry.id === mapping.superTokensUserId && entry.alias === alias.id,
      )
    ) {
      throw new RowndMigrationPolicyError(
        "Consolidation alias moved outside the planned graph",
      );
    }
    if (
      mapping.status !== "OK" &&
      plan.retiredAliases?.some((retired) => retired.id === alias.id) &&
      await SuperTokens.getUser(alias.id, context)
    )
      throw new RowndMigrationPolicyError("A retired consolidation alias acquired a literal owner");
  }
  for (const candidate of plan.candidates) {
    if (
      candidate.supertokens_user_id !== undefined ||
      plan.aliases.some((alias) => alias.id === candidate.rownd_user_id)
    )
      continue;
    const mapping = await SuperTokens.getUserIdMapping({
      userId: candidate.rownd_user_id,
      userIdType: "EXTERNAL",
      userContext: context,
    });
    const literalUser = await SuperTokens.getUser(
      candidate.rownd_user_id,
      context,
    );
    if (mapping.status === "OK" || literalUser) {
      throw new RowndMigrationPolicyError(
        "An ownerless consolidation candidate acquired an owner",
      );
    }
  }
  for (const marker of plan.initial.markers) {
    if (marker.values.rownd_migration_superseded !== undefined &&
      ((await SuperTokens.getUserIdMapping({ userId: marker.id, userIdType: "EXTERNAL", userContext: context })).status === "OK" ||
        await SuperTokens.getUser(marker.id, context)))
      throw new RowndMigrationPolicyError("A retired consolidation alias acquired a literal owner");
    state.markers.push({
      id: marker.id,
      values: markers(await getRawUserMetadata(marker.id, context)),
    });
  }
  state.verifications = await Promise.all(
    plan.initial.verifications.map(async (entry) => ({
      ...entry,
      verified: await EmailVerification.isEmailVerified(
        SuperTokens.convertToRecipeUserId(entry.id),
        entry.email,
        context,
      ),
    })),
  );
  return { state, methods, extra };
}

export async function assertCompletedPlan(
  plan: OwnerPlanCheckpoint,
  context: JsonRecord,
) {
  if (plan.status !== "COMPLETE" || plan.reservation)
    throw new RowndMigrationPolicyError("Owner consolidation is incomplete");
  const completed = plan.completion;
  const { state } = await observe(
    completed
      ? { ...plan, recipes: completed.recipes, initial: completed.state }
      : plan,
    context,
  );
  const final = completed?.state ?? ownerStateAt(plan, plan.operations.length);
  if (
    state.graph.length < plan.recipes.length ||
    state.graph.some(
      (entry) => entry.owner !== plan.target || !entry.primary,
    ) ||
    plan.recipes.some(
      (recipe) => !state.graph.some((entry) => entry.id === recipe.id),
    ) ||
    !isDeepStrictEqual(state.graph, final.graph) ||
    !isDeepStrictEqual(state.mappings, final.mappings)
  ) {
    throw new RowndMigrationPolicyError(
      "Consolidation completed ownership changed",
    );
  }
  for (const alias of plan.aliases)
    await assertMigrationMapping(alias.to, alias.id, context);
  for (const entry of state.markers) {
    const wanted = final.markers.find((marker) => marker.id === entry.id)!;
    for (const field of [
      "rownd_migration_target",
      "rownd_migration_canonical_target",
      "rownd_migration_superseded",
      "rownd_migration_reconciliation",
    ]) {
      const alias = plan.aliases.find((alias) => alias.id === entry.id);
      if (
        field === "rownd_migration_canonical_target" &&
        wanted.values[field] === undefined &&
        alias &&
        entry.values[field] === alias.to
      )
        continue;
      if (!isDeepStrictEqual(entry.values[field], wanted.values[field]))
        throw new RowndMigrationPolicyError(
          "Consolidation literal metadata changed",
        );
    }
    const original = entry.values.original_rownd_user;
    const expectedOriginal = wanted.values.original_rownd_user;
    if (
      isRecord(original) &&
      isRecord(original.data) &&
      isRecord(expectedOriginal) &&
      isRecord(expectedOriginal.data) &&
      original.data.user_id !== expectedOriginal.data.user_id
    )
      throw new RowndMigrationPolicyError(
        "Consolidation source provenance changed",
      );
  }
  const metadata = await getRawUserMetadata(plan.target, context);
  if (
    metadata.original_rownd_user?.data.user_id !== plan.sourceId ||
    !isDeepStrictEqual(readOwnerPlanCheckpoint(metadata), plan)
  )
    throw new RowndMigrationPolicyError(
      "Consolidation canonical metadata changed",
    );
}

export async function assertConsolidationSessionMembership(
  userId: string,
  recipeUserId: string,
  tenantId: string,
  context: JsonRecord,
) {
  clearSuperTokensCoreCallCache(context);
  await assertMappingPublicationSessionMembership(
    userId,
    recipeUserId,
    context,
  );
  const ids = new Set([userId, recipeUserId]);
  for (const id of ids) {
    const user = await SuperTokens.getUser(id, context);
    if (user)
      for (const value of [
        user.id,
        ...user.loginMethods.map((method) => method.recipeUserId.getAsString()),
      ])
        ids.add(value);
    ids.add(await immutableId(id, context));
  }
  for (const id of ids) {
    const metadata = await getRawUserMetadata(id, context);
    const plan = readOwnerPlanCheckpoint(metadata);
    const legacy = readConsolidationCheckpoint(metadata);
    if (!plan && !legacy) continue;
    if (tenantId !== "public")
      throw new RowndMigrationPolicyError(
        "Owner consolidation requires public tenant membership",
      );
    if (plan) {
      // Reservations remain blocking until cleared; the target checkpoint is
      // completed last, after every recipe belongs to the survivor.
      await assertCompletedPlan(plan, context);
      if (userId !== plan.sourceId)
        throw new RowndMigrationPolicyError(
          "Owner consolidation session owner changed",
        );
    } else await assertV1(legacy!, context);
    const user = await SuperTokens.getUser(recipeUserId, context);
    const method =
      user &&
      (await recipeMethod(
        user,
        await immutableId(recipeUserId, context),
        context,
      ));
    if (!user || user.id !== userId || !method?.tenantIds.includes(tenantId))
      throw new RowndMigrationPolicyError(
        "Owner consolidation session membership changed",
      );
  }
}

export async function resolveConsolidatedTokenOwner(
  source: SuperTokensUserImport,
  tenantId: string,
  context: JsonRecord,
) {
  const alias = source.externalUserId!;
  clearSuperTokensCoreCallCache(context);
  const raw = await getRawUserMetadata(alias, context);
  const recovery = await readOwnerRecoveryCheckpoint(raw, alias, context);
  if (recovery && recovery.status !== "COMPLETE")
    throw new RowndMigrationPolicyError("Owner consolidation is incomplete");
  const reservation = readOwnerPlanCheckpoint(raw);
  if (reservation && reservation.status !== "COMPLETE")
    throw new RowndMigrationPolicyError("Owner consolidation is incomplete");
  const user = await SuperTokens.getUser(alias, context);
  if (!user) return undefined;
  const target = await immutableId(user.id, context);
  const metadata = await getRawUserMetadata(target, context);
  const plan = readOwnerPlanCheckpoint(metadata);
  const legacy = readConsolidationCheckpoint(metadata);
  if (!plan && !legacy) return undefined;
  if (tenantId !== "public")
    throw new RowndMigrationPolicyError(
      "Consolidated alias requires public tenant",
    );
  const canonicalRowndId = plan?.sourceId ?? legacy!.winner;
  if (plan) {
    await assertCompletedPlan(plan, context);
    if (!plan.aliases.some((entry) => entry.id === alias))
      throw new RowndMigrationPolicyError("Unplanned consolidated alias");
  } else {
    await assertV1(legacy!, context);
    if (
      !legacy!.members.some((member) => member.rownd_user_id === alias) ||
      metadata.original_rownd_user?.data.user_id !== legacy!.winner
    ) {
      throw new RowndMigrationPolicyError(
        "Consolidated Rownd alias ownership could not be verified",
      );
    }
  }
  if (!(await assertAuthenticatedMigrationSource(source, tenantId)))
    throw new RowndMigrationPolicyError(
      "Consolidated alias requires an authenticated source",
    );
  if (alias === canonicalRowndId) return undefined;
  const canonical = await requiredProfile(canonicalRowndId);
  const requested = await requiredProfile(alias);
  const methods = mapRowndUserToSuperTokens(canonical, tenantId).loginMethods;
  const requiredMethods = plan ? methods : [...source.loginMethods, ...methods];
  if (
    !sharedProfile(requested, canonical) ||
    !user.isPrimaryUser ||
    requiredMethods.some(
      (expected) =>
        !user.loginMethods.some(
          (method) =>
            method.tenantIds.includes(tenantId) &&
            matchesImportLoginMethod(method, expected),
        ),
    )
  ) {
    throw new RowndMigrationPolicyError(
      "Consolidated Rownd alias ownership could not be verified",
    );
  }
  return {
    user,
    target,
    canonicalRowndId,
    recipeUserId: SuperTokens.convertToRecipeUserId(alias),
  };
}

export async function prepareOwnerConsolidation(input: {
  source: SuperTokensUserImport;
  candidates: ActivityCandidate[];
  target: string;
  tenantId: string;
  userContext: JsonRecord;
  ownerIds?: string[];
}) {
  const { source, candidates, target, tenantId, userContext: context } = input;
  if (!isAdministrativeMigration(source, tenantId)) return undefined;
  const fail: (reason: string) => never = (reason) => {
    throw new UnresolvedConsolidationOwners(candidates, reason);
  };
  if (tenantId !== "public")
    fail("whole-owner consolidation requires the public tenant");
  const sourceId = source.externalUserId!;
  const initialMetadata = await getRawUserMetadata(target, context);
  let existing = readOwnerPlanCheckpoint(initialMetadata);
  let previous: OwnerPlanCheckpoint | undefined;
  const legacy = readConsolidationCheckpoint(initialMetadata);
  if (legacy) {
    if (legacy.winner !== sourceId || legacy.target !== target)
      fail("the v1 checkpoint target changed");
    const assertOwners = async () => {
      clearSuperTokensCoreCallCache(context);
      await assertV1(legacy, context);
    };
    await assertOwners();
    const fresh = async () => {
      if (!isAdministrativeElectionCandidate(source, sourceId))
        fail("the private election binding is missing");
      await assertAuthenticatedMigrationSource(source, tenantId);
      await assertOwners();
    };
    return {
      managesMapping: true as const,
      sourceId,
      assertOwners,
      proposedActions: [] as ReconcilePreviewAction[],
      plannedOwnerIds: new Set(
        legacy.members.flatMap((member) => [
          member.rownd_user_id,
          member.supertokens_user_id,
        ]),
      ),
      execute: fresh,
      beginMethodReconciliation: fresh,
      complete: fresh,
    };
  }
  if (existing && (existing.reservation || existing.target !== target))
    fail("the checkpoint target changed");
  if (existing && existing.sourceId !== sourceId) {
    if (existing.status !== "COMPLETE")
      fail("the in-progress source election changed");
    await assertCompletedPlan(existing, context);
    previous = existing;
    existing = undefined;
  }
  const profile = await requiredProfile(sourceId);
  const survivor = await SuperTokens.getUser(target, context);
  const anchor = survivor && (await recipeMethod(survivor, target, context));
  const provider = anchor?.thirdParty;
  const previousSource = initialMetadata.original_rownd_user;
  if (
    provider &&
    anchor.tenantIds.includes(tenantId) &&
    previousSource?.data?.user_id === sourceId &&
    [
      previousSource.data[`${provider.id}_id`],
      resolveRowndProviderSubject(previousSource, provider.id),
    ].includes(provider.userId) &&
    source.loginMethods.some(
      (method) =>
        method.recipeId === "thirdparty" &&
        method.thirdPartyId === provider.id &&
        method.thirdPartyUserId !== provider.userId,
    )
  ) {
    fail("provider retirement would delete the immutable primary recipe");
  }
  const isRetiredHistory = async (id: string, historical: RowndUser) => {
    const metadata = await getRawUserMetadata(id, context);
    const retired = metadata.rownd_migration_superseded;
    const mapping = await SuperTokens.getUserIdMapping({
      userId: id,
      userIdType: "EXTERNAL",
      userContext: context,
    });
    return (
      isRecord(retired) &&
      retired.rowndUserId === sourceId &&
      retired.targetUserId === target &&
      mapping.status !== "OK" &&
      !(await SuperTokens.getUser(id, context)) &&
      (sharedProfile(profile, historical) || sharesAdministrativeElectionPhone(source, profile, historical))
    );
  };
  const profiles = new Map<string, RowndUser>();
  for (const candidate of candidates) {
    const current = await requiredProfile(candidate.rownd_user_id);
    if (
      !sharedProfile(profile, current) && !sharesAdministrativeElectionPhone(source, profile, current) && !sharesAdministrativeInstantPrimary(source, profile, current) &&
      candidate.rownd_user_id !== sourceId
    )
      fail("a source no longer shares the current identity");
    profiles.set(candidate.rownd_user_id, current);
  }
  const ownerIds = new Set([
    target,
    ...(input.ownerIds ?? []),
    ...candidates.flatMap((candidate) =>
      candidate.supertokens_user_id ? [candidate.supertokens_user_id] : [],
    ),
  ]);
  let plan: OwnerPlanCheckpoint;
  if (existing) {
    plan = existing;
    for (const candidate of plan.candidates)
      if (!profiles.has(candidate.rownd_user_id) && !(plan.status === "COMPLETE" &&
        plan.retiredAliases?.some((alias) => alias.id === candidate.rownd_user_id)))
        fail("a checkpoint source is missing");
    for (const id of ownerIds)
      if (
        !(
          plan.completion?.recipes ?? [
            ...plan.recipes,
            ...(plan.createdRecipes ?? []),
          ]
        ).some((recipe) => recipe.id === id)
      )
        fail("an unplanned owner appeared");
  } else {
    const recipes = new Map<string, OwnerRecipe>();
    const initial: OwnerState = {
      graph: [],
      mappings: [],
      markers: [],
      verifications: [],
    };
    const owners = new Map<string, User>();
    for (const id of ownerIds) {
      const user = await SuperTokens.getUser(id, context);
      if (!user) fail("an owner disappeared");
      const owner = await immutableId(user.id, context);
      if (id === target && owner !== target)
        fail("the target is not an immutable primary owner");
      owners.set(owner, user);
    }
    const canonical = await SuperTokens.getUserIdMapping({
      userId: sourceId,
      userIdType: "EXTERNAL",
      userContext: context,
    });
    if (
      !previous &&
      owners.size === 1 &&
      owners.has(target) &&
      canonical.status === "OK" &&
      canonical.superTokensUserId === target &&
      initialMetadata.original_rownd_user?.data.user_id === sourceId
    ) {
      await assertMigrationOwnerGraph(owners.get(target)!, tenantId, context);
      await assertMigrationMapping(target, sourceId, context);
      return undefined;
    }
    for (const [owner, user] of owners) {
      await assertMigrationOwnerGraph(user, tenantId, context);
      const hasEmail =
        profile.data.email !== undefined &&
        hasNativeContactEmail(user, profile.data.email);
      let provenRownd = false;
      let sharedCurrentEmail = false;
      for (const candidate of candidates) {
        if (!candidate.supertokens_user_id) continue;
        const candidateOwner = await SuperTokens.getUser(
          candidate.supertokens_user_id,
          context,
        );
        if (
          candidateOwner &&
          (await immutableId(candidateOwner.id, context)) === owner
        ) {
          const forward = await SuperTokens.getUserIdMapping({
            userId: candidate.rownd_user_id,
            userIdType: "EXTERNAL",
            userContext: context,
          });
          const stored = await getRawUserMetadata(
            candidate.supertokens_user_id,
            context,
          );
          if (
            forward.status === "OK"
              ? forward.superTokensUserId !== candidate.supertokens_user_id
              : stored.original_rownd_user?.data.user_id !==
                candidate.rownd_user_id
          )
            fail("a candidate has no literal mapping or source provenance");
          provenRownd = true;
          sharedCurrentEmail ||=
            profile.data.email !== undefined &&
            profiles.get(candidate.rownd_user_id)?.data.email?.toLowerCase() ===
              profile.data.email.toLowerCase();
        }
      }
      const nativeCurrent =
        !user.isPrimaryUser &&
        user.loginMethods.length === 1 &&
        source.loginMethods.some(
          (expected) =>
            ((expected.recipeId === "thirdparty" &&
              ["google", "apple"].includes(expected.thirdPartyId)) ||
              (expected.recipeId === "passwordless" &&
                expected.phoneNumber !== undefined &&
                expected.isVerified)) &&
            matchesImportLoginMethod(user.loginMethods[0]!, expected),
        );
      if (!hasEmail && !provenRownd && !nativeCurrent)
        fail("an owner lacks current exact identity proof");
      if (
        owner !== target &&
        user.isPrimaryUser &&
        (provenRownd ? !sharedCurrentEmail : !hasEmail)
      )
        fail("primary donor merging requires a shared current exact email");
      for (const method of user.loginMethods) {
        if (method.tenantIds.length !== 1 || method.tenantIds[0] !== tenantId)
          fail("a recipe has non-public tenant membership");
        const id = await immutableId(
          method.recipeUserId.getAsString(),
          context,
        );
        recipes.set(id, {
          id,
          identity: identity(method),
          verified: method.verified,
          ...(method.email ? { email: method.email } : {}),
        });
        initial.graph.push({ id, owner, primary: user.isPrimaryUser });
        const mapping = await SuperTokens.getUserIdMapping({
          userId: id,
          userIdType: "SUPERTOKENS",
          userContext: context,
        });
        initial.mappings.push({
          id,
          ...(mapping.status === "OK"
            ? {
                alias: mapping.externalUserId,
                ...(mapping.externalUserIdInfo !== undefined
                  ? { info: mapping.externalUserIdInfo }
                  : {}),
              }
            : {}),
        });
      }
    }
    initial.graph.sort((a, b) => a.id.localeCompare(b.id));
    initial.mappings.sort((a, b) => a.id.localeCompare(b.id));
    const aliases = initial.mappings.flatMap((mapping) =>
      mapping.alias
        ? [
            {
              id: mapping.alias,
              from: mapping.id,
              to: mapping.id,
              ...(mapping.info !== undefined ? { info: mapping.info } : {}),
            },
          ]
        : [],
    );
    const absentAliases: string[] = [];
    for (const alias of aliases)
      if (!profiles.has(alias.id)) {
        if (await optionalProfile(alias.id))
          fail("a live mapped source was omitted from the election");
        const ownerId = initial.graph.find(
          (entry) => entry.id === alias.from,
        )?.owner;
        const owner = ownerId && owners.get(ownerId);
        if (
          !owner ||
          !profile.data.email ||
          !hasNativeContactEmail(owner, profile.data.email)
        ) {
          fail("an absent alias has no native exact-email owner proof");
        }
        absentAliases.push(alias.id);
      }
    const retiredAliases: NonNullable<OwnerPlanCheckpoint["retiredAliases"]> = [];
    const sourceAlias = aliases.find((alias) => alias.id === sourceId);
    if (recipes.has(sourceId) && sourceId !== target)
      fail("the canonical alias collides with an immutable recipe ID");
    if (sourceAlias) sourceAlias.to = target;
    else aliases.push({ id: sourceId, to: target } as (typeof aliases)[number]);
    const displaced = aliases.find(
      (alias) => alias.id !== sourceId && alias.to === target,
    );
    if (displaced) {
      const available = [...recipes.keys()]
        .filter(
          (id) =>
            id !== target &&
            !aliases.some(
              (alias) => alias.id !== displaced.id && alias.to === id,
            ),
        )
        .sort();
      const destination =
        available.find((id) => id === sourceAlias?.from) ?? available[0];
      if (destination) displaced.to = destination;
      else {
        if (recipes.has(displaced.id))
          fail("the retiring alias collides with an immutable recipe ID");
        retiredAliases.push({
          id: displaced.id,
          from: displaced.from,
          ...(displaced.info !== undefined ? { info: displaced.info } : {}),
        });
        aliases.splice(aliases.indexOf(displaced), 1);
      }
    }
    const previousState = previous?.completion?.state ?? (previous ? ownerStateAt(previous) : undefined);
    const inheritedRetirements = previousState?.markers.filter((marker) => marker.values.rownd_migration_superseded !== undefined) ?? [];
    const literals = new Set([
      ...recipes.keys(),
      ...candidates.map((candidate) => candidate.rownd_user_id),
      ...aliases.map((alias) => alias.id),
      ...retiredAliases.map((alias) => alias.id),
      ...inheritedRetirements.map((marker) => marker.id),
    ]);
    const emails = new Set(
      [...recipes.values()].flatMap((recipe) =>
        recipe.email ? [recipe.email] : [],
      ),
    );
    for (const id of literals)
      for (const email of emails)
        initial.verifications.push({
          id,
          email,
          verified: await EmailVerification.isEmailVerified(
            SuperTokens.convertToRecipeUserId(id),
            email,
            context,
          ),
        });
    for (const id of literals) {
      const metadata = await getRawUserMetadata(id, context);
      const inherited = inheritedRetirements.find((marker) => marker.id === id);
      if (inherited) {
        if (!isDeepStrictEqual(markers(metadata), inherited.values) ||
          (await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext: context })).status === "OK" ||
          await SuperTokens.getUser(id, context)) fail("retired owner lineage changed");
        initial.markers.push({ id, values: markers(metadata) });
        continue;
      }
      const mappedId =
        initial.mappings.find((entry) => entry.alias === id)?.id ?? id;
      const ownerId = initial.graph.find(
        (entry) => entry.id === mappedId,
      )?.owner;
      await assertOwnerEmailPolicy(
        metadata,
        ownerId ? owners.get(ownerId) : undefined,
        profile.data.email,
        context,
      );
      if (
        metadata[key] !== undefined &&
        !(
          id === target &&
          previous &&
          isDeepStrictEqual(readOwnerPlanCheckpoint(metadata), previous)
        )
      )
        fail("an owner has another consolidation checkpoint");
      const values = markers(metadata);
      const mapping = initial.mappings.find(
        (entry) => entry.id === id || entry.alias === id,
      );
      const candidate = candidates.find(
        (entry) =>
          entry.rownd_user_id === id || entry.supertokens_user_id === id,
      );
      const expectedId = mapping?.id ?? candidate?.supertokens_user_id;
      if (
        [
          values.rownd_migration_target,
          values.rownd_migration_canonical_target,
        ].some((value) => value !== undefined && value !== expectedId) ||
        values.rownd_migration_superseded !== undefined ||
        values.rownd_migration_reconciliation !== undefined
      )
        fail("an owner has conflicting migration markers");
      const original = metadata.original_rownd_user?.data.user_id;
      if (
        original !== undefined &&
        !profiles.has(original) &&
        !absentAliases.includes(original) &&
        mapping?.alias === undefined
      ) {
        const ownerId = initial.graph.find((entry) => entry.id === id)?.owner;
        const owner = ownerId && owners.get(ownerId);
        if (
          owner &&
          profile.data.email &&
          hasNativeContactEmail(owner, profile.data.email)
        ) {
          const historical = await optionalProfile(original);
          if (!historical || (await isRetiredHistory(original, historical)))
            absentAliases.push(original);
        }
      }
      const previousMarkers = previousState?.markers.find((entry) => entry.id === id)?.values;
      const recordedProvenance =
        previousMarkers !== undefined &&
        isDeepStrictEqual(
          previousMarkers.original_rownd_user,
          metadata.original_rownd_user,
        );
      if (
        original !== undefined &&
        ((!profiles.has(original) && !absentAliases.includes(original)) ||
          (mapping?.alias !== undefined &&
            mapping.alias !== original &&
            !recordedProvenance))
      )
        fail("an owner's literal source provenance changed");
      initial.markers.push({ id, values });
    }
    plan = {
      version: 2,
      id: randomUUID(),
      sourceId,
      target,
      candidates: candidates.map((candidate) => ({ ...candidate })),
      absentAliases,
      recipes: [...recipes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      aliases,
      ...(retiredAliases.length ? { retiredAliases } : {}),
      initial,
      operations: [],
      cursor: 0,
      status: "READY",
    };
    const instantAnchor = instantPrimaryAnchor(plan);
    const inheritedSessionAliases = previous ? ambiguousOwnerSessionAliases(previous) : [];
    if (inheritedSessionAliases.length && instantPrimaryAnchor(previous!)?.identity !== instantAnchor?.identity)
      fail("legacy session alias history changed its immutable instant primary");
    const ambiguousSessionAliases = [...new Set([...inheritedSessionAliases, ...ambiguousOwnerSessionAliases(plan)])].sort();
    if (instantAnchor && ambiguousSessionAliases.length) {
      plan.legacySessionAliasHistory = {
        instantRecipeId: target,
        instantRecipeIdentity: instantAnchor.identity,
        aliases: ambiguousSessionAliases,
      };
    }
    const decision = planOwnerOperations({
      ...plan,
      profile,
      authenticatedEmail: getAuthenticatedMigrationEmail(source, tenantId),
    });
    if (decision.status === "BLOCKED") return fail(decision.reason);
    plan.operations = decision.actions;
  }

  // Core persists JSON; optional undefined activity/profile fields must not turn
  // a successful checkpoint write into apparent drift on the next read.
  plan = JSON.parse(JSON.stringify(plan)) as OwnerPlanCheckpoint;
  let expected: OwnerPlanCheckpoint | undefined = existing ?? previous;
  let reconciling =
    existing?.status === "RECONCILING" || existing?.status === "COMPLETE";
  const normalizeEnginePolicy = async (metadata: JsonRecord, id: string) => {
    const normalized = { ...metadata };
    if (!reconciling) return normalized;
    const introductions = metadata.rownd_migration_provider_introductions;
    if (introductions !== undefined) {
      if (id !== target || !Array.isArray(introductions))
        fail("an unexpected provider introduction appeared");
      for (const entry of introductions as JsonRecord[]) {
        if (!isRecord(entry) || typeof entry.recipeUserId !== "string")
          fail("an unexpected provider introduction appeared");
        const recipeId = entry.recipeUserId as string;
        const receipt = [...plan.recipes, ...(plan.createdRecipes ?? [])].find(
          (recipe) => recipe.id === recipeId,
        );
        const user = await SuperTokens.getUser(recipeId, context);
        const method = user && (await recipeMethod(user, recipeId, context));
        if (
          !isRecord(entry) ||
          entry.recipeUserId !== recipeId ||
          entry.internalUserId !== target ||
          entry.rowndUserId !== sourceId ||
          entry.tenantId !== tenantId ||
          !receipt ||
          !method ||
          identity(method) !== receipt.identity ||
          method.thirdParty?.id !== entry.provider ||
          method.thirdParty?.userId !== entry.subject ||
          !source.loginMethods.some((wanted) =>
            matchesImportLoginMethod(method, wanted),
          ) ||
          (entry.created === true &&
            !(plan.createdRecipes ?? []).some(
              (recipe) => recipe.id === recipeId,
            ))
        )
          fail("an unexpected provider introduction appeared");
      }
      delete normalized.rownd_migration_provider_introductions;
    }
    if (
      Array.isArray(normalized.rownd_pending_verification) &&
      normalized.rownd_pending_verification.length === 0
    )
      delete normalized.rownd_pending_verification;
    return normalized;
  };
  const reservations = new Map<string, OwnerPlanCheckpoint | undefined>();
  for (const marker of [
    ...plan.initial.markers,
    ...(plan.createdRecipes ?? []).map(({ id }) => ({ id })),
  ])
    if (marker.id !== target) {
      const saved = readOwnerPlanCheckpoint(
        await getRawUserMetadata(marker.id, context),
      );
      if (saved && (!saved.reservation || !sameOwnerPlan(saved, plan)))
        fail("an owner reservation changed");
      reservations.set(marker.id, saved);
    }
  let instantProfileRevision: object | undefined;
  const assertOwners = async (complete = false) => {
    clearSuperTokensCoreCallCache(context);
    if (complete) {
      const instant = hasAdministrativeInstantProof(source);
      // Adjacent completion checks share fresh evidence only until a cache
      // invalidation (including SDK mutations). Outside a read scope, always refresh.
      if (instant && (instantProfileRevision === undefined || instantProfileRevision !== reconciliationReadRevision()))
        invalidateReconciliationReads("rownd");
      const profileRevision = reconciliationReadRevision();
      const currentProfiles = await Promise.all([...profiles.keys()].map(requiredProfile));
      if (instant) {
        assertAdministrativeInstantProfiles(source, currentProfiles);
        instantProfileRevision = profileRevision;
      }
      for (const current of currentProfiles) {
        const initial = profiles.get(current.data.user_id)!;
        if (
          !isDeepStrictEqual(
            mapRowndUserToSuperTokens(current, tenantId).loginMethods,
            mapRowndUserToSuperTokens(initial, tenantId).loginMethods,
          )
        )
          fail("a source identity changed before completion");
      }
    }
    if (
      !isDeepStrictEqual(
        readOwnerPlanCheckpoint(await getRawUserMetadata(target, context)),
        expected,
      )
    )
      fail("the consolidation checkpoint changed");
    for (const [id, saved] of reservations)
      if (
        !isDeepStrictEqual(
          readOwnerPlanCheckpoint(await getRawUserMetadata(id, context)),
          saved,
        )
      )
        fail("an owner reservation changed");
    if (plan.status !== "COMPLETE")
      for (const marker of plan.initial.markers) {
        const metadata = await getRawUserMetadata(marker.id, context);
        const recipeId =
          [...plan.aliases, ...(plan.retiredAliases ?? [])].find((alias) => alias.id === marker.id)?.from ??
          marker.id;
        const user = await SuperTokens.getUser(recipeId, context);
        await assertOwnerEmailPolicy(
          await normalizeEnginePolicy(metadata, marker.id),
          user,
          profile.data.email,
          context,
          [...plan.recipes, ...(plan.createdRecipes ?? [])],
          plan,
        );
      }
    for (const alias of plan.absentAliases) {
      const historical = await optionalProfile(alias);
      if (historical && !(await isRetiredHistory(alias, historical)))
        fail("an absent source reappeared; rediscovery is required");
    }
    if (profile.data.email)
      for (const user of await SuperTokens.listUsersByAccountInfo(
        tenantId,
        { email: profile.data.email },
        false,
        context,
      )) {
        if (!hasNativeContactEmail(user, profile.data.email)) continue;
        const owner = await immutableId(user.id, context);
        if (
          !(
            plan.completion?.recipes ?? [
              ...plan.recipes,
              ...(reconciling ? (plan.createdRecipes ?? []) : []),
            ]
          ).some((recipe) => recipe.id === owner)
        )
          fail("an unplanned exact-email owner appeared");
      }
    if (plan.status === "COMPLETE") {
      await assertCompletedPlan(plan, context);
      return observe(plan, context);
    }
    for (const receipt of plan.createdRecipes ?? []) {
      const user = await SuperTokens.getUser(receipt.id, context);
      const method = user && (await recipeMethod(user, receipt.id, context));
      if (
        !reconciling ||
        !user ||
        !method ||
        identity(method) !== receipt.identity ||
        !source.loginMethods.some((expected) =>
          matchesImportLoginMethod(method, expected),
        ) ||
        ![receipt.id, target].includes(await immutableId(user.id, context)) ||
        (
          await SuperTokens.getUserIdMapping({
            userId: receipt.id,
            userIdType: "SUPERTOKENS",
            userContext: context,
          })
        ).status === "OK"
      )
        fail("a created recipe receipt changed");
      if (
        !receipt.verified &&
        method?.verified &&
        receipt.email?.toLowerCase() !==
          getAuthenticatedMigrationEmail(source, tenantId)
      )
        fail("linking verified a created email without matching source proof");
    }
    const observed = await observe(plan, context);
    if (reconciling)
      for (const entry of observed.state.markers) {
        const normalized = await normalizeEnginePolicy(entry.values, entry.id);
        for (const field of [
          "rownd_migration_provider_introductions",
          "rownd_pending_verification",
        ]) {
          if (
            normalized[field] === undefined &&
            ownerStateAt(plan).markers.find((marker) => marker.id === entry.id)
              ?.values[field] === undefined
          )
            delete entry.values[field];
        }
      }
    const state = ownerStateAt(plan);
    const next =
      plan.status === "APPLYING" && plan.operations[plan.cursor]
        ? ownerStateAt(plan, plan.cursor + 1)
        : undefined;
    const matches = (candidate: OwnerState) => {
      if (
        !isDeepStrictEqual(observed.state.graph, candidate.graph) ||
        !isDeepStrictEqual(observed.state.mappings, candidate.mappings)
      )
        return false;
      if (
        !observed.state.verifications.every(
          (entry, index) =>
            entry.verified === candidate.verifications[index]?.verified ||
            (reconciling &&
              entry.verified &&
              !candidate.verifications[index]?.verified &&
              entry.email.toLowerCase() ===
                getAuthenticatedMigrationEmail(source, tenantId) &&
              candidate.mappings.some(
                (mapping) => (mapping.alias ?? mapping.id) === entry.id,
              )),
        )
      )
        return false;
      if (reconciling) {
        // The parent may refresh the authoritative snapshot and publish exact
        // alias canonical markers, but cannot redirect any literal target.
        return observed.state.markers.every((entry) => {
          const wanted = candidate.markers.find(
            (marker) => marker.id === entry.id,
          )!;
          const actual = { ...entry.values };
          const original = { ...wanted.values };
          const canonicalPointer = getCanonicalEmailRecipeUserId(
            actual,
            tenantId,
          );
          const plannedCanonical =
            entry.id === target &&
            [...observed.methods.values(), ...observed.extra.values()].some(
              (method) =>
                method.recipeUserId.getAsString() === canonicalPointer &&
                method.recipeId === "passwordless" &&
                method.tenantIds.includes(tenantId) &&
                !!profile.data.email &&
                method.hasSameEmailAs(profile.data.email),
            );
          if (plannedCanonical) {
            if (actual.rownd_email_recipe_user_id === canonicalPointer)
              actual.rownd_email_recipe_user_id =
                original.rownd_email_recipe_user_id;
            if (isRecord(actual.rownd_email_recipe_user_ids)) {
              const pointers = { ...actual.rownd_email_recipe_user_ids };
              if (
                isRecord(original.rownd_email_recipe_user_ids) &&
                original.rownd_email_recipe_user_ids[tenantId] !== undefined
              )
                pointers[tenantId] =
                  original.rownd_email_recipe_user_ids[tenantId];
              else delete pointers[tenantId];
              actual.rownd_email_recipe_user_ids =
                Object.keys(pointers).length ||
                original.rownd_email_recipe_user_ids !== undefined
                  ? pointers
                  : undefined;
            }
            for (const field of [
              "rownd_email_recipe_user_id",
              "rownd_email_recipe_user_ids",
            ])
              if (actual[field] === undefined) delete actual[field];
          }
          if (
            isRecord(actual.rownd_email_recipe_user_ids) &&
            !isRecord(original.rownd_email_recipe_user_ids) &&
            Object.keys(actual.rownd_email_recipe_user_ids).every(
              (tenant) => tenant === tenantId,
            )
          )
            delete actual.rownd_email_recipe_user_ids;
          if (entry.id === target) {
            const snapshot = actual.original_rownd_user as RowndUser;
            assertRowndSourcePayload(snapshot);
            if (
              snapshot.data.user_id !== sourceId ||
              !isRowndMigrationProfileActive(snapshot) ||
              !isDeepStrictEqual(
                mapRowndUserToSuperTokens(snapshot, tenantId).loginMethods,
                source.loginMethods,
              )
            )
              return false;
            delete actual.original_rownd_user;
            delete original.original_rownd_user;
          }
          const alias = plan.aliases.find((alias) => alias.id === entry.id);
          if (
            alias &&
            actual.rownd_migration_canonical_target === alias.to &&
            original.rownd_migration_canonical_target === undefined
          )
            delete actual.rownd_migration_canonical_target;
          return isDeepStrictEqual(actual, original);
        });
      }
      return isDeepStrictEqual(observed.state.markers, candidate.markers);
    };
    if (!matches(state) && !(next && matches(next)))
      fail("recipe graph, mapping, or literal metadata changed");
    if (
      complete &&
      observed.state.graph.some(
        (entry) => entry.owner !== target || !entry.primary,
      )
    )
      fail("a donor is not linked to the survivor");
    for (const [id, method] of observed.extra) {
      if (
        !reconciling ||
        !source.loginMethods.some((expected) =>
          matchesImportLoginMethod(method, expected),
        )
      )
        fail(`an unexpected recipe joined the survivor: ${id}`);
    }
    for (const recipe of plan.recipes) {
      const address =
        observed.state.mappings.find((entry) => entry.id === recipe.id)
          ?.alias ?? recipe.id;
      const expectedVerification = recipe.email
        ? observed.state.verifications.find(
            (entry) => entry.id === address && entry.email === recipe.email,
          )?.verified
        : recipe.verified;
      if (expectedVerification !== observed.methods.get(recipe.id)?.verified)
        fail(
          "a recipe's verification no longer matches its planned literal address",
        );
      if (
        !recipe.verified &&
        recipe.email &&
        observed.methods.get(recipe.id)?.verified &&
        recipe.email.toLowerCase() !==
          getAuthenticatedMigrationEmail(source, tenantId)
      )
        fail("linking verified an email without matching source proof");
    }
    return observed;
  };
  const assertFresh = async () => {
    if (
      plan.candidates.some(
        (candidate) =>
          !(plan.status === "COMPLETE" && plan.retiredAliases?.some((alias) => alias.id === candidate.rownd_user_id)) &&
          !isAdministrativeElectionCandidate(source, candidate.rownd_user_id),
      )
    )
      fail("the private election binding is missing");
    await assertAuthenticatedMigrationSource(source, tenantId);
    return observe(plan, context);
  };
  const preflight = async () => {
    const observed = await assertOwners();
    const pending = plan.operations.slice(plan.cursor);
    if (
      plan.status === "COMPLETE" ||
      !pending.some((op) => op.kind !== "metadata")
    )
      return;
    for (const op of pending)
      if (op.kind === "link" && op.verifiedEmail) {
        const recipe = plan.recipes.find((recipe) => recipe.id === op.id)!;
        if (
          !recipe.verified &&
          op.verifiedEmail.email.toLowerCase() !==
            getAuthenticatedMigrationEmail(source, tenantId)
        ) {
          fail(
            "linking would verify an unverified email without exact source proof",
          );
        }
      }
    const primary = await SuperTokens.getUser(target, context);
    if (primary)
      for (const method of source.loginMethods) {
        if (
          method.recipeId === "passwordless" &&
          method.email &&
          !method.isVerified &&
          !primary.loginMethods.some((existing) =>
            matchesImportLoginMethod(existing, method),
          ) &&
          primary.loginMethods.some(
            (existing) =>
              existing.verified && existing.hasSameEmailAs(method.email!),
          )
        )
          fail(
            "linking would verify an unverified email without exact source proof",
          );
      }
    if (primary && !primary.isPrimaryUser) {
      const promotion = await AccountLinking.canCreatePrimaryUser(
        SuperTokens.convertToRecipeUserId(await sdkId(target, context)),
        context,
      );
      const conflictingOwner =
        promotion.status !== "OK"
          ? await immutableId(promotion.primaryUserId, context)
          : undefined;
      if (
        promotion.status !== "OK" &&
        !(
          promotion.status ===
            "ACCOUNT_INFO_ALREADY_ASSOCIATED_WITH_ANOTHER_PRIMARY_USER_ID_ERROR" &&
          plan.operations.some(
            (op) => op.kind === "detach" && op.id === conflictingOwner,
          )
        )
      )
        fail("Core cannot promote the survivor");
    }
    if (primary?.isPrimaryUser)
      for (const entry of observed.state.graph) {
        if (entry.owner === target || entry.primary) continue;
        if (
          (
            await AccountLinking.canLinkAccounts(
              SuperTokens.convertToRecipeUserId(await sdkId(entry.id, context)),
              primary.id,
              context,
            )
          ).status !== "OK"
        )
          fail("Core cannot link a donor to the survivor");
      }
  };
  await preflight();
  bindOwnerEmailPlan(source, plan);
  const pending =
    plan.status === "COMPLETE" ? [] : plan.operations.slice(plan.cursor);
  const proposedActions: ReconcilePreviewAction[] = pending.flatMap(
    (op): ReconcilePreviewAction[] =>
      op.kind === "link"
        ? [
            {
              action: "link_method",
              recipeUserId: op.id,
              supertokens_user_id: target,
            },
          ]
        : op.kind === "detach"
          ? [
              {
                action: "unlink_method",
                recipeUserId: op.id,
                supertokens_user_id: target,
              },
            ]
          : op.kind === "promote"
            ? [{ action: "create_primary", supertokens_user_id: target }]
            : op.kind === "delete_mapping"
              ? [
                  {
                    action: "remove_mapping",
                    supertokens_user_id: op.id,
                    rownd_user_id: op.alias,
                  },
                ]
              : op.kind === "create_mapping"
                ? [
                    {
                      action: "create_mapping",
                      supertokens_user_id: op.id,
                      rownd_user_id: op.alias,
                    },
                  ]
                : op.kind === "verify_email"
                  ? [
                      {
                        action: "verify_email",
                        recipeUserId: op.id,
                        rownd_user_id: op.id,
                        email: op.email,
                      },
                    ]
                  : [],
  );
  if (pending.length || plan.status !== "COMPLETE")
    proposedActions.push({
      action: "update_migration_metadata",
      supertokens_user_id: target,
    });
  if (
    plan.status !== "COMPLETE" &&
    profile.data.email &&
    plan.initial.markers.some(({ values }) => {
      const pointer = getCanonicalEmailRecipeUserId(values, tenantId);
      const id =
        plan.initial.mappings.find((mapping) => mapping.alias === pointer)
          ?.id ?? pointer;
      return (
        pointer &&
        plan.recipes.some(
          (recipe) =>
            recipe.id === id &&
            recipe.email &&
            recipe.email.toLowerCase() !== profile.data.email!.toLowerCase(),
        )
      );
    })
  )
    proposedActions.push({
      action: "set_canonical_email",
      email: profile.data.email,
      supertokens_user_id: target,
    });
  const assertCheckpoint = async () => {
    invalidateReconciliationReads("metadata", target);
    clearSuperTokensCoreCallCache(context);
    if (
      !isDeepStrictEqual(
        readOwnerPlanCheckpoint(await getRawUserMetadata(target, context)),
        expected,
      )
    )
      fail("the consolidation checkpoint changed");
  };
  const save = async (next: OwnerPlanCheckpoint) => {
    await assertCheckpoint();
    const result = await UserMetadata.updateUserMetadata(
      target,
      { [key]: next },
      context,
    );
    if (result.status !== "OK") fail("consolidation checkpoint write failed");
    plan = next;
    expected = next;
    if (
      !isDeepStrictEqual(
        readOwnerPlanCheckpoint(await getRawUserMetadata(target, context)),
        expected,
      )
    )
      fail("consolidation checkpoint write was not persisted");
  };
  observeAdministrativeMethodCreation(source, async (id) => {
    if (
      !reconciling ||
      plan.status !== "RECONCILING" ||
      plan.recipes.some((recipe) => recipe.id === id)
    )
      fail("method creation is outside the reconciliation checkpoint");
    const user = await SuperTokens.getUser(id, context);
    const method = user && (await recipeMethod(user, id, context));
    if (
      !user ||
      !method ||
      user.isPrimaryUser ||
      user.loginMethods.length !== 1 ||
      !source.loginMethods.some((expected) =>
        matchesImportLoginMethod(method, expected),
      )
    )
      fail("a created method does not match the live source");
    const receipt: OwnerRecipe = {
      id,
      identity: identity(method!),
      verified: method!.verified,
      ...(method!.email ? { email: method!.email } : {}),
    };
    plan = {
      ...plan,
      createdRecipes: [...(plan.createdRecipes ?? []), receipt],
    };
    await save(plan);
  });
  const clearRecoveryPointers = async () => {
    for (const candidate of plan.candidates) {
      const saved = (
        await getRawUserMetadata(candidate.rownd_user_id, context)
      )[recoveryKey];
      if (saved === undefined) continue;
      if (!isDeepStrictEqual(saved, { target, planId: plan.id }))
        fail("a source has another recovery pointer");
      await UserMetadata.updateUserMetadata(
        candidate.rownd_user_id,
        { [recoveryKey]: null },
        context,
      );
    }
  };
  return {
    managesMapping: true as const,
    sourceId,
    assertOwners: async (complete = false) => {
      await assertOwners(complete);
    },
    proposedActions,
    plannedOwnerIds: new Set([
      ...plan.recipes.map((recipe) => recipe.id),
      ...plan.aliases.map((alias) => alias.id),
      ...(plan.retiredAliases ?? []).map((alias) => alias.id),
    ]),
    async execute() {
      await assertFresh();
      if (plan.status === "COMPLETE") return;
      if (!expected || previous) {
        await save(plan);
        previous = undefined;
      }
      for (const candidate of plan.candidates) {
        const id = candidate.rownd_user_id;
        if (id === target) continue;
        const pointer = { target, planId: plan.id };
        const saved = (await getRawUserMetadata(id, context))[recoveryKey];
        if (saved !== undefined && !isDeepStrictEqual(saved, pointer))
          fail("a source has another recovery pointer");
        if (saved === undefined)
          await UserMetadata.updateUserMetadata(
            id,
            { [recoveryKey]: pointer },
            context,
          );
      }
      while (plan.cursor < plan.operations.length) {
        const op = plan.operations[plan.cursor]!;
        if (plan.status !== "APPLYING")
          await save({ ...plan, status: "APPLYING" });
        const observed = await assertFresh();
        const after = ownerStateAt(plan, plan.cursor + 1);
        if (
          op.kind === "revoke_verification_tokens" ||
          !isDeepStrictEqual(observed.state, after)
        ) {
          if (op.kind === "detach") {
            const user = await SuperTokens.getUser(op.id, context);
            if (
              !user ||
              (await immutableId(user.id, context)) === target ||
              ((await immutableId(user.id, context)) === op.id &&
                user.loginMethods.length !== 1)
            )
              fail("unsafe primary donor detach");
            const result = await AccountLinking.unlinkAccount(
              SuperTokens.convertToRecipeUserId(await sdkId(op.id, context)),
              context,
            );
            if (result.status !== "OK" || result.wasRecipeUserDeleted)
              fail("Core failed to preserve a donor recipe during detach");
          } else if (op.kind === "promote") {
            const result = await AccountLinking.createPrimaryUser(
              SuperTokens.convertToRecipeUserId(await sdkId(op.id, context)),
              context,
            );
            if (result.status !== "OK") fail("primary promotion failed");
          } else if (op.kind === "link") {
            const donor = SuperTokens.convertToRecipeUserId(
              await sdkId(op.id, context),
            );
            const primary = await sdkId(target, context);
            if (
              (await AccountLinking.canLinkAccounts(donor, primary, context))
                .status !== "OK"
            )
              fail("Core cannot link a donor to the survivor");
            await assertCheckpoint();
            invalidateReconciliationReads("mapping");
            invalidateReconciliationReads("user", donor.getAsString());
            invalidateReconciliationReads("user", primary);
            clearSuperTokensCoreCallCache(context);
            const donorUser = await SuperTokens.getUser(
              donor.getAsString(),
              context,
            );
            const recipient = await SuperTokens.getUser(primary, context);
            if (
              !donorUser ||
              !(await recipeMethod(donorUser, op.id, context)) ||
              !recipient ||
              (await immutableId(recipient.id, context)) !== target
            )
              fail("link ownership changed");
            if (
              (await AccountLinking.linkAccounts(donor, primary, context))
                .status !== "OK"
            )
              fail("donor linking failed");
          } else if (op.kind === "delete_mapping") {
            const result = await SuperTokens.deleteUserIdMapping({
              userId: op.alias,
              userIdType: "EXTERNAL",
              force: true,
              userContext: context,
            });
            if (result.status !== "OK") fail("alias mapping deletion failed");
          } else if (op.kind === "create_mapping") {
            const result = await SuperTokens.createUserIdMapping({
              superTokensUserId: op.id,
              externalUserId: op.alias,
              ...(op.info !== undefined ? { externalUserIdInfo: op.info } : {}),
              force: true,
              userContext: context,
            });
            if (result.status !== "OK") fail("alias mapping creation failed");
          } else if (op.kind === "revoke_verification_tokens") {
            const result =
              await EmailVerification.revokeEmailVerificationTokens(
                tenantId,
                SuperTokens.convertToRecipeUserId(op.id),
                op.email,
                context,
              );
            if (result.status !== "OK")
              fail("old alias verification token revocation failed");
          } else if (op.kind === "verify_email") {
            const recipient = plan.aliases.find(
              (alias) => alias.id === op.id,
            )?.to;
            const baseline = plan.recipes.find(
              (recipe) => recipe.id === recipient,
            );
            if (!baseline?.verified || baseline.email !== op.email)
              fail(
                "verification transfer has no immutable credential baseline",
              );
            const token = await EmailVerification.createEmailVerificationToken(
              tenantId,
              SuperTokens.convertToRecipeUserId(op.id),
              op.email,
              context,
            );
            if (token.status === "OK") {
              const result = await EmailVerification.verifyEmailUsingToken(
                tenantId,
                token.token,
                false,
                context,
              );
              if (result.status !== "OK") fail("verification transfer failed");
            }
          } else if (op.kind === "metadata") {
            invalidateReconciliationReads("metadata", op.id);
            clearSuperTokensCoreCallCache(context);
            if (
              !isDeepStrictEqual(
                markers(await getRawUserMetadata(op.id, context)),
                ownerStateAt(plan).markers.find((entry) => entry.id === op.id)
                  ?.values,
              )
            )
              fail("literal metadata changed before publication");
            const result = await UserMetadata.updateUserMetadata(
              op.id,
              op.values,
              context,
            );
            if (result.status !== "OK") fail("metadata transition failed");
          }
        }
        if (!isDeepStrictEqual((await assertFresh()).state, after))
          fail("the planned transition did not reach its postcondition");
        await save({ ...plan, cursor: plan.cursor + 1, status: "READY" });
      }
      await assertOwners(true);
    },
    async beginMethodReconciliation() {
      await assertOwners(true);
      if (plan.status !== "COMPLETE" && plan.status !== "RECONCILING")
        await save({ ...plan, status: "RECONCILING" });
      reconciling = true;
    },
    async complete() {
      await assertOwners(true);
      if (plan.status === "COMPLETE") {
        await clearRecoveryPointers();
        return;
      }
      for (const [id, saved] of reservations) {
        if (!saved) continue;
        await UserMetadata.updateUserMetadata(id, { [key]: null }, context);
        reservations.set(id, undefined);
      }
      const current = (await SuperTokens.getUser(target, context))!;
      const completedRecipes: OwnerRecipe[] = [];
      for (const method of current.loginMethods)
        completedRecipes.push({
          id: await immutableId(method.recipeUserId.getAsString(), context),
          identity: identity(method),
          verified: method.verified,
          ...(method.email ? { email: method.email } : {}),
        });
      completedRecipes.sort((a, b) => a.id.localeCompare(b.id));
      const completedInitial = structuredClone(plan.initial);
      for (const recipe of completedRecipes) {
        if (!completedInitial.markers.some((entry) => entry.id === recipe.id))
          completedInitial.markers.push({
            id: recipe.id,
            values: markers(await getRawUserMetadata(recipe.id, context)),
          });
        if (recipe.email)
          for (const id of new Set([
            recipe.id,
            await sdkId(recipe.id, context),
          ])) {
            if (
              !completedInitial.verifications.some(
                (entry) => entry.id === id && entry.email === recipe.email,
              )
            )
              completedInitial.verifications.push({
                id,
                email: recipe.email,
                verified: false,
              });
          }
      }
      const completedState = (
        await observe(
          { ...plan, recipes: completedRecipes, initial: completedInitial },
          context,
        )
      ).state;
      await save({
        ...plan,
        status: "COMPLETE",
        completion: { recipes: completedRecipes, state: completedState },
      });
      await assertCompletedPlan(plan, context);
      await clearRecoveryPointers();
    },
  };
}
