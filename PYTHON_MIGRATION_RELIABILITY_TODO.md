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

## Unknown JWKS `kid` Hardening

- [x] Require a non-empty `kid` and `EdDSA` before network access.
- [x] Add a generation-aware single-flight miss refresh with a 5-second global cooldown.
- [x] Add a generation-bound 5-second, 256-entry negative cache that never blocks the first refresh permitted after cooldown.
- [x] Require `aud`, `exp`, and `iat`; validate `nbf` when present and trusted discovery `issuer` only when published.
- [x] Verify known-key signatures before authenticated app-config requests while retaining required audience validation.
- [x] Validate temporal claims before app-config access and cache trusted app IDs for 5 minutes with generation tracking and single-flight refresh.
- [x] Replay typed app-ID refresh failures for 5 seconds without serving expired app IDs stale.
- [x] Back off failed cold-cache and expired-cache refreshes, atomically publish completion state, preserve known-good keys, and apply a practical 10-second total discovery/JWKS timeout.
- [x] Emit sampled redacted JWKS diagnostics through a globally rate-limited registry isolated from terminal telemetry; cancellation-resistant deliveries retain one of four slots until termination.
- [x] Cover cached, rotated, unknown, concurrent, cooldown, prepublication, outage, deadline, signature amplification, claims, issuer, diagnostics, and discovery behavior.

Completed in the working tree for Point 3 of `PYTHON_PLUGIN_CUSTOMER_REPORT_REMEDIATION_PLAN.md`.

Verification on 2026-09-05 using Python 3.9.25:

- `uv run pytest tests/test_rownd_repository.py`: 73 passed.
- `uv run pytest --ignore=tests/test_integration.py`: 555 passed.
- Full pytest was not repeated for the final isolated app-ID backoff change. The immediately preceding full runs produced 687 passes and 11 integration fixture setup errors, with no assertion failures, because RootlessKit could not bind occupied host ports `43018` and `43022`.
- `uv run ruff check .`: passed.
- `uv run pyright`: passed.
- `git diff --check`: passed.

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
- [x] Classify typed Rownd profile and app-config adapter failures without upstream leakage.

## Durable State Inspection

Reference Node.js commit: `f9d44eb` (`feat: Inspect durable migration state`).

- [x] Normalize Rownd identity data into an immutable source snapshot.
- [x] Validate the token subject against the Rownd profile user ID before Core access.
- [x] Retain only normalized, currently verified identities in the source snapshot.
- [x] Add fresh mapping, identity-owner, tenant, metadata, and canonical-email reads.
- [x] Select and pin the canonical target deterministically.
- [x] Classify complete, repairable, and blocked migration states.
- [x] Add source-validation, mapping-conflict, collision, ambiguity, and metadata tests.
- [x] Keep source snapshots free of fingerprints and source versions; compare normalized snapshots directly.
- [x] Keep completion metadata to `rownd_migration_complete` and existing canonical-email/original-user fields; do not add v2 migration metadata.

Before enabling phase-3 mutations:

- [x] Require Rownd verification authority before treating `google_id` and `apple_id` as expected identities.
- [x] Keep `original_rownd_user.data.user_id` as protected historical targeting evidence; require fresh topology inspection and `rownd_migration_complete: true` before session creation.
- [x] Re-fetch and normalize the Rownd profile before phase-3 finalization, then compare the new snapshot directly with the attempt snapshot before writing completion metadata.

## Convergent Reconciliation

Reference Node.js commit: `36bfa04` (`feat: Converge concurrent Rownd migrations`).

- [x] Add the bounded inspect, repair, and final-verification loop.
- [x] Remove destructive migration rollback behavior.
- [x] Make an existing Rownd mapping the canonical repair anchor.
- [x] Reconcile verified Passwordless identities safely.
- [x] Repair mapped users whose verified Rownd email changed.
- [x] Delay migration-complete metadata until durable postconditions pass.
- [x] Recover from duplicate imports, linking races, mapping races, and uncertain mutation outcomes.
- [x] Keep session creation separate from durable migration completion.

Implemented by commit `6d6722c` (`feat: Converge concurrent Rownd migrations`).

## Incomplete Migration Reconciliation

- [x] Re-fetch and normalize Rownd source at every bounded repair iteration and immediately before each planned mutation.
- [x] Reclassify fresh durable mappings, users, identity owners, primary state, tenant membership, migration metadata, and canonical-email state as `COMPLETE`, `REPAIRABLE`, or `BLOCKED`.
- [x] Keep import, unforced mapping, primary conversion, identity creation, permitted linking, email verification, and final metadata publication ordered and convergent.
- [x] Clear caches and use fresh durable postconditions after errors or uncertain mutation results; never roll back sibling-created state.
- [x] Discard identity-derived target pins when normalized source changes, while allowing an exact durable mapping to become canonical on reclassification.
- [x] Reset all source-scoped target, blocker, path, capability, error, recovery, unresolved-mutation, and mapping-retry state through one source-epoch transition path.
- [x] Return `ROWND_USER_NOT_FOUND`/401 when a fresh profile disappears at attempt, completion, final, mutation, or session boundaries.
- [x] Perform one final fresh classification after the two-iteration online budget and preserve a specific blocker where available.
- [x] Emit only a safely allowlisted unresolved mutation category from a final fresh `REPAIRABLE` disposition; unknown future mutation types cannot alter the migration error.
- [x] Keep completion metadata last and session creation after durable completion so session retries do not repeat account repair mutations.
- [x] Complete app-variant publication and asynchronous claim preparation before the final Rownd source comparison; restart bounded classification instead of issuing a stale session when preparation races a source change.
- [x] Derive unresolved telemetry from only the first planned mutation and omit it when that first type is not allowlisted.
- [ ] Expose the shared read-only account diagnostic command for Points 2, 4, and 5.

Point 5 online reconciliation is complete in the working tree. Mapping capability and cross-tenant limitations remain unchanged: no broad force, destructive rollback, cross-tenant enumeration/association, or unsafe ownership inference was added.

Verification on 2026-09-05 using Python 3.9.25:

- `uv run pytest tests/test_migration.py tests/test_migration_contract.py`: 237 passed.
- `uv run pytest --ignore=tests/test_integration.py`: 616 passed.
- `uv run pytest`: 752 passed in 166.57 seconds with Docker-backed integration tests.
- `uv run ruff check .`: passed.
- `uv run pyright`: passed with 0 errors and 0 warnings.
- `git diff --check`: passed.

## Mapping Safety

Reference Node.js commit: `ec277cf` (`feat: Guard forced migration mapping`).

- [x] Add fresh, two-direction mapping and ownership preflight checks.
- [x] Verify mapping symmetry after creation or uncertain outcomes.
- [x] Never use broad `force=True` as a fallback.
- [ ] Return `CORE_CAPABILITY_REQUIRED` when the narrow atomic Core capability is unavailable (blocked until the Python SDK exposes the exact Core result and narrow operation).
- [x] Add tests proving conflicts, collisions, and generic Core errors never force mapping.

## Different-User Login Methods

- [x] Select mapping, safe raw ID, unique verified third-party owner, unique verified Passwordless owner, or fresh import in order.
- [x] Reject unrelated owner ambiguity, foreign mappings/metadata, and primary-account merges with stable permanent reasons.
- [x] Re-fetch Rownd source, ownership, target mapping authority, and tenant membership immediately around linking.
- [x] Fail closed without mutation when a discovered method lacks request-tenant membership.
- [x] Accept a sibling link only after fresh exact identity, tenant, target-authority, and final-owner checks.
- [x] Add redacted identity-type and target-source context to terminal migration telemetry without changing public errors.
- [ ] Classify affected accounts through a read-only command (shared points 2/4/5 diagnostic remains unimplemented).
- [ ] Reconcile eligible cross-tenant standalone owners (unsafe without discoverability and an atomic association/link operation).

Point 4 is partial. Point 2's unavailable narrow Core mapping capability remains blocked; this work neither broadens force behavior nor adds a workaround.

## Telemetry

Reference Node.js commit: `2e9c702` (`feat: Add migration telemetry taxonomy`).

- [x] Construct exactly one terminal migration event and attempt one submission per request; delivery may be dropped at bounded capacity.
- [x] Record stable outcome, reason, stage, path, attempt count, target source when available, and forced-mapping state.
- [x] Remove raw identifiers, token data, upstream bodies, URLs, stacks, and exception messages from migration telemetry.
- [x] Track application-loop migration telemetry delivery in one process-wide bounded task registry without awaiting it on the request path.
- [x] Add privacy, cardinality, cancellation, bounded-capacity, and failure-isolation regression tests for the configured telemetry client contract.

## Email Topology

Reference Node.js commit: `f8e4ded` (`fix: Authorize canonical email topology`).

- [x] Permit a verified canonical Passwordless method beside retained unverified noncanonical methods.
- [x] Continue classifying old noncanonical methods as retired and blocking their authentication.
- [x] Verify migration-created canonical metadata satisfies guard mode.
- [x] Keep old methods during synchronous reconciliation; retire or remove them only through manual/asynchronous tooling.

Point 6 is complete in the working tree. Tenant-scoped canonical and migration-completion
metadata are published together and fresh-validated before completion. Passwordless session
cleanup and binding remain tracked separately under Final Hardening/Point 7.

Verification on 2026-09-05 using Python 3.9.25:

- `uv run pytest tests/test_mapping.py tests/test_overrides.py tests/test_migration.py -q`: 464 passed.
- `uv run pytest --ignore=tests/test_integration.py -q`: 625 passed.
- `uv run pytest -q`: 761 passed with Docker-backed integration tests.
- `uv run ruff check .`: passed.
- `uv run pyright`: passed with 0 errors and 0 warnings.
- `git diff --check`: passed.

## Final Hardening

Reference Node.js commit: `55d7643` (`fix: Harden Rownd migration reliability`).

- [x] Fetch fresh Rownd profiles without per-user caching at every migration repair iteration and mutation boundary.
- [x] Add bounded app-config/profile request deadlines, streamed response limits, and redirect rejection.
- [ ] Add explicit Rownd API base URL validation.
- [x] Map profile 404 to `ROWND_USER_NOT_FOUND`/401.
- [x] Map invalid server credentials to `PLUGIN_CONFIGURATION_INVALID`.
- [x] Map Rownd 408, rate limits, 5xx responses, network errors, and timeouts to `ROWND_UNAVAILABLE`.
- [ ] Clean up sessions and response credentials after rejected Passwordless authentication.
- [ ] Add the read-only migration diagnostic command.
- [ ] Run shared Node.js/Python behavioral scenarios and full package verification.

## Parity Decisions

- Follow Node.js final behavior for missing Rownd profiles: return `ROWND_USER_NOT_FOUND`/401 instead of a successful no-op.
- Follow Node.js fail-closed mapping behavior: do not use broad boolean force while the narrow atomic Core capability is unavailable.
- Treat the Node.js final implementation as the behavior reference where older plans disagree.

## Point 4 Verification

Verification on 2026-09-05 using Python 3.9.25:

- `uv run pytest tests/test_migration.py tests/test_migration_contract.py`: 191 passed.
- `uv run pytest --ignore=tests/test_integration.py`: 570 passed.
- `uv run pytest`: 706 passed.
- `uv run ruff check .`: passed.
- `uv run pyright`: passed.
- `git diff --check`: passed.
