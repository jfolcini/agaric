## Session 881 — BlockId newtype propagation, batch 5 (Draft) (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator + 1 build (verified independently) |
| **Items closed** | — |
| **Items modified** | `#107` (batch 5 of N) |
| **Tests added** | — (type migration) |
| **Files touched** | 5 (+ .sqlx) |

**Summary:** Batch 5 of the `BlockId` newtype migration (#107). Converted `Draft.block_id` (`src/draft.rs`) from `String` to `BlockId` and fixed the read-site cascade, which reaches into the draft-recovery path. Type-only — no behaviour change.

**Files touched (this session):**
- `src/draft.rs` — `Draft.block_id` → `BlockId`; the two `query_as!(Draft, ...)` readers gained `block_id AS "block_id: crate::ulid::BlockId"` column overrides.
- `src/recovery/boot.rs` — `.to_string()` / `.as_str()` at the recovery call sites (`log_draft_error`, `delete_draft`, the `Vec<String>` collect).
- `src/recovery/draft_recovery.rs` — `.as_str()` for HashSet lookups, debug-assert string ops, `find_prev_edit`/`from_trusted` args.
- `src/lib/bindings.ts` — 1 line: `Draft.block_id` now the transparent `BlockId` TS alias (= `string`; wire-identical).
- `src-tauri/.sqlx/` — 2 query JSONs replaced (the two reworded Draft SELECTs).

**Scope notes:** `#[tauri::command]`/`*_inner` `block_id: String` params left as IPC inputs (out of scope); the ad-hoc `query!` row in `flush_all_drafts_inner` is not the `Draft` struct, left `String`.

**Verification:**
- `cargo build --tests` — 0 errors (orchestrator re-ran independently; subagent green held — IDE diagnostics mid-run were a stale snapshot, as in batches 3-4).
- `cargo nextest run` — 4067 passed, 6 skipped, 0 failed.
- `cargo clippy --all-targets` — 0 errors / 0 new warnings.
- `cargo sqlx prepare --check` passes (cache regenerated); pre-commit + pre-push hooks pass.

**Commit plan:** single commit / pushed. #107 stays open (remaining: `cache/projected_agenda.rs` and the sensitive `snapshot/types.rs`).
