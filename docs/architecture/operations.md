<!-- markdownlint-disable MD060 -->
# Performance & Scalability

How the system stays responsive at scale, and the architectural choices that get it there.

## Product SLO

Interactive commands ≤ 200 ms p95 at 100K blocks. Pinned by `src-tauri/benches/interactive_slo.rs` — every interactive command has a per-command budget there (the bench file is the canonical source). The bench gates CI on regression; perf drift surfaces as a build failure, not a silent slowdown.

Two paths are known to exceed budget today (`list_page_links`, `list_projected_agenda`) and are gated behind `SLO_INCLUDE_PROBLEM=1` until mitigations land. The graph and projected-agenda paths are the known scaling frontiers.

## Architectural decisions that buy responsiveness

### Materializer apply-cursor atomicity (C-2b)

Op-log append + materialized-view apply + cursor advance run in a single transaction. Boot recovery walks from the cursor; one transaction means crash never leaves a half-applied state. Removes the entire "what if we re-applied this op twice" headache.

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
