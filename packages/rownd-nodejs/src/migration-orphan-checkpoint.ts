import { isDeepStrictEqual } from "node:util";
import { RowndMigrationPolicyError } from "./errors";
import { resolveRowndProviderSubject } from "./provider-identity";
import type { RowndUser } from "./types";
import { isRecord, type JsonRecord } from "./utils";

export const orphanCheckpointKey = "rownd_migration_orphan_mapping_repair";
export type OrphanRepair = {
  version: 1; sourceId: string; absentId: string; target: string; tenantId: string;
  winner: string; phase: "PREPARED" | "HANDOFF" | "COMPLETE";
  absence?: { externalSelector: true; internalTarget: true }; previousCheckpoint?: string;
  oldMapping: { superTokensUserId: string; externalUserId: string; externalUserIdInfo?: string };
  evidence: string; sourceIdentity: string;
};

function invalid(): never { throw new RowndMigrationPolicyError("MAPPING_TARGET_MISSING: ORPHAN_MAPPING_RECOVERY_BLOCKED: invalid durable checkpoint"); }
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function parse(value: string): unknown { try { return JSON.parse(value); } catch { return invalid(); } }
function sameSet(actual: string[], expected: Set<string>) {
  return actual.length === expected.size && new Set(actual).size === actual.length && actual.every((id) => expected.has(id));
}

export function sameOrphanSourceIdentity(expected: string, actual: string) {
  if (expected === actual) return true;
  const old = parse(expected), current = parse(actual);
  return Array.isArray(old) && old.length === 5 && isRecord(current) && isDeepStrictEqual(old,
    parse(JSON.stringify([current.data, current.verified_data, current.state, current.auth_level, current.meta])));
}

export function sameEarlierOrphanEvidence(previous: OrphanRepair, current: OrphanRepair) {
  if (previous.absence !== undefined || previous.phase === "COMPLETE" ||
    ["sourceId", "absentId", "target", "tenantId", "winner"].some((field) => previous[field as keyof OrphanRepair] !== current[field as keyof OrphanRepair]) ||
    !isDeepStrictEqual(previous.oldMapping, current.oldMapping) || !sameOrphanSourceIdentity(previous.sourceIdentity, current.sourceIdentity)) return false;
  const before = parse(previous.evidence), after = parse(current.evidence);
  if (!isRecord(before) || !isRecord(after) || !isRecord(before.metadata) || !isRecord(after.metadata)) return false;
  after.sourceIdentity = previous.sourceIdentity;
  if (before.mappings === undefined) delete after.mappings;
  if (previous.phase === "HANDOFF") {
    const oldSource = before.metadata[previous.sourceId], newSource = after.metadata[previous.sourceId];
    if (!isRecord(oldSource) || !isRecord(newSource) || newSource.rownd_migration_target !== previous.target) return false;
    if (oldSource.rownd_migration_target === undefined) delete newSource.rownd_migration_target;
    else newSource.rownd_migration_target = oldSource.rownd_migration_target;
  }
  return isDeepStrictEqual(before, after);
}

function validate(value: unknown, previous = false): OrphanRepair {
  if (!isRecord(value) || value.version !== 1 ||
    ![value.sourceId, value.absentId, value.target, value.winner, value.evidence, value.sourceIdentity].every(text) || value.tenantId !== "public" ||
    !["PREPARED", "HANDOFF", "COMPLETE"].includes(value.phase as string) ||
    new Set([value.sourceId, value.absentId, value.target]).size !== 3 || !isRecord(value.oldMapping) ||
    value.oldMapping.superTokensUserId !== value.absentId || value.oldMapping.externalUserId !== value.sourceId ||
    (value.oldMapping.externalUserIdInfo !== undefined && typeof value.oldMapping.externalUserIdInfo !== "string") ||
    (value.absence !== undefined && (!isRecord(value.absence) || value.absence.externalSelector !== true || value.absence.internalTarget !== true)) ||
    (value.previousCheckpoint !== undefined && (!text(value.previousCheckpoint) || previous))) invalid();
  const plan = value as OrphanRepair;
  const identity = parse(plan.sourceIdentity);
  const legacy = Array.isArray(identity);
  if (legacy && (identity.length !== 5 || plan.absence !== undefined)) invalid();
  if (!legacy && (!isRecord(identity) || plan.absence === undefined)) invalid();
  const profile = (legacy ? { data: identity[0], verified_data: identity[1], state: identity[2], auth_level: identity[3], meta: identity[4] } : identity) as RowndUser;
  if (!isRecord(profile.data) || profile.data.user_id !== plan.sourceId || profile.state !== "enabled" || !text(profile.data.email) ||
    !isRecord(profile.verified_data) || !(profile.verified_data.email === true ||
      (typeof profile.verified_data.email === "string" && profile.verified_data.email.toLowerCase() === profile.data.email.toLowerCase()))) invalid();
  const evidence = parse(plan.evidence);
  if (!isRecord(evidence) || evidence.target !== plan.target || evidence.primary !== true || evidence.winner !== plan.winner ||
    evidence.sourceIdentity !== plan.sourceIdentity || !Array.isArray(evidence.recipes) || !evidence.recipes.length ||
    !Array.isArray(evidence.aliases) || !Array.isArray(evidence.election) || !evidence.election.length ||
    !isRecord(evidence.metadata) || !isRecord(evidence.profiles) || !Array.isArray(evidence.verifications)) invalid();
  const recipes = new Map<string, JsonRecord>();
  const emails = new Set([profile.data.email.toLowerCase()]);
  for (const recipe of evidence.recipes) {
    if (!isRecord(recipe) || !text(recipe.id) || recipes.has(recipe.id) || [plan.sourceId, plan.absentId].includes(recipe.id) ||
      !["thirdparty", "passwordless", "emailpassword", "webauthn"].includes(recipe.recipeId as string) ||
      typeof recipe.verified !== "boolean" || !Array.isArray(recipe.tenantIds) || !isDeepStrictEqual(recipe.tenantIds, [plan.tenantId]) ||
      typeof recipe.timeJoined !== "number" || !Number.isFinite(recipe.timeJoined) || recipe.timeJoined < 0 ||
      (recipe.email !== undefined && !text(recipe.email)) || (recipe.phoneNumber !== undefined && !text(recipe.phoneNumber)) ||
      (recipe.recipeId === "passwordless" && !text(recipe.email) && !text(recipe.phoneNumber)) ||
      (recipe.recipeId === "emailpassword" && !text(recipe.email)) ||
      (recipe.recipeId === "thirdparty" && (!isRecord(recipe.thirdParty) || !text(recipe.thirdParty.id) || !text(recipe.thirdParty.userId))) ||
      (recipe.recipeId !== "thirdparty" && recipe.thirdParty !== undefined) || (recipe.webauthn !== undefined && !isRecord(recipe.webauthn))) invalid();
    recipes.set(recipe.id, recipe as JsonRecord);
    if (text(recipe.email)) emails.add(recipe.email);
  }
  if (!recipes.has(plan.target) || ![...recipes.values()].some((recipe) => recipe.verified === true &&
    typeof recipe.email === "string" && recipe.email.toLowerCase() === profile.data.email!.toLowerCase())) invalid();
  const providerMatches = (source: RowndUser) => ["google", "apple"].some((provider) => {
    const subject = resolveRowndProviderSubject(source, provider);
    return subject !== undefined && [...recipes.values()].some((recipe) => isRecord(recipe.thirdParty) && recipe.thirdParty.id === provider && recipe.thirdParty.userId === subject);
  });
  if (!providerMatches(profile)) invalid();
  const aliases = new Map<string, string>();
  for (const alias of evidence.aliases) {
    if (!Array.isArray(alias) || alias.length !== 2 || !alias.every(text) || aliases.has(alias[0]!) || recipes.has(alias[0]!) ||
      [plan.sourceId, plan.absentId].includes(alias[0]!) || !recipes.has(alias[1]!) || [...aliases.values()].includes(alias[1]!)) invalid();
    aliases.set(alias[0]!, alias[1]!);
  }
  const literals = new Set([plan.sourceId, plan.absentId, ...recipes.keys(), ...aliases.keys()]);
  if (!sameSet(Object.keys(evidence.metadata), literals) || Object.values(evidence.metadata).some((record) => !isRecord(record) || record[orphanCheckpointKey] !== undefined) ||
    !sameSet(Object.keys(evidence.profiles), new Set(aliases.keys()))) invalid();
  for (const [id, aliasProfile] of Object.entries(evidence.profiles)) {
    if (!isRecord(aliasProfile) || !isRecord(aliasProfile.data) || aliasProfile.data.user_id !== id || aliasProfile.state !== "enabled" ||
      !providerMatches(aliasProfile as RowndUser)) invalid();
  }
  const candidates = new Set([plan.sourceId, ...aliases.keys()]);
  if (!sameSet(evidence.election.map((candidate) => isRecord(candidate) && text(candidate.rownd_user_id) ? candidate.rownd_user_id : ""), candidates) || !candidates.has(plan.winner)) invalid();
  for (const candidate of evidence.election) {
    if (!isRecord(candidate) || candidate.supertokens_user_id !== aliases.get(candidate.rownd_user_id as string) ||
      (candidate.activity !== undefined && (typeof candidate.activity !== "string" || !Number.isFinite(Date.parse(candidate.activity))))) invalid();
  }
  const ranked = evidence.election.filter((candidate) => isRecord(candidate) && candidate.activity !== undefined) as JsonRecord[];
  const canonical = [...aliases].find(([, id]) => id === plan.target)?.[0];
  const latest = ranked.length ? Math.max(...ranked.map((candidate) => Date.parse(candidate.activity as string))) : undefined;
  const tied = ranked.filter((candidate) => Date.parse(candidate.activity as string) === latest);
  const elected = evidence.election.length === 1 ? plan.sourceId : tied.length === 1 ? tied[0]!.rownd_user_id :
    tied.length ? tied.find((candidate) => candidate.rownd_user_id === canonical)?.rownd_user_id : canonical;
  if (elected !== plan.winner) invalid();
  const identityKeys = (source: RowndUser) => [
    ...(typeof source.data.email === "string" ? [`email:${source.data.email.toLowerCase()}`] : []),
    ...["google", "apple"].flatMap((provider) => { const subject = resolveRowndProviderSubject(source, provider); return subject ? [`${provider}:${subject}`] : []; }),
  ];
  const aliasProfiles = Object.values(evidence.profiles);
  if (!identityKeys(profile).some((identity) => aliasProfiles.every((other) => identityKeys(other as RowndUser).includes(identity)))) invalid();
  for (const [id, record] of Object.entries(evidence.metadata)) {
    if (!isRecord(record)) invalid();
    if (record.rownd_migration_superseded !== undefined || record.rownd_migration_owner_consolidation !== undefined || record.rownd_migration_mapping_publication !== undefined ||
      (id === plan.sourceId && record.rownd_migration_canonical_target !== undefined) ||
      (record.rownd_migration_canonical_target !== undefined && record.rownd_migration_canonical_target !== plan.target) ||
      (record.rownd_migration_target !== undefined && record.rownd_migration_target !== plan.target && !(id === plan.sourceId && record.rownd_migration_target === plan.absentId))) invalid();
    const historical = record.original_rownd_user;
    if (historical !== undefined && (!isRecord(historical) || !isRecord(historical.data) || !candidates.has(historical.data.user_id as string))) invalid();
  }
  const mappingMatches = (mapping: unknown, id: string, alias: string | undefined) => {
    if (!isRecord(mapping)) return false;
    return alias === undefined ? mapping.status === "UNKNOWN_MAPPING_ERROR" : mapping.status === "OK" && mapping.superTokensUserId === id &&
      mapping.externalUserId === alias && (mapping.externalUserIdInfo === undefined || typeof mapping.externalUserIdInfo === "string");
  };
  if (evidence.mappings !== undefined || plan.absence !== undefined) {
    if (!Array.isArray(evidence.mappings) || !sameSet(evidence.mappings.map((entry) => isRecord(entry) && text(entry.id) ? entry.id : ""), new Set([...recipes.keys(), ...aliases.keys()]))) invalid();
    for (const entry of evidence.mappings) {
      if (!isRecord(entry) || typeof entry.id !== "string" ||
        !mappingMatches(entry.external, aliases.get(entry.id) ?? entry.id, aliases.has(entry.id) ? entry.id : undefined) ||
        !mappingMatches(entry.internal, entry.id, [...aliases].find(([, recipe]) => recipe === entry.id)?.[0])) invalid();
    }
    for (const [alias, recipe] of aliases) {
      const forward = evidence.mappings.find((entry) => isRecord(entry) && entry.id === alias);
      const reverse = evidence.mappings.find((entry) => isRecord(entry) && entry.id === recipe);
      if (!isRecord(forward) || !isRecord(reverse) || !isDeepStrictEqual(forward.external, reverse.internal)) invalid();
    }
  }
  const cells = new Map<string, boolean>();
  for (const cell of evidence.verifications) {
    if (!isRecord(cell) || !text(cell.id) || !text(cell.email) || !literals.has(cell.id) || !emails.has(cell.email) || typeof cell.verified !== "boolean") invalid();
    const cellKey = JSON.stringify([cell.id, cell.email]);
    if (cells.has(cellKey)) invalid();
    cells.set(cellKey, cell.verified);
  }
  if (cells.size !== literals.size * emails.size) invalid();
  for (const [id, recipe] of recipes) if (recipe.email !== undefined) {
    const address = [...aliases].find(([, mapped]) => mapped === id)?.[0] ?? id;
    if (cells.get(JSON.stringify([address, recipe.email])) !== recipe.verified) invalid();
  }
  if (plan.previousCheckpoint !== undefined) {
    const prior = validate(parse(plan.previousCheckpoint), true);
    if ((prior.phase === "HANDOFF" && plan.phase === "PREPARED") || !sameEarlierOrphanEvidence(prior, plan)) invalid();
  }
  return plan;
}

export function readOrphanCheckpoint(metadata: JsonRecord) {
  return metadata[orphanCheckpointKey] === undefined ? undefined : validate(metadata[orphanCheckpointKey]);
}
