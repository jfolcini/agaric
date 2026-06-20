# Session 1079 — /batch-issues loop: relative FTS cursor epsilon, batch 27 (2026-06-20)

## What happened

Single focused robustness fix from the overnight `/loop /batch-issues` run, built in
worktree `wt-batch27` and adversarially reviewed.

## Shipped

PR `fix/cursor-rank-epsilon-1598`:

- **#1598** (robustness) — the FTS keyset/cursor pagination used a fixed `1e-9` rank
  epsilon, hard-coupling pagination correctness to bm25's numeric scale: if scores were
  near-equal (or the scale changed), the absolute-epsilon band could skip or duplicate
  rows across a page boundary. Replaced it with a RELATIVE band `1e-9 * MAX(1.0,
  ABS(?3))` (per the issue's recommendation), applied symmetrically to both keyset arms
  (the strict-greater `rank > ?3 + band` and the id-tiebreak `ABS(rank - ?3) <= band AND
  id > ?4`) so the partition stays clean — every row on exactly one side, boundary row
  counted once via the id tiebreak. The `MAX(1.0, ...)` floor prevents band collapse for
  sub-unit ranks. Applied identically to the production query (`fetch.rs`) and its test
  mirror `fts_select_prefix_for_test`. Runtime `query_as` — no `.sqlx` change.

## Key property

Real trigram bm25 ranks are sub-unit (|rank| ≈ 1e-6), so `MAX(1.0, ABS(rank)) = 1.0`
and the relative band equals the old `1e-9` on all current corpora — **zero behavior
change for existing data**. The fix only diverges (favorably) at large rank magnitudes,
the future-ranking-scale scenario the issue flagged.

## Review pass

Reviewer (APPROVE, safe to ship): proved the two arms are mutually exclusive at every
point (no skip/duplicate, boundary row emitted exactly once), confirmed production ↔
test-mirror byte-identity, the zero-regression-on-production property, and the
dynamic-SQL guard / clippy clean (585 tests). It found one real test-quality gap: the
builder's headline "mutation-killer" embedded inline SQL copies, so reverting `fetch.rs`
to the fixed epsilon didn't fail any test (it didn't guard the production path).

## Hardening (this session)

Added `fts_cursor_predicate_uses_relative_rank_epsilon_1598` to `fts/tests.rs`: it pins
the production-mirror SQL (`fts_select_prefix_for_test`, byte-identical to the live
query) to contain `1e-9 * MAX(1.0, ABS(?3))` for both snippet modes — so a future revert
to the scale-coupled fixed epsilon now fails CI. Test passes; clippy clean.

## Notes

- Files: `fts/search/fetch.rs`, `fts/search/cursor.rs` (doc-comment), `fts/tests.rs`
  (builder's 2 tests + the added mirror-guard).
- Branch base is current `origin/main`.
