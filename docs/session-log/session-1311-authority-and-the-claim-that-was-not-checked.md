# Session 1311

## Authority, and two claims that did not survive checking

#3908 and #3886 are both about a cache that derives from `page_id`. The fixes are small.
Two of the *justifications* written alongside them were wrong, and both were caught by
trying to falsify them rather than by reading them again.

### #3908 — prevention, not repair

`set_block_page_id_from_parent_in_tx` copies only the parent's `page_id`, while
`resolve_owning_page` walks the whole `parent_id` chain. So a retried `SetBlockPageId`
whose parent stamp is still pending writes `Some(P) → NULL` and detaches a block from its
real page. The issue offered two fixes: seed a `RebuildPageIds` obligation to repair it,
or guard the write so it cannot happen.

Prevention, because the repair is strictly worse: it fixes the row *eventually* while
leaving the block wrong for `pages_cache.inbound_link_count`, for
`COALESCE(b.space_id, p.space_id)`, and for every other `page_id` consumer in the
meantime. The seeded `RebuildPageLinkCache` touches none of them.

### The justification that was false

The guard was documented as: a NULL inherited from the parent means "the parent cannot
tell me yet" and **never** means "this block has no owning page."

That absolute is wrong, and the doc contradicted itself in listing the counterexample —
a **purged parent**. Then the block genuinely is orphaned, `compute_page_id_diff` puts it
in `to_null`, and NULL is the correct final answer.

The fix survives; the reason changes. What makes refusal safe is not that NULL is always
wrong, but that this function lacks the *authority* to decide it:

- `SetBlockPageId`'s only enqueue site is `invalidations_for_op`'s `CreateBlock` arm plus
  its own retry rehydration. No move, delete, or restore path enqueues it. So `previous`
  is always a value `resolve_owning_page` derived authoritatively moments earlier.
- Every path where NULL *is* correct runs an authoritative re-derivation anyway:
  delete/restore/purge fan out task sets containing `RebuildPageIds`, and a move
  re-derives in-transaction via `rederive_page_and_space_ids`, which writes NULL
  unconditionally and never goes through the guarded function.

So refusal costs transient staleness that an authority later corrects. Demotion destroyed
a correct value outright. That asymmetry is the argument, and it is now written at the
guard along with the precondition a future change could break — a second `SetBlockPageId`
enqueue site on a move or delete path, where NULL is intended. Nothing currently pins that
precondition, which is worth an executable guard.

### #3886 — narrowing a fast path

`invalidations_for_op` skips the page-link rebuild when `move_same_page == Some(true)`,
justified by "the roll-up derives from `page_id`". It does not. It derives from
`COALESCE(page_id, parent_id, id)`, so a reparent inside a page-less subtree keeps
`page_id` NULL at both ends — the skip fires — while the key moves from the old parent to
the new one.

`move_same_page_hint(old, new) = old == new && old.is_some()` now carries the stronger
claim the skip actually needs. Checked against the sharp case: a moved block that *is*
itself a page has `page_id == id` by CHECK constraint, so a page move is always
`Some(P) → Some(P)` and its key is stable. The change only ever narrows the fast path, so
it can cost extra rebuilds, never missing ones.

### The second claim that did not survive

The B6 driver was changed to call the production `move_same_page_hint` rather than
mirroring the rule in test code, and both the oracle doc and the proptest comment then
claimed: *weakening that function therefore turns the property red.*

Reverting the helper to the pre-fix `old == new` and re-running B6 left it **green**.

`prepare_chain` reparents every root create and move onto `PAGE_ID`, so B6 never generates
a page-less move at all. Calling production code is necessary for the property to have
teeth, and it is not sufficient — the generator has to be able to reach the shape. Both
comments now say what B6 actually buys: the skip *when taken* is audited, and the page-less
shape is pinned by the dedicated tests, not by the oracle.

The general form is worth keeping: "the test calls the real function" and "the test can
fail if the real function breaks" are different claims, and only the second is worth
anything. The first is easy to verify and easy to mistake for the second.

### What the tests pin

Every new test was demonstrated red by breaking the code it covers, and re-broken
independently rather than trusted from a transcript. The consumer test feeds the
*computed* hint rather than a hand-written `Some(false)` — which is why reverting the
helper reddens it, and why a hand-written constant would have survived. The B6
non-vacuity counter was itself falsified by disabling it (`successes: 0`).

`cargo fmt --check` was red across three hunks and would have aborted the commit.
