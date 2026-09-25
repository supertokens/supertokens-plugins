import type { RowndUser } from "./types";

export function normalizeOptionalRowndIdentities(profile: RowndUser): RowndUser {
  const normalized = structuredClone(profile);
  for (const container of [normalized.data, normalized.verified_data]) {
    if (!container || typeof container !== "object") continue;
    for (const field of ["email", "phone_number", "google_id", "apple_id"]) {
      if (container[field] === "" || container[field] === null) delete container[field];
    }
  }
  return normalized;
}

export function resolveRowndProviderSubject(user: RowndUser, provider: string) {
  const field = `${provider}_id`;
  const verified = user.verified_data?.[field];
  if (typeof verified === "string" && verified.trim()) return verified;
  const data = user.data[field];
  return typeof data === "string" && data.trim() ? data : undefined;
}
