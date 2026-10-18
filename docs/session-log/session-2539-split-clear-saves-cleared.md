# Session 2539

A block that Enter splits off and that reads as typed (#5830) is saved cleared when the user clears it before leaving. #5830 merged before its review's blocking finding was fixed. This is that fix.

**Bug.** `readSplitOffAsTyped` used `markCommitted('')`, which also moved the editor's record of what the block holds to `''`.
- Repro: split `status:: done` off with Enter, clear the new block, then leave by click or Escape.
- Leaving compared `''` with `''`, so `unmount()` reported no change and nothing was written. `status:: done` came back.

**Fix:** the roving editor's handle keeps two values that #5830 merged.
- `originalMarkdown` is the classification baseline. `useEditorBlur`, `persistUnmount`, `useBlockFlush` and the restructure handlers read it as `loaded`.
- `storedMarkdown` is what the block holds. `mount` and `markCommitted` set both values; the new `readAsTyped(untyped)` moves only the baseline.
- `unmount()` reports a change against either value:
  - an untouched typed block still reaches the leave-time commit;
  - a cleared one is saved cleared, and the empty-block cleanup then deletes it.
- These read `storedMarkdown`:
  - the debounced commit's "nothing new" skip;
  - draft autosave's unchanged-on-unmount check;
  - *Discard changes*.

  So a typed split no longer shows "Changes discarded", and doesn't flush an identical draft.

**#5830's non-blocking review notes, also fixed here:**
- *The blur leave's identical re-save.* `useEditorBlur` Step 3 early-persists a block created empty, and decided that from `originalMarkdown === ''`, so a typed split block re-saved its unchanged text before the property commit. It now reads `storedMarkdown === ''`. That check is the whole change to the file, which #5807 is also editing.
- *A property line in a tail of several paragraphs* now becomes the property, and the tail stays one block, as in page mode.
  - Why #5830 left it: against a `''` baseline, a tail of N paragraphs counts as N blocks added, so the flush splits it before any property commit.
  - The baseline is now `untypedBaseline(after)`: one `.` paragraph per top-level block of the tail. It holds no marker, property key or tag, so the classifier's rules are unchanged, and the tail adds no block against it.
  - Plain text still classifies as a plain edit, so it keeps the stored baseline and leaving writes nothing.

**Seen, left:**
- *A property line and a `#name` split off together.* Page mode's `commitTyped` runs the task, property and tag commits in turn, so it makes both. Block mode's flush commits one kind per leave, the first it finds: the property here. `#project` stays text until the block is next edited and left. The one-kind rule covers every typed block, so it is unchanged.
- *A stripped property paragraph leaves a blank line.* `stripPropertyLines` removes the line but not the blank line after it: `status:: done` + blank line + `more text` becomes `\nmore text`, an empty paragraph then the text. Page mode's commit strips the same way. The row's text reads `more text`; whether the empty paragraph shows as a gap was not checked.

**Ran:**
- vitest over `src/stores`, `src/editor`, `src/hooks`, `src/components/editor` and `src/components/block-tree`.
- `npm run typecheck`, `typecheck:e2e` and `lint`, with no new warning.
- Playwright: `block-line-break`, `escape-right-after-enter-cleans-blank`, `escape-keeps-text`, `draft-autosave`, `properties-table-and-refusals` and `block-keyboard-fundamentals`, on a private port.

**Shown red:**
- `readAsTyped` also emptying the stored text (#5830 as merged): the cleared block, in vitest and in Playwright, by click-away and by Escape.
- `unmount` without its typed branch.
- Each reader put back on `originalMarkdown`: the debounced commit, draft autosave and *Discard*.
- Step 3 put back on `loaded === ''`: `edit` called twice, the identical text then the stripped one.
- The tail of several paragraphs, with a `''` baseline and with #5830's rule, in vitest; with a `''` baseline in Playwright, where `status:: done` stayed text.
