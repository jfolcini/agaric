# Session 3339 — A one-line paste reads page names (#6033 S1)

Set out to build #6033's first slice: a single pasted line holding `[[Name]]`, `[[Name|label]]` or Logseq `[alias]([[Name]])` kept the name as text (in a table cell it stored `\[\[Name\]\]`), while a multi-line paste resolved and created pages.

**What shipped.** `html-paste.ts` routes a plain-text line in which `scanNameTokens` finds a page token to `dispatchPasteBlocks`, whose Rust `resolve_pasted_names` resolves names and whose `PasteSplice::join` splices the line into the anchor block in place. `isBlockPaste` is unchanged, so a line pasted inside a table cell or list item still pastes inline as text. List and task lines stay on the one-line path: after text, the block path would renumber `3.` and rewrite `*`.

**Premise check.** A one-line `#tag` already became a tag at save (`tagsWrittenAsText`), so it is not routed. The HTML one-block branch is left alone: turndown escapes `[[`, so no page token ever reaches it. Page mode's paste is S12.

**Trade.** Like every block-path paste, the routed paste goes on the page-level undo stack: Ctrl+Z inside the editor right after it does nothing (the remount resets ProseMirror history); Escape then Ctrl+Z undoes it with the page it created.

**Tests.** New `e2e/paste-one-line-names-6033.spec.ts` (shown red on main at the "Fresh page" poll) and routing cases in `html-paste.test.ts`; each guard (page-token kind, list-line check, its trim, the `inside` guard) was falsified. Gates: full vitest, typecheck, lint, the manual-stage hooks, and the 152 Playwright specs `e2e-related` selected (926 passed, 7 skipped). The e2e-tauri specs it listed run in CI.
