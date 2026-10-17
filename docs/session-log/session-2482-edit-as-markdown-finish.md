# Session 2482 — Edit as Markdown: the diff runs once typing pauses

#5696 shipped Edit / Preview / Changes with three acceptance criteria on #5685
left unticked. This session checked each against the code and tests.

**Held already:**
- **Not by colour alone.** `PageSourceChanges` gives every added or removed row
  a visible `+` / `−` gutter and a screen-reader "Added:" / "Removed:", and
  strikes through or underlines the changed words. Its tests assert all of
  them and run axe. Under Playwright `forcedColors: 'active'` the gutter and
  the underline stay legible; the design system has no forced-colors rules to
  extend.
- **The spec.** `e2e/page-source-edit.spec.ts` ("Changes marks what an edit
  added, Preview shows its link as a chip, and Save keeps it") edits, opens
  Changes then Preview, saves, reopens the page and reads the saved block. The
  real-backend save path is `e2e-tauri/page-source-edit.e2e.ts`; Changes and
  Preview run no backend code, so no new wdio spec.

**Fixed: the diff was not lazy.**
- `PageSourceEditor` diffed the text on every deferred keystroke in every
  mode, so Save's change count cost a full line diff each time. Measured with
  jsdiff: a page edited in a few places takes about 1–2 ms at 50,000 lines,
  but a page changed past a thousand lines takes 200 ms or more, per edit.
- The diff now reads `diffedText`, set when typing pauses (the draft saver's
  300 ms debounce) and when Changes opens. The word diff already ran only
  inside the Changes view. A restored draft is diffed from the text it opened
  with.
- `useDeferredValue` is gone. The Save count may trail the buffer by a pause.

**Tests added:**
- `line-diff.test.ts`: CRLF and mixed breaks give the LF hunks with no `\r`
  in a line, a pasted Windows text, trailing line breaks, an emptied buffer.
  The diff was already correct on all of them.
- `PageSourceChanges.test.tsx`: the rows for a CRLF page, a dropped trailing
  newline, an emptied page and a filled empty one.
- `PageSourceEditor.test.tsx`: a burst of edits diffs once, after the pause;
  Changes opened before the pause shows the current text; a restored draft
  counts and shows its hunks before anything is typed.

**Shown red:**
- Eager `setDiffedText` in `handleChange`: the burst test, 5 diffs for 2.
- No `setDiffedText` on opening Changes: two tests.
- The diff text falling back to the page's: the restored-draft test.
- `splitLines` on `\n` only: the CRLF tests in both diff and Changes suites.
- `splitLines` dropping a trailing newline: the trailing-newline and emptied
  tests.

**Known and left:** a `\r` inside block content is a limit of the backend's
line counting (`markdown_source_tests.rs`), not of the diff.

**Ran:** vitest on the three suites and `PageSourceEditor`,
`page-source-edit.spec.ts` (21 tests), `npm run typecheck`, `npm run lint`.
