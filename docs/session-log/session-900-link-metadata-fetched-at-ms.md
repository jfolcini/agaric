## Session 900 — #109 Phase 2: link_metadata.fetched_at → INTEGER ms (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator-only |
| **Items closed** | — |
| **Items modified** | #109 (Phase 2, table 1 of ~10) |
| **Tests added** | +1 backend (`is_stale_zero_timestamp`; converted `is_stale_invalid_timestamp` → boundary/future coverage) |
| **Files touched** | 8 |

**Summary:** First table of #109 Phase 2 — migrate the legacy TEXT (RFC 3339)
`link_metadata.fetched_at` column to INTEGER milliseconds-since-epoch, the canonical
encoding codified in Phase 1 (`crate::db::now_ms()`). Picked first per the issue's
least-hot-first ordering: `link_metadata` is a device-local, NOT-synced cache with no
FKs/triggers/indexes beyond its PK, so it establishes the migration shape with minimal
blast radius. Per the 2026-05-29 maintainer decision, the IPC type breaks `string` →
`number` (no ISO re-encode shim). No FE code reads `.fetched_at` for display, so the
frontend change is type + mock-fixture only.

**Files touched (this session):**
- `src-tauri/migrations/0074_link_metadata_fetched_at_ms.sql` (new — table-rebuild recipe, STRICT, `CHECK (fetched_at >= 0)`, `julianday`-based ms-precise backfill)
- `src-tauri/src/link_metadata/mod.rs` (`fetched_at: String→i64`; row + From; `now_ms()` writes; `cleanup_stale` ms cutoff; `clear_auth_flag` ms)
- `src-tauri/src/commands/link_metadata.rs` (`is_stale` takes `i64`, whole-day resolution preserved; test fixtures)
- `src-tauri/src/link_metadata/tests.rs` (epoch-ms fixtures)
- `src/lib/bindings.ts` (regenerated — `fetched_at: number`)
- `src/lib/tauri.ts` (`LinkMetadata.fetched_at: number`)
- `src/lib/tauri-mock/handlers.ts` (`Date.now()` instead of ISO string)
- 4 FE test files (epoch-ms number fixtures / `toBe('number')`)

**Verification:**
- `SQLX_OFFLINE=true cargo check --all-targets` — 0 errors, 0 warnings.
- `cargo nextest run link_metadata` — 82 passed.
- Backfill formula sanity in `sqlite3`: `CAST(ROUND((julianday(ts) - 2440587.5) * 86400000.0) AS INTEGER)` reproduces known epoch-ms values exactly, millisecond precision preserved (verified `…789` sub-second).
- `cargo test specta_tests -- --ignored` — bindings regenerated (semantic diff = `fetched_at: number` only; trailing-whitespace noise stripped).
- `npx tsc --noEmit` — clean.
- `npx vitest run` (link-metadata + tauri suites) — 491 passed.

**Process notes:** `is_stale` deliberately keeps **whole-day** resolution
(`age_ms / 86_400_000 > max_days`) rather than an exact-ms comparison — the pre-migration
`num_days() > max_days` semantics meant "exactly 7 days" is fresh, and an exact-ms
comparison would flip that boundary under sub-ms timing skew between the two `now_ms()`
reads. The `.sqlx` cache needed no regen: every `link_metadata` query is a runtime
`query`/`query_as`, not a compile-time macro.

**Lessons learned (for future sessions):** The per-table Phase 2 recipe is now proven —
(1) table-rebuild migration with `julianday`-based ms backfill + STRICT + `CHECK >= 0`,
(2) `String→i64` on the struct/row/From, (3) `now_ms()` at writes + ms arithmetic at
comparisons (preserve any day/granularity semantics deliberately), (4) regen bindings and
flip FE type to `number` + fixtures, (5) strip bindings.ts trailing whitespace so the diff
is semantic-only. Replicate per remaining table, least-hot-first.

**Commit plan:** single commit / pushed.
