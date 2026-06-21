<!-- markdownlint-disable MD060 -->
# Performance & Scalability

How the system stays responsive at scale, and the architectural choices that get it there.

## Product SLO

Interactive commands ≤ 200 ms p95 at 100K blocks. Pinned by `src-tauri/benches/interactive_slo.rs` — every interactive command has a per-command budget there (the bench file is the canonical source). The bench gates CI on regression; perf drift surfaces as a build failure, not a silent slowdown.

Two paths are known to exceed budget today (`list_page_links`, `list_projected_agenda`) and are gated behind `SLO_INCLUDE_PROBLEM=1` until mitigations land. The graph and projected-agenda paths are the known scaling frontiers.

## Architectural decisions that buy responsiveness

### Materializer apply-cursor semantics (C-2b)

The apply cursor (`materializer_apply_cursor.materialized_through_seq`) tracks **engine-apply progress, not SQL-materialization progress** (#1248). It advances only inside the foreground engine-apply path (`apply_op` / `BatchApplyOps`), in the same transaction as the engine apply — so engine-apply + cursor advance are atomic and a crash never leaves the cursor ahead of engine state. The live local command path materializes the SQL `blocks` row synchronously in its own `CommandTx` and fires only background cache rebuilds; it does **not** advance this cursor. Boot recovery therefore re-applies the prior session's ops into the engine from the cursor — idempotent, so re-applying an op twice is a no-op (`INSERT OR IGNORE` + per-op-type guard). Making the cursor reflect SQL materialization would require routing local ops through engine-apply, tracked in **#1257**. See `docs/architecture/data-and-events.md` for the full discussion.

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

Space filter is pushed into the SQL `WHERE` clause everywhere it matters (canonical fragment pinned by `SPACE_FILTER_CANONICAL` parity test). Cross-space queries don't load + post-filter — they stop at the SQL engine. The 13 sites that share the fragment have a drift-detection test so they can't desync.

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

## FTS5 maintenance

The FTS index is rebuilt incrementally on every block edit. A background optimize task runs after `max(500, block_count / 10_000)` writes — adaptive so small vaults don't optimize too often and large vaults do — with a 60-minute ceiling so an idle-but-recently-edited vault still gets maintenance.

The strip pass (`src-tauri/src/fts/strip.rs`) resolves `[[ULID]]` / `#[ULID]` to target titles before indexing, so a search for a page name matches blocks that link to it (not just blocks that contain the literal ULID).

## Roadmap

What's not yet shipped is tracked separately. High-level items today:

- **OS notifications** for due tasks (Org-mode parity; mobile especially).
- **iroh transport** — scoped, not started. Approved adoption plan replacing the mDNS + WebSocket + TLS + TOFU stack with a higher-level p2p library.
- **rmcp migration** — M1 landed (RO tools/list); M2 (`tools/call`) + M3 (delete hand-rolled framing) remain.
- **`ActiveBlockId` newtype M3** — completes the type-system lift of invariant #9 (recursive-CTE conflict filtering); dispatcher decision pending.
