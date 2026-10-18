# Session 2531

Review notes from #5818, #5822 and #5825, and two flaky tests fixed at their cause.

**`expectAbsent` (e2e-tauri).** It failed in CI with WebKitWebDriver's "Stale
element found when trying to create the node handle" at
`page-alias-undo.e2e.ts:92`. The `$(selector)` in front of the reverse
`waitForExist` is a find made outside any retry, and the alias badge it matched
was leaving the DOM mid-find. It now polls `$$(selector)` inside
`browser.waitUntil`, whose timer retries a poll that throws (webdriverio
10.0.2, `Timer._checkCondition`). The second query after the wait is gone. The
suggested `querySelectorAll` count would have broken the callers: that call
passes an XPath, and most others pass WebdriverIO's `*=` text selectors. The
other reverse waits in `helpers.ts` (the welcome modal, `confirmDialog`,
`chooseSelectOption`) find their element earlier through a positive wait and
poll only inside the wait, so they do not have this shape and are unchanged.
Type-checked only; CI runs it.

**The page-mode property flake.** Both recorded counterexamples type a
`key:: value` line into a block that a peer then deletes before the save.
Page mode keeps the text under a new id, and the leave-time commit, keyed by
the old id, finds nothing to commit, so the line stays text. Then either Enter
splits the line into a new block or a cut pastes it into another block. The
line becomes a property once the caret leaves that block, and the model did
not expect that property.

**Decision: the model was wrong.** The late commit applies
`commitPageProperties`' one rule: a line counts unless the block held its key
before it was changed, and a new block held nothing. It loses nothing: the line
becomes the property of the block that holds it. Block mode commits a pasted
line the same way (`classifyUnmountFlush` against the content the editor
mounted with). Block mode cannot set the property on a peer-deleted block
either: `set_property` takes an `ActiveBlockId`. The model already took this
rule for task markers ("or by an earlier step that could not leave the
block"). Its property check now derives the expected properties from the
block's lines in the same way, for the keys the backend check reads.

One difference from block mode stays as it is, by decision: block mode's Enter
mounts the split-off half as loaded, so a line split off there stays text,
while page mode treats a block made by Enter as all typed.

- Both counterexamples are pinned as `examples`. Against the old model each is
  red: `01NEW…1:assignee => "A #newtagna"` and `01J…1:assignee => "An"`.
- The log's seed and path came from a copy of the file with other runs in it,
  so they do not replay on this file. The pinned examples are the replay.
- Loops (concurrent copies at 1,500 or 3,000 runs, alongside
  `vitest run src/editor/page-mode src/editor/__tests__`): 10,500 runs green
  on the first model fix, plus one failure at run 1,968. That failure came
  from the fix itself: it expected a custom key, `outsideassignee`, that the
  backend check never reads. It is replayed by seed and path, red before the
  key filter and green after. 21,000 runs on the final model, all green.

**`pageModeBlocker`.** The wrapper and its export are deleted.
`use-page-mode.ts` calls `readPageFit`, and its tests now test `readPageFit`.

**#5825's notes (page mode lists).**
- `- ` then Enter: TipTap runs input rules on Enter with the text `\n`, and
  the bullet rule's `[^[]` took it. The block became a bullet holding a hard
  break (stored as a backslash and a newline), and the Enter did not split.
  The rule is now `[^[\n]`. The ordered rule's `(.)` never matches `\n`, so
  it was already immune. Block mode's half is a separate PR. New vitest case,
  red on the old rule: two blocks, the second holding the hard break, where
  three were expected, the second holding `- `.
- Markers on indent and outdent: a vitest case presses Tab on the second of
  two numbered blocks (`1.`, `1.`), then Shift+Tab (`1.`, `2.`). Red with
  `sameItems` ignoring depth: `['1.', '2.']` after Tab.
- `pageTasks` takes `lists` as required. The `null` arm in `PageBlockView` is
  gone, and `pageModeExtensions` draws the checkbox only when it has both
  `tasks` and `lists`, as its one caller passes.
- `docs/features/editor.md`: numbering starts again after a sibling that is not
  numbered, not after any other block. `computeListOrdinals` groups blocks by
  parent, so children nested between two numbered siblings do not restart it.
- `page-mode-fit.ts`'s header no longer breaks mid-sentence.

**Gates:** `npx vitest run src/editor/page-mode src/components/pages`
(1,080 tests), `npm run typecheck`, `npm run typecheck:e2e`,
`npm run typecheck:e2e-tauri`, `npm run lint`.
