import { RowndMigrationPolicyError } from "./errors";
import { assertAuthenticatedMigrationSource, assertRowndSourcePayload, isAdministrativeMigration, isRowndMigrationProfileActive } from "./migration-email";
import { isSuperTokensFakeEmail } from "./rownd-compatibility";
import { fetchOptionalRowndUserInfo } from "./rownd-repository";
import { resolveRowndProviderSubject } from "./provider-identity";
import type { RowndUser, SuperTokensUserImport } from "./types";

export type ActivityCandidate = { rownd_user_id: string; supertokens_user_id?: string; activity?: string };
export class AmbiguousAdministrativeElection extends Error {
  constructor(readonly candidates: ActivityCandidate[]) {
    super("Rownd activity does not establish a unique owner of the shared current identity");
  }
}

function identityKeys(profile: RowndUser) {
  const keys: string[] = [];
  const email = profile.data.email?.toLowerCase();
  if (email && !isSuperTokensFakeEmail(email)) keys.push(`email:${email}`);
  for (const provider of ["google", "apple"] as const) {
    const subject = resolveRowndProviderSubject(profile, provider);
    if (subject) keys.push(`${provider}:${subject}`);
  }
  return keys;
}

function activity(profile: RowndUser, now: number) {
  const valid = [profile.meta?.last_sign_in, profile.meta?.last_active].flatMap((value) => {
    if (typeof value !== "string") return [];
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    if (!match || match[3] === "-00:00") return [];
    const calendar = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
    const local = Date.parse(calendar);
    if (!Number.isFinite(local) || new Date(local).toISOString() !== calendar) return [];
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp <= now ? [timestamp] : [];
  });
  return valid.length ? new Date(Math.max(...valid)).toISOString() : undefined;
}

function fingerprint(profile: RowndUser) {
  return JSON.stringify([identityKeys(profile), profile.meta?.last_sign_in, profile.meta?.last_active]);
}

export async function inspectAdministrativeElection(candidates: ActivityCandidate[]) {
  if (candidates.length === 0 || candidates.some((candidate) => candidates.some((other) =>
    other.rownd_user_id === candidate.rownd_user_id && other.supertokens_user_id !== candidate.supertokens_user_id))) {
    throw new AmbiguousAdministrativeElection(candidates);
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.rownd_user_id, candidate])).values()]
    .sort((a, b) => a.rownd_user_id.localeCompare(b.rownd_user_id));
  const profiles = await Promise.all(unique.map(async (candidate) => {
    const profile = await fetchOptionalRowndUserInfo(candidate.rownd_user_id);
    if (!profile) throw new RowndMigrationPolicyError("Rownd election source disappeared");
    assertRowndSourcePayload(profile);
    if (profile.data.user_id !== candidate.rownd_user_id || !isRowndMigrationProfileActive(profile)) {
      throw new RowndMigrationPolicyError("Rownd election source changed");
    }
    return profile;
  }));
  const now = Date.now();
  const observed = unique.map((candidate, index) => ({ ...candidate, activity: activity(profiles[index]!, now) }));
  const shared = identityKeys(profiles[0]!).filter((key) => profiles.every((profile) => identityKeys(profile).includes(key)));
  const ranked = [...observed].sort((a, b) => (b.activity ?? "").localeCompare(a.activity ?? ""));
  if (unique.length > 1 && (!shared.length || observed.some((candidate) => candidate.activity === undefined) || ranked[0]!.activity === ranked[1]!.activity)) {
    throw new AmbiguousAdministrativeElection(observed);
  }
  return { winner: ranked[0]!, candidates: observed, fingerprints: profiles.map(fingerprint) };
}

type Election = Awaited<ReturnType<typeof inspectAdministrativeElection>>;
const elections = new WeakMap<SuperTokensUserImport, { election: Election; assertOwners: () => Promise<void> }>();

export function bindAdministrativeElection(source: SuperTokensUserImport, tenantId: string, election: Election, assertOwners: () => Promise<void>) {
  if (!isAdministrativeMigration(source, tenantId) || source.externalUserId !== election.winner.rownd_user_id) {
    throw new RowndMigrationPolicyError("Administrative election binding is invalid");
  }
  if (election.candidates.length > 1) elections.set(source, { election, assertOwners });
}

export function isAdministrativeElectionCandidate(source: SuperTokensUserImport | undefined, rowndId: string) {
  return source !== undefined && elections.get(source)?.election.candidates.some((candidate) => candidate.rownd_user_id === rowndId) === true;
}

export async function assertAdministrativeElection(source: SuperTokensUserImport) {
  const previous = elections.get(source);
  if (!previous) return;
  try {
    await previous.assertOwners();
    const fresh = await inspectAdministrativeElection(previous.election.candidates);
    if (fresh.winner.rownd_user_id === source.externalUserId && JSON.stringify(fresh.fingerprints) === JSON.stringify(previous.election.fingerprints)) return;
  } catch (error) {
    if (!(error instanceof AmbiguousAdministrativeElection) && !(error instanceof RowndMigrationPolicyError)) throw error;
  }
  throw new RowndMigrationPolicyError("Rownd activity election changed before reconciliation completion");
}

export async function assertAdministrativeDuplicateWinner(source: SuperTokensUserImport, tenantId: string, duplicateId: string) {
  if (!isAdministrativeMigration(source, tenantId)) return;
  await assertAuthenticatedMigrationSource(source, tenantId);
  const election = await inspectAdministrativeElection([{ rownd_user_id: source.externalUserId! }, { rownd_user_id: duplicateId }]);
  if (election.winner.rownd_user_id !== source.externalUserId) throw new RowndMigrationPolicyError("A newer Rownd source owns the duplicate identity");
}
