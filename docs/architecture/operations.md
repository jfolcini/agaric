<!-- markdownlint-disable MD060 -->
# Performance & Scalability

How the system stays responsive at scale, and the architectural choices that get it there.

## Product SLO

The product target is **interactive commands ≤ 200 ms p95 at 100K blocks**. `src-tauri/benches/interactive_slo.rs` supports that target with a scheduled regression gate, but does not directly enforce p95: it accumulates elapsed time and iteration counts across Criterion's batched `iter_custom` invocations, then enforces the resulting **mean** against each command's inline budget (the bench file is the canonical source for those budgets). Most command budgets are substantially tighter than 200 ms, so the mean gate remains useful and fails the scheduled lane on broad regressions, but it is not a guarantee about the per-call tail.

**Two vault shapes are supported targets (#6527).** An *outliner* vault has few pages and many blocks: the `FIXTURE_SIZE` fixtures, whose blocks sit under `PAGE_COUNT` pages or none. A *page-heavy* vault has many pages of few blocks each, as a folder imported from Obsidian leaves: `page_heavy::PAGES` pages of `BLOCKS_PER_PAGE` blocks in one engine-backed space (`page_heavy::bench_page_heavy_vault`). Every probe runs on the outliner shape. The page-heavy fixture runs only the probes whose cost grows with the number of pages: `create_page_in_space`, `list_all_pages_in_space`, the pages list's first page, `resolve_page_title` and a one-block file import, the unit of a folder import. They are measurement-only until `bench-slo` has measured them, and no page count is declared as a ceiling.

The harness intentionally does not compute a percentile over Criterion batch means. Individual-call latencies are not retained, so such a percentile would still dilute a slow-call tail; genuine p95 enforcement would require per-call timing. The ≤200 ms p95 figure therefore remains the product target, while the accumulated mean under the per-command budget is the metric enforced today.

Every interactive command is now in the enforced green tier except `revert_ops` (separate `SLO_INCLUDE_REVERT=1` gate, aspirational budget) and the backlink panels' reads (#5422), which are measurement-only probes behind `SLO_INCLUDE_PROBLEM` until CI has measured them. `list_page_links` was promoted after the 20K count-then-cap (#2529) brought the unscoped read under budget; the space-scoped read (#5415) went over budget at 100K and was gated again, then returned to the green tier once it ranged `page_link_cache.space_id` (#5426). `list_projected_agenda` was **graduated off `SLO_INCLUDE_PROBLEM` into the green tier by #2601**: its earlier straddle was an artefact of the bench measuring the COLD-cache on-the-fly fallback (it seeded repeating blocks but never populated `projected_agenda_cache`). The production interactive read is a warm-cache index scan, and #2601 makes that the measured path — see "Bounded-horizon projected agenda" below. The graph path remains the known scaling frontier.

**Bounded-horizon projected agenda (#2601).** `projected_agenda_cache` now materializes only the next `HORIZON_OCCURRENCES` (13 × 7 = 91) occurrences per repeating block per date source, instead of every occurrence inside a fixed 365-day window. Reads become a pure O(window) index scan — recurrence expansion happens on the write/rebuild path, never on the interactive hot path. The rebuild records the guaranteed-complete horizon date (`today + HORIZON_DAYS = today + 90`, the tightest daily-cadence bound) in `projected_agenda_horizon`, written in the same transaction as the rows; `list_projected_agenda_inner` falls back to on-the-fly projection for any query whose end date reaches past it, so a sub-year horizon never returns an incomplete page. The rebuild also writes every occurrence in the `BACKWARD_WINDOW_DAYS` (90) before its reference date, so a past journal day's Due panel is the same index scan; a range starting earlier than `rebuild_today - 90` is projected on the fly, on the blocking pool (#5421). A repeat rule / date / todo-state edit rewrites only its own block's rows (`UpdateProjectedAgendaBlock`, #5423), projected from the stored `rebuild_today`; when that is no longer the local date, the edit runs the full rebuild instead, which advances the horizon. Boot, the midnight maintenance job, inbound sync, a `template` change, delete / restore / purge and a cross-page move rebuild in full. A vault that sits idle for days simply serves the rare far-future query from the on-the-fly fallback until the next full rebuild re-anchors `today`. The `bench_list_projected_agenda` green-tier bench warms the cache, then measures the index-scan read across 100/1K/10K/100K — flat under 200 ms because latency tracks the query window, not the fixture size.

### Enter and merge through the app (#6559)

How long Enter and a merge wait, from the key to the backend's answer, on the real app:

```sh
AGARIC_PERF=1 just e2e-real e2e-tauri/enter-merge-latency.e2e.ts
```

It splits block 250 of a 2,000-block page in the middle of its text 100 times (`split_block`) and merges each split back with Backspace (`merge_blocks`), on a 3,002-block vault, idle and while `e2e_sync_peer` rewrites a page of its own and the app pulls it; then it pastes 300 lines in page mode five times, each taken back with one Ctrl+Z. The times are the app's own `logLatencySample` lines (Settings › Debug mode), from the key's handler to the block taking focus, and to the backend's answer. Not 100K blocks: the spec's header says why, and `bench_enter_split_and_merge` above times the backend's share at 100K. The lane's runs are a debug backend with the production frontend, in WebKitGTK under Xvfb on a 4-core cloud container, so compare runs on one machine, never with the bench.

Idle and paste from six runs (the spec at `98e1e69` and at `9c27173`, whose idle and paste halves are the same), under sync from the three at `9c27173`; each cell is the band of the runs' p50, then of their p95:

| ms | Enter split, focus | Enter split, answer | Merge, focus | Merge, answer |
|---|---|---|---|---|
| Idle, p50 | 197–232 | 321–389 | 163–194 | 227–269 |
| Idle, p95 | 272–333 | 420–529 | 220–261 | 329–365 |
| Under sync, p50 | 194–215 | 313–352 | 172–184 | 245–283 |
| Under sync, p95 | 269–313 | 425–535 | 238–273 | 390–471 |

The 300-line paste saved in 3.5–4.1 s at p50 and 5.3–6.6 s at p95 (`page-mode-save`, five pastes a run), and one Ctrl+Z took it back 30 times in 30. No key was lost idle (1,200 keys); under sync one Backspace in 600 reached nothing (#6814).

What they say:

- **Under sync is inside the idle band** at p50 and at p95: a pull applying beside the keys did not lengthen the wait measurably, though it can lose a key (#6814).
- **Most of the wait is the frontend's.** Focus reaches the new block 0.2 s after the key, before the backend answers, and since #6617 a key typed meanwhile lands there. The backend's share, the answer less the focus, is about 0.12 s for a split and 0.07 s for a merge in this debug build; the bench's optimized build takes 18 ms and 5 to 8 ms at 100K.
- **The phone row is missing**: the same lines from logcat, by the steps on #6513.

Go / no-go for what #6559 left open, on these numbers:

- **Faster backend for Enter** (the sibling-slot create #6706 pointed at): no-go. The key does not wait for it, and it is the smaller half of the answer.
- **Enter right after a merge, and a second Backspace on a blank block, still dropped**: no-go on desktop. The window is the merge's answer, 0.23 to 0.27 s at p50 here; the phone row decides.
- **Page-mode batching** (#6732): done; a 300-line paste is seconds in this build, and one Ctrl+Z undoes it. Batching a pasted list's style writes was not measured (the paste here is plain lines); no-go until a list paste is.
- **Keys lost while a pull applies**: go, as #6814.
- **Writes on a vault pulled from a peer, or with a peer paired before them, are far slower** (a split about 2 s, a 300-line paste 91 s): go, as #6811, before the phone row, since a phone gets its vault by a pull.

## Architectural decisions that buy responsiveness

### Materializer apply-cursor semantics (C-2b)

The apply cursor (`materializer_apply_cursor.materialized_through_seq`) tracks **replay/remote apply progress, and local writes only as of the last snapshot pass**; boot dispatches again the index work of every local op above it (#1248, revised by #2250 / #2325 and #5418). Every apply path — the live local command path included — runs the same collapsed entry point, `apply_op_projected`, which applies the op to the per-space Loro engine *and* the SQL projection in one transaction. The paths differ only in the `advance_cursor` flag: remote apply and boot replay advance the cursor atomically with the apply; the local command path deliberately does not. The snapshot pass advances it past local ops once the engine snapshots hold them (#5418). Boot builds the engines from their saved rows and applies no op (#6521); a boot that cannot use those rows re-applies, idempotently in SQL (`INSERT OR IGNORE` + per-op-type guard), only the local ops committed after the last pass. #1257 (route local ops through engine-apply) is closed — the collapse did exactly that. See `docs/architecture/data-and-events.md` § Apply-cursor semantics for the full discussion.

### Cache streaming on rebuilds

Cache rebuild jobs (`tags_cache`, `pages_cache`, `agenda_cache`, `projected_agenda_cache`, FTS) **stream** rows from the read pool, transform, and batch-INSERT into the write pool. Earlier passes buffered entire result sets in memory before flushing — fine at 1K blocks, OOM at 100K. The streaming pattern keeps memory bounded at ~one batch's worth.

### Sync streaming over framed pull

Attachment file transfer streams on the same QUIC bi-stream the control messages use, copied through one fixed 5 MB buffer (`BULK_COPY_BYTES` in `src-tauri/agaric-sync/src/transport/bulk.rs`). Every read is sized from that buffer's own length rather than from the declared total, so allocation stays constant however large the transfer; the declared size is bounded against a caller-supplied cap *before* the first read. Sender holds open a producer task that pulls from a `BufReader`. Memory bounded; back-pressure comes from QUIC's flow-control windows rather than from a hand-rolled chunk loop.

Loro payloads, the catch-up's snapshots included, travel raw after a header frame on the same stream (`transport/session.rs`, #5761): the receiver bounds the announced size by `MAX_LORO_SYNC_PAYLOAD_SIZE` (256 MB) before reading, and reads it straight into the buffer the engine imports from, through one 5 MB read buffer. Each side holds the payload once, plus that buffer.

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

- **Loro engines (per-space, in process).** The CRDT state is a `LoroEngineRegistry` — a process-local `HashMap<SpaceId, LoroEngine>` rebuilt at boot from each space's saved rows (its snapshot and the `loro_doc_delta` rows since) and held resident for the process lifetime (`src-tauri/agaric-engine/src/loro/snapshot.rs`). Because partitioning is per-space, resident Loro memory scales with **total live block state across all open spaces**, and the spike paths below scale with the **largest single space**, not the whole vault.
- **Op-log recovery.** `recover_blocks_from_op_log` `fetch_all`s the entire `op_log` before replaying (`src-tauri/src/db/recovery.rs`); the row-source `Vec` fully materialises, so peak RAM there is **O(vault), not O(chunk)**. This is the acknowledged OOM risk (#1624, #129). #4699 removed the other half of it: compaction used to read every row of every derived table into per-table `Vec`s and CBOR+zstd-encode them on each 24 h tick, for a blob nothing read.
- **Cache rebuilds.** The streamed rebuilds are bounded by design: they stream rows and batch-INSERT (see "Cache streaming on rebuilds" above), and the projected-agenda rebuild flushes a working buffer at a 10 000-entry chunk — peak ≈ 500 KB versus the ~18 MB the pre-M-19 full-buffer path peaked at on a 1000-block × 365-day vault, "larger on Android" (`src-tauri/agaric-store/src/cache/projected_agenda.rs`). The `page_id` rebuild is not streamed: it reads every block's id, parent and `page_id` into memory to diff them (`compute_page_id_diff` in `src-tauri/agaric-store/src/cache/page_id.rs`), so its peak grows with the vault. The rebuilds that compare on the read pool and re-derive under the write lock (`agenda_cache`, `block_tag_refs`, `tags_cache`, `pages_cache`) hold the ids of the rows they found stale, which is every row only when the cache is empty.
- **FTS index.** `fts_blocks` is a standalone trigram FTS5 table that stores stripped text in a shadow content table *plus* a trigram index (~3×). A per-block cap of `FTS_MAX_INDEXED_BYTES = 128 KiB` keeps one pathological pasted multi-MB block from dominating the index on memory-constrained mobile (`src-tauri/agaric-store/src/fts/strip.rs`); it bounds the worst case per block, it is not a measured budget.

### Dominant scaling factors

1. **Cold start** — materializer boot rehydrates every per-space Loro engine and refreshes caches. Resident memory after boot tracks total live block state.
2. **Op-log replay** — the worst remaining spike: recovery buffers the full `op_log` row source in memory (above). Sync *transfer* itself is bounded (5 MB framed pull, "Sync streaming over framed pull" above).
3. **FTS rebuild** — a full reindex re-strips and re-indexes every block; per-block contribution is capped but total work scales with block count.

### Known OOM risks

- **Op-log replay buffers the whole log** (#1624). `recover_blocks_from_op_log` materialises a full row-source `Vec`, and there is no guard on it — the `SNAPSHOT_WARN_ROW_COUNT` / `SNAPSHOT_WARN_PAYLOAD_BYTES` warns went with the snapshot blob in #4699, because after that the thing they warned about (compaction buffering the derived vault) no longer happens. Recovery is the rare disaster path by construction; the streaming rewrite is still deferred pending Android profiling (#129, `SQL-M-8`).

### Loro engine cost (#6563)

What one space's engine costs as it grows, on the engine as #6521 left it: the snapshot in `loro_doc_state`, the writes since in `loro_doc_delta` rows. A space of `n` blocks (a page per 100 blocks, built through the engine's write path), with `m` rounds of one edit to every block:

```sh
cd src-tauri && CARGO_PROFILE_BENCH_LTO=off CARGO_PROFILE_BENCH_CODEGEN_UNITS=16 \
  cargo bench --bench engine_bench -- loro_snapshot 2>&1 | grep '^loro_snapshot_bench'
```

`LORO_SNAPSHOT_MAX_BLOCKS=10000` skips the 100K scale: a run at both takes about 20 minutes on the container below, and one at 10K about 5. A compile with the two overrides takes about 20 minutes cold; the shipped profile's thin LTO does not finish on a shared box (`src-tauri/benches/AGENTS.md`). The numbers are from `src-tauri/benches/groups/loro_snapshot_bench.rs`, a release build without LTO, on a 4-core cloud container: 10K blocks twice, 100K once. Each cell is the band of the runs' medians, then the lowest and highest sample of either run.

| Space | Snapshot | Export | Rehydrate (import + index) | Heap after rehydrate (peak) | Cold first sync (of 120 s) |
|---|---|---|---|---|---|
| 10K × 0 edits | 0.85 MB | 46–48 ms [36–70] | 64–68 ms [55–107] | 17.9 MB (19.4) | 2.91–2.95 s [2.64–3.95] (2.4–2.5%) |
| 10K × 10 | 1.38 MB | 64–85 ms [51–95] | 98–106 ms [64–129] | 18.1 MB (19.6) | 3.00–3.21 s [2.64–3.58] (2.5–2.7%) |
| 100K × 0 | 8.77 MB | 556 ms [504–732] | 968 ms [861–1,113] | 171.5 MB (185.0) | 29.7 s [28.1–31.1] (24.7%) |
| 100K × 10 | 14.17 MB | 781 ms [698–945] | 1,153 ms [1,002–1,339] | 174.4 MB (187.9) | 33.4 s [32.6–33.9] (27.8%) |

Export is `export_snapshot`, what a save writes to `loro_doc_state` and a snapshot catch-up sends. Rehydrate is what boot does for a space: import into an empty engine, rebuild the `block_id` index, read one block. Heap is the counting allocator's total of live Rust allocations after that rehydrate, and its highest on the way: not the process's resident set, and without SQLite's pages. Cold first sync is `apply_remote` of the snapshot into an empty vault: the inbox write, the import, the diff and the SQL projection of every block, which is one sync dispatch against `HANDSHAKE_TIMEOUT` (`src-tauri/agaric-sync/src/transport/driver.rs`).

What they say:

- **A first sync is the number near a limit.** 100K blocks take 30 to 33 s of the 120 s dispatch on this box, and 10× the blocks took 10× as long (2.9 s at 10K). The Loro import and index are about a second of it (the rehydrate column); the rest is SQL projection and its diff, whose split was not measured. A phone is slower than this container, and its row is missing.
- **Ten rounds of one edit to every block** add 62% to the snapshot at 100K, 40% to its export and 19% to its rehydrate. The heap after rehydrate does not follow: it moved by 3 MB.
- **A pulled vault carries the update, not the snapshot, until a compaction folds it.** After a cold first sync `loro_doc_delta` holds one row of 10.3 MB at 100K × 0 (the snapshot is 8.77 MB), 23.8 MB at 100K × 10 (14.17 MB), both far past `DELTA_COMPACTION_BYTES`.
- **Memory is per engine and held for the process's life.** At 100K blocks one space is about 175 MB of heap, 190 MB at its peak.
- **The attachment scan** (`find_missing_attachments`, every live attachment statted once per sync session) takes 249–264 ms [183–310] over 10,000 attachments whose files are present, on every session.

**A write on a pulled vault, beside the same write on the vault that wrote it** (#6811). `pulled_vault_bench` builds #6811's vault by commands (a 1,100-block page and 1,900 blocks of filler, about 3K blocks), pulls its space snapshot into a second empty vault with `apply_remote`, then times a split (`create_block_inner` at the middle sibling slot) and a 300-line paste (`create_blocks_batch_inner`) on both, the two arms alternating sample by sample:

```sh
cd src-tauri && LORO_SNAPSHOT_MAX_BLOCKS=0 CARGO_PROFILE_BENCH_LTO=off CARGO_PROFILE_BENCH_CODEGEN_UNITS=16 \
  cargo bench --bench engine_bench -- pulled_vault 2>&1 | grep '^pulled_vault_bench'
```

(`LORO_SNAPSHOT_MAX_BLOCKS=0` keeps the Loro run's own fixtures out of it; a run takes about 5 minutes.) Two runs, same container and build; each cell is the two runs' medians, then the lowest and highest sample of either run. The page grows by one block per split and 300 per paste, so a run's timings drift up on both arms alike; the pulled-over-written ratio of each pair taken in turn is the figure that cancels it.

| Write | App-written | Pulled | Pulled / app-written, median of pairs |
|---|---|---|---|
| Split | 10.1–12.1 ms [6.0–85.9] | 9.5–11.7 ms [6.2–72.3] | 0.96–0.98 |
| 300-line paste | 3.7–4.2 s [2.3–6.7] | 3.8–4.1 s [2.2–6.5] | 0.93–0.98 |

- **No gap at this level.** A split on a pulled vault took as long as on the vault that wrote the blocks, and so did the paste, in the commands and the engine of a release build. #6811's gap (a split about 2 s, a paste 91 s) is not in how an engine built from a peer's snapshot performs a command. The harness has no UI or IPC, no paired peer and no running materializer or sync daemon, and its build is release, where #6811's table is a debug build: any of those can still hold the cause.
- **A 300-line paste into a page of 1,100 blocks is seconds in a release build** on both arms (the fastest samples are 2.2–2.5 s).

### Guidance for memory-constrained Android (1–3 GB)

- **Vault-size envelope.** Interactive responsiveness is bench-validated to 100K blocks in an outliner-shaped vault (`FIXTURE_SIZE = 100_000` in `src-tauri/benches/interactive_slo.rs`; the page-heavy shape is measured, not budgeted, see § Product SLO); treat **~100K blocks per space as the comfortable ceiling** on a 1–3 GB device. One space's Loro engine holds about 175 MB of heap at 100K blocks and peaks near 190 MB while it loads (§ [Loro engine cost](#loro-engine-cost-6563)); the rest of the process (SQLite's caches, the frontend, the WebView) is not measured, so there is still no whole-process peak-RAM figure.
- **What to avoid on low-RAM devices.** Single multi-MB pasted blocks (the FTS cap truncates indexing of the tail, but the block content still lives in the Loro doc); letting a single space grow unbounded; and triggering a disaster-recovery replay or an FTS rebuild on a very large vault while other apps are pressuring the heap.
- **Mitigation.** Split content across spaces (the Loro engine spike is per-space, so several smaller spaces peak lower than one large one); archive or prune stale pages to keep live block count down.

## Pool architecture

`WritePool` (2 connections) + `ReadPool` (4 connections), each a `sqlx::Pool` with type-safe newtype wrappers. The newtype guards prevent accidental writes through the read pool or vice versa.

Background materializer tasks use the read pool for the SELECT phase and only acquire a write connection for the final DELETE + batch-INSERT. Foreground (interactive) commands use the write pool directly.

### Write-lock hold-time contract (#2470)

The required shape for an O(vault) background job is **read-phase / brief-write**
— never "do the scan under the write lock":

1. **Collect** in a `DEFERRED` read transaction (`pool.begin()`). Under WAL a reader never blocks the writer, so an O(vault) table scan does not stall interactive commands. `compact_op_log`'s read phase (`src-tauri/agaric-sync/src/snapshot/create.rs`) follows this shape: it counts eligible ops and reads the per-device frontier with no write lock held.
2. **Write** in a brief `BEGIN IMMEDIATE` transaction that performs only the minimal INSERT/UPDATE/DELETE, never the collection. `compact_op_log`'s write phase runs the per-device `op_log` DELETE and clamps the apply cursor, then commits.

Every write transaction opens through `begin_immediate_logged` (`src-tauri/agaric-store/src/db/mod.rs`). Writers queue there in arrival order, one queue per database file, and a writer keeps its turn until its transaction commits, rolls back or is dropped: SQLite hands the lock to whichever connection polls first, so without the queue a writer that begins again at once starves the other until the busy timeout (#6567). The wait for a turn has no timeout, so code that holds a write transaction must not wait for another one to begin. The helper times the turn, the pool acquire *and* the SQLite lock acquire together and emits a `slow BEGIN IMMEDIATE` warning once that exceeds `SLOW_ACQUIRE_WARN_MS` — this warning is the standing observability primitive for a regression in the pattern above. A single statement run on the pool outside a transaction is not in the queue and still takes the lock by polling.

**The long-hold exception is gone with the snapshot restore (#4699).** `apply_snapshot` wiped and re-seeded every core and cache table inside one `BEGIN IMMEDIATE` transaction, and its measured hold at 100K blocks was ~18 s — well past the 5 s `busy_timeout`, so every interactive command issued during a restore failed `pool_busy`. Nothing called it in production, and #4699 deleted it along with the blob it restored. No background job in the tree now holds the write lock for an O(vault) scan.

**The `pool_busy` story end-to-end.** The write pool's `busy_timeout` is 5 s (`src-tauri/src/db/pool.rs`). A command that cannot acquire the write lock within that window fails with SQLite's `SQLITE_BUSY`, which `From<sqlx::Error>` routes to `AppError::PoolTimedOut` (kind `pool_busy`), as it does sqlx's own pool timeout, rather than the generic `Database` variant so the frontend retries instead of failing hard (`src-tauri/agaric-core/src/error.rs`). The frontend's `isPoolBusy` predicate and the shared `retryOnPoolBusy` helper both live in `src/lib/app-error.ts`; every block-mutating store action routes through the latter (`src/stores/page-blocks-reducers.ts`, tagged `#730`) with a bounded 3-attempt, 0/50/150 ms backoff before bubbling the error to the caller. The scenario most likely to exhaust that budget used to be a long `apply_snapshot` hold (#2470's writer probe measured a full 5.008 s wait then `SQLITE_BUSY`); #4699 deleted it, and no remaining path holds the write lock long enough to make the FE's bounded retry (max ~200 ms of backoff) hopeless by construction.

## FTS5 maintenance

The FTS index is rebuilt incrementally on every block edit. A background optimize task runs after `max(500, block_count / 10_000)` writes — adaptive so small vaults don't optimize too often and large vaults do — with a 60-minute ceiling so an idle-but-recently-edited vault still gets maintenance.

The strip pass (`src-tauri/agaric-store/src/fts/strip.rs`) resolves `[[ULID]]` / `#[ULID]` to target titles before indexing, so a search for a page name matches blocks that link to it (not just blocks that contain the literal ULID).

## Engine format version & downgrade recovery

The per-space Loro engine stamps `ENGINE_FORMAT_VERSION` into each snapshot on export and checks it on import (`src-tauri/agaric-engine/src/loro/engine/mod.rs`). Once a snapshot has been re-saved under engine format v2, **downgrading to a pre-#332 build is the only forward-migration route** — there is no in-place v2→v1 conversion, so a host that must run an older build has to restore from a v1-era snapshot or re-derive state from the op log on that build.

A v1 peer cannot sync with a v2 peer: the raw Loro bytes are incompatible across the format boundary. As of #2130 the sync handshake gates this **up front**. The initiator advertises its `engine_format_version` in the `HeadExchange` message, and the responder rejects an incompatible peer before any raw-byte merge — emitting a `SyncEvent::Error` coded `engine_format_mismatch` and sending the initiator a refusal frame, so both devices name the one to update (#5728, #6523; `sync-protocol-spec.md` has the messages), and failing the session, instead of letting the bytes reach an import and surfacing a confusing mid-session failure. A version of `0` denotes a legacy peer predating the field; it is accepted and falls through to the existing import-time format guards (`reject_legacy_v1_snapshot` / `reject_unknown_format_version`).

## Roadmap

What's not yet shipped is tracked separately. High-level items today:

- **OS notifications** for due tasks (Org-mode parity; mobile especially).
- **iroh transport** — **shipped** (#78, plan #3464). Both sync roles run over QUIC; `sync_net/`, `sync_cert.rs` and `sync_daemon/wire.rs` were deleted outright in #3544. What the port itself did *not* fix, and was closed separately: first-ever pairing initiation (#3502 — daemon policy, not transport, fixed in #3535). Also closed separately: the S-5 lock key was asymmetric during the pairing window (#3511 — both roles now key on the peer's `EndpointId`, per #3529). Still open from the cutover: inbound is single-homed (#3513) and wire compression is gone (#3512).
- **rmcp migration** — M1 landed (RO tools/list); M2 (`tools/call`) + M3 (delete hand-rolled framing) remain.
- **`ActiveBlockId` newtype M3** — completes the type-system lift of invariant #9 (recursive-CTE conflict filtering); dispatcher decision pending.
