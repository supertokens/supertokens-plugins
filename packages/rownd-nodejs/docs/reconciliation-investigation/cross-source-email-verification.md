# Cross-source email verification

Observed snapshot: **2026-09-15**. **9 blocked inputs: 7 with an already-discovered proof owner + 2 needing expanded discovery.** Deferred proof-binding enhancement; none is asserted implemented or currently eligible.

## Current behavior

All nine requested sources have a verified Apple subject but no `verified_data.email`. Their mapped Apple recipes carry the same literal email and are Core-verified. Introducing a passwordless method can inherit verification, so `migration-consolidation.ts` preflight rejects the plan without exact elected-source email proof. Core verification alone does not establish its origin.

Another live enabled source was observed for each input with the exact current email, exact verified Apple subject and `verified_data.email` equal to that email. Current binding accepts only elected-source proof. Supporting another source requires an explicit, freshly validated proof binding, not removing the verification guard.

## Already-discovered proof owners: 7

Exact requested input → observed proof source:

- `user_i8bnh73wjw485g0swg7t4m38` → `user_qj0zulqbh0f2pvmdd2yn9a02`
- `user_zh13nn0nl3ca4j522cjebdtb` → `user_bj2bltzyopyw3jfz70cskrgc`
- `user_r63cytd0fk78btc9la2iy57d` → `user_ki0vj2v2tmzhhy2tbdtxxvxd`
- `user_c5xziu5tg108hdrl8bhv5z0b` → `user_upkifm8gl9l5q3cqnj8tcuva`
- `user_xpkf41hbcu64ef2v10ml3skv` → `user_rmidj5svez1kym8hyk7rtmqn`
- `user_h5p9jb46b1kppwl13g8emjhb` → `user_s7e4rwo8uyqr4w3afxyc4xqz`
- `user_xrftfr86ywi1i6d0tohnmzyw` → `user_lcbvbmwzmne8s84sfsk8w6wr`

Proposed A → B example: `user_i8bnh73wjw485g0swg7t4m38` cannot independently prove its email → bind the exact-email/exact-Apple proof from `user_qj0zulqbh0f2pvmdd2yn9a02` to the specific planned passwordless credential → reassess verification inheritance with fresh ownership and election checks. This arrow denotes a proof relationship, not an instruction to remap to the proof source or elect it automatically.

## Expanded discovery required: 2

- `user_jctfuz3i2lpxcpkt388wkhdo` → additional unmapped proof source `user_ttk013tcgf4kmqvehbaosodz`. Prior mapped Apple source `user_pgw360udce7ksnidfsadaep4` lacks email proof. Same-Apple source `user_m5b2egdgcdeugb944mgdi4dw` verifies a different email and cannot prove this address.
- `user_p9zwupl3zvaf576t7e3zpcjm` → additional unmapped proof source `user_sla8c6wb340rw2oowfa2r3dv`. Prior `user_keejlhx29ogoajyhzeybgoo0` and additional `user_j2zcy8v70y789bv2k5dau9c7` lack email proof.

Proposed A → B: current election set lacks a usable proof source → explicitly discover and validate the additional source → recompute election/activity and membership → bind proof only if the resulting ownership model permits it. These proof sources were absent from dry-run election candidates; email-search results alone do not authorize their use.

## Proofs and acceptance scenarios

- Bind proof-source ID, live enabled state, exact current/verified email, exact authoritative verified Apple subject, target credential and ownership/tenant context into a fresh plan.
- Test an already-discovered proof owner and each expanded-discovery shape; recompute election rather than assuming the requested source remains winner.
- Core-verified Apple alone, different verified email, same email with different Apple subject, disabled source or missing proof remains blocked.
- Changed proof-source identity, verification, activity, mapping or graph between preview and execution invalidates proof. Include additional-source membership in freshness checks.
- Proof covers only the exact literal address/credential, never unrelated historical addresses or sibling credentials. Confirm no accidental verification escalation after linking/remapping.
- Preview and execution agree on proof requirements; retries retain verifiable provenance and all ordinary consolidation, retirement and session checks.

Source: `remaining19-ses-f5b2-summary.md`, verification proof. See [artifact location](index.md).
