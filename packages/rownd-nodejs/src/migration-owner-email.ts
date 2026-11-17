import type { OwnerPlanCheckpoint } from "./migration-owner-plan";
import type { RowndUser, SuperTokensUserImport } from "./types";
import { assertRowndSourcePayload } from "./migration-email";
import { resolveRowndProviderSubject } from "./provider-identity";

// Only consolidation's validated graph may supply historical email provenance.
const plans = new WeakMap<SuperTokensUserImport, OwnerPlanCheckpoint>();

export function bindOwnerEmailPlan(source: SuperTokensUserImport, plan: OwnerPlanCheckpoint) {
  plans.set(source, plan);
}

export function getOwnerEmailPlan(source: SuperTokensUserImport) {
  return plans.get(source);
}

export function checkpointEmailPointer(plan: OwnerPlanCheckpoint, pointer: string) {
  const alias = [...plan.aliases, ...(plan.retiredAliases ?? [])].find((entry) => entry.id === pointer);
  if (!alias?.from || !plan.operations.some((operation, index) => index <= plan.cursor &&
    operation.kind === "delete_mapping" && operation.alias === pointer && operation.id === alias.from)) return undefined;
  return alias.from;
}

export function hasCheckpointEmailHistory(plan: OwnerPlanCheckpoint, source: SuperTokensUserImport, recipeId: string, email: string) {
  const recipe = plan.recipes.find((entry) => entry.id === recipeId && entry.email?.toLowerCase() === email.toLowerCase());
  if (!recipe) return false;
  const owner = plan.initial.graph.find((entry) => entry.id === recipeId)?.owner;
  return plan.initial.markers.some(({ id, values }) => {
    const snapshot = values.original_rownd_user as RowndUser | undefined;
    if (snapshot === undefined) return false;
    assertRowndSourcePayload(snapshot);
    const mapped = plan.initial.mappings.find((entry) => entry.alias === id)?.id ?? id;
    if (plan.initial.graph.find((entry) => entry.id === mapped)?.owner !== owner ||
      !plan.candidates.some((candidate) => candidate.rownd_user_id === snapshot.data.user_id) ||
      snapshot.data.email?.toLowerCase() !== email.toLowerCase() ||
      !(snapshot.verified_data?.email === true || (typeof snapshot.verified_data?.email === "string" &&
        snapshot.verified_data.email.toLowerCase() === email.toLowerCase()))) return false;
    return source.loginMethods.some((method) => method.recipeId === "thirdparty" &&
      ["google", "apple"].includes(method.thirdPartyId) &&
      resolveRowndProviderSubject(snapshot, method.thirdPartyId) === method.thirdPartyUserId);
  });
}
