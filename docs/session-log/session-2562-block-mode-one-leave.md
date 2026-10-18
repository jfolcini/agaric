# Session 2562 — block mode commits every typed kind on one leave

**Asked:** make leaving a block in block mode commit its task marker,
`key:: value` lines and `#tags` together, as page mode does, instead of one
kind per leave. Also stop `stripPropertyLines` leaving a blank line where a
property paragraph was.

**Premise, confirmed:**
- `runUnmountFlush` took exactly one branch of split → checkbox → property →
  tag → edit. A new vitest leaving `- [ ] call mom #work` + Shift+Enter +
  `status:: done` saw only `set_todo_state`; the property line and the tag
  stayed text.
- A task paragraph's Shift+Enter break serializes as `\` and a newline; a
  bare newline after a task line parses as a second paragraph and splits.
- Page mode (`commitTyped` in `PageModeEditor.tsx`) runs `commitPageTask`,
  then `commitPageProperties`, then `commitPageTags`, each on the text the
  one before it wrote, each writing its own edit.
- `stripPropertyLines("status:: done\n\nmore text", {0})` gave
  `"\nmore text"`. Its only caller is `commitInlineProperties`, which page
  mode shares.

**Design:**
- `classifyUnmountFlush` still names the first kind the edit introduced;
  its callers only compare against `split` and `edit`. The property and tag
  payloads it no longer needs are gone.
- Past a split, `runUnmountFlush` runs `commitTyped`: the checkbox commit,
  then the property commit on the text it wrote, then the tags on the text
  after that. One `bumpFlushSeq` token covers the chain, and it stops once a
  newer save of the block has started.
- Each step writes through one `write` wrapper. It records the text the
  step meant to write, so a failed write is carried by the next step's
  write. It skips a write of the same text, as page mode's wrapper does.
- A refused task state keeps the marker as text, and the property and tag
  steps still run. The tags still wait for a saved text, as before. The
  outcome is `false` only when the last text write failed.
- The chain is tracked for the empty-block cleanup when it starts with a
  marker or a property. The tag-first case keeps its synchronous text write,
  `invokeSync` and the #1062 dedupe.
- Undo is unchanged: each helper notifies the undo store as its
  single-kind path did, and the writes of one leave fall in one group
  window.
- `stripPropertyLines`: a run of stripped lines that was a paragraph of its
  own takes one blank separator line with it. That is the blank after it, or
  the blank before it when the run ends the block.

**Tests and reds:**
- `unmount-flush.test.ts`, "one leave commits every kind":
  - all three kinds commit. Stopping after the checkbox gave
    `['todo:TODO']` against `['todo:TODO', 'property:status=done']`.
  - a refused state still commits the rest. Building on the clean text
    instead of the text written failed the last-edit assertion.
  - a failed write is carried by the next one. Stopping on it gave the
    outcome `false`.
  - a refused property writes the text once. Without the same-text skip,
    there were three edits against two.
  - a newer save stops the chain. Without the check, `set_property` ran.
- `inline-property-parse.test.ts`: the first, middle, last, two-line and
  adjacent property paragraphs. Without the paragraph rule, the first gave
  `'\nmore text'` and the last gave `'a\n'`. Keeping the blank after a
  paragraph whose last line was the property went red when the rule ignored
  the line before the run.
- `e2e/typed-metadata-one-leave.spec.ts`: paste `- [ ] call mom`, type
  ` #work`, then Escape, Shift+Enter and `status:: done`. Leave the block,
  reopen the page and re-query the block. With one kind per leave, the
  content poll stayed at `call mom #work\` + `status:: done`.
- `e2e/block-line-break.spec.ts`: the paragraph tail now asserts the stored
  `more text`. Without the paragraph rule, it got a leading newline.

**Ran:** vitest over `src/stores src/lib src/editor src/components/editor
src/components/block-tree src/hooks` (14466 passed), `npm run typecheck`,
`npm run lint`. Also the new spec, `page-mode`, `block-line-break`,
`hash-tag-typing`, `checkbox-typing`, `task-paste-wiring`, `property-picker`
and `properties-table-and-refusals` (62 passed).
