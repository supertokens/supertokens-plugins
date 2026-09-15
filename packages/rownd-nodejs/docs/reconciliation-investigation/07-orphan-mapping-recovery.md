# 7. Orphan mapping recovery

Observed snapshot: **2026-09-15**. **4 blocked inputs: 2 recovery candidates + 2 with insufficient replacement-owner proof.** Deferred investigation, not implemented recovery or current eligibility.

## Current behavior

Both external selector and internal mapped-target lookups return no user for all four. These are genuinely absent mapped recipes, not extant linked secondaries. Each has a separate same-email primary; no migration checkpoint proves that primary is the replacement target. Existing mapping checks block reconciliation.

## Recovery candidates: 2

```text
user_kwld5gbw607s11rohli591r4
user_mqvyaaw4sw6tvci93d9hehxk
```

Proposed A → B actions, conditional on a new validated recovery path:

- `user_kwld5gbw607s11rohli591r4`: absent `26c31531-64d5-4eda-b70f-62a0e5a73a1a` → investigate replacement `87dbb89a-c424-4b0a-91f6-261fed71305a`, an unmapped primary with verified Google/passwordless at the current email. Requested source exactly verifies current email. Its `data.google_id` differs from `verified_data.google_id`; the resolver-preferred verified subject exactly matches this primary. Preserve that authoritative-subject distinction.
- `user_mqvyaaw4sw6tvci93d9hehxk`: absent `5f467528-2b5c-40f3-a2a7-9bb9da0aecea` → investigate replacement `eecd2d4b-a6f0-42d5-8df5-b668d7696459`, alias `vEy0oVLsclZbH24NvxfOuRcdWP83`. Requested source has exact email/Google proof matching the primary, which also holds Apple. Existing alias's verified email differs from its current email: its ownership and verification effects require separate validation.

Needed before any retarget: fresh confirmed absence (not a lookup failure), unique exact authoritative provider/email match, all literal mappings and aliases, live enabled source election, immutable recipes, tenants, provenance, verification transitions and alias-publication/session postconditions. Recheck the missing target has not reappeared. Contact equality alone must not authorize deleting or replacing a mapping.

## Insufficient proof: 2, separate from candidates

```text
user_c3prgyfnsblic6rpkxu0ub4z
user_grfib0a2w7cbhtylbaelyx60
```

- `user_c3prgyfnsblic6rpkxu0ub4z`: absent `af5c0cfa-1b0e-4a38-a021-8c42582adfae`; same-email primary `44b28609-18cf-4b61-ba44-2829388d6659` / `user_a6vskqdtohhgi83vd8dtkz8d`. Requested verified email differs from current email and verified Google differs from the primary's subject.
- `user_grfib0a2w7cbhtylbaelyx60`: absent `07f1d71f-d68a-411b-9efb-886fb4e57571`; same-email primary `44054523-e424-4d7b-9ba8-6ff33355df75` / `user_fsuiztepg5od4ffxvqsqshqz`. Requested verified email and Google subject differ from that owner's current identity.

Required A → B: same-email suggestion → obtain independently validated replacement-owner lineage or corrected authoritative identity evidence → reassess. The present observations do not justify either proposed replacement mapping.

## Acceptance scenarios

- Exact authoritative provider/email proof plus unique fresh ownership permits only an explicitly pinned recovery preview; additional owners or contested aliases block it.
- Raw versus verified Google disagreement uses the established resolver; raw contact/subject similarity cannot replace proof.
- Both insufficient-proof cases remain blocked. Existing alias with mismatched verified email cannot silently lend verification to another credential.
- Lookup errors are not absence; reappearing targets, remapped aliases, tenant or graph drift invalidate recovery.
- Crash/retry during explicit alias replacement is idempotent and preserves provenance; preview and execution agree on verification, retirement and session effects.

Source: `remaining19-ses-f5b2-summary.md`, missing targets. See [artifact location](index.md).
