# Session 1784 — a cross-space move left half the ranks behind

#5100. `move_blocks_to_space_inner` reprojected the destination group and not
the source one, so every sibling that sat *behind* a departing block kept its
pre-move `blocks.position` while its dense rank in the source space's Loro doc
had shifted down by one. SQL and the CRDT disagreed about the same group.

## Why it was invisible

SQL is what the UI reads, and SQL still held a total order — just the wrong one.
Nothing looked broken. The damage was latent: disaster recovery reprojects from
Loro (`db/recovery.rs`), so a recovered database would have ordered that space's
pages differently from the one the user had been looking at, and any later
reprojection of the group would have renumbered the siblings under them.

It surfaced only because #5099 tripped the #891 parity guard while pinning
`move_blocks_to_space`, and that PR could not touch backend Rust, so it worked
around the shape instead — ordering its fixture's moves so the departing block
was always last, which is the one case where nothing sits behind it. That
workaround is gone now.

## The fix

`apply_set_property_via_loro`'s `old_space != new_space` arm already took the
old space's engine guard to purge the block from that doc. It now reads the
block's parent *before* the purge, the parent's ordered children *after* it,
drops the guard, and calls the same `projection::reproject_dense_positions` the
destination path already uses — on the caller's connection, inside the move's
own `BEGIN IMMEDIATE`. No new helper, no SQL change, no command-signature
change; about fifteen lines.

The guard is scoped to a block that ends before the `await`, which is not merely
tidy: the guard is `!Send`, so holding it across the await would not compile.

A block absent from the old engine (projected into SQL only) yields no parent,
hence an empty sibling list and no reprojection — matching the purge's own
idempotency on the same input.

## The mock, and why it renumbers per block

The mock previously said the source group was deliberately left alone and that
it matched the backend either way. That stopped being true, so it renumbers the
source group too — but *inside* the per-block loop rather than once after it.

That is not incidental. `hydrate_page_subtree_into_engine` reads the moved
block's `blocks.position` from SQL, which the previous iteration's reprojection
has already rewritten, and `legacy_slot` breaks equal positions on id bytes. So
two blocks leaving the same group can arrive carrying ranks that a single pass
after the loop would not produce.

## What review added

The builder's fixture did not pin that. Its departure ranks were distinct, so
the per-block and one-pass spellings agree on it: the reviewer mutated the mock
to one pass and the whole suite stayed green — 155 passed. A throwaway probe
with adjacent departure ranks and reversed id order showed the backend answering
`Ledger=1, Meetings=2`, which one pass gets backwards.

So the fixture gained a third move, `two_adjacent_departures_tie_on_their_shifted
_rank`, moving two adjacent-rank blocks out of one group. Against it the
one-pass mutant is red. Both `expected` blocks are backend-authored
(`CONFORMANCE_UPDATE=1`), and the regeneration's formatting churn across the
other 58 fixtures was reverted so only this one moved.

The reseeded fixture also pins the *snapshot*, not only the guard: two survivors
sit behind every departure and settle at 1 and 2, where a hole-leaving
implementation answers 4 and 6. Deleting the mock's source renumber reddens the
vitest snapshot at exactly those positions, independently of the Rust guard.

## Verified

With the fix reverted against a copy, the #891 guard fires:

```
fixture 'spaces_lifecycle': SQL/Loro parity failed after fixture setup/op:
block 000000000000000000000000S1 position differs (SQL=Some(4), Loro=3);
parent None is not a purge-gapped group (#891 engine-path guard)
```

Restored, `cmp` identical. `cargo nextest run --workspace -E 'test(spaces) or
test(move_blocks_to_space) or test(conformance)'` — 223 passed. `npx vitest run
src/lib/tauri-mock/__tests__/ conformance` — 50 files, 990 passed.
`npm run typecheck` clean.

Edges checked rather than assumed: only child (empty sibling list, no-op); last
child (ranks unchanged, the `UPDATE` writes nothing — the previously-working
case does not regress); absent from the old engine; and a space block as the
moved block, whose `space_id` is NULL so the arm is skipped, unchanged from
before.
