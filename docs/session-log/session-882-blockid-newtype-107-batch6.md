## Session 882 — BlockId newtype propagation, batch 6 (agenda cache) (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator + 1 build (verified independently) |
| **Items closed** | — |
| **Items modified** | `#107` (batch 6 of N) |
| **Tests added** | — (type migration) |
| **Files touched** | 1 (+ .sqlx) |

**Summary:** Batch 6 of the `BlockId` newtype migration (#107). Converted `CacheRepeatingRow.id` (`src/cache/projected_agenda.rs`) — the projected-agenda recompute row — from `String` to `BlockId`. Type-only; no behaviour change. After this, the only remaining `#107` FromRow struct is the sensitive `snapshot/types.rs` (deferred — needs encode/decode review).

**Files touched (this session):**
- `src/cache/projected_agenda.rs` — `CacheRepeatingRow.id` → `BlockId`; the compile-time `query_as!` gained `b.id AS "id: crate::ulid::BlockId"`; one cascade site in `project_block_into` (`block_id.as_str().to_string()` into the `Vec<(String,…)>` buffer). The runtime `query_as::<_,_>` reader needed no change (transparent derive).
- `src-tauri/.sqlx/` — 1 query JSON swapped.

**Verification:**
- `cargo build --tests` — 0 errors (orchestrator re-ran independently; subagent green held).
- `cargo nextest run` — 4067 passed, 6 skipped, 0 failed.
- `cargo clippy --all-targets` — 0 errors / 0 new warnings.
- `cargo sqlx prepare --check` passes; `bindings.ts` unchanged (private struct); pre-commit + pre-push hooks pass.

**Commit plan:** single commit / pushed. #107 stays open — remaining work is `snapshot/types.rs` (the snapshot wire-format row types; the plan flags this for encode/decode review, best done orchestrator-direct in daylight).
