## Session 901 — #109 Phase 2: peer_refs timestamps → INTEGER ms (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator-only |
| **Items closed** | — |
| **Items modified** | #109 (Phase 2, table 2 of ~10) |
| **Tests added** | repurposed 2 (Rust `peers_due_for_resync_epoch_zero_is_overdue`; FE `formatLastSynced` epoch-0 case) |
| **Files touched** | 10 |

**Summary:** Second table of #109 Phase 2 — migrate `peer_refs.synced_at` and
`peer_refs.last_reset_at` from TEXT (RFC 3339) to INTEGER epoch-ms. Both columns are
nullable and **genuinely independent** of the `op_log.created_at` cluster: they're
self-generated via `now_rfc3339()` at the sync/reset write sites and only ever compared in
Rust (`sync_scheduler::peers_due_for_resync`), never in a cross-table SQL predicate — so
no coupling risk. (Chained on the #231 branch so migration 0075 follows 0074, preserving
apply order.)

**Process note — coupling investigation:** Started on `block_drafts.updated_at` (the
nominal "table 2") but found it hard-coupled to `op_log.created_at`:
`recovery/draft_recovery.rs:93` runs `… AND created_at > ?` binding `draft.updated_at`, so
migrating one side without the other silently breaks the recovery check (SQLite ranks
INTEGER < TEXT by storage class). `attachments.created_at` is similarly coupled
(`materializer/handlers.rs:1334` sets it from the op's `created_at`). Recorded the
finding on #109: `{op_log.created_at, block_drafts.updated_at, attachments.created_at}`
must migrate as one unit; pivoted to `peer_refs`, which is clean.

**Files touched (this session):**
- `src-tauri/migrations/0075_peer_refs_timestamps_ms.sql` (new — rebuild, STRICT, `CHECK (col IS NULL OR col >= 0)`, NULL-preserving `julianday` backfill)
- `src-tauri/src/peer_refs.rs` (`Option<String>→Option<i64>` on `PeerRef`; `now_ms()` at the 3 write sites)
- `src-tauri/src/sync_scheduler.rs` (`peers_due_for_resync` → integer-ms staleness math; test helper `pr` + fixtures)
- `src-tauri/src/command_integration_tests/sync_integration.rs` (epoch-ms `synced_at` binds)
- `src-tauri/.sqlx/*` (regenerated — 2 peer_refs query files now infer `Option<i64>`)
- `src/lib/bindings.ts` (regenerated — `synced_at`/`last_reset_at: number | null`)
- `src/lib/tauri.ts` (`PeerRefRow` timestamps → `number | null`)
- `src/lib/format.ts` (`formatTimestamp` widened to `string | number`; `formatLastSynced` takes `number | null` — fixed a falsy-`0` bug: `!syncedAt` → `== null`)
- 4 FE test files (epoch-ms fixtures + `formatLastSynced` epoch-0 test)

**Verification:**
- `SQLX_OFFLINE=true cargo check --all-targets` — 0 errors, 0 warnings.
- `cargo nextest run peer_refs sync_scheduler sync_integration sync_protocol sync_daemon` — all pass (one integration test surfaced + fixed: it bound ISO strings into the new INTEGER column, which STRICT correctly rejected).
- `npx tsc --noEmit` clean; `npx vitest run` (format + pairing + device-mgmt + tauri suites) — 341 passed.

**Lessons learned (for future sessions):** Before picking a Phase 2 table, grep for
cross-table timestamp comparisons (`created_at .* updated_at`, values flowing from
`record.created_at` into another column). The `op_log.created_at` cluster
(`block_drafts`, `attachments`) must move together; the self-contained columns
(`peer_refs`, `materializer_*`, `link_metadata`) migrate in any order. STRICT is a useful
tripwire here — binding a leftover ISO string into the new INTEGER column fails loudly at
test time rather than silently coercing.

**Commit plan:** single commit / pushed (chained on #231).
