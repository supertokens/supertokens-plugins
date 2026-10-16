import type { User } from "supertokens-node/types";
import type { ActivityCandidate } from "./migration-election";
import type { OwnerPlanCheckpoint } from "./migration-owner-plan";

export type VerifiedPhoneSurvivor = Readonly<{
  phoneNumber: string;
  supertokensUserId: string;
}>;

const survivorProofs = new WeakSet<VerifiedPhoneSurvivor>();

function survivorProof(phoneNumber: string, supertokensUserId: string) {
  const proof = Object.freeze({ phoneNumber, supertokensUserId });
  survivorProofs.add(proof);
  return proof;
}

export function isVerifiedPhoneSurvivor(proof: VerifiedPhoneSurvivor) {
  return survivorProofs.has(proof);
}

// A retry may already have promoted the survivor. Only the validated checkpoint's
// original standalone graph can authorize that transition; current primary state
// alone is never phone-election evidence.
export function inspectCheckpointVerifiedPhoneSurvivor(
  checkpoint: OwnerPlanCheckpoint,
  tenantId: string,
): VerifiedPhoneSurvivor | undefined {
  const graph = checkpoint.initial.graph;
  const recipe = checkpoint.recipes[0];
  if (graph.length !== 1 || graph[0]!.primary ||
    graph[0]!.id !== checkpoint.target || graph[0]!.owner !== checkpoint.target ||
    checkpoint.recipes.length !== 1 || !recipe?.verified || recipe.id !== checkpoint.target)
    return undefined;
  let identity: unknown;
  try { identity = JSON.parse(recipe.identity); } catch { return undefined; }
  if (!Array.isArray(identity) || identity[0] !== "passwordless" || identity[1] !== null ||
    typeof identity[2] !== "string" || !identity[2] || identity[3] !== null ||
    !Array.isArray(identity[4]) || identity[4].length !== 1 || identity[4][0] !== tenantId ||
    !checkpoint.candidates.some((candidate) => candidate.supertokens_user_id === checkpoint.target) ||
    checkpoint.candidates.some((candidate) => candidate.supertokens_user_id !== undefined &&
      candidate.supertokens_user_id !== checkpoint.target)) return undefined;
  return survivorProof(identity[2], checkpoint.target);
}

// Contact-only election must not inherit the broader privileges of a preferred
// primary. Validate the complete owner before the caller pins it as preferred.
export function inspectVerifiedPhoneSurvivor(
  owners: { id: string; user: User }[],
  candidates: ActivityCandidate[],
  tenantId: string,
): VerifiedPhoneSurvivor | undefined {
  const unique = [...new Map(owners.map((owner) => [owner.id, owner])).values()];
  if (unique.length !== 1) return undefined;
  const { id, user } = unique[0]!;
  const method = user.loginMethods[0];
  if (
    user.isPrimaryUser ||
    user.loginMethods.length !== 1 ||
    !method ||
    method.recipeId !== "passwordless" ||
    method.email !== undefined ||
    !method.phoneNumber ||
    !method.verified ||
    method.tenantIds.length !== 1 ||
    method.tenantIds[0] !== tenantId ||
    !candidates.some((candidate) => candidate.supertokens_user_id === id) ||
    candidates.some((candidate) =>
      candidate.supertokens_user_id !== undefined &&
      candidate.supertokens_user_id !== id,
    ) ||
    !candidates.some((candidate) =>
      candidate.supertokens_user_id === id &&
      [id, candidate.rownd_user_id].includes(method.recipeUserId.getAsString()),
    )
  ) return undefined;
  return survivorProof(method.phoneNumber, id);
}
