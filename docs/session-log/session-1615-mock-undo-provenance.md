# Session 1615 — the mock's undo provenance was a naming convention (#4868)

Found while making #3824's symbolic-op-coordinates decision, which turns on
whether the two stacks' op sequences line up. They did not, and the reason was
not subtle: the backend documents the rule the mock was breaking, in the doc
comment of the function the mock is mirroring.

`undo_page_op_inner` (`src-tauri/src/commands/history.rs`):

> "Undoable" excludes reverse ops — those carry `op_log.is_undo = 1` … They use
> a plain `op_type` (e.g. `edit_block`), **NOT an `undo_`/`redo_` prefix, so the
> filter must key on the `is_undo` flag, not the op_type.**

The mock had no such column and encoded provenance in the op type instead —
`undo_<type>`, `redo_<type>`, `revert_<type>` — with a comment asserting that
was equivalent. Three things fell out of it.

## 1. Redo was not undoable

A redo op stamps `reverses_*` while **keeping `is_undo = 0`** — "its effect is
forward-equivalent" (`history.rs:2401`) — so `AND ol.is_undo = 0` admits it and
it occupies a slot in the undoable list. The mock filtered `redo_*` out, so
every depth past a redo pointed one op too far back.

*Victim:* a browser-mode user who undoes, redoes, then undoes again. The
user-visible symptom needs two edits to see, which is also what it took to
write a test that does not pass for the wrong reason — see Falsification.

## 2. Undo rows vanished from history

The reverse row's payload was `{ reversed: target }`, so `opBlockId` returned
`null`, and the two readers that require a block id — `list_page_history`'s
per-page scope and `get_block_history` — dropped every undo the backend lists.
Recorded as a comment on #4865; the fix was always in the write path, which is
where it landed.

## 3. The op type itself differed

Backend `edit_block` + `is_undo = 1` against mock `undo_edit_block`. Any
op-type filter in the History view selects different rows on the two stacks,
and the #763 op-log digest — which compares `op_type` — would diverge the
moment a conformance fixture drove an undo. None does, which is the only reason
this was invisible.

## What changed

`MockOpLogEntry` gains `is_undo`; `pushOp` / `pushOpAt` take it. Four write
sites stamp the **genuine** reverse type with the flag and a real `block_id`:
`undo_page_op`, `redo_page_op` (flag `false` — forward-equivalent),
`revert_ops`, and the ref-addressed `applyUndoForTarget`. `revert_ops` reuses
`reverseOpTypeFor`, which already existed for the ref-addressed path.

Four read sites stop testing prefixes: the two undoable filters,
`resolveUndoTarget`'s reject rule, and `timesReversedNet`.

One thing the flag cannot express: a redo op is `is_undo = 0`, so it is
indistinguishable from a forward op by the flag alone. The backend tells them
apart with `reverses_*` (migration 0101); the mock's equivalent is the
`re_applied` payload stash `redo_page_op` writes, and both `resolveUndoTarget`
and the positional `undo_page_op` now resolve through it. The mock's reverse
rows still carry bookkeeping stashes rather than real op payloads — that is why
the resolution hop is needed at all, and it is the residue this change does not
remove.

## Falsification, including one test that was wrong

Three mutations, each against a copy, each verified to have actually applied
before its result was read — the first attempt produced two false "covered"
results from mutations that silently did not match after `oxfmt` reflowed the
code.

- **undo push drops `block_id`** → the history-listing test reddens. ✓
- **undo push keeps the `undo_` prefix** → the two genuine-type tests redden. ✓
- **redo ops excluded from the undoable list** → *passed*, first time round.

That third one was the interesting failure. The original test did
edit → undo → redo → undo-at-depth-0 and asserted the content came back to
`'original'`. It does — in **both** worlds, because depth 0 resolves to the same
op either way. An assertion true for two reasons hides a dead fix.

Rewritten with two edits and depth 1, where the two worlds genuinely part:
undoable is `[redo, edit→v2, edit→v1]` correctly and `[edit→v2, edit→v1]` under
the bug, so depth 1 reverses the second edit (`'v1'`) or the first
(`'original'`). The mutation now reddens with exactly that:
`Expected "v1", Received "original"`.

## Verified

- `npx vitest run` over the whole frontend estate: **823 files, 18,965 passing**
  (1 expected-fail, 37 skipped).
- `npm run typecheck` clean.
- The pre-existing `undo-op-refs.test.ts` assertion `op_type === 'undo_edit_block'`
  was pinning the defect; it now asserts the plain type plus the flag.
