<!-- markdownlint-disable MD060 -->
# Performance & Scalability

How the system stays responsive at scale, and the architectural choices that get it there.

## Product SLO

Interactive commands ≤ 200 ms p95 at 100K blocks. Pinned by `src-tauri/benches/interactive_slo.rs` — every interactive command has a per-command budget there (the bench file is the canonical source). The bench gates CI on regression; perf drift surfaces as a build failure, not a silent slowdown.

Two paths are known to exceed budget today (`list_page_links`, `list_projected_agenda`) and are gated behind `SLO_INCLUDE_PROBLEM=1` until mitigations land. The graph and projected-agenda paths are the known scaling frontiers.

## Architectural decisions that buy responsiveness

### Materializer apply-cursor semantics (C-2b)

The apply cursor (`materializer_apply_cursor.materialized_through_seq`) tracks **replay/remote apply progress, not local write progress** (#1248, revised by #2250 / #2325). Every apply path — the live local command path included — runs the same collapsed entry point, `apply_op_projected`, which applies the op to the per-space Loro engine *and* the SQL projection in one transaction. The paths differ only in the `advance_cursor` flag: remote apply and boot replay advance the cursor atomically with the apply; the local command path deliberately does not, so boot recovery re-applies the prior session's local ops from the cursor — idempotent (`INSERT OR IGNORE` + per-op-type guard) and kept as a standing safety net that exercises the replay path on every startup. #1257 (route local ops through engine-apply) is closed — the collapse did exactly that. See `docs/architecture/data-and-events.md` § Apply-cursor semantics for the full discussion.

### Cache streaming on rebuilds

Cache rebuild jobs (`tags_cache`, `pages_cache`, `agenda_cache`, `projected_agenda_cache`, FTS) **stream** rows from the read pool, transform, and batch-INSERT into the write pool. Earlier passes buffered entire result sets in memory before flushing — fine at 1K blocks, OOM at 100K. The streaming pattern keeps memory bounded at ~one batch's worth.

### Sync streaming over framed pull

Both snapshot transfer (catch-up) and attachment file transfer ship as 5 MB binary frames over the same WebSocket. Receiver applies frame-by-frame; sender holds open a producer task that pulls from a `BufReader`. Memory bounded; back-pressure native to the channel.

### Per-page block stores

Multiple open page tabs share a single `useBlockStore` for focus / selection, but each page's block content lives in an **independent store** built by `createPageBlockStore(pageId)`. Switching tabs doesn't churn the React tree of other tabs; closing a tab drops just its slice. Without this, 5 open pages = 5x the block-render overhead.

### Cursor-only pagination

Every list IPC is cursor-paginated, never offset-paginated. Offset O(N) penalty avoided; concurrent edits don't shift the pages.

### Specta single-source-of-truth IPC

Generated TS bindings + the macro single-source means there's no per-PR drift cost — adding a command updates both ends from one edit, and CI catches a stale `.ts` file. Saves ongoing maintenance latency that would otherwise compound.

### Per-space scoping in SQL

Space filter is pushed into the SQL `WHERE` clause everywhere it matters (canonical fragment pinned by `SPACE_FILTER_CANONICAL` parity test). Cross-space queries don't load + post-filter — they stop at the SQL engine. The fragment is inlined at ~30 sites (every canonical-shape inline site); the drift-detection test walks `src/**/*.rs` and asserts the canonical shape on every match — no exact count is pinned, so adding a site can't desync.

## Memory footprint & scaling envelope

The sections above describe how individual paths *bound* memory; this one consolidates where memory actually goes, what it scales with, and what that means on memory-constrained Android (1–3 GB RAM, ~24 MB release heap is the figure the snapshot guards are calibrated against — `src-tauri/src/snapshot/create.rs:42`).

### Where memory goes

- **Loro engines (per-space, in process).** The CRDT state is a `LoroEngineRegistry` — a process-local `HashMap<SpaceId, LoroEngine>` rebuilt from persisted per-space snapshots on boot and held resident for the process lifetime (`src-tauri/src/loro/snapshot.rs:5`). Because partitioning is per-space, resident Loro memory scales with **total live block state across all open spaces**, and the spike paths below scale with the **largest single space**, not the whole vault.
- **Snapshot create / restore.** Snapshot creation reads every row of every derived table into per-table `Vec`s before CBOR+zstd-encoding (`collect_tables`, `src-tauri/src/snapshot/create.rs:122`); restore decodes the full `SnapshotData` and op-log recovery `fetch_all`s the entire `op_log` before replaying (`src-tauri/src/db/recovery.rs:271`). The encode/decode wire path streams, but these row-source `Vec`s fully materialise — so peak RAM here is **O(vault), not O(chunk)**. This is the acknowledged OOM risk (#1624, #129).
- **Cache rebuilds.** Bounded by design: rebuild jobs stream rows and batch-INSERT (see "Cache streaming on rebuilds" above), and the projected-agenda rebuild flushes a working buffer at a 10 000-entry chunk — peak ≈ 500 KB versus the ~18 MB the pre-M-19 full-buffer path peaked at on a 1000-block × 365-day vault, "larger on Android" (`src-tauri/src/cache/projected_agenda.rs:36`).
- **FTS index.** `fts_blocks` is a standalone trigram FTS5 table that stores stripped text in a shadow content table *plus* a trigram index (~3×). A per-block cap of `FTS_MAX_INDEXED_BYTES = 128 KiB` keeps one pathological pasted multi-MB block from dominating the index on memory-constrained mobile (`src-tauri/src/fts/strip.rs:167`); it bounds the worst case per block, it is not a measured budget.

### Dominant scaling factors

1. **Cold start** — materializer boot rehydrates every per-space Loro engine and refreshes caches. Resident memory after boot tracks total live block state.
2. **Snapshot/sync catch-up** — the worst spike: snapshot create/restore and op-log replay buffer their full row source in memory (above). Sync *transfer* itself is bounded (5 MB framed pull, "Sync streaming over framed pull" above) — it is the snapshot **build/apply** at each end that spikes.
3. **FTS rebuild** — a full reindex re-strips and re-indexes every block; per-block contribution is capped but total work scales with block count.

### Known OOM risks

- **Snapshot/op-log replay buffers the whole vault** (#1624). `collect_tables` and `recover_blocks_from_op_log` materialise full row-source `Vec`s. Guards are warn-only: a `warn!` fires at `SNAPSHOT_WARN_ROW_COUNT = 100 000` op-log rows and at `SNAPSHOT_WARN_PAYLOAD_BYTES = 64 MiB` of payload — both deliberately conservative, chosen to fire long before the OOM ceiling rather than as a tight bound, and the 64 MiB figure is already ~2.6× the Android release heap (`src-tauri/src/snapshot/create.rs:43`, `src-tauri/src/snapshot/create.rs:52`).
- **Streaming snapshot restore is deferred** until Android profiling lands (#129, `SQL-M-8`). Until a fully-streaming wire format is approved (the #416 / #129 plan: keyset-paginate `collect_tables` and stream rows into the encoder so peak is O(chunk)), the warn thresholds are the only safety net and are calibrated to the lowest platform heap.

### Guidance for memory-constrained Android (1–3 GB)

- **Vault-size envelope.** Interactive responsiveness is bench-validated to 100K blocks (`FIXTURE_SIZE = 100_000` in `src-tauri/benches/interactive_slo.rs`), and the snapshot row-count warn is set at the same 100K — so treat **~100K blocks per space as the comfortable ceiling** on a 1–3 GB device, since the snapshot spike (O(vault)) is the binding constraint there, not steady-state interactive memory. A precise per-device peak-RAM-at-N-blocks figure is **not yet measured** — the existing benches validate interactive latency at scale (#1231), not resident/peak RAM, so a dedicated resource-envelope measurement is needed before a hard number can be stated here; do not infer a hard MB-per-block number from the figures above.
- **What to avoid on low-RAM devices.** Single multi-MB pasted blocks (the FTS cap truncates indexing of the tail, but the block content still lives in the Loro doc); letting a single space grow unbounded toward the snapshot warn thresholds; and triggering a full snapshot/restore or FTS rebuild on a very large vault while other apps are pressuring the heap.
- **Mitigation.** Split content across spaces (snapshot spikes are per-space, so several smaller spaces peak lower than one large one); keep an eye on the snapshot `warn!` lines as the early-warning signal; archive or prune stale pages to keep live block count down.

## Pool architecture

`WritePool` (2 connections) + `ReadPool` (4 connections), each a `sqlx::Pool` with type-safe newtype wrappers. The newtype guards prevent accidental writes through the read pool or vice versa.

Background materializer tasks use the read pool for the SELECT phase and only acquire a write connection for the final DELETE + batch-INSERT. Foreground (interactive) commands use the write pool directly.

### Write-lock hold-time contract (#2470)

The required shape for an O(vault) background job (snapshot creation, op-log compaction) is **read-phase / brief-write** — never "do the scan under the write lock":

1. **Collect** in a `DEFERRED` read transaction (`pool.begin()`). Under WAL a reader never blocks the writer, so an O(vault) table scan does not stall interactive commands. `create_snapshot`'s `collect_tables` + `collect_frontier` call (`src-tauri/src/snapshot/create.rs:298-300`) and `compact_op_log`'s read phase (`src-tauri/src/snapshot/create.rs:400`) both follow this shape.
2. **Encode** (CBOR + zstd) outside any transaction — pure computation, no lock held at all.
3. **Write** in a brief `BEGIN IMMEDIATE` transaction that performs only the minimal INSERT/UPDATE/DELETE, never the collection. `create_snapshot` folds its pending-insert + complete-update pair into one such transaction (`src-tauri/src/snapshot/create.rs:319`); `compact_op_log`'s phase 3 does the same for the snapshot insert (`:473`) and the retention purge (`:502`).

Every `BEGIN IMMEDIATE` acquire above routes through `begin_immediate_logged` (`src-tauri/src/db/pool.rs:209`), which times the pool-acquire *and* SQLite-lock-acquire together and emits a `slow BEGIN IMMEDIATE` warning once that exceeds `SLOW_ACQUIRE_WARN_MS` (100 ms, `src-tauri/src/db/pool.rs:13`) — this warning is the standing observability primitive for a regression in the pattern above. There is currently no automated guard pinning "collection must not run under the write lock" as an invariant (a test asserting `collect_tables` executes on a non-`BEGIN IMMEDIATE` connection would close that gap; not yet written).

**`apply_snapshot` is the accepted long-hold exception.** Restoring from a snapshot (`src-tauri/src/snapshot/restore.rs:140`) wipes and re-seeds the whole vault's core **and** cache tables inside a single `BEGIN IMMEDIATE` transaction (also via `begin_immediate_logged`, `src-tauri/src/snapshot/restore.rs:159`) — there is no read-then-brief-write split, because the operation *is* a wholesale replace: partial visibility of a half-restored vault would be worse than blocking writers for the duration. Its hold time at realistic vault sizes (e.g. the 100K-block fixture used elsewhere in this doc) has **not been measured** — that measurement, plus recording `begin_immediate_logged` slow-acquire stats during a sync-import burst, remains open work (#2470). Until it is measured, treat `apply_snapshot` as an unbounded-duration write-lock hold for scheduling and UX purposes rather than assuming it is brief like the pattern above.

**The `pool_busy` story end-to-end.** The write pool's `busy_timeout` is 5 s (`src-tauri/src/db/pool.rs:366`). A command that cannot acquire the write lock within that window surfaces as `sqlx::Error::PoolTimedOut`, which the backend routes to `AppError::PoolTimedOut` (kind `pool_busy`) rather than the generic `Database` variant specifically so the frontend can offer a retry instead of a hard failure (`src-tauri/src/error.rs:120-125`, `:238`, `:268`). The frontend's `isPoolBusy` predicate (`src/lib/app-error.ts:77`) gates the shared `retryOnPoolBusy` helper (`src/lib/app-error.ts:178`), which every block-mutating store action routes through (`src/stores/page-blocks-reducers.ts`, e.g. `:136`, `:239`, `:291`, tagged `#730`) with a bounded 3-attempt / ~200 ms backoff (`src/lib/app-error.ts:137`) before bubbling the error to the caller. A long `apply_snapshot` hold is the scenario most likely to exhaust that budget: every interactive command issued during the restore waits out the full 5 s `busy_timeout` before failing `pool_busy`, and the FE's bounded retry (max ~200 ms of backoff) does not come close to covering that wait — so it will typically also fail and surface to the user rather than silently recovering.

## FTS5 maintenance

The FTS index is rebuilt incrementally on every block edit. A background optimize task runs after `max(500, block_count / 10_000)` writes — adaptive so small vaults don't optimize too often and large vaults do — with a 60-minute ceiling so an idle-but-recently-edited vault still gets maintenance.

The strip pass (`src-tauri/src/fts/strip.rs`) resolves `[[ULID]]` / `#[ULID]` to target titles before indexing, so a search for a page name matches blocks that link to it (not just blocks that contain the literal ULID).

## Engine format version & downgrade recovery

The per-space Loro engine stamps `ENGINE_FORMAT_VERSION` (currently `2`) into each snapshot on export and checks it on import (`src-tauri/src/loro/engine/mod.rs`). Once a snapshot has been re-saved under engine format v2, **downgrading to a pre-#332 build is the only forward-migration route** — there is no in-place v2→v1 conversion, so a host that must run an older build has to restore from a v1-era snapshot or re-derive state from the op log on that build.

A v1 peer cannot sync with a v2 peer: the raw Loro bytes are incompatible across the format boundary. As of #2130 the sync handshake gates this **up front**. The initiator advertises its `engine_format_version` in the `HeadExchange` message, and the responder rejects an incompatible peer before any raw-byte merge — emitting a clear `SyncEvent::Error` ("peer engine format vN incompatible with local vM") and failing the session, instead of letting the bytes reach an import and surfacing a confusing mid-session failure. A version of `0` denotes a legacy peer predating the field; it is accepted and falls through to the existing import-time format guards (`reject_legacy_v1_snapshot` / `reject_unknown_format_version`).

## Roadmap

What's not yet shipped is tracked separately. High-level items today:

- **OS notifications** for due tasks (Org-mode parity; mobile especially).
- **iroh transport** — scoped, not started. Approved adoption plan replacing the mDNS + WebSocket + TLS + TOFU stack with a higher-level p2p library.
- **rmcp migration** — M1 landed (RO tools/list); M2 (`tools/call`) + M3 (delete hand-rolled framing) remain.
- **`ActiveBlockId` newtype M3** — completes the type-system lift of invariant #9 (recursive-CTE conflict filtering); dispatcher decision pending.
