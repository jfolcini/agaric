# Session 1759 — maintain_pages_cache_counts_after_op, and a guard nothing held

`maintain_pages_cache_counts_after_op` is the in-transaction hook that keeps
`pages_cache.{child_block_count,inbound_link_count}` correct as ops project. It
carried an `#[expect(clippy::too_many_lines)]`; clippy now accepts the file
without one. Workspace attribute count **27 → 26** (anchored grep, both sides).

One helper per reachable arm, which is the shape the match already had:

| helper | what it is |
|---|---|
| `affected_pages_for_create` | the owning page, the `page_id`/`space_id` stamp, the `pages_cache` seed row, the #1548 in-tx link reindex |
| `affected_pages_for_edit` | the block's page, its OLD outbound targets, its NEW content's targets |
| `affected_pages_for_move` | the same-parent reorder early-out, the re-derive, and the subtree ∪ outbound-target CTE |

The cohort arms stay inline: they sit *after* the #2042 early return, so they
are unreachable, and the file says they are kept as the canonical documentation
of each op's count impact. That is a maintainer's call and not a split's to
make — flagged, not acted on.

The move was verified rather than assumed: normalising both files to code lines
only, every difference is structural except five type adjustments the `&str`
parameters require (`parent_id.as_deref()` → `parent_id`, `content.as_str()` →
`content`, `block_id.clone()` → `block_id.to_string()`, the `old_parent_id`
comparison, `src.clone()` → `src.to_string()`). No logic line changed.

## The #2042 guard was load-bearing and unheld

| mutant | result |
|---|---|
| Move: drop the same-parent reorder early-out | SURVIVED — see below |
| Create: drop the page's own `affected` insert | SURVIVED — see below |
| **drop the cohort defer guard (#2042)** | **SURVIVED — 1028/1028 green** |

The third is the real one. Delete / Restore / Purge return early because their
affected set spans an arbitrarily large descendant subtree, and recomputing it
in-transaction holds the single-writer apply lock for the whole walk. #2042
exists because that stalled a user deleting a big page. Removing the guard is
therefore invisible to every existing test: the other parity tests drain the
background handler before asserting, so they see the same final counts whether
the recompute ran inline or was deferred. The counts converge; only the lock
does not.

`cohort_ops_defer_the_count_recompute_2042` calls the hook directly with each
of the three cohort states and asserts a deliberately-wrong seeded count is
left **untouched** — the one observation that separates "deferred" from "done
inline". Against the mutant: 1029 run, 1 failed, the new test alone.

## The two survivors that are not gaps

- **The same-parent reorder early-out** is a performance guard, and its own
  comment carries the argument: no block crosses a page boundary, so the
  committed counts are provably identical either way. Removing it does more
  work and reaches the same state, so no test can separate them.
- **The Create arm's `affected.insert(block_id)` for a page** looks redundant —
  `resolve_owning_page` returns the seed itself when the seed is page-typed, and
  the next line inserts that. It is not: the function falls back to
  `parent_hint` when the seed row is not yet projected, and a page create passes
  `parent_id = None`, so on that path the explicit insert is the only thing that
  adds the page. The path is legacy (the file says so) and untested, which is
  why the mutant lives. Recorded rather than deleted — deleting it would remove
  the only cover for a case nothing else holds.

Pattern worth keeping: a surviving mutant has three quite different causes, and
saying which one applies is the whole value. Here it was one real gap, one
provable equivalence, and one untested legacy path.
