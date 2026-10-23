# Session 2888 — review notes from the sweep's merged PRs

This is the follow-up PR for the non-blocking review notes of the PRs merged in this sweep: #6038, #6042, #6061, #6064, #6065, #6070, #6071, #6072, #6078, #6081 and #6085. Three builders took the notes in groups (imports; slash commands and journal; navigation, Pages and mobile). Each checked the premise first, and a separate reviewer ran the gates over the whole branch.

**Fixed:**
- **Org import:**
  - a `:PROPERTIES:` drawer opens only when an `:END:` follows, so an unclosed one stays text instead of swallowing its section;
  - a source block's fence is longer than any backtick run inside it;
  - a page-level drawer key the app reserves stays text instead of being dropped silently.
- **Import summary:**
  - a Notion `X.csv` and `X_all.csv` count once;
  - a file a note embedded is no longer counted as skipped. The runner records attached paths, and the count is worked out after the run (`finalWarnings`), with the skipped warning first.
  - `isNotionPick` is computed once.
- **Batch toolbar:** Enter and Space stop at the toolbar, so pressing a Pages toolbar button no longer also opens the highlighted page. The reviewer drove the twins, History (Enter confirming a revert) and Trash (Space toggling a row): both had the same leak, and both are fixed by the shared toolbar.
- **Space move:**
  - a throw from `onMoved` after a successful move is logged instead of being reported as a failed move;
  - the loss dialog shows a reference value as its target's title, with a test for a failed title lookup.
- **Mobile chrome needs touch:** `useShouldShowMobileChrome` now requires `useIsTouch()`, so a narrow mouse window keeps desktop chrome. As a result, the real-backend Quick Capture spec, which narrowed a mouse webview to reach the button, now presses the OS chord.
- **Small items:**
  - two test comments now name `setCreated`;
  - the page grip's `GRIP` constant is no longer exported, and `hide` assigns `hidden` directly;
  - `src-tauri/src/commands/AGENTS.md` (maintainer-approved) now says that a new create path's undo test strips the move's `prior`, or it passes without the slot.

**Dropped, with what was checked:**
- **Already fixed by #6059 or #6075:**
  - the JEX link warning's wording;
  - the peek's blank first blocks and its Ctrl release;
  - the tab role and the `dndAccessibility` memo;
  - the `enterTab` tests;
  - `applyContentEdit` returning a boolean;
  - the `clearListStyle` shadow;
  - the delegated link-click memo and the container click stop;
  - the journal `spaceId` reuse;
  - `setTodo`'s read after a refused write;
  - the Clear row's order;
  - the `undo_todo_state_batch` fixture.
- **No failure to fix:**
  - page mode's `/turn` writing the list style directly: the save's reread shows it;
  - Turndown built once per JEX note: hoisting it is more than a line;
  - the Org look-ahead: it is quadratic only within one section, at 668 ms for 5,000 unclosed drawers in one section;
  - `repair_misfiled_tag_spaces`'s `None`: unreachable, since a misfiled tag always holds a space;
  - `.nsprc`: already clean.
- **Not built, by decision:**
  - the chord-parity test;
  - the product calls: page-mode heading chords, hidden blocks in a drag across a collapsed one, and Notion's first `Key: value` paragraph and built-in collisions.
- **Moved elsewhere:**
  - `.txt` / `.markdown` / `.mdx` sibling links need the extension check in Rust (`rewrite_relative_md_links`), so they go with #6032's Rust items;
  - the shared CTE of `space_move_losses` and `space_move_loss_values` goes with the `preview_space_move` probe (#5691).

**Suites:**
- vitest: the whole tree, sharded;
- `npm run typecheck`, `npm run lint` and the import-cycle check;
- Playwright: the import, space-move, Pages, batch, Trash, History, phone and sheet specs, and the page-mode gutter spec.

The real-backend lane did not run locally; CI's run of it covers the Quick Capture spec change.
