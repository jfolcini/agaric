# Session 1616 — the reverse type a positional undo stamps (#4868 follow-up)

Review note on #4869, taken as its own change because it is a correctness gap
that PR made observable rather than a tidy-up.

## The gap

`undo_page_op`'s effect chain covers the five block-row op types, and its
`reverseOpType` local was a `let` seeded with `'edit_block'` that each of those
five arms overwrote. Anything else — `set_property`, `add_tag`, `remove_tag`,
`delete_property`, the task-column setters — fell through with the default, so
the reverse row was stamped **`edit_block`** regardless of what it reversed.

That was inert before #4868: the row was `undo_edit_block`, nothing read the
type, and no reader scoped it. #4868 gave those rows the plain type, a real
`block_id` and `is_undo`, which is exactly what makes the label observable —
History displays the row, and the #763 op-log digest compares `op_type` across
the two stacks.

`reverseOpTypeFor` is the shared table this file already imports, it covers all
eleven types, and it agrees with the five arms on every one of them. The local
is gone; the chain now owns only the effect.

Also from the same review: `revert_ops` parsed `target.payload` twice into two
identically-valued locals.

## Falsified

Restoring the `'edit_block'` default reddens the tag test and the two
create_block ones: `Expected "delete_block", Received "edit_block"`. The new
test undoes an `add_tag` and asserts the reverse row is a `remove_tag`, which is
the arm the five-way chain never had.

## Verified

- `npx vitest run` over the mock estate — 43 files, 1105 tests.
- `npm run typecheck` clean.
