# Session 3648 — review notes from #6390, #6396, #6406, #6411, #6425, #6431, #6432 and #6433

The batched follow-up for the non-blocking notes on every PR merged in the 24 hours from 2026-11-05 15:00 UTC (the table at the end). Each note was weighed on the review terms: a concrete failure and someone it hurts, or code that doesn't earn its keep.

## Taken

- **#6406, `FileTools`.** The struct existed only to keep `call_tool` under the line ceiling, and it cloned four fields per call. It's gone.
  - The shared arm now calls a plain `file_tool` with what `call_tool` already clones, plus `app_data_dir`.
  - A separate arm per tool would drop the second name match, but it puts `call_tool` at 74 lines, over clippy's 70.
  - A fn taking `&ReadWriteTools` can't be used either: `scoped_dispatch` needs a `'static` future.
- **#6425 / #6433, `BlockRefs`.** `resolve_block_refs` now fills `PageReferences`' three block-ref fields directly, and the one-caller 3-tuple alias is gone.
- **#6431 (E5), comment width.** The `paste_blocks_inner` doc comment (`markdown.rs`) and the mock's `paste_blocks` comment are reflowed under 100 columns. The mock's stray `// after text the first` line is folded back into its sentence. The other long lines in those files predate E5 and are left alone.
- **#6431 (E5), two walk gaps in `html-to-blocks.ts`.** Both are fixed by one `walkAnyList` that every list walk goes through.
  - **A task list nested under a plain item kept no checkboxes.** `walkList` recursed as a plain list. Red first: "keeps the checkboxes of a task list nested under a plain item".
  - **A `ul` written directly inside a `ul` was dropped.** Google Docs and Word write a sub-list that way. It now nests under the item before it. Red first: "nests a list written directly inside a list under the item before it".
- **#6431 (E5), the writer-escape test.** The case G's reviewer meant is a paragraph that reads as a property line.
  - `<p>key:: value</p>` is written `\key:: value`, and reads back as its own block with no properties.
  - Before this, only the `<hr>`-first case pinned the writer's own escaping; the list-item case passes on Turndown's escapes.
  - Dropping the first-line escape in `pushDocumentLines` reds the new test on its text.
- **#6432 (S5b), `isRecordingPlaceholder` over several lines.** It now matches `[\s\S]` rather than `.`, as Rust's `is_recording_placeholder` does. Red first: a placeholder written `<%\nrecording\n%>` was copied.
  - The mock's copy in `tauri-mock/handlers/meetings.ts` keeps `.`. It's pinned by the backend-authored `meeting_add` fixture, and no user reaches it.
- **#6433 (F2), `own_anchor_links`.** Deleted. A source-mode save runs the name pass with `file_page: None`, so `link_global_block_anchors` already links every `[[#^id]]` whose block is live in the space.
  - Re-run falsification: with the function and its call removed, the source-mode, anchor and block-ref tests stay green. That's 84 tests, among them `a_buffer_holding_block_refs_saves_as_nothing`, whose edit adds an own-page `[[#^own]]` and checks the stored `((own))`.

- **#6411, `openMeetingDialog` required.** It's now required, like `openVoiceNoteRecorder`, so the `/meeting` handler's unreachable warn branch is gone. Page mode, which doesn't offer `/meeting`, and the structural-insert context in `use-block-tree-event-listeners.ts` pass `() => {}`.
  - Existing-test edits, approved by the maintainer: `openMeetingDialog: vi.fn()` in the params fixture of `use-block-slash-commands.test.ts`, and in `test-utils.ts`'s synthetic `SlashCommandContext`; and the deletion of the warn branch's test in `useSlashCommandProperty.test.ts`.

## Not taken

- **#6396, `title_pages`' `.unwrap_or_default()` on `matches.titles.get(id)`.** Moot: #6402 (review notes from #6396) already made it `matches.titles[id].clone()`.
- **#6390, `GatedImage`'s Load button inside a link.** Moot: #6393 moved the Load button out of the link while the badge is withheld, and `linked-image.test.tsx` checks it with axe and a no-`[role="link"]`-ancestor assertion.
- **#6392:** the stale nextest claim sits in a merged session log, which is immutable.
- **#6395:**
  - the fixture key-reorder churn is already merged, so the note is moot;
  - the `userSet` flag on `BuiltinPropertyDef` is speculative, with one key today;
  - the e2e happy path it asked for exists: `e2e/meeting-attachments.spec.ts` and `e2e-tauri/meeting-attachments.e2e.ts`.
- **#6394:** making `parseEnex`'s `fileName` required, to drop its test-only `undefined` branch, means editing about 77 existing test call sites, and no production path reaches the branch.
- **#6398 and #6410:** already addressed, in #6404 and #6411.
- **#6425 (F3), `load_name_snapshot`'s tuple param.** Moot: since F2 it takes plain `refs` and `ref_titles` arguments.
- **#6433 (F2), from G's review:**
  - **Mirror timing against the `block_links` reindex.** The premise is false. `edit_block` reindexes `block_links` in its own transaction (`affected_pages_for_edit` → `reindex_block_links_conn`, #1548), as create does, so the mirror can't read before the row exists.
  - **The mirror ignoring a block `value_ref`.** No user-visible failure. The property's page writes the value as a raw id, which no other tool follows to a `^id`, and our re-import reads by id.
  - **The `links.ids` insert in `link_global_block_anchors`.** No failure. It may change no output, and it mirrors `link_cross_page_anchors`.
- **#6423:** an over-claiming test title in `MeetingDialog.test.tsx` and a missing blank line. Fixing either is an edit to an existing test, which isn't approved.
- **#6424:** the space-lookup helper; three copies are fine.
- **#6415:** the pinned list.
- **#6420:** the palette dump.
- **F3:** case-variant twin titles and the cross-space copy; no concrete failure found.

## The sweep

Every PR merged from 2026-11-05 15:00 UTC, with what became of its non-blocking notes:

- **Taken here:** #6406, #6411, #6425 (one note moot), #6431, #6432, #6433.
- **Notes moot or not taken (reasons above):** #6390, #6392, #6394, #6395, #6396 (`pagesUpdated`: ITEM1), #6398, #6410, #6423, #6424, #6415, #6420.
- **Notes already batched by their own follow-ups:** #6391, #6402, #6404.
- **No non-blocking notes, per the coordinator's sweep of all 41:** #6393, #6397, #6399, #6400, #6401, #6403, #6405, #6407, #6408, #6409, #6412, #6413, #6414, #6418, #6421, #6422, #6426, #6427, #6428, #6429, #6430.
