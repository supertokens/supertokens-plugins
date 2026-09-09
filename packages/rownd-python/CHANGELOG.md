# @supertokens-plugins/rownd-python

## 0.2.2

### Patch Changes

- Improve errors

## 0.2.1

### Patch Changes

- Fix rownd token validation and additional migration bugs

## 0.2.0

### Minor Changes

- Fix migrate race conditions and port rownd-nodejs changes
- a9af441: Add an opt-in email credential retirement mode so operators can prevent authentication through previously replaced Passwordless email aliases while durable email-change completion remains unavailable without Core metadata compare-and-swap. Guard mode disables email-change start and completion, so pending changes must be drained and all workers upgraded before rollout. Direct SuperTokens SDK calls outside plugin-owned APIs remain out of scope.

### Patch Changes

- a5150ef: Report the current package version in plugin metadata

## Unreleased

### Patch Changes

- Classify verified Session/UserMetadata user-ID mapping rejections as `CORE_CAPABILITY_REQUIRED`
  (HTTP 503, `retryable: false`, `stage: "mapping"`), compatibility-tested with Python SDK
  0.31.3 and Core 12.0.10. No automatic reference repair, forced mapping, or session revocation
  is attempted to unblock mapping. Other errors retain existing handling; exact bidirectional
  mapping races still recover. Recognition is limited to the verified rejection formats.
- Return HTTP 400 with `reason: "UNKNOWN_APP_VARIANT"` for unknown app-config variants,
  preserving the existing message. Valid and omitted variants are unchanged.
- Document existing unreleased behavior: missing Rownd users return `ROWND_USER_NOT_FOUND`
  (HTTP 401, `retryable: false`) on both migration routes, replacing the old successful no-op.
- Recognize the verified Python SDK 0.31.3 HTTP 5xx exception envelope as retryable
  `CORE_UNAVAILABLE` (503) when reconciliation cannot establish completion; do not infer
  outages from arbitrary exception text or broaden Session/UserMetadata rejection matching.
- Bound Core bulk-import transport with 5-second operation/inactivity timeouts, a practical
  15-second total deadline, and a streamed 1 MiB response limit. Refuse non-identity
  compression before decoding and redact import error bodies. Clear request-local Core
  call caches on all exits; uncertain writes require fresh reconciliation, not blind
  transport retries. Duplicate recovery remains restricted to the verified E006 contract.
- Add optional validated `rownd_app_id` for audience and profile lookup, bypassing authenticated
  app-ID discovery only when configured. Omission retains cached discovery; configured-ID
  failures do not fall back. Token validation and namespaced app-user identity remain required.
- Route opt-in debug diagnostics through standard Python logging at INFO. Emit sanitized
  local migration terminal summaries independently of debug/telemetry settings (errors at
  WARNING, success/cancellation at INFO); omit exception details from guest/bypass failure
  logs and request values from unknown-variant warnings. Email-change rollback failures emit
  fixed reconciliation-required warnings without user IDs or exception text. Legacy guest
  telemetry is unchanged.
- Bind guard-mode Passwordless consume markers and returned sessions to the request tenant.
  Independently validate the result owner and session user ID against the checked owner
  through mapping-aware comparison. Deny invalid evidence; track the SDK's boolean targeted
  revocation and explicit response-clear queueing separately, never inferring clearing from
  mutator-list growth. A fresh read confirming an already-absent session avoids collateral
  logout. Fallback revocation remains scoped to linked accounts in the request
  tenant; uncleared queued mutators fail closed and cancellation propagates.
- Release integration reminder: both migration aliases use non-2xx errors, not successful
  no-ops. Clients must honor HTTP status, `reason`, and `retryable`; cancellation's 499 is
  telemetry-only, never a fabricated HTTP response. Test coverage is not production recovery
  approval. No browser/mobile client changes or end-to-end rotation proof are included;
  further investigation and release qualification are still required.
- Reject decoded token key IDs containing lone Unicode surrogates as `TOKEN_MALFORMED`
  (401) before network/cache work or sampled JWKS diagnostics, preventing encoding errors
  from becoming internal failures. Valid Unicode key IDs and cache policy are unchanged.
- Await terminal migration telemetry for up to 250 ms so cooperative delivery can finish before
  request-scoped loops close (including Django WSGI). Isolate client failures, preserve request
  cancellation, and retain timed-out deliveries in the admission cap until they exit without
  awaiting cancellation acknowledgement. Custom clients must not block the event loop or
  suppress cancellation during framework loop teardown. JWKS diagnostics are unchanged.
- Normalize verified provider IDs and phone numbers before online migration mapping so padded
  identities converge during new imports and missing-method repairs. Retain the original Rownd
  profile in metadata; offline mapping is unchanged.
- Accept legacy non-expiring Rownd tokens without `exp` on both migration routes. Continue
  verifying expiration when present and preserve signature, algorithm, issued-at, not-before,
  audience, discovery issuer, and Rownd user ID validation.
- Return retryable `ROWND_UNAVAILABLE` (503) on both migration routes when JWKS cooldown
  prevents checking a new signing key, rather than permanently rejecting a potentially valid
  rotated token. Preserve confirmed-unknown 401s, refresh limits, and negative caching.

- Recover verified standalone Passwordless email/phone identities left by interrupted
  create-before-link repairs when an exact mapping or non-raw pinned target resolves
  cross-identity ambiguity. Existing ownership and verification checks remain required.
- Return HTTP 422 instead of 409 for the six migration identity/state conflicts so native
  clients do not mistake blocked migrations for existing sessions. Reasons and
  `retryable: false` are unchanged; email-change conflicts remain HTTP 409.
- Rate-limit Rownd signing-key refreshes and diagnostics, verify signatures before authenticated
  lookups, and preserve cached keys during outages
- Recover simultaneous E006 passwordless email import races
- Ignore custom claims that conflict with JWT, SuperTokens, Rownd, or authoritative OAuth claims
- Reject malformed custom session claim names with their schema field path
- Allow verified canonical Passwordless emails in guard mode when retained noncanonical methods
  are unverified, while continuing to block those retired methods

## 0.1.13

### Patch Changes

- Pass context to prevent extra core calls

## 0.1.12

### Patch Changes

- Handle concurrent Rownd migrations

## 0.1.11

### Patch Changes

- Match email verification check against the node plugin
- Prevent concurrent migrations from misidentifying externalized user IDs or rolling back shared reconciliation state

## 0.1.10

### Patch Changes

- Fix account linking during migrate

## 0.1.9

### Patch Changes

- Fix fetch rownd user
- Preserve previous Passwordless emails as tenant-scoped login aliases and report pending email verification
- Refresh Rownd session claims after automatic linking during Passwordless and third-party sign-in
- Resolve compatibility metadata across linked identities and apply profile writes to the primary user

## 0.1.8

### Patch Changes

- Fix rownd token validation

## 0.1.7

### Patch Changes

- Fix migration and email verification

## 0.1.7

### Patch Changes

- Secure email changes, support third-party and phone-only accounts, and fix Rownd identity reconciliation
- Require `context.rowndNativeEmailVerification: true` for mobile email changes; unsupported clients receive HTTP 426
- Require custom verification delivery to preserve `token` and `rowndPendingVerificationId`

## 0.1.6

### Patch Changes

- Enforce limitations on cross device sign in

## 0.1.5

### Patch Changes

- Fix default account linking setup

## 0.1.4

### Patch Changes

- Include appVariantId in the session payload

## 0.1.3

### Patch Changes

- Handle tenant id and add OTP overrides

## 0.1.2

### Patch Changes

- Fix the OAuth flow for passwordless and handle users without email address

## 0.1.1

### Patch Changes

- Fix readme instructions
