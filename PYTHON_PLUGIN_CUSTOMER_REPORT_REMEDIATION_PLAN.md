# Python Plugin Customer Report Remediation Plan

## Status

- Target package: `packages/rownd-python`.
- Scope: changes that can be made in the `supertokens-rownd` plugin only.
- Report: Sandboxx production report dated 2026-09-02.
- Reference behavior: the Node.js Rownd plugin where it is compatible with the plugin-only constraint.
- Current baseline: commits `0355e45` through `95aab0c`, plus the uncommitted Point 5 remediation described below.

## Scope Boundary

This plan does not require changes to the Rownd service, SuperTokens Core, or the SuperTokens Python SDK. That constraint creates two hard limits:

1. The plugin cannot verify a Rownd token when its signing public key is genuinely absent from the freshly fetched JWKS.
2. The plugin cannot safely create a user-ID mapping when Core requires an atomic mapping capability that is not available through the current SDK/Core contract.

The plugin must handle those states deterministically where the current interfaces expose enough evidence, prevent retry storms, and provide enough diagnostics for remediation. An unforced mapping rejection can receive a plugin-owned permanent `MAPPING_REJECTED` reason without claiming to know why Core rejected it. The plugin must not bypass signature verification, parse a token as trusted data, use broad `force=True`, remove Core data temporarily, or guess between conflicting owners.

## Goals

1. Make every migration result observable from its HTTP response and stable reason.
2. Converge retries when the intended durable state already exists or can be repaired safely.
3. Stop automatic retries for permanent conflicts and unsupported states.
4. Preserve account ownership and Passwordless credential security during reconciliation.
5. Give support a read-only diagnostic for each affected account.
6. Keep all changes backward compatible with successful migration responses.
7. Verify the final account and session state after every mutation sequence.

## Non-Goals

- Accepting tokens without a valid signature.
- Changing Rownd key publication or retention policy.
- Fixing the customer's ordinary authenticated requests that do not pass through this plugin.
- Automatically merging two primary SuperTokens users.
- Re-pointing a conflicting user-ID mapping.
- Using broad forced mapping as a recovery mechanism.
- Deleting old Passwordless methods during synchronous migration.
- Direct database remediation.

## Required Invariants

Every successful migration response must satisfy these invariants after fresh reads:

1. The validated Rownd token subject matches the fetched Rownd profile user ID.
2. Exactly one canonical SuperTokens target is selected and remains pinned for the attempt.
3. The Rownd external ID either equals the canonical ID or maps to it symmetrically in both directions.
4. No expected identity or mapping belongs to another Rownd account.
5. Every reconciled identity is authorized by verified Rownd identity data.
6. Every required login method belongs to the canonical account and request tenant.
7. Canonical Passwordless metadata points to an existing verified method.
8. Completion metadata is written only after durable postconditions pass.
9. The newly issued session belongs to the verified user, recipe user, and tenant. Guard mode requires an SDK version that exposes all three session bindings.

## Point 1: HTTP Status And Stable Error Contract

### Problem

Migration failures previously returned HTTP 200 with a generic `Migration failed` body. Operators could not classify failures without scraping plugin logs, and access-log monitoring treated a total migration outage as success.

### Current Baseline

Commit `34161ff` introduced typed migration errors, non-2xx statuses, stable reasons, retryability, stages, and operation IDs. The successful body remains `{"status":"OK"}`.

### Implementation

1. Preserve the current public failure shape:

   ```json
   {
     "status": "ERROR",
     "code": 409,
     "reason": "MAPPING_CONFLICT",
     "message": "The Rownd identity is linked to another user",
     "retryable": false,
     "stage": "mapping",
     "operationId": "..."
   }
   ```

2. Use the same contract for `/plugin/rownd/migrate` and `/plugin/migrate-session`.
3. Keep `message` safe for users and logs. Never expose tokens, credentials, upstream bodies, stack traces, or exception text.
4. Add typed Rownd adapter errors for profile and app-config requests:
   - profile 404 -> `ROWND_USER_NOT_FOUND`, HTTP 401, not retryable;
   - a profile carrying the documented Rownd disabled-state value -> `ROWND_USER_DISABLED`, HTTP 401, not retryable;
   - rejected plugin credentials -> `PLUGIN_CONFIGURATION_INVALID`, HTTP 500, not retryable;
   - malformed profile -> `SOURCE_IDENTITY_INVALID`, HTTP 422, not retryable;
   - rate limit, timeout, network failure, or 5xx -> `ROWND_UNAVAILABLE`, HTTP 503, retryable.
5. Map unknown plugin exceptions to `INTERNAL_ERROR` without leaking the cause.
6. Emit exactly one terminal migration telemetry event. Include `operationId`, outcome, reason, stage, HTTP status, retryability, attempt count, target source, and migration path. Exclude raw user identifiers and exception details.
7. Make telemetry delivery best-effort with a bounded latency budget and ensure telemetry failures never alter the HTTP result.
8. Document that callers must branch on HTTP status and `reason`, not `message`.

Before implementing disabled-user classification, identify the authoritative field and value in the existing Rownd profile response contract. Do not infer disabled state from profile absence or malformed data.

### Tests

- Contract-test every `MigrationErrorReason`.
- Exercise both migration route aliases.
- Verify success remains HTTP 200 with the existing body.
- Verify every failure is non-2xx and contains the complete contract.
- Verify unknown exceptions are sanitized.
- Verify one terminal telemetry event for early failures, conflicts, recovered attempts, and success.
- Verify telemetry contains no user IDs, tokens, URLs, bodies, stack traces, or hostile exception messages.

### Acceptance Criteria

- No migration failure returns HTTP 200.
- Every failure has a stable reason and retryability value.
- The customer's wrapper can classify failures using only the response.
- Access-log error-rate alerts detect migration outages.

## Point 2: Existing Or Structurally Blocked User-ID Mapping

### Problem

Core can reject `/recipe/userid/map` with `UserId is already mapped`. The same account then retries indefinitely. The message can represent an exact mapping created by a previous or concurrent attempt, a real mapping conflict, or a mapping blocked by non-auth recipe references.

### Current Baseline

Commits `4f18700`, `6d6722c`, and `180c882` add durable mapping inspection, exact-mapping convergence, race recovery, and bidirectional preflight/postcondition checks. Production mapping writes use `force=False`.

### Implementation

1. Clear the SDK Core-call cache and read both mapping directions immediately before a write.
2. Classify the mapping state:
   - `EXACT`: both directions describe the intended internal/external pair;
   - `ABSENT`: neither direction exists;
   - `CONFLICT`: one or both directions describe another pair.
3. Treat `EXACT` as converged and continue migration without another mapping write.
4. Return `MAPPING_CONFLICT`, HTTP 409, `retryable:false` for `CONFLICT`. Do not mutate either mapping.
5. For `ABSENT`, perform exactly one unforced mapping transport call through the plugin-owned mapping adapter. The adapter may delegate to `create_user_id_mapping(..., force=False)` when the SDK preserves structured outcomes, or replace that SDK call with one bounded request to the existing Core endpoint. It must never perform both writes.
6. After any result or exception, clear caches and read both directions again. Treat an exact postcondition as success even when the call returned an error.
7. When an allowlisted structured Core mapping response rejects the unforced call and both mappings remain absent, return a new plugin-owned `MAPPING_REJECTED`, HTTP 409, `retryable:false`. This reason means only that Core deterministically rejected the unforced write; it does not claim that non-auth references were proven as the cause.
8. Preserve the Core outcome through the mapping adapter. It must distinguish successful and already-exists mapping statuses, documented mapping-rejection statuses, 401/403 configuration failures, 429 rate limits, 5xx responses, transport failures, and malformed responses. Only documented structured mapping-rejection statuses may become `MAPPING_REJECTED`.
9. If the SDK discards structured outcomes, the adapter may directly call this existing Core endpoint instead of the SDK. It must use the configured Core URI and API key, apply strict timeout and response-size limits, validate the JSON response shape, and never enable force.
10. Return `CORE_CAPABILITY_REQUIRED` only if a supported interface provides a structured non-auth-reference result. With the currently supported SDK contract, do not infer this reason from an English error message.
11. Map 401/403 to configuration failure and 429, 5xx, or transport failures to retryable `CORE_UNAVAILABLE`. Keep malformed, undocumented 4xx, or unrecognized outcomes as `INTERNAL_ERROR` rather than misclassifying them as permanent.
12. Remove any unreachable test-only narrow mapping callback from the production path, or clearly isolate it as future scaffolding. The current plugin must not imply that it can perform unavailable recovery.
13. Add a read-only diagnostic that reports mapping state, target selection, identity owners, raw-ID collision state, and final disposition.

### Prohibited Recovery

- Do not call `create_user_id_mapping(..., force=True)`.
- Do not revoke sessions or delete metadata merely to make an unforced mapping pass.
- Do not remove and recreate mappings.
- Do not write directly to Core storage.
- Do not treat an absent postcondition as success.

### Tests

- Exact pre-existing mapping is successful and performs no write.
- A sibling-created exact mapping is successful after a fresh postcondition read.
- Conflicting external mapping returns `MAPPING_CONFLICT` without mutation.
- Conflicting internal mapping returns `MAPPING_CONFLICT` without mutation.
- Raw-ID collision returns `RAW_USER_ID_COLLISION` without mutation.
- An allowlisted structured unforced Core rejection with absent postconditions returns `MAPPING_REJECTED` with `retryable:false`.
- Undocumented or malformed Core 4xx responses never become `MAPPING_REJECTED`.
- `CORE_CAPABILITY_REQUIRED` is returned only for a structured supported result, never from message matching.
- Generic Core 400, transport failure, and malformed result never authorize force or report success.
- Diagnostic output is deterministic, read-only, and redacted by default.

### Acceptance Criteria

- Retrying an already-complete mapping succeeds.
- Conflicting mappings are never overwritten.
- Deterministically rejected unforced mappings stop retrying automatically and receive an actionable reason.
- No plugin path uses broad forced mapping.

### Residual Limitation

If an affected account has no mapping and Core rejects the unforced mapping because of non-auth references, the plugin cannot safely make that account converge under the stated scope. Without an allowlisted structured Core result, the plugin must use a safe generic error and operator diagnostics rather than claim a permanent mapping reason. This must be communicated as an unsupported recovery state, not described as fixed.

## Point 3: Unknown JWKS `kid`

### Problem

A token can reference a `kid` absent from the plugin's cached JWKS. A normal key rotation should trigger a fresh lookup. A key still absent after that lookup cannot be used to verify the token.

### Current Baseline

Commit `0355e45` added bounded JWKS caching, one forced refresh after an unknown `kid`, single-flight concurrent refresh, typed token reasons, and preservation of the last valid cache after failed refreshes. Point 3 is now complete in the working tree: it adds generation-bound negative caching, global refresh backoff for unknown-key and outage paths, required audience and temporal claims, conditional trusted-discovery issuer validation, signature/temporal-first authenticated-request protection with bounded app-ID caching, a practical total refresh timeout, atomic refresh completion state, and sampled redacted diagnostics with isolated bounded delivery.

Operational bounds are a 5-second refresh cooldown, 5-second app-ID failure backoff, 5-second negative-cache TTL, 256 negative entries, practical 10-second total discovery/JWKS timeout, 5-minute JWKS and app-ID TTLs, and 10% diagnostic sampling. Expired app IDs are not served stale; their typed refresh failure is replayed during backoff. Diagnostics are globally limited to one submission per second and use a separate four-slot registry that requests cancellation after 250 ms while retaining the slot until actual termination. Negative entries do not suppress the first refresh permitted after cooldown, so maximum policy-induced recognition delay for a newly published key is 5 seconds; network and refresh execution time is additional. Python 3.9 `asyncio.wait_for` is not a strict cancellation-independent deadline when lower-level code suppresses cancellation. `TOKEN_KID_UNKNOWN` remains HTTP 401 and `retryable:false`; callers must discard the token and reauthenticate rather than automatically retry it.

### Implementation

1. Parse and validate the JWT header before network access. Require a non-empty `kid` and the supported `EdDSA` algorithm.
2. Load the bounded JWKS cache and look up the key.
3. On a miss, perform one generation-aware, single-flight discovery/JWKS refresh.
4. Recheck the key after refresh.
5. If still absent, return `TOKEN_KID_UNKNOWN`, HTTP 401, `retryable:false`.
6. Add a short global forced-refresh cooldown and a bounded per-`kid` negative cache. This prevents repeated obsolete or attacker-generated tokens from causing a JWKS request per API request.
7. Bound negative-cache size and lifetime. Maximum recognition delay for a newly published key is bounded by the greater of the forced-refresh cooldown and per-`kid` negative-cache TTL, not the normal JWKS TTL.
8. Distinguish malformed, expired, not-active, invalid-claims, unknown-key, invalid-signature, JWKS-fetch, and JWKS-response failures.
9. Require expected audience and temporal claims. Add expected issuer validation if the Rownd token issuer is available from trusted plugin configuration or trusted discovery metadata.
10. Emit sampled structured diagnostics containing a bounded hash or truncated representation of the requested `kid`, key count, cache generation, and refresh outcome. Do not use `kid` as an unbounded metric label and never log the token.
11. Document `TOKEN_KID_UNKNOWN` as requiring token discard and reauthentication. Retrying the same token cannot succeed until the published key set changes.

### Tests

- Cached key validates without refresh.
- Rotated key forces one refresh and succeeds.
- Unknown key forces one refresh and returns `TOKEN_KID_UNKNOWN`.
- Concurrent misses share one refresh.
- Repeated misses during cooldown do not refetch.
- Negative cache is bounded and expires.
- Failed refresh preserves the last known-good keys.
- Invalid signature does not trigger a refresh when the `kid` is known.
- Missing or invalid required claims return the correct typed reason.

### Acceptance Criteria

- A key newly visible in JWKS succeeds on the next refresh permitted by the cooldown and negative-cache policy.
- A key absent from fresh JWKS returns a deterministic 401.
- Repeated invalid tokens cannot create a JWKS request storm.
- The 88 migration failures become distinguishable and instruct the caller to reauthenticate.

Status: the final app-ID backoff change is verified on Python 3.9.25 with all 82 repository tests and all 565 non-integration tests passing. Ruff, Pyright, and diff whitespace checks pass. The immediately preceding full-suite attempts were limited by documented RootlessKit host-port collisions and were not repeated for this final isolated change. Full verification details are recorded in `PYTHON_MIGRATION_RELIABILITY_TODO.md`.

### Residual Limitation

The plugin cannot validate a token whose public key is absent from fresh JWKS. It also cannot affect the customer's ordinary authenticated requests handled by their own Rownd verifier. The reported 24,000 daily failures outside the migration route remain outside plugin control.

## Point 4: Login Method Belongs To A Different SuperTokens User

### Problem

A Rownd profile can contain multiple verified identities whose matching SuperTokens methods belong to different users. Linking the wrong method can transfer account access. Refusing every different-user topology, however, leaves safely reconcilable non-primary methods permanently blocked.

### Current Baseline

Commits `4f18700` and `6d6722c` inspect all identity owners, pin a target, and link permitted non-primary methods after fresh checks. Primary-account and contradictory ownership cases fail closed.

Point 4 is partially implemented in the working tree. Already-associated eligible methods can be linked safely, but the shared read-only diagnostic command is still pending and cross-tenant standalone owners cannot be reconciled safely. Therefore the six reported accounts cannot yet be classified without invoking migration. Point 2's unavailable narrow mapping capability remains unchanged and is not bypassed.

### Implementation

1. Build expected identities only from Rownd fields that are verified and authoritative for authentication.
2. Resolve every matching login method to its current primary user.
3. Select and pin the canonical target using this order:
   - exact existing Rownd mapping;
   - safe raw Rownd-ID target;
   - unique verified third-party owner;
   - unique verified Passwordless owner;
   - fresh import when no owner exists.
4. Permit automatic linking only when the foreign owner:
   - matches the exact expected identity;
   - is non-primary;
   - is still unlinked at mutation time;
   - has no user-ID mapping;
   - has no metadata claiming another Rownd user;
   - already belongs to the expected tenant.
5. Fail closed with `IDENTITY_OWNED_BY_ANOTHER_USER` when a discovered method lacks request-tenant membership. Do not associate or link it on the request path.
6. Re-fetch the Rownd source and Core ownership immediately before linking.
7. Verify target mapping authority immediately before linking.
8. Treat a sibling link to the same target as convergence after a fresh read.
9. Return stable permanent reasons for unsafe topologies:
   - `PRIMARY_ACCOUNT_MERGE_REQUIRED` for another primary owner;
   - `IDENTITY_OWNED_BY_ANOTHER_USER` for foreign mapping or ownership evidence;
   - `IDENTITY_AMBIGUOUS` for multiple unrelated owners;
   - `MAPPING_CONFLICT` when target authority changes.
10. Include the blocked identity type and target source in redacted diagnostic output, but not in the public response.

### Tests

- Verified standalone non-primary provider links to the pinned target.
- Verified standalone non-primary Passwordless method links to the pinned target.
- Unverified Passwordless owner is never linked.
- Foreign mapped owner is never linked.
- Foreign primary owner returns `PRIMARY_ACCOUNT_MERGE_REQUIRED` without mutation.
- Multiple owners return `IDENTITY_AMBIGUOUS` without mutation.
- Concurrent sibling link converges to success only when final ownership is exact.
- Changed target authority between preflight and mutation returns a conflict.

### Acceptance Criteria

- Safely reconcilable different-user methods converge.
- No primary account is automatically merged into another primary account.
- Every blocked topology has a specific permanent reason.
- The six reported accounts can be classified through the diagnostic command.

Status: partial. The safe online subset and redacted terminal diagnostic context are implemented and the full 706-test suite passes. The diagnostic-command criterion remains pending, and automatic cross-tenant association is intentionally unavailable.

### Residual Limitation

Primary-primary and contradictory ownership cases cannot be made successful safely by the plugin. They require a separately authorized account-recovery process outside online migration.

The shared read-only diagnostic command is required to classify affected accounts without invoking migration. Cross-tenant standalone reconciliation additionally requires reliable cross-tenant owner discovery and an atomic association/link operation; current tenant-scoped account-info lookup and irreversible SDK association cannot provide those guarantees. The plugin therefore neither enumerates other tenants nor associates or links a discovered owner that lacks request-tenant membership.

## Point 5: Incomplete Migrated User Could Not Be Reconciled

### Problem

An earlier attempt can leave durable partial state: an imported user, mapping, login method, account link, tenant association, metadata update, or completed migration without a request session. Retrying a linear migration can repeat mutations or fail without identifying the missing postcondition.

### Current Baseline

Commits `4f18700` and `6d6722c` add immutable Rownd source snapshots, durable state inspection, a bounded inspect/repair/final-verify loop, race recovery, and delayed completion metadata.

Point 5's online reconciliation behavior is implemented in the working tree. Characterization tests confirm the baseline snapshot, classification, ordered mutation, uncertain-result convergence, metadata-last, non-destructive concurrency, and session separation behavior. The remaining production delta refreshes normalized Rownd source at every repair-budget iteration, centralizes source-epoch changes so no target, path, blocker, error, capability, or mapping-retry attribution survives from the old source, and reports an unresolved mutation only from the final fresh `REPAIRABLE` disposition through a safe bounded allowlist. A profile that disappears at any refresh boundary returns `ROWND_USER_NOT_FOUND` rather than an incomplete-migration retry.

### Implementation

1. Fetch and normalize a fresh Rownd profile for each attempt.
2. Build a durable Core snapshot containing mappings, users, identity owners, primary state, tenant associations, migration metadata, and canonical email pointers.
3. Classify the snapshot as `COMPLETE`, `REPAIRABLE`, or `BLOCKED`.
4. Convert a repairable snapshot into ordered idempotent mutations:
   - import missing user;
   - create an unforced mapping;
   - make the selected target primary;
   - create a missing verified identity;
   - link a permitted identity;
   - verify a Rownd-authorized email;
   - write canonical email and migration completion metadata together as the final metadata mutation.
5. Before each mutation, re-fetch the Rownd source and reclassify fresh Core state. Stop and restart classification when source identity data changes.
6. After every error or uncertain result, clear caches and inspect durable state. Continue when the intended postcondition exists.
7. Limit online repair attempts. After the budget is exhausted, perform one final fresh classification.
8. Return the final blocked reason where available. Use `MIGRATION_INCOMPLETE` only when state remains repairable but bounded attempts cannot finish.
9. Record the unresolved mutation category in telemetry and diagnostics.
10. Never destructively roll back users, mappings, methods, or links performed by this or a concurrent request.
11. Keep session creation separate. A completed durable migration with failed session creation must be retryable without repeating account mutations.
12. Treat missing request-tenant membership as permanently blocked with `IDENTITY_OWNED_BY_ANOTHER_USER`; do not associate or link on the request path.

### Clarification On Phone Identities

The current integration suite demonstrates that a plugin-created phone method can converge. `test_migration_preflights_later_collision_before_creating_phone_method` succeeds with a verified Rownd phone identity. The incomplete case near `test_failed_unverification_keeps_linked_methods_without_mapping` is consistent with mapping being blocked by existing non-auth data, not a general inability to create phone identities. Do not add a new phone-verification capability without a failing characterization test that proves it is required.

### Tests

- Retry after each mutation succeeds but its response is lost.
- Retry after metadata finalization failure converges without duplicate identities.
- Retry after session creation failure reuses completed durable state.
- Existing mapping remains the canonical target when Rownd email changes.
- Missing provider, email, phone, and metadata each repair independently.
- Missing tenant membership fails closed without association or linking.
- Source profile changes during repair restart classification safely.
- Attempt exhaustion returns the final specific blocker or `MIGRATION_INCOMPLETE`.
- No failed attempt deletes state created by a sibling.

### Acceptance Criteria

- Every final snapshot is classified as complete, permanently blocked with a specific reason, or still repairable with retryable `MIGRATION_INCOMPLETE` after the bounded attempt budget.
- Repeated requests do not create duplicate users or methods.
- Completion metadata is never published before all durable invariants pass.
- Session failure does not corrupt an otherwise complete migration.
- Cross-tenant standalone reconciliation remains blocked until owner discovery and tenant association/linking can be performed atomically.

Status: the online Point 5 behavior is complete in the working tree. Focused migration tests pass with category-specific production-branch response-loss coverage for every mutation category, source changes at every repair boundary and terminal/session classification boundary, profile disappearance at each route boundary, independent provider/email/phone/mapping/metadata repairs, final-budget classification, metadata-finalization recovery, session retry, metadata-last publication, and bounded telemetry. App-variant metadata publication and asynchronous claim construction now precede the last Rownd source read; a change during either preparation step restarts bounded durable classification and cannot issue a stale session. The shared read-only diagnostic command remains pending and is not claimed as complete.

### Residual Limitation

The plugin still cannot repair a structurally rejected unforced mapping, safely merge primary accounts, or associate/link a standalone owner missing request-tenant membership. Those states retain the Point 2 and Point 4 permanent failure behavior. Terminal telemetry reports only the allowlisted unresolved mutation category and does not replace the pending read-only per-account diagnostic command.

## Point 6: Passwordless `canonical_topology`

### Problem

The current Python classifier marks an account malformed when any tenant Passwordless email method is unverified. A valid migrated account can contain one verified canonical method and an older retained unverified method. The old method must remain blocked, but it must not prevent the canonical method from authenticating.

`canonical_topology` can also mean that canonical metadata references a missing method, multiple methods have no canonical pointer, or a committing email plan disagrees with durable methods. Those states must remain blocked.

### Implementation

1. Keep rejecting duplicate recipe-user IDs and malformed email identifiers.
2. Stop requiring every Passwordless email method to be verified.
3. Resolve the tenant-scoped canonical recipe-user ID, with the existing legacy fallback only when tenant-scoped metadata is absent.
4. If no canonical pointer exists:
   - allow no-owner state;
   - infer the only method when exactly one valid method exists;
   - return `AMBIGUOUS/CANONICAL_TOPOLOGY` when multiple methods exist.
5. Require the selected canonical method to exist, belong to the tenant, be Passwordless, have a valid email, and be verified.
6. During a committing email change, require the target canonical method and committing plan to agree and require the target to be verified.
7. Classify the matching canonical method as `ALLOW/CANONICAL`.
8. Classify a valid noncanonical method as `RETIRED/NONCANONICAL`, regardless of whether that retired method remains verified.
9. Continue rejecting retired methods during create, resend, and consume in guard mode.
10. Preserve old methods during synchronous migration. Do not delete them as part of request handling.
11. Write tenant-scoped canonical and completion metadata in the same final metadata update, then fresh-read and validate both before classifying migration complete.
12. Port the relevant final behavior and tests from Node.js commit `f8e4ded` without removing Python's stricter pending-email metadata checks.

### Tests

- Verified canonical method plus verified retired method.
- Verified canonical method plus unverified retired method.
- Unverified canonical method remains malformed.
- Canonical pointer to a missing method remains malformed.
- Multiple methods without a canonical pointer remain ambiguous.
- In guard mode, create, resend, and consume allow the canonical method.
- In guard mode, create, resend, and consume reject the retired method.
- Migration followed immediately by guard-mode Passwordless authentication succeeds for the canonical email.
- Concurrent canonical metadata change is detected.

### Acceptance Criteria

- In guard mode, a retained unverified old method does not block the verified canonical method.
- In guard mode, the retired method cannot authenticate.
- Truly contradictory canonical topology remains blocked.
- The 93 reported rejections are resolved when they match the retained-method topology and are otherwise reclassified precisely.
- Observe mode retains its existing non-blocking behavior.

Status: complete in the working tree. The classifier now validates the selected canonical
method rather than requiring every retained Passwordless email method to be verified. Guard
create, resend, and consume permit the verified canonical method and reject every valid
noncanonical method. Migration retains prior methods, publishes tenant canonical and completion
metadata together, and fresh-validates both before completion.

## Point 7: Passwordless Session Binding And Cleanup

### Problem

The plugin applies Rownd canonical-credential policy around SuperTokens Passwordless consumption. Most policy rejection happens in the recipe override before the API creates a session. The outer API override still needs to verify that an `OK` session is bound to the owner and recipe user authorized by the recipe-level checks.

If the API returns an `OK` session despite a missing or mismatched postcheck marker, returning an error without invalidating that session could leave usable credentials for a rejected authentication.

### Required Checks

1. For email credentials, resolve the stored email from the Passwordless device before consumption.
2. For email credentials, authorize the credential before consumption to reject an already-retired or malformed method.
3. Consume the code through the original recipe implementation. Phone credentials preserve the existing consume path and do not use email classification.
4. For email credentials, authorize again after consumption using the exact consumed recipe-user ID and expected owner. This closes ownership and canonical-metadata races.
5. Pass a typed internal marker containing the authorized owner and recipe-user ID to the API layer.
6. If the outer API returns `OK`, require:
   - a valid marker;
   - a returned `SessionContainer`;
   - the session recipe-user ID to equal the consumed recipe-user ID;
   - the returned user to resolve to the authorized owner;
   - the session tenant to equal the request tenant.

Guard mode requires a supported SDK version that exposes the session tenant. If that binding cannot be inspected, guard mode must fail initialization rather than skip the check.

### Cleanup

1. Normal successful consumption must not revoke any session.
2. A normal recipe-level policy rejection should return before session creation and needs no session cleanup.
3. If the outer API returns an `OK` session with an invalid marker or binding, revoke the exact returned session handle.
4. Queue or apply the SDK clear-session response mutator so access, refresh, anti-CSRF, and front-token credentials are not returned.
5. Treat a `False` revocation result as cleanup failure.
6. If exact revocation fails, use the existing tenant-scoped linked-account revocation as a last-resort containment measure. Document that this may sign out other legitimate sessions in that tenant.
7. Do not use unscoped account-wide revocation.
8. Guard mode startup must verify that the supported SDK exposes the clear-session response mutator for every supported transfer method. Refuse to enable guard mode when this capability is absent.
9. If response credential clearing fails at runtime, attempt exact and tenant-scoped revocation even if an earlier cleanup step appeared successful. Never return the original `OK` result.
10. If neither revocation nor response clearing succeeds, the plugin cannot prove containment. Return a generic authentication failure and emit a critical redacted diagnostic; this state is a release-blocking defect for a supported SDK/transfer method.
11. Keep cleanup failures independent so one failure does not prevent attempting the other cleanup operation.

### Tests

- Normal canonical consume creates and retains its session.
- Retired-method rejection occurs before session creation.
- Canonical metadata change between precheck and postcheck is rejected before session creation.
- Missing marker after an outer `OK` result revokes the exact session.
- Mismatched recipe-user ID revokes the exact session.
- Mismatched owner revokes the exact session.
- Revocation returning `False` is treated as failure.
- Response credentials are cleared without deleting unrelated headers or cookies.
- Guard mode refuses initialization when response credential clearing is unsupported.
- Clear-session mutator failure triggers exact and tenant-scoped revocation attempts and never returns `OK`.
- Simultaneous response-clearing and revocation failure emits a critical diagnostic.
- Exact revocation failure invokes only the documented tenant-scoped linked-account fallback.
- Total revocation failure with successful response clearing emits an alertable diagnostic and exposes no newly issued credentials.
- Custom Passwordless overrides cannot bypass the marker/binding invariant.

### Acceptance Criteria

- For every supported transfer method, a rejected Passwordless response either exposes no session credentials or the issued session is proven revoked.
- Exact revocation is proven for the normal supported cleanup path.
- Unrelated sessions remain valid unless the documented tenant-scoped fallback is required.
- Normal canonical authentication is unaffected.
- Cleanup failures are observable without exposing account or token data.

## Diagnostic Command

Add a read-only command to make points 2, 4, and 5 operationally useful. It should reuse migration normalization and classification rather than reimplementing them.

The command should report:

- normalized source identity types;
- selected target and target source;
- external and internal mapping states;
- raw-ID collision state;
- identity owner topology and primary status;
- tenant associations;
- migration metadata validity;
- canonical Passwordless pointer validity;
- disposition: `COMPLETE`, `REPAIRABLE`, or `BLOCKED`;
- stable reason and required mutation types.

Identifiers and identity values must be redacted by default. An explicit operator flag may reveal them. Secrets, tokens, credentials, upstream bodies, and stack traces must never be printed. The command must not call any mutation API.

Expose the command through a documented `[project.scripts]` entry point. CLI arguments override environment variables. Use deterministic JSON output with a versioned schema and stable exit codes for complete, repairable, blocked, configuration-error, and upstream-error outcomes. Add tests that fail if any mutation API is called and tests covering redaction, control characters, malformed configuration, and secret-bearing upstream errors.

## Delivery Sequence

### Phase 1: Direct Customer Impact

1. Fix canonical Passwordless classification from point 6.
2. Tighten exact-session cleanup from point 7.
3. Complete Rownd adapter error classification from point 1.
4. Add unknown-`kid` cooldown and negative caching from point 3.

### Phase 2: Permanent Failure Handling

1. Convert deterministic unforced Core mapping rejections into `MAPPING_REJECTED`, `retryable:false`.
2. Preserve exact mapping convergence and conflict protection.
3. Add the read-only diagnostic command.
4. Add stable unresolved-mutation diagnostics for incomplete migrations.

### Phase 3: Observability And Verification

1. Add terminal migration telemetry with privacy tests.
2. Add customer-derived characterization fixtures for each failure family.
3. Test pre-existing sessions on linked users.
4. Run full lint, type checking, unit, integration, build, and package checks.

## Release Criteria

Before release:

1. `uv run ruff check .` passes.
2. `uv run pyright` passes.
3. `uv run pytest` passes against supported Core configurations.
4. Both migration routes pass identical response-contract tests.
5. No production path invokes broad forced mapping.
6. No rejected Passwordless response exposes usable newly issued session credentials: credentials are scrubbed, or the corresponding session is proven revoked. Exact and tenant-scoped revocation behavior is verified for every supported transfer method.
7. Canonical Passwordless authentication succeeds beside retained unverified methods.
8. Repeated unknown `kid` requests do not cause unbounded JWKS refreshes.
9. Diagnostic execution performs no writes and redacts identifiers by default.
10. Documentation clearly identifies plugin-only residual limitations.

## Customer-Facing Outcome

After this plan:

- Migration failures are visible and machine-classifiable.
- Exact mappings and safe concurrent repairs converge.
- Deterministically rejected or conflicting mappings stop retrying and report a permanent reason; unrecognized failures remain safely generic.
- Unknown signing keys trigger one bounded refresh and then require reauthentication.
- Safe different-user identity topologies reconcile; unsafe ownership conflicts remain blocked.
- Partial migrations converge when all required operations are available.
- A verified canonical Passwordless method works beside retained old methods.
- Rejected Passwordless responses do not expose usable newly issued credentials: the plugin scrubs them, proves the returned session revoked through the strongest available scoped mechanism, or both.

The plugin must not claim to solve missing public keys, structurally blocked mappings, primary-primary merges, or failures in authentication paths that do not use the plugin.
