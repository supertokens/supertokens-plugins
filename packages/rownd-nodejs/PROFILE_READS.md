# Profile reads: contract, measurements, and release gates

Status: P1/P2 implementation complete with qualified local validation. This
describes the current working-tree contract, not a released-version guarantee.
Production canary and executed mobile decoder validation remain outstanding.
Historical activity summaries, canonical
projections (P3), and cross-request sharing (P4) are deferred.

## Request contract

Routes are relative to the configured SuperTokens `apiBasePath` (default `/auth`).
Use the normal authenticated SuperTokens request mechanism:

- `GET /auth/plugin/rownd/user` retains the legacy profile contract.
- `GET /auth/plugin/rownd/user?profile=lightweight-v1` selects lightweight reads.
- Only the exact `profile=lightweight-v1` value selects the new contract. Missing
  or other values select legacy behavior; they do not produce a version error.

The response retains `status: "OK"` and the existing profile envelope. The
authenticated session selects the user and tenant. Negotiation does not relax
authentication, database-checked session verification, or revocation checks.
This query option applies to the GET user handler; it does not opt mutation
responses or other profile-producing operations into lightweight behavior.
There is no deployment-wide default switch in this implementation.

### Activity semantics

Legacy reads enumerate sessions for the tenant and select the newest available
session creation time. `meta.last_sign_in` and `meta.last_active` both reflect
that time; `last_active` is not a general app-activity timestamp. With no selected
session, the existing implementation falls back to account creation time and a
login-method fallback. These values are not reliable historical sign-in records.

Lightweight reads omit all three properties from `meta`:

- `last_sign_in`
- `last_active`
- `last_sign_in_method`

Omission means **unknown/unavailable**, not null, never signed in, signed out, or
an email sign-in. Historical values in stored metadata do not populate these
properties. Other profile fields retain their existing assembly behavior,
including `created`, `first_sign_in`, and `first_sign_in_method`; those fields
must not be used to reconstruct the omitted activity values.

Lightweight reads perform zero session-list and session-detail calls, including
when activity is unavailable. They do not scan sessions as a fallback. No
historical activity summary is read or persisted by this change. A future
historical summary would have different expiry/revocation semantics from the
legacy newest-active-session result and needs a separately reviewed contract.

## P1/P2 implementation scope

Each profile assembly owns a read operation that reuses identical instrumented
user, mapping, and metadata reads within that operation. Distinct records remain
distinct work. Its lifetime ends with assembly; it is not a cross-request cache
or a snapshot transaction against Core. Mutation responses start fresh reads.

P2 skips session enrichment only for the negotiated lightweight mode. Linked
metadata still uses the compatibility resolver: neither a fixed linked-record
read budget nor removal of alias/linked-record fan-out is claimed.

Presentation profiles are not authoritative migration/checkpoint inputs. Keep
identity, canonical ownership, verified contacts, tenant email pointers, alias
precedence, and authoritative deletion checks on their existing paths.

## Instrumentation and interpretation

The GET handler forwards a terminal profile event to the configured telemetry
client. Debug logging can also emit the event. Other internal callers only
forward it when they supply a recorder. Profile telemetry failures do not fail
the profile result.

Profile events include:

- `operation: "profile_read"`, `stage: "profile_assembly"`, and `eventType: "terminal"`.
- `requestId` (the assembly operation ID), `pluginVersion`, `durationMs`, and
  success/error `outcome` and `result`.
- `profileMode`: `legacy` or `lightweight-v1`.
- `profileConfig`: `static` or `dynamic`.
- `profileFallbackReason`: `legacy_contract` for legacy reads or
  `activity_unavailable` for lightweight reads. These describe mode/activity
  selection, not a projection fallback or an online scan.
- `sdkCalls`: `user`, `mapping`, `metadata`, `sessionList`, and `sessionDetail`.

Counters measure instrumented SDK-boundary attempts after operation-local
deduplication, including failed attempts. They are **not Core HTTP request
counts**. Assembly timing includes its reads and assembly, not earlier route
authentication or configuration resolution. Refresh, route verification, SDK
internal HTTP retries, and work outside the assembly are not covered by these
counters. OpenTelemetry uses the span name `rownd.profile_read`.

Measure Core wire attempts separately, including failures and retries. Normalize
route paths; do not use user IDs, full URLs, or operation IDs as metric labels.
Report database work and endpoint latency separately from both count types.

The planning probe's `6/10/25` SDK calls for 1/5/20 sessions concerned one unmapped
user with one login method. Removing enumeration alone predicts four calls for
that fixture, excluding route verification and any added summary work. This is
not a universal endpoint budget or an independently validated release result.
Incident route shares are addressable work, not measured savings.

## Deferred prerequisites

### Historical activity summaries

Core metadata updates are unconditional shallow patches, not compare-and-swap
operations. Read/modify/write cannot implement a durable atomic maximum across
instances; a process-local mutex cannot fix this. Before storing summaries,
provide an atomic max/CAS or equivalent durable ordered-write primitive.

Also define tenant scope, schema version, supported sign-in paths, treatment of
migration/adoption and replacement sessions, and failure/repair behavior.
Refresh must not count as sign-in. A summary failure must not turn successful
authentication into a reported authentication failure. Unknown activity permits
shipping lightweight reads independently of these prerequisites.

### P3: canonical compatibility projection

Uncontrolled alias, account-graph, direct SDK/Core, and metadata writers prevent
proving a projection current. Inventory and control every relevant writer, or
provide reliable invalidation, before enabling projection reads. Unconditional
metadata patches also prevent revision-checked concurrent publication; adding a
version field alone does not establish freshness or ordering.

Required gates include canonical-owner and deletion authority preservation,
atomic/ordered publication, stale-state rejection, bounded idempotent backfill,
old-writer coexistence, and sampled shadow comparisons. Until then, retain the
compatibility resolver rather than treating a projection as authoritative.

### P4: cross-request single-flight and caching

Dynamic configuration has no stable equivalence revision for safely identifying
equivalent responses. Cross-instance mutation generations are also absent: a
local invalidation cannot prevent another instance from serving or joining
pre-mutation work. Establish response-equivalence keys and durable mutation
ordering before claiming cross-request sharing or read-after-write guarantees.

Every request must still authenticate and check revocation independently. Share
only immutable presentation data, never session objects or mutable request
context. P1 operation-local reuse does not satisfy these P4 prerequisites. No
response TTL cache is introduced; caching requires a separate staleness and
invalidation contract plus measured justification.

## Validation, rollout, and rollback

### Current validation status

Independent validation of the in-progress implementation:

- `profile-read.integration.test.ts`: **18/18 real-Core tests passed**, covering
  exact query negotiation, unknown-selector legacy default, revocation before
  assembly, mapped/unmapped users in public/non-public tenants, legacy/lightweight
  parity outside the changed activity fields, omission despite stale stored
  activity, and zero lightweight session SDK calls with 1/5/20 sessions.
- Earlier focused validation reported 64 passing tests. That run and the 18-test
  real-Core run above are separate, overlapping runs; their counts are not additive.
- Final span-timing fix: 21 focused profile/telemetry tests passed. The full-suite
  run below may predate the last telemetry test addition and does not establish
  full-suite coverage of the final telemetry change.
- `npm run build`: passed, including bundles and declarations, before the final
  span-timing tweak; no post-tweak build pass is claimed.
- `npm run typecheck`: not clean; only reported baseline `logger.ts` `o`/`O` errors.
- `npm run lint`: not clean; only reported baseline `_reserved` issue.
- Full `npm test`: 43 files, 1,520 tests; 1,513 passed and seven hit the five-second
  timeout, in 149.08 seconds. The full parallel suite is not clean.
- Exactly those seven failures were rerun with `--no-file-parallelism`, retaining
  the original five-second timeout: seven passed, 606 skipped, across five files
  in 34.13 seconds. This is strong evidence of load contention, not proof that the
  failures predate this implementation. No further broad reruns were performed.

These backend tests do not establish mobile decoder compatibility. Source
inspection suggesting omitted fields are accepted is distinct from executing
iOS/Android decoding tests. Actual mobile decode results and tested versions
remain pending confirmation from the implementer.

### Release gates

Before release:

1. Verify iOS and Android decoders accept omission of all three activity fields;
   record tested client versions. Do not enable negotiation for incompatible clients.
2. Test legacy/new client and backend combinations, unsupported negotiation,
   tenant isolation, linked identities, authoritative deletions, missing activity,
   revoked sessions, and mutation responses. Verify zero lightweight session
   calls with 1/5/20 sessions.
3. Run package typecheck, lint, tests, build, and real-Core integration suites.
   Record plugin, Node SDK, Core, and fixture versions with results.
4. Compare cold-distinct-user and hot-same-user workloads separately. Include
   failed requests and all endpoint Core work; measure latency and authentication
   success against a matched control. Do not infer capacity from warm reads alone.

Canary negotiated requests first. Existing clients remain legacy and must not be
promised session-scan removal. Stop expansion on increased authentication failures
or meaningful latency/load regression; roll back immediately on identity,
revocation, or output mismatches. Clients can stop sending the negotiation query
to return to legacy behavior; test this rollback before expansion.

Release notes must distinguish P1/P2 from deferred summaries/P3/P4 and include
tested compatibility and observed measurements. If later releases introduce
summary/projection writers, disable optimized reads before reverting writers and
retain additive metadata rather than requiring a destructive rollback migration.
