# Migration request counts

Run the opt-in benchmark against the test suite's disposable Core:

```sh
ROWND_TEST_REQUEST_COUNTS=1 .venv/bin/pytest -s tests/test_migration_request_counts.py
```

If Docker's default address pools are exhausted, also set `ROWND_TEST_DOCKER_SUBNET`
to an unused subnet. The fixture removes its own containers and network afterward.

The observer wraps HTTPX transport calls below the SDK cache and filters requests
to the test Core's host and port. It reports endpoint totals and separately counts
synthetic Rownd profile fetches. Budgets include session creation and, for first
migrations, SDK API-version discovery. No production services are used.

Measured with Python SDK 0.31.3 and Core 12.0.10, using identical fixtures before
and after read-phase cache reuse:

| Operation | Core before → after | Mapping before → after | Rownd fetches (both) |
| --- | ---: | ---: | ---: |
| First email migration | 182 → 138 | 70 → 50 | 9 |
| Stable email migration | 103 → 81 | 39 → 29 | 5 |
| Stable email migrate-session | 103 → 81 | 39 → 29 | 5 |
| First provider migration | 164 → 148 | 66 → 58 | 9 |
| Stable provider migration | 95 → 87 | 37 → 33 | 5 |
| Stable provider migrate-session | 95 → 87 | 37 → 33 | 5 |
| Provider replacement | 256 → 237 | 112 → 98 | 12 |
| Retained historical alias, four recipes | 391 → 391 | 97 → 97 | 9 |

Source-binding validation starts with a fresh literal tombstone read, then shares
the SDK's ordinary completed-GET cache across both mapping directions and owner
resolution. Email lifecycle inspection reuses that binding while reading its
ledger, refreshing again after retirement settlement writes. Source fetches,
mutation recovery, snapshots, and session validation retain their fresh barriers.

The budgets are request-count regressions, not latency measurements. SDK/Core
changes can legitimately change counts; investigate before updating the limits.

## Ordinary mapped migration path

The previous, post-classification shortcut measured 67 Core calls / 22 mapping
calls for stable email, and 70 / 25 for stable provider, with four Rownd profile
reads each. The ordinary path now branches **before full migration discovery and
consolidated-owner probing**. Both route aliases require zero calls to
`read_fresh_migration_snapshot`, lifecycle repair, or migration repair on unchanged
fixtures.

Measured handoff change against baseline `3fab681`, with SDK 0.31.3, Python 3.9,
and Core 12.0.10:

| Operation | Core before → after | Mapping before → after | Rownd profile reads before → after | SDK EV reads before → after |
| --- | ---: | ---: | ---: | ---: |
| Stable email, either route | 32 → 28 | 12 → 12 | 3 → 1 | 1 → 1 |
| Stable provider, either route | 29 → 27 | 12 → 12 | 3 → 1 | 1 → 1 |
| First email | 138 → 138 | 50 → 50 | 9 → 9 | 1 → 1 |
| First provider | 148 → 148 | 58 → 58 | 9 → 9 | 1 → 1 |
| Provider replacement | 237 → 237 | 98 → 98 | 12 → 12 | 1 → 1 |
| Retained historical alias, four recipes | 391 → 391 | 97 → 97 | 9 → 9 | 162 → 162 |

Stable metadata reads fall from 12 to 10 for both credential types; user reads
remain three. Email reservation queries fall from three to one per request.
Counts are actual HTTP requests below the SDK cache, measured against disposable Core.

First migrations, replacement, and historical aliases retain their budgets.
The entry probe checks source metadata and user existence before requesting map
roles, then shares these reads with fallback discovery. Historical validation
remains on the full administrative path.

Initial migration inspection costs ten plugin GETs for email, nine for provider:
four mapping roles, four literal metadata/ledger records, one user read, and an
email reservation query where applicable. Each subsequent credential-binding
phase costs eight GETs: four mapping roles, two literal account records, the
selected credential's retirement ledger, and one user read. The SDK reuses the
pre-issuance user read; its additional calls are one literal email-verification
GET and one session POST. Email totals `10 + 8 + 2 + 8 = 28`, provider
`9 + 8 + 2 + 8 = 27`. Every identical GET key is read at most once per phase.

### Call graph and fresh boundaries

1. The route validates the JWT, fetches its subject's profile, and privately binds
   source authority. `read_completed_migration` opens a fresh SDK GET phase and
   reads a bounded `_OrdinarySnapshot` in `migration_plan.py`.
2. `build_rownd_session_claims` uses defensively reconstructed snapshot inputs.
   It remains an awaited hook boundary. After it returns, the coordinator clears
   SDK GETs and checks only current authentication validity: exact mapping roles,
   primary owner, selected method identity/incarnation, tenant membership,
   required verification, tombstones, publication/orphan markers, and selected
   credential introduction/retirement. It does not fetch Rownd again.
3. Native creation claims a single-use private evidence object, bound to config,
   authenticated source, target, recipe, tenant, task, and issuance phase. Its
   claims preparation reuses the established snapshot. Identity
   witnesses into the SDK GET cache expire this authority after cache invalidation
   or writes; there is no independent HTTP-response cache. Without current private
   evidence, native creation uses its existing fresh standalone guards.
4. Native return transfers publication back to the coordinator. After the SDK
   session call **and outer session hooks** return, the coordinator starts a
   separate fresh SDK phase checking the same selected credential binding, then
   checks the returned session's owner, recipe, and tenant.
   Failure revokes the session and scrubs response credentials. Evidence expires
   in `finally`; retaining or copying a context cannot authorize another request.

The snapshot stores immutable strings/tuples, including explicit mapping roles,
literal metadata records, contact-query results, and the selected method. Its
validators perform no HTTP. Raw metadata names and SDK email-verification names
remain literal; alias mapping never merges their cache keys. Cross-recipe email
and phone reservation queries and both hashed ledgers are required during initial
migration inspection. After handoff, only the selected credential's ledger is
read, and unrelated entries do not invalidate its authentication. Provider
identity matching stays exact.

Migration completion is deliberately distinct from session validity. New
completion debt, nonselected method/contact changes, or Rownd profile changes
during hooks are handled on the next migration attempt. They do not invalidate
the account and credential already authenticated for this request. Claims use
the established, privately authenticated inputs, not hook-supplied provenance.
Native create/refresh remain Core-only and work during Rownd outages. First
migration, repair, and administrative alias paths retain their conservative
source refreshes and authority checks.

Eligibility requires a bidirectionally mapped, primary, complete target; an exact
authenticated source profile; all expected methods, tenant memberships,
verification and canonical-email agreement; no unexpected current methods; and
clean literal metadata across source, target, and linked recipes. Foreign source
provenance, conflicting canonical fields, pending receipts, unknown operational
keys (including null-valued markers), or any ledger content use reconciliation
or block. The read model is capped at eight linked methods and eight owners per
contact query. App variants and custom schemas use reconciliation.

Conservative fallback shares the entry phase's SDK reads through the literal
tombstone and consolidated-owner checks. The existing reconciliation executor
retains its subsequent fresh/mutation boundaries. No second fast-path probe runs
after full classification.

Cancellation after issuance synchronously scrubs credentials and detaches the
request session, then attempts revocation for at most five seconds. Repeated
cancellation does not restart that deadline or replace the original
`CancelledError`. Revocation failure or timeout also preserves cancellation;
remote deletion cannot be guaranteed when Core does not complete revocation.

The transport benchmark also labels each plugin read phase and SDK-only calls.
Every identical plugin GET key may occur at most once per phase. SDK nested
email-verification and session requests are reported separately. First ordinary
requests preserve the account's methods, metadata, and literal verification
state; session issuance is their only durable change.
