# 4. Survivor selection

Observed snapshot: **2026-09-15**. Deferred investigation, not implemented behavior or current eligibility. All 13 inputs were AMBIGUOUS in the source report; direct election inspection found unique Rownd activity winners, not successful reconciliation previews.

## Current behavior

`reconcile-user.ts` ranks SuperTokens (ST) owners before administrative source election: primary, method count, passwordless-email presence, then a unique mapped owner. Two equally ranked mapped owners block before the unique Rownd activity winner can be considered. Selecting a Rownd source and selecting an immutable ST survivor are separate decisions.

## Narrow candidates: 9

### Winner has its own exact mapping: 6

```text
6WuGrLfqlgeaEfb5iylZfC6vjbi2
fwy8eotJ6Xfufcw6wC1s1djwWPA2
gXjd0d2aFtVp8G2tjA8o6r1LIqJ2
user_oyj5j3cjll6y03cawuo3kn3g
user_gu8fc8zm40gh6sgdeuvfo8cn
user_pc87c7w0avjlvz2bjq77qy7i
```

Proposed A → B: structural tie → elect the shared-current-identity source, then prefer its proven tied owner. Example: `6WuGrLfqlgeaEfb5iylZfC6vjbi2` wins by activity and maps to Apple `d8100132-c3f6-4990-9250-8b961b87db40`; competitor `tvLTSaSEicYLb7RQzbnGfR8uBaG2` maps to Google `d19a8a7b-1ddb-43f6-8d79-ba8a69325fd4`. Both rank `[0,1,0]`. The proposed survivor is the winner's Apple owner. The Google credential is unverified, so downstream verification remains a separate check.

### Ownerless winner has one exact current provider anchor: 3

```text
user_ykswxfhve0uhb04axm8kyrhd
user_vl5j2rso99kqcv0fraygj7pw
user_l8xufo97wh9eaz6e5l51wrja
```

Proposed A → B: ownerless elected source plus tied Apple/Google owners → select the only owner matching its current provider subject. Example: `user_ykswxfhve0uhb04axm8kyrhd` matches Apple alias `user_m1nltl0dc4js5ahgah5wxkdy` / `fb423f84-5bf9-45e8-8e48-13e3c04763ca`; Google alias `user_vau7ukjiybencsvqe0pnzsbt` / `467718c9-6615-4bb2-bc72-1ebf32fce8a9` shares email but is not that provider anchor.

## Separate policy decision: 4

```text
user_q9m3vdzkq01vylpvg5t17uw9
user_dqq8p35cgiq83wm5az6cvxi7
user_wikkem9iy5h8bnn7pjoniu8y
user_ivum4gy5w53mtsvyqkp4ghag
```

Each ownerless winner matches both independently mapped provider owners. Example: `user_q9m3vdzkq01vylpvg5t17uw9` matches Apple `995389d1-3210-4588-b02b-7a5a6f801d78` and Google `3c573156-b34d-4666-951c-3a0263d4b7f6`. A unique source does not choose between these immutable IDs. Required A → B is an explicitly agreed survivor policy followed by validated consolidation; UUID, creation-time or provider ordering is not identity proof. These four are not in the nine-candidate extension.

## Proofs and acceptance scenarios

- Revalidate shared current identity, strict activity election, literal mappings, provider subjects, tenant membership and full owner graph before publishing a plan.
- Mapped winner and unique-provider-anchor cases select only the proven tied owner; requesting an older alias does not change the elected source.
- Both-provider matches remain ambiguous without a deliberate policy; missing or changed anchors fail closed.
- Mapping, activity, identity or graph changes between preview and execution invalidate the pinned decision.
- Preview/execution agree on consolidation, alias retirement, exact-source verification and session handling. An election success alone must not report end-to-end eligibility.

Source: `ambiguous-f5b2-report.md`, sections A1–A3. Source artifact location is listed in [the index](index.md).
