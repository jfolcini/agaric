# Session 1112 — list-item hardBreak round-trip + per-frame serialize coalescing

Two deep-review editor findings, shipped together (disjoint files, both in the
block-editor markdown path).

## #1885 — list-item hard break / continuation lost on round-trip (correctness)

A `listItem > paragraph[text, hardBreak, text]` (Shift+Enter inside a list item)
serialized to `- foo\` + newline + `bar` — the trailing odd backslash is the
hard-break marker, and the continuation line `bar` sits at column 0. The
top-level `parseParagraph` already honours that marker, but the list-item path
(`collectListItem`/`buildListItem`) did not: it only collected *indented* nested
lines, so `bar` fell through to a separate top-level paragraph and the hard break
was lost. Serialize → parse was not a fixpoint.

**Fix (parser-only; serializer unchanged):**
- New `parseHardBreakLines` helper emits the item's inline content, inserting a
  `hardBreak` node between successive lines and stripping the trailing backslash
  from each non-final line — symmetric with `parseParagraph`.
- `collectListItem` now consumes trailing-odd-backslash continuation lines into
  the item's `textLines` (before the existing nested-indent loop, so #1513
  nested-list dedent is preserved).
- `buildListItem` parses `textLines` via the new helper.

Negative case preserved: a plain unindented line after a list item (no trailing
backslash) still splits to a separate top-level paragraph.

## #1890 — per-keystroke full-document serialize (performance)

`handleEditorUpdate` serialized the whole active-block document to Markdown on
every keystroke — the one FE perf path the React Compiler can't memoize (it runs
in an editor `update` handler, not render). Now coalesced to once per animation
frame: the handler schedules a single `requestAnimationFrame` and reads
`editor.getJSON()` at flush time (last-write-wins per frame; the final keystroke
is never dropped).

The frame is cancelled on every teardown path:
- `unmount` detaches the listener then cancels the pending frame (its own
  dirty-check delta is computed independently, so no content is lost).
- A component-unmount effect cancels on host teardown.
- **`mount` also detaches the listener + cancels at its start** — the doc-swap
  hardening: `mount` is reachable without a preceding `unmount` (the consumer
  only unmounts when a block is already active), so a stale frame and a
  still-attached listener could otherwise serialize the newly-swapped document
  against the outgoing block's callback (and stack a duplicate listener). Caught
  by the adversarial reviewer.

## Verification

- `markdown-parse.test.ts` + `use-roving-editor.test.ts`: 154 passed (new
  round-trip + coalescing + doc-swap-race tests included).
- Broader editor suite (62 files): 2535 passed.
- `tsgo -b --noEmit`: clean.

## Review

Both fixes were adversarially reviewed by separate subagents. The #1890 reviewer
found the load-bearing doc-swap race (mount-without-unmount) that the initial
implementation missed, fixed it, and added a regression test.

Closes #1885. Closes #1890.
