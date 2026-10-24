# Session 2900 — has-property on column keys, undo refuses a taken name, a busy peer is quiet

#6051, three backend slips, plus the siblings review found.

**`HasProperty` on a column-backed key.**
- `todo_state`, `priority`, `due_date`, `scheduled_date` and `space` live in `blocks` columns. `block_properties` never holds them, by migration 0088's CHECK.
- The Pages, Search, Query and Backlinks projections all compiled `HasProperty` against `block_properties`, so `Exists` matched nothing and `NotExists` matched everything.
- `compile_column_property` maps the key through `reserved_key_blocks_column`, with `space` going to `space_id`. Operands bind as text, so `prop:priority=1` matches the stored `"1"`.
- `Ne` keeps each surface's meaning for a property row:
  - Pages, Search and Query match a block without the key.
  - Backlinks need the key.
- The mock moves with the backend, pinned by new conformance query steps.

**An undo never revives a taken name.**
- The maintainer's decision: an undo that would restore a tag or page title a live one now holds refuses, names the conflict and changes nothing. The whole group aborts, as with creating a duplicate.
- `reject_revived_duplicate_names` checks every page and tag a reverse revives after its writes. The edit reverse calls the same check as a rename, so the fold and the space scoping match.
- Every reverse path goes through `apply_reverse_in_tx`: History revert, the Activity Feed, MCP `revert_ops`, `undo_op`, `undo_ops`, `undo_page_group`, `undo_page_op`, `redo_page_op` and `restore_page_to_op`.
- It is a `Validation`/`DuplicatePageTitle` refusal, not `NonReversible`, so a point-in-time restore aborts instead of skipping the op. A name clash is current state the user can fix; skipping would leave a half-restored page.
- Trash restore, single and batch, now refuses a taken page title, as it already did for tags.
- **The refusal keeps its undo entry**, so the same Ctrl+Z works once the name is free. If the name stays taken, Ctrl+Z keeps hitting that entry, with a toast that says why. Dropping it would lose the undo.
- **Toasts show the backend's words only for this clash** (`takenNameReason`), on every surface that can raise it: undo, redo, swipe-undo, the delete-page toast's Undo, the Pages batch undo, both History dialogs, the Activity Feed and Trash, including Restore all. Every other failure keeps its previous copy. The message says "in this space", not a space ULID.
- **The mock is all-or-nothing:** its batch reverse handlers restore their state on a throw, as the backend's transaction does.

**A simultaneous dial is not a sync failure.**
- Both devices dial at once, and the responder refuses with `Rejection::Busy`, which has no user-facing message.
- Before, the initiator raised a red "Sync failed: peer is busy" twice: once from the orchestrator's `SyncMessage::Error` arm, and again from the supervisor's first-failure report.
- Both now stay quiet. The backoff is still booked, because the doubling is what keeps repeated collisions apart. The device row ends with the terminal progress event that a repeated failure sends, so the store gets no red dot and no toast.
- A refusal during a pairing window also ends the row.

**Shown red:**
- **Column keys:** with the column branch off, each surface's test returns an empty set. A number bound as `1.0` misses the stored `"1"`. Each surface's `Ne` arm and the substring operators have their own red.
- **Name checks:** with the restore-arm or edit-arm check off, the tag, page and rename tests get an `UndoResult` instead of the refusal. With the Trash page arm off, both restore tests succeed.
- **Undo entry:** with every Validation permanent again, the refused undo and redo lose their entries.
- **Toasts:** with the helper widened to any Validation, the generic-copy tests fail. With each site back on generic copy, that site's clash test fails.
- **Mock:** with the mock's check off, or a handler unwrapped from `allOrNothing`, the conformance fixtures and the mock's own tests fail. The Playwright case fails at the toast and at the page counts.
- **Busy:** with the supervisor passing no rejection, the Busy test sees the original "Sync failed: … peer is busy" event. Making every rejection quiet fails the existing outside-a-pairing-window test. With the pairing-window progress event removed, 0 events arrive instead of 1.

**Not here:**
- #6099: a move to another space does not check names there.
- The `create_block` response's `position` can differ from the stored one; to look at.
- A user-pressed sync's terminal progress still sets the global status to `error` for a quiet failure. That predates this change.

**Suites:**
- the whole workspace under nextest;
- clippy, fmt, `SQLX_OFFLINE` check and the four `sqlx prepare --check` lanes;
- bindings regenerated;
- vitest over `src/lib`, `src/hooks`, `src/stores` and `src/components`;
- typecheck and lint;
- Playwright: history, undo, trash, sync, advanced query and references specs.
