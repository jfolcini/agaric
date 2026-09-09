# Session 1651 — a reverse row that is only labelled like one

The mock's undo wrote a reverse op whose payload was a bookkeeping stash —
`{ reversed, block_id }` — under the reverse op's real type. #4868 and #4871
had already fixed the *label*; the payload underneath it was still not the
forward payload of the op it claimed to be.

## Why that is not cosmetic

A reverse row that carries a real payload behaves like the op it names:
`applyRevertForOp` over it re-applies the op it reversed, which is how
`revert_ops` and `redo_page_op` reach through it, and an `edit_block` reverse
carries the `to_text` that makes an undo restorable in block history.

With a stash instead, `revert_ops` reached the edit arm and read
`payload.from_text ?? null` — off a payload that has no `from_text` — so an
unguarded revert wiped the content. The stopgap for that was
`isBookkeepingRow`, a guard that turned the wipe into a no-op. A no-op is the
safe half of a divergence, not agreement.

## The fix

`reversePayloadFor(target)` builds the genuine forward payload of
`reverseOpTypeFor(target.op_type)` for all thirteen reversible mock op types.
The stash rides on top of it, because `redo_page_op` and `timesReversedNet`
look it up and payloads are not compared across the stack.

It has to be built BEFORE the revert runs: `set_property`'s inverse needs the
value the op SET, and the mock's forward payload records only the value it
replaced, so the live properties map is the only source.

`isBookkeepingRow` is gone, and `undo_page_op` / `redo_page_op` lost their
duplicated per-type effect chains for the same `applyRevertForOp` core the
ref-addressed path already used — which is what closes the maintainer's
follow-up: a positional `add_tag` undo stamped `remove_tag` while `blockTags`
kept the tag, a `restore_block` undo hit the target row instead of the cohort,
and redo of a property op did nothing. The diff removes 189 lines and adds 125.

## The one asymmetry worth stating

The shapes are not mirrors of their forward twins. `set_property`'s inverse is
another `set_property` whose `from_value` is the value being undone;
`delete_property`'s inverse re-adds the prior value under a `from_value` of
NULL, so that reverting IT deletes the key again.

## Deliberately not done

`reverseOpTypeFor` is untouched. When a `set_property` had no prior value the
backend's reverse is `DeleteProperty` and the mock still labels it
`set_property`. Only the label diverges — the payload makes the effect correct
in both directions — and the type table is #4871's surface, which would need
its own falsification.

## Verification

Five mutations, each against a `cp` backup, each `cmp`-restored:

- un-swap `edit_block`'s `from_text`/`to_text` — 3 red;
- force `set_property`'s reverse `from_value` to null — 2 red;
- let `delete_property`'s reverse keep the prior `from_value` — 1 red, and the
  behavioural half reddens independently of the payload half;
- drop `applyRevertForOp` from `undo_page_op` — 10 of 16 red;
- re-add the `isBookkeepingRow` guard — 12 of 16 red.

Full frontend suite on this tree: 826 files, 19014 passed. Typecheck clean.

The `#4868` stopgap test is deleted rather than kept: its premise was that
reverting a reverse row is a no-op, and that is now false by design.

Closes #4870.
