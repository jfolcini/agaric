# Session 1075 — /batch-issues loop: split fts/search.rs god-file, batch 22 (2026-06-19)

## What happened

Second god-file split of the night `/loop /batch-issues` run (batch 22), built in
worktree `wt-fts`, alongside the op_log split (#1659). Pure reorganization of a
production module — public API, SQL, and logic preserved verbatim.

## Shipped

PR `fix/split-fts-search-1660`:

- **#1660** (LOW, maintainability) — `fts/search.rs` (1,380 lines) mixed the tokenizer,
  sanitizer, two pagination engines, partitioning, and FTS5 error mapping in one file.
  Converted it to a `fts/search/` directory module with a thin `mod.rs` facade and 8
  focused submodules: `constants.rs`, `tokenizer.rs`, `sanitizer.rs`, `row.rs`,
  `fetch.rs` (the shared dynamic-SQL builder + executor + FTS5 error mapping),
  `cursor.rs` (pagination engine 1: `search_fts`), `post_filter.rs` (pagination engine
  2), `partitioned.rs`. `mod.rs` re-exports every previously-public item at the same
  path, so all callers — and `fts/mod.rs` — compile unchanged. Logic and SQL moved
  verbatim; only `use` paths, intra-doc links, and cross-submodule visibilities
  (`pub(super)` → `pub(in crate::fts)` where a sibling reads an item) changed.

## Path-keyed guard re-anchoring

- **Dynamic-SQL baseline (#646):** count-preserving — the single runtime `query_as`
  site moved `fts/search.rs` → `fts/search/fetch.rs`; the baseline line was repointed
  surgically (NOT `--update-baseline`, to avoid rewriting unrelated pre-existing drift).
  Grand total unchanged (246 → 246); `check-dynamic-sql.py` passes.
- **Doc citations:** `docs/architecture/search.md` repointed (`MAX_SEARCH_RESULTS` →
  `constants.rs`, `sanitize_fts_query` → `sanitizer.rs`, snippet projection →
  `constants.rs`, overview → the dir). `check-doc-code-paths` passes.
- **`.sqlx`:** empty delta — the FTS query is runtime `query_as`, never in the
  content-keyed cache; no macros moved.

## Review pass

Reviewer (APPROVE): verified every previously-public item is reachable at the same
effective path (`fts/mod.rs` byte-unchanged; `pub(super)` → `pub(in crate::fts)` is
exactly equivalent); SQL strings character-identical (incl. the pre-existing `AS`/`as`
snippet casing, which was NOT changed); zero tests dropped (the real tests live in
`fts/tests.rs`, untouched — `search.rs` had only the `fts_select_prefix_for_test`
helper, moved intact); dynamic-SQL guard 246→246; doc-code-paths green.
`clippy --all-targets -D warnings` clean; nextest 396/396.

## Notes

- Stale-base gotcha: the branch forked at `58dff693`, but `origin/main` (`b5345df8`)
  had since **deleted** `docs/cluster-109-op-log-plan.md` — which the builder had
  edited to repoint a citation. Resolved on rebase by accepting the deletion (dropping
  that hunk); the `architecture/search.md` repoint is kept. The FTS split itself
  collides with none of the intervening commits (none touch `fts/`).
- Files: `fts/search.rs` → `fts/search/{mod,constants,tokenizer,sanitizer,row,fetch,
  cursor,post_filter,partitioned}.rs`; `docs/architecture/search.md`.
