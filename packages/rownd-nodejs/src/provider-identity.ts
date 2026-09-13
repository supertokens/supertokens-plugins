import type { RowndUser } from "./types";

export function resolveRowndProviderSubject(user: RowndUser, provider: string) {
  const field = `${provider}_id`;
  const verified = user.verified_data?.[field];
  if (typeof verified === "string" && verified.trim()) return verified;
  const data = user.data[field];
  return typeof data === "string" && data.trim() ? data : undefined;
}
