# Session 1779 — the #5057 enumeration question, answered

#5057's comment thread carried one open question across two comments and was
about to carry it into closure. It is answered here, and the answer is that
there is no bug.

## The question

> `undo_page_group` refuses `NotFound` when the group is built from
> `move_block` + `delete_block` ops, but succeeds on `create_block` +
> `set_property` — same page, same seed, same depth, and `undo_page_op` at
> depth 0 succeeds on the move/delete ops. So it is specific to the group's own
> enumeration.

It was recorded rather than asserted, with the obvious cause ruled out and no
further claim made. That was the right call, and it is also why the question
survived two comments without being resolved: nobody could close #5057 without
either answering it or losing it.

## It is not the enumeration

`enumerate_undo_group_in_tx` and `find_positional_undo_target` carry a
character-for-character identical `WHERE` — same recursive page-blocks CTE with
its depth bound, same attachment disjunct, same `is_undo`, `is_replicated` and
origin clauses. The group query differs only in projecting its coordinates
through a walk rather than an offset. The measured group size in the failing
case is two: both ops are enumerated.

The structural argument settles it before any test runs. `undo_page_group_inner`
answers `Ok(vec![])` for an empty group and never `NotFound`, so a `NotFound`
from that command can only come from reverse computation.

## The comparison compared two different ops

Depth 0 addresses the *newest* op, which in that seed is the `delete_block` —
and a delete's reverse needs no prior context. The group additionally covers
the `move_block`. Pointed at the move, the single-op path fails with the
byte-identical error. The two halves of the reported comparison were never
looking at the same op.

## What actually happens is deliberate

Reversing a `move_block` has to reconstruct the slot it came from, so
`find_prior_position` scans for an earlier local `move_block` or `create_block`
and refuses when the log holds none. One variable separates the failing shape
from the passing one: whether such an op exists at all. A seed that inserts
block rows directly and appends a move without a create leaves the move with
nothing to reconstruct from.

The control shape passes structurally rather than incidentally. `create_block`
reverses to a bare delete, and `set_property` with no prior value reverses to
`DeleteProperty` rather than an error, so neither performs a placement lookup.
The whole group aborts because the command passes `skip_non_reversible = false`,
its documented interactive contract.

## Why this leaves tests behind

Nothing pinned that refusal at the command level — only the two sites in the
engine that construct the error. Both arms are pinned now, because pinning only
the refusal would leave the next reader with exactly the hypothesis that cost
this thread two comments. The three tests were renamed out of their
investigation names and their header rewritten: they shipped as a diagnosis
harness and now describe a contract.

## One residual, already documented

`find_prior_position` filters replicated rows, so moving a block whose only
`create_block` op is a foreign audit record and then undoing hits this same
refusal, and in a coalesced group takes reversible siblings with it. That is
deliberate (#2549) and is the same amplification the file already calls out for
byte-less attachment deletes (#3706, with its UX follow-up #4249). Not new, not
what the question described, and not re-filed.

Shipped as #5096. #5057 itself stays open: `move_blocks_to_space` remains.
