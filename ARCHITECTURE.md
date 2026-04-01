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
5. [Materializer (CQRS)](#5-materializer-cqrs)
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

---

## 1. Technology Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Desktop shell | Tauri 2.0 | Lightweight native wrapper. Ships a WebView, not a bundled browser. |
| Frontend | React 18 + Vite | Locked by TipTap and shadcn/ui ecosystem. |
| Editor | TipTap (ProseMirror) | WYSIWYG inline nodes for token chips. See [Editor Architecture](#7-editor-architecture). |
| UI library | shadcn/ui + Tailwind | Copy-paste components, no lock-in. `rtl:` variants for future i18n. |
| Linting/formatting | Biome | Replaces ESLint + Prettier. Non-negotiable from day one — retrofitting means a whole-repo reformat. |
| Database | SQLite via sqlx | Async, compile-time query validation. WAL mode for concurrent readers. |
| State management | Zustand | Lightweight stores with explicit state enums for boot and editor lifecycle. |
| Async runtime | Tokio | Powers the materializer queues and all async Tauri command handlers. |
| DnD | @dnd-kit | Tree-aware drag-and-drop with depth projection for indent/reparent. |

**Rejected alternatives:**
- **Electron:** Too heavy for a notes app.
- **Flutter/Capacitor:** Wrong ecosystem for TipTap + shadcn.
- **CodeMirror 6:** Source-visible editor model. ProseMirror inline nodes are the correct model for WYSIWYG token chips — CodeMirror's `atomicRanges` have known cursor boundary bugs.
- **ESLint + Prettier:** Biome is faster and ships as a single tool.
- **Diesel/rusqlite:** Diesel has too much boilerplate; rusqlite's sync API would require migration later. sqlx gives compile-time checks + async from day one.

### Rust Libraries

| Crate | Purpose |
|-------|---------|
| sqlx 0.8 + sqlx-cli | Async SQLite, compile-time query validation, migrations |
| blake3 | Op log hash chaining (content-addressable, deterministic) |
| diffy | Line-level three-way text merge for conflict resolution |
| zstd | Snapshot compression (level 3) |
| ciborium | CBOR serialisation for `log_snapshots.data` |
| thiserror + tracing | Error handling and structured logging |
| specta + tauri-specta | Auto-generated TypeScript bindings from Rust types |
| FxHashMap (rustc-hash) | Fast hash maps on materializer hot paths |
| ulid + uuid | ULID generation for all IDs; UUID v4 for device identity |
| chrono | Timestamps (RFC 3339 with millisecond precision) |

---

## 2. Data Model

### Central principle: everything is a block

Tags, pages, and content are all rows in the `blocks` table, distinguished by `block_type`. There
are no separate tags or pages tables. This unified model means tags and pages travel through the
op log identically to content blocks — same creation, deletion, properties, and metadata.

| `block_type` | `parent_id` | `position` | `content` |
|---|---|---|---|
| `content` | any block or null | integer (1-based) | Markdown text with `#[ULID]` and `[[ULID]]` tokens |
| `tag` | always null | always null | canonical name (e.g. `work/meeting`) |
| `page` | any block or null | integer (1-based) | page title |

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

**Tag inheritance will not be implemented.** Prefix-aware LIKE search covers the use case (the
Obsidian model). True query-time inheritance would require graph traversal in the materializer hot
path and fan-out on rename. The explicit prefix model is simpler and predictable.

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

SQLite in WAL mode. Database file at `~/.local/share/com.blocknotes.app/notes.db`.

**Pool architecture:**
- **Write pool:** Single connection (`max_connections(1)`) — serialises all writes including
  materializer ops. No write contention by design.
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
The `.sqlx/` offline cache (90 query files) is committed; CI fails if stale. Runtime queries are
limited to PRAGMAs, FTS5 operations, and dynamic SQL (~11 queries).

### Schema

12 tables + 1 FTS5 virtual table, 9 indexes across 2 migrations.

**Core tables:**

```
blocks              — id (ULID PK), block_type, content, parent_id, position,
                      deleted_at, archived_at, is_conflict, conflict_source
block_tags          — (block_id, tag_id) composite PK
block_properties    — (block_id, key) composite PK, value_text/value_num/value_date/value_ref
block_links         — (source_id, target_id) composite PK — materializer-maintained cache
attachments         — id (ULID PK), block_id, mime_type, filename, size_bytes, fs_path
```

**Op log tables:**

```
op_log              — (device_id, seq) composite PK, parent_seqs (JSON), hash (blake3),
                      op_type, payload (JSON), created_at
block_drafts        — block_id PK, content, updated_at — mutable scratch space for autosave
log_snapshots       — id (ULID PK), status ('pending'|'complete'), up_to_hash, up_to_seqs,
                      data (zstd-compressed CBOR BLOB)
peer_refs           — peer_id PK, last_hash, last_sent_hash, synced_at, reset_count
```

**Performance caches:**

```
tags_cache          — tag_id PK, name, usage_count, updated_at
pages_cache         — page_id PK, title, updated_at
agenda_cache        — (date, block_id) composite PK, source
fts_blocks          — FTS5 virtual table (block_id UNINDEXED, stripped), unicode61 tokenizer
```

**Indexes:** Covering indexes on `blocks(parent_id, deleted_at)`,
`blocks(block_type, deleted_at)`, `blocks(deleted_at, id)`, `block_tags(tag_id)`,
`block_links(target_id)`, `block_properties(value_date)`, `op_log(created_at)`,
`agenda_cache(date)`, `attachments(block_id)`.

---

## 4. Operation Log

### Core invariant

The op log is **strictly append-only**. No mutations, no deletions (except compaction into
snapshots). `block_drafts` is the only mutable scratch space. Nothing else bypasses this
invariant.

### Composite primary key

```
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
```
blake3(device_id || seq || parent_seqs_canonical || op_type || payload_canonical)
```

- `parent_seqs_canonical`: JSON array sorted by `[device_id, seq]` lexicographically.
- Output: 64-character lowercase hex string.
- ULIDs in payloads are normalised to uppercase Crockford base32 before hashing (determinism).
- Constant-time comparison for verification.

### Causal tracking

`parent_seqs` is a JSON array of `[device_id, seq]` pairs stored from Phase 1:
- **Linear (current):** null for genesis, single-entry array pointing to the previous local op.
- **DAG (sync):** merge ops carry multiple entries, one per causal parent at the merge point. No
  schema migration required — the column already accepts multi-entry arrays.

### Op types

12 op types with exhaustive `match` — no catch-all arms:

| Op type | Trigger | Key payload fields |
|---------|---------|-------------------|
| `create_block` | Block creation | block_id, block_type, parent_id, position, content |
| `edit_block` | Blur/flush | block_id, to_text, prev_edit (causal link) |
| `delete_block` | User delete | block_id, cascade: true (always) |
| `restore_block` | Restore from Trash | block_id, deleted_at_ref |
| `purge_block` | Permanent delete | block_id |
| `move_block` | Indent/dedent/DnD | block_id, new_parent_id, new_position |
| `add_tag` | Apply tag | block_id, tag_id |
| `remove_tag` | Remove tag | block_id, tag_id |
| `set_property` | Set typed property | block_id, key, value_text/num/date/ref (exactly one non-null) |
| `delete_property` | Remove property | block_id, key |
| `add_attachment` | Attach file | attachment_id, block_id, mime_type, filename, size_bytes, fs_path |
| `delete_attachment` | Remove attachment | attachment_id |

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

## 5. Materializer (CQRS)

Commands write ops to the log. The materializer asynchronously applies ops to derived state. This
is the fundamental architectural split — commands never write to core tables directly.

### Queue architecture

- **Foreground queue** (capacity 256): Op application to core tables (`blocks`, `block_tags`,
  `block_properties`). Low latency for viewport responsiveness.
- **Background queue** (capacity 1024): Cache rebuilds, FTS indexing, maintenance. Stale-while-
  revalidate — never blocks the UI.

Both queues drain with automatic dedup: duplicate cache-rebuild tasks are coalesced. Backpressure
is silent drop (appropriate for caches that will rebuild on the next cycle). Panic isolation per
task via spawned sub-tasks.

### Caches maintained

| Cache | Rebuild trigger | Staleness threshold |
|-------|----------------|-------------------|
| `tags_cache` | create/delete/restore tag block, add/remove tag | 5s |
| `pages_cache` | create/delete/restore/edit page block | 5s |
| `agenda_cache` | set/delete property (value_date), add/remove tag (date pattern) | 2s |
| `block_links` | edit_block — regex parse `[[ULID]]`, diff against prior index | immediate |

**`tags_cache` rebuild query:** Uses `LEFT JOIN` from `blocks` to capture zero-usage tags (newly
created, never applied). A plain `GROUP BY block_tags.tag_id` would omit them.

**Cache strategy:** Stale-while-revalidate. Caches are never rebuilt synchronously on the hot path
or at boot. Return last computed value immediately, enqueue background rebuild if stale. Cold boot
returns a loading sentinel; UI renders skeleton.

### FTS5 maintenance

The FTS5 index accumulates segment files. Without periodic maintenance, segment count grows and
search degrades.

- **Scheduled optimize:** After every 500 `edit_block` ops or every 60 minutes (whichever comes
  first): `INSERT INTO fts_blocks(fts_blocks) VALUES('optimize')`. Merges all segments into one
  b-tree.
- **Post-RESET:** One immediate `optimize` pass after full FTS rebuild from snapshot.
- **Rejected:** `optimize` after every op (too costly), `optimize` only on user request (invisible
  degradation).

### Queue monitoring

`StatusInfo` struct with atomic counters: `fg_processed`, `bg_processed`, `bg_deduped`,
`fts_edits_since_optimize`, queue high-water marks, error and panic counts. Exposed via
`get_status` command and polled by the StatusPanel UI every 5 seconds.

### Pagination

All list queries use cursor-based (keyset) pagination. No offset pagination anywhere. No "fetch
all and filter in Rust." Enforced from Phase 1. Zero exceptions.

---

## 6. Content Format & Serializer

### Storage format

`blocks.content` is a UTF-8 Markdown string with a locked inline mark set and two custom ULID
token extensions. The format is plain text — diffed directly by `diffy`, stored as-is in SQLite,
human-readable in any text tool.

```
block_content  := (block_element | span)*
block_element  := heading | code_block
heading        := '#'{1,6} ' ' span+              -- # H1 through ###### H6
code_block     := '```' language? '\n' text '\n' '```'
span           := plain_text | bold | italic | code_span | tag_ref | block_link | ext_link
bold           := '**' span+ '**'
italic         := '*' span+ '*'
code_span      := '`' plain_text '`'               -- no nesting inside code
tag_ref        := '#[' ULID ']'
block_link     := '[[' ULID ']]'
ext_link       := '[' text '](' url ')'
ULID           := [0-9A-Z]{26}                     -- Crockford base32, exactly 26 chars
```

**Constraints:**
- Every `\n` is a block split boundary (auto-split on blur), except inside fenced code blocks
  and headings, which remain single blocks.
- No `\n\n` paragraph breaks. The block tree is the structural separator.
- `code_span` content is plain text — marks and tokens inside backticks are not parsed.

**The inline mark set is locked.** Adding any mark (strikethrough, highlight, underline) requires
extending the serializer, FTS5 stripping, export mapping, and a migration audit.

### Custom serializer

Standalone TypeScript module (`src/editor/markdown-serializer.ts`, ~681 lines) with zero external
dependencies. Converts between ProseMirror document nodes and the storage format.

**Serialize (ProseMirror → Markdown):**

| Node/mark | Output |
|-----------|--------|
| `text` | raw text (escape `*`, `` ` ``, `#[`, `[[` when literal) |
| `bold` mark | `**...**` |
| `italic` mark | `*...*` |
| `code` mark | `` `...` `` |
| `heading` node | `# ` through `###### ` prefix (levels 1–6) |
| `codeBlock` node | ` ``` language\n...\n``` ` |
| `tag_ref` node | `#[{id}]` |
| `block_link` node | `[[{id}]]` |
| `link` mark | `[text](url)` |
| `hardBreak` | `\n` (triggers auto-split) |
| unknown node | stripped with warning |

**Parse (Markdown → ProseMirror):** Hand-rolled single-pass parser. Regex for token ID only. Mark
stack with unclosed-mark revert (becomes plain text, never errors).

**Test suite:** 200+ unit tests, property-based tests (fast-check) for round-trip identity and
idempotence. Mark coalescing avoids ambiguous sequences like `*a****b****c*`.

**Why not `tiptap-markdown`:** Has known edge cases, doesn't support `#[ULID]` / `[[ULID]]`
tokens, uncertain maintenance. A scoped custom serializer is ~150 lines of core logic, fully
owned, trivially testable.

### FTS5 strip pass

Before inserting into the FTS5 index, the materializer strips Markdown syntax:
- Remove `**`, `*`, `` ` `` delimiters.
- Replace `#[ULID]` → resolved tag name (enables tag-name search).
- Replace `[[ULID]]` → resolved page title.

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
1. User clicks/arrows into a block → mount TipTap, parse Markdown → `setContent`, focus editor.
2. User blurs → serialize ProseMirror → Markdown string. If changed, flush `edit_block` op.
   `clearHistory()`, unmount, render static div.

**Why one instance:** Mounting thousands of ProseMirror instances for a large page is prohibitively
expensive. The roving pattern gives full rich editing for the focused block with zero per-block
overhead elsewhere.

### TipTap extensions

| Extension | Type | Purpose |
|-----------|------|---------|
| TagRef | inline node (atom) | `#[ULID]` rendered as chip with resolved tag name |
| BlockLink | inline node (atom) | `[[ULID]]` rendered as chip with resolved page title |
| ExternalLink | mark extension | `[text](url)` with autolink and paste detection |
| AtTagPicker | suggestion | `@` triggers fuzzy search of `tags_cache` → inserts `tag_ref` node |
| BlockLinkPicker | suggestion | `[[` triggers fuzzy search of `pages_cache` → inserts `block_link` node, "Create new" option |
| SlashCommand | suggestion | `/` triggers command menu (TODO, DOING, DONE, DATE, PRIORITY HIGH/MED/LOW) |
| CodeBlockLowlight | node | Fenced code blocks with syntax highlighting |

Pickers intercept keystrokes and open autocomplete popups. On selection, they insert the
appropriate inline node with ULID. The raw ULID is never visible to the user.

### Keyboard handling

`useBlockKeyboard` hook — pure handler function attached to the TipTap editor DOM:

| Key | Condition | Action |
|-----|-----------|--------|
| ArrowUp/Left | cursor at position 0 | Flush, focus previous block (cursor to end) |
| ArrowDown/Right | cursor at end | Flush, focus next block (cursor to start) |
| Enter | — | Save block and close editor |
| Backspace | block empty | Delete block, focus previous |
| Backspace | cursor at start, non-empty | Merge with previous block |
| Tab | — | Flush, indent (change parent) |
| Shift+Tab | — | Flush, dedent |
| Escape | — | Cancel editing, discard changes |
| Ctrl+Enter | — | Cycle task state (TODO → DOING → DONE → none) |

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
- On blur/flush: op written, `clearHistory()` called. Session undo history is lost.

**Tier 2 — Page-level (op reversal):**
- Ctrl+Z/Ctrl+Y when focus is outside contentEditable (intercepted by `useUndoShortcuts`).
- Backend computes the inverse of the Nth most recent op on the page via `reverse.rs`.
- Reverse op is appended to the op log as a new op (the log remains append-only).
- Per-page state tracked in `useUndoStore`: `undoDepth` (how many ops undone) and `redoStack`
  (`OpRef[]` for redo). Cleared on navigation or new user action.
- Optimistic UI updates with rollback on backend error.

**Operation reversal (`reverse.rs`):**

| Original op | Reverse |
|-------------|---------|
| `create_block` | `delete_block` |
| `edit_block` | `edit_block` with prior text (from op log) |
| `delete_block` | `restore_block` |
| `move_block` | `move_block` to prior parent/position (from op log) |
| `add_tag` | `remove_tag` |
| `remove_tag` | `add_tag` |
| `set_property` | `set_property` with prior values, or `delete_property` if first set |
| `delete_property` | `set_property` with prior values |
| `add_attachment` | `delete_attachment` |
| `restore_block` | `delete_block` |
| `purge_block` | **non-reversible** |
| `delete_attachment` | **non-reversible** |

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

---

## 8. Frontend Architecture

### State management — Zustand stores

| Store | Purpose | Key state |
|-------|---------|-----------|
| `useBootStore` | App initialization state machine | booting → recovering → ready \| error |
| `useBlockStore` | Block tree CRUD, focus management | blocks[], focusedBlockId, rootParentId |
| `useNavigationStore` | Page routing and view state | currentView, pageStack[], selectedBlockId |
| `useJournalStore` | Journal mode and date selection | mode (daily/weekly/monthly/agenda), currentDate |
| `useResolveStore` | Centralized ULID → title cache | cache Map, pagesList[], version counter |
| `useUndoStore` | Page-level undo/redo state | undoDepth per page, redoStack (OpRef[]) |

`useResolveStore` is preloaded on boot (`preload()` fetches all pages and tags) and updated
incrementally on create/edit/delete. Both JournalPage and BlockTree consume from the same store —
no duplicate `listBlocks` calls.

### Component hierarchy

```
App
├── BootGate                       — blocks UI during boot/recovery
├── Sidebar                        — Journal, Pages, Tags, Trash, History, Status, Conflicts nav
├── JournalPage                    — daily/weekly/monthly/agenda modes
│   └── BlockTree (per day)        — recursive block renderer
│       └── SortableBlock          — @dnd-kit wrapper
│           └── EditableBlock      — static div ↔ TipTap toggle
│               ├── StaticBlock    — rendered Markdown (links, tags, code blocks)
│               ├── TipTap editor  — mounted on focus only
│               └── BlockContextMenu — right-click / long-press actions
├── PageEditor                     — page title + block tree + detail panels
│   └── BlockTree                  — same recursive renderer
├── PageBrowser                    — all pages list
├── TagList                        — all tags list
├── TrashView                      — soft-deleted blocks
├── SearchPanel                    — FTS5 full-text search
├── HistoryView                    — global op log with multi-select batch revert
├── StatusPanel                    — materializer queue metrics
├── ConflictList                   — pending conflict copies
└── Panels (contextual)
    ├── BacklinksPanel             — blocks linking to current block (filtered)
    ├── HistoryPanel               — per-block edit chain from op log
    ├── PropertiesPanel            — typed key-value properties
    ├── TagPanel                   — apply/remove tags
    ├── FormattingToolbar          — bold/italic/code/link/undo/redo
    ├── LinkEditPopover            — inline link creation/editing
    └── KeyboardShortcuts          — help panel
```

### Journal view

Four modes, each rendering day sections with their own BlockTree:

| Mode | Layout |
|------|--------|
| Daily | Single day, prev/next navigation, Today button |
| Weekly | Mon–Sun grid, each day as a section |
| Monthly | Stacked day sections with calendar grid header (content dots) |
| Agenda | TODO/DOING/DONE panels, paginated, collapsible |

Features: floating date picker (react-day-picker), keyboard shortcuts (Alt+Left/Right for
prev/next, Alt+T for today), scroll-to-date support.

### Drag and drop

@dnd-kit with tree-aware projection:
- Horizontal drag offset determines indent level (depth projection).
- Drop indicator shows target position and depth.
- `SortableBlock` wraps `EditableBlock` with `useSortable()`.
- On drop: `moveToParent(blockId, newParentId, newPosition)` via Tauri command.

### Tauri command wrappers

`src/lib/tauri.ts` provides 28 type-safe wrappers over auto-generated `bindings.ts`. Handles
Tauri 2's requirement for explicit `null` (not `undefined`) on `Option<T>` parameters.

### Extracted hooks

BlockTree's concerns are decomposed into focused hooks:

| Hook | Purpose |
|------|---------|
| `useBlockDnD` | DnD state, handlers, and tree-aware depth projection |
| `useBlockResolve` | ULID → title resolution, tag/page search, page creation |
| `useBlockProperties` | Property state, TODO/priority cycling |
| `useUndoShortcuts` | Global Ctrl+Z / Ctrl+Y (outside editor contentEditable) |
| `useViewportObserver` | IntersectionObserver for off-screen block placeholders |

---

## 9. Search

### FTS5 integration

SQLite FTS5 virtual table (`fts_blocks`) with `unicode61` tokenizer.

- **Index content:** Markdown-stripped text with tag names and page titles resolved from ULIDs.
- **Search command:** `search_blocks` with cursor-based pagination on `(rank, rowid)`.
- **Ranking:** BM25 (FTS5 default).
- **UI:** `SearchPanel` with debounced input, paginated results.

### CJK limitation (known, accepted)

FTS5 `unicode61` tokenizer does not handle CJK word boundaries — searching CJK text returns noise.
This is documented and accepted for v1. CJK text storage, rendering, and IME input all work
correctly. Only FTS5 search is affected.

See ADR.md for the Phase 5 Tantivy + lindera roadmap.

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

```
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

Cache tables (`tags_cache`, `pages_cache`, `agenda_cache`, FTS5) are **not included** — they
rebuild from core tables on first boot after a RESET.

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
   - Check if an `edit_block` op exists for this `block_id` with `created_at >= draft.updated_at`.
   - If none: draft was not flushed. Emit a synthetic `edit_block` op. Log a warning.
   - If found: draft was already flushed (no-op).
4. Delete all draft rows regardless.

Per-draft errors are captured in `RecoveryReport::draft_errors`. A single corrupt draft does not
block boot — processing continues with remaining drafts. Caches are rebuilt on first materializer
dispatch after boot (stale-while-revalidate handles it).

---

## 13. Type Safety & Bindings

### specta + tauri-specta

All 28 Tauri commands are annotated with `#[specta::specta]`. TypeScript bindings are auto-
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

| Layer | Tool | Scope |
|-------|------|-------|
| Rust unit tests | cargo nextest | Inline `#[cfg(test)] mod tests` in every module (~945 tests) |
| Rust integration | cargo nextest | Pipeline tests, API contract tests |
| Rust snapshots | insta (22 YAML snapshots) | Op payload serialization, command responses |
| Frontend unit | Vitest (jsdom) | Pure functions, store logic, hooks |
| Frontend component | Vitest + @testing-library/react | Render, interaction, a11y (vitest-axe) |
| Frontend property | Vitest + fast-check | Markdown serializer fuzzing, round-trip stability |
| E2E | Playwright (Chromium, 12 spec files) | Smoke, editor lifecycle, links, keyboard, Markdown syntax, slash commands, toolbar, tags, undo/redo, conflicts, history, features coverage |
| Benchmarks | Criterion (9 bench files) | Cache, commands, drafts, FTS, hash, op log, pagination, soft delete, undo/redo (manual only) |

### Pre-commit hooks (prek)

File-type-aware hooks — Rust hooks skip when no `.rs` files are staged, and vice versa:
- **Builtin:** trailing whitespace, EOF fixer, YAML/TOML/JSON validation, merge conflict detection, large file blocking
- **Frontend:** Biome check, TypeScript (`tsc --noEmit`), Vitest
- **Security:** npm audit, license-checker, depcheck
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
`value_ref` — but the current query API only supports text matching. Numeric, date, and reference
filtering is a planned extension.

### Backlinks

`get_backlinks(blockId)` returns blocks whose content contains `[[blockId]]` tokens. The
`block_links` table (materializer-maintained) is joined with `blocks` to produce paginated
results. Excludes soft-deleted and conflict blocks.

**Client-side filters (current):** The BacklinksPanel applies type, TODO status, priority, and
creation-date filters in JavaScript after loading. Properties are fetched per-block via
`getProperties()`.

**Planned:** Server-side compound filter expression (AND/OR/NOT over property, tag, date, and
text predicates) pushed to SQL. See the backlinks filter plan for details.

### Batch operations

Two commands avoid N+1 patterns in the frontend:

- `batch_resolve(ids[])` → `ResolvedBlock[]` — lightweight metadata (id, title, block_type,
  deleted) for rendering `[[ULID]]` and `#[ULID]` tokens in StaticBlock.
- `get_batch_properties(blockIds[])` → `HashMap<blockId, PropertyRow[]>` — all properties for
  multiple blocks in a single query using `json_each()`.

Both accept a `Vec<String>` of IDs and return validation errors on empty input.

---

## 17. Android Platform

### Build and deployment

Android support via Tauri 2's mobile target. The generated Android project lives at
`src-tauri/gen/android/`. Same Rust backend, same React frontend — the WebView hosts the
identical UI.

**Build targets:**
- `x86_64` — emulator (AVD `spike_test`, API 34)
- `aarch64` — physical ARM64 devices

**DB path:** `/data/data/com.blocknotes.app/notes.db` (via `app.path().app_data_dir()`). Same
SQLite WAL mode, same pool configuration, same migrations.

**SDK requirements:** Min SDK 24, Target SDK 36, NDK 27.

### Status

All IPC commands (read + write) confirmed working. Block creation, editing, and persistence
across restarts verified on emulator. Debug APK builds, installs, and runs correctly.

**Known limitation:** ProGuard `isMinifyEnabled = true` for release builds, but keep rules are
empty — release APK will crash. Debug builds work correctly.

### Headless testing

AI agents and CI can interact with the Android app entirely via ADB — no display needed:
- `adb exec-out screencap -p` for screenshots
- `adb shell input tap/text/swipe` for interaction
- `adb logcat -s RustStdoutStderr:V` for Rust logs
- Chrome DevTools Protocol via `adb forward` for WebView inspection
