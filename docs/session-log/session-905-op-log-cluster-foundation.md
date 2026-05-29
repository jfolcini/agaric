## Session 905 — #109 Phase 2 op_log cluster: migrations + convention foundation (WIP) (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator-only |
| **Items closed** | — |
| **Items modified** | #109 (Phase 2 — cluster foundation only; **NOT mergeable yet**) |
| **Tests added** | 0 (foundation only) |
| **Files touched** | 6 (4 migrations + plan doc + this log) |

**Summary:** Foundation for the final #109 Phase 2 cluster — `op_log.created_at`,
`blocks.deleted_at`, `attachments.created_at`, `block_drafts.updated_at` → INTEGER
epoch-ms (maintainer hard-cutover decision, 2026-05-29). This branch carries **only the 4
verified migrations + the locked type convention** (`docs/cluster-109-op-log-plan.md`).
**It does NOT compile/pass tests yet and must NOT be merged** until the Rust propagation
lands — the change is atomic (the migrations make the columns INTEGER, so all ~200 Rust
call sites must read `i64` or tests fail at runtime).

**Why this is a separate, careful piece:** unlike the 5 device-local cache tables already
merged (link_metadata/peer_refs/apply_cursor/retry_queue/pages_cache), these 4 columns are
embedded in the **sync wire format** (`OpTransfer`), the **snapshot format**
(`BlockSnapshot`/`AttachmentSnapshot`), the **op payload** (`RestoreBlockPayload.deleted_at_ref`),
and **4 FE IPC types** — plus the pagination **`Cursor`** overloads one slot to carry both
i64 timestamps and date strings. A first propagation attempt oscillated (155→273 errors)
by flip-flopping the Cursor/helper signatures without a fixed convention; that churn was
reset and the convention written down so the redo converges monotonically.

**Files (this branch):**
- `src-tauri/migrations/0079_op_log_created_at_ms.sql` (rebuild + STRICT + CHECK; recreates the 0036 immutability triggers + 3 indexes verbatim)
- `src-tauri/migrations/0080_blocks_deleted_at_ms.sql` (0073-style 12-step rebuild; page_id CHECK + 2 triggers + 9 indexes; nullable INTEGER)
- `src-tauri/migrations/0081_attachments_created_at_ms.sql` (rebuild; `deleted_at` stays TEXT — out of scope)
- `src-tauri/migrations/0082_block_drafts_updated_at_ms.sql` (rebuild + STRICT)
- `docs/cluster-109-op-log-plan.md` — the locked per-layer type convention + verify recipe

**Verification:** all 4 migrations apply cleanly to a fresh DB (`sqlx migrate run`); types
confirmed INTEGER; op_log keeps 2 immutability triggers; blocks keeps 2 triggers + 9
indexes. **No Rust verification** — propagation not started on this clean base.

## HOW TO CONTINUE AND FINISH (next session)

1. `git checkout ts-cluster-final` (rebase onto latest `main` first; if `main` gained new
   migrations, renumber 0079–0082 accordingly).
2. Apply the propagation per `docs/cluster-109-op-log-plan.md` — the convention is fixed,
   so apply it once and don't deviate (esp. **Cursor.deleted_at stays `String`** with
   explicit `.to_string()` encode / `.parse::<i64>()` decode bridges).
3. Work in **ONLINE sqlx mode** so `query!` macros validate against the INTEGER schema:
   `cd src-tauri && set -a && . ./.env && set +a && sqlx database drop -y && sqlx database create && sqlx migrate run --source migrations`, then `unset SQLX_OFFLINE` before `cargo check --all-targets`. Drive the error count to 0 monotonically, file-by-file.
4. Order: core type defs (op.rs/op_log.rs/sync_protocol/snapshot/draft/pagination row
   structs) → producers (`now_rfc3339`→`now_ms`) → call sites → cursor bridges → tests.
5. `cargo sqlx prepare -- --tests`; `cargo test specta_tests -- --ignored` (bindings);
   flip the 4 FE IPC types to `number` + fix consumers; `tsc` + `vitest`.
6. **Full `cargo nextest run` is the correctness arbiter** (op_log/dag/recovery/sync/
   soft-delete proptests guard the event log + restore + cross-device sync).
7. Only then is the branch mergeable — drop the DRAFT/DO-NOT-MERGE marker.

**Commit plan:** foundation only / pushed as a DRAFT (do-not-merge) PR.
