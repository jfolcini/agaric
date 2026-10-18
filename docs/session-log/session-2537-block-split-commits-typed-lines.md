# Session 2537 — a block Enter splits off commits its typed lines on leave

**Asked:** the maintainer wanted block mode's Enter split to match page mode. Page mode reads a block made by Enter as typed. When the caret leaves it, a `key:: value` line becomes a property, a task marker a task and a `#name` a tag. Block mode left all three as text in the half Enter split off.

**Cause:** `handleEnterSave` creates the new block holding the after-text, and EditableBlock's auto-mount mounts the editor on it with that text. So the leave-time flush's baseline (`originalMarkdown`) is the after-text itself. An unchanged block then unmounts as "no change" and nothing is classified. No commit or comment gave a reason. #5160 D2 (#5172) set the baseline to "the text the editor loaded" for blocks loaded from Source, import or paste, and the split-off half inherited it.

**Fix:** after the split, `handleEnterSave` flushes `setFocused` (`flushSync`), so the auto-mount has run. `readSplitOffAsTyped` then rebases the baseline to `''` (`markCommitted('')`), but only when that baseline makes the after-text a `checkbox`, `property` or `tag` classification. Plain text keeps the loaded baseline, so leaving it writes nothing. Several paragraphs keep it too, so they stay one block, as page mode keeps them. Enter at the start of a block also keeps it: block mode moves the whole text to the new block, while page mode keeps that text in its loaded block. The leave-time rules themselves are unchanged.

**Traps:**
- Mounting the new block directly from `handleEnterSave` loses the caret: React moves the editor's DOM after the mount. Playwright showed the editor not focused.
- Without the `flushSync`, the auto-mount runs after `markCommitted`, which is then a no-op on an unmounted editor.

**Knock-on, as traced:**
- Paste and Enter at the end of a block take other paths and are untouched.
- In-editor undo right after the split has no history either way, since mount clears it.
- A source block's stored properties never reach the new block (`createBelow` copies none), so a line split off becomes its property.
- On a blur leave, `useEditorBlur` Step 3 first re-saves the unchanged text once (its baseline is now `''`), then the property commit runs.

**Ran:**
- vitest over `src/stores`, `src/editor`, `src/hooks`, `src/components/editor` and `src/components/block-tree`.
- `npm run typecheck`, `typecheck:e2e` and `lint`, with no new warning.
- `e2e/block-line-break.spec.ts` plus the keyboard, draft, Escape-after-Enter and property-refusal specs on a private port.
- Each new test was shown red with the guard it covers removed:
  - the baseline reset, for the three typed cases and the Playwright case;
  - the kind filter, for plain text;
  - the start-of-block check;
  - the `flushSync`, in Playwright.
