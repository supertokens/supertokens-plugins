import type { SquadUpPluginNormalisedConfig } from "./types";

type EmailEntry = { expiresAt: number; value: Promise<string | undefined> };

export function createEmailCache(
  policy: SquadUpPluginNormalisedConfig["emailCache"],
) {
  const emails = new Map<string, EmailEntry>();
  return (
    tenantId: string,
    userId: string,
    load: () => Promise<string | undefined>,
  ): Promise<string | undefined> => {
    if (!policy || policy.ttlMs === 0 || policy.maxEntries === 0) return load();
    const key = JSON.stringify([tenantId, userId]);
    const cached = emails.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      emails.delete(key);
      emails.set(key, cached);
      return cached.value;
    }
    emails.delete(key);
    while (emails.size >= policy.maxEntries) {
      const oldest = emails.keys().next().value;
      if (oldest !== undefined) emails.delete(oldest);
    }
    const entry: EmailEntry = { expiresAt: Infinity, value: load() };
    emails.set(key, entry);
    entry.value = entry.value.then(
      (email) => {
        entry.expiresAt = Date.now() + policy.ttlMs;
        return email;
      },
      (error) => {
        if (emails.get(key) === entry) emails.delete(key);
        throw error;
      },
    );
    return entry.value;
  };
}
