import { logDebugMessage } from "./logger";

export class SquadUpResponseValidationError extends Error {
  readonly actualType: string;

  constructor(
    readonly field: string,
    readonly expectedType: string,
    value: unknown,
  ) {
    super("Invalid SquadUp response field");
    this.actualType =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  }
}

export type SquadUpFailureStage =
  | "credential_resolution"
  | "email_lookup"
  | "upstream_request"
  | "upstream_http"
  | "response_json"
  | "response_validation"
  | "visibility_policy";

const transportCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function getTransportCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const cause = "cause" in error ? error.cause : undefined;
  for (const candidate of [error, cause]) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("code" in candidate)
    )
      continue;
    if (
      typeof candidate.code === "string" &&
      transportCodes.has(candidate.code)
    )
      return candidate.code;
  }
  return undefined;
}

export function logSquadUpFailure(
  input: {
    stage: SquadUpFailureStage;
    tenantId: string;
    durationMs: number;
    upstreamStatus?: number;
  },
  error: unknown,
): void {
  // Only schema paths, types and allowlisted codes are safe; exception messages may contain credentials or response values.
  const validation =
    error instanceof SquadUpResponseValidationError ? error : undefined;
  logDebugMessage(
    `SquadUp request failed ${JSON.stringify({
      ...input,
      transportCode:
        input.stage === "upstream_request"
          ? getTransportCode(error)
          : undefined,
      field: validation?.field,
      expectedType: validation?.expectedType,
      actualType: validation?.actualType,
    })}`,
  );
}
