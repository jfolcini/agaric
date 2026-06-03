# Session 956 — SQL/Rust review batch (overnight)

**Date:** 2026-06-03
**Scope:** Implement every actionable finding from the multi-agent SQL/Rust review
(issues #341–#349), one file-disjoint PR per domain, pipelined against CI.

## What was reviewed → issues

A multi-agent review (10 domain reviewers + adversarial verification) produced 64 verified
findings, filed as 9 GitHub issues under the new `sql` label:

- **#341 (C1)**, **#342 (C2)** — single-finding High bugs.
- **#343 (C4)**, **#344 (C5)** — single-finding High bugs.
- **#345** — correctness follow-ups (C3, C6, C7, C8, C9-cluster).
- **#346** — DB pushdown (P1–P8).
- **#347** — index hygiene + robustness (IX1, IX2/IX3, R1–R5).
- **#348** — maintainability (M1–M7).
- **#349** — testing gap (T1) + stale-doc cleanups.

## PRs (file-disjoint, parallel-safe)

| PR | Branch | Findings | Closes |
|----|--------|----------|--------|
| #350 | fix/sql-cache-group | C1, C2, C9-cache, P6, IX1, R3, R1 (+ skill doc) | #341, #342 |
| #351 | fix/sql-c4-batch-reverse-delete-property | C4, C5, C7, M6 | #343, #344 |
| #352 | fix/sql-crud-dbcore | C3, C9-cascade, P7, purge, C8, R2, R4 | (part of #345/#346/#347) |
| #355 | fix/sql-query-fts | P2, P4, M1, M2, M3, R5, C6, IX2/IX3, docs | (part of #345–#349) |
| #354 | fix/sql-misc-docs | P3, P5, P8, M4, M5, M7, C9-misc, T1, docs | (part of #345/#346/#348/#349) |
| #353 | fix/ci-lint-inherited | (infra) zizmor + lychee inherited-from-main lint | — |

Grouped issues (#345–#349) span multiple PRs; close them manually once all parts merge.

## The ONE deliberately-deferred finding

**P1 (#346)** — backlink negative/broad-filter resolution materializes the whole-vault
complement in Rust and re-binds a multi-MB `json_each(?)` blob. The sound fix is compiling
the filter tree to a correlated `WHERE EXISTS` SQL fragment — a large rewrite of a core
path that the review itself said must ship behind full parity proof. It was left in its
safe state (the existing candidate-threading) and **#346 stays open** with P1 tracked.
Everything else in #346 (P2–P8) shipped.

## Findings consciously NOT changed (per the verification pass)

These were verified as "do not do" and the correct action was the documented non-change:
- IX2: `idx_op_log (created_at, seq)` compound — EXPLAIN-confirmed it won't help; not added.
- "single-scan FTS" simplification — would reintroduce the PEND-69 over-rank starvation bug.
- P6 naive pushdown that dropped `deleted_at IS NULL` — guards preserved.
- `recover_derived_state` OR-guard — kept (both derived tables CASCADE-coupled), documented.
- `conflict_source` doc claims — deleted (columns dropped 0058–0060); no filter re-added.

## Lessons captured in the skill (batch-issues)

Pushing a Rust branch from a **fresh worktree** failed pre-push even for Rust-only diffs:
1. **node_modules** — Phase A `prek --all-files` lints JS regardless of the diff; without
   the symlink, oxfmt's native binding is missing. Symlink from main FIRST.
2. **src-tauri/.env + dev.db** — Phase E `sqlx prepare --check` connects to
   `DATABASE_URL=sqlite:dev.db`; both gitignored, absent in worktrees. Copy from main.

Documented in `.claude/skills/batch-issues/SKILL.md` + `references/pitfalls.md` (PR #350).

## CI-inherited lint failures (fixed in #353)

All PRs initially red on `validate / lint` from two `--all-files`-only hooks on `main`:
- **zizmor** `ref-version-mismatch`: `claude-code-action` `# v1` comment vs tag `v1.0.133`.
- **lychee**: `v2.tauri.app` + `contributor-covenant.org` GHA timeouts.

#353 merges first; feature branches rebased onto the new `main` to clear the inherited red.

## Verification

Every PR: full `cargo nextest run` green locally, `cargo clippy --tests` clean,
`.sqlx` regenerated where macros changed, pre-push hooks passed. New regression tests added
for each correctness fix (C1 split-pool, C2 rebuild parity, C3 cohort, C4 Set;Delete;Set,
C5 >333-op, C9 collisions, R2 query_only, T1 keyset walk, C6 fts dup-scan, P4/P5/P6).
