## Session 880 — BlockId newtype propagation, batch 4 (FTS rows) (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator + 1 build (verified independently) |
| **Items closed** | — |
| **Items modified** | `#107` (batch 4 of N) |
| **Tests added** | — (type migration) |
| **Files touched** | 2 |

**Summary:** Batch 4 of the `BlockId` newtype migration (#107). Converted the block-ULID fields of the FTS read-row structs (`FtsSearchRow`, `RegexScanRow`) from `String` to `BlockId` and fixed the cascade. Type-only — no behaviour change.

**Files touched (this session):**
- `src/fts/search.rs` — `FtsSearchRow.{id, parent_id}` → `BlockId` / `Option<BlockId>`; cursor + `fts_row_to_block_row` cascade.
- `src/fts/toggle_filter.rs` — `RegexScanRow.{id, parent_id}` → `BlockId` / `Option<BlockId>`; mapping-site cascade.

**Scope notes:** `page_id` left as `String` in both (it's a page id, not a block ULID). The wire struct `SearchBlockRow` (already uses `ActiveBlockId`) untouched; conversions happen at the boundary with `.into_string()` / `from_trusted_active(.as_str())`. Both structs are private (no specta/IPC exposure).

**Verification:**
- `cargo build --tests` — 0 errors (orchestrator re-ran independently; subagent green held — IDE diagnostics mid-run were a stale snapshot, same as batch 3).
- `cargo nextest run` — 4067 passed, 6 skipped, 0 failed.
- `cargo clippy --all-targets` — 0 errors / 0 new warnings (method-paths, not closures).
- `.sqlx` unchanged (runtime `query_as::<_,T>` + transparent derive); `bindings.ts` unchanged (private structs).
- pre-commit + pre-push hooks pass.

**Commit plan:** single commit / pushed. #107 stays open (remaining: `draft.rs` Draft, `cache/projected_agenda.rs`, and the sensitive `snapshot/types.rs`).
