# Session 2252 — Redo, revert and restore on the real backend (#4671)

#4671's first item asked the real-backend lane to cover the surfaces that
mock conformance waives, undo, redo and revert among them. Undo was covered
by `undo-todo-state` and `page-alias-undo`. Redo, revert from the History
view, and point-in-time restore had no real-lane spec, and the mock's
`restore_page_to_op` was a constant stub when the issue was filed.

**The spec,** `e2e-tauri/history-redo-revert-restore.e2e.ts`: three
scenarios in one vault, each on its own page, each checked after leaving the
page and coming back.
- **Redo:** tick a task, Ctrl+Z, then Ctrl+Y. The todo state holds in place
  and after the round trip.
- **Revert:** two edits to one block, plus a second block. Reverting the
  second edit from the History view (Settings › Data › Open edit history)
  brings back the first text, keeps the other block, and drops the reverted
  text.
- **Restore:** three edits and a new block, then "Reset to this point" at the
  second edit. After the round trip, the second edit's text shows and both
  later changes are gone. The UI's only restore rewinds the whole space
  (`restorePageToOp('__all__', …)`), so this scenario runs last.

**Shown red** locally on the real backend under Xvfb, one Rust break in
`commands/history.rs` at a time, with the tree restored after each run. Each
break failed only its own scenario:
- `redo_page_op_inner` rolls back instead of committing: "redo did not
  restore the todo state in place".
- `revert_ops_inner` reverts nothing: "the reverted edit did not roll back:
  the text before it never came back".
- `restore_page_to_op_inner` starts its sweep a millisecond early: "the edit
  at the restore point is gone after the restore".

Without the breaks, the spec passed in CI (run 38937318512).

**Local lane:** `tauri-driver`, `webkit2gtk-driver` and `openbox` now make
the lane runnable on the maintainer's box. A run there has to strip
`WAYLAND_DISPLAY` and force `GDK_BACKEND=x11`; otherwise GTK opens the
window on the desktop session rather than Xvfb.
