<!-- markdownlint-disable MD060 -->
# Data Model & Event Sourcing

The system has two halves: a **logical data model** (everything is a block; references are ULID-anchored) and a **physical event-sourcing pipeline** (every change appends to an op log; materialized views derive from it).

## Stack

| Layer | Choice |
| --- | --- |
| Desktop shell | Tauri 2 (Rust + WebView) |
| Frontend | React 19, TypeScript, Vite, TipTap (ProseMirror) |
| Backend | Rust + SQLite (via `sqlx`, async, compile-time validated) |
| CRDT | Loro (per-space `LoroDoc` engines) |
| State | Zustand (per-feature stores; per-page stores via factory + context) |
| Bindings | `tauri-specta` (`agaric_commands!` macro is the single source) |
| Lint / format | OXC (oxlint + oxfmt) — no ESLint / Prettier / Biome |

**Rejected:** Electron (size), CodeMirror (cell model worse for outliner), Diesel (sync-only), ESLint+Prettier (Biome is one tool). See [`rejected.md`](rejected.md) for the full library-rejection catalogue.

## Everything is a block

One `blocks` table covers every entity. The `block_type` column discriminates:

| `block_type` | What it represents |
| --- | --- |
| `content` | Paragraph, heading, code block, list item — anything in a page body. |
| `page` | A page (also nestable; pages may contain pages). |
| `tag` | A tag (a first-class entity with its own page). |

Tree shape: `parent_id` + 1-based integer `position` among siblings. Batch-renumber on insert; **fractional indexing was rejected** (precision drift, lack of stable comparator across devices) — the SQL `position` stays an `i64`. The mergeable hierarchy lives in the Loro engine as a `LoroTree` (convergent moves, cycle-safety); the SQL `parent_id` / `position` columns are *derived* from it (`parent_id` = the tree parent's `block_id`, `position` = the node's `i64` sort key) and keep the same shape, so pagination cursors and the frontend's position arithmetic are unchanged. See [crdt-and-recovery.md](crdt-and-recovery.md) § CRDT convergence.

All inter-block references are ULID-keyed:

- `[[ULID]]` — page / block link
- `#[ULID]` — inline tag reference
- `((ULID))` — block reference (transclusion)

Renames never break references because the link is by ULID, resolved to a current title at render time.

## Tags & inheritance

A tag is a `blocks` row with `block_type = 'tag'`. Hierarchy is naming-convention: `projects/website` creates `projects` as a parent. Queries can include inherited descendants (`include_inherited`).

Inheritance is **materialized**, not a recursive CTE — `block_tag_inherited` is maintained incrementally by the materializer. This collapses cross-page tag-query latency from O(depth) to O(1) lookup. Tag-to-tag inheritance (chains across tags) will not ship — it complicates the model without enough payoff.

Inline tag references (`#[ULID]`) are tracked separately in `block_tag_refs`. They contribute to chip counts but do **not** participate in inheritance — the inline ref is a per-block usage, not a category membership.

## Pages

Pages may nest. Title sort order is a frontend preference (recent / alphabetical / created); the backend just returns the matching set. The `blocks.page_id` column denormalises the owning page (set by `create_block_in_tx`; rebuilt by `cache/page_id.rs`) so list queries can join on it directly instead of walking parent chains.

## Soft delete & trash

A block is soft-deleted via `deleted_at`. The Trash view lists root-only soft-deleted blocks; restore brings the whole subtree back. Hard purge cascades via foreign-key `ON DELETE CASCADE` across every dependent table (`block_properties`, `block_tags`, `block_links`, `block_tag_refs`, `page_link_cache`, …) — no enumerated DELETE list to maintain.

Soft-pointer columns (`block_properties.value_ref`) `CASCADE` on hard delete to keep the exactly-one-value-column CHECK valid.

## Property values

Non-built-in properties live in `block_properties`, one row per (block, key), with the value held in exactly one of `value_text` / `value_num` / `value_date` / `value_ref` / `value_bool` (the `exactly_one_value` CHECK enforces precisely one non-NULL arm). Built-in keys (`todo_state`, `due_date`, …) are denormalised to dedicated `blocks` columns instead and never hit this table.

**All numeric properties are stored as `REAL` (`value_num`), by design.** The numeric pipeline is `f64` end-to-end: SQL `value_num REAL` ↔ `PropertyValue::Num(f64)` (`src-tauri/src/loro/engine/mod.rs`) ↔ `LoroValue::Double` in the CRDT. There is deliberately **no `value_int` arm**. The consequence is that an integer-valued property (count, ordinal, priority) round-trips as `3.0` rather than `3`, and an integer above 2⁵³ would lose precision in the IEEE-754 double.

This is an accepted, *documented* tradeoff (#587), not an oversight:

- It is **unreachable with real payloads** today — every numeric property in use (priority levels, date-as-epoch-ms) is far below 2⁵³, so no value is actually mis-stored.
- Adding a `value_int` arm is **not a DB-only migration**. The same `f64` cast exists at the engine layer (`PropertyValue::Num(f64)` persisted as `LoroValue::Double`), so a faithful fix would need a matching `PropertyValue::Int` / `LoroValue::I64` variant threaded through `to_loro`/`from_loro` and the SQL projection in lock-step — otherwise the fidelity loss just moves one layer down. Touching only the column would be a false fix.

If a property type is ever introduced that is *semantically* a large exact integer (IDs, byte counts > 2⁵³, monotonic counters), revisit this as a coordinated three-layer change (column arm + `PropertyValue` variant + engine persistence) — not before. Until then `REAL` is sufficient and this note exists so the gap is not re-litigated as a bug.

## Concurrent edits

Convergence is CRDT-based: every op is **eventually** applied into the per-space `LoroEngine` (`src-tauri/src/loro/`), and the engine resolves concurrent writes deterministically — same op inputs produce identical state on every replica. The legacy three-way merge / `is_conflict` model is gone.

Both apply paths now funnel through **one collapsed entry point**, `apply_op_projected` (`src-tauri/src/materializer/handlers/apply.rs`; the #2250/#2325 convergence): it re-derives the payload from the appended op record and runs the same engine-apply + SQL projection on both. The paths differ **only** in the `advance_cursor` flag. The **cursor-advancing path** (`apply_op` / `BatchApplyOps`, reached by boot replay and remote/sync import) passes `true` — engine-apply and cursor advance share the transaction. The **live local command path** passes `false` from inside its own `CommandTx`: the engine is applied and the SQL row projected synchronously in the command's transaction, then `commit_and_dispatch` fires background cache rebuilds. Local writes therefore reach the engine eagerly; the deliberately-unadvanced cursor keeps boot replay re-applying the prior session's ops idempotently as a safety net (see "Apply-cursor semantics" below). One asymmetry remains: a delete/restore's *descendant cohort* fans out to the engine **post-commit** (`dispatch_delete_descendants` / `dispatch_restore_descendants`), so SQL can lead the engine for those descendants for the instants between commit and fan-out. The `sql_only` fallback survives only for the `SpaceUnresolved` trigger (see [sql-only-convergence.md](sql-only-convergence.md)); the `EngineUninit` arm is retired in production.

## Database

SQLite, WAL mode, FK on, `synchronous=NORMAL`, `busy_timeout=5000`, `wal_autocheckpoint=5000` pages, `journal_size_limit=52428800` (50 MB WAL cap), `cache_size=-65536` (64 MB), `mmap_size=268435456` (256 MB), `temp_store=MEMORY`. Set per-connection on both pools in `src-tauri/src/db/pool.rs`.

**Pool architecture:** type-safe `WritePool` (2 connections) + `ReadPool` (4 connections). The newtypes prevent accidentally reading through the write pool or vice versa. Cache rebuilds use the read pool until the final DELETE+INSERT batch, which acquires a write connection.

**Migrations:** `src-tauri/migrations/*.sql`, versioned SQL, auto-run on boot. `sqlx::query!` / `query_as!` macros validate every query at compile time; the offline cache is `.sqlx/` (committed; CI fails on stale via `sqlx-prepare-check`).

**Triggers:** an append-only enforcement trigger on `op_log` (with a sentinel bypass for compaction). The `block_type` enum is enforced at the SQL layer by the `block_type_valid` CHECK constraint on `blocks` (migration `0085_blocks_block_type_check.sql`, which replaced the original migration-0005 BEFORE INSERT/UPDATE triggers — a CHECK survives table rebuilds automatically). Cache tables are rebuilt by the materializer, not by triggers — kept simple to avoid Sql-side hidden state.

## Op log

Append-only. Composite primary key `(device_id, seq)` where `seq` is the device-local monotonic counter (`COALESCE(MAX(seq), 0) + 1 WHERE device_id = ?`). Per-device counters mean two peers can produce `seq = 5` independently without collision; renumbering would break the hash chain.

**Three truths (#2481).** The op log is **globally-replicated audit truth**, the Loro engine is **state truth**, and SQL is **query truth**. Own-device ops are dual-written to the log *and* applied to state (below); since #2481 phase 1, *foreign*-device ops also land in the log — streamed as `SyncMessage::OpLogBatch` after the Loro deltas, hash-verified, stored with `is_replicated = 1` — but purely as **audit metadata for cross-device History/attribution, never applied to state** (every state path filters `is_replicated = 0`). State converges only through Loro CRDT sync; the replicated log cannot be a cross-device state-rebuild source (op replay is order-dependent and non-convergent — the pre-Loro problem the cutover deleted).

**Hash chain.** Each op carries a `blake3` hash of its own preimage. The chain is **positional, not Merkle**: the preimage includes `parent_seqs` (the `(device_id, seq)` *positions* of the parent op(s)), not the parent op's hash — so a child's hash does not transitively depend on its ancestors' hashes. The preimage is a null-byte-separated concat of fields (`\0`-delimited so a payload containing the delimiter would be unrepresentable — fields are guarded against `\0`). `origin` is intentionally excluded from the preimage so local-only attribution metadata (e.g. `agent:claude`) doesn't perturb cross-device op identity. See [`op-log-format.md`](op-log-format.md) for the exact preimage byte layout and verification rules.

ULIDs are normalised to uppercase Crockford-Base32 in the preimage (and in every `block_id` slot) — the hash is byte-stable only when the normalisation is.

**Op types** (the engine applies all of these; attachments are out-of-engine because the file blob lives on disk):

| Type | What it changes |
| --- | --- |
| `create_block` | Inserts a new block with `parent_id`, `position`, `block_type`, `content`. |
| `edit_block` | Replaces a block's content. |
| `delete_block` | Soft-deletes a block (and descendants — cascade is always-on). |
| `restore_block` | Reverses a soft delete. |
| `purge_block` | Hard delete; non-reversible. |
| `move_block` | Reparents or repositions. |
| `set_property` | Sets a typed property value. |
| `delete_property` | Removes a property. |
| `add_tag` | Adds a tag association. |
| `remove_tag` | Removes a tag association. |
| `add_attachment` | Records an attachment binding (file blob managed separately). |
| `delete_attachment` | Removes the binding. |

`block_links`, `page_link_cache`, `block_tag_refs`, `block_tag_inherited` are caches, **never op types** — they are rebuilt deterministically from the underlying op-induced state.

**Draft lifecycle.** `block_drafts` is the only mutable scratch table — it stores the in-flight content of focused blocks so a crash mid-edit doesn't lose work. `INSERT OR REPLACE` semantics; entries are reconciled at boot (see Recovery).

## Materializer

Synchronous primary-state materialization, not pure CQRS. Every op is dual-written: into `op_log` AND into the affected core tables (`blocks`, `block_properties`, `block_tags`, …) in **one** transaction. Background cache rebuilds queue up after the core write commits.

```text
apply_op_projected(op, advance_cursor):
  BEGIN IMMEDIATE
    INSERT INTO op_log (...) VALUES (...)        -- the truth
    apply op to core tables (blocks, ...)        -- primary state
    apply op to LoroEngine (per-space)           -- engine, same tx
    reproject engine-owned ordering (dense-rank)  -- when the op moved things
    if advance_cursor:                            -- REMOTE / boot replay only
      advance materializer_apply_cursor           -- atomic with above
  COMMIT
  post-commit: enqueue cache rebuild tasks (background)
```

Apply-and-advance share one transaction → crash never advances the cursor past the last applied seq, and a crash never leaves the engine ahead of (or behind) the SQL tables — they commit or roll back together.

### Queue architecture

- **Foreground queue**: small bounded channel (capacity 256). Used for synchronous-feeling user ops.
- **Background queue**: larger bounded channel (capacity 1024). Used for cache-rebuild fan-out, FTS reindex, agenda projection rebuild, attachment GC.
- **Dedup**: identical tasks within a flush window collapse via per-task-discriminant hash sets.
- **Panic isolation**: a panic in one task does not poison the queue; the next task drains.

### Retry semantics

Two-tier retry:

- **In-memory**: foreground retries once at ~100 ms; background retries up to twice at 150 ms → 300 ms.
- **Persistent**: foreground apply path **persists exhausted ops** into `materializer_retry_queue` and warns; background global rebuilds (`RebuildTagsCache`, `RebuildPagesCache`, …) also persist using the `'__GLOBAL__'` sentinel for `block_id`. Drained on the next boot.

`Barrier` and `Panic` tasks never retry. Truly non-retryable tasks (full FTS rebuild, FTS optimize, attachment GC) are silently counted on failure.

### Materialized caches

Rebuilt by the materializer; never read-through:

| Cache | What it stores | Triggered by | Serves stale during retry window? |
| --- | --- | --- | --- |
| `block_links` | `[[ULID]]` (page-link) and `((ULID))` (block-ref) tokens parsed out of block content. `#[ULID]` inline tag refs are NOT here — they go to `block_tag_refs`. | `edit_block`, `create_block` (content scan) | Yes — `ReindexBlockLinks` is a persisted per-block task |
| `page_link_cache` | Page-level rollup `(source_page, target_page, edge_count)` | derived from `block_links` | Yes — `RebuildPageLinkCache` is a persisted global task |
| `block_tag_refs` | Inline `#[ULID]` references | content scan, separate from explicit tag membership | Yes — `ReindexBlockTagRefs` is a persisted per-block task |
| `block_tag_inherited` | Materialized ancestor-tag inheritance | `add_tag` / `remove_tag` + tree moves | Yes — `RebuildTagInheritanceCache` is a persisted global task |
| `tags_cache` | Per-tag aggregate (usage, descendant count) | tag-touching ops | Yes — `RebuildTagsCache` is a persisted global task |
| `pages_cache` | Per-page aggregate | page-touching ops | Yes — `RebuildPagesCache` is a persisted global task |
| `agenda_cache` | Per-date task index | due / scheduled / completed property writes | Yes — `RebuildAgendaCache` is a persisted global task |
| `projected_agenda_cache` | Future occurrences of repeating tasks | repeat-property writes | Yes — `RebuildProjectedAgendaCache` is a persisted global task |
| `fts_blocks` (FTS5 virtual table) | Tokenised block content for search | edit_block, materializer post-commit | Yes for incremental per-block reindex (`UpdateFtsBlock` is persisted); **no** for a full reindex — `RebuildFtsIndex` is one of the "truly non-retryable" tasks and is silently dropped on failure/saturation, not queued for a later sweep |

**Rebuild order is load-bearing.** `rebuild_page_ids` MUST run before `rebuild_agenda_cache` / `rebuild_projected_agenda_cache` (the date-by-page joins depend on the denormalised column). `rebuild_block_tag_refs_cache` runs before `rebuild_tags_cache`. The materializer's task graph enforces this.

### Per-cache staleness contract (#2471)

The staleness **bound** for every cache above is engineered, not incidental: a task that fails all in-memory retries (or is dropped by a saturated background queue) is persisted to `materializer_retry_queue` and picked up by a sweeper on an escalating backoff — 1 min → 5 min → 30 min → **1 hour cap** (`backoff_delay_for`, `src-tauri/src/materializer/retry_queue.rs:341-347`; documented at `AGENTS.md:258` "Materializer task durability"). So after a drop-then-persist event, any of the caches marked "Yes" above can lag primary state by **up to one hour**, until either a later unrelated mutation re-dispatches the same rebuild or the sweeper's own retry succeeds. Two counters on `StatusInfo` track this: `bg_dropped` (total drop-then-persist events, `src-tauri/src/materializer/metrics.rs:89`) and `bg_dropped_global` (the subset attributable to a global rebuild rather than a per-block reindex, `:90`), both surfaced by `get_status` (`src/lib/bindings.ts:3409-3422`).

**Read-surface classification.** Every user-facing read either resolves against a **primary** table (`blocks` / `block_properties` / `block_tags`) — always current, the write is in the same transaction — or against one of the **cache** tables above, which inherits the up-to-1h bound. The rule is mechanical: trace the read's `FROM` clause. A read that touches a cache table is bounded-stale; a read that only touches primary tables is never affected by retry-queue staleness. A lagging search result for a block whose primary content is already up to date is therefore possible and expected — the block opens fine, search just hasn't caught up.

| Read surface | Reads from | Kind | Bounded-stale (≤1h)? |
| --- | --- | --- | --- |
| Open / load a page, render blocks | `blocks`, `block_properties` (`src-tauri/src/commands/pages/listing.rs`) | primary | **No** — always current |
| Read one block's content | `blocks`, `block_properties` (`src-tauri/src/commands/blocks/crud.rs`) | primary | **No** — always current |
| Explicit tag membership on a block | `block_tags` (`src-tauri/src/commands/tags.rs`) | primary | **No** — written in-txn with the tag op |
| Full-text search / FTS | `fts_blocks` (`src-tauri/src/fts/search/fetch.rs`) | cache | **Yes** — `UpdateFtsBlock` is a persisted per-block task |
| Agenda (day / upcoming) | `agenda_cache` (`src-tauri/src/commands/agenda.rs`) | cache | **Yes** — `RebuildAgendaCache` |
| Repeating-task projections | `projected_agenda_cache` (`src-tauri/src/commands/agenda.rs`) | cache | **Yes** — `RebuildProjectedAgendaCache` |
| Tag-inheritance queries (`include_inherited`) | `block_tag_inherited` (`src-tauri/src/commands/pages/links.rs`) | cache | **Yes** — `RebuildTagInheritanceCache` |
| Backlinks / inbound page links | `page_link_cache` (`src-tauri/src/commands/pages/links.rs`) | cache | **Yes** — `RebuildPageLinkCache` |
| Pages-view per-page aggregate counts | `pages_cache` (`src-tauri/src/commands/pages/metadata.rs`) | cache | **Yes** — `RebuildPagesCache` |
| Per-tag aggregate counts (usage, descendants) | `tags_cache` (`src-tauri/src/commands/tags.rs`) | cache | **Yes** — `RebuildTagsCache` |

The boundary to remember: **the content of a note is never stale; the indexes that help you find or count it can be.** Opening a page you just edited always shows the edit; searching for it, seeing it in the agenda, or seeing an updated backlink/count can lag by up to the 1h backoff cap after a drop-then-persist event.

**Surfacing the bounded-staleness state (#2471).** The degraded state is now visible in the Status view. `StatusPanel.tsx` (`src/components/agenda/StatusPanel.tsx`) reads `StatusInfo.bg_dropped` alongside `retry_queue_pending` and, when **both** are non-zero (a drop happened *and* rows are still waiting in the retry queue), renders a bounded-staleness notice — "*N background cache rebuilds pending; search, agenda, and counts may be briefly stale*" — so a search silently missing a recent edit is no longer indistinguishable from the note not existing: the Status view now carries the cue and states the ≤1h self-heal bound. This gates on `retry_queue_pending > 0` rather than `bg_dropped > 0` alone because `bg_dropped` is a monotonic since-boot counter (a past drop that has since flushed should not keep the notice lit), whereas `retry_queue_pending` reflects the live queue.

Two smaller affordances from the issue remain **deferred follow-ups** (not built here) because each needs new plumbing rather than a field read: (a) a *manual "rebuild now"/flush* action — `Materializer::flush_background` exists but is only called from test code (e.g. `src-tauri/src/commands/journal.rs`), with no `#[tauri::command]` wrapper, so exposing it is new command + wiring work; and (b) an inline *search-results banner* while `fts_blocks` specifically has pending rebuilds — the Status-view notice covers all caches uniformly, but a per-surface FTS banner would need the FTS-only pending count threaded to the search UI. Both are left as optional future affordances beyond the core #2471 contract-and-surfacing work.

### Durable retry: correctness vs. staleness (#2509)

Issue #2509 asked whether `materializer_retry_queue` still earns its keep now that primary-state apply is synchronous and in-transaction on every path (post-#2250/#2325) — i.e. whether the persistent tier could be retired in favor of "mark dirty, rebuild on next boot/idle tick." Reading `retry_queue.rs` end to end shows the queue carries **two structurally different payload classes**, and only one of them is the "derived cache" story above:

1. **Per-block / global cache-rebuild tasks** (`UpdateFtsBlock`, `ReindexBlockLinks`, `ReindexBlockTagRefs`, `RefreshTagUsageCount`, `RebuildTagsCache`, `RebuildPagesCache`, `RebuildPagesCacheCounts`, `RebuildAgendaCache`, `RebuildProjectedAgendaCache`, `RebuildTagInheritanceCache`, `RebuildPageIds`, `SetBlockPageId`, `RebuildBlockTagRefsCache`, `RebuildPageLinkCache`) — these are exactly the caches in the table above: idempotent to rebuild from primary state, and their persisted-retry loss is bounded by the documented ≤1h backoff cap.
2. **`ApplyOp` / `BatchApplyOps`** (`retry_queue.rs:118-129`) — a failed **primary-state application**, keyed by `(device_id, seq)` rather than a cache identity. This class is not a cache-staleness concern; it is a correctness backstop, for reasons that matter to any future "just drop it" proposal:
   - `ApplyOp` tasks reach the foreground queue on **every boot**, not just during pool-exhaustion storms: because the LOCAL command path applies with `apply_op_projected(advance_cursor=false)` (#1257 — it deliberately does not move the cursor), `materialized_through_seq` stays pinned at the prior boot's watermark while a live session runs. The **next boot's replay therefore re-enqueues the whole prior session's local ops** as `ApplyOp` tasks (`recovery/replay.rs:441-489`), each going through `apply_op` (`materializer/handlers/apply.rs:37-103`), which is the one call site that runs `apply_op_projected(advance_cursor=true)`.
   - `advance_apply_cursor` is `MAX(materialized_through_seq, seq)` (`handlers/apply.rs:515-537`). If op *N* exhausts its 100ms in-memory retry budget but op *N+1* in the same replay batch succeeds, the cursor jumps to *N+1* — and the next boot's `WHERE seq > cursor` query can **never see op *N* again**. The persisted retry-queue row is the only remaining record that the op was never materialized; see the `#621` rationale inline (`retry_queue.rs:736-747`) and the ~150 lines of purge/edit-supersession guards (`SupersededByPurge` / `SupersededByAncestorPurge` / `SupersededByEdit`, `retry_queue.rs:956-1198`) that exist specifically to make a late, out-of-order re-apply of such a row safe rather than a data-resurrection bug. Losing this class silently drops a user's write, not a cache entry.
   - Live incoming sync does **not** go through this path at all today — it applies via the CRDT-native `apply_remote` (`sync_protocol/loro_sync.rs`), which imports the Loro update and reprojects to SQL directly, with no reference to the materializer or its retry queue. `ApplyOp`/`BatchApplyOps` persistence is exercised in production by boot replay (`recovery/replay.rs`) and draft recovery (`recovery/draft_recovery.rs:186`) only — but boot replay runs on every restart with a nonempty prior session, so this is not a rare path.
   - Distinct metrics already exist for this class — `fg_apply_dropped` / `fg_apply_dropped_persisted` (`materializer/metrics.rs:49-79`), separate from `bg_dropped` / `bg_dropped_global` above — but neither is documented in this file or surfaced anywhere in the frontend; they're the actual counters to watch to answer "how often does this fire in the field," which nobody has instrumented yet.

One correction to the "reconciled at boot anyway" premise for class (1): `recovery/cache_refresh.rs` only refreshes FTS/links/tags/pages caches for **draft-recovered block ids** — it is not a general boot-time cache reconciliation pass. A background cache task that is shed (queue-full) or fails without being persisted has no other automatic re-trigger besides an unrelated later mutation of the same block/tag/page. So for class (1), retiring the persistent tier would trade the documented ≤1h staleness bound for an unbounded one, not for "next boot fixes it" — the boot path doesn't currently do that general fix.

**Conclusion:** the persistent tier is not uniformly disposable. Class (2) (`ApplyOp`/`BatchApplyOps`) is load-bearing for correctness and structurally exercised on every boot with un-replayed local ops; class (1) (the cache rebuilds) is durability/staleness machinery whose removal is not obviously safe today because no general "rebuild on next boot" path exists to fall back on. See #2509 for the full investigation; #2471 surfaced `bg_dropped` in the Status view (above) and left the manual-flush command and per-surface FTS banner as optional future affordances. `fg_apply_dropped`/`fg_apply_dropped_persisted` — the class-(2) correctness counters — remain unsurfaced in the UI.

#### Per-`task_kind` classification (the retirement decision, task by task)

Every `RetryKind` that `record_failure` can persist, classified by whether its durable retry is load-bearing for **correctness** (a boot-rebuild would not recover it) or only bounds cache **staleness** (a "mark dirty, rebuild on boot/idle" shape could subsume it). Persisted `block_id` shape and the `retry_queue.rs` evidence are noted so a future retirement PR can act per-kind rather than all-or-nothing:

| `task_kind` | `block_id` shape | class | boot-rebuild would recover it? |
| --- | --- | --- | --- |
| `ApplyOp:<seq>:<device_id>` | `'__APPLY_OP__'` | **correctness** | **No** — `advance_apply_cursor`'s `MAX(materialized_through_seq, seq)` (`handlers/apply.rs`) can strand op *N* forever once *N+1* advances the cursor; the persisted row is the only surviving record. Purge/edit-supersession guards (`retry_queue.rs` `SupersededBy*`) exist to make the late re-apply safe. |
| `UpdateFtsBlock` | real `block_id` | pure-cache | Yes — idempotent FTS reindex from `blocks`; but only if a general boot reconcile existed (it does not today; `cache_refresh.rs` covers draft-recovered ids only). |
| `ReindexBlockLinks` | real `block_id` | pure-cache | Yes (same caveat). |
| `ReindexBlockTagRefs` | real `block_id` | pure-cache | Yes (same caveat). |
| `RefreshTagUsageCount` | `tag_id` | pure-cache | Yes (same caveat). |
| `RebuildTagsCache` | `'__GLOBAL__'` | pure-cache | Yes (same caveat). |
| `RebuildPagesCache` | `'__GLOBAL__'` | pure-cache | Yes (same caveat). |
| `RebuildPagesCacheCounts` | `'__GLOBAL__'` | pure-cache | Yes (same caveat). |
| `RebuildAgendaCache` | `'__GLOBAL__'` | pure-cache | Yes (same caveat). |
| `RebuildProjectedAgendaCache` | `'__GLOBAL__'` | pure-cache | Yes (same caveat). |
| `RebuildTagInheritanceCache` | `'__GLOBAL__'` | pure-cache | Yes (same caveat). |
| `RebuildPageIds` | `'__GLOBAL__'` | pure-cache | Yes (same caveat). |
| `SetBlockPageId` | real `block_id` | pure-cache | Yes (same caveat). |
| `RebuildBlockTagRefsCache` | `'__GLOBAL__'` | pure-cache | Yes (same caveat). |
| `RebuildPageLinkCache` | `'__GLOBAL__'` | pure-cache | Yes (same caveat). |

Rebuild-order dependencies the issue flagged for correctness (measure-item 3, e.g. `page_ids` before agenda) are enforced by the materializer's **dispatch/dedup** layer, not by retry-queue persistence — that ordering is orthogonal to whether a *failed instance* of a rebuild gets a durable retry, so it does not, on its own, keep the persistent tier alive for class (1).

#### Instrumentation added by #2509 (measure before removing)

The prior investigation could not produce field numbers; #2528 was docs-only. #2509 adds the counters that make measure-items 1 and 2 answerable **in production**, classified so the retirement decision is data-driven rather than by-inspection. Every persistent enqueue funnels through `record_failure`, which now calls `QueueMetrics::note_persistent_enqueue(class, attempts)` and surfaces four new `StatusInfo` fields (`materializer/metrics.rs`, wired through `coordinator.rs::status_with_scheduler`):

- `retry_persist_apply_op` — reaches of the **correctness** class. Expected to track boots with a nonempty prior session (replay re-enqueues un-cursor-advanced local ops). A field value that scales with restarts *confirms* the class-(2) design rather than indicting it.
- `retry_persist_cache` — reaches of the **pure-cache** class (per-block + global). **This is the retirement gauge.** If it stays ≈0 outside pool-exhaustion storms, class (1)'s persistent tier is protecting a failure mode that almost never happens, and the simpler "mark dirty, rebuild on boot/idle" shape becomes defensible — *once the general boot-reconcile pass it depends on actually exists*.
- `retry_persist_cache_global` — subset of the above attributable to global `'__GLOBAL__'` rebuilds (the most expensive to re-run; distinguishes a per-block reindex backlog from a global-cache freshness gap).
- `retry_persist_capped` — reaches that escalated to the **1h backoff-cap tier** (`attempts >= 4`). Measure-item 2 directly: if this stays ≈0, no failure mode ever exercises the deep backoff schedule, and the next boot would have covered the same ground — evidence that the multi-tier backoff is machinery in excess of the failure it guards.

Each counter is bumped on *every* reach (fresh INSERT and every escalating UPSERT), so they measure churn, not distinct rows; the `persist_class` is also emitted on the existing `record_failure` warn line for per-event triage. These are process-global monotonic counters on the same path #2471 uses for `bg_dropped`; surfacing them in the Status view is left to that frontend work, consistent with the counters above.

#### Recommendation (reasoned, telemetry-gated)

**Keep the persistent tier as-is for now; do not remove anything in this issue.** Grounded in the code, not vibes:

1. **Class (2) (`ApplyOp`) — keep, design vindicated.** Its loss is a dropped *user write*, not a stale cache, and it is exercised on *every* boot with un-replayed local ops (`recovery/replay.rs`), not just in storms. Durable retry here protects something boot-rebuild structurally cannot (the `MAX`-cursor strand). No plausible telemetry retires this.
2. **Class (1) (the cache rebuilds) — a candidate for the simpler mark-dirty/boot-rebuild shape, but blocked on two preconditions, not sanctioned yet.** The reduced shape would be: on cache-handler failure or shed, mark the affected entity dirty (or rely on the existing `pending_retry_rows` gauge as a "something is stale" flag) and rebuild on the next boot/idle tick — deleting the 1m→1h backoff schedule, the `(block_id, task_kind)` coalescing, and the `'__GLOBAL__'` sentinel machinery for these kinds only. That is safe **only if both**: (a) the new `retry_persist_cache` / `retry_persist_capped` field data shows class-(1) reaches are ≈0 and effectively never escalate to the cap (else the simpler shape trades a bounded ≤1h staleness window for an unbounded one); **and** (b) a *general* boot/idle cache-reconciliation pass is built first — today `recovery/cache_refresh.rs` only covers draft-recovered block ids, so "next boot fixes it" is not currently true. Executing that removal is an explicit **telemetry-gated follow-up** (track under #2509 / a new issue), not part of this change.

### Crash recovery (boot)

Four steps, runs once per process (guarded by `AtomicBool`):

1. Delete `log_snapshots WHERE status = 'pending'` (incomplete snapshot writes from a previous crash).
2. **Replay unmaterialized ops** (C-2b): walk `op_log WHERE seq > materializer_apply_cursor.materialized_through_seq`; enqueue each through the foreground queue; drain via Barrier.
3. **Reconcile drafts**: walk `block_drafts`; emit a synthetic `edit_block` or `create_block` op iff no matching newer op exists in `op_log` after the draft's `updated_at`.
4. Delete all draft rows.

Followed by an explicit cache rebuild for any blocks resurrected by step 3.

Per-draft errors are captured in a `RecoveryReport`; a single corrupt draft does not block boot.

## BE→FE change-notification contract

The call direction (FE→BE) is documented via the `agaric_commands!` macro / `tauri-specta` bindings (`src/lib/bindings.ts`) — every invocation is a typed, awaited request/response. The reverse direction is undocumented as a contract: Rust emits ad hoc Tauri events (`AppHandle::emit`), the frontend subscribes with `listen()`, and nothing about ordering, delivery, or staleness is written down anywhere. This section is that contract (#2461).

It is derived by (a) reading `src-tauri/src/sync_events.rs` in full, (b) ripgrepping `\.emit\(|\.emit_all\(` across `src-tauri/src`, and (c) reading every frontend hook that calls `listen()` (directly or through the shared `useTauriEventListener` wrapper, `src/hooks/useTauriEventListener.ts`). The inventory below is broader than the one first proposed in #2461: two more broadcast events (`recovery:degraded`, `mcp:activity`) exist and are consumed on the frontend, and two of the issue's per-event claims (a `sync:mdns_disabled` consumer, and "1 listener" for `block:properties-changed`) do not match what the code currently does — both are called out inline.

### Event registry

Every row below is a **broadcast** event: `AppHandle::emit(name, payload)` on the Rust side, `listen(name, cb)` on the frontend, delivered to every registered listener with no addressee. This is distinct from the per-invoke `tauri::ipc::Channel<T>` streams (`SyncProgressUpdate::Files` / `::Snapshot`, and the markdown-import `ImportProgressUpdate` channel in `src-tauri/src/commands/pages/markdown.rs`) that exist only for the lifetime of one `invoke()` call and are not part of this contract — they cannot go stale the way a missed broadcast event can, because the invoking component owns the channel end for as long as it's listening.

| Event | Payload | Emitted when | FE consumer(s) | On receipt |
| --- | --- | --- | --- | --- |
| `sync:progress` (`EVENT_SYNC_PROGRESS`) | `SyncEvent::Progress { state, remote_device_id, ops_received, ops_sent }` | Per state transition of a **background/daemon-triggered** sync session — the raw `TauriEventSink` wired in `src-tauri/src/lib.rs:2041` for the auto-sync daemon | **None.** `useSyncEvents.ts` dropped its `sync:progress` listener in the Phase 2 channel migration (see the file's own module doc). A manually-triggered "sync now" reports progress over a per-invoke `Channel<SyncProgressUpdate>` instead (`useSyncTrigger`), which is a different transport than this event. | Dropped silently — nothing observes this event today. |
| `sync:complete` (`EVENT_SYNC_COMPLETE`) | `SyncEvent::Complete { remote_device_id, ops_received, ops_sent, changed_page_ids: Vec<String> }` | Once per sync session, success | `src/hooks/useSyncEvents.ts` | Sets sync store to `idle`, toasts if `ops_received > 0`, and reloads: if `changed_page_ids` is non-empty (#1071 targeted invalidation), reload + re-anchor undo **only** the mounted page stores whose id is in the set, then run one resolve-cache preload and bump the graph-structure signal; if the field is absent/empty (older peer, or the snapshot-catch-up path which reimports a whole space), fall back to reloading **every** mounted page store plus a full preload. |
| `sync:error` (`EVENT_SYNC_ERROR`) | `SyncEvent::Error { message, remote_device_id }` | Sync session failed | `src/hooks/useSyncEvents.ts` | Sets sync store to `error` + error toast. No data reload. |
| `sync:mdns_disabled` (`EVENT_SYNC_MDNS_DISABLED`) | `SyncEvent::MdnsDisabled { reason }` | mDNS peer discovery could not initialize (sandboxed platform) | **None found.** Ripgrepping `src/**/*.ts,*.tsx` for `mdns` / `MdnsDisabled` turns up only an unrelated static hint string in a device-management test (`src/components/peers/__tests__/DeviceManagement.test.tsx:1247`). #2461's inventory table lists "settings surface" as the consumer; that consumer does not exist in this codebase — sync still works via manual IP entry, but nothing tells the user *why* the peer list is empty. | Dropped on the FE today — no listener, no user-visible effect. |
| `block:properties-changed` (`EVENT_PROPERTY_CHANGED`) | `PropertyChangedEvent { block_id, changed_keys }` | After `set_property` / `set_todo_state` / `set_priority` / `set_due_date` / `set_scheduled_date` / `delete_property` commits, via the shared `emit_property_changed_event` helper (`src-tauri/src/commands/properties.rs:56-81`); **and (#2505) after an MCP `set_property` write commits**, via the RW tool's `ViewChangeEmitter` (`src-tauri/src/mcp/view_notify.rs`), with the byte-identical `{ block_id, changed_keys: [key] }` payload | **Three independent listeners**, not one: `src/lib/block-property-events.ts` (module-level 150 ms-debounced invalidation counter, consumed via `useBlockPropertyEvents`), and two instances of the `createPropertyChangeCache` factory (`src/lib/create-property-change-cache.ts`) in `src/lib/property-keys-cache.ts` and `src/lib/property-values-cache.ts`. #2461 describes this as "(1 listener)"; the actual count is 3, each independently `listen()`-registered and each doing a **blanket** invalidation that ignores `block_id`/`changed_keys` — any property change anywhere invalidates all three caches. | Each listener discards the payload and invalidates its own cache/counter wholesale (no per-block or per-key targeting on the FE side, unlike `sync:complete`'s `changed_page_ids`). |
| `blocks:changed` (`EVENT_BLOCKS_CHANGED`, `src-tauri/src/sync_events.rs`) — **#2505, the out-of-band local-write signal** | `BlocksChangedEvent { changed_page_ids: Vec<String> }` — `changed_page_ids` carries the **identical** semantics as `SyncEvent::Complete`'s #1071 field (deduped owning-page ids for the write) | After each MCP RW tool (`append_block` / `update_block_content` / `set_property` / `add_tag` / `create_page` / `delete_block`) commits, via the RW tool's `ViewChangeEmitter` (`src-tauri/src/mcp/view_notify.rs`); the owning-page set is resolved post-commit by the same `resolve_changed_page_ids` `parent_id`-chain walk the sync path uses (`src-tauri/src/sync_protocol/loro_sync.rs`) | `src/hooks/useSyncEvents.ts` (the same hook that owns `sync:complete`) | Routes through the **shared `reloadChangedPageStores` helper** — the exact `forEachPageStore` targeted-reload path `sync:complete` uses: reload + undo-re-anchor (#731) only the mounted page stores whose id is in the set (empty/absent set → reload every mounted store), then one resolve-cache preload and a graph-structure-signal bump. No toast, no ops counter. |
| `deeplink:navigate-to-block` / `deeplink:navigate-to-page` (`EVENT_NAVIGATE_TO_BLOCK` / `EVENT_NAVIGATE_TO_PAGE`) | `BlockNavigatePayload { id }` | `src-tauri/src/deeplink/mod.rs` parses an inbound `agaric://…` or `https://agaric.app/o/…` URL | `src/hooks/useDeepLinkRouter.ts` | Resolves the block/page and navigates. |
| `deeplink:open-settings` (`EVENT_OPEN_SETTINGS`) | `OpenSettingsPayload { tab }` | Same deep-link router, `settings/<tab>` route | `src/hooks/useDeepLinkRouter.ts` | Sets the pending settings tab and opens the settings view. |
| `recovery:degraded` (`EVENT_RECOVERY_DEGRADED`, `src-tauri/src/recovery/mod.rs:132`) — **not in #2461's original table** | `RecoveryStatus { degraded, replay_errors }` | Once at boot, only if the C-2b op-log replay failed wholesale (`surface_recovery_status`, `src-tauri/src/lib.rs:955-989`) | `src/hooks/useRecoveryStatus.ts` | Shows a persistent (`duration: Infinity`) degraded-boot toast, deduped by a fixed id. |
| `mcp:activity` (`MCP_ACTIVITY_EVENT`, `src-tauri/src/mcp/activity.rs:46`) — **not in #2461's original table** | `ActivityEntry { tool_name, summary, timestamp, actor_kind, agent_name?, result, session_id, op_ref?, additional_op_refs? }` (the two `?` fields are `skip_serializing_if`-omitted from the wire when absent/empty; `additional_op_refs` is forward-compat and empty for today's single-op RW tools) | After every completed MCP tool call (RO and RW), pushed to the in-memory ring buffer first and then emitted (`emit_activity`, `src-tauri/src/mcp/activity.rs:399-415`) | `src/hooks/useMcpActivityFeed.ts` (mounted only while the Agent Access settings tab is open) | Prepends the entry to a capped (100-entry) render buffer. **This is the only propagation an MCP write produces** — see Known gaps below. |

### Delivery guarantees

- **Fire-and-forget.** `AppHandle::emit` is a plain broadcast; there is no ack, no persistence, and no replay. `TauriEventSink::on_sync_event` (`src-tauri/src/sync_events.rs:179-203`) and every other emit site log a `tracing::warn!` on failure but never propagate it — a missing/unmounted frontend does not block the backend.
- **No cross-event ordering guarantee.** Events are independent broadcasts; only events that share one Rust-side sequential emitter (e.g. `Progress`→`Complete` within one sync session) are ordered relative to each other.
- **Two recovery patterns are in use, inconsistently:**
  1. **Implicit reload-on-mount.** Per-page state lives in Zustand stores created by `PageBlockStoreProvider` (`src/stores/page-blocks.ts`) that call `load()` fresh each time a `BlockTree` mounts. Navigating away from a page and back re-fetches current state regardless of whether any event was missed while unmounted.
  2. **Explicit "emit + query-on-mount backfill".** Used by `recovery:degraded` (`getRecoveryStatus()` on mount, `src/hooks/useRecoveryStatus.ts:98-116`) and by the deep-link router's launch-URL case (`getCurrentDeepLink()` on mount, `src/hooks/useDeepLinkRouter.ts:323-348`) specifically because both can be emitted by the backend *before* the frontend listener has registered (boot / OS launch races).
- **No backfill wired for `sync:complete`, `block:properties-changed`, or `mcp:activity`.** A live emission missed while unmounted is gone. `mcp:activity` is the sharpest case: the `get_mcp_recent_activity` command exists specifically to read back the ring buffer (`src/lib/bindings.ts:767`, backed by `McpActivityRing` in `src-tauri/src/mcp/activity.rs`) but no frontend component currently calls it — the backfill data exists server-side and is simply never fetched.

### Staleness rule

What a missed event costs, and what eventually re-converges it:

| Event | Cost of a missed emission | What re-converges it |
| --- | --- | --- |
| `sync:complete` | The affected page store(s) keep rendering pre-sync content | The **next** `sync:complete` (each carries a full `changed_page_ids` set for ops applied *in that session*, not a cumulative diff, so a page whose only change was in the missed session stays stale until something else touches it), or navigating away and back (reload-on-mount) |
| `block:properties-changed` | Property-key/value autocomplete and the property-panel invalidation counter serve stale data | Any **later** `block:properties-changed` event for *any* block (the invalidation is blanket, not keyed), or a full page/app reload |
| `recovery:degraded` | None — the mount-time `getRecoveryStatus()` backfill always runs | Backfill, unconditionally |
| `deeplink:*` | The OS-launch URL is lost | Backfill via `getCurrentDeepLink()`, unconditionally, for the launch case only — a deep link delivered while the app is already running and the listener is momentarily not yet attached has no backfill |
| `mcp:activity` | The Agent Access activity feed under-reports recent tool calls | Nothing today — see the ring-buffer note above |
| `sync:mdns_disabled` | The user gets no explanation for an empty peer list | Nothing — no consumer exists |
| `blocks:changed` | An open page displaying a block an MCP tool just wrote keeps rendering the pre-write content | Any **later** `blocks:changed` (or `sync:complete`) that includes the page, or navigating away and back (reload-on-mount) — fire-and-forget, no backfill, same as `sync:complete` |

### Known gaps (#2461)

1. **~~MCP RW writes have no propagation channel to open views.~~ RESOLVED (#2505).** The decision was: reuse the pattern that already works rather than invent a channel. Every MCP RW tool now emits a page-keyed **`blocks:changed`** event (`BlocksChangedEvent { changed_page_ids }`) post-commit, whose `changed_page_ids` payload is byte-identical to `SyncEvent::Complete`'s #1071 field; the frontend consumes it through the **same** `reloadChangedPageStores` targeted-reload path `sync:complete` already uses (`src/hooks/useSyncEvents.ts`) — no new event vocabulary on the FE, no new consumer machinery. Property-touching writes (`set_property`) *additionally* fire the existing `block:properties-changed` with the same `{ block_id, changed_keys }` payload local property commands emit, so the property-change dispatcher is untouched. See the `blocks:changed` and `block:properties-changed` registry rows above. **Scope decision (issue § Proposed shape point 3):** `blocks:changed` is deliberately the general **"out-of-band local write"** signal — one signal, one consumer — not an MCP special case; any future local write path outside a page store's own optimistic flow (deep-link-driven mutations, automations) should funnel through it rather than mint a new event.
2. **`sync:complete` granularity is partially, not fully, resolved.** #1071 already threads `changed_page_ids` through `SyncEvent::Complete` so `useSyncEvents.ts` reloads only the touched page stores instead of every mounted store (see the registry row above) — this is more granular than #2461's description of "session-granular, can't reload selectively" suggests as still-open. The MCP-write gap from (1) is now closed by `blocks:changed`, which shares that same targeted-reload path. What remains genuinely unsettled: there is still no per-property or per-block reload channel — both `sync:complete` and `blocks:changed` are per-**page**.
3. **Delivery guarantees were unstated.** This section is that statement: fire-and-forget, no replay, reload-on-mount or an explicit backfill query as the only recovery mechanisms, and — per the registry above — several events (`sync:mdns_disabled`, `mcp:activity`) currently have no recovery mechanism at all.

## Apply-cursor semantics

`materialized_through_seq` (in `materializer_apply_cursor`) tracks **replay/remote apply progress, not local write progress** (#1248, revised by #2250/#2325). Since the apply-path collapse, both the live LOCAL command path and the REMOTE/boot-replay path run the *same* function, `apply_op_projected`, which applies the op to the SQL tables **and** the per-space `LoroEngine` inside one transaction. The only difference is the `advance_cursor` flag: REMOTE apply and boot replay pass `true` (cursor advance is atomic with the apply); the live LOCAL command path passes `false`.

Because local ops never advance the cursor, during a live session `op_log.seq` climbs while `materialized_through_seq` stays pinned at the prior-boot replay watermark. A clean boot is therefore **not** a crash-only tail replay: `replay_unmaterialized_ops` re-applies the *whole prior session's* local ops (`WHERE seq > cursor`). This is expected and safe because re-apply is idempotent (`INSERT OR IGNORE` + per-op-type idempotency guards), and it is what makes the boot replay a standing safety net — if a live engine apply was ever lost (e.g. a bug rolled back the engine but not the log, which the shared transaction is designed to prevent), the next boot re-converges it. The `heal_orphaned_apply_cursor` path evaluates routinely (not only after a crash) and is safe for the same idempotency reason.

Advancing the cursor on local writes (making boot replay a true crash-only tail replay) was considered and deliberately **not** done: keeping local ops out of the cursor costs one idempotent replay pass per boot and in exchange keeps the replay path exercised on every startup rather than only after crashes. #1257 (route local ops through engine-apply) is closed — that routing is exactly what `apply_op_projected` now does.
