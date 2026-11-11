# Session 3805 — the mock's Trash cursor carries deleted_at as a string

Review note from #6499.

- The backend's `Cursor.deleted_at` is `Option<String>`: `list_trash` puts the epoch-ms value in the slot as a string, and `pagination/trash.rs` parses it back to an integer.
- #6499 made the mock's `list_trash` key on the bare number, so its cursor carried a JSON number. Paging still worked, but the wire shape differed from the backend's. The key is back to the string form. At 13 digits, string order is numeric order.
- Correction: session 3803's log cites `Cursor.deleted_at: Option<i64>`. The `Option<i64>` is `BlockRow.deleted_at`, the column's type.
- Test: `list-trash-cursor.test.ts` deletes two blocks and pages `list_trash` one row at a time. It requires a string `deleted_at` slot that still pages to the second root. It went red on main (a number where the backend has a string).
