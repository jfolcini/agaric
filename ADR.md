# Architecture Decision Records

## Vision
Block-based local-first notes app for Linux desktop and Android. Journal-first, with powerful
tagging inspired by org-mode and emergent structure. No cloud — local WiFi sync only. Simpler
than Anytype, faster than Logseq. Everything is a block; pages are a block type; tags are a
block type.

## Status Summary

| ADR | Title | Status | Notes |
|-----|-------|--------|-------|
| 01 | Shell & Frontend | **Partial** | P1-P3 done, P4 Waves 1-2 done. Export (P5) not started. |
| 02 | State Management | **Partial** | Zustand boot/editor done. TanStack Query (P3+), XState (P4+) pending. |
| 03 | UI Components | **Partial** | P1 done. Noto Sans bundling deferred to P5 (i18n). |
| 04 | Database | **Complete** | sqlx + WAL + migrations. Single pool (ADR-04 read/write split deferred). |
| 05 | Schema | **Complete** | 13 tables + FTS5 virtual table, 8 indexes. |
| 06 | Data Model | **Partial** | P1 done. P4W1 conflict copies done. Export (P5) pending. |
| 07 | Operation Log | **Partial** | Linear chain + DAG + snapshots/compaction done. Sync protocol pending. |
| 08 | Materializer | **Complete** | Queues, caches, FTS tasks, tag queries, queue monitoring all done. |
| 09 | Sync | **Planned** | Schema ready (peer_refs, DAG support). Implementation not started. |
| 10 | CRDT / Conflict | **Partial** | merge.rs done (diffy, conflict copy, LWW). Sync-triggered merge pending. |
| 11 | Rust Libraries | **Complete** | All libraries integrated (blake3, diffy, zstd, ciborium, etc.). |
| 12 | Search | **Partial** | FTS5 done (P3). Tantivy/lindera for CJK deferred to P5. |
| 13 | Dev Tooling | **Complete** | insta, Playwright E2E, cargo-nextest, FTS5 benchmarks all done. |
| 14 | API | **N/A** | Dropped for v1. Deferred indefinitely. |
| 15 | Encryption at Rest | **N/A** | Decision-only: filesystem-level (Android FBE, Linux LUKS). |
| 16 | Build Order | **Partial** | Planning ADR. P1-P1.5 complete, P2-P5 in progress or planned. |
| 17 | Graph View | **Planned** | Deferred to P5+. Schema supports it (block_links table). |
| 18 | Tag Inheritance | **Closed** | Will not implement. Prefix-aware LIKE search covers the use case. |
| 19 | CJK Support | **Partial** | FTS5 limitations documented. Tantivy + lindera planned for P5. |
| 20 | Content Storage | **Partial** | Serializer + FTS strip + diffy done. Export (P5) pending. |
| — | UX Review Notes | **Active** | 2026-03-31 review: auto-split tension, cross-block undo, collapse persistence, monthly view, BlockTree decomposition, N+1 property fetch, resolve cache duplication. |

**Legend:** P1=Phase 1, P2=Phase 2, etc. P4W1=Phase 4 Wave 1.

---

## ADR-01 — Shell & Frontend
**Status:** Phase 1.5 complete. Android spike complete (Phase 1.5). Phase 2 complete (DnD, backlinks, editor UI). Phase 3 complete (FTS5 search, tag queries, nextest). Phase 4 Waves 1-2 complete (DAG merge, snapshots/compaction). Export (Phase 5) not started.

**Decision:** Tauri 2.0, React 18 + Vite, TipTap, Biome.

**Rejected:** Electron (too heavy), Flutter/Capacitor (wrong ecosystem), Vue/Preact/Svelte/Astro
(locked by TipTap + shadcn), ESLint+Prettier (replaced by Biome from day one).

---

### TipTap integration architecture — single roving instance

There is exactly **one TipTap instance** in the application at any time. It is mounted into a
block's DOM slot when that block receives focus, and unmounted on blur. All non-focused blocks
render as plain static `<div>` elements.

**Lifecycle:**
- User clicks or arrows into a block → mount TipTap into that block's slot, set content to
  `block.content`, focus editor.
- User blurs (clicks away, arrows out, Tab, Enter) → if content changed, flush `edit_block` op,
  call `clearHistory()`, unmount TipTap, render static div.
- Exactly one TipTap instance exists at any time.

**Content format — Markdown with inline extensions:**
`blocks.content` is a UTF-8 Markdown string with a locked inline mark set and two custom token
extensions. The format is plain text — it is diffed directly by `diffy`, stored as-is in SQLite,
and human-readable in any text tool.

**Inline mark set (locked — no additions without an ADR):**

| Syntax | Meaning |
|--------|---------|
| `**text**` | Bold |
| `*text*` | Italic |
| `` `text` `` | Inline code |

Strikethrough, highlight, underline, and other marks are explicitly deferred. Adding a mark
extends the serializer schema and requires a migration audit — this is not a casual change.

**Custom token extensions:**

| Syntax | Meaning | Stored example |
|--------|---------|----------------|
| `#[ULID]` | Tag reference | `#[01ARZ3NDEKTSV4RRFFQ69G5FAV]` |
| `[[ULID]]` | Page or block link | `[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]` |

Human-readable names are resolved at render time by TipTap reading from `tags_cache` and
`pages_cache`. The ULID is the canonical identity. Renaming a tag or page propagates everywhere
automatically — no content migration ever needed. Tag and link syntax is never written as
`#tagname` or `[[title]]`; the TipTap extension intercepts `#` and `[[` keystrokes and opens a
picker that resolves to a ULID on selection.

**WYSIWYG editing model:** Users see formatted text and named chips, not raw syntax. `**bold**`
renders as bold with the asterisks hidden. `[[01ARZ...]]` renders as a chip showing the resolved
page title. This is the Notion/Anytype model, not the Obsidian/Logseq source-visible model. It is
the primary reason TipTap is used over CodeMirror 6 (see rejected alternatives below).

**Markdown serializer — custom, scoped, standalone:**
Every focus/blur cycle round-trips through a custom Markdown serializer:

```
Mount:   Markdown string → parse → ProseMirror document → TipTap editor
Unmount: TipTap editor  → ProseMirror document → serialize → Markdown string
```

The serializer is written as a standalone TypeScript module with its own test suite, independent
of `tiptap-markdown` or any third-party Markdown library. Its schema is intentionally minimal —
exactly the marks and tokens above, nothing else. Unknown node types produced by TipTap
(e.g. `hardBreak` from paste normalization) are stripped with a logged warning. Unknown node
types must not silently corrupt content.

The serializer is the highest-risk component in the content pipeline. It must be completed and
fully tested before Phase 1.5 begins. Test coverage requirements:
- Round-trip identity: `serialize(parse(s)) === s` for all valid strings.
- Mark nesting: bold inside italic, inline code adjacent to bold.
- Token adjacency: token at start of string, end of string, adjacent to mark boundary.
- Paste normalization: `hardBreak`, `paragraph` wrapper nodes handled or stripped cleanly.
- Empty string and whitespace-only strings.

**Why TipTap over CodeMirror 6:**
CodeMirror 6 treats Markdown as its native format and would eliminate the round-trip entirely.
However, CodeMirror decorations are visual overlays on text — the `[[ulid]]` token chip cannot
replace the raw text in the editor buffer the way ProseMirror inline nodes do. The cursor
behavior at replaced-range boundaries (`atomicRanges`) is a known source of bugs. ProseMirror
inline nodes are the correct model for WYSIWYG token chips. CodeMirror is the right tool for a
source-visible editor; this app is not source-visible.

**Why not `tiptap-markdown`:**
The community `tiptap-markdown` extension handles the full Markdown spec. It has known fidelity
gaps on edge cases and does not know about `#[ulid]` / `[[ulid]]` tokens. Extending it would
create a dependency on an unofficial package with an unclear maintenance trajectory. A custom
serializer scoped to this app's exact schema is ~150 lines, fully owned, and trivially testable.

**Keyboard boundary handling** (shared `useBlockKeyboard` hook, applied to the single instance):

| Event | Condition | Action |
|-------|-----------|--------|
| `ArrowUp` / `ArrowLeft` | Cursor at position 0 | Flush if dirty, focus previous block, cursor to end |
| `ArrowDown` / `ArrowRight` | Cursor at end | Flush if dirty, focus next block, cursor to start |
| `Backspace` | Block empty | Delete block, focus previous block |
| `Enter` | — | Insert `\n` into content (auto-split fires on blur) |
| `Tab` | — | Flush, indent block (change parent) |
| `Shift+Tab` | — | Flush, dedent block |

**Cross-block selection:** Not supported in v1. Explicitly out of scope.

**Auto-split on blur:** When TipTap blurs and the serialized Markdown string contains one or more
newline characters, the block is automatically decomposed. The first segment overwrites the
current block via `edit_block`. Each subsequent segment becomes a new `create_block` op inserted
immediately below, in order. Tags and properties on the original block are retained on the first
segment only — new blocks are created clean. `block_links` is a materializer-maintained cache
derived from `[[ulid]]` tokens in each block's content; each split segment automatically receives
the correct links after the materializer processes its content.

There is no soft-newline concept: every `\n` in stored content is a block boundary on flush.
Markdown paragraph syntax (`\n\n`) is not used — blocks are inherently single-paragraph and the
block tree is the structural separator. The serializer must not emit double newlines for any mark
or node type. A `hardBreak` node from paste normalization is treated as a `\n` and triggers
auto-split, not rendered as `<br>`.

This is the primary "write prose freely, get structure on exit" mechanic. A user can type a
multi-paragraph entry without thinking about blocks and have it decompose naturally on blur.

**Cross-block paste:** Multi-line paste uses the same `splitOnNewlines(content)` path as
auto-split — one block per line, same op sequence. Not a separate code path.

**Viewport rendering:** Blocks outside the viewport render as static `<div>` elements with known
heights. Intersection Observer manages the visible window to avoid rendering thousands of DOM
nodes on very long pages. Since TipTap only mounts for the focused block, there is no per-block
instance overhead for off-screen blocks.

**TipTap history:** Enabled within the active editing session. Cleared on blur/flush. Ctrl+Z
does not cross the flush boundary — intentional, not a limitation.

**Android risk and early validation:** Tauri 2.0 Android support is relatively new. TipTap on
Android WebView has known differences from desktop: virtual keyboard interaction with ProseMirror,
IME composition events for CJK input.

**Android spike — end of Phase 1.5 (before Phase 2 begins):** Build a minimal throwaway app:
Tauri Android + single roving TipTap instance + IME composition input (CJK preferred) +
Markdown round-trip serializer. Pass criteria: text input works reliably, composition events
handled, virtual keyboard does not break layout, mount/unmount on focus/blur works correctly,
Markdown serializer round-trips correctly under Android WebView's ProseMirror output. Estimated
cost: 3–5 days. Phase 2 does not start until spike passes or mitigation is chosen.

**Notes:**
- specta / tauri-specta bindings implemented (Phase 1.5). `src/lib/bindings.ts` auto-generated; `ts_bindings_up_to_date` test ensures sync.
- Biome is non-negotiable from day one — retrofitting means a whole-codebase reformat.

---

## ADR-02 — State Management
**Status:** Phase 1 complete. TanStack Query (Phase 3+) and XState (Phase 4+) not started.

**Phased introduction to match actual complexity:**

| Phase | State layer |
|-------|-------------|
| 1–2   | Plain Tauri invoke + Zustand with explicit state enums for boot and editor |
| 3+    | TanStack Query for server state, invalidated by Tauri events |
| 4+    | XState for sync state machine only |

**Undo strategy:**
- TipTap history handles Ctrl+Z within the active draft session.
- On blur/flush: op written to log, `clearHistory()` called.
- No Ctrl+Z across the flush boundary — intentional. `edit_block` ops store `to_text` only; there
  is no `from_text`. The previous state is always recoverable from the prior op's `to_text` in the
  history panel, but this is a deliberate manual action, not an automatic undo. The `from_text`
  field was considered and rejected: it doubles storage for every edit and adds no capability that
  isn't already covered by the per-block edit chain in the history panel.
- Persistent version history: op log filtered by `block_id`, surfaced as a history panel (Phase 2).
- Non-text ops (tag, property, move) do not participate in Ctrl+Z. Revert via history panel.
- XState enters only in Phase 4 for the sync state machine.

---

## ADR-03 — UI Components
**Status:** Phase 1 complete. Noto Sans bundling deferred to Phase 5 (i18n).

**Decision:** shadcn/ui (copy-paste, owned, no lock-in), Tailwind with `rtl:` variants, Noto
Sans bundled.

**Rejected:** MUI / Chakra (lock-in), system fonts (inconsistent CJK/Arabic rendering on
Android).

---

## ADR-04 — Database
**Status: FULLY IMPLEMENTED.** Compile-time query validation (`query!` / `query_as!` / `query_scalar!`) active across ~147 queries. `.sqlx/` offline cache committed. 11 runtime queries remain (PRAGMAs, FTS5, dynamic SQL).

**Decision:** sqlx + sqlx migrate from Phase 1. WAL mode, single write connection, sqlx read
pool for concurrent readers.

**Key points:**
- sqlx from day one: compile-time query validation via `sqlx::query!` / `sqlx::query_as!`
  macros. `.sqlx/` offline cache committed to repo; CI fails if stale (see ADR-13).
- Schema migrations managed by `sqlx migrate` with versioned `.sql` files from Phase 1. The
  initial schema is `0001_initial.sql`.
- WAL snapshot isolation is sufficient. `PRAGMA read_uncommitted=ON` is a no-op under WAL.
- Soft deletes via `deleted_at`. Cascade to descendants on block deletion — see ADR-06.
  `archived_at` for working set filtering.
- All Tauri command handlers that touch the DB are `async fn` from the start.

**Rejected:** Diesel (boilerplate), rusqlite (sync API, would require wholesale migration later),
deadpool-sqlite (unnecessary once sqlx pool is in place from Phase 1), single `Mutex<Connection>`
for reads (WAL allows concurrent readers).

---

## ADR-05 — Schema
**Status: FULLY IMPLEMENTED.** All 13 tables, 7 indexes created in 0001_initial.sql. Phase 3 added FTS5 virtual table (0002_fts5.sql) + 1 index.

**Central principle: everything is a block.** Tags, pages, and content are all rows in `blocks`,
distinguished by `block_type`. No separate tags or pages tables.

```sql
blocks
  id              ULID PK
  block_type      TEXT NOT NULL DEFAULT 'content'
                    -- 'content' : regular note block
                    -- 'tag'     : tag definition; content = canonical name (e.g. "work/meeting")
                    -- 'page'    : named document; content = page title
  content         TEXT
                    -- 'content': Markdown UTF-8 with bold/italic/inline-code marks and
                    --            #[ULID] tag tokens and [[ULID]] link tokens (see ADR-20).
                    --            Single-paragraph — no \n\n paragraph breaks. Every \n is a
                    --            block boundary that auto-split will decompose on blur.
                    -- 'tag':     canonical tag name string, no Markdown or token syntax
                    -- 'page':    page title string, no Markdown or token syntax
  parent_id       ULID nullable FK -> blocks(id)
                    -- null = top-level block
                    -- pages and content blocks may have parents
                    -- tag blocks always have parent_id = NULL
  position        INTEGER nullable
                    -- 1-based integer among siblings with the same parent_id
                    -- null for tag blocks (unordered)
                    -- on sync conflict (two devices assign the same position to different blocks),
                    -- last-writer-wins by created_at; materializer compacts to contiguous 1..n
  deleted_at      TIMESTAMP nullable
                    -- soft delete; cascade to all descendants set by materializer (see ADR-06)
  archived_at     TIMESTAMP nullable
  is_conflict     BOOL NOT NULL DEFAULT 0
  conflict_source ULID nullable FK -> blocks(id)

-- Tag blocks always have parent_id = NULL and position = NULL.
-- Tag hierarchy is a naming convention on content only, not a parent_id tree.
-- Deleting a tag block does NOT affect other tag blocks that share a name prefix.
-- e.g. deleting '#work' has no effect on '#work/meeting' — they are independent blocks.

block_tags
  block_id        ULID FK -> blocks(id)
  tag_id          ULID FK -> blocks(id)   -- must reference block_type = 'tag'
  PRIMARY KEY (block_id, tag_id)
  -- Tag blocks may themselves be tagged (block_id pointing to a tag block).
  -- Natural consequence of the unified block model; no special handling required.
  -- All tags in v1 are explicit.
  -- If tag inference is ever added, a separate block_tag_inferred table will be introduced.

block_properties
  block_id        ULID FK -> blocks(id)
  key             TEXT
  value_text      TEXT nullable
  value_num       REAL nullable
  value_date      TIMESTAMP nullable
  value_ref       ULID nullable FK -> blocks(id)
  PRIMARY KEY (block_id, key)

block_links
  source_id       ULID FK -> blocks(id)   -- block containing the [[ulid]] token
  target_id       ULID FK -> blocks(id)   -- block being linked to
  PRIMARY KEY (source_id, target_id)
  -- Materializer-maintained index of [[ulid]] tokens in content.
  -- Does NOT include #[ulid] tag references — those are tracked via block_tags.
  -- Pure read cache: drop and rebuild is safe at any time.

attachments
  id              ULID PK
  block_id        ULID FK -> blocks(id)
  mime_type       TEXT
  filename        TEXT
  size_bytes      INTEGER
  fs_path         TEXT                    -- relative path alongside SQLite file
  created_at      TIMESTAMP
  deleted_at      TIMESTAMP nullable

op_log
  device_id       TEXT NOT NULL           -- originating device UUID (see ADR-07)
  seq             INTEGER NOT NULL        -- per-device monotonic sequence number
  PRIMARY KEY (device_id, seq)
  parent_seqs     JSON nullable           -- causal parents as [[device_id, seq], ...]
                                          -- Phase 1–3: null (genesis) or single-entry array
                                          -- Phase 4+: may be multi-entry at merge points
                                          -- Stored from Phase 1 — no schema change needed at Phase 4
  hash            TEXT NOT NULL           -- blake3(device_id||seq||parent_seqs_canonical||op_type||payload_canonical)
                                          -- parent_seqs_canonical: array sorted by [device_id, seq] lexicographically
  op_type         TEXT NOT NULL
  payload         JSON NOT NULL           -- see ADR-07 for full payload schemas per op_type
  created_at      TIMESTAMP NOT NULL

block_drafts
  block_id        ULID PK
  content         TEXT NOT NULL
  updated_at      TIMESTAMP NOT NULL
  -- No session_id column. Any surviving row at boot is a recovery candidate regardless of origin.
  -- See ADR-07 crash recovery.

log_snapshots
  id              ULID PK
  status          TEXT NOT NULL           -- 'pending' | 'complete'
                                          -- 'pending' rows are deleted on boot before anything else (see ADR-07)
  up_to_hash      TEXT NOT NULL           -- hash of last op included in snapshot
  up_to_seqs      JSON NOT NULL           -- { device_id: seq } frontier map
  data            BLOB NOT NULL           -- zstd-compressed CBOR (see ADR-07)

peer_refs
  peer_id         TEXT PK                 -- device UUID of remote peer
  last_hash       TEXT                    -- hash of last op *received* from this peer in most recent successful sync
  last_sent_hash  TEXT                    -- hash of last op *sent* to this peer in most recent successful sync
  synced_at       TIMESTAMP               -- wall-clock time of last successful sync
  reset_count     INTEGER NOT NULL DEFAULT 0
  last_reset_at   TIMESTAMP nullable

-- Performance caches (see ADR-08 for lifecycle)

tags_cache
  tag_id          ULID PK FK -> blocks(id)
  name            TEXT NOT NULL UNIQUE    -- denormalised from blocks.content
  usage_count     INTEGER NOT NULL DEFAULT 0
  updated_at      TIMESTAMP NOT NULL

pages_cache
  page_id         ULID PK FK -> blocks(id)
  title           TEXT NOT NULL           -- denormalised from blocks.content
  updated_at      TIMESTAMP NOT NULL

agenda_cache
  date            DATE NOT NULL
  block_id        ULID NOT NULL FK -> blocks(id)
  source          TEXT NOT NULL           -- 'property:<key>' or 'tag:<tag_id>'
  PRIMARY KEY (date, block_id)
```

**Indexes:**
```sql
CREATE INDEX idx_blocks_parent      ON blocks(parent_id, deleted_at);
CREATE INDEX idx_blocks_type        ON blocks(block_type, deleted_at);
CREATE INDEX idx_block_tags_tag     ON block_tags(tag_id);
CREATE INDEX idx_block_links_target ON block_links(target_id);
CREATE INDEX idx_block_props_date   ON block_properties(value_date) WHERE value_date IS NOT NULL;
CREATE INDEX idx_op_log_created     ON op_log(created_at);
CREATE INDEX idx_agenda_date        ON agenda_cache(date);
```

---

## ADR-06 — Data Model
**Status:** Phase 1 complete. Phase 4 Wave 1 complete (conflict copies via merge.rs create_conflict_copy). Export (Phase 5) not started.

**Integer position ordering:** `position` is a 1-based integer among siblings sharing the same
`parent_id`. On insert between positions N and N+1, all siblings at position ≥ N+1 are
incremented — emitted as a batch of `move_block` ops. Sibling counts in a personal notes app are
small enough that this compaction is cheap. On sync conflict (two devices independently assign the
same position to different blocks), the materializer resolves by last-writer-wins on `created_at`
with `device_id` as lexicographic tiebreaker, then compacts sibling positions to contiguous 1..n.
Order instability after a position conflict is cosmetic and infrequent.

**Rejected:** Fractional TEXT indexing — adds meaningful implementation complexity (TEXT
comparison correctness, rebalance triggers, sync merge of rebalance batches) for no practical
benefit at the sibling counts a notes app produces.

**Cascade delete and Trash:**
- Deleting any block (`delete_block` op with `cascade: true`) sets `deleted_at` to the same
  timestamp on that block and **all its descendants**, via a recursive CTE walk executed by the
  materializer. A single op covers the entire subtree.
- Deleted blocks and their descendants are visible in a **Trash** view
  (`WHERE deleted_at IS NOT NULL AND is_conflict = 0`).
- **Restore** (`restore_block` op): the materializer clears `deleted_at` on the target block and
  all descendants whose `deleted_at` matches the `deleted_at_ref` timestamp in the op payload.
  Descendants that were independently deleted (different `deleted_at`) are left soft-deleted.
- **Permanent delete** (`purge_block` op): physically removes the block and its descendants.
  Triggered by explicit user action ("Delete permanently") or automatically after 30 days in
  Trash. Purged blocks are absent from subsequent compacting snapshots.
- Deleting a `tag` block does NOT cascade to content blocks that reference the tag. The
  materializer removes `block_tags` rows for the deleted tag; `#[ulid]` tokens in content remain
  but TipTap decorations render them as "deleted tag."

**ID-based references — canonical model:**
All inter-block references in content use ULIDs, never human names. Human names are resolved at
render time by TipTap decorations reading `tags_cache` and `pages_cache`. This means:
- Renaming a tag (editing tag block's `content`) propagates everywhere with no content migration.
- Renaming a page propagates everywhere with no content migration.
- `blocks.content` is always valid UTF-8 text with opaque tokens.
- Export replaces ULIDs with human names at serialisation time.

**Block types:**

| `block_type` | `parent_id` | `position` | `content` |
|---|---|---|---|
| `content` | any block or null | integer | text + `#[ulid]` + `[[ulid]]` |
| `tag` | always null | always null | canonical name (e.g. `work/meeting`) |
| `page` | any block or null | integer | page title |

**Tags:** Tag blocks are first-class blocks. Identity, creation, deletion, and properties all
travel through the op log identically to content blocks. Tag metadata (colour, icon, description)
lives in `block_properties` on the tag block. Tag blocks may be tagged with other tag blocks —
natural consequence of the unified model. This is structural only: tagging `#work/meeting` with
`#important` does not cause blocks tagged `#work/meeting` to appear in an `#important` query.
See ADR-18.

**Tag namespacing:** Hierarchical naming convention (`#work/meeting`) with prefix-aware
`LIKE 'work/%'` search on `tags_cache.name`. No write-time materialisation. `#work` and
`#work/meeting` are independent tag blocks; deleting one has no effect on the other.

**Pages:** Page blocks may have parents — they can be nested under other pages or content blocks.
The page browser lists all page blocks (`WHERE block_type = 'page' AND deleted_at IS NULL`)
regardless of depth. Sort order in the browser is a frontend preference (user settings), not a DB
ordering. Default: reverse ULID (creation time descending).

**Block links:** `[[ulid]]` tokens in content are indexed in `block_links` by the materializer
after each `edit_block` op. Enables backlink queries. Pure read cache — safe to drop and rebuild.

**Non-text content:** `attachments` table, referenced via embed syntax in content. Binary on
filesystem. Sync carries references in op log; binary transfer is a separate Phase 4 concern.

**Templates:** Not a distinct concept. A page block with a conventional name (e.g.
`template/daily`) serves as a template by user convention. No enforcement at schema level.

**90-day op log compaction** into `log_snapshots`. Offline peer past compaction window: see
ADR-09 RESET_REQUIRED protocol.

**Export:** Lossy by design. `#[ulid]` → tag name, `[[ulid]]` → block/page title, properties →
frontmatter YAML, embeds → filename. Round-trip test deferred to Phase 5.

**Conflict copies:** When diffy produces a conflict, a new block is created as a copy of the
conflicting version: `is_conflict = 1`, `conflict_source = original_block_id`. The original block
retains the common ancestor content. User sees both and chooses. On resolution: chosen content →
new `edit_block` on original, conflict copy → `delete_block`.
`WHERE is_conflict = 1 AND deleted_at IS NULL` finds all pending conflicts.

---

## ADR-07 — Operation Log
**Status:** Phase 1 complete (linear chain). Phase 4 Wave 1 complete (DAG traversal, LCA, multi-parent merge ops). Phase 4 Wave 2 complete (snapshot encoding, crash-safe write, RESET apply, 90-day compaction). Sync protocol not started.

**Core principle:** Op log is strictly append-only. `block_drafts` is the only mutable scratch
space. Nothing else bypasses this invariant.

---

### op_log primary key — composite (device_id, seq)

**Problem:** A per-device `seq AUTOINCREMENT` collides when inserting ops received from another
device. Renumbering received ops breaks blake3 hash chains because `seq` is an input to the hash.

**Decision:** Composite PK `(device_id, seq)`.

- `device_id`: UUID v4, generated once on first app launch, stored in a local config file outside
  the database. Never changes.
- `seq` for local ops: `SELECT COALESCE(MAX(seq), 0) + 1 FROM op_log WHERE device_id = local_id`,
  serialised by the single write connection — no race.
- Received ops: inserted verbatim with their original `(device_id, seq)`. No renumbering. No
  collision.
- Hash: `blake3(device_id || seq || parent_seqs_canonical || op_type || payload_canonical)`.
  `parent_seqs_canonical` is the JSON array sorted by `[device_id, seq]` lexicographically for
  deterministic hashing. Computed at origin, verifiable anywhere.
- `created_at` is a display hint, not a merge ordering key.

---

### `parent_seqs` — causal tracking from Phase 1

`op_log.parent_seqs` is a JSON array of `[device_id, seq]` pairs, present from Phase 1.

- **Phase 1–3 (linear):** null for the genesis op on a fresh device; otherwise a single-entry
  array `[[device_id, seq]]` pointing to the immediately preceding local op.
- **Phase 4+ (DAG):** merge ops may carry multiple entries, one per causal parent (one from each
  syncing device at the merge point).

No schema migration is required at Phase 4 — the column already exists and accepts multi-entry
arrays. Only the write and read logic changes.

---

### Op payload schemas

All `op_log.payload` values are JSON objects. Canonical field definitions:

```
create_block {
  block_id:   ULID
  block_type: "content" | "tag" | "page"
  parent_id:  ULID | null
  position:   integer | null          -- null for tag blocks
  content:    string                  -- Markdown string for 'content' blocks (see ADR-20);
                                      -- plain name string for 'tag' and 'page' blocks
}

edit_block {
  block_id:   ULID
  to_text:    string                  -- full new Markdown content (see ADR-20); passed directly
                                      -- to diffy::merge() — no preprocessing needed since
                                      -- Markdown is plain text and tokens are space-free words
  prev_edit:  [device_id, seq] | null -- the (device_id, seq) of the edit_block or create_block
                                      -- op that this edit is directly based on, as known by the
                                      -- writing device. Null only if the writing device has no
                                      -- prior edit for this block (unusual; treated as based on
                                      -- create_block). Used for per-block LCA during merge.
}

delete_block {
  block_id: ULID
  cascade:  true                      -- always true; descendants soft-deleted by materializer
}

restore_block {
  block_id:       ULID
  deleted_at_ref: string              -- ISO 8601 timestamp matching the deleted_at set by the
                                      -- original delete op. Descendants with this exact
                                      -- deleted_at are restored; independently deleted
                                      -- descendants (different deleted_at) are left soft-deleted.
}

purge_block {
  block_id: ULID                      -- physical delete of block and all descendants; irreversible
}

move_block {
  block_id:      ULID
  new_parent_id: ULID | null
  new_position:  integer
}

add_tag {
  block_id: ULID
  tag_id:   ULID
}

remove_tag {
  block_id: ULID
  tag_id:   ULID
}

set_property {
  block_id:   ULID
  key:        string
  value_text: string | null
  value_num:  number | null
  value_date: string | null           -- ISO 8601 timestamp
  value_ref:  ULID | null
  -- Exactly one value field is non-null.
}

delete_property {
  block_id: ULID
  key:      string
}

add_attachment {
  attachment_id: ULID
  block_id:      ULID
  mime_type:     string
  filename:      string
  size_bytes:    integer
  fs_path:       string
}

delete_attachment {
  attachment_id: ULID
}
```

**`from_text` — considered and rejected:** storing the previous content alongside `to_text` was
considered to enable cross-flush undo. It was rejected because: (1) cross-flush Ctrl+Z is
intentionally not supported (see ADR-02); (2) the previous state is always reconstructable as the
`to_text` of the prior op in the per-block edit chain, available in the history panel; (3) it
would double op log storage for every text edit. No capability is lost by its absence.

**`create_link` / `delete_link` — not op types:** `block_links` is a materializer-maintained
read cache derived from `[[ulid]]` tokens in content. It is never written by ops directly.

---

### Write rules by op type

| Op type | When written |
|---------|--------------|
| `create_block` | Immediately on block creation |
| `delete_block` | Immediately; materializer cascades soft-delete to descendants |
| `restore_block` | Immediately; materializer reverses cascade for matching `deleted_at_ref` |
| `purge_block` | Immediately; materializer physically removes block and descendants |
| `move_block` | Immediately; emitted as a batch for position compaction (see ADR-06) |
| `add_tag`, `remove_tag` | Immediately |
| `set_property`, `delete_property` | Immediately |
| `add_attachment`, `delete_attachment` | Immediately |
| `edit_block { block_id, to_text, prev_edit }` | On blur or window focus loss. If `to_text` contains `\n`, flush emits one `edit_block` for the first segment and one `create_block` per subsequent segment, in order. Tags and properties stay with the first segment; `block_links` for all segments are re-derived by the materializer from each segment's content. |

---

### Draft lifecycle

- Every ~2 s during active typing → `INSERT OR REPLACE` into `block_drafts` (one row per block,
  always overwritten).
- On blur / window focus loss → write `edit_block` op, delete the `block_drafts` row.
- Drafts never participate in sync, undo, or compaction.

**Crash recovery at boot** (runs before any user-visible UI):
1. Read all rows from `block_drafts`.
2. For each row: check for an `edit_block` op in `op_log` for this `block_id` with
   `created_at >= block_drafts.updated_at`.
3. If none found: the draft was not flushed. Determine `prev_edit` as the latest `edit_block` or
   `create_block` op for this `block_id` in `op_log`. Apply the draft as a synthetic `edit_block`
   op with that `prev_edit`. Log a warning.
4. Delete the draft row regardless of outcome.

Any surviving draft row at boot is a recovery candidate. Clean shutdown always deletes draft rows.

---

### Text ancestor reconstruction and merge (Phase 4)

**Problem:** `diffy::merge(ancestor_text, ours, theirs)` requires the common ancestor text for
two concurrent `edit_block` ops on the same block.

**Per-block edit chain:** Every `edit_block` op carries `prev_edit: [device_id, seq] | null` —
a pointer to the edit this op was directly based on. This forms a per-block DAG embedded in the
global op log, independent of the global `parent_seqs` causality structure.

**Lowest Common Ancestor algorithm:**

```
fn find_lca(op_a: (device_id, seq), op_b: (device_id, seq)) -> AncestorText:
  // Collect all ancestors of op_a by following prev_edit pointers.
  ancestors_a = BTreeSet::new()
  cursor = op_a
  loop:
    ancestors_a.insert(cursor)
    payload = op_log[cursor].payload
    match payload.prev_edit:
      None  => break   // reached create_block root
      Some(p) => cursor = p

  // Walk op_b's chain; first node found in ancestors_a is the LCA.
  cursor = op_b
  loop:
    if cursor in ancestors_a:
      return text_at(cursor)
    payload = op_log[cursor].payload
    match payload.prev_edit:
      None  => return text_at(create_block for this block_id)
      Some(p) => cursor = p

fn text_at(op: (device_id, seq)) -> string:
  match op_log[op].op_type:
    "edit_block"   => op_log[op].payload.to_text
    "create_block" => op_log[op].payload.content
```

**Complexity:** O(chain depth) — the number of `edit_block` ops for a single block. Trivially
fast for any realistic note-taking workload. No graph library required.

**Phase 1–3:** `prev_edit` is written correctly from Phase 1 but the LCA algorithm is never
invoked — a linear single-device log has no concurrent edits to merge.

---

### `log_snapshots` — write sequence and boot cleanup

**Write sequence (atomic relative to crash):**
1. `INSERT INTO log_snapshots ... status = 'pending'` — row committed before expensive work.
2. Compress block tables to CBOR, write to `data` column in the same transaction.
3. `UPDATE log_snapshots SET status = 'complete' WHERE id = ?` — only reached if step 2 succeeds.

**Boot cleanup (first thing on every application start, before draft recovery):**
```sql
DELETE FROM log_snapshots WHERE status = 'pending';
```
A `'pending'` row means the process crashed between step 1 and step 3. Its `data` may be
incomplete. Deleting it is always safe: the full op log is available for replay, and a new
snapshot will be written on the next compaction cycle.

---

### `log_snapshots.data` format

**Decision:** zstd-compressed CBOR encoding of all materialised table rows at the compaction
point.

**CBOR document structure:**
```
{
  schema_version:     u32,
  snapshot_device_id: string,
  up_to_seqs:         { device_id: seq, ... },  -- op frontier
  up_to_hash:         string,
  tables: {
    blocks:           [...],
    block_tags:       [...],
    block_properties: [...],
    block_links:      [...],
    attachments:      [...],
  }
}
```

Cache tables (`tags_cache`, `pages_cache`, `agenda_cache`, FTS5) are **not included** — they
rebuild from core tables on first boot after a RESET.

**Applying a snapshot (RESET path):**
1. Wipe `blocks`, `block_tags`, `block_properties`, `block_links`, `attachments`, `op_log`, all
   cache tables.
2. Decompress + decode CBOR.
3. Insert all rows from snapshot tables.
4. Replay tail ops (after `up_to_seqs` frontier) received from peer.
5. Trigger background cache rebuilds and one FTS5 `optimize` pass. UI shows skeleton until ready.

**Rejected:** SQLite backup API dump (large, version-coupled, includes cache tables), full op log
replay from op 1 (correct but slow on large datasets), JSON instead of CBOR (2–5× larger for
binary data).

---

## ADR-08 — Materializer
**Status:** Phase 1 complete (queues, caches, pagination). Phase 3 complete (FTS5 maintenance, tag query materializer, queue monitoring). Status View exposed via get_status command.

**Priority queues:**
- Foreground queue: viewport blocks — low latency.
- Background queue: `tags_cache`, `pages_cache`, `agenda_cache`, `block_links` index, FTS5 index,
  FTS5 maintenance, orphan GC.

**Tag resolution:** Prefix-aware `LIKE` on `tags_cache.name`. No graph traversal.

**Boolean tag queries:** `TagExpr` tree + `FxHashSet` in Rust for complex expressions. `SQL LIKE`
for simple prefix lookups.

**Single write connection** ensures materializer operations are serialised.

**Pagination:** All list queries are paginated — cursor-based or keyset, never offset. No "fetch
all and filter in Rust." Enforced from Phase 1.

**Cache strategy — stale-while-revalidate:** Caches never rebuilt synchronously on the hot path
or at boot. Always return last computed value immediately, enqueue background rebuild if stale.
Cold boot returns a loading sentinel; UI renders skeleton.

---

### block_links — maintenance

The `block_links` table is a materializer-maintained index of `[[ulid]]` tokens. Not written by
the op log directly.

**Trigger:** Any `edit_block` op. The materializer:
1. Parses `to_text` for all `[[ulid]]` tokens via regex `\[\[([0-9A-Z]{26})\]\]`.
2. Diffs against previously indexed tokens for this `source_id`.
3. Deletes removed links, inserts new links.

**Backlink query:**
```sql
SELECT b.* FROM block_links bl
JOIN blocks b ON b.id = bl.source_id
WHERE bl.target_id = ? AND b.deleted_at IS NULL
```
Surfaced in the backlinks panel (Phase 2).

---

### agenda_cache — specification

**Purpose:** Materialise blocks carrying a date for the journal agenda view.

**Triggers an entry:**
- `block_properties` row with `value_date IS NOT NULL` → `source = 'property:<key>'`
- `block_tags` row where the referenced tag block's name matches `date/YYYY-MM-DD` →
  `source = 'tag:<tag_id>'`

**Rebuild triggers:** `set_property`, `delete_property`, `add_tag`, `remove_tag`, `delete_block`.
Full recompute. Staleness threshold: 2 s.

**Query:** `SELECT block_id FROM agenda_cache WHERE date BETWEEN ? AND ? ORDER BY date`.

---

### tags_cache — specification

**Purpose:** Fast `#[ulid]` autocomplete and tag browsing.

**Rebuild triggers:** `create_block` / `delete_block` / `restore_block` with `block_type = 'tag'`,
or any `add_tag` / `remove_tag`. Full recompute:

```sql
SELECT b.id AS tag_id, b.content AS name, COALESCE(t.cnt, 0) AS usage_count
FROM blocks b
LEFT JOIN (
  SELECT tag_id, COUNT(*) AS cnt FROM block_tags GROUP BY tag_id
) t ON t.tag_id = b.id
WHERE b.block_type = 'tag' AND b.deleted_at IS NULL
```

The `LEFT JOIN` from `blocks` ensures tags with zero usage (newly created, never applied) appear
in the cache. A plain `GROUP BY block_tags.tag_id` would omit them. Staleness threshold: 5 s.

---

### pages_cache — specification

**Purpose:** Fast `[[ulid]]` autocomplete and page picker.

**Rebuild triggers:** `create_block` / `delete_block` / `restore_block` / `edit_block` where
`block_type = 'page'`. Full recompute. Staleness threshold: 5 s.

---

### FTS5 index maintenance

The FTS5 virtual table accumulates segment files as content is inserted and updated. Without
periodic maintenance, segment count grows and search performance degrades.

**Scheduled maintenance (background queue):**
- After every 500 `edit_block` ops processed by the materializer, or every 60 minutes of active
  use (whichever comes first):
  ```sql
  INSERT INTO fts_blocks(fts_blocks) VALUES('optimize');
  ```
  This merges all segments into one b-tree, restoring O(log n) lookup.
- After a RESET_REQUIRED sync: run `optimize` once immediately after the FTS5 index is fully
  rebuilt from the snapshot.

**Rejected:** `optimize` after every op (too costly on bulk import); `optimize` only on user
request (invisible degradation on long-running installs).

---

**Status View** (settings panel / persistent indicator):
- Materializer queue depths (foreground, background)
- `agenda_cache`, `tags_cache`, `pages_cache` staleness
- FTS5 index status and last `optimize` timestamp
- Orphan GC last run
- Property conflict auto-resolutions since last sync (count + per-block detail)
- Phase 4+: sync state, per-peer last sync time, reset history

Reads from in-memory state struct — no additional DB queries.

---

## ADR-09 — Sync
**Status:** Not started. Schema ready (peer_refs table, parent_seqs DAG support, device UUID). Phase 4.

**Discovery:** mDNS on local network. Initiating device generates session passphrase.

**Pairing — per-session word passphrase + QR code:**
- Host generates a 4-word EFF large wordlist passphrase (~51 bits entropy) per session.
  Ephemeral — discarded after pairing or 5-minute timeout.
- Host displays QR code (passphrase + host address) and 4-word text. Both paths derive identical
  session keys.
- Rejected: persistent shared passphrase (hard to rotate), SPAKE2 (correct but adds a crypto
  dependency for marginal gain at this threat model).

**Transport:** tokio-tungstenite + rustls.

**Protocol:**
1. Exchange heads: latest `(device_id, seq, hash)` per device known to each peer.
2. Walk `parent_seqs` DAG back to find common ancestor.
3. If peer's last known op predates oldest retained op and no snapshot covers it →
   **RESET_REQUIRED**.
4. Otherwise → stream diverging ops. Receiver inserts with original `(device_id, seq)` via
   `INSERT OR IGNORE` (duplicate delivery is idempotent).
5. Receiver writes a merge op whose `parent_seqs` contains one entry per syncing device.
6. On successful completion → update `peer_refs` atomically (see below).

**`peer_refs` maintenance:**

| Column | Updated when | Value |
|--------|-------------|-------|
| `last_hash` | End of every successful sync | Hash of the last op *received* from this peer. Starting point for next sync — ops after this hash are new. |
| `last_sent_hash` | End of every successful sync | Hash of the last op *sent* to this peer. Avoids re-sending already-transferred ops on reconnect. |
| `synced_at` | End of every successful sync | Wall-clock timestamp, updated atomically with the two hashes. |
| `reset_count` | RESET_REQUIRED sync completes | Incremented by 1. |
| `last_reset_at` | RESET_REQUIRED sync completes | Set to current timestamp. |

On sync failure (connection lost mid-stream): `peer_refs` is **not** updated. The next sync
restarts from `last_hash`. Duplicate op delivery is safe due to `INSERT OR IGNORE` on the
composite PK.

**Offline peer / compaction reset:**
UI: *"[Device name] has been offline too long to sync incrementally. Reset this device's data
from [peer]?"* — explicit confirm, no silent replacement. On confirm: wipe local state, receive
and apply snapshot per ADR-07. `peer_refs.reset_count` incremented.

---

### Conflict resolution

**Text conflicts:**
- Non-overlapping edits: `diffy::merge(ancestor_text, ours, theirs)` → `Ok(String)`. Written as
  new `edit_block` op. Invisible to user.
- Overlapping / ambiguous edits: diffy returns `Err(MergeConflict)`. Original block retains
  common ancestor content. A conflict copy is created: `is_conflict = 1`,
  `conflict_source = original_block_id`, content = conflicting version. Both visible to user. On
  resolution: chosen content → new `edit_block` on original; conflict copy → `delete_block`.

**Property conflicts:**
Two `set_property` ops for the same `(block_id, key)` that are causally concurrent are resolved
silently: **last-writer-wins on `created_at`**, with `device_id` as lexicographic tiebreaker.
No block duplication. Auto-resolutions logged to in-memory audit list visible in Status View.

**Non-text content:** `[[ulid]]` and `#[ulid]` tokens are opaque words to diffy. Two sides
modifying the same token → conflict copy path, identical to text.

**Attachment binary transfer:** Separate file-sync step after op streaming. Op log carries
reference only.

---

## ADR-10 — CRDT / Conflict Strategy
**Status:** Phase 4 Wave 1 complete (merge.rs: diffy integration, conflict copy, property LWW, merge_block orchestrator). Sync-triggered merge execution not started (Phase 4 Wave 5).

**Decision:** Three-way merge via `diffy` crate at word-level granularity, not a CRDT library.

**Rejected:**
- `yrs` (Yjs port): significant complexity, not needed for local WiFi sync.
- `automerge-rs`: same reason, overkill for v1.
- `similar`: no first-class three-way merge API.
- Last-write-wins for text: correctness debt expensive to fix post-sync.

**`diffy` specifics:**
- Call: `diffy::merge(ancestor_text, ours_text, theirs_text)`.
- Returns `Ok(String)` on clean merge, `Err(MergeConflict)` on ambiguous overlap.
- Word-level granularity: correct for single-paragraph prose blocks.
- Markdown marks (`**`, `*`, `` ` ``) are plain ASCII characters treated as word boundaries by
  diffy. Two sides modifying different words within a marked span → clean merge. Two sides both
  modifying the same mark delimiters → conflict copy path, same as text.
- `#[ULID]` and `[[ULID]]` tokens contain no whitespace — treated as single opaque words.
  Two sides modifying different tokens → clean merge. Two sides modifying the same token →
  conflict copy path.
- Markdown is plain text; no preprocessing or extraction is required before passing to diffy.
  The merged result is a valid Markdown string that the serializer can parse directly.
- Ancestor text reconstruction: per-block LCA algorithm in ADR-07.

---

## ADR-11 — Rust Libraries
**Status:** Phase 1 complete. Phase 4: diffy, zstd, ciborium added.

| Library | Phase | Purpose |
|---------|-------|---------|
| sqlx + sqlx-cli | 1+ | SQLite async, compile-time query validation, migrations |
| thiserror + anyhow | 1+ | Error handling |
| blake3 | 1+ | Op log hash chaining |
| FxHashMap | 1+ | Fast hash maps for hot paths |
| specta + tauri-specta | 2+ | TypeScript type generation from Tauri commands |
| diffy | 4+ | Word-level three-way text merge |
| zstd | 4+ | Snapshot compression |
| ciborium | 4+ | CBOR serialisation for log_snapshots |
| tokio-console | On demand | Async debugging; not a baseline dep |

**Removed from prior version and rationale:**
- `rusqlite`: replaced by sqlx from Phase 1. No migration milestone needed.
- `deadpool-sqlite`: unnecessary; sqlx pool handles both read concurrency and the single write
  connection from day one.
- `fractional_index` (internal crate): replaced by plain integer positions (see ADR-06). Integer
  ordering is correct, simpler, and adequate at the sibling counts this app produces.
- `bon`, `petgraph`, `similar`, `slotmap`: never needed.

---

## ADR-12 — Search
**Status:** Phase 3 complete (FTS5 virtual table, strip pass, scheduled optimize, search command, SearchPanel UI, CJK notice). Tantivy/lindera (Phase 5) not started.

**v1:** SQLite FTS5. Adequate for non-CJK text. CJK limitations documented in ADR-19.

**Phase 5+:** Tantivy + lindera. Lindera dictionaries are optional downloads on Android, not
bundled.

---

## ADR-13 — Dev Tooling
**Status:** Phase 1.5 complete (insta snapshots). Phase 2 complete (Playwright E2E). Phase 3 complete (cargo-nextest, FTS5 benchmarks). `.sqlx/` offline cache active (82 query files committed); `cargo sqlx prepare --check` ready for CI.

| Tool | When | Notes |
|------|------|-------|
| Biome | Day one | Replaces ESLint + Prettier |
| GitHub Actions + tauri-action | Day one | CI before features |
| Vitest | Day one | Frontend unit tests |
| cargo test | Phase 1+ | |
| cargo-watch | Phase 1+ | Dev loop |
| sqlx-cli prepare | Phase 1+ | `.sqlx/` offline cache committed to repo |
| Playwright + tauri-driver | Phase 2+ | E2E tests |
| insta (snapshot tests) | Phase 2+ | Wait for stable schema |
| cargo-nextest | Phase 3+ | When suite is large enough to feel slow |
| tokio-console | On demand | Not a baseline dep |

**CI gates:**
- `cargo test` always.
- `cargo sqlx prepare --check`: fails if `.sqlx/` offline query cache is stale. Active from
  Phase 1.
- specta export diff check: fails if generated TypeScript types are dirty. Active from Phase 2.

---

## ADR-14 — API
**Status: N/A.** Dropped for v1.

Dropped for v1. Deferred indefinitely.

---

## ADR-15 — Encryption at Rest
**Status: FULLY IMPLEMENTED.** Decision-only ADR; no application code required.

**Decision:** Filesystem-level only (Android FBE, Linux LUKS / dm-crypt).

**Rejected:** SQLCipher — key derivation complexity, passphrase UX, platform keychain integration
for marginal benefit.

**Threat model:** Device theft. SQLite file is plaintext on disk.

---

## ADR-16 — Build Order & Timeline
**Status:** Planning ADR. Phase 1 and Phase 1.5 complete.

| Phase | Scope | Estimate |
|-------|-------|----------|
| 1 — Foundation | Schema (tags/pages as blocks, composite op_log PK, `parent_seqs` from day 1, integer positions), linear op log, materializer foreground + background queues, `tags_cache`, `pages_cache`, `agenda_cache`, sqlx + sqlx migrate from day 1, CI (Biome + cargo test + sqlx prepare check). Linux only. Data model locked here. | 6–8 weeks |
| 1.5 — Daily Driver | Block CRUD, roving TipTap, Markdown serializer (ADR-20) with full test suite, `#[ulid]` / `[[ulid]]` inline picker, bold/italic/inline-code marks, flat tagging, journal view, auto-split on blur, Trash + restore. **Android spike at end of phase** (includes serializer round-trip validation). | 4–6 weeks + 4–8 weeks real use |
| 2 — Full Editor | Block links + backlinks panel, history panel (per-block edit chain via `prev_edit`), move / merge / indent, cross-block paste, conflict resolution UI, Status View. specta introduced. | 8–12 weeks |
| 3 — Search | FTS5 + scheduled `optimize`, boolean tag queries, cargo-nextest. | 3–4 weeks |
| 4 — Sync + Android | mDNS, passphrase / QR pairing, op streaming, diffy merge, DAG log (schema already supports it), LCA ancestor algorithm, snapshot format, Android full. XState + TanStack Query. | 12–16 weeks |
| 5 — Polish | i18n, CJK search (Tantivy + lindera, ADR-19), export (ADR-20 — ULID → name substitution, Markdown output), auto-updates, graph view. | 6–8 weeks |

**Total at ~10 h/week:** 12–18 months. Daily driver by month 3–4.

**Non-negotiable:** op log append-only invariant, materializer CQRS split, three-way merge for
sync, pagination on all list queries.

---

## ADR-17 — Graph View (Deferred)
**Status: N/A.** Deferred to Phase 5+. Schema supports it (block_links table).

**Decision:** Out of scope for v1. Block and tag relationships are already in the schema; the
graph view is a visualisation layer only. Deferred to Phase 5+.

**Rejected for v1:** D3, Cytoscape. If built: react-force-graph on WebGL canvas.

---

## ADR-18 — Tag Inheritance — Closed, Not Planned
**Status: CLOSED.** Will not be implemented. Prefix-aware LIKE search covers the use case.

**Decision:** Tag inheritance via query propagation will not be implemented.

**What it would have been:** A query for `#work` automatically including results tagged
`#work/meeting`, `#work/email` etc. via graph traversal at query time.

**Why closed:**
- Prefix-aware search (`LIKE 'work/%'` on `tags_cache.name`) covers the org-mode use case in the
  vision. This is the Obsidian model and is sufficient.
- True query-time inheritance requires graph traversal in the materializer hot path and fan-out
  on rename. Complexity is not justified.
- The explicit model is cleaner and predictable: to match all sub-tags, use the `#work/` prefix.

**Tag-on-tag:** Tag blocks may be tagged with other tag blocks — natural consequence of the
unified block model. Its meaning is user-defined and has no effect on query semantics.

**Structural behaviour of tag deletion:** `#work` and `#work/meeting` are independent tag blocks
sharing only a name prefix, not a tree. Deleting one has no effect on the other. `block_tags`
rows referencing the deleted tag are removed by the materializer; `#[ulid]` tokens in content
that pointed to the deleted tag render as "deleted tag" decoration in TipTap.

---

## ADR-19 — CJK Support: Limitations and Roadmap
**Status:** v1 limitations documented and accepted. Tantivy + lindera planned for Phase 5.

### v1 limitations (explicit)

**Full-text search is broken for CJK in v1.** Known and accepted, not an oversight.

SQLite FTS5 `unicode61` tokenizer splits on Unicode word boundaries. CJK scripts have no
word-boundary characters — adjacent characters produce single-character tokens or no useful
tokens. Searching `会議` returns noise.

**v1 CJK status by feature:**

| Feature | Status |
|---------|--------|
| Render CJK text | ✅ Noto Sans bundled |
| Type CJK via IME | ✅ ProseMirror composition events; validated by Android spike |
| Store CJK content | ✅ Plain UTF-8 |
| Tag with CJK names | ✅ SQLite LIKE works on Unicode |
| Full-text search CJK | ❌ FTS5 unicode61 produces noise |
| Full-text search CJK (Phase 5) | ✅ Tantivy + lindera |

**Mitigation considered — FTS5 trigram tokenizer:**
SQLite 3.34+ ships a `trigram` tokenizer enabling CJK substring search with no additional
dependencies. Index size is ~3× larger than `unicode61`. **Rejected for v1:** index size is
material on Android storage. Noted as a viable interim option (recreate the FTS5 virtual table
only; no schema migration) if CJK demand arises before Phase 5.

### Phase 5: Tantivy + lindera

**Tantivy:** Rust full-text search library with pluggable tokenizers.

**lindera:** Rust morphological analyser — Japanese (IPAdic), Chinese (CC-CEDICT), Korean
(KoDic). Linguistically-aware tokenisation: `会議室` → `["会議", "室"]`.

**Implementation:**
- Tantivy index lives on disk alongside SQLite. Source of truth remains op log + materialised
  blocks.
- Background materializer queue maintains the Tantivy index with stale-while-revalidate.
- lindera dictionaries are optional downloads, not bundled.
- FTS5 retained for non-CJK text during transition window. Both indexes maintained in parallel.

**Dictionary sizes and Android strategy:**

| Language | Dictionary | Size |
|----------|------------|------|
| Japanese | IPAdic | ~18 MB |
| Japanese | IPADIC-NEologd | ~130 MB |
| Chinese | CC-CEDICT | ~8 MB |
| Korean | KoDic | ~8 MB |

Base APK ships with no dictionaries. First CJK search triggers: *"Better search for
Japanese / Chinese / Korean is available. Download language data? (~18 MB)"* Stored in
app-private storage. IPAdic and CC-CEDICT are priority targets. IPADIC-NEologd is optional, off
by default.

On Linux: dictionaries bundled in package or downloaded on first use, depending on distribution
packaging constraints.

---

## ADR-20 — Content Storage Format
**Status:** Phase 1.5 complete (serializer, types, TipTap integration). Phase 3: FTS5 strip pass complete. diffy integration complete (Phase 4). Export (Phase 5) not started.

**Decision:** Markdown with a locked inline mark set and two custom ULID token extensions.
TipTap serializes to and from this format on every focus/blur cycle via a custom serializer.

---

### Storage grammar

```
block_content  := span*
span           := plain_text | bold | italic | code_span | tag_ref | block_link
bold           := '**' span+ '**'
italic         := '*' span+ '*'
code_span      := '`' plain_text '`'        -- no nesting inside code spans
tag_ref        := '#[' ULID ']'
block_link     := '[[' ULID ']]'
plain_text     := UTF-8 text not starting a token or mark delimiter
ULID           := [0-9A-Z]{26}              -- Crockford base32, exactly 26 chars
```

**Constraints:**
- No block-level Markdown (no `#` headings, no `-` lists, no `>` blockquotes, no `---` rules).
  These constructs are expressed as block structure, not as Markdown syntax within a block.
- No `\n\n` paragraph breaks. Every `\n` is a block split boundary. The serializer must not emit
  double newlines for any node type.
- No nested bold-in-bold or italic-in-italic. The parser is not required to handle these and the
  serializer will not produce them.
- `code_span` content is treated as plain text — marks and tokens inside backticks are not parsed.

**Inline mark set is locked.** Adding any mark (strikethrough, highlight, underline, superscript,
etc.) requires a new ADR covering: serializer extension, FTS5 stripping, export mapping, and a
migration audit of existing content.

---

### Serializer design

The serializer is a standalone TypeScript module (`src/editor/markdown-serializer.ts`) with no
dependency on `tiptap-markdown` or any Markdown library. It converts between ProseMirror
document nodes and the storage grammar above.

**ProseMirror node → Markdown string (serialize):**

| ProseMirror node/mark | Output |
|---|---|
| `text` node | raw text (escape `*`, `**`, `` ` ``, `#[`, `[[` when literal) |
| `bold` mark | `**...**` |
| `italic` mark | `*...*` |
| `code` mark | `` `...` `` |
| `tag_ref` inline node, attr `id` | `#[{id}]` |
| `block_link` inline node, attr `id` | `[[{id}]]` |
| `hardBreak` node | `\n` (triggers auto-split; not `<br>`) |
| `paragraph` wrapper (from paste) | content only; no surrounding newlines |
| any unknown node | stripped; warning logged |

**Markdown string → ProseMirror document (parse):**
Hand-rolled single-pass parser. Regex used only for token identification (`#[` and `[[`), not for
the full parse. Marks are tracked as a stack; mismatched or unclosed marks are passed through as
plain text rather than erroring.

**Escape rules:**
A literal `*` that is not a mark delimiter is stored as `\*`. A literal `` ` `` is stored as
`` \` ``. A literal `#[` not followed by a valid ULID and `]` passes through unescaped — the
token regex requires exactly 26 Crockford base32 characters, so false positives are impossible
in practice. No escape is needed for `[[` that is not followed by a valid ULID and `]]`.

---

### Integration with TipTap

**On mount:**
```
const doc = markdownSerializer.parse(block.content);
editor.commands.setContent(doc);
```

**On unmount (flush):**
```
const markdown = markdownSerializer.serialize(editor.getJSON());
if (markdown !== block.content) {
  emit('edit_block', { block_id: block.id, to_text: markdown, prev_edit: ... });
}
```

**Custom inline nodes (`tag_ref`, `block_link`):**
Defined as TipTap extensions with `atom: true` and `inline: true`. The picker extension
intercepts `#` and `[[` keystrokes and opens the autocomplete UI. On selection, a `tag_ref` or
`block_link` node is inserted with the chosen ULID as the `id` attribute. The node renders as a
chip showing the resolved name from `tags_cache` / `pages_cache`. The raw ULID is never visible
to the user during editing.

---

### Integration with diffy (Phase 4)

`blocks.content` is passed to `diffy::merge()` as-is. No extraction or transformation is needed.
Markdown marks are ASCII word-boundary characters; diffy handles them at word granularity.
ULID tokens are space-free 28-character strings treated as single words. A merged result from
diffy is always a valid storage-format string parseable by the serializer.

---

### FTS5 indexing

The FTS5 index must strip Markdown syntax before indexing to avoid searching for `**` or `*`.
The materializer applies a lightweight strip pass before inserting into the FTS5 table:
- Remove `**`, `*`, `` ` `` mark delimiters.
- Replace `#[ULID]` tokens with the resolved tag name from `tags_cache` (enables tag-name search).
- Replace `[[ULID]]` tokens with the resolved page title from `pages_cache`.

This strip pass is non-lossy for search purposes — the original Markdown is preserved in
`blocks.content`.

---

### Export

On export, the serializer emits the storage Markdown string with ULIDs replaced by human names:
- `#[ULID]` → `#tagname` (from `tags_cache`)
- `[[ULID]]` → `[[Page Title]]` (from `pages_cache`)

This produces standard Markdown + Obsidian-style wikilinks, readable in any Markdown editor.
Round-trip import (Markdown → blocks with ULID tokens) is deferred to Phase 5.

---

### Rejected alternatives

**ProseMirror JSON storage:** TipTap's native format. Eliminates the serializer entirely but
breaks `diffy` integration — JSON diff on ProseMirror output operates on structural keys, not
text content. Re-applying a merged JSON diff to a document is non-trivial and lossy when
structure diverges between branches. Also 4–5× more storage per block. Rejected.

**`tiptap-markdown` package:** Community extension handling the full Markdown spec. Has known
edge cases, does not support `#[ULID]` / `[[ULID]]` tokens, and has an uncertain maintenance
trajectory. A scoped custom serializer is ~150 lines, fully owned, and trivially testable.
Rejected.

**CodeMirror 6:** Treats Markdown as its native format — no round-trip needed. However,
WYSIWYG token chips (hiding the raw ULID, showing the resolved name) require `atomicRanges`
replace decorations, which have known cursor boundary bugs. ProseMirror inline nodes are the
correct model for this interaction. CodeMirror is the right tool for a source-visible editor;
this app is WYSIWYG. Rejected.

---

## UX Review Notes (2026-03-31)

Comprehensive UX review of the Journal and Outliner identified architectural issues. Decisions
recorded here after user review.

### Auto-split on blur — KEEP AS IS

**Decision:** Keep current auto-split behavior. Accept paste-split as a trade-off for the
"write prose freely, get structure on exit" mechanic. No ADR amendment needed.

### Cross-block undo — KEEP AS IS (per ADR-02)

**Decision:** Keep undo scoped per block mount. Op-level undo/redo as designed in ADR-02.
History panel remains the deliberate revert mechanism for cross-block changes.

### Collapse state persistence — KEEP AS IS

**Decision:** Keep ephemeral collapse state. Not a priority.

### Monthly journal view — OPTIMIZE PERFORMANCE, KEEP STACKED LAYOUT

**Decision:** Keep the stacked day-section layout but optimize performance. Do NOT replace with
calendar grid. Lazy-load BlockTree components for off-screen days. The resolve cache
centralization (see below) eliminates the per-BlockTree preload overhead.

### BlockTree component size — DECOMPOSE

**Decision: Approved.** Extract into smaller hooks:
- `useBlockResolve()` — resolve cache management
- `useBlockDnD()` — DnD state and handlers
- `useBlockProperties()` — property fetch and task state
- Keep BlockTree as the orchestrator.

### N+1 property fetch — ADD BATCH COMMAND

**Decision: Approved.** Add `get_batch_properties` Tauri command accepting `Vec<String>` block
IDs, returning `HashMap<String, Vec<PropertyRow>>`. Uses `json_each()` pattern from
`batch_resolve_inner`. Include benchmark tests matching existing command bench coverage.

### Resolve cache duplication — CENTRALIZE TO ZUSTAND STORE

**Decision: Approved.** Move the resolve cache to a Zustand store (`stores/resolve.ts`). Fetch
once on boot via `preload()`. Update incrementally on block creation/edit/delete. Both
JournalPage and BlockTree consume from the same store — no more duplicate `listBlocks` calls.
