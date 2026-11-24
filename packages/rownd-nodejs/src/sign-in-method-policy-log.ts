import { createHash } from "node:crypto";

type Fields = {
  code: string;
  step: string;
  ownerId?: string;
  tenantId?: string;
  providerId?: string;
  count?: number;
};

export function logSignInMethodPolicy(level: "info" | "warn" | "error", event: string, fields: Fields) {
  const { ownerId, ...details } = fields;
  console[level](JSON.stringify({
    event,
    ...details,
    ...(ownerId ? { owner_hash: createHash("sha256").update(ownerId).digest("hex") } : {}),
  }));
}
