# 6. Instant primary / authenticated secondaries

Observed snapshot: **2026-09-15**. Deferred investigation: **2 narrow same-graph candidates**, plus **2 separate-owner cases outside that justification**. All four were AMBIGUOUS; none is asserted eligible or implemented.

## Narrow same-graph candidates: 2

```text
user_ku0zhrlvf2hqyt6x365uc6oy
user_i03v8jkxqz5u50ibqv0z39rb
```

Current: source election requires a current identity shared by every candidate. An identity-less live/stored `instant` primary contributes no key, so election fails even though the authenticated source is already a linked secondary. Preserving the distinction between literal secondary mapping and aggregate owner does not itself resolve this election gate. Canonical preference cannot bypass the shared-key check.

Proposed A → B: identity-less instant alias treated as an independent identity competitor → retain its ownership/provenance binding while electing the sole proven authenticated identity within the same graph.

- `user_ku0zhrlvf2hqyt6x365uc6oy` maps literally to Google secondary `5496ec9a-f04d-4b78-82b1-db814f76ea2e`, already under instant primary `ec3fa6b7-38c0-4c8d-8029-276922803355` / `user_emmdup5ob45ecu86r6ay1sna`. Primary canonical-target marker points to itself. Secondary live/stored verified email/Google agree; activity is `2026-01-04T20:43:11.030Z`.
- `user_i03v8jkxqz5u50ibqv0z39rb` maps to Google secondary `3bd355dc-5607-4a34-af4d-ffc59218f312`, under instant primary `3b4ae736-9cfc-43f5-a700-7c713b6df91e` / `user_uka3csnzf926zfm0giz8csgd`. Authenticated activity is `2025-10-17T01:56:41.671Z`; instant has only created/modified metadata.

Needed: exact literal mappings, existing linked graph/tenant membership, live and stored instant identity absence, authenticated provider/email provenance, primary metadata and freshness. Missing activity alone is insufficient to exclude a live alias. A selected authenticated source must not implicitly rewrite the immutable primary or erase its alias binding.

## Separate owners: 2, outside the narrow scope

```text
user_ys3kzw4m1kr942nqxcyegkh1
user_dfl48w3tnt5g2apq8skudyc9
```

Here the authenticated owner is not linked under the instant primary. That primary holds matching passwordless email; the second case also has an unmapped Google recipe. Stored instant snapshots do not establish their email/provider origins.

Required A → B: separate owner plus contact match → obtain method-origin receipts or define an explicit verified-email consolidation policy → reassess ownership. Same-email discovery does not supply the existing-graph proof used above.

## Acceptance scenarios

- Already-linked authenticated secondary with proven identity-less instant primary can reach full preview under the proposed rule, retaining both literal bindings and the existing primary graph.
- An instant alias with a current identity, arbitrary missing-activity alias, changed mapping or newly separate graph does not receive that exception.
- Canonical metadata, retirement planning, verification and session effects remain validated through execution; stale graph/source evidence invalidates the plan.
- The two separate-owner cases remain blocked by this narrow rule without independently established provenance/policy.

Source: `ambiguous-f5b2-report.md`, C1–C2. See [artifact location](index.md).
