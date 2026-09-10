# Session 1667 — six splits in `history.rs`, and one kept on purpose

#4639 asks for the `#[expect(clippy::too_many_lines)]` markers to go, one
function at a time, where a split genuinely clarifies. The maintainer's status
comment put the count at **126** and named `commands/history.rs` — seven
markers in one module — as the natural next slice. Re-derived before starting:
126. After: **120**.

## Why these six

Each had a seam that was already there:

- `reverse_move_block` — build-then-write: settle the SQL slot, reproject the
  source group, converge the engine. Three steps, three functions.
- `apply_reverse_in_tx` — a long `match` whose arms are independent per op
  type. It is a dispatcher now, and each arm can be read against its forward
  `apply_*_via_loro` twin. The three-line `DeleteAttachment` arm stayed inline.
- `revert_ops_in_tx` — compute, plan the order, apply. The middle step
  (`plan_reverse_apply_order`) came out pure and **gained tests**.
- `restore_page_to_op_inner`, `undo_page_op_inner`, `undo_page_group_inner` —
  each was one large query and then the act on it.

## Why the seventh stays

`verify_undo_targets_in_tx` is one `query!` whose anonymous row type feeds
three sequential checks. Splitting it means inventing a named row struct or a
six-argument checker purely to move lines. It is already one query and one
decision list; the marker is the honest description.

## Extract, do not rewrite

Every extraction is a verbatim move — same order of operations, same early
returns, same error paths, same `drive_reverse_engine` closures, same log text.
The only mechanical adaptations: `&mut **tx` → `&mut ***tx` where a helper
takes `&mut CommandTx`, `target_ts` by value, and one two-phase counter that is
now two counts summed.

**Zero deletions in the tests module.** The suite is the oracle for a
behaviour-preserving refactor, and it must not need editing; it did not.

## The pure function's tests, shown red

`plan_reverse_apply_order` sorts a distinct-move group by `(parent, slot)` —
including the pre-#400 `new_index: None` fallback — and keeps LIFO for a
same-block sequence and for a mixed group. Two mutants against a `cp` copy,
restored `cmp`-identical:

- drop the `(parent, slot)` sort → `left: [0, 1, 2]  right: [2, 0, 1]`;
- `.all(is MoveBlock)` → `.any(...)` → the mixed-group test panics.

## Verification

`cargo clippy --workspace --all-targets -- -D warnings` clean — this is the
proof that every removed `#[expect]` was removable: an unfulfilled expectation
is itself a warning, and so is any new function over 70 lines. Full workspace
nextest 6338 passed, re-run after the agent's own pass. No `query!` text
changed, so `.sqlx/` is untouched; no command-surface doc changed, so no
bindings regeneration owed.
