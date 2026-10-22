# Session 2880 — a cross-space move asks first, then drops what the target defines differently (#5841 S0.6)

#5841 slice S0.6. Since S0.5, property definitions are per space. A page moved to a space whose definition of a key differs used to carry values that space cannot read. The maintainer decided on 2026-10-18 that such a move drops each value the target does not define identically, after one confirmation that lists everything lost.

**What a move keeps:**
- built-ins;
- keys both spaces define with the same `value_type` and `options`;
- keys neither space declares.

A key declared in only one space, or declared differently, is dropped.

**What changed.**
- **`preview_space_move` (new, `commands/blocks/space_move.rs`):** one `{key, count}` row per key the move drops, from one grouped SELECT over `json_each`.
  - The moved set matches `project_set_property_to_sql`'s `WHERE id = ? OR page_id = ?`: each live root plus its page group, trashed rows included, nested pages left behind, minus anything already in the target.
- **`list_property_loss_values` (new):** the blocks holding the dropped values, cursor-paged by block id, `limit` validated through `PageRequest::new`.
- **`move_blocks_to_space` takes `acknowledged_loss`:**
  - It recomputes the losses inside its `BEGIN IMMEDIATE` transaction.
  - It refuses with the new `ValidationCode::UnacknowledgedPropertyLoss` when they differ from the acknowledgement.
  - A move whose drops plus moves exceed `MAX_REVERT_OPS` is refused with "move fewer pages".
  - Otherwise it appends one `DeleteProperty` per value, carrying `prior`, before the `space` ops. One undo then reverts the space first and restores the values second (`plan_reverse_apply_order` keeps newest-first for a group with no `MoveBlock`).
  - A move with no losses needs no acknowledgement.
- **Frontend:**
  - `useSpaceMove` previews, asks, and moves with the acknowledgement. A refused acknowledgement previews again and asks again.
  - `SpaceMoveConfirmDialog` (`ConfirmDialog`) lists each property with its count and expands to its holders with `LoadMoreButton`.
  - The page header's move and the Pages batch toolbar both use it. The page header no longer calls `set_property(space)`.
- **MCP:** `move_page_to_space` takes `acknowledge_property_loss`, and its refusal names the keys, the counts and the object to pass.
- **Mock:** `space-move.ts`, with backend-authored fixtures `space_move_property_loss.json` and `space_move_nested_pages.json`.

**Found in review and fixed:**
- **Batch toolbar focus:** Cancel left focus on `<body>`, because Move was disabled during the async preview. The button now disables only without a target.
- **Wrong copy, re-ask:** a lossless preview that went stale asked with "Something changed since you confirmed" before anything was confirmed. Only a refused acknowledgement now says that.
- **Wrong copy, cap:** the cap message counted only the values while the cap counts pages too.
- **Missing tests,** added by review:
  - atomicity after the drops, with the engine rollback;
  - a lossy move on a peer, in both pull orders;
  - nested pages in the mock;
  - the dialog's Load more.

**The semantic merge with #6072, checked on the real op payloads:**
- the forward `SetProperty(space)` records the old space as its prior;
- each `DeleteProperty` records the value;
- undo stamps priors on both;
- redo reproduces the moved state.

**Shown red,** each with a one-command mutation that restored the file:
- trashed rows excluded from the moved set;
- nested pages included;
- options or type ignored;
- keys declared on one side kept;
- keys neither space declares dropped;
- the acknowledgement check bypassed;
- `prior` emptied;
- drops appended after the move;
- the cap off by one, or removed;
- the cursor taken as `>=`;
- the MCP acknowledgement not passed through;
- the engine rollback unarmed;
- the drops removed (peer sync);
- the mock walking `parent_id`;
- the dialog's paths: first ask skipped, no re-ask, null acknowledgement, Load more, the re-ask flag;
- the toolbar's focus;
- the e2e-tauri happy path.

**Suites:**
- nextest `--workspace` in 6 partitions: 7157 passed. After the last edits, the targeted space-move, sync, undo and MCP sets passed.
- clippy `-D warnings`; `SQLX_OFFLINE=true cargo check --workspace --all-targets`; all four `.sqlx` caches and the bindings regenerated with no change.
- vitest over pages, journal, hooks, the mock, `src/lib` and `src/__tests__`.
- `npm run typecheck`, `typecheck:e2e-tauri`, lint, import cycles, and prek's manual stage.
- Playwright over the move and spaces specs.
- e2e-tauri: `space-move-property-loss`, `sync-cross-space-move` and `property-defs-per-space`.

**Found, not this slice's:**
- #6080: a page moved to another space loses its trashed blocks. Peers purge them and a restore never syncs. Reproduced on main without S0.6.
- The ignored `conformance_fuzz` lane fails on main: the mock refuses a `priority` value the backend applies by payload replay. Handed to #6054.
