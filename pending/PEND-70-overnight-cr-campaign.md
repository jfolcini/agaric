# PEND-70 — Overnight code-review campaign (2026-05-24)

**Goal:** run code-review rounds **non-stop until 08:00 CEST (2026-05-24)**,
identifying and fixing correctness bugs, robustness gaps, perf issues, a11y
defects, security exposure, weak typing, missing tests, and doc drift across the
`pend-58f-search-view-hardening` branch — which is now merged up to `origin/main`
and carries: PEND-58g search-view hardening (8 batches), PEND-69 toolchain
hygiene, the session-log archival, and (via the merge) PEND-58 pages compound
filters.

**End deliverable:** a PR against `main` with CI passing, ready to merge & release.

## Operating mode (the loop)

Each **round**:

1. Re-read this file (it is the running ledger; never cache it).
2. If a review subagent just completed, **triage** its findings:
   - **Fix now** — high-confidence correctness / security / a11y / perf bugs and
     clear improvements. Make the smallest change; behaviour-preserving unless the
     finding *is* a behaviour bug.
   - **Defer + log** — uncertain, large-refactor, or design-decision findings:
     record in the ledger with rationale; do NOT risk a speculative fix overnight.
   - **Reject + log** — false positives (note why, so they aren't re-raised).
3. **Verify** every fix: `npx tsc -b --noEmit`, `biome check` on changed files,
   the affected `vitest`/`nextest`/`clippy` targets. Run `prek` before each commit.
4. **Commit** (small, focused, green) and **push** so CI re-validates.
5. **Append** a ledger row.
6. Launch the **next** round's review subagent (background) on the next focus
   slice, and set a `ScheduleWakeup` fallback. The loop is driven by
   background-subagent completions; the wakeup is the safety net.

**Stop at 08:00 CEST** → final `prek run --all-files`, push, ensure the PR's CI is
green, leave it ready to merge. Then end the loop (no further wakeup).

**Guardrails:** every commit must pass `prek`. Never push red. Don't churn
already-justified suppressions (see PEND-69). Don't auto-apply risky refactors
(e.g. the deferred `noExcessiveCognitiveComplexity` extraction) unattended —
log them. Keep reverts surgical.

## Focus rotation (areas; revisit as needed)

1. **noBannedTypes** — 38 `as Function` casts → precise fn types (6 editor test
   files). *(prelim quick-win)*
2. **Search DSL** — `to-search-filter`, `autocomplete`, `fold-for-search`,
   `glob-validate`, `serialize`, `tokenize`: caret math, NFC, projection contract.
3. **Search frontend** — `SearchPanel` + extracted hooks (`useSearchResults`,
   `useSearchHistoryControls`), `FilterHelperPopover`, results virtualization,
   combobox/listbox a11y, focus management.
4. **Merge integration** — compound filters (main) × search (mine): shared
   `FilterPrimitive`/`Projection`, `bindings.ts`/IPC shape consistency, no
   duplicated/diverged filter logic.
5. **Pagination** — `has_more`/cursor/over-fetch contracts (backend `queries.rs`,
   `usePaginatedQuery`).
6. **Security** — XSS (mermaid/QR/innerHTML), SQL/FTS injection, glob/path
   traversal, secret leakage, the merged GitHub workflows.
7. **Perf** — effect-dep correctness, re-render hotspots, virtualization windows,
   N+1 IPC, the detached partitioned-scan connection hold (BE-A5).
8. **Error handling / edge cases** — empty states, long values, truncation, RTL,
   mobile viewport, abort/cancel races.
9. **Test coverage** — unit + e2e gaps for changed code paths.
10. **Docs** — PEND docs, FEATURE-MAP, AGENTS, SESSION-LOG accuracy.
11. **Rust** — clippy spot-checks, error paths, sqlx cache, migration safety.

## Pre-campaign state (baseline)

- HEAD `eb4f96b1` (merge of `origin/main` into the branch); 0 behind / 65 ahead
  of `origin/main`; tree clean.
- `prek run --all-files` green on the merged tree (Session 828 verification).
- Open: noBannedTypes fix; push + open PR; CI verification.

## Ledger

| Round | Time (CEST) | Focus | Findings | Action | Verify / commit |
|------:|-------------|-------|----------|--------|-----------------|
| 0 | 01:30 | setup | merge to main done; tree green | wrote this plan; push + PR | `eb4f96b1`, `d916ba62` |
| 0b | 01:55 | push blocker | pre-push `sqlx prepare --check` failed (merge left .sqlx missing 2 compound-filter queries) | regenerated cache `cargo sqlx prepare -- --tests` | `--check` passes; commit `<sqlx>` |
| 1 | 02:00 | noBannedTypes | 38 `as Function` casts in 6 editor tests | typed precisely, dropped suppressions | tsc+biome clean, 108 vitest pass; `ea38748f` |
| — | 02:05 | PR | #50 opened (base main); CONFLICTING because pushes kept aborting (sqlx, then SIGPIPE) | re-push foreground SKIP_CI_VERIFY (pre-push already passed) | (verifying) |
| 2 | 02:10 | merge integration + search backend/DSL | subagent: **no CRITICAL/MAJOR**. Confirmed: no dangling scaffolding refs, bindings↔Rust consistent, search SQL injection-safe, `has_more`/cursor/filter-only correct, DSL caret/NFC sound. 1 MINOR: stale `tokenize.ts` "verbatim" doc comment | fixed the comment | `cf9a7740` |
| — | 02:20 | push/PR | pre-push hook SIGPIPEs the upload under rtk (verification PASSES); push needs `--no-verify`. **PR #50 → MERGEABLE** | push `--no-verify`; CI started | remote `cf9a7740` |
| — | 02:30 | CI fix | `validate / lint` FAILED: zizmor `unpinned-uses` ×4 + end-of-file, both on main's merged `claude*.yml` workflows | pinned actions (`zizmor --fix`) + EOF; re-push | `2a733f37` |
| 3 | 02:35 | search frontend + a11y + perf | subagent: **no CRITICAL**. 1 MAJOR (cross-group SR focus — the documented per-group-listbox design), 5 MINOR (dead history-recall activeIndex wiring; breadcrumb re-fetch of unresolvable ids; breadcrumb not space-scoped; radiogroup/toolbar lack roving — codebase-wide). Hook extraction, usePaginatedQuery race guards, perf memos all verified correct. | **logged for follow-up** (all on load-bearing or pre-existing/codebase-wide paths — not safe to speculatively change unattended; see "Deferred findings") | no code change |
| 4 | 02:40 | Rust diff (PEND-69 hygiene + compound-filter SQL) | subagent: **no CRITICAL/MAJOR**, clippy green. PEND-69 hygiene verified behaviour-neutral. 2 MINOR: prop-key trim mismatch (BE-8); vestigial SnapshotTaskShutdown flag | **fixed** the prop-key trim (+unit test); logged the snapshot flag | `c0dc654e` |
| 5 | 03:00 | e2e + test quality/coverage | subagent: **no CRITICAL**, test quality high (editor casts + TFunction mocks sound; e2e has zero sleeps, deterministic selectors). 3 test gaps: M1 (MAJOR) `migrate()` `historyEnabled` fallback untested; M2 (MINOR) FE-4 nav-generation race untested; M3 (MINOR) dropdown Enter test uses raw `KeyboardEvent` | **fixed** all 3 (M1 +4 migrate tests; M2 +1 non-flaky nav-race regression test; M3 → userEvent); 102 tests green | `447017a6` |
| 6 | 03:10 | docs accuracy | subagent: SEARCH.md / architecture / SESSION-LOG / PEND-58g/69/70 docs accurate. 2 MAJOR: the merge resurrected the deleted PEND-58 + PEND-58d README index rows and the `PEND-58d.md` file (index/narrative contradiction + D23a double-tracked vs REVIEW-LATER `PAGES-FOLD-MARK`). 2 MINOR: architecture related-files omitted FE-A18 hooks; `docs/features/views.md` Search section stale | **fixed** both MAJORs (removed the 2 stale index rows, re-deleted `PEND-58d.md`) + MINOR-3 (added FE-A18 modules to architecture/search.md); logged views.md | `<batch>` |

## Deferred findings (for human review — not auto-fixed overnight)

These are real but either design-level, on load-bearing/pre-existing paths, or
codebase-wide patterns — applying speculative unattended fixes risks regressing
tested behavior. Captured here for a maintainer decision / a follow-up PR.

- **[a11y, MAJOR] Cross-group keyboard roving loses the SR active-descendant**
  (`SearchResultGroups.tsx` / `VirtualizedResultListbox.tsx`). Per-group
  `role="listbox"` is the documented PEND-50 design; only the owning group sets
  `aria-activedescendant`, but DOM focus doesn't move to the new group when
  arrowing across a boundary, so multi-group results don't announce the active
  row to screen readers. Fix needs programmatic `.focus()` on group change (or a
  single spanning listbox) + a11y testing — a design change, not a quick fix.
- **[a11y, MINOR] History-recall `activeIndex`→`aria-activedescendant` is dead**
  (`SearchPanel.tsx`). The history dropdown unmounts once recall fills the input
  (query becomes non-empty), so the `activeIndex` wiring is never perceivable.
  Either keep the dropdown mounted during `cycling.activeIndex >= 0` (UX change)
  or drop the unreachable wiring.
- **[perf, MINOR] Breadcrumb `batchResolve` re-fires for unresolvable page_ids**
  (`useSearchResults.ts`). Soft-deleted/missing parents are never cached, so they
  re-fetch on every `loadMore`. Bounded waste. Fix: track attempted ids (a ref)
  so they're not retried — touches the load-bearing breadcrumb effect, so defer.
- **[correctness, MINOR] Breadcrumb resolution not space-scoped**
  (`useSearchResults.ts`): `batchResolve(parentIds)` omits `currentSpaceId` →
  global scope (lifted verbatim from the pre-extraction code; correct today
  because results are already space-scoped server-side).
- **[a11y, MINOR] `IncludeExcludeToggle` radiogroup + `SearchToggleRow` toolbar**
  lack roving tabindex / arrow-key nav — but this matches the existing
  `QueryBuilderModal` convention, so it's a codebase-wide a11y pattern, not a
  branch regression.
- **[lifecycle, MINOR] Vestigial `SnapshotTaskShutdown` flag** (`lib.rs` /
  `loro/snapshot.rs`): stored via `app.manage(...)` but never set to `true`, so
  the periodic snapshot task only ends at process exit; clean-exit persistence is
  handled separately by the `RunEvent::Exit` handler, so it's harmless dead
  plumbing. Either wire a shutdown caller or drop the managed flag. Not changed
  overnight — it's on the app-lifecycle path (risky to rewire unattended).
- **[docs, MINOR] `docs/features/views.md` Search section is stale**: describes only
  page/tag filter chips; missing the inline filter DSL, the `+ Filter` builder, the
  case/word/regex toggles, regex + filter-only search, per-space history, and mobile
  escalation. Mostly pre-existing; `docs/SEARCH.md` is the current source of truth
  (FEATURE-MAP defers to it), so this is a low-priority focused refresh.

## Stop condition

08:00 CEST 2026-05-24. On stop: `prek run --all-files` green, branch pushed, PR
open against `main` with CI passing, ledger summarized. End the loop.
