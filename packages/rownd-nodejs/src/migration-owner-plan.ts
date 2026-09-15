import { isDeepStrictEqual } from "node:util";
import { RowndMigrationPolicyError } from "./errors";
import type { ActivityCandidate } from "./migration-election";
import { isRecord, type JsonRecord, type JsonValue } from "./utils";
import { assertVerificationCellInheritance } from "./migration-verification";
import type { RowndUser } from "./types";

export type OwnerPlanningResult =
  | { status: "NOOP"; actions: [] }
  | { status: "PLAN"; actions: OwnerOperation[] }
  | { status: "BLOCKED"; reason: string };

function preserveRetiredEmailPointers(values: JsonRecord, retiredAliases: NonNullable<OwnerPlanCheckpoint["retiredAliases"]>, aliases?: OwnerAlias[]) {
  const next = structuredClone(values);
  const resolve = (pointer: JsonValue) => {
    const retired = retiredAliases.find((alias) => alias.id === pointer || (aliases && alias.from === pointer));
    return retired ? aliases?.find((alias) => alias.to === retired.from)?.id ?? retired.from : pointer;
  };
  if (next.rownd_email_recipe_user_id !== undefined)
    next.rownd_email_recipe_user_id = resolve(next.rownd_email_recipe_user_id);
  if (isRecord(next.rownd_email_recipe_user_ids))
    next.rownd_email_recipe_user_ids = Object.fromEntries(Object.entries(next.rownd_email_recipe_user_ids)
      .map(([tenant, pointer]) => [tenant, resolve(pointer)]));
  return next;
}

export function planOwnerOperations(
  input: Pick<
    OwnerPlanCheckpoint,
    "sourceId" | "target" | "recipes" | "aliases" | "retiredAliases" | "initial"
  > & {
    profile: RowndUser;
    authenticatedEmail?: string;
  },
): OwnerPlanningResult {
  const { sourceId, target, initial, aliases, profile, authenticatedEmail } =
    input;
  const recipes = new Map(input.recipes.map((recipe) => [recipe.id, recipe]));
  const emails = new Set(
    input.recipes.flatMap((recipe) => (recipe.email ? [recipe.email] : [])),
  );
  const actions: OwnerOperation[] = [];
  const retiredAliases = input.retiredAliases ?? [];
  let state = initial;
  const append = (operation: OwnerOperation) => {
    state = applyOwnerOperation(state, operation, target);
    actions.push(operation);
  };
  try {
    for (const recipe of recipes.values())
      if (recipe.email) {
        const address =
          initial.mappings.find((entry) => entry.id === recipe.id)?.alias ??
          recipe.id;
        if (
          initial.verifications.find(
            (entry) => entry.id === address && entry.email === recipe.email,
          )?.verified !== recipe.verified
        ) {
          return {
            status: "BLOCKED",
            reason:
              "baseline recipe verification does not match its literal address",
          };
        }
      }
    for (const owner of new Set(
      initial.graph
        .filter((entry) => entry.primary && entry.owner !== target)
        .map((entry) => entry.owner),
    )) {
      // Demoting a primary with secondaries deletes its recipe in Core.
      for (const entry of initial.graph.filter(
        (entry) => entry.owner === owner && entry.id !== owner,
      ))
        append({ kind: "detach", id: entry.id });
      append({ kind: "detach", id: owner });
    }
    if (!state.graph.find((entry) => entry.id === target)?.primary)
      append({ kind: "promote", id: target });
    for (const entry of [...state.graph])
      if (entry.owner !== target) {
        const recipe = recipes.get(entry.id)!;
        const address =
          state.mappings.find((mapping) => mapping.id === entry.id)?.alias ??
          entry.id;
        const verifiedEmail =
          recipe.email &&
          state.graph.some((other) => {
            const otherRecipe = recipes.get(other.id)!;
            const otherAddress =
              state.mappings.find((mapping) => mapping.id === other.id)
                ?.alias ?? other.id;
            return (
              other.owner === target &&
              otherRecipe.email?.toLowerCase() ===
                recipe.email?.toLowerCase() &&
              state.verifications.some(
                (cell) =>
                  cell.id === otherAddress &&
                  cell.email === otherRecipe.email &&
                  cell.verified,
              )
            );
          })
            ? { id: address, email: recipe.email }
            : undefined;
        append({
          kind: "link",
          id: entry.id,
          ...(verifiedEmail ? { verifiedEmail } : {}),
        });
      }
    for (const alias of [
      ...aliases,
      ...retiredAliases.map((alias) => ({ ...alias, to: undefined })),
    ])
      if (alias.from !== alias.to)
        for (const email of emails)
          append({ kind: "revoke_verification_tokens", id: alias.id, email });
    const assertInheritance = () => {
      for (const recipe of recipes.values())
        if (recipe.email) {
          const address =
            state.mappings.find((entry) => entry.id === recipe.id)?.alias ??
            recipe.id;
          assertVerificationCellInheritance(
            recipe.email,
            recipe.verified,
            state.verifications.find(
              (entry) => entry.id === address && entry.email === recipe.email,
            )?.verified === true,
            authenticatedEmail,
          );
        }
    };
    // Persist retirement before removing ownership so a retry or token migration
    // cannot restore the losing alias during the mapping gap.
    for (const marker of [...state.markers]) {
      const values = preserveRetiredEmailPointers(marker.values, retiredAliases);
      if (!isDeepStrictEqual(values, marker.values))
        append({ kind: "metadata", id: marker.id, values });
    }
    for (const alias of retiredAliases) {
      const marker = state.markers.find((entry) => entry.id === alias.id)!;
      append({
        kind: "metadata",
        id: alias.id,
        values: {
          ...marker.values,
          rownd_migration_superseded: { rowndUserId: sourceId, targetUserId: target },
        },
      });
      append({ kind: "delete_mapping", id: alias.from, alias: alias.id });
      assertInheritance();
    }
    for (const alias of aliases)
      if (alias.from !== undefined && alias.from !== alias.to) {
        append({ kind: "delete_mapping", id: alias.from, alias: alias.id });
        assertInheritance();
      }
    for (const alias of aliases)
      if (alias.from !== alias.to) {
        append({
          kind: "create_mapping",
          id: alias.to,
          alias: alias.id,
          ...(alias.info !== undefined ? { info: alias.info } : {}),
        });
        assertInheritance();
        const recipe = recipes.get(alias.to)!;
        if (
          recipe.verified &&
          recipe.email &&
          !state.verifications.find(
            (entry) => entry.id === alias.id && entry.email === recipe.email,
          )?.verified
        )
          append({ kind: "verify_email", id: alias.id, email: recipe.email });
      }
    for (const marker of [...state.markers]) {
      const destination =
        aliases.find((entry) => entry.id === marker.id)?.to ??
        aliases.find((entry) => entry.to === marker.id)?.to;
      const values = preserveRetiredEmailPointers(marker.values, retiredAliases, aliases);
      if (destination !== undefined)
        for (const field of [
          "rownd_migration_target",
          "rownd_migration_canonical_target",
        ])
          if (values[field] !== undefined) values[field] = destination;
      if (marker.id === sourceId) values.rownd_migration_target = target;
      if (marker.id === target)
        values.original_rownd_user = structuredClone(profile);
      if (!isDeepStrictEqual(values, marker.values))
        append({ kind: "metadata", id: marker.id, values });
    }
    return actions.length
      ? { status: "PLAN", actions }
      : { status: "NOOP", actions: [] };
  } catch (error) {
    if (!(error instanceof RowndMigrationPolicyError)) throw error;
    return { status: "BLOCKED", reason: error.message };
  }
}

export const OWNER_PLAN_KEY = "rownd_migration_owner_consolidation";
export const OWNER_POLICY_MARKER_KEYS = [
  "rownd_email_recipe_user_id",
  "rownd_email_recipe_user_ids",
  "rownd_pending_verification",
  "rownd_migration_email_retirements",
  "rownd_migration_provider_retirements",
  "rownd_migration_provider_introductions",
  "rownd_migration_provider_introduction",
] as const;
export type OwnerRecipe = {
  id: string;
  identity: string;
  email?: string;
  verified: boolean;
};
export type OwnerGraph = { id: string; owner: string; primary: boolean }[];
export type OwnerAlias = {
  id: string;
  from?: string;
  to: string;
  info?: string;
};
export type OwnerState = {
  graph: OwnerGraph;
  mappings: { id: string; alias?: string; info?: string }[];
  markers: { id: string; values: JsonRecord }[];
  verifications: { id: string; email: string; verified: boolean }[];
};
export type OwnerOperation =
  | {
      kind: "detach" | "promote" | "link";
      id: string;
      verifiedEmail?: { id: string; email: string };
    }
  | {
      kind: "delete_mapping" | "create_mapping";
      id: string;
      alias: string;
      info?: string;
    }
  | { kind: "metadata"; id: string; values: JsonRecord }
  | {
      kind: "verify_email" | "revoke_verification_tokens";
      id: string;
      email: string;
    };
export type OwnerPlanCheckpoint = {
  version: 2;
  id: string;
  sourceId: string;
  target: string;
  candidates: ActivityCandidate[];
  absentAliases: string[];
  recipes: OwnerRecipe[];
  aliases: OwnerAlias[];
  retiredAliases?: { id: string; from: string; info?: string }[];
  initial: OwnerState;
  operations: OwnerOperation[];
  cursor: number;
  status: "READY" | "APPLYING" | "RECONCILING" | "COMPLETE";
  reservation?: true;
  createdRecipes?: OwnerRecipe[];
  completion?: { recipes: OwnerRecipe[]; state: OwnerState };
};

function invalid(): never {
  throw new RowndMigrationPolicyError(
    "Invalid duplicate owner consolidation plan",
  );
}

function assertState(
  state: OwnerState,
  recipes: OwnerRecipe[],
  target?: string,
) {
  if (
    !recipes.length ||
    recipes.some(
      (recipe) =>
        !isRecord(recipe) ||
        typeof recipe.id !== "string" ||
        !recipe.id ||
        typeof recipe.identity !== "string" ||
        typeof recipe.verified !== "boolean" ||
        (recipe.email !== undefined && typeof recipe.email !== "string"),
    )
  )
    invalid();
  const ids = new Set(recipes.map((recipe) => recipe.id));
  if (
    ids.size !== recipes.length ||
    state.graph.length !== ids.size ||
    state.mappings.length !== ids.size ||
    state.graph.some(
      (entry) =>
        !isRecord(entry) ||
        !ids.has(entry.id) ||
        !ids.has(entry.owner) ||
        typeof entry.primary !== "boolean" ||
        (target !== undefined && (entry.owner !== target || !entry.primary)),
    ) ||
    new Set(state.graph.map((entry) => entry.id)).size !== ids.size ||
    state.mappings.some(
      (entry) =>
        !isRecord(entry) ||
        !ids.has(entry.id) ||
        (entry.alias !== undefined &&
          (typeof entry.alias !== "string" || !entry.alias)) ||
        (entry.info !== undefined && typeof entry.info !== "string"),
    ) ||
    new Set(state.mappings.map((entry) => entry.id)).size !== ids.size ||
    new Set(
      state.mappings.flatMap((entry) => (entry.alias ? [entry.alias] : [])),
    ).size !==
      state.mappings.filter((entry) => entry.alias !== undefined).length ||
    state.markers.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        !entry.id ||
        !isRecord(entry.values),
    ) ||
    new Set(state.markers.map((entry) => entry.id)).size !==
      state.markers.length ||
    state.verifications.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        !entry.id ||
        typeof entry.email !== "string" ||
        !entry.email ||
        typeof entry.verified !== "boolean",
    ) ||
    new Set(
      state.verifications.map((entry) =>
        JSON.stringify([entry.id, entry.email]),
      ),
    ).size !== state.verifications.length
  )
    invalid();
}

function assertFinalAliases(plan: OwnerPlanCheckpoint, state: OwnerState) {
  if (
    (plan.retiredAliases ?? []).some((alias) =>
      state.mappings.some((entry) => entry.alias === alias.id) ||
      !isDeepStrictEqual(
        state.markers.find((entry) => entry.id === alias.id)?.values.rownd_migration_superseded,
        { rowndUserId: plan.sourceId, targetUserId: plan.target },
      ),
    ) ||
    plan.aliases.some(
      (alias) =>
        !state.mappings.some(
          (entry) => entry.id === alias.to && entry.alias === alias.id,
        ),
    ) ||
    state.mappings.some(
      (entry) =>
        entry.alias !== undefined &&
        !plan.aliases.some(
          (alias) => alias.id === entry.alias && alias.to === entry.id,
        ),
    )
  )
    invalid();
}

// Literal metadata only. A checkpoint is recovery evidence, never execution proof.
export function readOwnerPlanCheckpoint(
  metadata: JsonRecord,
): OwnerPlanCheckpoint | undefined {
  const value = metadata[OWNER_PLAN_KEY];
  if (value === undefined || (isRecord(value) && value.version === 1))
    return undefined;
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.sourceId !== "string" ||
    !value.sourceId ||
    typeof value.target !== "string" ||
    !value.target ||
    !["READY", "APPLYING", "RECONCILING", "COMPLETE"].includes(
      String(value.status),
    ) ||
    !Number.isInteger(value.cursor) ||
    !Array.isArray(value.operations) ||
    (value.cursor as number) < 0 ||
    (value.cursor as number) > value.operations.length ||
    !Array.isArray(value.candidates) ||
    !value.candidates.length ||
    value.candidates.some(
      (candidate) =>
        !isRecord(candidate) ||
        typeof candidate.rownd_user_id !== "string" ||
        !candidate.rownd_user_id ||
        (candidate.supertokens_user_id !== undefined &&
          typeof candidate.supertokens_user_id !== "string"),
    ) ||
    !Array.isArray(value.absentAliases) ||
    value.absentAliases.some((alias) => typeof alias !== "string") ||
    !Array.isArray(value.recipes) ||
    !value.recipes.length ||
    value.recipes.some(
      (recipe) =>
        !isRecord(recipe) ||
        typeof recipe.id !== "string" ||
        !recipe.id ||
        typeof recipe.identity !== "string" ||
        typeof recipe.verified !== "boolean" ||
        (recipe.email !== undefined && typeof recipe.email !== "string"),
    ) ||
    !Array.isArray(value.aliases) ||
    value.aliases.some(
      (alias) =>
        !isRecord(alias) ||
        typeof alias.id !== "string" ||
        typeof alias.to !== "string" ||
        (alias.from !== undefined && typeof alias.from !== "string") ||
        (alias.info !== undefined && typeof alias.info !== "string"),
    ) ||
    !isRecord(value.initial) ||
    !Array.isArray(value.initial.graph) ||
    !Array.isArray(value.initial.mappings) ||
    !Array.isArray(value.initial.markers) ||
    !Array.isArray(value.initial.verifications) ||
    (value.reservation !== undefined && value.reservation !== true)
  )
    invalid();
  const plan = value as OwnerPlanCheckpoint;
  assertState(plan.initial, plan.recipes);
  const ids = new Set(plan.recipes.map((recipe) => recipe.id));
  if (
    plan.retiredAliases !== undefined &&
    (!Array.isArray(plan.retiredAliases) ||
      plan.retiredAliases.some((alias) =>
        !isRecord(alias) ||
        typeof alias.id !== "string" || !alias.id ||
        typeof alias.from !== "string" || !ids.has(alias.from) ||
        ids.has(alias.id) ||
        (alias.info !== undefined && typeof alias.info !== "string") ||
        plan.aliases.some((active) => active.id === alias.id) ||
        !plan.initial.mappings.some((entry) =>
          entry.id === alias.from && entry.alias === alias.id && entry.info === alias.info,
        ),
      ) ||
      new Set(plan.retiredAliases.map((alias) => alias.id)).size !== plan.retiredAliases.length)
  )
    invalid();
  if (
    plan.createdRecipes !== undefined &&
    (!Array.isArray(plan.createdRecipes) ||
      !["RECONCILING", "COMPLETE"].includes(plan.status) ||
      plan.createdRecipes.some(
        (recipe) =>
          !isRecord(recipe) ||
          typeof recipe.id !== "string" ||
          !recipe.id ||
          ids.has(recipe.id) ||
          typeof recipe.identity !== "string" ||
          typeof recipe.verified !== "boolean" ||
          (recipe.email !== undefined && typeof recipe.email !== "string"),
      ) ||
      new Set(plan.createdRecipes.map((recipe) => recipe.id)).size !==
        plan.createdRecipes.length)
  )
    invalid();
  if (
    !ids.has(plan.target) ||
    !plan.candidates.some(
      (candidate) => candidate.rownd_user_id === plan.sourceId,
    ) ||
    new Set(plan.candidates.map((candidate) => candidate.rownd_user_id))
      .size !== plan.candidates.length ||
    new Set(plan.aliases.map((alias) => alias.id)).size !==
      plan.aliases.length ||
    new Set(plan.aliases.map((alias) => alias.to)).size !==
      plan.aliases.length ||
    new Set(plan.absentAliases).size !== plan.absentAliases.length ||
    plan.absentAliases.some((alias) =>
      plan.candidates.some((candidate) => candidate.rownd_user_id === alias),
    ) ||
    plan.aliases.some(
      (alias) =>
        !ids.has(alias.to) ||
        (alias.from !== undefined && !ids.has(alias.from)),
    ) ||
    !plan.aliases.some(
      (alias) => alias.id === plan.sourceId && alias.to === plan.target,
    ) ||
    plan.initial.mappings.some(
      (entry) =>
        entry.alias !== undefined &&
        ![...plan.aliases, ...(plan.retiredAliases ?? [])].some(
          (alias) => alias.id === entry.alias && alias.from === entry.id,
        ),
    )
  )
    invalid();
  const literals = new Set([
    ...ids,
    ...plan.aliases.map((alias) => alias.id),
    ...(plan.retiredAliases ?? []).map((alias) => alias.id),
    ...plan.candidates.map((candidate) => candidate.rownd_user_id),
  ]);
  if (
    [...literals].some(
      (id) => !plan.initial.markers.some((entry) => entry.id === id),
    )
  )
    invalid();
  for (const id of literals)
    for (const recipe of plan.recipes)
      if (
        recipe.email &&
        !plan.initial.verifications.some(
          (entry) => entry.id === id && entry.email === recipe.email,
        )
      )
        invalid();
  for (const op of plan.operations) {
    if (!isRecord(op) || typeof op.id !== "string") invalid();
    if (["detach", "promote", "link"].includes(op.kind)) {
      if (!ids.has(op.id)) invalid();
      if (
        "verifiedEmail" in op &&
        op.verifiedEmail !== undefined &&
        (op.kind !== "link" ||
          !isRecord(op.verifiedEmail) ||
          !plan.initial.verifications.some(
            (entry) =>
              entry.id === op.verifiedEmail!.id &&
              entry.email === op.verifiedEmail!.email,
          ))
      )
        invalid();
    } else if (op.kind === "delete_mapping" || op.kind === "create_mapping") {
      if (!ids.has(op.id) || typeof op.alias !== "string") invalid();
    } else if (op.kind === "metadata") {
      if (
        !isRecord(op.values) ||
        !plan.initial.markers.some((entry) => entry.id === op.id) ||
        Object.keys(op.values).some(
          (field) =>
            ![
              "original_rownd_user",
              "rownd_migration_target",
              "rownd_migration_canonical_target",
              "rownd_migration_superseded",
              "rownd_migration_reconciliation",
              ...OWNER_POLICY_MARKER_KEYS,
            ].includes(field),
        ) ||
        OWNER_POLICY_MARKER_KEYS.some(
          (field) =>
            !isDeepStrictEqual(
              op.values[field],
              plan.initial.markers.find((entry) => entry.id === op.id)?.values[
                field
              ],
            ) && !isDeepStrictEqual(
              op.values[field],
              preserveRetiredEmailPointers(
                plan.initial.markers.find((entry) => entry.id === op.id)!.values,
                plan.retiredAliases ?? [],
              )[field],
            ) && !isDeepStrictEqual(
              op.values[field],
              preserveRetiredEmailPointers(
                plan.initial.markers.find((entry) => entry.id === op.id)!.values,
                plan.retiredAliases ?? [],
                plan.aliases,
              )[field],
            ),
        )
      )
        invalid();
    } else if (
      op.kind === "verify_email" ||
      op.kind === "revoke_verification_tokens"
    ) {
      if (
        typeof op.email !== "string" ||
        !plan.initial.verifications.some(
          (entry) => entry.id === op.id && entry.email === op.email,
        )
      )
        invalid();
    } else invalid();
  }
  if (
    ["RECONCILING", "COMPLETE"].includes(plan.status) &&
    plan.cursor !== plan.operations.length
  )
    invalid();
  if (
    plan.completion !== undefined &&
    (!isRecord(plan.completion) ||
      !Array.isArray(plan.completion.recipes) ||
      !isRecord(plan.completion.state) ||
      !Array.isArray(plan.completion.state.graph) ||
      !Array.isArray(plan.completion.state.mappings) ||
      !Array.isArray(plan.completion.state.markers) ||
      !Array.isArray(plan.completion.state.verifications))
  )
    invalid();
  const final = ownerStateAt(plan, plan.operations.length);
  assertState(final, plan.recipes, plan.target);
  assertFinalAliases(plan, final);
  if (plan.status === "COMPLETE" && plan.completion === undefined) invalid();
  if (plan.completion) {
    if (plan.status !== "COMPLETE") invalid();
    const completed = plan.completion;
    assertState(completed.state, completed.recipes, plan.target);
    assertFinalAliases(plan, completed.state);
    if (
      [...plan.recipes, ...(plan.createdRecipes ?? [])].some(
        (original) =>
          !completed.recipes.some(
            (recipe) =>
              recipe.id === original.id &&
              recipe.identity === original.identity &&
              recipe.email === original.email,
          ),
      ) ||
      plan.initial.markers.some(
        (marker) =>
          !completed.state.markers.some((entry) => entry.id === marker.id),
      ) ||
      plan.initial.verifications.some(
        (cell) =>
          !completed.state.verifications.some(
            (entry) => entry.id === cell.id && entry.email === cell.email,
          ),
      )
    )
      invalid();
  }
  return plan;
}

export function applyOwnerOperation(
  state: OwnerState,
  operation: OwnerOperation,
  target: string,
): OwnerState {
  const next = structuredClone(state);
  if (operation.kind === "revoke_verification_tokens") {
    return next;
  } else if (operation.kind === "verify_email") {
    const entry = next.verifications.find(
      (entry) => entry.id === operation.id && entry.email === operation.email,
    );
    if (!entry) invalid();
    entry.verified = true;
  } else if (operation.kind === "metadata") {
    const entry = next.markers.find((marker) => marker.id === operation.id);
    if (!entry) invalid();
    entry.values = structuredClone(operation.values);
  } else if (
    operation.kind === "delete_mapping" ||
    operation.kind === "create_mapping"
  ) {
    const mapping = next.mappings.find((entry) => entry.id === operation.id);
    if (!mapping) invalid();
    if (operation.kind === "delete_mapping") {
      if (mapping.alias !== operation.alias) invalid();
      delete mapping.alias;
      delete mapping.info;
    } else {
      if (
        mapping.alias !== undefined ||
        next.mappings.some((entry) => entry.alias === operation.alias)
      )
        invalid();
      mapping.alias = operation.alias;
      if (operation.info !== undefined) mapping.info = operation.info;
    }
  } else {
    const recipe = next.graph.find((entry) => entry.id === operation.id);
    if (!recipe) invalid();
    if (operation.kind === "detach") {
      if (
        !recipe.primary ||
        recipe.owner === target ||
        (recipe.owner === recipe.id &&
          next.graph.some(
            (entry) => entry.owner === recipe.owner && entry.id !== recipe.id,
          ))
      )
        invalid();
      recipe.owner = recipe.id;
      recipe.primary = false;
    } else if (operation.kind === "promote") {
      if (recipe.owner !== recipe.id || recipe.id !== target || recipe.primary)
        invalid();
      recipe.primary = true;
    } else if (operation.kind === "link") {
      if (
        recipe.primary ||
        recipe.owner !== recipe.id ||
        !next.graph.some(
          (entry) =>
            entry.id === target && entry.primary && entry.owner === target,
        )
      )
        invalid();
      recipe.owner = target;
      recipe.primary = true;
      if (operation.verifiedEmail) {
        const cell = next.verifications.find(
          (entry) =>
            entry.id === operation.verifiedEmail!.id &&
            entry.email === operation.verifiedEmail!.email,
        );
        if (!cell) invalid();
        cell.verified = true;
      }
    }
  }
  return next;
}

export function ownerStateAt(
  plan: OwnerPlanCheckpoint,
  cursor = plan.cursor,
): OwnerState {
  return plan.operations
    .slice(0, cursor)
    .reduce(
      (state, operation) => applyOwnerOperation(state, operation, plan.target),
      plan.initial,
    );
}

export function sameOwnerPlan(
  left: OwnerPlanCheckpoint,
  right: OwnerPlanCheckpoint,
) {
  const base = (plan: OwnerPlanCheckpoint) =>
    Object.fromEntries(
      Object.entries(plan).filter(
        ([field]) =>
          ![
            "cursor",
            "status",
            "reservation",
            "completion",
            "createdRecipes",
          ].includes(field),
      ),
    );
  return isDeepStrictEqual(base(left), base(right));
}
