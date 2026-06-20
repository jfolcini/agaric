# Session 1088 — /batch-issues loop: shared (position,id) keyset + drift guard, batch 36 (2026-06-20)

## What happened

Maintainability fix from the morning `/loop /batch-issues` continuation, built in
worktree `wt-1652` and adversarially reviewed.

## Shipped

PR `fix/shared-position-keyset-1652`:

- **#1652** (MEDIUM, maintainability) — the same `(COALESCE(position, sentinel) ASC,
  id ASC)` keyset + cursor + has_more/next_cursor logic was implemented (and had drifted)
  across call sites. Investigation found THREE inlined copies: `list_children`
  (`pagination/hierarchy.rs`), `get_page_inner` (`commands/pages/listing.rs`), and a
  third in `commands/pages/markdown.rs` (export subtree walk).
  - Extracted the shared *logic* into `pagination/mod.rs`: `position_keyset_binds(after)`
    (the cursor-bind destructure) and `split_position_keyset_page<T: PositionKeyRow>`
    (the has_more/truncate/next_cursor assembly via `Cursor::for_id_and_position`), with
    a `PositionKeyRow` trait for `ActiveBlockRow` + `BlockRow`. `list_children` and
    `get_page_inner` now share these (get_page_inner previously hand-rolled the page
    boundary).
  - The keyset SQL itself stays inlined at each `query_as!` callsite — per the #1661
    lesson, no compile-time macro was converted to runtime SQL (`query_as!` needs a
    literal).
  - **Drift guard** (modelled on `space_filter_canonical`): canonical WHERE/ORDER consts
    + a recursive `src/**/*.rs` walk asserting every inlined keyset normalises to the
    canonical shape, with a `≥3`-site floor so a regex break can't silently disable it.
    Covers all three production sites (including markdown.rs, which keeps its own copy
    but is policed).

## Review pass

Reviewer (APPROVE): confirmed `position_keyset_binds` + `split_position_keyset_page` are
byte-identical to both sites' prior inlined logic (same limit+1 over-fetch, has_more,
truncate, next-cursor-from-last-row — no off-by-one; `Cursor::for_id_and_position`
produces the exact prior struct), the `PositionKeyRow` impls use the right fields, and the
drift guard is robust (mutation: dropping a `COALESCE` wrap fails via the `≥3` floor). No
macro→runtime conversion, #646 baseline untouched, markdown.rs committed-diff empty, no
over-reach. It also FOUND a coverage gap — no test walked `get_page_inner`'s subtree path
across a real page boundary (where a `split_position_keyset_page` off-by-one would hide) —
and added a mutation-verified `get_page_subtree_paginates_across_boundary_1652`. 174 tests,
clippy clean.

## Notes

- Files: `pagination/mod.rs`, `pagination/hierarchy.rs`, `commands/pages/listing.rs`,
  `pagination/tests.rs`. No `.sqlx`/baseline change.
- Branch base is current `origin/main`.
