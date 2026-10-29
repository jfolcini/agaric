# Session 3072 — Review notes from #6163, #6167, #6170 and #6172

Set out to clear the non-blocking notes the reviewers left on the PRs merged in the 10-28 night sweep. Each note was premise-checked against the code first; all four TypeScript notes held. One builder wrote the change and a separate reviewer re-ran its reds and the gates.

**Done:**
- **`/bullet-list` and `/numbered-list` on a heading, quote, callout or code block turn it into a list paragraph.**
  - Before, they stored a `listStyle` that `showsListMarker` never shows, because the block does not open with a paragraph.
  - The command now takes Turn into's path (`turnInto`, shared with `handleTurnInto`), so `# Title` becomes the bullet `Title`.
  - A paragraph keeps the old path, and so does a paragraph opening with `+ `.
    - `detectBlockType` reads `+ ` as a bullet, but the editor does not, so Turn into would have stripped it.
    - The reviewer caught this, and the routing now leaves list kinds out.
  - Page mode reaches the same handlers.
  - A kind change still records one undo step.
- **The block menu's Turn into clears task states after its style write,** as the slash and toolbar routes do. Behaviour is unchanged; a failed write still reloads and skips the clear.
- **`bubble-keyboard.spec.ts` crosses the selection bubble with the arrow keys** before pressing Bold, so the arrow path is proven in Chromium.
- **Comments:**
  - The scale-envelope test iterates `SCALES` directly.
  - The catalog-parity and scale comments keep the reason and drop the history.
  - The page-mode property comment says why every block in its harness reads as not yet a task.

**Not changed:**
- **Turn into still strips a leading `+ `.** `BULLET_RE` accepts it and the parser does not. This predates this PR and is pinned by `block-type-convert.test.ts`.
- **Blocks still read as paragraphs:** a query, embed, table, divider or math block reads as a paragraph to `detectBlockType`. `/bullet-list` there still stores a style nobody sees, as Turn into does today.
- **`PageLists`' `isTask` default:** it exists only for tests. Making it required waits for #6156 part 2, which is changing `page-lists.ts`.

**Deferred to the Rust lane:**
- inline the test-only `render_page_source`;
- G3 notes: the `parse_document_outline` fuzz target, and `docs/features/import-export.md`'s one-grammar sentence;
- the reminder spec's test tick and the unpair refusal (handed to the parallel test session).

**Dropped, with what was checked:**
- **#6171's shard-boundary drift by one file:** coverage is unchanged, and balance moves one file.
- **#6174's page-header growth shifting blocks:** no failure seen; the two-screen pick absorbs up to a screen.
- **#6175's over-escapes and double error log:** accepted in review.

**Red first:**
- **The heading-to-bullet cases:** with the new branch turned off, they fail on `expected '# Title' to be 'Title'`.
- **The bubble spec:**
  - with `useRovingTabindex`'s forward step frozen, it fails on Italic `toBeFocused`;
  - with the backward step frozen, it fails on Bold `toBeFocused`.
- **The `+ ` case:** against the first version, it fails with `expected '1 for this' to be '+ 1 for this'`.

**Suites:**
- vitest over block-tree, editor, i18n, page-mode and hooks (6,186 tests);
- typecheck and lint;
- the manual-stage hooks;
- Playwright: 19 specs covering the bubble, slash commands, kind change, list styles, task lists, Turn into and page mode (108 tests).
