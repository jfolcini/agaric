# Session 4342 — review-notes batch (#6924, #6929, #6934, #6936, #6938)

Non-blocking reviewer notes from merged PRs, each confirmed against origin/main before fixing.

- **#6924:** `SpacesTab.test.tsx`'s `workId` is `WORK`, beside `PERSONAL`.
- **#6929:** `manage_settings_state` (`lib.rs`) manages the six states the Settings panels read (MCP lifecycle, toggle gate and activity ring, the mirror's, mDNS and bind-exposure status). Boot and `HeadlessApp::over` both call it. Boot keeps the MCP lifecycle, the ring and the mirror state it returns for the MCP server and the mirror task. `wire_mcp_server` no longer manages anything, so the mDNS and bind states are now managed earlier in boot, still before the daemon spawns. `the_settings_status_reads_answer_on_a_headless_app` goes red when the helper drops a state.
- **#6934:** the mock's `__mockExtraPages` / `__mockFacetFixture` opt-ins are gone. The two mock unit tests seed through `addBulkPages` in `__tests__/mock-store-helpers.ts`, which writes the stores directly. Real commands answered within one tick would tie the edit stamps those tests order on. Taking the stamp out of the helper turns 8 tests red. A trap for later: `bulk-pages-history-order`'s undo case stays green when `sortOpLogNewestFirst` returns plain push order, because `undo_page_op` is scoped to a page with one op. That was already true on main.
- **#6936:** `commands/queries.rs`'s `local_days` is `local_day_predicate_sql`.
- **#6938:** dropped the stale sentence about the full title from `blockRef.tsx`'s comment.

Ran: `cargo clippy --workspace --all-targets -- -D warnings`, nextest for headless, MCP wiring, conformance_ipc and the queries day filters, typecheck, oxlint, and vitest over `src/lib/tauri-mock`, `SpacesTab` and `RichContentRenderer`.
