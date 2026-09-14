import type { ReconcileUserResult } from "../src/reconcile-user";
import type { Profile } from "./profiles";

const safeDiagnostics = new Set([
  "Duplicate owner consolidation blocked: a donor is not an eligible standalone owner",
  "Duplicate owner consolidation blocked: an owner has conflicting migration markers",
  "Duplicate owner consolidation blocked: an alias mapping changed",
  "Duplicate owner consolidation blocked: the checkpoint target changed",
  "Duplicate owner consolidation blocked: Core cannot promote the pinned winner",
  "Duplicate owner consolidation blocked: Core cannot link a donor to the pinned winner",
  "Duplicate owner consolidation blocked: linking would verify an unverified email",
  "Duplicate owner consolidation blocked: linking would verify an unverified email without exact source proof",
  "Duplicate owner consolidation blocked: the survivor alias has no vacant final linked recipe",
  "Duplicate owner consolidation blocked: a checkpoint source disappeared",
  "Duplicate owner consolidation blocked: Core cannot link a donor to the survivor",
  "Active sessions block owner consolidation",
  "CANONICAL_EMAIL_POLICY",
  "The survivor canonical mapping changed during election",
  "Rownd election owner changed",
  "Rownd activity election changed before reconciliation completion",
  "The SuperTokens selector belongs to a different canonical Rownd owner",
  "A newer Rownd source owns the duplicate identity",
  "Rownd election source disappeared",
  "Rownd election source changed",
  "Rownd activity does not establish a unique owner of the shared current identity",
  "The reconciliation target changed",
  "Failed to map migrated Rownd user ID: the reconciliation target changed",
  "The reconciliation target changed during final observation",
  "The reconciliation target changed before email verification",
  "The canonical reconciliation target changed",
  "Migrated user mapping postcondition failed",
  "Reconciled user disappeared during final observation",
  "Reconciled user could not be resolved",
  "Live Rownd user not found",
  "No Rownd source mapping or metadata found in SuperTokens",
  "No existing SuperTokens email owner found; use a Rownd user ID to import a user",
  "ROWND_EMAIL_SEARCH_UNSUPPORTED: configure an app-scoped Rownd email search client",
  "ROWND_EMAIL_LOOKUP_NO_MATCH: no enabled exact-email source found through verified-value lookup; use a Rownd user ID for other profiles",
  "ROWND_EMAIL_SEARCH_INVALID_RESPONSE",
  "ROWND_EMAIL_SEARCH_CHANGED: retry discovery",
  "ROWND_EMAIL_SEARCH_INCOMPLETE: pagination did not advance",
  "ROWND_EMAIL_SEARCH_INCOMPLETE: pagination limit reached",
  "Rownd email discovery source disappeared; retry discovery",
  "Rownd email discovery source changed",
  "SOURCE_ID_MISMATCH: email discovery returned another Rownd user",
  "Rownd administrative lookup request failed",
  "Invalid Rownd administrative lookup response",
  "Invalid Rownd administrative lookup scope",
  "Invalid Rownd email lookup value",
  "Administrative metadata backfill is incomplete",
  "Rownd source is not the requested enabled user",
  "Rownd source identity changed before migration completion",
  "Rownd verified email proof changed before reconciliation completion",
  "The requested Rownd user has been superseded",
  "Missing mapping cannot be restored without matching live identity and migration provenance",
  "Administrative contact election requires a current Rownd email identity",
  "Authenticated Rownd contact cannot elect an unrelated primary account",
  "Current Rownd email verification is blocked by canonical policy",
  "Current Rownd methods remain missing or blocked by canonical policy",
  "Contradictory historical snapshots cannot authorize mapping restoration",
  "Pinned reconciliation owner disappeared during final observation",
  "EXTERNAL_ALIAS_AMBIGUOUS: selector identifies different internal and external owners",
  "MAPPING_TARGET_MISSING: external mapping target does not exist",
  "MAPPING_TARGET_MISSING: reconciliation target does not exist",
  "OWNER_MEMBERSHIP_INCONSISTENT: invalid primary or tenant membership",
  "OWNER_MEMBERSHIP_INCONSISTENT: recipe owner could not be confirmed",
  "PROVIDER_IDENTITY_SPLIT: exact login identity has multiple owners",
]);

function safeDiagnostic(message: string | undefined) {
  return message && (safeDiagnostics.has(message) ||
    /^Rownd administrative lookup failed \(HTTP [1-5]\d{2}\)$/.test(message) ||
    /^SOURCE_PAYLOAD_INVALID: (?:(?:data|verified_data)(?:\.(?:user_id|email|phone_number|google_id|apple_id))?)(?:, (?:data|verified_data)(?:\.(?:user_id|email|phone_number|google_id|apple_id))?)*$/.test(message) ||
    /^Migrated login method postcondition failed: (?:missing_user|unexpected_owner|missing_method|missing_tenant|unverified_authenticated_email)$/.test(message)) ? message : undefined;
}

export function formatReconcileResult(result: ReconcileUserResult, profile: Profile) {
  const secrets = [profile.rownd.appKey, profile.rownd.appSecret, profile.supertokens.apiKey]
    .filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length);
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      for (const secret of secrets) {
        value = (value as string).split(secret).join("***").split(encodeURIComponent(secret)).join("***");
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
    return value;
  };
  // SDK/transport messages may contain whole requests, encoded headers or URLs.
  // Only authored, allowlisted diagnostics may survive transport-message filtering.
  const message = result.status === "OK" || result.status === "PREVIEW" ? undefined : safeDiagnostic(result.message) ?? {
    NOT_FOUND: "No matching user or Rownd source found",
    AMBIGUOUS: "Multiple Rownd sources found; select an explicit Rownd user ID",
    BLOCKED: "Reconciliation blocked by identity, ownership, canonical policy or source consistency checks",
    ERROR: "Reconciliation failed; check profile configuration and service availability",
  }[result.status];
  const observationError = "observationError" in result && result.observationError !== undefined
    ? safeDiagnostic(result.observationError) ?? "Final state could not be observed" : undefined;
  return JSON.stringify(redact({ ...result, message, observationError }), null, 2);
}
