import { createHash } from "node:crypto";

type Fields = {
  code: string;
  step: string;
  ownerId?: string;
  tenantId?: string;
  providerId?: string;
  count?: number;
};

export function signInMethodPolicyFailureLevel(code: string): "warn" | "error" {
  switch (code) {
  case "DISCONNECT_OWNER_CHANGED":
  case "DISCONNECT_POLICY_INVALID":
  case "SIGN_IN_METHOD_OPERATION_INCOMPLETE":
    return "error";
  default:
    return "warn";
  }
}

export function logSignInMethodPolicy(level: "info" | "warn" | "error", event: string, fields: Fields) {
  const { ownerId, ...details } = fields;
  console[level](JSON.stringify({
    event,
    ...details,
    ...(ownerId ? { owner_hash: createHash("sha256").update(ownerId).digest("hex") } : {}),
  }));
}
