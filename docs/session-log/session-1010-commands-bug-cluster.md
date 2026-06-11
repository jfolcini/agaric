# Session 1010 — commands correctness bug cluster (#656/#658/#660/#661/#663)

Five verified `commands/` correctness bugs from the backend review, shipped as one cluster
(off post-#882 main to avoid the crud.rs/mod.rs/properties.rs stale-base overlap).

## Shipped

- **`fix(commands)` cluster:**
  - **#656** — `edit_block_inner` (crud.rs) returned a `BlockRow` with `todo_state`/`priority`/
    `due_date`/`scheduled_date` hardcoded `None` though the edit doesn't change them; now threads
    `existing.*` through (latent contract bug — FE discards the response today). Test added.
  - **#658** — `delete_property_inner` (properties.rs) had no built-in-key guard, so FE/MCP could
    delete system-managed `created_at`/`completed_at`/`repeat-*` rows and break recurrence
    bookkeeping. Added `is_builtin_property_key(&k) && !is_reserved_property_key(&k)` — blocks
    exactly the **lifecycle** keys while keeping legit reserved-column clears (`due_date` etc.)
    working (reviewer confirmed the scope against `op.rs` canonical defs + the existing
    reserved-column-clear test stays green).
  - **#660** — `export_page_markdown_inner` (pages/markdown.rs) ran its 200-row keyset loop as N
    independent pool reads (N WAL snapshots) → concurrent edits could skip/duplicate blocks. Now
    the whole read flow runs in ONE `pool.begin()` read tx. The regression test was **verified to
    fail pre-fix** (`snap-line-197 appeared 2 times`).
  - **#661** — `set_page_aliases_inner` (pages/aliases.rs) ran the page-exists probe on the pool
    before `BEGIN IMMEDIATE` (TOCTOU — a concurrent delete left aliases on a tombstoned page).
    Moved the probe inside the tx (the F01/F02/F03 sibling pattern). Tests for nonexistent +
    tombstoned page rejection.
  - **#663** — `get_block_history` passed the raw un-normalized id to SQL, so lowercase callers
    got an empty history silently. The `#[tauri::command]` keeps its `String` param (bindings
    unchanged) but normalizes to `BlockId` internally; `list_block_history` now takes `&BlockId`
    and binds canonical case. Test proves a lowercase id returns the same history.

  Adversarial reviewer: SHIP all 5 (verified the #658 scope, the #660 pre-fix-fails probe, and
  bindings unchanged). 1045 tests pass, clippy clean, `bindings.ts` untouched. Closes #656 #658
  #660 #661 #663.

## Lane status (waste-optimized plan)
Rust lane: this cluster shipped; next = #645-C inversions. YAML lane: #833 docs CI fast-path
(separate PR, maintainer reviews the gate). FE lane: #877 big-bang held for its quiet window,
then the FE bug backlog.
