# Session 1605 — per-page history was global history in the mock (#3824)

## Three defects in `list_page_history`, not one

The issue named one: no pagination. Reading the handler found it read **none**
of its arguments except `scope` — a grep for `pageId`, `cursor`, `limit` and
`opTypeFilter` across the old body returns zero.

- **`pageId` was never read.** Per-page history *was* global history in browser
  mode. Not in the issue's list, and the larger of the two defects.
- **No pagination.** Returned `{ next_cursor: null, has_more: false }` over the
  whole set. The backend is `ORDER BY ol.created_at DESC, ol.seq DESC,
  ol.device_id DESC LIMIT ?limit + 1` over `Cursor::for_history_full` — a
  **three-slot composite** keyset.
- **`opTypeFilter` was never read**, so a filtered page was filtered by nobody.

## `get_block_history` was not blocked

#3824 frames these as waiting on symbolic op coordinates. That is true of
`compute_edit_diff` and `compute_block_vs_current_diff`, whose inputs are op
coordinates a fixture cannot spell. It is **not** true of `get_block_history`:
its input is a block id a fixture can spell and its output projects fine. It
was a constant `{ items: [] }` for no structural reason, and is now implemented.

## Reusing the paginator rather than growing a second codec

`blocks.ts`'s `CursorLeadSlot` (one lead slot) became `CursorSlot[]` — the
slots a keyset populates ahead of the trailing `id`, which is exactly the
backend `Cursor`'s composite overload. `compareSortKeysDesc` rides the
paginator's existing `compare` parameter. Seven call sites updated; no new
cursor codec.

## What the row token can and cannot say

The comparable vocabulary is `op_type#is_replicated=…`: `device_id`, `seq` and
`created_at` are per-stack identities and `payload` is a blob the token grammar
refuses. So the fixture's ops are chosen to make `op_type` **discriminate** —
B1's subtree ends in a `delete_block`, B4's carries the only `set_property`,
and the paging steps run over B3, whose two ops differ in type. Without that
the steps would pass on any ordering.

## Left waived, with the real blocker named

The `delete_attachment` / `rename_attachment` disjunct cannot be modelled, and
it is not a missing fixture: the mock's attachment handlers
(`handlers/attachments.ts:42-84`) append **no op-log row at all**. There is no
attachment op for the disjunct to admit or reject, so mirroring the SQL would
add a branch nothing can enter. Closing it means giving the mock's attachment
writes an op log — a write-path change to three commands the harness waives
outright. Recorded in the fixture description and both handler comments.

The symbolic-op-coordinates decision is untouched, which is what keeps #3824
open.

## Falsification

Eleven mutations, each against a copy, restored and `cmp`-verified. The ones
that matter: reverting pagination leaks two `edit_block` rows onto page 1 and
makes page 2 re-serve page 1; ignoring `pageId` leaks B4's ops into Alpha's
history; ignoring `opTypeFilter` gains a `delete_block` in two steps; the stub
restored collapses four block steps to `rows: []`; dropping limit validation
turns `error "validation"` into `null`; shortening the cursor slots from
`['deleted_at','seq']` to `['deleted_at']` changes the cursor shape and page 2
never terminates; dropping the DESC comparator returns rows ascending.

The four new unit tests were checked complementary — three red under the stub,
three red under an ignored `blockId`, and no test passes both mutations.

## Note

`CONFORMANCE_UPDATE=1` churned 32 fixtures again — verified `json.loads`-equal
to HEAD and restored byte-for-byte. Fourth session in a row hitting this.
