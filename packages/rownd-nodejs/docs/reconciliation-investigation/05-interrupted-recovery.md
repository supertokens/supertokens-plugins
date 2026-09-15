# 5. Interrupted recovery

Observed snapshot: **2026-09-15**. **16 blocked inputs = 12 legacy checkpoints + 2 stale graphs + 2 handoff markers.** These are deferred recovery investigations, not implemented recovery or current eligibility. The first 14 come from the generic report; the final two come from remaining19.

## Legacy v1 LINKING: 12

```text
user_uoqwbc30yxjqtay2beazve93
user_kbipuhkyj52ruqhl9z7mkdj4
user_ps13srxjokffwwk8hugk4oj9
user_g130tb2lnb40oo3em6olw8hw
user_tkpxov72i33sahmidmjj6w0l
user_hnljbul2y5cvkpmqlw8mdw2b
user_kd317kq2ibdqb55wt21yfhm5
user_ckrqn1bogi5akxvv4o6z8wx7
user_q2fy1yady5tjt9djjidbewmz
user_chz9b3hjws46t7dwa6hccxjv
user_m11cc8m4l0o0w6owtac2qwpo
user_xcr7junlrs7np0n41lpd36zm
```

Current: `migration-consolidation.ts` rejects v1 `LINKING` before graph inspection. Each checkpoint has two members; read-only inspection found both recorded immutable identities still matching and resolving under the pinned primary winner.

Proposed A → B: stranded v1 checkpoint → validated pinned recovery plan → resume remaining operations. Example: `user_ps13srxjokffwwk8hugk4oj9` maps literally to secondary `897ba2b4-0a83-4024-bd46-2b5bb82856f5`; it and winner `user_xp9adnnthcxrje5jcbdm1d17` already resolve under `4eaa02af-4d92-4cc6-ab94-1c706f2b0f48`. Validate that linked state rather than merely changing status to COMPLETE.

Needed: recorded literal mappings, recipe/email/phone/provider identity, tenants, fresh source election, verification baselines and every extra method. Existing linked state does not prove all postconditions.

## Stale v2 graphs: 2

```text
user_f77u98m8j3h2jtsmrmg12f3b
user_xtppaopnt8wepxy4rmupbp48
```

- `user_f77u98m8j3h2jtsmrmg12f3b`: winner `user_f2m2exwf8dwopq0pmbniv7cn`, target `8d9f22ba-0d7a-4f7d-8108-149ac8eb12ff`, APPLYING/cursor 0 records only Google. Extra linked unverified passwordless `b616bd97-d779-c3fd-304a-56fc42ad8314` matches the live verified email. Current guard admits extra methods only during RECONCILING.
- `user_xtppaopnt8wepxy4rmupbp48`: winner `user_enefndt4zf0mteqs7s5wx6lo`, target `7b001100-da26-4bd8-b1f4-3fac1379f9bc`, internal RECONCILING/cursor 3 versus alias copies READY/cursor 0. Discovery finds unplanned standalone verified passwordless `4b5a8181-c2df-4f62-8675-461c43a8612f`, exact current email, no mapping or literal metadata.

Proposed A → B: rejected graph drift → receipt/provenance-validated adoption or rebase → re-pinned graph and verification baseline. Establish owner/tenant membership, source stability, operation provenance and authoritative checkpoint state before reconciling copies. Exact email equality alone does not prove an APPLYING operation belonged to the old plan; empty metadata does not prove creation provenance.

## Handoff markers: 2

```text
user_d8hltw1y2t2i2f3vqcf4qpyj
user_xzcddv0wg330azh4tuappyl8
```

- `user_d8hltw1y2t2i2f3vqcf4qpyj`: requested and previous `user_n7ipb1swbjsvbn311sgbxywb` aliases are unmapped. They share verified Apple subject but have different verified emails. Surviving nonprimary Apple `7422e974-1ad8-489a-9073-8717dd89f203` has the older unverified email. Target, reconciliation and superseded markers agree on the requested-source handoff, but state is incomplete. Proposed A → B: conflicting marker block → validated interrupted handoff resume, with explicit current-email and mapping postconditions.
- `user_xzcddv0wg330azh4tuappyl8`: mapped primary `8c139c72-51b0-4440-8d78-dc6175dd751b` has matching target/canonical markers and `migration_complete:true`, but retains reconciliation marker naming old `user_b3r62vpx1cw57pqgz6x44o3s`. Old alias is unmapped/superseded; both share verified Apple/email. Separate Google alias `user_ecin3nzlyf3mw0fix5i1sy78` / `fed7c597-95b3-43fd-a948-5da6e87e5166` shares verified email. Proposed A → B: stale completed-handoff marker → validated marker retirement → fresh consolidation assessment of the Google owner.

Require full marker source/previous/target agreement, literal graph and mappings, identity lineage and actual completion postconditions. Neither deleting all markers nor trusting `migration_complete` alone is recovery.

## Acceptance scenarios

- Recover a v1 already-linked graph only after all pinned identities and postconditions match; changed mappings, missing recipes or tenant drift block recovery.
- Explicitly validate extra exact-current methods; reject unrelated additions and unverifiable operation provenance.
- Exercise APPLYING extras, RECONCILING unplanned owner and divergent checkpoint copies; require deterministic receipt handling and fresh re-pinning.
- Distinguish incomplete unmapped handoff from completed stale marker; reject mismatched targets, remapped old aliases and conflicting live identity.
- Crash/replay after each recovery write is idempotent; preview and execution use the same evidence and reject intervening drift. Verify final aliases, metadata, verification and session effects before completion.

Sources: `std-generic34-20260915-report.md`, legacy/stale-graph sections and supplementary findings; `remaining19-ses-f5b2-summary.md`, conflicting markers. See [artifact location](index.md).
