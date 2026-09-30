# Session 1838 — Escape keeps the typed text and selects the block (#5160 D17)

Phase 6 of #5160: X10, "Escape in a block throws the typed text away, with a toast that offers no Undo."

**What changed.**
- **Escape saves.** It runs the flush every other way out of a block uses (`handleFlush`: split, checkbox fold, inline properties, plain edit), leaves editing and selects the block, so Shift+Arrow, Ctrl+C and the batch toolbar act on it. A second Escape clears the selection through the existing `clearSelection` listener. No toast.
- **A blank block is left unselected.** Leaving it hands it to BlockTree's #4729 empty-block cleanup, which may delete it, and a selection naming a deleted block would keep the batch toolbar up. The Enter-created stub needs no branch of its own any more: the same cleanup removes it.
- **Discard keeps discarding.** The toolbar button still drops the edit and toasts; its tip loses "(Esc)". `handleEscapeCancel` is split into `handleEscapeSave` and `handleDiscard`, and the keyboard callback is `onEscapeSave`.
- **Ctrl+Z undoes it** like any saved edit: the flush goes through `edit()`, which files the page-level undo entry. Nothing new was built for it.
- **Docs.** `editor.md`, `keyboard.md`, `tags-and-links.md` (the embed's Escape now matches an ordinary block's) and `FEATURE-MAP.md`. The keyboard catalog gains a documentation-only `leaveBlock` entry beside `saveBlock`, so the shortcuts sheet lists it.
- **Tests.** Unit tests for the Escape handler, the Discard tests renamed onto `handleDiscard`, and `e2e/escape-keeps-text.spec.ts` (save, select, second Escape clears, Ctrl+Z restores, each re-read after a reopen). Three specs relied on the old contract: `block-keyboard-select-collapse` and `block-dnd-parent-child` Ctrl+Clicked the block Escape now selects (toggling it off), and `draft-autosave`'s click-away test reached `delete_draft` through Escape; it now blurs. `e2e-tauri/block-clipboard` clears the selection its Escape may leave. Comments that said Escape discards are corrected.

**Worth knowing:**
- Escape leaves a persisted draft row in place, as Enter and the arrow keys do; the backend's supersession guard drops it at the next `flush_all_drafts`. The click-away blur still deletes it after the save.
- Escape with the editor mounted but not focused (`handleUnfocusedEscape`) saves and leaves, as before, without selecting.
- `/numbered-list` and `/bullet-list` still flush the pending commit first (#4577), which Escape no longer needs. It was left alone.

**Verified.**
- The new unit tests failed on the old code (15 failed, 248 passed across the three files), and `e2e/escape-keeps-text.spec.ts` failed on an old-code bundle (2 of 2).
- vitest, the touched files and their direct tests: 21 files, 1476 passed. `npm run typecheck` and `tsc -p tsconfig.wdio.json` are clean.
- Playwright, every spec that presses Escape or calls `blurEditors`: 45 files, 394 passed, 2 skipped, 1 failed (`block-dnd-parent-child`, adapted above and green on re-run). The final run of the new spec, that one and the toolbar Discard spec: 25 passed, 2 skipped.
- Falsified on copies: dropping the flush, leaving without selecting, selecting a blank block, dropping Discard's toast, the Escape rule calling nothing, `DISCARD_BLOCK_EDIT` calling nothing, and `leaveBlock` offered as rebindable each turned a test red. A bundle whose Escape unmounted without saving failed both e2e tests.
