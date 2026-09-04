# Python Migration Reliability Todo

## Completed

- [x] Add per-client JWKS caching with a bounded TTL.
- [x] Refresh discovery and JWKS once when a token uses an unknown `kid`.
- [x] Single-flight concurrent JWKS refreshes.
- [x] Preserve the last valid key set after failed refreshes.
- [x] Reject malformed or unsupported token headers before network requests.
- [x] Distinguish unknown keys, signature failures, malformed tokens, claims failures, and JWKS failures internally.
- [x] Add deterministic Ed25519 token, rotation, concurrency, failure-recovery, and TTL tests.

Implemented by commit `0355e45` (`fix: Refresh rotated Rownd signing keys`).

## Next: Stable Error Contract

Reference Node.js commit: `40c7107` (`feat: Add stable migration error contract`).

- [x] Add a typed `MigrationError` carrying reason, HTTP status, retryability, safe message, stage, and internal cause.
- [x] Return documented non-2xx statuses from both migration routes.
- [x] Require a strict `Bearer <token>` authorization header.
- [x] Map `TOKEN_KID_UNKNOWN` and `TOKEN_SIGNATURE_INVALID` to HTTP 401.
- [x] Map JWKS transport and malformed-response failures to retryable `ROWND_UNAVAILABLE`/503.
- [x] Classify expired and not-active tokens as `TOKEN_EXPIRED` and `TOKEN_NOT_ACTIVE`.
- [x] Return `INTERNAL_ERROR`/500 for unknown failures without exposing internal details.
- [x] Add equivalent response-contract tests for both migration routes.

## Durable State Inspection

Reference Node.js commit: `f9d44eb` (`feat: Inspect durable migration state`).

- [ ] Normalize Rownd identity data into an immutable source snapshot.
- [x] Validate the token subject against the Rownd profile user ID before Core access.
- [ ] Generate deterministic identity fingerprints compatible with Node.js.
- [ ] Add fresh mapping, identity-owner, tenant, metadata, and canonical-email reads.
- [ ] Select and pin the canonical target deterministically.
- [ ] Classify complete, repairable, and blocked migration states.
- [ ] Add source-validation, mapping-conflict, collision, ambiguity, and metadata tests.

## Convergent Reconciliation

Reference Node.js commit: `36bfa04` (`feat: Converge concurrent Rownd migrations`).

- [ ] Add the bounded inspect, repair, and final-verification loop.
- [ ] Remove destructive migration rollback behavior.
- [ ] Make an existing Rownd mapping the canonical repair anchor.
- [ ] Reconcile verified Passwordless identities safely.
- [ ] Repair mapped users whose verified Rownd email changed.
- [ ] Delay migration-complete metadata until durable postconditions pass.
- [ ] Recover from duplicate imports, linking races, mapping races, and uncertain mutation outcomes.
- [ ] Keep session creation separate from durable migration completion.

## Mapping Safety

Reference Node.js commit: `ec277cf` (`feat: Guard forced migration mapping`).

- [ ] Add fresh, two-direction mapping and ownership preflight checks.
- [ ] Verify mapping symmetry after creation or uncertain outcomes.
- [ ] Never use broad `force=True` as a fallback.
- [ ] Return `CORE_CAPABILITY_REQUIRED` when the narrow atomic Core capability is unavailable.
- [ ] Add tests proving conflicts, collisions, and generic Core errors never force mapping.

## Telemetry

Reference Node.js commit: `2e9c702` (`feat: Add migration telemetry taxonomy`).

- [ ] Emit exactly one terminal migration event.
- [ ] Record stable outcome, reason, stage, path, attempt count, target source, and forced-mapping state.
- [ ] Remove raw identifiers, token data, upstream bodies, URLs, stacks, and exception messages from telemetry.
- [ ] Keep telemetry failures non-blocking.
- [ ] Add privacy and terminal-event regression tests for each telemetry backend.

## Email Topology

Reference Node.js commit: `f8e4ded` (`fix: Authorize canonical email topology`).

- [ ] Permit a verified canonical Passwordless method beside retained unverified noncanonical methods.
- [ ] Continue classifying old noncanonical methods as retired and blocking their authentication.
- [ ] Verify migration-created canonical metadata satisfies guard mode.

## Final Hardening

Reference Node.js commit: `55d7643` (`fix: Harden Rownd migration reliability`).

- [ ] Fetch fresh Rownd profiles without per-user caching.
- [ ] Add bounded profile request timeouts, response limits, redirect rejection, and URL validation.
- [x] Map profile 404 to `ROWND_USER_NOT_FOUND`/401.
- [ ] Map invalid server credentials to `PLUGIN_CONFIGURATION_INVALID`.
- [ ] Map Rownd rate limits, 5xx responses, network errors, and timeouts to `ROWND_UNAVAILABLE`.
- [ ] Clean up sessions and response credentials after rejected Passwordless authentication.
- [ ] Add the read-only migration diagnostic command.
- [ ] Run shared Node.js/Python behavioral scenarios and full package verification.

## Parity Decisions

- Follow Node.js final behavior for missing Rownd profiles: return `ROWND_USER_NOT_FOUND`/401 instead of a successful no-op.
- Follow Node.js fail-closed mapping behavior: do not use broad boolean force while the narrow atomic Core capability is unavailable.
- Treat the Node.js final implementation as the behavior reference where older plans disagree.
