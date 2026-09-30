# Session 1842 — Edit as Markdown: Cancel confirms, Ctrl+S saves, the save leaves a report (#5160 phase 5-1)

Phase 5, PR 1 of 7: the feedback around the buffer (X2, X7, X8, part of X9). The buffer is still the textarea; later PRs replace it.

**What changed.**
- **Cancel and Escape ask first when the text changed (X7, X9).**
  - "Changed" means the text is not the source it was loaded from, so a restored draft asks too; an unchanged buffer closes at once.
  - The existing `ConfirmDialog`, destructive: focus starts on *Keep editing*, and *Discard* drops the draft.
  - The buffer stops its Escape from reaching any document-level listener, and ignores an Escape that ends an input-method composition, as the block editor does.
- **Ctrl/Cmd+S saves the buffer.** It is the catalog entry `savePageSource`, so it can be rebound. `Ctrl+Enter` still saves until a later PR moves it.
- **A save leaves a report (X2, X8)**, in `PageSourceSaveReport.tsx`.
  - It stays until dismissed when the save deleted blocks, created pages or tags, or has warnings. It then counts the deletes, creates, edits and moves, and lists each warning on its own line. The created pages and tags are links (`PageLink`).
  - Any other save shows *Markdown saved* for the usual few seconds.
  - *Undo* reverts the whole save, with the paste toast's staleness check: once the save is no longer the page's latest undo entry, it says so and reverts nothing. A save that wrote no ops offers no Undo, so it cannot revert an earlier change.
- Docs: `editor.md`, `keyboard.md` (two rows), `FEATURE-MAP.md`.

**Worth knowing.**
- Closing the buffer from inside the dialog left focus on `body`: the dialog's focus trap pulled back the focus that `PageEditor` hands to the page kebab. The dialog now closes (`flushSync`) before the buffer does.
- The backend's warning strings are unchanged. No warning the save can reach still says "during import"; the report now lists them one per line instead of joining them with `; `.

**Verified.**
- vitest, `PageSourceEditor.test.tsx`: 46 passed; 14 are new and 3 flipped. Of those 17, 16 failed before their change (the IME and focus tests on their own run, the rest on the unchanged editor). The one that passed there pins the other arm: Cancel with the text back as loaded closes without asking.
- 18 mutations on copies (no `stopPropagation`, Cancel never or always asks, no Escape, no IME guard, no `flushSync`, Ctrl+S unbound or not prevented, no stale check, no undo, Undo for a save that wrote nothing, the report short-lived or always persistent, counts without deletes, no created names, a tag without `#`, a link to the wrong page, warnings as a success toast). Each failed its test, and every file was restored and `cmp`-checked.
- vitest, the 13 affected files (the page editor, header, menu and link, the keyboard catalog, its drift and Settings tests, i18n parity, the command palette): 827 passed. `npm run typecheck` is clean.
- Playwright, `e2e/page-source-edit.spec.ts`: 8 passed. Its three new or changed specs (Cancel asks, Ctrl+S and the report, Undo from the report) failed against the old editor.
