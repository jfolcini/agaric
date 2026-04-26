# Architecture

Block-based local-first note-taking app inspired by Org-mode and Logseq. Journal-first workflow
with powerful tagging and emergent structure. No cloud — local WiFi sync only. Simpler than
Anytype, faster than Logseq.

**Platforms:** Linux desktop (primary), Android (validated via spike).

---

## Table of Contents

1. [Technology Stack](#1-technology-stack)
2. [Data Model](#2-data-model)
3. [Database](#3-database)
4. [Operation Log](#4-operation-log)
5. [Materializer (CQRS — hybrid model)](#5-materializer-cqrs--hybrid-model)
6. [Content Format & Serializer](#6-content-format--serializer)
7. [Editor Architecture](#7-editor-architecture)
8. [Frontend Architecture](#8-frontend-architecture)
9. [Search](#9-search)
10. [Merge & Conflict Resolution](#10-merge--conflict-resolution)
11. [Snapshots & Compaction](#11-snapshots--compaction)
12. [Crash Recovery](#12-crash-recovery)
13. [Type Safety & Bindings](#13-type-safety--bindings)
14. [Dev Tooling & CI](#14-dev-tooling--ci)
15. [Security](#15-security)
16. [Query System](#16-query-system)
17. [Android Platform](#17-android-platform)
18. [Sync & Networking](#18-sync--networking)
19. [Planned Features](#19-planned-features)
20. [Tauri Command API](#20-tauri-command-api)
21. [Rust Backend Modules](#21-rust-backend-modules)
22. [Scalability Characteristics](#22-scalability-characteristics)
23. [Lessons Learned & Established Patterns](#23-lessons-learned--established-patterns)

---

## 1. Technology Stack

| Layer              | Choice               | Why                                                                                                    |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------ |
| Desktop shell      | Tauri 2.0            | Lightweight native wrapper. Ships a WebView, not a bundled browser.                                    |
| Frontend           | React 19 + Vite      | Locked by TipTap and shadcn/ui ecosystem. Components accept `ref` as a regular prop (no `forwardRef`). |
| Editor             | TipTap (ProseMirror) | WYSIWYG inline nodes for token chips. See [Editor Architecture](#7-editor-architecture).               |
| UI library         | shadcn/ui + Tailwind | Copy-paste components, no lock-in. Noto Sans in font stack. `rtl:` variants for future i18n.           |
| Linting/formatting | Biome                | Replaces ESLint + Prettier. Non-negotiable from day one — retrofitting means a whole-repo reformat.    |
| Database           | SQLite via sqlx      | Async, compile-time query validation. WAL mode for concurrent readers.                                 |
| State management   | Zustand              | Lightweight stores with explicit state enums for boot and editor lifecycle.                            |
| Async runtime      | Tokio                | Powers the materializer queues and all async Tauri command handlers.                                   |
| DnD                | @dnd-kit             | Tree-aware drag-and-drop with depth projection for indent/reparent.                                    |
| Positioning        | @floating-ui/dom     | Popup/menu positioning with flip/shift. Replaced manual coordinate math.                               |

**Rejected alternatives:**

- **Electron:** Too heavy for a notes app.
- **Flutter/Capacitor:** Wrong ecosystem for TipTap + shadcn.
- **CodeMirror 6:** Source-visible editor model. ProseMirror inline nodes are the correct model for WYSIWYG token chips — CodeMirror's `atomicRanges` have known cursor boundary bugs.
- **ESLint + Prettier:** Biome is faster and ships as a single tool.
- **Diesel/rusqlite:** Diesel has too much boilerplate; rusqlite's sync API would require migration later. sqlx gives compile-time checks + async from day one.

### Rust Libraries

| Crate                      | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| sqlx 0.8 + sqlx-cli        | Async SQLite, compile-time query validation, migrations   |
| blake3                     | Op log hash chaining (content-addressable, deterministic) |
| diffy                      | Line-level three-way text merge for conflict resolution   |
| similar                    | Word-level diff for `compute_edit_diff` display           |
| zstd                       | Snapshot compression (level 3)                            |
| ciborium                   | CBOR serialisation for `log_snapshots.data`               |
| thiserror + tracing        | Error handling and structured logging                     |
| tracing-appender           | Daily-rolling log file output alongside stderr            |
| specta + tauri-specta      | Auto-generated TypeScript bindings from Rust types        |
| FxHashMap (rustc-hash)     | Fast hash maps on materializer hot paths                  |
| ulid + uuid                | ULID generation for all IDs; UUID v4 for device identity  |
| chrono                     | Timestamps (RFC 3339 with millisecond precision)          |
| regex                      | FTS query tokenization, import parsing, content matching  |
| mdns-sd                    | mDNS service discovery for local WiFi sync                |
| tokio-tungstenite + rustls | TLS WebSocket transport for sync                          |
| rcgen                      | Self-signed ECDSA P-256 certificate generation            |
| x509-parser                | Certificate CN verification for sync peer validation      |
| hkdf + sha2                | HKDF-SHA256 key derivation for pairing                    |
| chacha20poly1305           | AEAD encryption for pairing messages                      |
| qrcode                     | QR code SVG generation for pairing                        |

---

## 2. Data Model

### Central principle: everything is a block

Tags, pages, and content are all rows in the `blocks` table, distinguished by `block_type`. There
are no separate tags or pages tables. This unified model means tags and pages travel through the
op log identically to content blocks — same creation, deletion, properties, and metadata.

| `block_type` | `parent_id`       | `position`        | `content`                                          |
| ------------ | ----------------- | ----------------- | -------------------------------------------------- |
| `content`    | any block or null | integer (1-based) | Markdown text with `#[ULID]` and `[[ULID]]` tokens |
| `tag`        | always null       | always null       | canonical name (e.g. `work/meeting`)               |
| `page`       | any block or null | integer (1-based) | page title                                         |

### Block tree

Blocks form a tree via `parent_id`. `position` is a 1-based integer among siblings sharing the
same parent. On insert between positions N and N+1, siblings at position >= N+1 are incremented
as a batch of `move_block` ops. Sibling counts in a personal notes app are small enough that this
compaction is cheap.

**Rejected:** Fractional TEXT indexing — adds meaningful complexity (TEXT comparison correctness,
rebalance triggers, sync merge of rebalance batches) for no practical benefit at realistic sibling
counts.

### ID-based references

All inter-block references in content use ULIDs, never human names. Human names are resolved at
render time by TipTap decorations reading from `tags_cache` and `pages_cache`. This means:

- Renaming a tag or page propagates everywhere instantly — no content migration needed.
- `blocks.content` is always valid UTF-8 text with opaque tokens.

### Tags

Tag blocks are first-class blocks. Tag hierarchy is a naming convention (`#work/meeting`) with
prefix-aware `LIKE 'work/%'` search on `tags_cache.name`. `#work` and `#work/meeting` are
independent tag blocks — deleting one has no effect on the other.

Tag blocks may be tagged with other tag blocks (natural consequence of the unified model). This is
structural only: tagging `#work/meeting` with `#important` does not cause blocks tagged
`#work/meeting` to appear in an `#important` query.

**Tag-to-tag inheritance will not be implemented.** Prefix-aware LIKE search covers the tag
hierarchy use case (the Obsidian model). True tag hierarchy inheritance would require graph
traversal in the materializer hot path and fan-out on rename.

**Block-level tag inheritance** is supported via `include_inherited` flag on tag queries (F-15).
When enabled, a block matches a tag filter if any ancestor block has that tag. Implemented via
a precomputed `block_tag_inherited` table (migration 0021) maintained transactionally by the
materializer on 7 op types: CreateBlock, MoveBlock, AddTag, RemoveTag, DeleteBlock,
RestoreBlock, PurgeBlock. Shared `tag_inheritance.rs` module provides 7 helper functions.
Query path uses UNION of `block_tags` + `block_tag_inherited` instead of recursive CTE.
Old CTE preserved as `resolve_expr_cte()` for correctness verification (oracle test confirms
both paths produce identical results).

### Pages

Page blocks may have parents (nestable). The page browser lists all page blocks regardless of
depth. Sort order is a frontend preference (default: reverse ULID / creation time descending).

### Block links

`[[ULID]]` tokens in content are indexed in `block_links` by the materializer. This is a pure
read cache — safe to drop and rebuild at any time.

### Cascade delete and Trash

Deleting any block (`delete_block` op with `cascade: true`) sets `deleted_at` on that block and
all its descendants via a recursive CTE. A single op covers the entire subtree.

- **Trash view:** `WHERE deleted_at IS NOT NULL AND is_conflict = 0`.
- **Restore:** clears `deleted_at` on the target and descendants whose `deleted_at` matches the
  original timestamp. Independently deleted descendants are left soft-deleted.
- **Permanent delete:** `purge_block` physically removes the block and descendants. Triggered by
  explicit user action or automatically after 30 days in Trash.

  **Purge table cleanup inventory** (a complete purge must clean all of these):
  `block_tags`, `block_tag_inherited`, `block_properties` (both as target and as `value_ref`
  source), `block_links`, `agenda_cache`, `tags_cache`, `pages_cache`, `attachments`,
  `block_drafts`, `fts_blocks`, `page_aliases`, `projected_agenda_cache`, `blocks`
  (`conflict_source` nullification), `blocks` (final DELETE).
- Deleting a tag block does NOT cascade to content blocks that reference it. The materializer
  removes `block_tags` rows; `#[ULID]` tokens render as "deleted tag" decoration.

### Conflict copies

When `diffy::merge` produces a conflict, a new block is created as a copy of the conflicting
version: `is_conflict = 1`, `conflict_source = original_block_id`. The original retains the
common ancestor content. User sees both and chooses. On resolution: chosen content becomes a new
`edit_block` on the original, conflict copy is deleted.

---

## 3. Database

### Engine and access pattern

SQLite in WAL mode. Database file at `~/.local/share/com.agaric.app/notes.db`.

**Pool architecture:**

- **Write pool:** 2 connections (`max_connections(2)`) — SQLite WAL mode serialises writers at
  the engine level; the second connection allows a queued writer to wait behind the first
  without blocking the caller.
- **Read pool:** 4 concurrent readers with `PRAGMA query_only = ON` enforced at SQLite level.
  Type-safe `State<WritePool>` and `State<ReadPool>` newtypes prevent accidental writes on the
  read pool.

**Pragmas (every connection):**

- `PRAGMA foreign_keys = ON` — enforced on every connection, always.
- `PRAGMA journal_mode = WAL` — concurrent readers, single serialised writer.
- `PRAGMA synchronous = NORMAL` — balanced durability/performance.
- `PRAGMA busy_timeout = 5000` — 5-second wait before SQLITE_BUSY.

**Migrations:** Auto-run on pool init from `src-tauri/migrations/`. Versioned `.sql` files.

**Compile-time validation:** All static SQL uses `sqlx::query!` / `query_as!` / `query_scalar!`.
The `.sqlx/` offline cache (107 query files) is committed; CI fails if stale. Runtime queries
(`sqlx::query()` without macro) total ~73 across 11 production files: snapshot ops (21),
tag inheritance recursive CTEs (16), FTS5 dynamic queries (15), sync protocol (6), cache (6),
recovery (3), drafts (2), PRAGMAs (1), and misc (3 in soft_delete, peer_refs, merge).

### Schema

18 tables + 1 FTS5 virtual table, 29 indexes across 30 migrations.

**Core tables:**

```text
blocks              — id (ULID PK), block_type, content, parent_id, position,
                      deleted_at, is_conflict, conflict_source, conflict_type,
                      todo_state, priority, due_date, scheduled_date, page_id
block_tags          — (block_id, tag_id) composite PK
block_properties    — (block_id, key) composite PK, value_text/value_num/value_date/value_ref
block_links         — (source_id, target_id) composite PK — materializer-maintained cache
attachments         — id (ULID PK), block_id, mime_type, filename, size_bytes, fs_path
property_definitions — key PK, value_type (text/number/date/select/ref), options (JSON)
page_aliases        — (page_id, alias) composite PK — case-insensitive alternative names
block_tag_inherited — (block_id, tag_id, inherited_from) — materialized tag inheritance cache
```

**Op log tables:**

```text
op_log              — (device_id, seq) composite PK, parent_seqs (JSON), hash (blake3),
                      op_type, payload (JSON), created_at
block_drafts        — block_id PK, content, updated_at — mutable scratch space for autosave
log_snapshots       — id (ULID PK), status ('pending'|'complete'), up_to_hash, up_to_seqs,
                      data (zstd-compressed CBOR BLOB)
peer_refs           — peer_id PK, last_hash, last_sent_hash, synced_at, reset_count,
                      last_reset_at, cert_hash, device_name, last_address
```

**Performance caches:**

```text
tags_cache          — tag_id PK, name, usage_count, updated_at
pages_cache         — page_id PK, title, updated_at
agenda_cache        — (date, block_id) composite PK, source
fts_blocks          — FTS5 virtual table (block_id UNINDEXED, stripped), trigram tokenizer
```

**Indexes:** Covering indexes on `blocks(parent_id, deleted_at)`,
`blocks(block_type, deleted_at)`, `blocks(deleted_at, id)`, `block_tags(tag_id)`,
`block_links(target_id)`, `block_links(source_id)`, `block_properties(value_date)`,
`op_log(created_at)`, `agenda_cache(date)`, `attachments(block_id)`,
`op_log(json_extract(payload, '$.block_id'))`, `block_properties(key, block_id)`,
`block_properties(key, value_text)`, `block_properties(key, value_num)`,
`op_log(device_id, op_type)`, `blocks(todo_state)`, `blocks(due_date)`,
`blocks(scheduled_date)`, `blocks(page_id)`, `page_aliases(alias COLLATE NOCASE)`, `page_aliases(page_id)`,
`block_tag_inherited(tag_id)`, `block_tag_inherited(inherited_from, tag_id)`.

---

## 4. Operation Log

### Core invariant

The op log is **strictly append-only**. No mutations, no deletions (except compaction into
snapshots). `block_drafts` is the only mutable scratch space. Nothing else bypasses this
invariant.

### Composite primary key

```sql
PRIMARY KEY (device_id, seq)
```

- `device_id`: UUID v4, generated once on first app launch, stored in a config file outside the
  DB. Never changes, never regenerated.
- `seq`: Per-device monotonic sequence number. Computed as
  `COALESCE(MAX(seq), 0) + 1 WHERE device_id = local_id`, serialised by the single write
  connection.
- Received ops during sync are inserted with their original `(device_id, seq)` — no renumbering,
  no collision.

**Why composite PK:** A per-device `AUTOINCREMENT` collides when inserting ops from another
device. Renumbering received ops would break blake3 hash chains because `seq` is an input to the
hash.

### Hash chain

Every op is hashed with blake3:

```text
blake3(device_id || seq || parent_seqs_canonical || op_type || payload_canonical)
```

- `parent_seqs_canonical`: JSON array sorted by `[device_id, seq]` lexicographically.
- Output: 64-character lowercase hex string.
- ULIDs in payloads are normalised to uppercase Crockford base32 before hashing (determinism).
- Constant-time comparison for verification.

**Positional, not Merkle.** `parent_seqs_canonical` carries `(parent_device_id, parent_seq)`
*positions* — not parent *hashes*. A child op's hash therefore does **not** transitively depend on
its parents' content. The chain is a deterministic per-op fingerprint that protects ordering and
op-payload integrity, not a Merkle commitment over ancestor history. Within the single-user threat
model this is intentional (mTLS + TOFU pinning between user-owned devices, no adversarial peers per
AGENTS.md "Threat Model"), and tampering protection comes from the duplicate-hash check on the
composite `(device_id, seq)` PK rather than chain re-computation.

### Causal tracking

`parent_seqs` is a JSON array of `[device_id, seq]` pairs stored from Phase 1:

- **Linear (current):** null for genesis, single-entry array pointing to the previous local op.
- **DAG (sync):** merge ops carry multiple entries, one per causal parent at the merge point. No
  schema migration required — the column already accepts multi-entry arrays.

### Op types

12 op types with exhaustive `match` — no catch-all arms:

| Op type             | Trigger            | Key payload fields                                                |
| ------------------- | ------------------ | ----------------------------------------------------------------- |
| `create_block`      | Block creation     | block_id, block_type, parent_id, position, content                |
| `edit_block`        | Blur/flush         | block_id, to_text, prev_edit (causal link)                        |
| `delete_block`      | User delete        | block_id, cascade: true (always)                                  |
| `restore_block`     | Restore from Trash | block_id, deleted_at_ref                                          |
| `purge_block`       | Permanent delete   | block_id                                                          |
| `move_block`        | Indent/dedent/DnD  | block_id, new_parent_id, new_position                             |
| `add_tag`           | Apply tag          | block_id, tag_id                                                  |
| `remove_tag`        | Remove tag         | block_id, tag_id                                                  |
| `set_property`      | Set typed property | block_id, key, value_text/num/date/ref (exactly one non-null)     |
| `delete_property`   | Remove property    | block_id, key                                                     |
| `add_attachment`    | Attach file        | attachment_id, block_id, mime_type, filename, size_bytes, fs_path |
| `delete_attachment` | Remove attachment  | attachment_id                                                     |

**`edit_block.prev_edit`:** Pointer to the `(device_id, seq)` of the prior edit this one is based
on. Forms a per-block edit chain (DAG) embedded in the global op log, used for LCA computation
during three-way merge.

**`from_text` — rejected:** Storing previous content alongside `to_text` was rejected because:
(1) cross-flush Ctrl+Z is intentionally not supported; (2) the previous state is always
reconstructable from the prior op's `to_text` in the history panel; (3) it doubles storage for
every edit.

**`create_link` / `delete_link` — not op types:** `block_links` is a materializer-maintained read
cache derived from `[[ULID]]` tokens in content. Never written by ops directly.

### Draft lifecycle

- Every ~2s during active typing: `INSERT OR REPLACE` into `block_drafts`.
- On blur/flush: write `edit_block` op, delete the draft row.
- Drafts never participate in sync, undo, or compaction.
- Any surviving draft at boot is a crash recovery candidate (see
  [Crash Recovery](#12-crash-recovery)).

### Text ancestor reconstruction (LCA)

`diffy::merge(ancestor, ours, theirs)` requires the common ancestor text for concurrent edits.
The LCA algorithm walks `prev_edit` chains:

1. Collect all ancestors of op A by following `prev_edit` pointers → `ancestors_a` set.
2. Walk op B's chain — first node found in `ancestors_a` is the LCA.
3. `text_at(lca)` returns `to_text` for `edit_block` or `content` for `create_block`.
4. Complexity: O(chain depth) — trivially fast for realistic note-taking workloads.
5. Cycle detection: max 10,000 iterations.

---

## 5. Materializer (CQRS — hybrid model)

Local commands write ops to the log **and** apply them to core tables (`blocks`, `block_tags`,
`block_properties`) in a single transaction. The materializer handles two distinct jobs:

1. **Remote ops (foreground queue):** Ops received during sync arrive as raw `op_log` entries
   without going through the command layer. The materializer applies them to core tables via
   `ApplyOp`. Idempotent patterns (`INSERT OR IGNORE`) mean local ops that were already applied
   by commands are harmless no-ops.
2. **Cache maintenance (background queue):** Rebuilds derived caches (`tags_cache`,
   `pages_cache`, `agenda_cache`, `block_links`, `block_tag_inherited`, FTS5) asynchronously
   after both local and remote ops.

This is a pragmatic hybrid — not pure CQRS. The dual-write avoids race conditions (atomic
transaction), eliminates async latency on local edits, and lets the UI read core tables
immediately. The materializer never duplicates local writes because its idempotent SQL patterns
(`INSERT OR IGNORE`, `UPDATE ... WHERE`) make re-application a safe no-op.

### Queue architecture

- **Foreground queue** (capacity 256): Applies remote ops to core tables (`blocks`, `block_tags`,
  `block_properties`). Also handles `BatchApplyOps` for sync (transaction-wrapped for atomicity).
  Low latency for viewport responsiveness.
- **Background queue** (capacity 1024): Cache rebuilds, FTS indexing, maintenance. Stale-while-
  revalidate — never blocks the UI.

Both queues drain with automatic dedup: duplicate cache-rebuild tasks are coalesced. Backpressure
is silent drop (appropriate for caches that will rebuild on the next cycle). Panic isolation per
task via spawned sub-tasks.

**Retry behaviour:**

- **Foreground:** single retry after 100ms backoff for transient errors. Panics and barrier tasks
  are never retried. `fg_errors` only incremented if both attempts fail.
- **Background:** up to 2 retries with exponential backoff (150ms initial, doubled per attempt
  → 150ms, 300ms). Barrier tasks skip retry. Panics during retry stop the retry loop. Tuned up
  from 50/100ms to reduce retry churn on transient WAL lock contention; see
  `INITIAL_BACKOFF_MS` in `materializer/consumer.rs`.

**Read/write pool split:** `Materializer::with_read_pool(write_pool, read_pool)` separates read
and write paths for background tasks. Cache-rebuild functions read from the read pool and only
acquire the write connection for the final DELETE/INSERT transaction — reducing write-connection
hold time and eliminating starvation of foreground tasks. Foreground tasks always use the write
pool. The production call site passes both pools; test helpers use `Materializer::new()` which
falls back to single-pool mode.

**Dedup:** Hash-based dedup via `hash_id()` (64-bit hash). Four separate `HashSet<u64>` for
block-ID-keyed tasks (reindex links, FTS update/remove/reindex refs). Parameterless cache-rebuild
tasks deduplicated by enum discriminant. `ApplyOp` and barrier tasks are never deduplicated.

### Caches maintained

| Cache                           | Rebuild trigger                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `tags_cache`                    | create/delete/restore tag block, add/remove tag                                         |
| `pages_cache`                   | create/delete/restore/edit page block                                                   |
| `agenda_cache`                  | set/delete property (value_date), set due/scheduled date, add/remove tag (date pattern) |
| `block_links`                   | edit_block — regex parse `[[ULID]]`, diff against prior index                           |
| `block_tag_inherited`           | create/move/delete/restore/purge block, add/remove tag                                  |
| `page_id` (denormalized column) | create/move/delete/restore/purge block — nearest page ancestor                          |

Invalidation is **event-driven**, not TTL-based. Each command calls `dispatch_background()` which
enqueues the relevant cache-rebuild tasks. There are no staleness timestamp checks — caches are
rebuilt when the ops that affect them are processed.

**`tags_cache` rebuild query:** Uses `LEFT JOIN` from `blocks` to capture zero-usage tags (newly
created, never applied). A plain `GROUP BY block_tags.tag_id` would omit them.

**Cache strategy:** Event-driven invalidation. Commands enqueue cache-rebuild tasks via
`dispatch_background()` after writing ops. Caches are never rebuilt synchronously on the hot
path or at boot. Cold boot returns last computed values; the materializer rebuilds caches on
first dispatch after boot.

### FTS5 maintenance

The FTS5 index accumulates segment files. Without periodic maintenance, segment count grows and
search degrades.

- **Scheduled optimize:** After every `max(500, block_count / 10_000)` `edit_block` ops or
  every 60 minutes (whichever comes first): `INSERT INTO fts_blocks(fts_blocks) VALUES('optimize')`.
  The adaptive threshold prevents very large vaults from running optimize on every tiny edit
  burst while keeping small vaults responsive. Merges all segments into one b-tree.
- **Post-RESET:** One immediate `optimize` pass after full FTS rebuild from snapshot.
- **Rejected:** `optimize` after every op (too costly), `optimize` only on user request (invisible
  degradation).

### Queue monitoring

`StatusInfo` struct with atomic counters: `fg_processed`, `bg_processed`, `bg_deduped`,
`fts_edits_since_optimize`, queue high-water marks, error and panic counts. Exposed via
`get_status` command and polled by the StatusPanel UI every 5 seconds.

### Pagination

All list queries use cursor-based (keyset) pagination. No offset pagination anywhere. No "fetch
all and filter in Rust." Enforced from Phase 1. One intentional exception: `undo_page_op_inner`
uses `LIMIT 1 OFFSET N` for undo-depth navigation (not a list query).

---

## 6. Content Format & Serializer

### Storage format

`blocks.content` is a UTF-8 Markdown string with a locked inline mark set and two custom ULID
token extensions. The format is plain text — diffed directly by `diffy`, stored as-is in SQLite,
human-readable in any text tool.

```text
block_content  := (block_element | span)*
block_element  := heading | code_block | blockquote | table | ordered_list | horizontal_rule
heading        := '#'{1,6} ' ' span+              -- # H1 through ###### H6
code_block     := '```' language? '\n' text '\n' '```'
blockquote     := ('> ' span+ '\n')+               -- consecutive > lines
table          := header_row '\n' separator '\n' data_row+
header_row     := '|' (cell '|')+
separator      := '|' ('-'+  '|')+                 -- e.g. |---|---|
data_row       := '|' (cell '|')+
cell           := span*
ordered_list   := (digit+ '. ' span+ '\n')+         -- 1. item, 2. item
horizontal_rule:= '---'                              -- three hyphens on a line
span           := plain_text | bold | italic | code_span | strikethrough | highlight | tag_ref | block_link | block_ref | ext_link
bold           := '**' span+ '**'
italic         := '*' span+ '*'
code_span      := '`' plain_text '`'               -- no nesting inside code
strikethrough  := '~~' span+ '~~'
highlight      := '==' span+ '=='
tag_ref        := '#[' ULID ']'
block_link     := '[[' ULID ']]'
block_ref      := '((' ULID '))'
ext_link       := '[' text '](' url ')'
ULID           := [0-9A-Z]{26}                     -- Crockford base32, exactly 26 chars
```

**Constraints:**

- Every `\n` is a block split boundary (auto-split on blur), except inside fenced code blocks
  and headings, which remain single blocks.
- No `\n\n` paragraph breaks. The block tree is the structural separator.
- `code_span` content is plain text — marks and tokens inside backticks are not parsed.

**The inline mark set is locked.** Bold, italic, code, strikethrough, and highlight are the
supported marks. Adding any new mark (underline, etc.) requires extending the serializer, FTS5
stripping, export mapping, and a migration audit.

### Custom serializer

Standalone TypeScript module (`src/editor/markdown-serializer.ts`, ~1140 lines) with zero external
dependencies. Converts between ProseMirror document nodes and the storage format.

**Serialize (ProseMirror → Markdown):**

<!-- markdownlint-disable MD038 -->

| Node/mark             | Output                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `text`                | raw text (escape `*`, `` ` ``, `#[`, `[[` when literal)                                          |
| `bold` mark           | `**...**`                                                                                        |
| `italic` mark         | `*...*`                                                                                          |
| `code` mark           | `` `...` ``                                                                                      |
| `heading` node        | `# ` through `###### ` prefix (levels 1–6)                                                       |
| `codeBlock` node      | ` ``` language\n...\n``` `                                                                       |
| `tag_ref` node        | `#[{id}]`                                                                                        |
| `block_link` node     | `[[{id}]]`                                                                                       |
| `block_ref` node      | `(({id}))`                                                                                       |
| `link` mark           | `[text](url)`                                                                                    |
| `orderedList` node    | `1. item\n2. item\n...`                                                                          |
| `horizontalRule` node | `---`                                                                                            |
| `hardBreak`           | `\n` (triggers auto-split)                                                                       |
| `blockquote` node     | `> ` prefix per line. Nested content serialized recursively.                                     |
| `table` node          | Pipe-delimited rows: header row + `\|---\|` separator + data rows. Cells contain inline content. |
| unknown node          | stripped with warning                                                                            |

<!-- markdownlint-enable MD038 -->

**Parse (Markdown → ProseMirror):** Hand-rolled recursive descent parser. Regex for token ID only.
Mark stack with unclosed-mark revert (becomes plain text, never errors). Blockquotes detected by
<!-- markdownlint-disable-next-line MD038 -->
`> ` prefix on consecutive lines — content parsed recursively. Tables detected by consecutive
`|`-prefixed lines; `|---|` separator rows are consumed but not emitted as content nodes. Node
types: `BlockquoteNode`, `TableNode`, `TableRowNode`, `TableHeaderNode`, `TableCellNode`.

**Test suite:** 200+ unit tests, property-based tests (fast-check) for round-trip identity and
idempotence. Mark coalescing avoids ambiguous sequences like `*a****b****c*`.

**Why not `tiptap-markdown`:** Has known edge cases, doesn't support `#[ULID]` / `[[ULID]]`
tokens, uncertain maintenance. A scoped custom serializer is ~150 lines of core logic, fully
owned, trivially testable.

### FTS5 strip pass

Before inserting into the FTS5 index, the materializer strips Markdown syntax:

- Remove `**`, `*`, `` ` ``, `~~`, `==` delimiters.
- Replace `#[ULID]` → resolved tag name (enables tag-name search).
- Replace `[[ULID]]` → resolved page title.
- Replace `((ULID))` → resolved block content preview.

Original Markdown preserved in `blocks.content`.

### Integration with diffy

`blocks.content` is passed to `diffy::merge()` as-is. Markdown marks are ASCII characters; diffy
handles them at line granularity. ULID tokens (`#[ULID]` at 29 characters, `[[ULID]]` at 30) are
space-free strings treated as atomic units within a line. A merged result is always a valid
storage-format string.

---

## 7. Editor Architecture

### Single roving TipTap instance

There is exactly **one TipTap editor instance** at any time. It is mounted into a block's DOM slot
on focus and unmounted on blur. All non-focused blocks render as plain static `<div>` elements.

**Lifecycle:**

1. User clicks/arrows into a block → if another block was focused, flush its pending edits first
   (auto-mount flush). Mount TipTap, parse Markdown → `setContent`, focus editor.
2. User blurs → serialize ProseMirror → Markdown string. If changed, flush `edit_block` op.
   `clearHistory()`, unmount, render static div.

**Why one instance:** Mounting thousands of ProseMirror instances for a large page is prohibitively
expensive. The roving pattern gives full rich editing for the focused block with zero per-block
overhead elsewhere.

### TipTap extensions

| Extension                                  | Type                | Purpose                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TagRef                                     | inline node (atom)  | `#[ULID]` rendered as chip with resolved tag name                                                                                                                                                                                                                             |
| BlockLink                                  | inline node (atom)  | `[[ULID]]` rendered as chip with resolved page title                                                                                                                                                                                                                          |
| ExternalLink                               | mark extension      | `[text](url)` with autolink and paste detection                                                                                                                                                                                                                               |
| AtTagPicker                                | suggestion          | `@` triggers fuzzy search of `tags_cache` → inserts `tag_ref` node                                                                                                                                                                                                            |
| BlockLinkPicker                            | suggestion          | `[[` triggers fuzzy search of `pages_cache` → inserts `block_link` node, "Create new" option. Also `addInputRules()` with `/\[\[([^\]]+)\]\]$/` regex for inline `[[text]]` → page link conversion. `allowSpaces: true`.                                                      |
| BlockRefPicker                             | suggestion          | `(())` triggers block reference search → inserts `block_ref` node. `allowSpaces: true`.                                                                                                                                                                                       |
| PropertyPicker                             | suggestion          | Triggers property value selection for typed properties.                                                                                                                                                                                                                       |
| SlashCommand                               | suggestion          | `/` triggers 60+ commands: TODO, DOING, DONE, DATE, DUE, SCHEDULED, LINK, TAG, CODE, EFFORT (6 presets), ASSIGNEE (2 presets), LOCATION (4 presets), REPEAT (11 variants), REPEAT-END (5 variants), TEMPLATE, QUOTE, TABLE, QUERY, CALLOUT (5 types) + PRIORITY 1/2/3 + H1-H6 |
| CheckboxInputRule                          | input rule          | `- [ ]` / `- [x]` → TODO/DONE state                                                                                                                                                                                                                                           |
| CodeBlockLowlight                          | node                | Fenced code blocks with syntax highlighting                                                                                                                                                                                                                                   |
| Blockquote                                 | node                | `@tiptap/extension-blockquote`. `>` prefixed block content.                                                                                                                                                                                                                   |
| Table + TableRow + TableHeader + TableCell | node (4 extensions) | `@tiptap/extension-table` family. Pipe-delimited table editing (`resizable: false`).                                                                                                                                                                                          |

Pickers intercept keystrokes and open autocomplete popups. On selection, they insert the
appropriate inline node with ULID. The raw ULID is never visible to the user.

**Chip re-expansion:** Both `BlockLink` and `TagRef` register `addKeyboardShortcuts()` with a
Backspace handler. When the cursor is immediately after a chip node and the user presses
Backspace, the chip is replaced with its raw text (`[[title]]` or `@tag`) so the user can edit
the reference. This avoids the need to delete-and-retype when correcting a tag or link.

### Keyboard handling

`useBlockKeyboard` hook — pure handler function attached to the TipTap editor DOM:

| Key             | Condition                  | Action                                        |
| --------------- | -------------------------- | --------------------------------------------- |
| ArrowUp/Left    | cursor at position 0       | Flush, focus previous block (cursor to end)   |
| ArrowDown/Right | cursor at end              | Flush, focus next block (cursor to start)     |
| ArrowUp/Down    | suggestion popup visible   | Suppressed — popup handles navigation         |
| Enter           | suggestion popup visible   | Passed through to suggestion plugin           |
| Tab             | suggestion popup visible   | Selects highlighted suggestion item           |
| Escape          | suggestion popup visible   | Dismisses popup (keeps editor focused)        |
| Enter           | —                          | Save block and close editor                   |
| Backspace       | block empty                | Delete block, focus previous                  |
| Backspace       | cursor at start, non-empty | Merge with previous block                     |
| Tab             | —                          | Flush, indent (change parent)                 |
| Shift+Tab       | —                          | Flush, dedent                                 |
| Escape          | —                          | Cancel editing, discard changes               |
| Ctrl+Enter      | —                          | Cycle task state (TODO → DOING → DONE → none) |

**Suggestion popup passthrough:** The block keyboard handler's event listener uses capture phase
on `parentElement` to fire before ProseMirror. When a suggestion popup (`.suggestion-popup`) is
visible (detected via `isSuggestionPopupVisible()` using `checkVisibility()`), Enter/Tab/Escape/
Backspace/ArrowUp/ArrowDown are passed through to the Suggestion plugin instead of being
intercepted by block navigation logic.

**Re-entrancy guards:** `handleEnterSave` and `handleDeleteBlock` use ref-based flags
(`enterSaveInProgress`, `deleteInProgress`) with `.finally()` reset to prevent concurrent
mutations from fast key repeats. Error recovery on `createBelow` failure re-mounts the editor.

### Auto-split on blur

When the serialized Markdown string contains `\n`, the block is automatically decomposed:

1. First segment → `edit_block` on the current block (retains tags, properties).
2. Each subsequent segment → `create_block` below, in order (created clean).
3. `block_links` for all segments re-derived by the materializer.

Code blocks and headings with internal newlines are **not** split — they remain single blocks.

This is the primary "write prose freely, get structure on exit" mechanic.

**Cross-block paste** uses the same `splitOnNewlines` path — one block per line.

### Undo & redo

Two-tier model: TipTap handles within-session undo, the backend handles cross-flush page-level
undo/redo via operation reversal.

**Tier 1 — In-session (TipTap history):**

- Ctrl+Z/Ctrl+Y inside the active editor instance (native ProseMirror history).
- On mount of the next block: `clearHistory()` called, preventing undo from crossing block
  boundaries. On blur/flush: op written to op log.

**Tier 2 — Page-level (op reversal):**

- Ctrl+Z/Ctrl+Y when focus is outside contentEditable (intercepted by `useUndoShortcuts`).
- Backend computes the inverse of the Nth most recent op on the page via `reverse.rs`.
- Reverse op is appended to the op log as a new op (the log remains append-only).
- Per-page state tracked in `useUndoStore`: `undoDepth` (how many ops undone) and `redoStack`
  (`OpRef[]` for redo). Cleared on navigation or new user action.
- Optimistic UI updates with rollback on backend error.

**Operation reversal (`reverse.rs`):**

| Original op         | Reverse                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `create_block`      | `delete_block`                                                                                                               |
| `edit_block`        | `edit_block` with prior text (from op log)                                                                                   |
| `delete_block`      | `restore_block`                                                                                                              |
| `move_block`        | `move_block` to prior parent/position (from op log)                                                                          |
| `add_tag`           | `remove_tag`                                                                                                                 |
| `remove_tag`        | `add_tag`                                                                                                                    |
| `set_property`      | `set_property` with prior values, or `delete_property` if first set                                                          |
| `delete_property`   | `set_property` with prior values                                                                                             |
| `add_attachment`    | `delete_attachment`                                                                                                          |
| `restore_block`     | `delete_block`                                                                                                               |
| `purge_block`       | **non-reversible**                                                                                                           |
| `delete_attachment` | **conditionally reversible** — `add_attachment` with original metadata if the op exists in the log; non-reversible otherwise |

Prior-state lookups use the op log exclusively (not the materialised `blocks` table), ensuring
consistency even if the materializer lags. Helper functions (`find_prior_text`,
`find_prior_position`, `find_prior_property`) walk the op log by `(created_at DESC, seq DESC)`.

**Batch revert:** `revert_ops` accepts multiple `OpRef`s, validates all are reversible, sorts
newest-first, and applies all reverses in a single `IMMEDIATE` transaction.

**History views:** `HistoryPanel` shows per-block edit history. `HistoryView` shows the global
op log with multi-select, op-type filtering, and batch revert.

### Viewport rendering

Off-screen blocks render as height-preserving placeholder `<div>` elements. An
`IntersectionObserver` (200px rootMargin) manages the visible window. Since TipTap only mounts for
the focused block, there is zero per-block overhead for off-screen blocks.

### Zoom-in (focus mode)

BlockTree supports zooming into a block to show only it and its descendants. A breadcrumb trail
shows the ancestor path with clickable navigation. Home button exits zoom. State is ephemeral
(not persisted across page reloads).

### Block multi-selection

`useBlockStore` (global singleton) exposes `selectedBlockIds` (a `Set<string>`-like array) for multi-block selection
orthogonal to the roving editor. Selection actions take `visibleIds` from the per-page store since blocks live in per-page context. Selection gestures:

- **Ctrl+Click** on a block bullet toggles its selection state.
- **Shift+Click** selects the range from the last-selected block to the clicked block.
- **Ctrl+A** (when no editor is active) selects all visible blocks.

Editing a block (mounting TipTap) clears the selection — the two modes are mutually exclusive.

**Batch toolbar:** When `selectedBlockIds` is non-empty, a toolbar appears with batch actions:
delete selected blocks and set todo state (TODO/DOING/DONE) on all selected blocks.

### Recurrence

When a block with a `repeat` property (e.g. `daily`, `weekly`, `monthly`, `+Nd`, `+Nw`, `+Nm`)
transitions to DONE via `set_todo_state`, the backend automatically creates a sibling block with
the repeat rule copied and `due_date`/`scheduled_date` shifted forward by the interval. The
original block stays DONE. The `shift_date` function in `commands.rs` handles date arithmetic
with month-end clamping.

---

## 8. Frontend Architecture

### State management — Zustand stores

| Store                | Purpose                                             | Key state                                                                                                                                                                           |
| -------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useBootStore`       | App initialization state machine                    | booting → recovering → ready \| error                                                                                                                                               |
| `useBlockStore`      | Global focus/selection (singleton)                  | focusedBlockId, selectedBlockIds[], pendingFocusId, setFocused, toggleSelected, rangeSelect(id, visibleIds), selectAll(visibleIds), setSelected, clearSelected, consumePendingFocus |
| `PageBlockStore`     | Per-page block tree CRUD (per-instance via context) | blocks[], rootParentId, loading, load(), createBelow, edit, remove, splitBlock, reorder, moveToParent, indent, dedent, moveUp, moveDown                                             |
| `useNavigationStore` | Page routing and view state                         | currentView (View union: 13 views incl. templates, settings, graph, page-editor), pageStack[], selectedBlockId, navigateToPage, goBack, replacePage                                 |
| `useJournalStore`    | Journal mode and date selection                     | mode (daily/weekly/monthly/agenda), currentDate, scrollToDate, scrollToPanel (JournalPanel: due/references/done), navigateToDate, goToDateAndScroll, goToDateAndPanel               |
| `useResolveStore`    | Centralized ULID → title cache                      | cache Map, pagesList[], version counter, resolveTitle, resolveStatus                                                                                                                |
| `useUndoStore`       | Page-level undo/redo state                          | pages Map (per-page: undoDepth, redoStack OpRef[], redoGroupSizes). Op grouping via isWithinUndoGroup (200ms window). undo, redo, canRedo, onNewAction, clearPage                   |
| `useSyncStore`       | Peer-to-peer sync lifecycle                         | state (idle/discovering/pairing/syncing/error/offline), error, peers[], lastSyncedAt, opsReceived/opsSent                                                                           |

**Per-page block store pattern (R-18):** Each `<BlockTree>` gets its own `PageBlockStore` instance via `<PageBlockStoreProvider pageId={...}>`. The provider creates a store with `createPageBlockStore(pageId)`, registers it in the module-level `pageBlockRegistry` (Map<pageId, StoreApi>), and unregisters on unmount. Global hooks (`useSyncEvents`, `useUndoShortcuts`) use the registry to reload pages without provider context. The global `useBlockStore` holds only focus/selection state since only one block can be focused at a time across all pages. Per-page mutation actions that affect focus (e.g., `remove`) call into the global store — one-directional dependency.

`useResolveStore` is preloaded on boot (`preload()` fetches all pages and tags) and updated
incrementally on create/edit/delete. Both JournalPage and BlockTree consume from the same store —
no duplicate `listBlocks` calls.

### Component hierarchy

```text
App
├── BootGate                       — blocks UI during boot/recovery
├── Sidebar                        — Journal, Pages, Tags, Trash, History, Status, Conflicts nav
├── JournalPage                    — daily/weekly/monthly/agenda modes
│   ├── DailyView / WeeklyView / MonthlyView / AgendaView
│   ├── JournalCalendarDropdown    — floating calendar date picker
│   └── DaySection                 — per-day container with PageBlockStoreProvider
│       └── BlockTree              — recursive block renderer
│           ├── SortableBlock      — @dnd-kit wrapper
│           │   ├── BlockInlineControls — gutter buttons (expand, drag handle)
│           │   └── EditableBlock  — static div ↔ TipTap toggle
│           │       ├── StaticBlock    — rendered Markdown (links, tags, code blocks)
│           │       │   └── QueryResult — inline {{query ...}} with QueryResultList/QueryResultTable
│           │       ├── TipTap editor  — mounted on focus only
│           │       ├── BlockPropertyEditor — inline property editing
│           │       └── BlockContextMenu — right-click / long-press actions
│           └── AddBlockButton     — ghost "+" button at tree bottom
├── PageEditor                     — page title + block tree + detail panels
│   ├── PageHeader                 — title, undo/redo, kebab menu
│   │   ├── PageTitleEditor        — contentEditable page title
│   │   ├── PageAliasSection       — alias badges with add/remove
│   │   ├── PageTagSection         — page-level tag management
│   │   └── PageHeaderMenu         — kebab menu (template, export, delete)
│   └── BlockTree                  — same recursive renderer
├── PageBrowser                    — all pages list (tree view)
│   └── PageTreeItem               — recursive tree node
├── TagList                        — all tags list
├── TemplatesView                  — template pages browser
├── TrashView                      — soft-deleted blocks
├── SearchPanel                    — FTS5 full-text search
│   └── HighlightMatch             — memoized regex-safe text highlighting
├── HistoryView                    — global op log with multi-select batch revert
│   ├── HistoryFilterBar           — op type filter dropdown
│   ├── HistoryListItem            — individual op entry with badge
│   └── HistorySelectionToolbar    — batch selection toolbar
├── StatusPanel                    — materializer queue metrics
├── ConflictList                   — pending conflict copies
│   ├── ConflictBatchToolbar       — select/deselect all toolbar
│   ├── ConflictListItem           — single conflict card
│   └── ConflictTypeRenderer       — type-specific conflict renderer
├── PropertiesView                 — system-wide property definitions
│   ├── PropertyDefinitionsList    — CRUD with search
│   ├── TaskStatesSection          — task state cycle editor
│   └── DeadlineWarningSection     — deadline warning days setting
├── DeviceManagement               — device identity and peer management
│   └── PeerListItem               — peer card with sync/rename/unpair
├── PairingDialog                  — passphrase/QR pairing flow
│   ├── PairingQrDisplay           — QR code + passphrase + countdown
│   ├── PairingEntryForm           — passphrase entry form
│   ├── PairingPeersList           — paired peers list
│   └── QrScanner                  — camera-based QR code scanning
├── EmptyState                     — placeholder for empty views
└── Panels (contextual)
    ├── BacklinksPanel             — blocks linking to current block (filtered)
    │   ├── BacklinkFilterBuilder  — composable filter expression UI
    │   │   ├── FilterPillRow      — active filter pills with remove
    │   │   └── FilterSortControls — sort field/direction controls
    │   └── BacklinkGroupRenderer  — collapsible backlink group
    ├── LinkedReferences           — grouped backlinks panel
    ├── UnlinkedReferences         — plain-text mentions panel
    ├── DuePanel                   — overdue + upcoming deadline blocks
    │   ├── OverdueSection         — overdue blocks with count badge
    │   ├── UpcomingSection        — upcoming deadline blocks
    │   └── DuePanelFilters        — source filter pills + toggle
    ├── HistoryPanel               — per-block edit chain from op log
    ├── BlockPropertyDrawer        — typed key-value properties
    ├── TagPanel                   — apply/remove tags
    ├── TagFilterPanel             — AND/OR tag query builder
    ├── FormattingToolbar          — bold/italic/code/link/undo/redo
    ├── LinkEditPopover            — inline link creation/editing
    └── KeyboardShortcuts          — help panel
```

### Journal view

Four modes, each rendering day sections with their own BlockTree:

| Mode    | Layout                                                        |
| ------- | ------------------------------------------------------------- |
| Daily   | Single day, prev/next navigation, Today button                |
| Weekly  | Mon–Sun grid, each day as a section                           |
| Monthly | Stacked day sections with calendar grid header (content dots) |
| Agenda  | TODO/DOING/DONE panels, paginated, collapsible                |

Features: floating date picker (react-day-picker), keyboard shortcuts (Alt+Left/Right for
prev/next, Alt+T for today), scroll-to-date support.

**Auto-create today's journal:** In daily mode, when the current date is today and no page exists,
JournalPage auto-creates a page block. If a journal template is configured (a page with
`journal-template=true` property), its children are copied as the initial structure.

**Templates:** Pages marked with `template=true` property serve as templates. The `/template`
slash command opens a picker to select and insert a template's block subtree. `template-utils.ts`
provides `loadTemplatePages()`, `loadJournalTemplate()`, and `insertTemplateBlocks()`.

**Page aliases:** Pages can have multiple alternative names via the `page_aliases` table.
`resolve_page_by_alias` enables case-insensitive lookup by any alias. PageHeader UI shows alias
badges with add/remove.

**Unlinked references:** `UnlinkedReferences` component shows blocks that mention a page's title
as plain text without an explicit `[[ULID]]` link. Grouped by source page with a "Link it" button
to convert mentions into proper block links. Cursor-paginated.

**DonePanel:** Shows blocks completed on a given date by querying `completed_at` property. Grouped
by source page, cursor-paginated, rendered alongside the agenda in daily view.

**Export:** `export_page_markdown` command produces a Markdown file with resolved `#[ULID]` → tag
names, `[[ULID]]` → page titles, and YAML frontmatter for page properties.

### View transitions and scroll restoration

View switches use a CSS opacity fade (150ms ease-out) implemented via a keyed wrapper `div`
in `App.tsx`. When `viewKey` changes, `fadeVisible` is set to `false` synchronously during
render, then restored to `true` via `requestAnimationFrame` — this produces a clean fade-in
without a flash. The `prefers-reduced-motion` media query in `index.css` automatically
disables the transition for users who prefer reduced motion.

Scroll positions are saved per-view by the `useScrollRestore` hook. It attaches a passive
`scroll` listener to the main content container, stores positions in a `Map<viewKey, number>`,
and restores via `rAF` on view change. Position `0` is used for first-visit views.

### CSS utility classes

`index.css` provides shared Tailwind `@utility` classes:

- `focus-ring` — `ring-2 ring-ring ring-offset-1` on `:focus-visible`
- `focus-outline` — `outline-2 outline-ring` on `:focus-visible`
- `touch-target` — `min-height: 44px` on `@media (pointer: coarse)`

Semantic color tokens (`--status-done`, `--status-pending`, `--priority-urgent`, etc.) are
defined in the `@theme inline` block with oklch values for both light and dark themes. All
status/priority colors use these tokens — no hardcoded Tailwind colors for semantic meanings.

### Drag and drop

@dnd-kit with tree-aware projection:

- Horizontal drag offset determines indent level (depth projection).
- Drop indicator shows target position and depth.
- `SortableBlock` wraps `EditableBlock` with `useSortable()`.
- On drop: `moveToParent(blockId, newParentId, newPosition)` via Tauri command.

### Tauri command wrappers

`src/lib/tauri.ts` provides 79 type-safe wrappers over auto-generated `bindings.ts`. Handles
Tauri 2's requirement for explicit `null` (not `undefined`) on `Option<T>` parameters.

### Extracted hooks (53 in src/hooks/)

BlockTree's concerns are decomposed into focused hooks. Additional hooks extracted from
component decompositions provide reusable logic across multiple views.

| Hook                            | Purpose                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `useBlockDnD`                   | DnD state, handlers, and tree-aware depth projection                         |
| `useBlockResolve`               | ULID → title resolution, tag/page search, page creation                      |
| `useBlockProperties`            | Property state, TODO/priority cycling                                        |
| `useBlockTags`                  | Load/add/remove/create tags for a block                                      |
| `useBlockKeyboardHandlers`      | Block-level keyboard handling (Enter, Backspace, Tab, arrow keys, shortcuts) |
| `useBlockSlashCommands`         | Slash command registration and execution                                     |
| `useBlockDatePicker`            | Date picker state for due/scheduled dates                                    |
| `useBlockMultiSelect`           | Multi-block selection gestures (Ctrl+Click, Shift+Click, Ctrl+A)             |
| `useBlockTouchLongPress`        | Touch long-press for mobile block context menu                               |
| `useBlockAttachments`           | Attachment CRUD for a block                                                  |
| `useBlockNavigation`            | Block click + keyboard navigation (shared across panels)                     |
| `useBlockCollapse`              | Block tree collapse/expand state persistence                                 |
| `useBlockZoom`                  | Focus-mode zoom into a block subtree                                         |
| `useBlockSwipeActions`          | Swipe gestures for mobile block actions                                      |
| `useBlockTreeKeyboardShortcuts` | 7 keyboard shortcuts extracted from BlockTree                                |
| `useBlockTreeEventListeners`    | 8 block event listeners extracted from BlockTree                             |
| `useRovingEditor`               | TipTap instance management (mount/unmount/serialize)                         |
| `useUndoShortcuts`              | Global Ctrl+Z / Ctrl+Y (outside editor contentEditable)                      |
| `useViewportObserver`           | IntersectionObserver for off-screen block placeholders                       |
| `useScrollRestore`              | Save/restore scroll position per view (passive listener, rAF restore)        |
| `useIsMobile`                   | Responsive breakpoint detection for mobile layout (\<768px)                  |
| `usePaginatedQuery`             | Cursor-based pagination with stale response detection and auto-refetch       |
| `usePollingQuery`               | Fixed-interval polling with optional refetch-on-focus                        |
| `useDebouncedCallback`          | Generic debounce hook replacing manual `useRef<timeout>` patterns            |
| `useListKeyboardNavigation`     | Arrow/vim key navigation for lists (wrap/clamp modes, Home/End)              |
| `useJournalAutoCreate`          | Auto-create today's journal page on mount                                    |
| `usePageDelete`                 | Page deletion with confirmation state                                        |
| `useAgendaPreferences`          | localStorage-persisted sort/group preferences                                |
| `useBacklinkResolution`         | TTL cache for ULID/tag resolution, batch resolve                             |
| `useSyncWithTimeout`            | Promise.race timeout pattern with cancelSync                                 |
| `useBatchCounts`                | Batch agenda count fetching (per-date, per-source)                           |
| `useHistoryDiffToggle`          | Expanded keys + diff cache + loading state for history views                 |
| `useDuePanelData`               | DuePanel data fetching (3 queries, 12 state variables, pagination)           |
| `useDraftAutosave`              | Draft content autosave with version counter race condition guard             |
| `useDateInput`                  | Date input parsing → preview → blur-save pattern                             |
| `usePropertySave`               | Property save/delete with toast + logging                                    |
| `useQueryExecution`             | Query dispatching, pagination, page title resolution                         |
| `useQuerySorting`               | Sort state + compareValues for query results                                 |
| `useWeekStart`                  | Configurable week start day (localStorage-persisted)                         |
| `useAutoScrollOnDrag`           | Auto-scroll during DnD operations                                            |
| `useItemCount`                  | Item count tracking for list views                                           |
| `useTheme`                      | Theme cycling (auto/dark/light)                                              |

Sync hooks (`useSyncTrigger`, `useSyncEvents`, `useOnlineStatus`) are documented in
[§18 Frontend sync integration](#18-sync--networking).

`usePaginatedQuery` and `usePollingQuery` replace per-component boilerplate across
PageBrowser, TrashView, ConflictList, BacklinksPanel, HistoryView, StatusPanel, and
`useHasConflicts`. The caller stabilises `queryFn` with `useCallback`; when its identity
changes the hook re-fetches page 1 (paginated) or restarts polling.

### Component inventory (120+ domain + 29 shadcn/ui + 1 editor = 150+ total)

**Page-level**: PageEditor, PageHeader (with PageTitleEditor, PageAliasSection, PageTagSection, PageHeaderMenu), PageBrowser (with PageTreeItem), JournalPage, SearchPanel (with SearchablePopover), TagList, TagFilterPanel, TrashView, ConflictList, HistoryView, StatusPanel, PropertiesView (with PropertyDefinitionsList, TaskStatesSection, DeadlineWarningSection), TemplatesView, GraphView

**Journal views**: journal/DailyView, journal/WeeklyView, journal/MonthlyView, journal/AgendaView, journal/DaySection, journal/JournalCalendarDropdown

**Block rendering**: BlockTree, SortableBlock (with BlockInlineControls), EditableBlock (with BlockPropertyEditor), StaticBlock, FormattingToolbar, block-tree/BlockContextMenu, block-tree/BlockDatePicker, block-tree/BlockDndOverlay, BatchActionToolbar, AddBlockButton, BlockListItem

**References**: LinkedReferences (with BacklinkGroupRenderer), UnlinkedReferences, BacklinkFilterBuilder (with FilterPillRow, FilterSortControls), SourcePageFilter, LinkEditPopover, QueryResult (with QueryResultList, QueryResultTable)

**Properties**: PagePropertyTable (with PropertyRowEditor), BlockPropertyDrawer, PropertyChip, PropertyValuePicker (with ChoiceValuePicker), AddPropertyPopover, BuiltinDateFields, DiffDisplay, DependencyIndicator

**Agenda**: AgendaResults, AgendaFilterBuilder (with AgendaSortGroupControls), DonePanel, DuePanel (with OverdueSection, UpcomingSection, DuePanelFilters)

**History**: HistoryPanel, HistorySheet, HistoryView (with HistoryFilterBar, HistoryListItem, HistorySelectionToolbar)

**Conflicts**: ConflictList (with ConflictBatchToolbar, ConflictListItem, ConflictTypeRenderer)

**Sync**: DeviceManagement (with PeerListItem), PairingDialog (with PairingQrDisplay, PairingEntryForm, PairingPeersList), QrScanner, UnpairConfirmDialog

**Shell/UI**: BootGate, ErrorBoundary, FeatureErrorBoundary, KeyboardShortcuts, KeyboardSettingsTab, RenameDialog, EmptyState, ConfirmDialog, LoadMoreButton, LoadingSkeleton, ListViewState, CollapsiblePanelHeader, CollapsibleGroupList, ResultCard, PageLink, HighlightMatch, PdfViewerDialog, AttachmentList, AlertSection, BlockGutterControls, RichContentRenderer, AttachmentRenderer, ImageResizeToolbar, TemplatePicker, MermaidDiagram, QueryBuilderModal, MonthlyDayCell, CodeLanguageSelector, HeadingLevelSelector

**Editor**: SuggestionList

**shadcn/ui (29)**: alert-dialog, alert-list-item, badge, button, calendar, card, card-button, chevron-toggle, close-button, dialog, filter-pill, input, label, list-item, popover, popover-menu-item, priority-badge, scroll-area, section-title, select, separator, sheet, sidebar, skeleton, sonner, spinner, status-badge, status-icon, tooltip

### Utility modules (src/lib/ — 37 modules)

- `tauri.ts` — Hand-written wrappers with object-style APIs for all 74 commands
- `bindings.ts` — Auto-generated from Rust types via specta
- `tauri-mock.ts` — In-memory backend mock (activates when Tauri absent)
- `tree-utils.ts` — Flat tree manipulation (depth, descendants, DnD projection)
- `announcer.ts` — Screen reader announcements (aria-live)
- `format.ts` — Formatting utilities
- `format-relative-time.ts` — Relative time formatting (e.g. "2 min ago")
- `parse-date.ts` — Date parsing helpers
- `date-utils.ts` — Date formatting/range helpers (formatCompactDate, getDateRangeForFilter, getTodayString)
- `open-url.ts` — URL opening utilities
- `i18n.ts` — i18next setup with ~1,440 translation keys
- `utils.ts` — cn() classname utility (clsx + tailwind-merge)
- `agenda-sort.ts` — Agenda sorting/grouping (sortAgendaBlocks, groupByDate/priority/state)
- `agenda-filters.ts` — Pure `executeAgendaFilters()` function for client-side agenda filtering
- `export-graph.ts` — Export all pages as ZIP of markdown files
- `repeat-utils.ts` — Repeat/recurrence formatting (formatRepeatLabel)
- `template-utils.ts` — Journal template loading (loadJournalTemplate, insertTemplateBlocks)
- `block-events.ts` — BLOCK_EVENTS constant, dispatchBlockEvent(), onBlockEvent(), NavigateToPageFn type
- `block-utils.ts` — processCheckboxSyntax utility
- `date-property-colors.ts` — getSourceColor()/getSourceLabel() for agenda source color coding
- `page-tree.ts` — Pure buildPageTree() utility for page browser hierarchy
- `query-utils.ts` — Query parsing and filter utilities for inline query blocks
- `query-result-utils.ts` — resolveBlockDisplay(), handleBlockNavigation() shared by query views
- `text-utils.ts` — truncateContent utility
- `history-utils.ts` — getPayloadPreview utility for op log display
- `property-utils.ts` — formatPropertyName(), BUILTIN_PROPERTY_ICONS map
- `property-save-utils.ts` — Property persistence helpers (NON_DELETABLE_PROPERTIES, buildInitParams)
- `priority-color.ts` — Shared priorityColor() utility for consistent priority styling
- `filter-dimension-metadata.ts` — Metadata for agenda filter dimensions
- `recent-pages.ts` — Recently visited pages tracking
- `file-utils.ts` — guessMimeType() + extractFileInfo() for file attachments
- `attachment-utils.ts` — getAssetUrl(), formatSize() for attachment display
- `toolbar-config.ts` — Toolbar button config arrays + factory functions
- `keyboard-config.ts` — 68 `DEFAULT_SHORTCUTS`, localStorage persistence, conflict detection
- `logger.ts` — Dual-write logging (console + Rust IPC), stack capture, rate limiting (5/min)
- `tag-colors.ts` — Tag color assignments
- `starred-pages.ts` — Starred pages tracking

---

## 9. Search

### FTS5 integration

SQLite FTS5 virtual table (`fts_blocks`) with `trigram` tokenizer (`case_sensitive 0`).

- **Index content:** Markdown-stripped text with tag names and page titles resolved from ULIDs.
- **Search command:** `search_blocks` with cursor-based pagination on `(rank, rowid)`.
  Supports optional `parent_id` filter (page scope) and `tag_ids` filter (ALL-semantics via
  COUNT(DISTINCT) subquery).
- **Query syntax:** `sanitize_fts_query()` uses a `QueryToken` enum + `tokenize_query()` state
  machine. Preserves `"quoted phrases"`, `NOT`/`OR`/`AND` operators. Injection prevention
  (NEAR/*/():). Tokens shorter than 3 characters are dropped (trigram minimum).
- **Ranking:** BM25 (FTS5 default).
- **UI:** `SearchPanel` with debounced input, paginated results.
- **CJK support:** Trigram tokenizer indexes every 3-character substring, enabling CJK search without a dedicated morphological analyzer. Queries shorter than 3 characters fall back to a linear scan (acceptable for personal app scale).

### Index size trade-off

Trigram indexes are ~3x larger than `unicode61` (each character position generates a trigram).
For a personal notes app with <100k blocks this is negligible — the index stays well under 50 MB.

---

## 10. Merge & Conflict Resolution

### Strategy

Three-way merge via `diffy` at **line-level** granularity. Not a CRDT library.

`diffy::merge` splits on `\n` boundaries. Because auto-split on blur turns each paragraph into
its own block, most blocks are single-line. Consequence: any concurrent edit to a single-line
block produces a conflict, even if the edits affect different words. This is an accepted trade-off
— the alternative (a CRDT) adds significant complexity for marginal benefit at local WiFi sync
frequency.

**Rejected:** `yrs` (Yjs port), `automerge-rs` — significant complexity not needed for local WiFi
sync. `similar` — no first-class three-way merge API. LWW for text — correctness debt.

### Text conflicts

1. Non-overlapping edits (multi-line blocks): `diffy::merge(ancestor, ours, theirs)` →
   `Ok(String)`. Written as new `edit_block` op. Invisible to user.
2. Overlapping edits (or any concurrent edit to a single-line block): `Err(MergeConflict)`.
   Original block retains ancestor content. Conflict copy created (`is_conflict = 1`). Both
   visible. User resolves by choosing.

### Property conflicts

Two `set_property` ops for the same `(block_id, key)` that are causally concurrent: **last-writer-
wins on `created_at`** with `device_id` as lexicographic tiebreaker. No block duplication.
Auto-resolutions logged to in-memory audit list visible in Status View.

### Ancestor text reconstruction

Per-block LCA algorithm following `prev_edit` chains (see [Operation Log](#4-operation-log)).
Complexity: O(chain depth). No graph library required.

---

## 11. Snapshots & Compaction

### Snapshot format

zstd-compressed CBOR encoding of all materialised table rows at the compaction point.

```text
SnapshotData {
  schema_version:     u32,
  snapshot_device_id: String,
  up_to_seqs:         { device_id: seq, ... },    // op frontier
  up_to_hash:         String,
  tables: {
    blocks, block_tags, block_properties, block_links, attachments
  }
}
```

Cache tables (`tags_cache`, `pages_cache`, `agenda_cache`, `block_tag_inherited`,
`projected_agenda_cache`, FTS5) are **not included** — they rebuild from core tables on first
materializer dispatch after a RESET. `apply_snapshot()` deletes all 6 cache tables before
restoring core data, ensuring no stale cache entries survive.

`property_definitions` and `page_aliases` are captured in snapshots (added with backward-compatible
`#[serde(default)]` fields at SCHEMA_VERSION 2). Restoring a snapshot preserves property type
metadata and page aliases.

**Snapshot-driven catch-up in sync (FEAT-6).** When a peer's op log has been compacted past the
remote's advertised frontier, the orchestrator now runs a snapshot exchange instead of terminating
the session. After the HeadExchange triggers `SyncState::ResetRequired`, the responder queries
`log_snapshots` for its most recent complete snapshot and sends `SnapshotOffer { size_bytes }`;
the initiator enforces a 256 MB size cap, sends `SnapshotAccept` or `SnapshotReject`, and on
accept receives the compressed blob in 5 MB binary frames (the same transport used for attachment
transfer). `apply_snapshot()` then wipes and restores the core tables atomically under
`BEGIN IMMEDIATE` + `defer_foreign_keys`, and `peer_refs.last_hash` advances to the snapshot's
`up_to_hash`. Post-snapshot delta catch-up is deferred to the next scheduled sync, which issues
a new HeadExchange from the restored frontier and retrieves any ops the responder wrote after the
snapshot was taken. The orchestrator's state machine is unchanged — the sub-flow is driven from
`sync_daemon/snapshot_transfer.rs`, consuming/producing the pre-existing `SnapshotOffer`,
`SnapshotAccept`, and `SnapshotReject` wire variants. If `log_snapshots` is empty on the
responder, the session closes without an offer (matching pre-FEAT-6 behavior).

**Rejected:** SQLite backup API dump (large, version-coupled), full op replay from op 1 (correct
but slow), JSON instead of CBOR (2–5x larger).

### Crash-safe write sequence

1. `INSERT INTO log_snapshots ... status = 'pending'` — committed before expensive work.
2. Compress + encode → write to `data` column.
3. `UPDATE ... SET status = 'complete'` — only reached if step 2 succeeds.

A `'pending'` row at boot means the process crashed mid-write. Its data may be incomplete — delete
it (boot cleanup). The full op log is available for replay.

### 90-day compaction

`compact_op_log()` creates a snapshot of current state and purges ops older than the retention
window (configurable, default 90 days). Frontier computed as max seq per device + latest hash.
Purged blocks are absent from subsequent snapshots.

---

## 12. Crash Recovery

Boot recovery runs **before** the materializer is created, before any user-visible UI.

**Sequence:**

1. Delete `log_snapshots` rows with `status = 'pending'` (incomplete snapshots).
2. Walk `block_drafts` table.
3. For each draft:
   - Check if an `edit_block` op exists for this `block_id` with `created_at > draft.updated_at`
     (strict comparator — relies on the millisecond-precision `Z`-suffix lex-monotonic invariant).
   - If none: draft was not flushed. Emit a synthetic `edit_block` op. Log a warning.
   - If found: draft was already flushed (no-op).
4. Delete all draft rows regardless.

Per-draft errors are captured in `RecoveryReport::draft_errors`. A single corrupt draft does not
block boot — processing continues with remaining drafts. Caches are rebuilt on first materializer
dispatch after boot (stale-while-revalidate handles it).

---

## 13. Type Safety & Bindings

### specta + tauri-specta

All 80 Tauri commands are annotated with `#[specta::specta]`. TypeScript bindings are auto-
generated to `src/lib/bindings.ts`. A pre-commit test (`ts_bindings_up_to_date`) fails if the
committed bindings diverge from the Rust types.

Regenerate after Rust type changes:

```bash
cd src-tauri && cargo test -- specta_tests --ignored
```

### Wrapper layer

`src/lib/tauri.ts` re-exports types from `bindings.ts` and provides hand-written wrappers with
object-style APIs. The wrapper layer handles Tauri 2's requirement for explicit `null` (not
`undefined`) on Rust `Option<T>` parameters.

### Compile-time SQL

All static SQL validated at compile time via `sqlx::query!` macros. `.sqlx/` offline cache ensures
CI doesn't need a live database. `cargo sqlx prepare --check` is a CI gate.

---

## 14. Dev Tooling & CI

### Testing layers

| Layer              | Tool                                 | Scope                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust unit tests    | cargo nextest                        | Inline `#[cfg(test)] mod tests` in every module (~2,130 tests)                                                                                                                                                                                       |
| Rust integration   | cargo nextest                        | Pipeline tests, API contract tests                                                                                                                                                                                                                   |
| Rust snapshots     | insta (25 YAML snapshots)            | Op payload serialization, command responses, backlink queries, pagination                                                                                                                                                                            |
| Frontend unit      | Vitest (jsdom)                       | Pure functions, store logic, hooks (~7,300 tests across 292 files)                                                                                                                                                                                   |
| Frontend component | Vitest + @testing-library/react      | Render, interaction, a11y (vitest-axe)                                                                                                                                                                                                               |
| Frontend property  | Vitest + fast-check                  | Markdown serializer fuzzing, round-trip stability                                                                                                                                                                                                    |
| Frontend typecheck | `vitest typecheck`                   | Compile-time type validation (enabled via `tsconfig.app.json`)                                                                                                                                                                                       |
| E2E                | Playwright (Chromium, 26 spec files) | Smoke, editor lifecycle, links, keyboard, Markdown syntax, slash commands, toolbar, tags, undo/redo, conflicts, history, error scenarios, sync UI, graph view, templates, properties, queries, import/export, features coverage, suggestion keyboard |
| Benchmarks         | Criterion (24 bench files)           | Agenda, aliases, attachments, backlinks, cache, commands, compaction, drafts, export, FTS, graph, hash, import, merge, move/reorder, op log, pagination, properties, property defs, snapshot, soft delete, sync, tag query, undo/redo (manual only)  |

### Pre-commit hooks (prek)

File-type-aware hooks — Rust hooks skip when no `.rs` files are staged, and vice versa:

- **Builtin:** trailing whitespace, EOF fixer, YAML/TOML/JSON validation, merge conflict detection, large file blocking
- **Frontend:** Biome check, TypeScript (`tsc --noEmit`), Vitest
- **Security:** npm audit, license-checker, depcheck
- **SQL:** sqruff (lint scoped to `src-tauri/migrations/*.sql`; SQLite dialect, layout + capitalisation rules; `sqlx` compile-time validation still covers inline `query!` macro strings)
- **Rust:** cargo fmt, cargo clippy, cargo nextest, cargo deny, cargo machete

### CI (GitHub Actions)

Single `check` job on Ubuntu 24.04: Biome → TypeScript → cargo fmt → cargo clippy → cargo nextest
(CI profile: 2 retries, 60s timeout) → Vitest → Playwright → sqlx offline cache check.

### Conventions

- **prek hooks are the verification.** Don't manually run the full suite before committing.
- **Minimum bar:** Every exported function gets happy-path + error-path tests. Components get
  render + interaction + `axe(container)` a11y tests.
- **Rust test isolation:** Each test gets its own `TempDir`. Must hold `_dir` handle to keep DB
  alive. Materializer settle: 50ms sleep after cache-rebuild ops.
- **Frontend mocking:** Global `invoke` mock in `test-setup.ts`. TipTap mocked in jsdom.
  `ResizeObserver`/`IntersectionObserver` polyfilled.

---

## 15. Security

### Encryption at rest

Filesystem-level only: Android FBE (File-Based Encryption), Linux LUKS / dm-crypt. No
application-level encryption.

**Rejected:** SQLCipher — key derivation complexity, passphrase UX, and platform keychain
integration for marginal benefit over filesystem encryption.

### Error sanitization

Database, IO, and JSON errors are replaced with generic "internal error" messages before reaching
the frontend. Original errors are logged server-side for debugging. The frontend receives
`{ kind: string, message: string }` and can match on `kind`.

### Secrets

No secrets or API keys in the codebase. No cloud services. Device UUID is the only persistent
identity, stored locally. Pre-commit hooks include `npm audit` and `cargo deny` for dependency
vulnerability scanning.

---

## 16. Query System

### Tag boolean queries

The tag query engine (`tag_query.rs`) evaluates composable boolean expressions over the tag graph:

```rust
pub enum TagExpr {
    Tag(String),           // blocks tagged with this tag_id
    Prefix(String),        // blocks tagged with any tag matching name prefix
    And(Vec<TagExpr>),     // intersection
    Or(Vec<TagExpr>),      // union
    Not(Box<TagExpr>),     // complement
}
```

**Evaluation strategy:** In-memory set operations. Each leaf resolves to a `FxHashSet<block_id>`
via SQL. AND = retain intersection. OR = extend union. NOT = complement against all non-deleted
blocks. Acceptable for <100k blocks (sub-millisecond). Future optimization: push NOT into SQL
CTEs.

**Prefix matching:** `LIKE 'name%'` on `tags_cache.name` with proper escape handling (`%`, `_`,
`\`). Single JOIN query — no N+1 per-tag.

**Frontend:** `TagFilterPanel` exposes AND/OR mode selection with tag_id and prefix inputs. The
`query_by_tags` command accepts `tag_ids[]`, `prefixes[]`, and `mode` (`"and"` / `"or"`).

### Property queries

`query_by_property(key, value_text)` filters blocks by property key with optional text value
matching. Keyset-paginated on `block_id ASC`. Excludes soft-deleted and conflict blocks.

`block_properties` supports four typed value columns — `value_text`, `value_num`, `value_date`,
`value_ref`. The query API supports text, numeric, and date filtering via `CompareOp` (Eq, Neq,
Lt, Gt, Lte, Gte). Reference filtering is a planned extension. Frontend parses operator syntax
(`property:key>value`) with relative date resolution via `parseDate`.

### Visual query builder

`QueryBuilderModal` provides a visual interface for constructing inline `{{query ...}}` blocks.
Three query types: tag (prefix input), property (key + operator + value), backlinks (target ULID).
Parses `initialExpression` via `parseQueryExpression()` for editing existing queries. Save calls
`editBlock()` to update block content and re-fetches results.

### Agenda filtering

`AgendaFilterBuilder` provides 5 filter dimensions: `status` (TODO/DOING/DONE), `priority`
(A/B/C), `dueDate` and `scheduledDate` (presets: Today, This week, Overdue, Next 7/14/30 days),
and `tag` (free-text search). The `agenda_cache` table indexes blocks by date for efficient
single-date and preset-range lookups.

### Backlinks

`get_backlinks(blockId)` returns blocks whose content contains `[[blockId]]` tokens. The
`block_links` table (materializer-maintained) is joined with `blocks` to produce paginated
results. Excludes soft-deleted and conflict blocks.

**Server-side compound filtering:** `query_backlinks_filtered` accepts a composable filter
expression tree (`BacklinkFilter` enum) pushed to SQL:

| Filter               | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `PropertyText`       | Text property comparison (Eq, Neq, Lt, Gt, Lte, Gte) |
| `PropertyNum`        | Numeric property comparison                          |
| `PropertyDate`       | Date property comparison                             |
| `PropertyIsSet`      | Property key exists                                  |
| `PropertyIsEmpty`    | Property key absent                                  |
| `HasTag`             | Block tagged with specific tag_id                    |
| `HasTagPrefix`       | Block tagged with any tag matching prefix            |
| `Contains`           | FTS5 full-text search within backlinks               |
| `CreatedInRange`     | ULID timestamp range (ISO 8601)                      |
| `BlockType`          | Filter by block_type                                 |
| `And` / `Or` / `Not` | Boolean composition                                  |

**Sorting:** `BacklinkSort` supports `Created`, `PropertyText`, `PropertyNum`, and `PropertyDate`
with ascending/descending direction. Default: `Created { Asc }`.

**Algorithm:** Resolve base backlink set → evaluate filter tree (each leaf → `FxHashSet<block_id>`
via SQL) → intersect → sort → keyset cursor pagination → fetch full `BlockRow` data. Response
includes `total_count` for UI display.

### Batch operations

Two commands avoid N+1 patterns in the frontend:

- `batch_resolve(ids[])` → `ResolvedBlock[]` — lightweight metadata (id, title, block_type,
  deleted) for rendering `[[ULID]]` and `#[ULID]` tokens in StaticBlock.
- `get_batch_properties(blockIds[])` → `HashMap<blockId, PropertyRow[]>` — all properties for
  multiple blocks in a single query using `json_each()`.

Both accept a `Vec<String>` of IDs and return validation errors on empty input.

### Inline query blocks

Blocks whose content matches `{{query type:<type> expr:<expression>}}` are rendered inline as
live query results instead of static text. Detected in `StaticBlock` rendering — the block's
content is stored as plain text in the op log (no special op type).

**Syntax:** `{{query type:tag expr:project}}`, `{{query type:property key:priority value:1}}`,
`{{query type:backlinks expr:<ULID>}}`. The `/query` slash command inserts the template.

**`QueryResult` component** (`src/components/QueryResult.tsx`):

- `parseQueryExpression()` extracts `type` and `expr`/`key`/`value` from the expression string.
- Fetches results via existing query APIs: `queryByTags` (tag queries), `queryByProperty`
  (property queries), `listBlocks` (backlinks queries).
- Collapsible result panel with todo state badges and source page breadcrumbs.
- Navigable — clicking a result block navigates to its parent page.

---

## 17. Android Platform

### Build and deployment

Android support via Tauri 2's mobile target. The generated Android project lives at
`src-tauri/gen/android/`. Same Rust backend, same React frontend — the WebView hosts the
identical UI.

**Build targets:**

- `x86_64` — emulator (AVD `spike_test`, API 34)
- `aarch64` — physical ARM64 devices

**DB path:** `/data/data/com.agaric.app/notes.db` (via `app.path().app_data_dir()`). Same
SQLite WAL mode, same pool configuration, same migrations.

**SDK requirements:** Min SDK 30 (Android 11, Sep 2020), Target SDK 36, NDK 27, Java/Kotlin target 17.

### Status

All IPC commands (read + write) confirmed working. Block creation, editing, and persistence
across restarts verified on emulator. Both debug and release APKs build, install, and run
correctly. Release APK is 24 MB (vs 402 MB debug) — ProGuard/R8 minification with verified keep
rules.

### Headless testing

AI agents and CI can interact with the Android app entirely via ADB — no display needed:

- `adb exec-out screencap -p` for screenshots
- `adb shell input tap/text/swipe` for interaction
- `adb logcat -s RustStdoutStderr:V` for Rust logs
- Chrome DevTools Protocol via `adb forward` for WebView inspection

---

## 18. Sync & Networking

Local WiFi sync between devices. No cloud. Discovery via mDNS, pairing via passphrase/QR code,
transport via TLS WebSocket, protocol via op streaming with three-way merge.

### Rust crates

| Crate             | Purpose                                                        |
| ----------------- | -------------------------------------------------------------- |
| mdns-sd           | mDNS service announcement and browsing (`_agaric._tcp.local.`) |
| tokio-tungstenite | Async WebSocket (server + client)                              |
| rustls + rcgen    | TLS with self-signed ECDSA P-256 certificates                  |
| hkdf + sha2       | HKDF-SHA256 session key derivation from passphrase             |
| chacha20poly1305  | ChaCha20-Poly1305 AEAD for pairing message encryption          |
| qrcode            | QR code SVG generation for pairing                             |

### Discovery

mDNS service type `_agaric._tcp.local.`. On announce: register service with TXT record
`device_id=<UUID>`. On browse: receive `ServiceResolved` events, extract peer addresses and port.

### Pairing

Per-session passphrase + QR code. Ephemeral — discarded after pairing or 5-minute timeout.

1. Host generates a 4-word EFF large wordlist passphrase (~51.7 bits entropy, 7,776-word list).
2. Host displays QR code (JSON: `{"passphrase":"...","host":"...","port":12345}`) and 4-word text.
3. Both sides derive a 32-byte session key via HKDF-SHA256:
   - Salt: sorted concatenation of local + remote device IDs (order-independent).
   - Info: `b"agaric-sync-v1"`.
4. Messages encrypted with ChaCha20-Poly1305: `[12-byte nonce][ciphertext + 16-byte tag]`.

**`PairingSession`** struct holds passphrase, derived key, and creation instant. `is_expired()`
checks the 5-minute timeout.

**Rejected:** Persistent shared passphrase (hard to rotate), SPAKE2 (correct but adds crypto
dependency for marginal gain at this threat model).

### Transport

Self-signed ECDSA P-256 certificates generated per device (`CN=agaric-{device_id}`,
SAN: localhost/127.0.0.1). `SyncServer` binds to a random port, accepts TLS+WebSocket connections.
`connect_to_peer()` establishes client connection with optional certificate pinning via a custom
`ServerCertVerifier` that computes SHA-256 of the peer's certificate.

`SyncConnection` abstracts over server/client streams with `send_json<T>`, `recv_json<T>`,
`send_binary`, `recv_binary`, and `peer_cert_hash()` methods.

**Security hardening:**

- **CN verification:** `PinningCertVerifier` validates that peer certificates have
  `CN=agaric-{device_id}` format via x509-parser. Non-matching CN is rejected.
- **Self-device guard:** Both mDNS discovery and `handle_incoming_sync()` reject sync attempts
  where `remote_id == local device_id`. Prevents self-sync loops.
- **Message size limits:** `MAX_MSG_SIZE = 10_000_000` enforced before deserialization to prevent
  DoS via oversized messages.
- **mDNS stale peer eviction:** Discovered peers carry `(DiscoveredPeer, Instant)` tuples;
  `retain()` evicts entries >5 minutes stale every 30-second resync interval.

### Protocol

`SyncOrchestrator` is a state machine (`SyncState` enum) that drives the sync flow:

```text
Idle → ExchangingHeads → StreamingOps → ApplyingOps → Merging → TransferringFiles → Complete
                                                                                  ↘ ResetRequired
                                                                                  ↘ Failed
```

**Messages** (`SyncMessage` enum in `sync_protocol/types.rs`): op-sync messages `HeadExchange`, `OpBatch`, `ResetRequired`, `SnapshotOffer`, `SnapshotAccept`, `SnapshotReject`, `SyncComplete`, `Error`; file-transfer messages `FileRequest`, `FileOffer`, `FileReceived`, `FileTransferComplete`.

**Flow:**

1. **Head exchange:** Each peer sends its latest `(device_id, seq, hash)` per known device.
2. **Compute divergence:** `compute_ops_to_send()` compares remote heads against local op log.
3. **Reset check:** If remote's last known op predates the oldest retained op (after compaction)
   and no snapshot covers it → `RESET_REQUIRED`. UI confirms before wiping.
4. **Op streaming:** Diverging ops sent as `OpBatch`. Receiver inserts with original
   `(device_id, seq)` via `INSERT OR IGNORE` (duplicate delivery is idempotent).
5. **Merge:** `merge_diverged_blocks()` handles four conflict types:

| Conflict              | Resolution                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Concurrent text edits | `diffy::merge` via `merge::merge_block`. Non-overlapping → clean merge. Overlapping → conflict copy. |
| Property conflicts    | LWW on `created_at` with `device_id` tiebreaker via `merge::resolve_property_conflict`.              |
| Move conflicts        | LWW on `created_at`. Block moved into deleted subtree → reparent to root.                            |
| Delete + edit         | Edit wins. Block resurrected via synthetic `restore_block` op before applying `edit_block`.          |

<!-- markdownlint-disable-next-line MD029 -->
6. **Complete:** `complete_sync()` updates `peer_refs` atomically.

### `peer_refs` maintenance

| Column           | Updated when                                 | Value                                                          |
| ---------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `last_hash`      | Successful sync                              | Hash of the last op *received* from this peer                  |
| `last_sent_hash` | Successful sync                              | Hash of the last op *sent* to this peer                        |
| `synced_at`      | Successful sync                              | Wall-clock timestamp, updated atomically with hashes           |
| `reset_count`    | RESET_REQUIRED completes                     | Incremented by 1                                               |
| `last_reset_at`  | RESET_REQUIRED completes                     | Current timestamp                                              |
| `last_address`   | Successful sync or manual `set_peer_address` | `host:port` string for direct connection when mDNS unavailable |

On sync failure (connection lost mid-stream): `peer_refs` is **not** updated. Next sync restarts
from `last_hash`. Duplicate delivery is safe due to `INSERT OR IGNORE` on the composite PK.

### SyncDaemon (auto-sync orchestrator)

`sync_daemon.rs` — long-lived background task spawned during `lib.rs` setup. Ties together all
sync building blocks into an always-on sync service.

**Lifecycle:**

1. Starts TLS WebSocket server on random port via `SyncServer::start()`
2. Announces device via mDNS (`MdnsService::announce()`)
3. Starts mDNS browse and enters main loop
4. Managed as Tauri state; shuts down cleanly on app exit

**Main loop** (`tokio::select!` with three branches):

- **mDNS discovery** (500ms poll): drains `browse_rx.try_recv()`, updates `HashMap<String, DiscoveredPeer>`, triggers immediate sync for newly discovered paired peers
- **Change-triggered sync**: `SyncScheduler::wait_for_debounced_change()` wakes the daemon when local ops are materialized (3s debounce window)
- **Periodic resync**: `SyncScheduler::peers_due_for_resync()` identifies stale peers (>60s since last sync)

When mDNS discovery does not find a peer, the daemon falls back to the `last_address` stored in
`peer_refs` for direct connection. After each successful sync, the daemon updates `last_address`
with the peer's current address.

**`try_sync_with_peer()`:** Runs a single initiator-side sync session:

1. Checks `SyncScheduler::may_retry()` (exponential backoff gate)
2. Acquires per-peer mutex via `try_lock_peer()` (prevents concurrent syncs)
3. Looks up `cert_hash` from `peer_refs` for TLS certificate pinning
4. Connects via `connect_to_peer(addr, cert_hash)`
5. Runs `SyncOrchestrator` message exchange loop
6. On success: `record_success()` (resets backoff), emits `SyncEvent::Complete`
7. On failure: `record_failure()` (doubles backoff 1s→60s max), emits `SyncEvent::Error`

### SyncScheduler

`sync_scheduler.rs` — manages per-peer backoff, debounced change notifications, and resync timing.

| Function                      | Purpose                                                                |
| ----------------------------- | ---------------------------------------------------------------------- |
| `try_lock_peer(id)`           | Per-peer mutex (RAII guard). Only one sync session per peer at a time. |
| `may_retry(id)`               | Returns false if peer is in backoff period                             |
| `record_failure(id)`          | Doubles backoff: 1s → 2s → 4s → ... → 60s max                          |
| `record_success(id)`          | Clears backoff entirely                                                |
| `notify_change()`             | Signals a local op was materialized                                    |
| `wait_for_debounced_change()` | Blocks until notifications stop for `debounce_window` (3s)             |
| `peers_due_for_resync(peers)` | Filters peers whose `synced_at` is older than `resync_interval` (60s)  |

### Tauri sync commands

Six commands registered in the invoke handler (`commands.rs` + `lib.rs`):

| Command            | Backend function           | Purpose                                                                                    |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------------------ |
| `start_pairing`    | `start_pairing_inner()`    | Generate passphrase + QR SVG, store `PairingSession` in managed state                      |
| `confirm_pairing`  | `confirm_pairing_inner()`  | Derive key from passphrase, upsert `peer_ref`, clear session                               |
| `cancel_pairing`   | `cancel_pairing_inner()`   | Clear pairing session                                                                      |
| `start_sync`       | `start_sync_inner()`       | Check backoff, acquire lock, notify daemon via `scheduler.notify_change()`                 |
| `cancel_sync`      | `cancel_sync_inner()`      | Set cancel flag (checked in sync message loop)                                             |
| `set_peer_address` | `set_peer_address_inner()` | Store a manual `host:port` address for a peer in `peer_refs.last_address` (migration 0017) |

Managed state: `PairingState(Mutex<Option<PairingSession>>)`, `Arc<SyncScheduler>`.
TypeScript bindings auto-generated via specta (`PairingInfo`, `SyncSessionInfo` types).

### Frontend sync integration

| Hook/Component      | Purpose                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useSyncTrigger`    | Recursive setTimeout with exponential backoff (60s→600s max). Syncs on mount (2s delay) + periodic. Checks `navigator.onLine` before attempting — sets `useSyncStore` to `'offline'` state when offline. Triggers immediate sync on `window.online` event. |
| `useSyncEvents`     | Listens to `sync:progress`, `sync:complete`, `sync:error` Tauri events. Updates `useSyncStore`. Shows toast on completion/failure. Checks for conflicts after sync.                                                                                        |
| `useOnlineStatus`   | `useSyncExternalStore` hook tracking `navigator.onLine` with event listeners.                                                                                                                                                                              |
| Sidebar Sync button | Shows `WifiOff` + "Offline" when offline. Tooltip: "Syncing..." during active sync.                                                                                                                                                                        |

### Batch sync performance

`apply_remote_ops()` wraps all inserts in a single explicit transaction (not N implicit
transactions). After commit, enqueues a single `MaterializeTask::BatchApplyOps(Vec<OpRecord>)`
instead of N individual `ApplyOp` messages. Foreground consumer iterates and `apply_op`s each
in sequence, preserving ordering.

### Duplicate tag dedup

On cache rebuild after sync, the materializer detects tag blocks with duplicate content
(case-insensitive). Keeps the lexicographically smallest ULID as canonical. Emits `edit_block`
ops to rewrite `#[loser-ULID]` tokens in all referencing blocks. Background reconciliation,
idempotent.

### Timeouts

WebSocket `RECV_TIMEOUT` is 30 seconds (`sync_net.rs`). The `handle_message` loop in
`sync_daemon.rs` wraps each message exchange in a 120-second `tokio::time::timeout` to prevent
indefinite hangs during large op transfers.

---

## 19. Planned Features

Planned items are tracked in the [issue tracker](https://github.com/jfolcini/agaric/issues).

**Recently completed** (formerly on this roadmap):

- Templates system with dynamic variables (#639) — `template-utils.ts`, `/template` slash command
- Scheduling semantics — overdue, hide-before, warning period (#641) — AgendaFilterBuilder presets
- Repeating tasks — `.+` and `++` modes, end conditions (`repeat-until`), projected agenda (#644)
- Block property UX — `BlockPropertyDrawer`, inline property editing (#645)
- Inline query blocks — `{{query ...}}` syntax, `QueryResult` component (#655)
- Logseq/Markdown import — `import_markdown` command, Logseq `.md` parser (#660)
- Table support — `@tiptap/extension-table` family, serializer pipe-delimited syntax
- Multi-selection + batch operations — `selectedBlockIds`, Ctrl+Click/Shift+Click, batch delete/todo
- Namespaced page tree — breadcrumb navigation in PageHeader for `a/b/c` page titles
- Custom task keywords — `set_todo_state` accepts arbitrary strings beyond TODO/DOING/DONE
- All 5 agenda filter dimensions — status, priority, due date, scheduled date, tag
- Page aliases — `page_aliases` table, case-insensitive lookup, PageHeader UI
- Point-in-time restore — `restore_page_to_op` command, recursive CTE for nested blocks
- Drag-and-drop file attachments — `EditableBlock` drop/paste handlers, MIME guesser
- Graph view — `list_page_links` + d3-force visualization, click-to-navigate
- Visual query builder — `QueryBuilderModal`, edit existing queries
- Monthly calendar grid — CSS Grid with `MonthlyDayCell`, configurable week start
- Keyboard shortcut customization — `keyboard-config.ts`, 40 shortcuts, conflict detection
- Op log compaction UI — `get_compaction_status` + `compact_op_log_cmd` commands
- Mermaid diagrams — lazy-loaded `MermaidDiagram` component for code blocks
- Search filter chips — page scope + tag filters on `search_blocks`
- Date-range operators for property queries — `CompareOp` with operator syntax parsing
- Task dependency indicator — `DependencyIndicator` with blocked_by warning
- Materialized tag inheritance — `block_tag_inherited` table, CTE-free query path
- Frontend error logging — `logger.ts` with Rust IPC bridge, global handlers
- Per-page block store — `PageBlockStore` context replacing global singleton

All completed features use existing schema, op types, and materializer infrastructure. No
architectural changes were required.

---

## 20. Tauri Command API

80+ total commands (including sync/pairing/file-transfer), split across `src-tauri/src/commands/` by domain: `blocks/` (crud + move + list + fetch), `pages.rs`, `tags.rs`, `properties.rs`, `agenda.rs`, `attachments.rs`, `history.rs`, `journal.rs`, `queries.rs`, `sync_cmds.rs`, `compaction.rs`, `drafts.rs`, `link_metadata.rs`, `logging.rs`. Each has an `inner_*` function taking `&SqlitePool` for testability. All use cursor-based pagination where applicable.

### Block Operations (9)

| Command         | Purpose                                                                         |
| --------------- | ------------------------------------------------------------------------------- |
| `create_block`  | Create block (content/tag/page). Max content: 256KB. Max depth: 20.             |
| `edit_block`    | Edit content. IMMEDIATE tx for TOCTOU safety. prev_edit for conflict detection. |
| `delete_block`  | Soft-delete + cascade descendants via recursive CTE.                            |
| `restore_block` | Un-delete with deleted_at_ref as optimistic concurrency guard.                  |
| `purge_block`   | Physical delete + all related rows. Non-reversible. Deferred FK checks.         |
| `move_block`    | Reparent. Cycle detection via ancestor-walking CTE. Depth validation.           |
| `list_blocks`   | Paginated list with exclusive filters (parent, type, tag, deleted, agenda).     |
| `get_block`     | Fetch single block including soft-deleted.                                      |
| `batch_resolve` | Batch metadata lookup via json_each(). Silent omit for missing.                 |

### Tag Operations (4)

| Command               | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `add_tag`             | Associate tag with block. Validates tag type and no duplicate. |
| `remove_tag`          | Dissociate tag.                                                |
| `list_tags_by_prefix` | Case-insensitive prefix search on tags_cache.                  |
| `list_tags_for_block` | Get all tag IDs for a block.                                   |

### Query Operations (9)

| Command                    | Purpose                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `search_blocks`            | FTS5 full-text search with cursor pagination.                               |
| `query_by_tags`            | Boolean tag query (AND/OR). TagExpr from IDs + prefixes.                    |
| `query_by_property`        | Filter blocks by property key/value.                                        |
| `query_backlinks_filtered` | Advanced backlink query with 17 filter types + sort.                        |
| `list_backlinks_grouped`   | Backlinks grouped by source page.                                           |
| `list_unlinked_references` | Blocks mentioning a page but not linked.                                    |
| `get_backlinks`            | Simple backlink list.                                                       |
| `list_projected_agenda`    | Compute virtual future occurrences for repeating tasks within a date range. |
| `list_undated_tasks`       | Paginated list of blocks with todo_state but no due_date or scheduled_date. |

### Property Operations (9)

| Command                       | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `set_property`                | Upsert property. Key format: alphanum + hyphens/underscores, 1-64 chars. |
| `delete_property`             | Remove property by key.                                                  |
| `get_properties`              | Fetch all properties for a block.                                        |
| `get_batch_properties`        | Batch fetch for multiple blocks via json_each().                         |
| `list_property_keys`          | List all distinct property keys in use.                                  |
| `create_property_def`         | Create schema definition (text/number/date/select).                      |
| `list_property_defs`          | List all property definitions.                                           |
| `update_property_def_options` | Update select-type options.                                              |
| `delete_property_def`         | Delete property definition.                                              |

### Fixed-Column Properties (4)

| Command              | Purpose                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set_todo_state`     | Set todo state (null/TODO/DOING/DONE/CANCELLED — locked cycle per UX-201a, reordered by UX-234). Recurrence support on done transition: creates sibling with shifted dates, sets `repeat-origin` ref to original block. |
| `set_priority`       | Set priority. Default levels are `'1' / '2' / '3'`; user-configurable via the `priority` property definition's `options` JSON (UX-201b). `null` clears the priority.                                                    |
| `set_due_date`       | Set due date (YYYY-MM-DD or null).                                                                                                                                                                                      |
| `set_scheduled_date` | Set scheduled date (YYYY-MM-DD or null).                                                                                                                                                                                |

### History & Undo/Redo (7)

| Command              | Purpose                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `get_block_history`  | List op_log entries for a block.                                                                                                         |
| `list_page_history`  | Ops affecting page + descendants. Optional op_type filter.                                                                               |
| `undo_page_op`       | Undo N-th most recent op. Computes reverse, appends, applies.                                                                            |
| `redo_page_op`       | Redo previously undone op.                                                                                                               |
| `revert_ops`         | Batch revert multiple ops.                                                                                                               |
| `compute_edit_diff`  | Word-level diff (word_diff.rs) for edit_block ops.                                                                                       |
| `restore_page_to_op` | Revert page to state at a given op. Recursive CTE for nested blocks, non-reversible ops skipped. Page-scoped + global (`__all__`) modes. |

### Sync & Pairing (5 + 6 peer management)

| Command            | Purpose                                                      |
| ------------------ | ------------------------------------------------------------ |
| `start_pairing`    | Generate passphrase + QR SVG, store session.                 |
| `confirm_pairing`  | Validate passphrase, store peer_ref + cert_hash.             |
| `cancel_pairing`   | Clear pairing session.                                       |
| `start_sync`       | Trigger sync via daemon. Checks backoff, acquires peer lock. |
| `cancel_sync`      | Set cancel flag (checked in message loop).                   |
| `get_device_id`    | Return persistent device UUID.                               |
| `list_peer_refs`   | List all paired peers.                                       |
| `get_peer_ref`     | Fetch single peer.                                           |
| `delete_peer_ref`  | Unpair a peer.                                               |
| `update_peer_name` | Set human-readable peer name.                                |
| `set_peer_address` | Set manual sync address for a peer.                          |

### Batch, Export & System (14)

| Command                        | Purpose                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `count_agenda_batch`           | Count agenda items per date (batch).                                          |
| `count_agenda_batch_by_source` | Count agenda items per date grouped by source (page/due/scheduled/property).  |
| `count_backlinks_batch`        | Count backlinks per page (batch).                                             |
| `set_page_aliases`             | Replace page's aliases.                                                       |
| `get_page_aliases`             | List aliases for a page.                                                      |
| `resolve_page_by_alias`        | Look up page by alias (case-insensitive).                                     |
| `export_page_markdown`         | Export as Markdown with resolved `#[ULID]` and `[[ULID]]` + YAML frontmatter. |
| `get_status`                   | Materializer queue metrics.                                                   |
| `get_conflicts`                | List conflict-copy blocks.                                                    |
| `import_markdown`              | Import Logseq/Markdown file as page + blocks.                                 |
| `list_page_links`              | Page-to-page edges (for graph view). 3 JOINs with DISTINCT dedup.             |
| `get_compaction_status`        | Op log stats (total ops, oldest, retention window).                           |
| `compact_op_log_cmd`           | Create snapshot + purge old ops. `BEGIN IMMEDIATE` transaction.               |
| `log_frontend`                 | Write frontend log entry to Rust tracing (dual-write IPC bridge).             |

---

## 21. Rust Backend Modules

`backlink`, `cache`, `commands`, `dag`, `db`, `device`, `draft`, `error`, `fts`, `hash`, `import`, `link_metadata`, `materializer`, `merge`, `op`, `op_log`, `pagination`, `pairing`, `peer_refs`, `recovery`, `recurrence`, `reverse`, `snapshot`, `soft_delete`, `sync_cert`, `sync_daemon`, `sync_events`, `sync_files`, `sync_net`, `sync_protocol`, `sync_scheduler`, `tag_inheritance`, `tag_query`, `ulid`, `word_diff`

---

## 22. Scalability Characteristics

Benchmark-driven analysis at 100K blocks. All measurements via Criterion on
SQLite WAL mode with 2-writer + 4-reader pool.

| Operation                        | 100   | 1K    | 10K   | 100K             | Verdict                         |
| -------------------------------- | ----- | ----- | ----- | ---------------- | ------------------------------- |
| get_block (PK lookup)            | 23µs  | 23µs  | 23µs  | 23µs             | Excellent — O(1)                |
| get_properties                   | 23µs  | 23µs  | 23µs  | 23µs             | Excellent — O(1)                |
| list_blocks (paginated)          | 222µs | 284µs | 982µs | 11.8ms           | Good — cursor pagination        |
| count_agenda_batch (7 dates)     | 42µs  | 108µs | 1.3ms | ~13ms            | Good — linear                   |
| export_page_markdown (2K blocks) | —     | —     | —     | 1.4ms            | Good — per-page                 |
| batch_resolve (json_each)        | —     | —     | —     | <1ms             | Excellent — single query        |
| count_backlinks_batch (10 pages) | 78µs  | 628µs | 6.2ms | ~62ms            | Concerning at scale             |
| list_page_links (graph)          | 0.8ms | 7ms   | 128ms | ~1.3s            | Problem — superlinear (3 JOINs) |
| list_projected_agenda            | 0.6ms | 6.2ms | 62ms  | ~620ms           | Problem — O(n×m) in-memory      |
| create_block                     | —     | —     | —     | 36ms             | Marginal — per-keypress budget  |
| compact_op_log                   | —     | —     | —     | 393ms @ 100K ops | Acceptable — maintenance only   |

**Design budget:** PK lookups and paginated reads stay O(1) or O(log n) — the app remains
responsive for typical use (<10K blocks). Graph and projected-agenda queries are the known
scaling bottlenecks; see REVIEW-LATER.md P-15/P-16 for mitigation plans.

**Write path:** `create_block` involves 6 SQL queries + blake3 hash + materializer dispatch.
Tag inheritance contributes ~3-5ms. Lazy hash computation was rejected (breaks sync protocol
integrity — `verify_op_record` checks hashes upfront).

---

## 23. Lessons Learned & Established Patterns

Hard-won patterns from 300+ development sessions. These are not aspirational — they are
empirically validated through bugs found, fixes applied, and alternatives rejected.

### State management

- **Capture mutable state before `await`.** Zustand `get()` values can change during IPC calls.
  Always snapshot state before the async gap. (Root cause of B-5 position:0, rootParentId races.)
- **Clean up store state on navigation.** Undo state, selection state, and per-page state must be
  cleared on unmount or page change. Use `useEffect` cleanup. (Root cause of undo state leaks.)
- **Use `useRef` for stable callbacks.** `[version]` as a dependency recreates callbacks on every
  cache bump, causing stale closures. Ref pattern keeps callbacks identity-stable. (Resolve
  callback instability fix.)
- **Use granular Zustand selectors.** Destructuring 15+ fields from a single `useBlockStore()`
  call causes unnecessary re-renders. Use individual selectors for reactive values and
  `getState()` for stable action references. (21→1 subscription optimization.)
- **Use `useShallow` for multi-field selectors.** When a component needs 3-5 reactive values,
  `useShallow` with object selectors is cleaner than individual hooks.
- **Per-page store isolation.** The global `useBlockStore` singleton caused multi-BlockTree
  conflicts in weekly/monthly views. `PageBlockStore` via React context (R-18) eliminated this:
  each `<BlockTree>` gets its own store, registered in a module-level `pageBlockRegistry`.

### Event handling

- **Use `onPointerDown` for timing-critical operations.** `onClick` fires after React re-renders
  from focus change. `onPointerDown` fires before focus. Keep `onClick` fallback for keyboard
  accessibility. (Delete button timing fix.)
- **Use capture phase for intercepting library events.** ProseMirror's keydown listener fires
  first and consumes events. Attach to `parentElement` with `capture:true` +
  `stopPropagation`. (Enter key not working fix.)
- **Wrap third-party promise callbacks in try/catch.** TipTap Suggestion plugin silently swallows
  rejected promises. Always return `[]` on error. (Picker not opening fix.)

### Error handling

- **Never silently swallow errors.** Replace `.catch(() => {})` with `logger.warn` or
  `toast.error`. 52+ catch sites updated with the logging system (F-19).
- **Optimistic updates need rollback.** Update the store before IPC for instant feedback, but
  always revert on backend failure with error toast. (`edit()` in page-blocks.ts.)
- **Guard against re-entrancy.** Fast key repeats can trigger `handleEnterSave` or
  `handleDeleteBlock` while the previous call is still in flight. Use ref-based flags with
  `.finally()` reset.

### Database & SQL

- **Batch queries aggressively.** Use `json_each()` for IN clauses with dynamic data. FTS
  strip_for_fts was N queries per block until batched to 2. (`batch_resolve`, `get_batch_properties`.)
- **Use recursive CTEs for tree operations.** Ancestor/descendant walks, subtree deletes, and
  page-scoped history all use `WITH RECURSIVE`. Add depth limits (max 10,000 iterations for
  LCA, max 20 for block depth).
- **Hoist timestamp generation above multiple writes.** Two separate `now_rfc3339()` calls can
  straddle a millisecond boundary, causing flaky tests. Single `let now` above both writes.
- **Use `BEGIN IMMEDIATE` for TOCTOU-sensitive writes.** `edit_block` and `compact_op_log` need
  exclusive locks upfront to prevent concurrent modification.
- **Reserved property keys route to columns.** `todo_state`, `priority`, `due_date`,
  `scheduled_date` live as dedicated columns on `blocks` (migration 0012). The materializer
  routes `SetProperty`/`DeleteProperty` for these keys to column updates, not
  `block_properties` rows. This eliminates N+1 queries for agenda/filter operations.

### Sync

- **Idempotent guards on merge operations.** Compare current state with winner before creating
  new ops. Without this, merge queries match all historical ops causing infinite re-resolution.
  All three conflict types (edit_block, set_property, move_block) have idempotency guards.
- **`INSERT OR IGNORE` for remote ops.** Duplicate delivery is safe due to composite PK.
  No renumbering, no collision.
- **Merge preload pattern.** Pre-load tag/page name maps via `load_ref_maps` before batch
  operations. O(N×3) → O(2+N) for FTS reindex.

### Frontend component patterns

- **Extract at ~800 lines or 3+ responsibilities.** Large components were systematically
  decomposed across multiple sessions: BlockTree 1998→808, StaticBlock 846→234,
  FormattingToolbar 638→350, PagePropertyTable 450→217, QueryResult 452→246.
- **Config-driven UI for repetitive patterns.** Toolbar buttons use `ToolbarButtonConfig` arrays.
  Task checkbox uses `TASK_CHECKBOX_STYLES` map. Slash commands group related items.
- **Use `EmptyState` for all empty views.** Never `return null` or show raw text.
- **Use `LoadingSkeleton` for initial load states.** Inline spinners only for action feedback.
- **Use `ConfirmDialog` for destructive confirmations.** Replaced 8 inline AlertDialog patterns.
- **Use `ListViewState` for loading/empty/loaded branching.** Adopted across 6 components.
- **Use `CollapsiblePanelHeader` for collapsible sections.** Shared across 7+ panels.
- **Use semantic color tokens, not hardcoded Tailwind classes.** `text-status-overdue` not
  `text-red-700`. 14 semantic tokens for status/conflict/priority in light+dark themes.
- **Focus ring consistency: `ring-[3px] ring-ring/50`** is the standard across Button, Input, and
  all `ui/` primitives (including `sidebar.tsx`).

### Testing

- **Test gaps are bug indicators.** Missing tests for `compute_edit_diff_inner`,
  `scheduled_date` undo, and date filtering all indicated real bugs.
- **Override-pattern factories for test fixtures.** `makeBlock({ id: 'x', content: 'test' })`
  is more maintainable than positional arguments. Centralized in `__tests__/fixtures/`.
- **`data-testid` for E2E selectors.** Not CSS classes. 411 selectors migrated.
- **`userEvent` over `fireEvent`.** Simulates real user interaction. Exception: mock-boundary
  contexts where async unmount causes timeout (documented in SortableBlock).
- **`axe(container)` on every component test.** Accessibility is not optional.
- **Materializer settle: 50ms sleep after cache-rebuild ops** in tests. The materializer is
  async; tests that query caches immediately after writes get stale data.

### Rejected approaches (empirically)

- **Lazy hash computation:** Breaks sync protocol — `verify_op_record` checks hashes upfront.
- **Offset-based pagination:** Unstable with concurrent inserts. ULID cursor only.
- **`from_text` on `edit_block` ops:** Doubles storage for every edit; prior state is
  reconstructable from op log.
- **Client-side backlink filtering:** N+1 `getProperties()` calls. Server-side filter
  expression system (13-variant `BacklinkFilter` enum) replaced it.
- **Destructuring Zustand stores:** Causes unnecessary re-renders. Individual selectors only.
- **Fractional TEXT indexing for positions:** Adds complexity (rebalance, sync merge of rebalance
  batches) for no practical benefit at realistic sibling counts.
- **Tag-to-tag inheritance:** Graph traversal in materializer hot path + fan-out on rename.
  Prefix-aware LIKE search covers the hierarchy use case.
- **SQLCipher:** Key derivation complexity and passphrase UX for marginal benefit over
  filesystem encryption.
- **Inline event handlers in render:** Breaks memo; use stable function references.
- **Manual dialog/dropdown implementations:** Use Radix UI for focus management, keyboard
  trapping, and accessibility. Never build custom overlays.
