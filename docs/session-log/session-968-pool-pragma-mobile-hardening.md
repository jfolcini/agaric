## Session 968 — DB pool/pragma mobile hardening (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Subagents** | orchestrator build + 1 review |
| **Items closed** | `#420`, `#434` |
| **Items modified** | — |
| **Tests added** | +0 (existing `init_pool_sets_performance_pragmas` updated to assert the new platform consts) |
| **Files touched** | 1 |

**Summary:** Second batch of the 2026-06-05 SQL backend audit. Hardens the
SQLite connection pools for the mobile/tens-of-thousands-of-pages target:
platform-gates the two memory-heavy pragmas so Android no longer risks an
OOM-kill from per-connection page cache, and aligns pool `acquire_timeout` with
the busy-timeout-scale UX budget so pool exhaustion fails fast instead of
freezing the UI for 30s.

**Files touched (this session):**
- `src-tauri/src/db.rs` — `CACHE_SIZE_PRAGMA`/`MMAP_SIZE_PRAGMA` cfg-gated consts; `acquire_timeout(10s)` on both pools; pragma test made platform-aware.

**Changes:**
- `#420` — `cache_size` is per-connection heap (up to 6 connections × 64 MB ≈
  384 MB peak). Now `#[cfg(target_os = "android")]`: 8 MB cache / 64 MB mmap on
  Android; 64 MB cache / 256 MB mmap on desktop (unchanged).
- `#434` — both pools now set `acquire_timeout(Duration::from_secs(10))` instead
  of inheriting sqlx's 30s default (busy_timeout is 5s), so a saturated pool
  surfaces an error within the freeze budget.

**Verification:**
- `cargo nextest run -E 'test(init_pool) or test(performance_pragmas) or test(/db::/)'` — 52 tests run, 52 passed.
- Independent review subagent: cfg-gating valid (exactly one const per target, desktop values byte-identical), both pools covered, units correct, `std::time::Duration` fully-qualified — no issues.
- pre-commit / pre-push hooks.

**Process notes:** Rust-only config change — no SQL query change, so no `.sqlx`
regen. Desktop CI (linux) exercises the `not(android)` branch; Android values are
const-asserted by the same test on that target. RSS measurement on a real
Android device with a ~50k-page DB remains a follow-up before further tuning.

**Commit plan:** single commit; pushed; PR against `main`.
