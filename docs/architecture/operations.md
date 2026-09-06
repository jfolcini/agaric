<!-- markdownlint-disable MD060 -->
# Performance & Scalability

How the system stays responsive at scale, and the architectural choices that get it there.

## Product SLO

The product target is **interactive commands ≤ 200 ms p95 at 100K blocks**. `src-tauri/benches/interactive_slo.rs` supports that target with a scheduled regression gate, but does not directly enforce p95: it accumulates elapsed time and iteration counts across Criterion's batched `iter_custom` invocations, then enforces the resulting **mean** against each command's inline budget (the bench file is the canonical source for those budgets). Most command budgets are substantially tighter than 200 ms, so the mean gate remains useful and fails the scheduled lane on broad regressions, but it is not a guarantee about the per-call tail.

The harness intentionally does not compute a percentile over Criterion batch means. Individual-call latencies are not retained, so such a percentile would still dilute a slow-call tail; genuine p95 enforcement would require per-call timing. The ≤200 ms p95 figure therefore remains the product target, while the accumulated mean under the per-command budget is the metric enforced today.

Every interactive command is now in the enforced green tier except `revert_ops` (separate `SLO_INCLUDE_REVERT=1` gate, aspirational budget). `list_page_links` was promoted after the 20K count-then-cap (#2529) brought it under budget. `list_projected_agenda` was **graduated off `SLO_INCLUDE_PROBLEM` into the green tier by #2601**: its earlier straddle was an artefact of the bench measuring the COLD-cache on-the-fly fallback (it seeded repeating blocks but never populated `projected_agenda_cache`). The production interactive read is a warm-cache index scan, and #2601 makes that the measured path — see "Bounded-horizon projected agenda" below. The graph path remains the known scaling frontier.

**Bounded-horizon projected agenda (#2601).** `projected_agenda_cache` now materializes only the next `HORIZON_OCCURRENCES` (13 × 7 = 91) occurrences per repeating block per date source, instead of every occurrence inside a fixed 365-day window. Reads become a pure O(window) index scan — recurrence expansion happens on the write/rebuild path, never on the interactive hot path. The rebuild records the guaranteed-complete horizon date (`today + HORIZON_DAYS = today + 90`, the tightest daily-cadence bound) in `projected_agenda_horizon`, written in the same transaction as the rows; `list_projected_agenda_inner` falls back to on-the-fly projection for any query whose end date reaches past it, so a sub-year horizon never returns an incomplete page. The horizon advances whenever a repeat rule / date / todo-state edit re-triggers the rebuild (existing materializer invalidation); a vault that sits idle for days simply serves the rare far-future query from the on-the-fly fallback until the next rebuild re-anchors `today`. The `bench_list_projected_agenda` green-tier bench warms the cache, then measures the index-scan read across 100/1K/10K/100K — flat under 200 ms because latency tracks the query window, not the fixture size.

## Architectural decisions that buy responsiveness

### Materializer apply-cursor semantics (C-2b)

The apply cursor (`materializer_apply_cursor.materialized_through_seq`) tracks **replay/remote apply progress, not local write progress** (#1248, revised by #2250 / #2325). Every apply path — the live local command path included — runs the same collapsed entry point, `apply_op_projected`, which applies the op to the per-space Loro engine *and* the SQL projection in one transaction. The paths differ only in the `advance_cursor` flag: remote apply and boot replay advance the cursor atomically with the apply; the local command path deliberately does not, so boot recovery re-applies the prior session's local ops from the cursor — idempotent (`INSERT OR IGNORE` + per-op-type guard) and kept as a standing safety net that exercises the replay path on every startup. #1257 (route local ops through engine-apply) is closed — the collapse did exactly that. See `docs/architecture/data-and-events.md` § Apply-cursor semantics for the full discussion.

### Cache streaming on rebuilds

Cache rebuild jobs (`tags_cache`, `pages_cache`, `agenda_cache`, `projected_agenda_cache`, FTS) **stream** rows from the read pool, transform, and batch-INSERT into the write pool. Earlier passes buffered entire result sets in memory before flushing — fine at 1K blocks, OOM at 100K. The streaming pattern keeps memory bounded at ~one batch's worth.

### Sync streaming over framed pull

Both snapshot transfer (catch-up) and attachment file transfer stream on the same QUIC bi-stream the control messages use, copied through one fixed 5 MB buffer (`BULK_COPY_BYTES` in `src-tauri/agaric-sync/src/transport/bulk.rs`). Every read is sized from that buffer's own length rather than from the declared total, so allocation stays constant however large the transfer; the declared size is bounded against a caller-supplied cap *before* the first read. Sender holds open a producer task that pulls from a `BufReader`. Memory bounded; back-pressure comes from QUIC's flow-control windows rather than from a hand-rolled chunk loop.

### Per-page block stores

Multiple open page tabs share a single `useBlockStore` for focus / selection, but each page's block content lives in an **independent store** built by `createPageBlockStore(pageId)`. Switching tabs doesn't churn the React tree of other tabs; closing a tab drops just its slice. Without this, 5 open pages = 5x the block-render overhead.

### Cursor-only pagination

Every list IPC is cursor-paginated, never offset-paginated. Offset O(N) penalty avoided; concurrent edits don't shift the pages.

### Specta single-source-of-truth IPC

Generated TS bindings + the macro single-source means there's no per-PR drift cost — adding a command updates both ends from one edit, and CI catches a stale `.ts` file. Saves ongoing maintenance latency that would otherwise compound.

### Per-space scoping in SQL

Space filter is pushed into the SQL `WHERE` clause everywhere it matters (canonical fragment pinned by `SPACE_FILTER_CANONICAL` parity test). Cross-space queries don't load + post-filter — they stop at the SQL engine. The drift-detection test walks `src/**/*.rs` and asserts the canonical shape on every match; no site count is pinned, so adding a site can't desync.

## Memory footprint & scaling envelope

The sections above describe how individual paths *bound* memory; this one consolidates where memory actually goes, what it scales with, and what that means on memory-constrained Android (1–3 GB RAM, ~24 MB release heap).

### Where memory goes

- **Loro engines (per-space, in process).** The CRDT state is a `LoroEngineRegistry` — a process-local `HashMap<SpaceId, LoroEngine>` rebuilt from persisted per-space snapshots on boot and held resident for the process lifetime (`src-tauri/agaric-engine/src/loro/snapshot.rs`). Because partitioning is per-space, resident Loro memory scales with **total live block state across all open spaces**, and the spike paths below scale with the **largest single space**, not the whole vault.
- **Op-log recovery.** `recover_blocks_from_op_log` `fetch_all`s the entire `op_log` before replaying (`src-tauri/src/db/recovery.rs`); the row-source `Vec` fully materialises, so peak RAM there is **O(vault), not O(chunk)**. This is the acknowledged OOM risk (#1624, #129). #4699 removed the other half of it: compaction used to read every row of every derived table into per-table `Vec`s and CBOR+zstd-encode them on each 24 h tick, for a blob nothing read.
- **Cache rebuilds.** Bounded by design: rebuild jobs stream rows and batch-INSERT (see "Cache streaming on rebuilds" above), and the projected-agenda rebuild flushes a working buffer at a 10 000-entry chunk — peak ≈ 500 KB versus the ~18 MB the pre-M-19 full-buffer path peaked at on a 1000-block × 365-day vault, "larger on Android" (`src-tauri/agaric-store/src/cache/projected_agenda.rs`).
- **FTS index.** `fts_blocks` is a standalone trigram FTS5 table that stores stripped text in a shadow content table *plus* a trigram index (~3×). A per-block cap of `FTS_MAX_INDEXED_BYTES = 128 KiB` keeps one pathological pasted multi-MB block from dominating the index on memory-constrained mobile (`src-tauri/agaric-store/src/fts/strip.rs`); it bounds the worst case per block, it is not a measured budget.

### Dominant scaling factors

1. **Cold start** — materializer boot rehydrates every per-space Loro engine and refreshes caches. Resident memory after boot tracks total live block state.
2. **Op-log replay** — the worst remaining spike: recovery buffers the full `op_log` row source in memory (above). Sync *transfer* itself is bounded (5 MB framed pull, "Sync streaming over framed pull" above).
3. **FTS rebuild** — a full reindex re-strips and re-indexes every block; per-block contribution is capped but total work scales with block count.

### Known OOM risks

- **Op-log replay buffers the whole log** (#1624). `recover_blocks_from_op_log` materialises a full row-source `Vec`, and there is no guard on it — the `SNAPSHOT_WARN_ROW_COUNT` / `SNAPSHOT_WARN_PAYLOAD_BYTES` warns went with the snapshot blob in #4699, because after that the thing they warned about (compaction buffering the derived vault) no longer happens. Recovery is the rare disaster path by construction; the streaming rewrite is still deferred pending Android profiling (#129, `SQL-M-8`).

### Guidance for memory-constrained Android (1–3 GB)

- **Vault-size envelope.** Interactive responsiveness is bench-validated to 100K blocks (`FIXTURE_SIZE = 100_000` in `src-tauri/benches/interactive_slo.rs`); treat **~100K blocks per space as the comfortable ceiling** on a 1–3 GB device. A precise per-device peak-RAM-at-N-blocks figure is **not yet measured** — the existing benches validate interactive latency at scale (#1231), not resident/peak RAM, so a dedicated resource-envelope measurement is needed before a hard number can be stated here; do not infer a hard MB-per-block number from the figures above.
- **What to avoid on low-RAM devices.** Single multi-MB pasted blocks (the FTS cap truncates indexing of the tail, but the block content still lives in the Loro doc); letting a single space grow unbounded; and triggering a disaster-recovery replay or an FTS rebuild on a very large vault while other apps are pressuring the heap.
- **Mitigation.** Split content across spaces (the Loro engine spike is per-space, so several smaller spaces peak lower than one large one); archive or prune stale pages to keep live block count down.

## Pool architecture

`WritePool` (2 connections) + `ReadPool` (4 connections), each a `sqlx::Pool` with type-safe newtype wrappers. The newtype guards prevent accidental writes through the read pool or vice versa.

Background materializer tasks use the read pool for the SELECT phase and only acquire a write connection for the final DELETE + batch-INSERT. Foreground (interactive) commands use the write pool directly.

### Write-lock hold-time contract (#2470)

The required shape for an O(vault) background job is **read-phase / brief-write**
— never "do the scan under the write lock":

1. **Collect** in a `DEFERRED` read transaction (`pool.begin()`). Under WAL a reader never blocks the writer, so an O(vault) table scan does not stall interactive commands. `compact_op_log`'s read phase (`src-tauri/agaric-sync/src/snapshot/create.rs`) follows this shape: it counts eligible ops and reads the per-device frontier with no write lock held.
2. **Write** in a brief `BEGIN IMMEDIATE` transaction that performs only the minimal INSERT/UPDATE/DELETE, never the collection. `compact_op_log`'s write phase upserts the `compaction_watermark` row, runs the per-device `op_log` DELETE and clamps the apply cursor, then commits.

Every `BEGIN IMMEDIATE` acquire above routes through `begin_immediate_logged` (`src-tauri/src/db/pool.rs`), which times the pool-acquire *and* SQLite-lock-acquire together and emits a `slow BEGIN IMMEDIATE` warning once that exceeds `SLOW_ACQUIRE_WARN_MS` (100 ms, `src-tauri/src/db/pool.rs`) — this warning is the standing observability primitive for a regression in the pattern above.

**The long-hold exception is gone with the snapshot restore (#4699).** `apply_snapshot` wiped and re-seeded every core and cache table inside one `BEGIN IMMEDIATE` transaction, and its measured hold at 100K blocks was ~18 s — well past the 5 s `busy_timeout`, so every interactive command issued during a restore failed `pool_busy`. Nothing called it in production, and #4699 deleted it along with the blob it restored. No background job in the tree now holds the write lock for an O(vault) scan.

**The `pool_busy` story end-to-end.** The write pool's `busy_timeout` is 5 s (`src-tauri/src/db/pool.rs`). A command that cannot acquire the write lock within that window surfaces as `sqlx::Error::PoolTimedOut`, which the backend routes to `AppError::PoolTimedOut` (kind `pool_busy`) rather than the generic `Database` variant specifically so the frontend can offer a retry instead of a hard failure (`src-tauri/agaric-core/src/error.rs`). The frontend's `isPoolBusy` predicate and the shared `retryOnPoolBusy` helper both live in `src/lib/app-error.ts`; every block-mutating store action routes through the latter (`src/stores/page-blocks-reducers.ts`, tagged `#730`) with a bounded 3-attempt, 0/50/150 ms backoff before bubbling the error to the caller. The scenario most likely to exhaust that budget used to be a long `apply_snapshot` hold (#2470's writer probe measured a full 5.008 s wait then `SQLITE_BUSY`); #4699 deleted it, and no remaining path holds the write lock long enough to make the FE's bounded retry (max ~200 ms of backoff) hopeless by construction.

## FTS5 maintenance

The FTS index is rebuilt incrementally on every block edit. A background optimize task runs after `max(500, block_count / 10_000)` writes — adaptive so small vaults don't optimize too often and large vaults do — with a 60-minute ceiling so an idle-but-recently-edited vault still gets maintenance.

The strip pass (`src-tauri/agaric-store/src/fts/strip.rs`) resolves `[[ULID]]` / `#[ULID]` to target titles before indexing, so a search for a page name matches blocks that link to it (not just blocks that contain the literal ULID).

## Engine format version & downgrade recovery

The per-space Loro engine stamps `ENGINE_FORMAT_VERSION` (currently `2`) into each snapshot on export and checks it on import (`src-tauri/agaric-engine/src/loro/engine/mod.rs`). Once a snapshot has been re-saved under engine format v2, **downgrading to a pre-#332 build is the only forward-migration route** — there is no in-place v2→v1 conversion, so a host that must run an older build has to restore from a v1-era snapshot or re-derive state from the op log on that build.

A v1 peer cannot sync with a v2 peer: the raw Loro bytes are incompatible across the format boundary. As of #2130 the sync handshake gates this **up front**. The initiator advertises its `engine_format_version` in the `HeadExchange` message, and the responder rejects an incompatible peer before any raw-byte merge — emitting a clear `SyncEvent::Error` ("peer engine format vN incompatible with local vM") and failing the session, instead of letting the bytes reach an import and surfacing a confusing mid-session failure. A version of `0` denotes a legacy peer predating the field; it is accepted and falls through to the existing import-time format guards (`reject_legacy_v1_snapshot` / `reject_unknown_format_version`).

## Roadmap

What's not yet shipped is tracked separately. High-level items today:

- **OS notifications** for due tasks (Org-mode parity; mobile especially).
- **iroh transport** — **shipped** (#78, plan #3464). Both sync roles run over QUIC; `sync_net/`, `sync_cert.rs` and `sync_daemon/wire.rs` were deleted outright in #3544. What the port itself did *not* fix, and was closed separately: first-ever pairing initiation (#3502 — daemon policy, not transport, fixed in #3535). Also closed separately: the S-5 lock key was asymmetric during the pairing window (#3511 — both roles now key on the peer's `EndpointId`, per #3529). Still open from the cutover: inbound is single-homed (#3513) and wire compression is gone (#3512).
- **rmcp migration** — M1 landed (RO tools/list); M2 (`tools/call`) + M3 (delete hand-rolled framing) remain.
- **`ActiveBlockId` newtype M3** — completes the type-system lift of invariant #9 (recursive-CTE conflict filtering); dispatcher decision pending.
