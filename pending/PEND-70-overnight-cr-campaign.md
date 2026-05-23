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
| 0 | 01:30 | setup | merge to main done; tree green | wrote this plan; push + PR next | `eb4f96b1` |

## Stop condition

08:00 CEST 2026-05-24. On stop: `prek run --all-files` green, branch pushed, PR
open against `main` with CI passing, ledger summarized. End the loop.
