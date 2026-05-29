## Session 902 — #109 Phase 2: materializer_apply_cursor.updated_at → INTEGER ms (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator-only |
| **Items closed** | — |
| **Items modified** | #109 (Phase 2, table 3 of ~10) |
| **Tests added** | 0 (existing recovery/materializer suites cover the cursor; fixtures updated) |
| **Files touched** | 4 |

**Summary:** Third table of #109 Phase 2 — migrate `materializer_apply_cursor.updated_at`
from TEXT (RFC 3339) to INTEGER epoch-ms. This single-row bookkeeping table's `updated_at`
is **write-only** (every reader selects only `materialized_through_seq`), so it's fully
independent of the `op_log.created_at` cluster and the lowest-risk remaining column.
Done as its own single-table PR off `main` (migration 0076) — one migration in flight at a
time to sidestep both the chained-PR auto-close hazard and the sqlx out-of-order-merge gap.

**Files touched (this session):**
- `src-tauri/migrations/0076_apply_cursor_updated_at_ms.sql` (new — rebuild + STRICT + `CHECK (updated_at >= 0)`, preserves `CHECK (id = 1)`; `julianday` backfill of the single row)
- `src-tauri/src/materializer/handlers.rs` (`advance_apply_cursor`: `now_rfc3339()` → `now_ms()`)
- `src-tauri/src/recovery/replay.rs` (2 cursor-reset writes → `now_ms()`; 4 test-helper literal `'2026-01-01…'` → `1767225600000`)
- `src-tauri/src/recovery/tests.rs` (`set_cursor` helper → `now_ms()`)

**Verification:**
- `SQLX_OFFLINE=true cargo check --all-targets` — 0 errors, 0 warnings.
- `cargo nextest run recovery materializer` — 292 passed.
- `.sqlx` regen produced **no diff** — the column is never SELECTed, and SQLite bind-param
  types are lenient, so no query metadata changed. (Still regenerated to confirm.)

**Process notes:** No bindings/FE work — `materializer_apply_cursor` is not IPC-exposed.
Under STRICT the test helpers that wrote literal RFC 3339 strings (`set_cursor`, the
replay corruption-injection helpers) had to switch to integer ms or they'd be rejected at
runtime — a good tripwire that all writers were found.

**Commit plan:** single commit / pushed.
