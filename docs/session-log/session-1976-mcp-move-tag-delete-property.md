# Session 1976 — MCP move_page_to_space, create_tag and delete_property

Issue #5378 asked for four RW tools. This session shipped three. `set_page_aliases` waits on #5387, which makes aliases ops so their writes become undoable and synced.

- **`move_page_to_space`** takes page blocks only. The engine already refuses `space` on a content block and a target space that isn't live, but it would move a top-level tag. The handler's page check exists for that case, and the test uses a tag so it can fail.
- **`create_tag`** resolves `SpaceScope::Active` as `create_page` does. A same-name tag in the space comes back instead of a duplicate.
- **`delete_property`** refuses `space` at the boundary, like `set_property`. The inner already refuses the system-managed keys.

The trap: deleting `todo_state` through the generic path cleared the column but left stale `created_at` / `completed_at` stamps, unlike the app's clear. `delete_property_core` now clears them in the same transaction, beside the existing `repeat` special case. It doesn't route to `set_todo_state_inner(None)`, which would turn the op into a `SetProperty`, break the conformance fixture and force a mock change.

`priority`, `due_date` and `scheduled_date` already behave like the app.

The stale "tags are global" wording in `add_tag` is gone. The tool-list test no longer carries a count in its name.

Suites that ran:
- nextest over the MCP modules, `delete_property`, move-to-space, `create_tag`, conformance and `todo_state`;
- `SQLX_OFFLINE` check of every target;
- clippy over every target.
