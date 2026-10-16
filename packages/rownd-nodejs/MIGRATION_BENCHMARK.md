# `/migrate` discovery measurements

Measured 2026-09-14 against disposable Docker Core/Postgres fixtures. Baseline:
`4e019cb` (the initial local source differences were formatting and an unused-import
removal). Revised: this working-tree implementation. No production or CSV users
were used.

## Method

- Node 22.22.0, `supertokens-node` 24.0.2, Vitest 1.6.1, macOS Docker.
- Core image digest: `sha256:8302ef1766b05c2b85cbed85de8d6e7fb38dedfe041918327e24e5b33d6f2590`.
- Postgres 14 digest: `sha256:e493b5ef86b5871b26d58203806738f4b3bed1e4ca5eb83a987d917e6b8f7bb7`.
- Each comparison used the same disposable Core for both versions, equivalent
  fixtures with noncolliding IDs, one Vitest worker, two excluded warmups, and
  20 measured requests per scenario. Fixture setup and session inspection were
  outside the timed interval. Timing includes the endpoint response body.
- Core counts intercept actual SDK HTTP fetches, not SDK method invocations.
- Rownd token/profile calls were in-memory SDK mocks. There were **zero remote
  Rownd HTTP requests**. These measurements do not characterize warm/cold Rownd
  caches, remote token validation, or remote profile latency.
- The consolidated alias was prepared through administrative reconciliation;
  its measured requests used the ordinary `/migrate` alias-binding path.

## Core HTTP requests per endpoint call

- Unchanged completed Google + email: **28 → 24**.
- First Google + email import: **31–32 → 31–32**.
- Completed Google owner missing email: **25 → 92**. Baseline incorrectly returns
  success without repairing the missing credential; revised performs the repair.
  These are different amounts of useful work, not equivalent successful repairs.
- Consolidated secondary alias: **144 → 144**.

## Actual latency (milliseconds, p50 / p95)

Baseline-first comparison:

- Unchanged: baseline **36.95 / 43.47**; revised **42.93 / 56.94**.
- First import: baseline **59.06 / 68.54**; revised **91.16 / 104.17**.
- Repair fixture: baseline **35.91 / 47.71**; revised **493.45 / 534.73**.
- Consolidated alias: baseline **126.03 / 167.83**; revised **264.79 / 288.81**.

Revised-first order-control comparison, on a new disposable Core:

- Unchanged: baseline **67.36 / 78.02**; revised **22.80 / 27.62**.
- First import: baseline **110.72 / 122.67**; revised **55.97 / 64.21**.
- Repair fixture: baseline **77.90 / 90.91**; revised **202.33 / 230.21**.
- Consolidated alias: baseline **309.87 / 334.30**; revised **139.89 / 177.65**.

The second version was slower in both orders, including scenarios whose request
counts did not change. Reversing order investigated the apparent unchanged-user
latency increase, but did not establish its underlying host/Core cause. These
small, order-sensitive samples establish the request-count reduction; they do
**not** establish a reliable latency improvement or regression. A controlled
remote-Rownd/end-to-end latency comparison remains outstanding before release.

The temporary benchmark harness was removed after collecting these measurements.
Integration tests provision and clean up their own disposable Core instances.
