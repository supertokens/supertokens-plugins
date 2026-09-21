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

## Completed migration shortcut

The migration entry point now branches after its first fresh snapshot and existing
completeness classification. Eligible requests return through a read-only
completed-session path before either lifecycle repair or migration repair runs.
The benchmark fails if either executor is called on an unchanged fixture.

| Operation | Core cache-only → shortcut | Mapping cache-only → shortcut | Rownd fetches |
| --- | ---: | ---: | ---: |
| Stable email, either route | 81 → 67 | 29 → 22 | 5 → 4 |
| Stable provider, either route | 87 → 70 | 33 → 25 | 5 → 4 |

First migrations (138/148), provider replacement (237), and retained historical
aliases (391) retain their measured budgets. The shortcut removes the second full
snapshot and both lifecycle passes. It shares the collected raw metadata when
combining provenance rather than fetching those records again.

Eligibility requires a mapped, primary, complete target; authenticated exact
source profile matching stored provenance; current source identities and tenant
memberships; verification and canonical-email agreement; no unexpected current
methods; and clean provider, pending-email, and operational-marker checks across
the target, source ID, and linked recipe IDs. Provider ledgers are checked even
for providers absent from the current source. Email/phone discovery still searches
Core for foreign cross-recipe reservations.

Immediately before issuance, a new source read and SDK read phase revalidate
bidirectional mapping, the literal source tombstone, source-ID collisions,
completion evidence, contact reservations, and the selected method's ownership.
After session hooks, the same full validator runs again, including completion,
all expected methods, primary ownership, clean ledgers, and contact reservations;
failure revokes the returned session and scrubs response credentials. The four
source reads are route normalization, initial inspection, pre-issuance, and
post-issuance. No authenticated source is inferred from user context.

Cancellation after issuance synchronously scrubs credentials and detaches the
request session, then attempts revocation for at most five seconds. Repeated
cancellation does not restart that deadline or replace the original
`CancelledError`. Revocation failure or timeout also preserves cancellation;
remote deletion cannot be guaranteed when Core does not complete revocation.

Conservative exclusions: app variants, custom schemas, any email-retirement
ledger, unknown operational markers, and requests already recovering from a
mutation error use the existing guarded executor. The shortcut does not add a
cross-request cache or optimize the retained-alias route.
