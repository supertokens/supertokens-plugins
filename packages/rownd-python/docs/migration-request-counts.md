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

Measured against baseline `1e8a279`, with SDK 0.31.3, Python 3.9, and Core 12.0.10:

| Operation | Core before → after | Mapping before → after | Rownd profile reads before → after | SDK EV reads before → after |
| --- | ---: | ---: | ---: | ---: |
| Stable email, either route | 67 → 32 | 22 → 12 | 4 → 3 | 1 → 1 |
| Stable provider, either route | 70 → 29 | 25 → 12 | 4 → 3 | 1 → 1 |
| First email | 138 → 138 | 50 → 50 | 9 → 9 | 1 → 1 |
| First provider | 148 → 148 | 58 → 58 | 9 → 9 | 1 → 1 |
| Provider replacement | 237 → 237 | 98 → 98 | 12 → 12 | 1 → 1 |
| Retained historical alias, four recipes | 391 → 391 | 97 → 97 | 9 → 9 | 162 → 162 |

Stable email metadata reads fall from 30 to 12, user reads from 10 to 3.
Stable provider metadata reads fall from 32 to 12, user reads from 11 to 3.
Email reservation queries remain three per request. Both revisions were rerun
against disposable Core instances with the same benchmark fixtures.

First migrations, replacement, and historical aliases retain their budgets.
The entry probe checks source metadata and user existence before requesting map
roles, then shares these reads with fallback discovery. Historical validation
remains on the full administrative path.

Each successful ordinary phase costs ten plugin GETs for email, nine for provider:
four mapping roles, four literal metadata/ledger records, one user read, and an
email reservation query where applicable. Initial, pre-issuance, and post-hook
phases each read every identical GET key at most once. The SDK reuses the
pre-issuance user read; its additional calls are one literal email-verification
GET and one session POST. Thus email totals `10 + 10 + 2 + 10 = 32`, provider
`9 + 9 + 2 + 9 = 29`.

### Call graph and fresh boundaries

1. The route validates the JWT, fetches its subject's profile, and privately binds
   source authority. `read_completed_migration` opens a fresh SDK GET phase and
   reads a bounded `_OrdinarySnapshot` in `migration_plan.py`.
2. `build_rownd_session_claims` uses defensively reconstructed snapshot inputs.
   It remains an awaited hook boundary. After it returns, the coordinator fetches
   the source again, clears SDK GETs, and reads/validates the entire ordinary
   snapshot again before issuance.
3. Native creation claims a single-use private evidence object, bound to config,
   authenticated source, target, recipe, tenant, task, and issuance phase. Its
   pure validator and claims preparation reuse the same snapshot. Identity
   witnesses into the SDK GET cache expire this authority after cache invalidation
   or writes; there is no independent HTTP-response cache. Without current private
   evidence, native creation uses its existing fresh standalone guards.
4. Native return transfers publication back to the coordinator. After the SDK
   session call **and outer session hooks** return, the coordinator fetches the
   source again and starts a separate fresh SDK phase. It validates all ordinary
   evidence, then checks the returned session's owner, recipe, and tenant.
   Failure revokes the session and scrubs response credentials. Evidence expires
   in `finally`; retaining or copying a context cannot authorize another request.

The snapshot stores immutable strings/tuples, including explicit mapping roles,
literal metadata records, contact-query results, and the selected method. Its
validators perform no HTTP. Raw metadata names and SDK email-verification names
remain literal; alias mapping never merges their cache keys. Cross-recipe email
and phone reservation queries remain mandatory. Provider identity matching stays
exact, and both hashed ledgers are read even when a provider is absent from the
current profile.

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
