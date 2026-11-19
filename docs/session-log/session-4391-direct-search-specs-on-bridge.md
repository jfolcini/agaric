# Session 4391 — the specs that test what search returns run on the bridge

#6529's measurement listed 25 specs, not yet on `REAL_BACKEND_SPECS`, that test search, the pickers or queries directly. 19 of them depend on what a search command returns, and each fails on the bridge when that command is broken. #7000 put 8 of the 19 on the list while this was in review. This PR adds the other 11: agenda-sort-group, block-ref-peek-keyboard, block-ref-picker, journal-title-format, perf, references-add-filter-click, suggestion-keyboard, suggestion-popup-stability, tag-suggested-properties, task-checkbox-rows and voice-typing.

**Spec fixes, so they pass on the real backend:**
- `perf.spec.ts`:
  - Its IPC recorder wrapped every assignment of `__TAURI_INTERNALS__.invoke`. The bridge assigns it a second time, with a function that calls the first, so every call was counted twice. It now wraps only the first assignment.
  - A list view's seed now waits for the backend's change feed to settle before the measured window. On the bridge, the seed's `blocks:changed` otherwise arrived inside the window.
  - The Agenda row is `@mock-only`: it seeds through `__addMockAgendaItems`.
  - The page-create test dates its picked day from the real clock instead of `page.clock.setFixedTime`.
- `journal-title-format.spec.ts`: dated from the real clock. The backend titles the seed's journal page by its own date, which `page.clock` does not move.
- `draft-autosave.spec.ts`, already listed, which failed on this PR's first CI run: the caret-split test saw `delete_draft` sent, then read `list_drafts` once. The bridge answered that read before the delete committed (4 failures in 40 local repeats, with no `save_draft` after the split). The test now polls the store until the row is gone, which a late save of the stale text would still fail.

**Shown red:** four bridge builds, each with one search command made to return an error (`search_blocks_inner`, `search_blocks_partitioned_inner`, `run_advanced_query`, `filtered_blocks_query_inner`), ran all 25 specs:

| Broken command | Tests failed | Specs that went red |
|---|---|---|
| `search_blocks` | 30 | block-linked-references, block-ref-count, block-ref-peek, block-ref-peek-keyboard, block-ref-picker, features-coverage, inner-links, journal-title-format, link-labels, paste-one-line-names-6033, perf, picker-happy-paths, suggestion-keyboard, suggestion-popup-stability, voice-typing |
| `search_blocks_partitioned` | 4 | perf, references-add-filter-click, voice-typing |
| `run_advanced_query` | 3 | tag-suggested-properties, task-checkbox-rows |
| `filtered_blocks_query` | 6 | agenda-sort-group, journal-title-format, task-checkbox-rows |

The draft-autosave fix fixes a test race, so it has no red run of its own: its evidence is the 4 local failures and the clean repeats after it. #7000 had already fixed the same kind of race in `inner-links.spec.ts` (it counted chips before the page had rendered).

**Left out, because no search break reddens them:**
- `autocomplete`: its popover suggests query tokens, not search results.
- `menus-popovers`: its popovers list from other commands.
- `observability-tracing`: asserts only that a `search_blocks` call was made, which a failing call still is.
- `palette-desktop`: its page result does not come from the block search.
- `agenda-virtualization` and the `phone-view-headers` Agenda test: their search use is seeded through `__addMockAgendaItems` alone.

**Ran:**
- All 25 on the bridge: 152 passed, 8 skipped, 1 failed: an inner-links race, which #7000 fixed in the meantime.
- The changed specs on the bridge and on the mock.
- `perf.spec.ts`: 7 passed on the bridge; its `@mock-only` Agenda row passed on the mock.
- `npm run typecheck`, oxlint and oxfmt on the touched files.
