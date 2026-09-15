# Deferred reconciliation investigations

Observed snapshot: **2026-09-15**. These documents record proposed work and evidence requirements, not implemented features or current eligibility. Source investigations used read-only observations and dry runs; they were not one atomic global snapshot. Revalidate before any future implementation assessment.

- [4. Survivor selection](04-survivor-selection.md): 9 narrow candidates; 4 separate policy cases.
- [5. Interrupted recovery](05-interrupted-recovery.md): 16 = 12 legacy + 2 stale graphs + 2 handoff markers.
- [6. Instant primary / authenticated secondaries](06-instant-primary-authenticated-secondaries.md): 2 narrow candidates; 2 separate-owner cases outside that scope.
- [7. Orphan mapping recovery](07-orphan-mapping-recovery.md): 2 candidates; 2 insufficient-proof cases.
- [Cross-source email verification](cross-source-email-verification.md): 9 = 7 existing proof owners + 2 requiring expanded discovery.

Total: **46 distinct requested CSV IDs**, including the explicitly separated policy/out-of-scope/insufficient-proof cohorts. Example aliases, proof sources and ST target IDs are supporting evidence, not additional cohort members. Counts describe investigation cohorts, not successful recovery predictions.

## Source artifacts

Reports under `/private/var/folders/5r/6bl83v_92vg_zgq58303jlc00000gn/T/opencode/`:

- `ambiguous-f5b2-report.md`: survivor selection and instant provenance.
- `std-generic34-20260915-report.md`: legacy and stale-graph recovery.
- `remaining19-ses-f5b2-summary.md`: handoff markers, orphan mappings and cross-source verification.

Requested cohort IDs and counts were checked against these reports and repository-root `std_failed.csv`. Original CSV statuses need not equal later report results. Source-code behavior described here is the reported snapshot; concurrent implementation work may change it. These documents contain IDs and sanitized evidence, no credentials.
