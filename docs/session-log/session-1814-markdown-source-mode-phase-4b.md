# Session 1814 — markdown source mode, phase 4b

Phase 4b of #5140 adds the page source-mode UI, on top of 4a's `apply_page_source` (#5156). Page kebab → *Edit as Markdown* replaces the page's block tree with a textarea holding `get_page_source`. Save writes it back as one undo entry, and Cancel throws it away. Phase 2's read-only "View as Markdown" dialog is deleted, because the textarea does select-and-copy.

**The pieces.**
- **`PageSourceEditor`.** It loads the source, keeps a per-page draft (a `PREFERENCES` entry, not raw localStorage, which two hooks refuse), asks before a blank buffer deletes every block, and saves.
  - A stale save opens `PageSourceConflictDialog` with what changed elsewhere. From there, Reload drops the user's text, Overwrite saves it forced against the current source, and Keep editing leaves both alone.
  - Any other refusal shows the backend's message inline and keeps the buffer.
- **`diffSourceByAnchor`.** A small, pure function that splits each source into blocks at their `^ID` anchors and lists what was added, removed or changed.
- **The `applyPageSource` store action.** It records one undo entry, tells the pickers about created pages and tags in the space captured before the call, and reloads.

**Changed from the plan.**
- **The draft flush on load is gone.** Entering source mode clears focus and unmounts the tree in one commit, so the flush is always unregistered by the time the load runs. What keeps the user's typing is that opening the kebab blurs the editor, which commits the block. A commit that lands after the read makes the save stale, which shows the conflict dialog. A Playwright case pins that what was just typed is in the buffer.
- **The store action has no empty-refs guard.** `onNewAction` already ignores empty refs, so a guard there could never be shown red. The store test pins the behaviour.
- **The diff helper runs a block through its anchor to the next bullet**, as the renderer writes it. A fenced code line starting with `- ` is therefore not a bullet.

**Review.** An independent reviewer fixed eight findings, and each fix has a test that fails without it:
- the dead flush;
- the diff splitting fenced `- ` lines, which showed a phantom "added" row;
- the kebab's close stealing focus from the textarea;
- the conflict dialog dropping focus on close;
- the restored-draft note missing from the textarea's description;
- four tests that asserted call shape, now reading the mock back, plus a new case where a restored draft whose page changed opens the dialog instead of saving;
- the save re-entrancy guard, which had no test;
- a duplicate class.

It checked each of these and found nothing to change:
- the draft lifecycle: double saves, a save during the stale re-fetch, navigating away mid-save, and one page's draft reaching another;
- global shortcuts while typing;
- the e2e-tauri spec's reopen and value-setting pattern.

**Found along the way, for the follow-up.** Both are older than this phase:
- At 390 px the page header's action row overflows. The kebab (*Edit as Markdown*, Export, Delete page) is clipped off-screen, so phone users can't reach it.
- Focus falls to `body` after source mode closes and after Cancel in the shared `ConfirmDialog`.

**Verified.**
- The whole vitest suite passed 19295 tests (844 files).
- `npm run typecheck` and `npm run typecheck:e2e-tauri` pass, and oxlint and oxfmt are clean on the changed files.
- Playwright passed 53 tests across `page-source-edit` (4), paste, duplicate, and the kebab users (import-export, spaces, templates).
- Every new test was reddened by a mutation against a copy.
- `e2e-tauri/page-source-edit.e2e.ts` typechecks, but only CI can run it. It reorders, edits and deletes in one save, then reopens the page.
