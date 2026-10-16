import { reconciliationSuperTokens as SuperTokens } from "./reconciliation-sdk";
import { getRawUserMetadata } from "./rownd-compatibility";
import { fetchOptionalRowndUserInfo } from "./rownd-repository";
import { assertRowndSourcePayload, isRowndMigrationProfileActive } from "./migration-email";
import { resolveRowndProviderSubject } from "./provider-identity";
import { readOwnerPlanCheckpoint } from "./migration-owner-plan";
import type { ActivityCandidate } from "./migration-election";
import type { RowndUser } from "./types";
import type { JsonRecord } from "./utils";

export type InstantPrimaryProof = Readonly<{ instantAlias: string; authenticatedAlias: string; target: string; provider: string; subject: string; email: string }>;
const proofs = new WeakSet<InstantPrimaryProof>();

export function isIdentitylessInstant(profile: RowndUser) {
  return profile.auth_level === "instant" &&
    [profile.data, profile.verified_data ?? {}].every((data) =>
      !data.email && !data.phone_number && !data.google_id && !data.apple_id) &&
    !resolveRowndProviderSubject(profile, "google") && !resolveRowndProviderSubject(profile, "apple");
}

export function matchesInstantPrimaryProof(proof: InstantPrimaryProof | undefined, profiles: RowndUser[]) {
  return proof !== undefined && proofs.has(proof) && profiles.length === 2 &&
    profiles.some((profile) => profile.data.user_id === proof.instantAlias && isIdentitylessInstant(profile)) &&
    profiles.every(isRowndMigrationProfileActive) &&
    profiles.some((profile) => profile.data.user_id === proof.authenticatedAlias && matchesAuthenticatedIdentity(profile, proof));
}

function matchesAuthenticatedIdentity(profile: RowndUser, proof: { provider: string; subject: string; email: string }) {
  return resolveRowndProviderSubject(profile, proof.provider) === proof.subject &&
    [profile.data[`${proof.provider}_id`], profile.verified_data?.[`${proof.provider}_id`]].every((value) =>
      value === undefined || value === null || value === "" || value === proof.subject) &&
    profile.data.email?.toLowerCase() === proof.email &&
    (profile.verified_data?.email === true || (typeof profile.verified_data?.email === "string" && profile.verified_data.email.toLowerCase() === proof.email));
}

// Checkpoint initial state retains literal provenance after the canonical alias
// moves. The owner executor separately validates every current checkpoint state.
export async function inspectInstantPrimaryProof(candidates: ActivityCandidate[], tenantId: string, context: JsonRecord) {
  if (tenantId !== "public" || candidates.length !== 2) return undefined;
  const live = await Promise.all(candidates.map((candidate) => fetchOptionalRowndUserInfo(candidate.rownd_user_id)));
  for (const [index, profile] of live.entries()) {
    if (!profile) return undefined;
    assertRowndSourcePayload(profile);
    if (profile.data.user_id !== candidates[index]!.rownd_user_id || !isRowndMigrationProfileActive(profile)) return undefined;
  }
  const instantIndex = live.findIndex((profile) => isIdentitylessInstant(profile!));
  if (instantIndex < 0) return undefined;
  const instant = candidates[instantIndex]!, authenticated = candidates[1 - instantIndex]!;
  if (!instant.supertokens_user_id || !authenticated.supertokens_user_id) return undefined;
  const user = await SuperTokens.getUser(instant.supertokens_user_id, context);
  if (!user?.isPrimaryUser) return undefined;
  const ownerMapping = await SuperTokens.getUserIdMapping({ userId: user.id, userIdType: "EXTERNAL", userContext: context });
  const target = ownerMapping.status === "OK" ? ownerMapping.superTokensUserId : user.id;
  const metadata = await getRawUserMetadata(target, context);
  const checkpoint = readOwnerPlanCheckpoint(metadata);
  const originalId = (alias: string) => checkpoint?.initial.mappings.find((entry) => entry.alias === alias)?.id ??
    candidates.find((candidate) => candidate.rownd_user_id === alias)?.supertokens_user_id;
  const instantId = originalId(instant.rownd_user_id), authenticatedId = originalId(authenticated.rownd_user_id);
  if (instantId !== target || !authenticatedId || authenticatedId === target) return undefined;
  if (checkpoint && (checkpoint.target !== target || checkpoint.sourceId !== authenticated.rownd_user_id ||
    checkpoint.initial.graph.some((entry) => entry.owner !== target || !entry.primary))) return undefined;
  // Bulk imports can store provenance only on the external alias. Both literal
  // locations are bound by the mapping below; conflicting snapshots never win by
  // fallback order. On resume, use initial markers before alias relocation.
  const stored = async (id: string, alias: string) => {
    const snapshots: RowndUser[] = [];
    for (const literal of [id, alias]) {
      const original = checkpoint
        ? checkpoint.initial.markers.find((marker) => marker.id === literal)?.values.original_rownd_user
        : (await getRawUserMetadata(literal, context)).original_rownd_user;
      if (original === undefined) continue;
      assertRowndSourcePayload(original as RowndUser);
      snapshots.push(original as RowndUser);
    }
    return snapshots;
  };
  const oldInstant = await stored(target, instant.rownd_user_id), oldAuthenticated = await stored(authenticatedId, authenticated.rownd_user_id);
  if (!oldInstant.length || !oldAuthenticated.length ||
    oldInstant.some((profile) => !isRowndMigrationProfileActive(profile) || profile.data.user_id !== instant.rownd_user_id || !isIdentitylessInstant(profile)) ||
    oldAuthenticated.some((profile) => !isRowndMigrationProfileActive(profile) || profile.data.user_id !== authenticated.rownd_user_id)) return undefined;
  const methods = new Map<string, typeof user.loginMethods[number]>();
  for (const method of user.loginMethods) {
    if (method.tenantIds.length !== 1 || method.tenantIds[0] !== tenantId) return undefined;
    const mapping = await SuperTokens.getUserIdMapping({ userId: method.recipeUserId.getAsString(), userIdType: "EXTERNAL", userContext: context });
    methods.set(mapping.status === "OK" ? mapping.superTokensUserId : method.recipeUserId.getAsString(), method);
  }
  const anchor = methods.get(target), provider = methods.get(authenticatedId)?.thirdParty;
  if (anchor?.thirdParty?.id !== "instant" || anchor.thirdParty.userId !== instant.rownd_user_id ||
    !provider || !["google", "apple"].includes(provider.id)) return undefined;
  const current = live[1 - instantIndex]!;
  if (methods.get(authenticatedId)?.email?.toLowerCase() !== current.data.email?.toLowerCase()) return undefined;
  if (!current.data.email || ![current, ...oldAuthenticated].every((profile) => matchesAuthenticatedIdentity(profile,
    { provider: provider.id, subject: provider.userId, email: current.data.email!.toLowerCase() }))) return undefined;
  for (const candidate of candidates) {
    const mapping = await SuperTokens.getUserIdMapping({ userId: candidate.rownd_user_id, userIdType: "EXTERNAL", userContext: context });
    if (!checkpoint && (mapping.status !== "OK" || mapping.superTokensUserId !== candidate.supertokens_user_id)) return undefined;
    if (mapping.status === "OK" && !methods.has(mapping.superTokensUserId)) return undefined;
    const owner = await SuperTokens.getUser(candidate.supertokens_user_id!, context);
    if (!owner || owner.id !== user.id) return undefined;
  }
  const proof = Object.freeze({ instantAlias: instant.rownd_user_id, authenticatedAlias: authenticated.rownd_user_id, target,
    provider: provider.id, subject: provider.userId, email: current.data.email!.toLowerCase() });
  proofs.add(proof);
  return proof;
}
