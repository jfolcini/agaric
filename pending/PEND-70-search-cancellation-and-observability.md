# PEND-70 — Server-side cancellation + slow-query logging for search

> Surfaced by the 2026-05-19 backend audit (round 2). `search_blocks_partitioned` has no cancellation token — a fast typist firing 5 keystrokes in 400 ms through the 80 ms palette debounce can queue 5 sequential IPCs that each run to completion on the read pool, even though the frontend's `generationRef` (`CommandPalette.tsx:397, 461`) discards the stale results. With `max_connections(4)` (`src-tauri/src/db.rs:434`), bursty typing can saturate the read pool and stall concurrent surfaces (page browser, backlinks). There's also zero slow-query logging on the search read path — `acquire_logged` only wraps the write pool's `BEGIN IMMEDIATE` today.

## TL;DR

- Wire `tokio::sync::watch` cancellation through `fts_fetch_rows`. The IPC layer drops the JS-side promise on remount; the Rust future should drop too.
- Wrap the read-pool acquire in the same slow-acquire warning pattern `acquire_logged` (`src-tauri/src/db.rs:37`) uses on the write pool, plus per-query timing.
- Net effect: typing bursts no longer waste 5× the CPU; a pathological 100k-block query surfaces in the logs instead of silently stalling.

## Current state — verified

- `src-tauri/src/commands/queries.rs:1017-1027` — `search_blocks_partitioned` is `async fn (..., State<'_, ReadPool>) -> ...`; no cancellation parameter.
- `src-tauri/src/db.rs:37` — `acquire_logged` is the slow-acquire-warning wrapper used by the write pool.
- `src-tauri/src/db.rs:434` — read pool `max_connections(4)`.
- `src/components/CommandPalette.tsx:81` — 80 ms debounce.
- `src/components/CommandPalette.tsx:397, 461` — `generationRef` discards stale responses on the frontend.

## Design

### Cancellation token

Add a `cancel: tokio::sync::watch::Receiver<bool>` to the search builder's signature. Check after each `fetch_one` / `fetch_optional` batch boundary inside `fts_fetch_rows`. The IPC handler creates a per-request `(tx, rx)` pair, fires `tx.send(true)` from a guard that lives as long as the Tauri command's response future. On drop (client unsubscribed), the guard cancels the work.

Concretely:

```rust
pub async fn search_blocks_partitioned(
    state: State<'_, ReadPool>,
    cancel: CancellationGuard, // new
    query: String,
    page_limit: u32,
    block_limit: u32,
    filter: SearchFilter,
) -> Result<PartitionedSearchResponse, AppError> {
    let token = cancel.token();
    // ... existing code; pass `token` into the builder which checks
    // `token.borrow().is_cancelled()` between row chunks.
}
```

The `CancellationGuard` is a small wrapper Tauri command extension that registers a cancellation channel against the request ID; when Tauri drops the response (client unsubscribed), the guard fires the watch. Implementation pattern lives in `tauri-plugin-cancel` or rolled by hand in ~40 LOC.

### Slow-query / per-query timing

Wrap the read-pool acquire and the SQL execute in an instrumented helper:

```rust
async fn search_pool_acquire_logged(
    pool: &SqlitePool,
    label: &str,
) -> Result<PoolConnection<Sqlite>, AppError> {
    let t0 = Instant::now();
    let conn = pool.acquire().await?;
    let dt = t0.elapsed();
    if dt > Duration::from_millis(50) {
        warn!(label, ?dt, "slow read-pool acquire");
    }
    Ok(conn)
}
```

Plus a per-FTS-query timer that logs at `info!` for > 200 ms and `warn!` for > 1 s. Provides the breadcrumbs needed to diagnose pathological queries in production.

### Frontend complement

The frontend already discards stale results via `generationRef`. With backend cancellation in place, the discard becomes a server-side abort too — the frontend can detect `AppError::Cancelled` cleanly without surfacing it to the user (cancellation is the expected case, not an error).

## Tests

- `cancellation_drops_in_flight_query` — fire a search, then drop the response future; assert the Rust task drops within 50 ms.
- `slow_acquire_logs_warning` — saturate the read pool with 5 concurrent searches; assert at least one `warn!` log fires.
- `cancellation_does_not_lose_in_flight_results` — fire two searches with the same query; assert at least one completes (no double-cancel race).
- Integration: rapid-fire keystrokes via `cargo nextest run` simulating the 5-keystroke burst pattern.

## Acceptance criteria

- Dropped client promise → in-flight Rust future drops within one row batch boundary (≤ 50 ms typical, ≤ 200 ms worst case).
- Slow pool acquire (> 50 ms) emits a `warn!` log with label + duration.
- No false-positive `AppError::Cancelled` on legitimate races (e.g., a search that completes the instant the user types another character).
- `cargo nextest run` green; no test-time regressions.

## Open questions

1. **`tauri-plugin-cancel` vs hand-rolled wrapper.** Tauri 2 doesn't ship a first-party cancellation primitive for `async` commands. Two options: (a) hand-roll a ~40 LOC `CancellationGuard` per the design above; (b) pull in `tauri-plugin-cancel` if it exists as a community plugin. **Recommendation:** hand-roll. The plugin landscape for Tauri 2 is still small; one in-repo helper is auditable and avoids a new dependency surface.
2. **Logging level for slow-query events.** The design says `info!` at > 200 ms, `warn!` at > 1 s. Verify these thresholds against current cold-cache wall-clock measurements on a 10k-block fixture — the 1 s threshold might be too aggressive for cold-start CI runs (where the WAL hasn't warmed up).
3. **Surface `AppError::Cancelled` to the frontend or swallow it server-side?** Cancellation is the expected case; surfacing the error to the frontend lets it discriminate "the user gave up" from "the query genuinely failed", but adds noise to the error path. **Recommendation:** surface — the frontend already discriminates via `generationRef`, and silent server-side swallowing is harder to debug.

## Out of scope

- F12 (backpressure / per-caller fairness on the read pool) — bound by this PEND; once cancellation lands, the pool saturation surface area shrinks dramatically and the OS-scheduler-fair-share approach stays acceptable.
- Adding metrics endpoints / Prometheus exposition. Logging is enough for the solo-maintainer case; metrics graduate to a separate PEND if multi-user telemetry surfaces a need.

## Cost / impact

- **Cost:** M (~5-7 h). One Tauri extension or hand-rolled cancellation wrapper (~40 LOC), three call-site updates inside the search builder, one logging helper (~30 LOC), four new tests.
- **Impact:** Bursty-typing CPU savings on the read pool (saturation goes from 5×80 ms = 400 ms of wasted work per burst → 1× ~80 ms). Observability for pathological queries.
- **Risk:** Low-medium. Cancellation plumbing is mechanical but easy to get wrong (deadlock if the guard outlives the runtime); test the drop path explicitly. No SQL changes.

## Related

- PEND-69 — pages partition correctness; touches the same SQL builder.
- PEND-71 — broader search test coverage matrix (concurrent IPC under load is one of the gaps).
- `src-tauri/src/commands/queries.rs`, `src-tauri/src/db.rs`, `src-tauri/src/fts/search.rs`
- `src/components/CommandPalette.tsx:397, 461`
