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
| Lint / format | Biome (no ESLint / Prettier) |

**Rejected:** Electron (size), CodeMirror (cell model worse for outliner), Diesel (sync-only), ESLint+Prettier (Biome is one tool). See [`rejected.md`](rejected.md) for the full library-rejection catalogue.

## Everything is a block

One `blocks` table covers every entity. The `block_type` column discriminates:

| `block_type` | What it represents |
| --- | --- |
| `content` | Paragraph, heading, code block, list item — anything in a page body. |
| `page` | A page (also nestable; pages may contain pages). |
| `tag` | A tag (a first-class entity with its own page). |

Tree shape: `parent_id` + 1-based integer `position` among siblings. Batch-renumber on insert; **fractional indexing was rejected** (precision drift, lack of stable comparator across devices) — the SQL `position` stays an `i64`. Since PEND-80 Phase 3 the mergeable hierarchy lives in the Loro engine as a `LoroTree` (convergent moves, cycle-safety); the SQL `parent_id` / `position` columns are *derived* from it (`parent_id` = the tree parent's `block_id`, `position` = the node's `i64` sort key) and keep the same shape, so pagination cursors and the frontend's position arithmetic are unchanged. See [crdt-and-recovery.md](crdt-and-recovery.md) § CRDT convergence.

All inter-block references are ULID-keyed:

- `[[ULID]]` — page / block link
- `#[ULID]` — inline tag reference
- `((ULID))` — block reference (transclusion)

Renames never break references because the link is by ULID, resolved to a current title at render time.

## Tags & inheritance

A tag is a `blocks` row with `block_type = 'tag'`. Hierarchy is naming-convention: `projects/website` creates `projects` as a parent. Queries can include inherited descendants (`include_inherited`).

Inheritance is **materialized**, not a recursive CTE — `block_tag_inherited` is maintained incrementally by the materializer. This collapses cross-page tag-query latency from O(depth) to O(1) lookup. Tag-to-tag inheritance (chains across tags) will not ship — it complicates the model without enough payoff.

Inline tag references (`#[ULID]`) are tracked separately in `block_tag_refs` (UX-250 cache). They contribute to chip counts but do **not** participate in inheritance — the inline ref is a per-block usage, not a category membership.

## Pages

Pages may nest. Title sort order is a frontend preference (recent / alphabetical / created); the backend just returns the matching set. The `blocks.page_id` column denormalises the owning page (set by `create_block_in_tx`; rebuilt by `cache/page_id.rs`) so list queries can join on it directly instead of walking parent chains.

## Soft delete & trash

A block is soft-deleted via `deleted_at`. The Trash view lists root-only soft-deleted blocks; restore brings the whole subtree back. Hard purge cascades via foreign-key `ON DELETE CASCADE` across every dependent table (`block_properties`, `block_tags`, `block_links`, `block_tag_refs`, `page_link_cache`, …) — no enumerated DELETE list to maintain.

Soft-pointer columns (`block_properties.value_ref`) `CASCADE` on hard delete to keep the exactly-one-value-column CHECK valid.

## Concurrent edits

There is **one op-application path**, and that path always fans out into the per-space `LoroEngine` (`src-tauri/src/loro/`). Concurrent writes from peers converge deterministically; same op inputs produce identical state on every replica. The legacy three-way merge / `is_conflict` model is gone (PEND-09 cutover).

## Database

SQLite, WAL mode, FK on, `synchronous=NORMAL`, `busy_timeout=5000`, `wal_autocheckpoint=5000` pages, `journal_size_limit=52428800` (50 MB WAL cap), `cache_size=-65536` (64 MB), `mmap_size=268435456` (256 MB), `temp_store=MEMORY`. Set per-connection on both pools in `src-tauri/src/db/pool.rs`.

**Pool architecture:** type-safe `WritePool` (2 connections) + `ReadPool` (4 connections). The newtypes prevent accidentally reading through the write pool or vice versa. Cache rebuilds use the read pool until the final DELETE+INSERT batch, which acquires a write connection.

**Migrations:** `src-tauri/migrations/*.sql`, versioned SQL, auto-run on boot. `sqlx::query!` / `query_as!` macros validate every query at compile time; the offline cache is `.sqlx/` (committed; CI fails on stale via `sqlx-prepare-check`).

**Triggers:** an append-only enforcement trigger on `op_log` (with a sentinel bypass for compaction). The `block_type` enum is enforced at the SQL layer by the `block_type_valid` CHECK constraint on `blocks` (migration `0085_blocks_block_type_check.sql`, which replaced the original migration-0005 BEFORE INSERT/UPDATE triggers — a CHECK survives table rebuilds automatically). Cache tables are rebuilt by the materializer, not by triggers — kept simple to avoid Sql-side hidden state.

## Op log

Append-only. Composite primary key `(device_id, seq)` where `seq` is the device-local monotonic counter (`COALESCE(MAX(seq), 0) + 1 WHERE device_id = ?`). Per-device counters mean two peers can produce `seq = 5` independently without collision; renumbering would break the hash chain.

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
applyOp(op):
  BEGIN IMMEDIATE
    INSERT INTO op_log (...) VALUES (...)        -- the truth
    apply op to core tables (blocks, ...)        -- primary state
    advance materializer_apply_cursor             -- atomic with above
  COMMIT
  post-commit: dispatch to LoroEngine (per-space)
  post-commit: enqueue cache rebuild tasks (background)
```

Apply-and-advance share one transaction → crash never advances the cursor past the last applied seq.

### Queue architecture

- **Foreground queue**: small bounded channel (capacity 256). Used for synchronous-feeling user ops.
- **Background queue**: larger bounded channel (capacity 1024). Used for cache-rebuild fan-out, FTS reindex, agenda projection rebuild, attachment GC.
- **Dedup**: identical tasks within a flush window collapse via per-task-discriminant hash sets.
- **Panic isolation**: a panic in one task does not poison the queue; the next task drains.

### Retry semantics

Two-tier retry:

- **In-memory**: foreground retries once at ~100 ms; background retries up to twice at 150 ms → 300 ms.
- **Persistent**: foreground apply path **persists exhausted ops** into `materializer_retry_queue` (PEND-24 H1) and warns; background global rebuilds (`RebuildTagsCache`, `RebuildPagesCache`, …) also persist (PEND-03) using the `'__GLOBAL__'` sentinel for `block_id`. Drained on the next boot.

`Barrier` and `Panic` tasks never retry. Truly non-retryable tasks (full FTS rebuild, FTS optimize, attachment GC) are silently counted on failure.

### Materialized caches

Rebuilt by the materializer; never read-through:

| Cache | What it stores | Triggered by |
| --- | --- | --- |
| `block_links` | `[[ULID]]` (page-link) and `((ULID))` (block-ref) tokens parsed out of block content. `#[ULID]` inline tag refs are NOT here — they go to `block_tag_refs`. | `edit_block`, `create_block` (content scan) |
| `page_link_cache` | Page-level rollup `(source_page, target_page, edge_count)` | derived from `block_links` |
| `block_tag_refs` | Inline `#[ULID]` references (UX-250) | content scan, separate from explicit tag membership |
| `block_tag_inherited` | Materialized ancestor-tag inheritance | `add_tag` / `remove_tag` + tree moves |
| `tags_cache` | Per-tag aggregate (usage, descendant count) | tag-touching ops |
| `pages_cache` | Per-page aggregate | page-touching ops |
| `agenda_cache` | Per-date task index | due / scheduled / completed property writes |
| `projected_agenda_cache` | Future occurrences of repeating tasks | repeat-property writes |
| `fts_blocks` (FTS5 virtual table) | Tokenised block content for search | edit_block, materializer post-commit |

**Rebuild order is load-bearing.** `rebuild_page_ids` MUST run before `rebuild_agenda_cache` / `rebuild_projected_agenda_cache` (the date-by-page joins depend on the denormalised column). `rebuild_block_tag_refs_cache` runs before `rebuild_tags_cache`. The materializer's task graph enforces this.

### Crash recovery (boot)

Four steps, runs once per process (guarded by `AtomicBool`):

1. Delete `log_snapshots WHERE status = 'pending'` (incomplete snapshot writes from a previous crash).
2. **Replay unmaterialized ops** (C-2b): walk `op_log WHERE seq > materializer_apply_cursor.materialized_through_seq`; enqueue each through the foreground queue; drain via Barrier.
3. **Reconcile drafts**: walk `block_drafts`; emit a synthetic `edit_block` or `create_block` op iff no matching newer op exists in `op_log` after the draft's `updated_at`.
4. Delete all draft rows.

Followed by an explicit cache rebuild for any blocks resurrected by step 3.

Per-draft errors are captured in a `RecoveryReport`; a single corrupt draft does not block boot.

## Apply-cursor atomicity

The boot-replay correctness rule. `materializer_apply_cursor` tracks `materialized_through_seq`. Apply + advance are one transaction → if the process crashes between op log append and the cursor advance, the next boot's replay covers exactly the seq that wasn't materialised. Idempotent (re-application uses `INSERT OR IGNORE` and a per-op-type idempotency guard).
