# Session 2548 — Page mode shows queries and embeds

Slice 7 of #5743, after the attachments slice (#5837). A page holding a
`{{query …}}` or an `{{embed …}}` block now opens in page mode. The `queries`
and `embeds` blockers and their `pageMode.blocked.*` strings are gone. The cap
(`PAGE_MODE_BLOCK_CAP`) is the one blocker left.

**What block mode does** (traced first):
- Both are block text. `StaticBlock` sniffs it: `{{query ` … `}}` draws
  `StaticQueryBlock`, which draws `QueryResult`; `parseEmbedToken` draws
  `EmbedContainer`. The focused block shows its raw text in the roving editor,
  with no results.
- `QueryResult` runs one `useInfiniteQuery` per block, keyed on its
  expression (`list_tags_by_prefix`, `run_advanced_query`, `batch_resolve`).
  It refetches when `recordGraphStructureChange` moves, which every saved edit
  fires through `notifyUndoNewAction`. A block-mode commit after 700 ms of idle
  therefore refreshes every query on the page.
- An embed resolves its target (`batch_resolve`, `get_block`), then mounts a
  `PageBlockStoreProvider` of the source page and loads it. Stores of the same
  page mirror each other (`mirrorToSiblings`). So an embed of a block of the
  page it sits on shows each commit, because block mode's `edit` writes the
  store.
- `EmbedChainContext` stops cycles and depth; the shells cover loading,
  deleted and unresolved targets.
- Its unlock needs a host `BlockTree` (`EmbedRowEditorContext`). Without one
  the control is not offered.

**Design** (`src/editor/page-mode/page-rendered.ts`, `page-tasks.ts`):
- The `pageBlock` node view draws block mode's `StaticBlock` after the editable
  text, for a block whose text block mode would draw as results. It mounts
  through the same `ControlsGate`, and the caret's block mounts at once.
- The text and the results swap on the caret, as block mode's two states do.
  `PageBlockFocus`'s current-block decoration now carries a spec the node view
  reads (`isCurrentBlock`). A block that is not current hides its text and shows
  the results; the current block shows its text and hides the results (CSS).
- What the results show follows the text only while the caret is out of the
  block. While the caret is in it, they stay as they were and run no query per
  keystroke. Once the caret leaves, the edit shows; the save runs then too.
  These are block mode's on-leave semantics.
- The browser's caret skips hidden text, so a small plugin steps the arrows
  into such a block. Without it, ArrowDown from the block above went past two
  hidden blocks (Playwright).
- Page mode also gets block mode's `BlockResolversProvider` around the editor.
  Without it, a link in an embed's rows had no resolver and showed its
  `[[0000…]]` fallback, even for a title the cache held.
- A query of this page refreshes on page mode's saves, through the same
  `notifyUndoNewAction`.
- An embed of a block of this page reads the page store's rows, which page
  mode's save does not write. A save that wrote, on a page that embeds one of
  its own blocks (`embedsOwnBlock`), now reads the store once, so the embed
  mirrors it as block mode's does.
- The query builder's Save goes on page mode's chain. `StaticBlock` →
  `StaticQueryBlock` → `QueryResult` take an optional `onSaveQuery`, which
  defaults to the page store's `edit` as before. Called directly, the store's
  optimistic write made page mode read the page while the edit was still in
  flight. The real backend can answer that read first, and the document then
  kept the old query. A vitest that delays `edit_block` shows it.
- Block mode's padding: the card and the embed take the block's inset back, and
  the editor's own `ul`/`ol` and table rules no longer reach into them.
  Playwright measures both at the same x, y, width and height as block mode's.
  Screenshots compared by eye: block mode and page mode, a table query, a list
  inside an embed, and the edit state.
- Differences from block mode: an embed offers no unlock, since there is no
  host tree to rove into. A query block with attachments shows their previews
  under the card, where block mode's static query shows none.

**Found on the way.** axe flags the result rows' page name in page mode:
`text-muted-foreground/60`, 2.46:1. The same rows passed axe in block mode, on
the same page. The fade is gone from `QueryResultList` and `QueryResultTable`.

**Tests, each shown red first by a one-command mutation (backup, trap, `! cmp -s`):**
- `page-mode-fit.test.ts`: query and embed blocks are let in, and their rows
  read. Red: a `{{` sniff back in `readPageFit`.
- vitest `PageModeEditor.test.tsx`, a `queries and embeds` describe:
  - Drawn outside the text, as block mode draws them, with axe. Red: the sniff
    finding nothing.
  - A link in an embedded block names its page, its title cached as the boot
    preload caches it. Red: no `BlockResolversProvider`.
  - The caret in a query shows its text; an edit and a save change nothing
    drawn until the caret leaves, then `tag:personal`'s two results. Red twice:
    redrawn while the caret is in (pills read `tag: personal`), and never
    redrawn (still four).
  - A click on a result puts the caret in the text; the embed's Open source
    navigates. Red twice: a no-op `onFocus`, and no `onNavigate`.
  - `run_advanced_query` refused: block mode's error, and Retry. Red twice: the
    alert role dropped, and a no-op Retry.
  - A missing embed target, an unreadable one (`get_block` refused, logged),
    and a query that finds nothing: block mode's states. Red: no embed branch
    in the sniff.
  - The builder's Save after a save, with `edit_block` answered late: the
    document reads the new query. Red: `onSaveQuery` not passed (the document
    kept `tag:work`).
  - A refused builder Save toasts and keeps the builder and the text. Red:
    `saveQuery` resolving true.
  - Typing elsewhere, the caret passing through, a save and two reloads redraw
    no result or embed; the keys run no query. Red: a callback rebuilt on each
    pass (two renders). A same-text guard in the node view was deleted:
    TipTap's `updateProps` already skips unchanged props.
  - An embed of a block of this page shows the saved text, with the page read
    a bounded number of times. Its mock answers each call in a task, as the real
    IPC does, so a loop shows as a count rather than a hang. Red twice: no
    read after the save, and a self-feeding read (74 reads against 6).
  - A query of this page lists a block tagged here once saved. Red: no
    `notifyUndoNewAction` after the save.
  - Lazy: nothing asked until near, or the caret is in. Red twice: mounted at
    once, and `reveal` not mounting it.
  - The reload blocker test now goes over the cap. Red, with the
    `PageEditor.test.tsx` rows test: a cap that never blocks.
- `PageEditor.test.tsx`: the blocker tests use the cap; the found-and-cleared
  pair uses a cap found while open. Red: a `checkFit` that never clears.
- Playwright `page-mode.spec.ts`: a page with a query and an embed opens in
  page mode. Both are drawn in block mode's boxes, with their text hidden. The
  arrows step in and out, and the text shows in place of the results. An
  edited query shows its new results once left. The backend holds the text,
  and after away, back and Page again the results and embed are there, with axe
  twice. Red five times:
  - the inset kept: 418 and 690 px, not 406 and 714;
  - no swap: the text visible;
  - no arrow plugin: the caret in block 3;
  - the fade back: `color-contrast`;
  - never redrawn: still four results.

  It needed `page-mode.spec`'s existing Escape-then-blur wait before the
  palette: without it Ctrl+K went to the editor (3 of 4).
- `page-mode-setting.spec.ts`: the query and embed cases are folded into the
  over-cap test: the setting on Page, the tooltip, axe, and Ctrl+Shift+M's
  notice. Red: a cap that never blocks (the page opened in page mode).
- e2e-tauri `page-mode-queries-embeds.e2e.ts`: a `#name` typed in page mode
  tags a block, whose inline tag the materializer indexes. `{{query tag:…}}`
  and an embed of that block are written through the real IPC. Page mode lists
  the block in the results and shows it in the embed, then again after
  navigating away and back. Type-checked only; it runs in CI.
- fast-check: not extended. #5721's property drives a bare editor with no node
  views through the save path. Query and embed blocks are text there, which
  its random text already covers. Their drawing, the caret swap and the builder
  write are off that path.

**Measurement.** `AGARIC_PERF=1 AGARIC_PERF_REPEATS=5 e2e/perf.spec.ts -g 'page
mode'`, sizes held to 500, unthrottled, median [min–max]. The harness now
makes one block in 25 a `{{query tag:work}}` and another an embed of a block on
another page (20 of each). The baseline is the same build with that seeding
skipped. Runs alternated in one session. Page mode:

| Run | Load average | Worst frame while opening | Key to paint, p50 |
| --- | --- | --- | --- |
| with | 5.5 → 2.8 | 79 [0–90] ms | 5.9 [5.7–6.9] ms |
| without | 3.0 → 2.9 | 78 [74–95] ms | 6.1 [5.6–7.5] ms |
| with | 2.5 → 3.3 | 83 [69–96] ms | 6.9 [5.6–7.5] ms |
| without | 3.2 → 4.4 | 86 [77–101] ms | 7.0 [5.4–9.0] ms |

No difference shows outside the bands: queries and embeds mount only near the
view. The 0 is a repeat that recorded no long frame while opening. The
attachments slice measured 85–159 ms and 7.6–11 ms on a busier machine. Every
seeded query is the same expression, so they share one fetch.

**Gates:** vitest over `src/editor src/stores src/lib` (9,554 passed) and
`src/components` (10,236 passed). Also `npm run typecheck`,
`npm run typecheck:e2e`, `npm run typecheck:e2e-tauri`, `npx vitest run
e2e-tauri` and `npm run lint`, with no new warnings. Playwright on a private
port: `page-mode` and `page-mode-setting` (30 passed), and the query and embed
specs (29 passed). Those are `advanced-query-group`,
`advanced-query-happy-paths`, `advanced-query-saved-views`,
`embed-edit-in-place`, `embed-render-states`, `query-blocks`, `query-hint`
and `tags-query-modes`.

`page-mode.property.test.ts` failed once, alongside 13 other files at load
average 10, and its output was not kept. It passed in ten runs after that:
seven alone and three with the same files. Its editor has no node views and
presses no arrows, so this slice's code is off its path. Sessions 2530 and 2543
record that flake's known class.
