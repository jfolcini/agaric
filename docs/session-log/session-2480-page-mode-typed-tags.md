# Session 2480 — Page mode commits a typed #name as a tag

#5743 slice 1. In page mode a `#name` typed as text stayed text, so the block never got the tag; block mode commits it on blur (`commitTypedTags`). The maintainer chose #5743 as the next feature work, in slices.

**When.** The tag is committed when the caret leaves the block it was typed in (arrows, a click, Enter, a join), and when the user leaves page mode or the page. Never on the idle save, an editor blur or an export flush while the caret is still in that block, so a half-typed `#proj` stays text. This is block mode's blur moment.

**How.** Leaving saves that block at once, then `commitPageTags` (`src/editor/page-mode/page-tags.ts`) feeds its last-saved text to block mode's own `commitTypedTags`. That reuses `tagIds`: an existing tag is matched case-insensitively, a new one is created, and `requireActiveScope` applies. A failure logs and leaves the text, as in block mode. The new `#[ULID]` text comes back the way a remote change does: the page is re-read and the block is patched outside undo history. The block keeps its id. Ctrl+Z removes the typing with the chip when the typing was one undo group; with a pause between groups the patch has replaced the earlier group's text, so those presses do nothing visible and the chip stays until it is deleted. Only blocks the caret changed are converted. Per transaction the cost is one caret-block lookup and a set insert, with no document scan.

`key:: value` lines and task markers still stay text: they need #5743's Properties and Tasks blockers first.

**Tests**, each shown red:
- **vitest:**
  - typed and left, including undo;
  - a caret still after the name;
  - an existing tag reused;
  - leaving page mode, and leaving the page;
  - a rejected tag creation;
  - a block typed in again and left while its tag is being made (the commit loop walks a copy of the set).
- **fast-check:** a type-`#name`-then-move step, 2,000 runs × 3.
- **Playwright:** the chip appears, survives navigating away and back, and axe passes. Stable at 88/88 repeats.
- **e2e-tauri:** `page-mode-typed-tag.e2e.ts`, checking `tags_cache` and the tag page's backlinks. CI only.

Gates: vitest over `src/editor`, `src/stores` and `src/components/pages` (5,023); typecheck, `typecheck:e2e-tauri` and lint; Playwright 55/55.
