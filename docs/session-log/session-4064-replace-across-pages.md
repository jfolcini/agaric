# Session 4064 — replace across pages from the Search view

`Closes #6608` (its last box: the first slice of the design note the maintainer approved on
2026-11-13).

The Search view gains a replace row (its toggle, or `Ctrl+H` with the focus in the view). While it
is open the result list is a preview: only the blocks a replace would change, each showing its
change and ticked. One `edit_blocks_batch` writes the ticked blocks in one transaction and the
toast's Undo reverts the run with one `undo_ops`. Literal text with the case and whole-word
toggles; no regex, no mobile sheet, no single-result Replace, no MCP tool.

Picked up from a `wip:` commit a cut-off builder left. What the wip lacked or had wrong:

- **The stale check read the row only.** #6684 showed why that is not enough: a sync import
  reaches the engine before it takes the writer lock to project, so a row can still hold what the
  search returned while the engine holds a peer's edit, and the edit, diffed against the engine's
  text, deletes it. The command now compares `expected` with the text the edit would be diffed
  against, as `edit_block_in_tx` picks it: the engine's (`engine_block_content`), else the row's.
- **No base per block.** A replace computed from search results is a stale editor, and
  `edit_block` now rebases one (#6533). The batch does not: the maintainer decided a block that
  changed is left alone and counted, the user confirmed the change the preview showed, and a
  rebase writes a text they never saw (and, where the two changes overlap, the caller's text over
  the peer's). So the command takes `expected`, skips on a mismatch, and passes no base down.
- **The mock search found nothing for a quoted phrase.** The replace sends its find text as
  quoted phrases, which the backend's tokenizer reads as phrases and the mock looked for with the
  quotes in. The Playwright spec was red for that alone. The mock now reads a query of nothing but
  phrases as the backend does, pinned by a query step the backend authored
  (`search_fts_quoted_phrases` in `query_search_blocks_modes.json`). A query mixing phrases and
  bare words is still the mock's whole-query substring test.
- The conformance fixture had no `expected` (now authored by the backend), `bindings.ts` lacked
  the command, the component tests left three commands unstubbed, and the Playwright spec went
  back to Search through `openSearchView`, which reloads the app and empties the mock.
- Two reds only the whole Rust suite shows: the command's span carried a field name
  (`edits`) that is not on the PII allowlist (`count` now), and `MUTATING_ARM_COUNT` in
  `conformance_command.rs`, which pins how many commands the conformance dispatcher wires, had
  to move from 69 to 70.
- Removed as unneeded: a `flushActiveDraft()` before the write (no editor is mounted behind the
  Search view; the design note wanted it for the mobile sheet, which this slice leaves out), the
  mock's copy of the cap (no fixture pins it and the frontend refuses first), and two conditions
  in `SearchPanel` no test held (hiding Load more and the alias card while replace is open).

Traps:

- `CONFORMANCE_UPDATE=1` followed by `oxfmt --write conformance/fixtures/` reformats four
  fixtures nobody changed; restore them.
- A component test that edits its stub vault after the preview can see the panel refetch in
  between: `reloadChangedPageStores` in the previous test arms a module-level debounce that bumps
  the search's query key. The two tests that need a stale search stub `search_blocks` with a
  frozen copy.
- A falsification that removes a call can leave an unused parameter, and `npm run build` then
  fails before the real-backend spec runs: a build break, not a kill.

Not covered:

- After Undo the preview searches again at once. Nothing makes that wait for the search index,
  which follows a write in the background, so after a large run the list may be short until the
  search runs again. On the three-block run of the real-backend spec it listed the restored blocks
  in four of four local runs; no test holds it.
- The bench (`edit_blocks_batch/at_cap` in `core_bench`) ran here in the dev profile only: about
  2 s for one run of `MAX_BATCH_BLOCK_IDS` edits (1.92 to 2.02 s over ten samples), which bounds a
  release build from above. The release bench graph was not built.
- A batch of this size may queue more background index work than the materializer's queue
  holds, the rest going through its retry queue, as for a large *Edit as Markdown* save. Read in
  the code, not measured.

Ran, on the tree with `main` merged in: each new test red once on the assertion predicted
(seven mutations of the command, eighteen of the hook and its components, five of the mock, two
of the Playwright spec, one of the real-backend spec, each through a restore-on-exit runner);
full vitest, typecheck, lint, `prek run --all-files` and the manual stage; the workspace nextest
in two halves, the `SQLX_OFFLINE` check and clippy over the workspace with all targets;
`just gen-sqlx` and `just gen-bindings` leave no diff; `e2e/search-replace.spec.ts` on the mock
and `e2e-tauri/search-replace.e2e.ts` on the real backend (its first runs). `just e2e-related`
selects both whole lanes, left to CI.
