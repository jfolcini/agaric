# Session 1086 — /batch-issues loop: tag fast-path SQL single-source, batch 35 (2026-06-20)

## What happened

Closure of a decision deferred earlier tonight, built in worktree `wt-1661` and
adversarially reviewed. #1661 was first attempted (batch 21) via "Approach 1" — single-
sourcing the fast-path / resolver leaf SQL by converting the resolver's compile-checked
`query_scalar!` macros to runtime `query_scalar(AssertSqlSafe)` — which was REJECTED
(it deletes compile-time SQL validation on a security-relevant resolver and regresses
the #646 dynamic-SQL baseline). This batch resolves it the right way, now made possible
by the #1622 helpers that landed tonight.

## Shipped

PR `fix/tag-candidate-clause-drift-guard-1661`:

- **#1661** (LOW, maintainability) — the #414 fast-path candidate-clause SQL in
  `tag_query/query.rs` (`tag_leaf_candidate_clause` / `prefix_leaf_candidate_clause`)
  was documented to "Mirror resolve_tag_leaves / resolve_tag_prefix_leaves EXACTLY" but
  was an independent hand-written SQL literal duplicating the resolver's leaf SQL — drift
  risk caught only by an output-set parity test. #1622 (merged tonight) had created the
  canonical bare-body helpers (`tag_leaf_subquery_body` / `prefix_leaf_subquery_body` in
  `resolve.rs`) for the And/Or/Not pushdown but did NOT single-source the leaf fast path.
  This change finishes the job: made those helpers `pub(crate)` and replaced the fast
  path's ~30-line hand-written SQL literals with
  `format!("b.id IN ({})", tag_leaf_subquery_body(include_inherited))` (+ prefix
  equivalent). **The duplication is gone** — there is no second copy to drift. Added a
  drift-guard test `fast_path_leaf_clauses_single_source_shared_bodies` pinning the
  single-source invariant. The resolver's `query_scalar!` macros were NOT converted to
  runtime SQL (the rejected Approach 1), and the #646 baseline is untouched.

## Review pass

Reviewer (APPROVE): confirmed result-set identity by an arm-by-arm comparison of the new
vs old fast-path SQL (same UNION arms direct ∪ inherited? ∪ refs, same columns, same
`?` count 2/3 in the same order, same `deleted_at IS NULL` filters — only cosmetic
whitespace after `(` differs); verified the `fast_path_matches_reference_full_matrix`
parity test genuinely exercises the leaf fast path against the compile-checked
`query_scalar!` resolver oracle (mutation: `AND 1=0` on the inherited arm fails it at
`Tag inherited=true`); confirmed no macro→runtime conversion (resolve.rs diff is only two
`fn`→`pub(crate) fn` widenings + doc comments), the #646 baseline diff is empty, and the
new drift guard fails on a 1-char wrapper tweak. 395 tag tests, clippy `--lib -D warnings`
clean, dynamic-SQL guard exit 0.

## Notes

- Files: `tag_query/query.rs`, `tag_query/resolve.rs` only. No `.sqlx` change, no baseline
  change, no result-semantics change.
- Branch base is current `origin/main`.
