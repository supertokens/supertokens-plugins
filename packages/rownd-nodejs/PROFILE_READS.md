# Profile reads: contract, measurements, and release gates

Status: P1/P2 default contract revised to session-free profiles with null activity.
This describes the current working-tree contract, not a released-version guarantee.
Production canary and executed mobile decoder validation remain outstanding.
Historical activity summaries, canonical
projections (P3), and cross-request sharing (P4) are deferred.

## Request contract

Routes are relative to the configured SuperTokens `apiBasePath` (default `/auth`).
Use the normal authenticated SuperTokens request mechanism:

- `GET /auth/plugin/rownd/user` returns a session-free profile with null activity.
- `GET /auth/plugin/rownd/user?include_activity=true` requests active-session enrichment.
- Only the exact `include_activity=true` value enables enumeration. Missing,
  `false`, empty, differently cased, or unknown values remain session-free.
- The former `profile=lightweight-v1` selector is ignored, as are other `profile`
  values. It cannot trigger enumeration. There is no header-based opt-in.

The response retains `status: "OK"` and the existing profile envelope. The
authenticated session selects the user and tenant. Negotiation does not relax
authentication, database-checked session verification, or revocation checks.
Ordinary internal `getUserById` calls and mutation-returned profiles are also
session-free by default. Internal callers must explicitly pass the fourth
argument `{ includeActivity: true }` when active-session activity is needed.
The GET query does not cause mutation-returned profiles to enumerate sessions.

### Activity semantics

Explicit activity reads enumerate sessions for the tenant and select the newest available
session creation time. `meta.last_sign_in` and `meta.last_active` both reflect
that time; `last_active` is not a general app-activity timestamp. With no selected
session, the existing implementation falls back to account creation time and a
login-method fallback. These values are not reliable historical sign-in records.

Default reads return all three properties in `meta` with JSON `null` values:

- `last_sign_in`
- `last_active`
- `last_sign_in_method`

Null means **not requested/unknown**, not never signed in, signed out, or
an email sign-in. Historical values in stored metadata do not populate these
properties. Other profile fields retain their existing assembly behavior,
including `created`, `first_sign_in`, and `first_sign_in_method`; those fields
must not be used to reconstruct the unknown activity values.

Default reads perform zero session-list and session-detail calls, including
when activity is unavailable. They do not scan sessions as a fallback. No
historical activity summary is read or persisted by this change. A future
historical summary would have different expiry/revocation semantics from the
opt-in newest-active-session result and needs a separately reviewed contract.

### Compatibility and metadata write-back

This is an intentional behavior change for existing clients: the default now
returns null instead of computed activity. The Hub profile-view audit found
`Profile.tsx` uses `user.data`, not these activity fields. iOS decodes `meta` as an
arbitrary dictionary that accepts null; Android's network user model does not
decode `meta`. These source inspections are not executed mobile decoder tests.
Dynamic automation equality and `EXISTS` conditions can behave differently for
null versus omitted or previously populated values; audit such rules before rollout.

The metadata update API ignores the exact top-level keys `last_sign_in`,
`last_active`, and `last_sign_in_method`, for both null and non-null input. Hub
clients may send back the whole `meta` object without erasing stored server-owned
activity or writing stale computed activity. Other customer metadata, including
null deletions and nested keys, retains its existing behavior. Profile `data`
writes and schema fields are not filtered by this metadata-only rule. Raw
administrative/SDK metadata writers are unchanged.

## P1/P2 implementation scope

Each profile assembly owns a read operation that reuses identical instrumented
user, mapping, and metadata reads within that operation. Distinct records remain
distinct work. Its lifetime ends with assembly; it is not a cross-request cache
or a snapshot transaction against Core. Mutation responses start fresh reads.

P2 skips session enrichment by default and permits explicit opt-in. Linked
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
- `profileMode`: `profile` (default) or `active-sessions` (explicit opt-in).
- `profileConfig`: `static` or `dynamic`.
- `profileFallbackReason`: `activity_not_requested` for default reads or
  `none` for opt-in reads. These describe mode/activity
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

The unmapped single-login-method unit fixture uses four SDK calls by default.
Explicit activity adds `1 + N` calls (list plus N details), giving `6/10/25` SDK
calls for 1/5/20 sessions. Detail concurrency is bounded to four per request;
this limits bursts, not total work. These are not universal endpoint budgets:
route verification, refresh, and additional linked metadata are separate work.
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
shipping session-free reads independently of these prerequisites.

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

The earlier opt-in lightweight implementation passed focused and real-Core
checks, but those results do not validate this revised null-by-default contract.
Current focused validation: **66/66 tests passed** across `profile-read.test.ts`,
`telemetry/openTelemetryClient.test.ts`, `mapped-profile-metadata.test.ts`,
`metadata-references.test.ts`, and `local-core-read-boundaries.test.ts`.
Coverage checks default/opt-in budgets, activity write-back protection, mutation
responses, fresh reads, bounded concurrency and failures, and exported span
duration. `npm run build` passed, including declarations.
Real-Core route tests are independently maintained.
Record their revised-contract results separately; do not reuse prior negotiation
or omission assertions as evidence for this contract.

Known package-check baselines are shared `logger.ts` `o`/`O` type errors and the
`_reserved` lint issue. Earlier full parallel tests had seven five-second
timeouts that passed isolated reruns; this is not a clean full-suite result.
Executed mobile decode results and tested client versions remain release gates.

### Release gates

Before release:

1. Verify iOS and Android decoders accept null for all three activity fields;
   record tested client versions and audit automation equality/EXISTS rules.
2. Test old/new client and backend combinations, unsupported query values,
   tenant isolation, linked identities, authoritative deletions, missing activity,
   revoked sessions, metadata echo, and mutation responses. Verify zero default session
   calls with 1/5/20 sessions.
3. Run package typecheck, lint, tests, build, and real-Core integration suites.
   Record plugin, Node SDK, Core, and fixture versions with results.
4. Compare cold-distinct-user and hot-same-user workloads separately. Include
   failed requests and all endpoint Core work; measure latency and authentication
   success against a matched control. Do not infer capacity from warm reads alone.

Canary the backend change by deployment: existing clients receive null activity
and session-scan removal without an upgrade. Stop expansion on increased
authentication failures or meaningful latency/load regression; roll back on
identity, revocation, or unexpected output mismatches. Clients needing the prior
computed activity can explicitly request `include_activity=true`, accepting its
extra work. Removing that query returns to null-by-default behavior. Restoring
the previous default for unmodified clients requires a backend rollback.

Release notes must distinguish P1/P2 from deferred summaries/P3/P4 and include
tested compatibility and observed measurements. If later releases introduce
summary/projection writers, disable optimized reads before reverting writers and
retain additive metadata rather than requiring a destructive rollback migration.
