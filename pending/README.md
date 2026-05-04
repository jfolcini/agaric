# `pending/` — planned tasks from the 2026-05-03 architectural review

Origin: a deep architectural review session run with five parallel investigation subagents, followed by per-task planning subagents and per-task reviewer subagents (planner + reviewer pairs). Each plan was independently audited for hallucinations, exaggeration, and unverified claims; corrections were folded back into the final plan files.

> **These are plans, not commits.** They describe scoped, time-estimated work with explicit cost / impact / risk. Each one is independently approve-able — pick what you want, when you want.

## Index

| ID | Title | Cost | Status |
| --- | --- | --- | --- |
| PEND-01 | Rename `MDNS_SERVICE_NAME` `BlockNotes` → `Agaric` | trivial | ✅ done this session |
| PEND-02 | Rename "CQRS hybrid model" → "event sourcing with materialized views" | S | ready (gated on AGENTS.md edit approval) |
| PEND-03 | Materializer silent-drop fix for global cache rebuilds | M (4-7h) | ✅ done session 658 — migration 0044 (STRICT, `'__GLOBAL__'` sentinel for PK), 7 new RetryKind variants, consumer+coordinator persist on drop, new `bg_dropped_global` counter, AGENTS.md "Backend Architecture" bullet (with user approval). +7 tests; 3455/3455 nextest pass. Filed MAINT-199 — STRICT-hook mis-parses `;` in SQL comments as statement terminator (surfaced during PEND-03 author's workaround). |
| PEND-04 | Threat-model audit — prune stale crypto docs | S (~1h) | ✅ done (bulk session 652; residue purged session 654 — `ARCHITECTURE.md` historical-note rephrase) |
| PEND-05 | Projected-agenda parity test (cached vs on-the-fly) | S (1-2h) | ✅ done session 654 — test landed in `agenda_cmd_tests::projected_agenda_cached_equals_on_the_fly`. `#[ignore]`d on first run because it correctly detected real `.+1w` drift between cached + on-the-fly paths; filed as MAINT-196 in REVIEW-LATER. Re-enable once MAINT-196 ships the projection-path refactor. |
| PEND-06 | Tauri 2 `Channel<T>` adoption for streaming progress | M-L (10-19h) | ready (revised: reviewer caught the `TransferringFiles` state hallucination, Tier 2 cost +2-4h) |
| PEND-07 | `STRICT` tables policy for new migrations | S (~1h) | ✅ done session 656 — AGENTS.md "Database" bullet added (with explicit user approval), `scripts/check-migrations-strict.mjs` (~69 LOC, pure node stdlib) + `prek.toml` hook entry. Migration-number floor `FIRST_STRICT_MIGRATION = 42` so `prek run --all-files` doesn't false-positive on the 41 pre-policy migrations; FTS5 carve-out via `CREATE VIRTUAL TABLE` skip. All 4 sanity tests pass (clean / bad migration fails / good passes / virtual table passes / prek integration passes). |
| PEND-08 | `tauri.ts` ↔ `bindings.ts` parity pre-commit hook | S (1-2h) | ✅ done session 654 — script `scripts/check-tauri-bindings-parity.mjs` (~171 LOC) + `prek.toml` hook entry. First-run calibration found 101 bindings / 96 wrappers / **15 unwrapped** (not 5 as the plan estimated): 13 MCP+GCal direct-consumer commands + 2 renamed-wrapper twins (`compactOpLogCmd` → `compactOpLog`, `listAttachmentsBatch` → `getBatchAttachments`). Allowlist pinned. Sanity-tested both `missingNew` (rename detection) and `allowlistStale` paths. |
| PEND-09 | CRDT migration (Loro), merge-layer only | L (3-4 months) | ready as a **planned spike + multi-phase migration** (revised after reviewer caught a 612-vs-559 reference count, optimistic timeline, missing risks; timeline now 11-15 weeks) |
| PEND-10 | iroh transport adoption (replaces mDNS+WebSocket+TLS+TOFU stack) | L (3.5-5 months) | ready as a **planned spike + multi-phase migration** (revised after reviewer caught LOC undercount of ~87% — actual delete is ~14.6k LOC including test files, not ~7.8k; timeline 14-19 weeks; 13 risks + 13 open questions; iroh post-1.0 status is the headline kill criterion) |
| PEND-11 | Space indicator redesign (thin top stripe + sidebar picker only) | — | (out-of-band plan, separate UX track) |
| PEND-12 | build.rs codegen for space-filter SQL fragment (unblocks MAINT-172) | M (7-11h) | ready (revised after reviewer caught: site count was 16 not 20, `include_str!`+sqlx composition needs Phase 0 spike, bind indices 2-8 not 1-8, hook false-positive risk on comments/tests) |
| PEND-13 | Drift test for `page_id` ↔ `space` consistency | S (1.5-2.5h) | ✅ done session 655 — `page_id_space_drift_audit_per_block` + `page_id_space_drift_audit_after_lifecycle_ops` landed in `src-tauri/src/integration_tests.rs` (+441 LOC); both pass on first run (no drift surfaced — confirms invariants currently hold); 3 helpers + shared `run_drift_audit` use `sqlx::query_scalar!` so .sqlx cache catches future SQL drift; all recursive CTEs filter `is_conflict = 0` + bound `depth < 100` per AGENTS.md invariant #9. Conflict-copy fixture deferred per plan open-question #2. |
| PEND-14 | Native `boolean` value type for property system | M (6.5-8h) | ✅ done session 657 — migrations 0042 (`value_bool` column) + 0043 (CHECK constraint allowing 'boolean', STRICT per PEND-07). `setProperty` IPC refactored to `SetPropertyArgs` bundle (forced by specta's 10-arg cap); frontend wrapper insulates 12 production callsites. Tech reviewer caught + fixed `reverse/property_ops.rs` dropping `value_bool` on undo. UX reviewer caught + fixed Checkbox 16-20px touch-target violation (44px AGENTS.md floor) via local hitbox wrapper. Systematic Checkbox primitive fix tracked as MAINT-197; indeterminate-for-null option tracked as MAINT-198 (needs user signal — reverses plan's open-question #1). |
| PEND-15 | Hard space separation — no cross-space links | L (7-12 weeks) | ready (revised after reviewer caught: critical sequencing constraint with PEND-09 — Phase 1 MUST land before CRDT cutover; severance Option (a) struck, Option (b) mandated; tag-scoping migration sub-phase added; `set_property` ref-type validation specified; cost upgraded from 4-8w to 7-12w) |
| PEND-16 | Daily-journal double-block render race | — | (out-of-band bug fix, separate track) |
| PEND-17 | Block history sheet — visible diff-nav + restore-with-preview | — | (out-of-band UX plan, separate track) |
| PEND-18 | `SpaceId` newtype + `SpaceScope` enum (lift Spaces enforcement into the type system) | M-L (9-15h) | ready (revised after reviewer caught: call-site count, mirror-target shape, missing specta+sqlx Phase 0 spike, test-fixture migration, IPC↔frontend coupling, sequencing-with-PEND-12) — renumbered from 11 due to id collision |
| PEND-19 | `RecentPagesStrip` redesign — visible chip chrome + tighter geometry | S (1.5-3h) | ready (UX polish, visual-only, no data path; out-of-band — separate UX track) |
| PEND-20 | SQL / perf review findings (post-validation) | mostly S, one M (G), one trivial bundle (A) | ready (8 actionable bundles A-H + 10 LOW items mostly accepted; sync-merge `json_extract` excluded — superseded by PEND-09 CRDT migration) |
| PEND-21 | Structural breadcrumb — icon-button affordance + drop redundant exit-zoom button | S (1-2h) | ready (UX polish on `Breadcrumb` icon triggers + `BlockZoomBar` dedup; out-of-band — separate UX track) |

## Recommended order

**Quick wins first** — schedule when convenient, low/no dependencies:

- PEND-01 (mDNS BlockNotes→Agaric rename) — ✅ shipped (commit 5db55af, session 652)
- PEND-02 (CQRS naming rename) — ✅ shipped (commit 27ca079, session 652)
- PEND-04 (stale crypto docs) — ✅ shipped (bulk: session 652; residue: session 654)
- PEND-05 (agenda parity test) — ✅ shipped session 654 (test `#[ignore]`d, drift filed as MAINT-196)
- PEND-08 (parity hook) — ✅ shipped session 654
- PEND-13 (`page_id` ↔ space drift test) — ✅ shipped session 655
- PEND-07 (STRICT tables policy) — ✅ shipped session 656
- PEND-14 (boolean property type) — ✅ shipped session 657 (followups: MAINT-197 + MAINT-198 in REVIEW-LATER)
- PEND-03 (materializer silent-drop fix) — ✅ shipped session 658 (followup: MAINT-199 STRICT-hook bug)

**Mid-tier** — useful but more invasive:

- PEND-06 (`Channel<T>` adoption) — Tier 1 sync progress first (~6-10h), Tier 2 file transfer later (~6-9h)
- PEND-20 (SQL / perf review findings) — bundle A (index hygiene migration) is ~1h and lives in the quick-wins tier on its own; bundles B/F/H are also <1h each. The remaining bundles (C/D/E ~ 1-3h each, G is 3-5h) are all independently approve-able. Excludes the sync-merge layer (superseded by PEND-09).

**Spaces enforcement bundle** — sequential, NOT parallel (touch the same `_inner` signatures):

- PEND-18 (`SpaceId` newtype + `SpaceScope` enum) — 9-15h. Has a Phase 0 specta+sqlx spike.
- PEND-12 (build.rs codegen for space-filter SQL, unblocks MAINT-172) — 7-11h. Has a Phase 0 `include_str!`+sqlx spike. Lands AFTER PEND-18 to avoid merge conflicts in shared `_inner` files.

**Out-of-band tracks** (planned in parallel by the user, separate from this session's bundle):

- PEND-11 (space indicator UI redesign), PEND-16 (journal double-block race fix), PEND-17 (block-history diff-nav + restore-with-preview), PEND-19 (`RecentPagesStrip` redesign), PEND-21 (structural breadcrumb icon-affordance + exit-zoom dedup). These were authored in separate sessions and don't share dependencies with the type-system / spaces-enforcement bundle. Schedule independently.

**Strategic** — independent decisions with multi-phase timelines:

- PEND-15 (hard space separation, no cross-space links) — 7-12 weeks. **Phase 1 MUST land before PEND-09 Phase 2 cutover** (avoids CRDT engine producing fresh cross-space refs from concurrent edits that one-shot severance would never see).
- PEND-09 (CRDT migration via Loro) — 11-15 weeks. Start with 2-week time-boxed Phase 0 spike. Don't commit to Phases 1+ before the spike report. **Phase 2 cutover gated on PEND-15 Phase 1 completion.**
- PEND-10 (iroh transport adoption) — 14-19 weeks. Start with 3-week time-boxed Phase 0 spike. Headline kill criterion: iroh's current version + wire-format stability stance.

**Recommended sequencing of the strategic trio:** PEND-15 Phase 1 → PEND-09 (CRDT, transport unchanged) → PEND-10 (iroh, post-CRDT). The hard constraint is "PEND-15 Phase 1 before PEND-09 Phase 2 cutover"; PEND-10 sits anywhere outside that pair. Combined calendar, sequential: **~30-40 weeks of focused engineering** — most of a year for a solo maintainer. **Don't pursue more than one strategic item in parallel.**

## Workflow notes

- Each plan is self-contained. Read its file before starting.
- Reviewer corrections are folded into the body of each file (with reviewer attribution where it surfaced a real bug — e.g. PEND-03's SQL constraint, PEND-05's horizon-drift gap, PEND-06's `TransferringFiles` hallucination, PEND-09's reference-count undercount).
- Cost / Impact / Risk live near the bottom of each plan. Review those three before deciding to schedule.
- When a task is done, **delete its file from `pending/`** (matching the REVIEW-LATER.md convention of "delete on completion, no historical record"). Land the work in a normal commit; the git history is the audit trail.
- If a task is started but not finished, leave the file in place and add a short status note at the top.
- Tasks that get rejected: also delete the file. Don't keep "rejected" plans around; that's documentation rot.
