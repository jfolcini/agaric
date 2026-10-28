# Session 3014 — A labelled link is one token in Edit as Markdown; page mode's toolbar commands are pinned (#5691)

Set out to ship PR-C of the three-modes code review (#5691): its findings F4 and F9.

**Shipped.**
- **F4: `[[ULID|label]]` is one atomic token in the buffer**, like `[[ULID]]`.
  - The scan in `ulid-tokens.ts` read `[[ULID]]`, `#[ULID]` and `((ULID))` but not a labelled link, which page mode's parser reads as a link. So the caret, a selection or a paste could land inside the id.
  - The bracket alternative now takes the parser's label grammar (`tryConsumeBlockLink`): up to the first `]`, no newline, possibly empty.
  - A labelled link is now deleted whole. To change its label, retype it.
- **F9: a matrix test** (`page-toolbar-commands.test.ts`) reads every `dispatchBlockCommand('NAME')` in the formatting toolbar's sources and asserts each is handled by page mode's `pageToolbarCommands` or left out with a reason. Only `DISCARD_BLOCK_EDIT` is left out, because page mode saves as it goes.
  - The test fails closed. A computed name fails it, since its literal count must equal its call count. A source tree with no matches fails it. A left-out entry must still be sent and still be unhandled.

**Decisions:**
- **One existing test changed,** by the orchestrator's call. The case "reads no token in a title, a short id … or a value with more text" had bundled `[[ID|label]]` with genuine non-tokens, and nothing recorded why. It pinned the F4 defect, so its labelled line was dropped. The new `describe` pins the labelled form positively.
- **The regex was checked against the parser exhaustively in review:** every suffix up to six characters over the delimiters, on four id prefixes (4.4M strings). Both consumed the same length in every case.
- **Not built:** an e2e spec for the labelled form. `source-buffer-ulids.test.ts` drives the real editor's caret clamp, step-over and paste.

**Suites, after the rebase onto the bubbles:**
- vitest over `src/components/pages`, `src/editor/page-mode`, `src/components/editor-toolbar` and `source-buffer-ulids` (2,032 tests);
- typecheck;
- in review: vitest over `src/components/pages` and `src/editor` (4,686), lint, the manual hooks, and Playwright `page-source-ulid-tokens`, `page-source-edit` and `page-mode-toolbar` (27).
