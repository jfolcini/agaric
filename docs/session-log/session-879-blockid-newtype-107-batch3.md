## Session 879 — BlockId newtype propagation, batch 3 (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator + 1 build (verified independently) |
| **Items closed** | — |
| **Items modified** | `#107` (batch 3 of N) |
| **Tests added** | — (type migration) |
| **Files touched** | 6 |

**Summary:** Batch 3 of the `BlockId` newtype migration (#107). Converted the block-ULID fields of the `sqlx::FromRow` row structs in `src/commands/mod.rs` from `String` to `BlockId` and fixed the read-site cascade. Type-only — no behaviour change.

**Files touched (this session):**
- `src/commands/mod.rs` — `AttachmentRow.{id,block_id}`, `ResolvedBlockRow.id`, `BatchPropertyRow.block_id` → `BlockId`.
- `src/commands/attachments.rs`, `src/commands/blocks/queries.rs`, `src/commands/properties.rs` — cascade fixes at construction / HashMap-key boundaries (`.into_string()`, `BlockId::from_trusted`).
- `src/commands/tests/block_cmd_tests.rs` — test call sites (`.as_str()`, `.into_string()`).
- `src/lib/bindings.ts` — 2 lines: `AttachmentRow.{id,block_id}` now the transparent `BlockId` TS alias (= `string`; wire format byte-identical).

**Scope notes (deliberately left as `String`):** `#[tauri::command]` / `*_inner` params (IPC inputs, out of scope); `PropertyRow` (no block-id field); `RepeatingBlockRow` (not a FromRow struct); `ResolvedBlock`/HashMap-key return types (converted at the boundary); `snapshot/`, `sync_protocol/`, `op_log.rs device_id` (out of scope — sensitive wire formats / different id type).

**Verification:**
- `cargo build --tests` — 0 errors (orchestrator re-ran independently to confirm; the subagent's green state held — IDE rust-analyzer diagnostics during the run were a stale mid-edit snapshot).
- `cargo nextest run` — 4067 passed, 6 skipped, 0 failed.
- `cargo clippy --all-targets` — 0 errors / 0 new warnings (method-paths used to avoid `redundant_closure_for_method_calls`).
- `.sqlx` cache unchanged (the `#[sqlx(transparent)]` derive handled `query_as!` into the structs without column annotations).
- pre-commit + pre-push hooks pass.

**Commit plan:** single commit / pushed. #107 remains open (further batches: snapshot/types.rs is the sensitive one, plus other commands/ + cache row structs).

**Lessons learned:** IDE rust-analyzer diagnostics surfaced after a subagent edit can be a stale mid-edit snapshot — always re-run `cargo build --tests` for ground truth before trusting OR distrusting them.
