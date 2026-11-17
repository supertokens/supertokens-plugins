import { RowndMigrationPolicyError } from "./errors";
import { hasReconciliationReads } from "./reconciliation-reads";
import {
  assertAuthenticatedMigrationSource,
  assertRowndSourcePayload,
  isAdministrativeMigration,
  isRowndMigrationProfileActive,
} from "./migration-email";
import { isSuperTokensFakeEmail } from "./rownd-compatibility";
import { fetchOptionalRowndUserInfo } from "./rownd-repository";
import { resolveRowndProviderSubject } from "./provider-identity";
import { isVerifiedPhoneSurvivor, type VerifiedPhoneSurvivor } from "./migration-phone-election";
import { matchesInstantPrimaryProof, type InstantPrimaryProof } from "./migration-instant-election";
import type { RowndUser, SuperTokensUserImport } from "./types";

export type ActivityCandidate = {
  rownd_user_id: string;
  supertokens_user_id?: string;
  activity?: string;
};
export type AdministrativeElectionOptions = {
  canonicalRowndId?: string;
  contactEmail?: string;
  verifiedPhoneSurvivor?: VerifiedPhoneSurvivor;
  instantPrimaryProof?: InstantPrimaryProof;
};
export class AmbiguousAdministrativeElection extends Error {
  constructor(readonly candidates: ActivityCandidate[]) {
    super(
      "Rownd activity does not establish a unique owner of the shared current identity",
    );
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
  const valid = [profile.meta?.last_sign_in, profile.meta?.last_active].flatMap(
    (value) => {
      if (typeof value !== "string") return [];
      const match =
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
          value,
        );
      if (!match || match[3] === "-00:00") return [];
      const calendar = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
      const local = Date.parse(calendar);
      if (!Number.isFinite(local) || new Date(local).toISOString() !== calendar)
        return [];
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) && timestamp <= now ? [timestamp] : [];
    },
  );
  return valid.length ? new Date(Math.max(...valid)).toISOString() : undefined;
}

function fingerprint(profile: RowndUser) {
  return JSON.stringify([
    identityKeys(profile),
    profile.data.phone_number,
    profile.verified_data?.phone_number,
    profile.meta?.last_sign_in,
    profile.meta?.last_active,
  ]);
}

// Only candidates with a valid activity compete for the newest sign-in. Sources
// without one cannot rank, but remain candidates so their evidence, fingerprints
// and owner callbacks are still checked on every fresh look.
function activityWinner(
  observed: ActivityCandidate[],
  canonicalRowndId?: string,
) {
  // An unopposed source keeps its legacy ability to migrate even without any
  // reliable timestamp. Ambiguity and canonical preference only apply when
  // multiple sources actually compete.
  if (observed.length === 1) return observed[0];
  const ranked = observed.filter(
    (candidate) => candidate.activity !== undefined,
  );
  if (ranked.length > 0) {
    const latest = ranked.reduce(
      (maximum, candidate) =>
        candidate.activity! > maximum ? candidate.activity! : maximum,
      ranked[0]!.activity!,
    );
    const tied = ranked.filter((candidate) => candidate.activity === latest);
    if (tied.length === 1) return tied[0];
    return tied.find(
      (candidate) => candidate.rownd_user_id === canonicalRowndId,
    );
  }
  return observed.find(
    (candidate) => candidate.rownd_user_id === canonicalRowndId,
  );
}

export async function inspectAdministrativeElection(
  candidates: ActivityCandidate[],
  options: AdministrativeElectionOptions = {},
) {
  if (
    candidates.length === 0 ||
    candidates.some((candidate) =>
      candidates.some(
        (other) =>
          other.rownd_user_id === candidate.rownd_user_id &&
          other.supertokens_user_id !== candidate.supertokens_user_id,
      ),
    )
  ) {
    throw new AmbiguousAdministrativeElection(candidates);
  }
  const unique = [
    ...new Map(
      candidates.map((candidate) => [candidate.rownd_user_id, candidate]),
    ).values(),
  ].sort((a, b) => a.rownd_user_id.localeCompare(b.rownd_user_id));
  const profiles = await Promise.all(
    unique.map(async (candidate) => {
      const profile = await fetchOptionalRowndUserInfo(candidate.rownd_user_id);
      if (!profile)
        throw new RowndMigrationPolicyError(
          "Rownd election source disappeared",
        );
      assertRowndSourcePayload(profile);
      if (
        profile.data.user_id !== candidate.rownd_user_id ||
        !isRowndMigrationProfileActive(profile)
      ) {
        throw new RowndMigrationPolicyError("Rownd election source changed");
      }
      if (
        options.contactEmail !== undefined &&
        profile.data.email?.toLowerCase() !== options.contactEmail
      ) {
        throw new RowndMigrationPolicyError(
          "Rownd email discovery source changed",
        );
      }
      return profile;
    }),
  );
  const now = Date.now();
  const observed = unique.map((candidate, index) => ({
    ...candidate,
    activity: activity(profiles[index]!, now),
  }));
  const shared = identityKeys(profiles[0]!).filter((key) =>
    profiles.every((profile) => identityKeys(profile).includes(key)),
  );
  const phone = options.verifiedPhoneSurvivor;
  const phoneEvidence = unique.length > 1 && !shared.length && phone !== undefined &&
    isVerifiedPhoneSurvivor(phone) &&
    phone.phoneNumber.length > 0 &&
    unique.some((candidate) => candidate.supertokens_user_id === phone.supertokensUserId) &&
    unique.every((candidate) => candidate.supertokens_user_id === undefined ||
      candidate.supertokens_user_id === phone.supertokensUserId) &&
    profiles.every((profile) => profile.data.phone_number === phone.phoneNumber &&
      profile.verified_data?.phone_number === phone.phoneNumber);
  const instantEvidence = matchesInstantPrimaryProof(options.instantPrimaryProof, profiles);
  if (unique.length > 1 && !shared.length && !phoneEvidence && !instantEvidence)
    throw new AmbiguousAdministrativeElection(observed);
  const winner = activityWinner(instantEvidence ? observed.filter((candidate) => candidate.rownd_user_id !== options.instantPrimaryProof!.instantAlias) : observed, options.canonicalRowndId);
  if (!winner) throw new AmbiguousAdministrativeElection(observed);
  return {
    winner,
    candidates: observed,
    fingerprints: profiles.map(fingerprint),
    canonicalRowndId: options.canonicalRowndId,
    ...(phoneEvidence ? { verifiedPhoneSurvivor: phone } : {}),
    ...(instantEvidence ? { instantPrimaryProof: options.instantPrimaryProof } : {}),
    ...(options.contactEmail !== undefined
      ? { contactEmail: options.contactEmail }
      : {}),
  };
}

type Election = Awaited<ReturnType<typeof inspectAdministrativeElection>>;
const elections = new WeakMap<
  SuperTokensUserImport,
  { election: Election; assertOwners: () => Promise<void> }
>();

export function bindAdministrativeElection(
  source: SuperTokensUserImport,
  tenantId: string,
  election: Election,
  assertOwners: () => Promise<void>,
) {
  if (
    !isAdministrativeMigration(source, tenantId) ||
    source.externalUserId !== election.winner.rownd_user_id
  ) {
    throw new RowndMigrationPolicyError(
      "Administrative election binding is invalid",
    );
  }
  // Single-candidate winners are bound too: an ownerless winner can later become a
  // native survivor, and that transition must still be revalidated before writes.
  elections.set(source, { election, assertOwners });
}

export function isAdministrativeElectionCandidate(
  source: SuperTokensUserImport | undefined,
  rowndId: string,
) {
  return (
    source !== undefined &&
    elections
      .get(source)
      ?.election.candidates.some(
        (candidate) => candidate.rownd_user_id === rowndId,
      ) === true
  );
}

export function sharesAdministrativeElectionPhone(
  source: SuperTokensUserImport,
  left: RowndUser,
  right: RowndUser,
) {
  const election = elections.get(source)?.election;
  const phone = election?.verifiedPhoneSurvivor?.phoneNumber;
  return phone !== undefined && [left, right].every((profile) =>
    election!.candidates.some((candidate) => candidate.rownd_user_id === profile.data.user_id) &&
    profile.data.phone_number === phone && profile.verified_data?.phone_number === phone,
  );
}

export function sharesAdministrativeInstantPrimary(source: SuperTokensUserImport, left: RowndUser, right: RowndUser) {
  return matchesInstantPrimaryProof(elections.get(source)?.election.instantPrimaryProof, [left, right]);
}

export function assertAdministrativeInstantProfiles(source: SuperTokensUserImport, profiles: RowndUser[]) {
  const proof = elections.get(source)?.election.instantPrimaryProof;
  if (proof && !matchesInstantPrimaryProof(proof, profiles))
    throw new RowndMigrationPolicyError("Instant primary source evidence changed before completion");
}

export function hasAdministrativeInstantProof(source: SuperTokensUserImport) {
  return elections.get(source)?.election.instantPrimaryProof !== undefined;
}

export async function assertAdministrativeElection(
  source: SuperTokensUserImport,
) {
  const previous = elections.get(source);
  if (!previous) return;
  // Reconciliation already elected and validated owners during discovery. Its
  // executor checks affected state; rerunning election here recursively rediscovers it.
  if (hasReconciliationReads()) return;
  try {
    await previous.assertOwners();
    const fresh = await inspectAdministrativeElection(
      previous.election.candidates,
      {
        canonicalRowndId: previous.election.canonicalRowndId,
        contactEmail: previous.election.contactEmail,
        verifiedPhoneSurvivor: previous.election.verifiedPhoneSurvivor,
        instantPrimaryProof: previous.election.instantPrimaryProof,
      },
    );
    if (
      fresh.winner.rownd_user_id === source.externalUserId &&
      JSON.stringify(fresh.fingerprints) ===
        JSON.stringify(previous.election.fingerprints)
    )
      return;
  } catch (error) {
    if (
      !(error instanceof AmbiguousAdministrativeElection) &&
      !(error instanceof RowndMigrationPolicyError)
    )
      throw error;
  }
  throw new RowndMigrationPolicyError(
    "Rownd activity election changed before reconciliation completion",
  );
}

export async function assertAdministrativeDuplicateWinner(
  source: SuperTokensUserImport,
  tenantId: string,
  duplicateId: string,
) {
  if (!isAdministrativeMigration(source, tenantId)) return;
  await assertAuthenticatedMigrationSource(source, tenantId);
  if (isAdministrativeElectionCandidate(source, duplicateId)) return;
  const election = await inspectAdministrativeElection([
    { rownd_user_id: source.externalUserId! },
    { rownd_user_id: duplicateId },
  ]);
  if (election.winner.rownd_user_id !== source.externalUserId)
    throw new RowndMigrationPolicyError(
      "A newer Rownd source owns the duplicate identity",
    );
}
