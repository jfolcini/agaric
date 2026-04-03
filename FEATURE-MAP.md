# Agaric — Complete Feature Map

**Local-first block-based note-taking app** inspired by Org-mode and Logseq.
React + TipTap frontend, Rust + SQLite backend via Tauri 2. Append-only op log with CQRS materializer for offline-first sync.

---

## 1. Architecture Overview

| Layer | Stack |
|-------|-------|
| **Frontend** | React 18, TipTap/ProseMirror, Zustand (7 stores), @dnd-kit, Tailwind CSS v4, shadcn/ui + Radix |
| **Backend** | Rust, Tauri 2, SQLite (WAL mode), async Tokio |
| **Sync** | Local WiFi, mDNS discovery, WebSocket + TLS, ECDSA P-256 cert pinning |
| **Data integrity** | blake3 hash chains, three-way merge (diffy), zstd+CBOR snapshots |
| **Testing** | Vitest (~2937 tests), cargo nextest (~850 tests), Playwright (14 E2E specs), fast-check, insta snapshots, Criterion benchmarks |

### Key Invariants

- Op log is strictly append-only (never mutate, never delete except compaction)
- CQRS split: commands write ops, materializer writes derived state
- Cursor-based keyset pagination on ALL list queries (no offset)
- Single roving TipTap instance
- Biome only (no ESLint/Prettier)
- sqlx compile-time queries with committed `.sqlx/` cache
- PRAGMA foreign_keys = ON on every connection
- ULID uppercase normalization (Crockford base32 for blake3 hash determinism)

---

## 2. Database Schema

**16 migration files**. **14 tables + 1 FTS5 virtual table**. **21+ indexes**.

### Core Tables

| Table | PK | Purpose |
|-------|----|---------|
| `blocks` | `id` (ULID) | Unified entity: content, page, or tag. Columns: block_type, content, parent_id, position, deleted_at, archived_at, is_conflict, conflict_source, todo_state, priority, due_date, scheduled_date |
| `block_tags` | `(block_id, tag_id)` | Tag-to-block associations |
| `block_properties` | `(block_id, key)` | Typed key-value properties (value_text, value_num, value_date, value_ref) |
| `block_links` | `(source_id, target_id)` | Derived backlink index from `[[ULID]]` tokens |
| `attachments` | `id` (ULID) | File attachments: block_id, mime_type, filename, size_bytes, fs_path |
| `op_log` | `(device_id, seq)` | Append-only operation log with blake3 hash chain |
| `block_drafts` | `block_id` | Mutable autosave scratch (only mutable table besides caches) |
| `log_snapshots` | `id` (ULID) | Op log compaction snapshots (zstd+CBOR) |
| `peer_refs` | `peer_id` | Sync peer tracking with cert_hash and device_name |
| `property_definitions` | `key` | Schema registry for typed properties (text/number/date/select) |
| `page_aliases` | `(page_id, alias)` | Alternative names for pages (case-insensitive) |

### Cache Tables (materialized, rebuilt on demand)

| Table | Purpose | Rebuild Triggers |
|-------|---------|-----------------|
| `tags_cache` | Tag names + usage counts | add/remove tag, create/delete/restore tag |
| `pages_cache` | Page titles | create/edit/delete page |
| `agenda_cache` | Agenda items by date | set/delete property (date), set due/scheduled, add/remove tag |

### FTS Virtual Table

| Table | Tokenizer | Content |
|-------|-----------|---------|
| `fts_blocks` | trigram (case_sensitive=0) | Markdown-stripped text with resolved tag names and page titles |

---

## 3. Op Log & Operations (12 types)

| Op Type | Payload | Reversible |
|---------|---------|-----------|
| `create_block` | block_id, block_type, parent_id?, position?, content | Yes → delete_block |
| `edit_block` | block_id, to_text, prev_edit? | Yes → edit_block (prior text) |
| `delete_block` | block_id | Yes → restore_block |
| `restore_block` | block_id, deleted_at_ref | Yes → delete_block |
| `purge_block` | block_id | **Non-reversible** |
| `move_block` | block_id, new_parent_id?, new_position | Yes → move_block (prior) |
| `add_tag` | block_id, tag_id | Yes → remove_tag |
| `remove_tag` | block_id, tag_id | Yes → add_tag |
| `set_property` | block_id, key, value_text/num/date/ref | Yes → set_property (prior) or delete_property |
| `delete_property` | block_id, key | Yes → set_property (prior) |
| `add_attachment` | attachment_id, block_id, mime_type, filename, size_bytes, fs_path | Yes → delete_attachment |
| `delete_attachment` | attachment_id | Non-reversible if no prior add found |

**Hash chain**: `blake3(device_id || seq || parent_seqs || op_type || payload)`. Canonical JSON for determinism.

---

## 4. Materializer (CQRS)

| Queue | Capacity | Tasks |
|-------|----------|-------|
| **Foreground** | 256 | ApplyOp, BatchApplyOps, Barrier |
| **Background** | 1024 | RebuildTagsCache, RebuildPagesCache, RebuildAgendaCache, ReindexBlockLinks, UpdateFtsBlock, ReindexFtsReferences, RemoveFtsBlock, RebuildFtsIndex, FtsOptimize |

- Batch-drain dedup on background queue (coalesce duplicate cache rebuilds)
- Backpressure: silent drop on full background queue
- Panic isolation: each task in spawned sub-task
- Metrics tracked: fg/bg processed, deduped, errors, panics, high-water marks

---

## 5. Tauri Commands (52 core + 5 sync = 57 total)

### Block Operations (10)

| Command | Purpose |
|---------|---------|
| `create_block` | Create block (content/tag/page). Max content: 256KB. Max depth: 20. |
| `edit_block` | Edit content. IMMEDIATE tx for TOCTOU safety. prev_edit for conflict detection. |
| `delete_block` | Soft-delete + cascade descendants via recursive CTE. |
| `restore_block` | Un-delete with deleted_at_ref as optimistic concurrency guard. |
| `purge_block` | Physical delete + all related rows. Non-reversible. Deferred FK checks. |
| `move_block` | Reparent. Cycle detection via ancestor-walking CTE. Depth validation. |
| `reorder_block` | Internal only (no Tauri command). Smart gap-detection reordering. |
| `list_blocks` | Paginated list with exclusive filters (parent, type, tag, deleted, agenda). |
| `get_block` | Fetch single block including soft-deleted. |
| `batch_resolve` | Batch metadata lookup via json_each(). Silent omit for missing. |

### Tag Operations (4)

| Command | Purpose |
|---------|---------|
| `add_tag` | Associate tag with block. Validates tag type and no duplicate. |
| `remove_tag` | Dissociate tag. |
| `list_tags_by_prefix` | Case-insensitive prefix search on tags_cache. |
| `list_tags_for_block` | Get all tag IDs for a block. |

### Query Operations (7)

| Command | Purpose |
|---------|---------|
| `search_blocks` | FTS5 full-text search with cursor pagination. |
| `query_by_tags` | Boolean tag query (AND/OR). TagExpr from IDs + prefixes. |
| `query_by_property` | Filter blocks by property key/value. |
| `query_backlinks_filtered` | Advanced backlink query with 11 filter types + sort. |
| `list_backlinks_grouped` | Backlinks grouped by source page. |
| `list_unlinked_references` | Blocks mentioning a page but not linked. |
| `get_backlinks` | Simple backlink list. |

### Property Operations (9)

| Command | Purpose |
|---------|---------|
| `set_property` | Upsert property. Key format: alphanum + hyphens/underscores, 1-64 chars. |
| `delete_property` | Remove property by key. |
| `get_properties` | Fetch all properties for a block. |
| `get_batch_properties` | Batch fetch for multiple blocks. |
| `list_property_keys` | List all distinct property keys in use. |
| `create_property_def` | Create schema definition (text/number/date/select). |
| `list_property_defs` | List all property definitions. |
| `update_property_def_options` | Update select-type options. |
| `delete_property_def` | Delete property definition. |

### Fixed-Column Properties (4)

| Command | Purpose |
|---------|---------|
| `set_todo_state` | Set todo state (null/TODO/DOING/DONE). Recurrence support on done transition: creates sibling with shifted dates, sets `repeat-origin` ref to original block. |
| `set_priority` | Set priority (null/1/2/3). |
| `set_due_date` | Set due date (YYYY-MM-DD or null). |
| `set_scheduled_date` | Set scheduled date (YYYY-MM-DD or null). |

### History & Undo/Redo (6)

| Command | Purpose |
|---------|---------|
| `get_block_history` | List op_log entries for a block. |
| `list_page_history` | Ops affecting page + descendants. Optional op_type filter. |
| `undo_page_op` | Undo N-th most recent op. Computes reverse, appends, applies. |
| `redo_page_op` | Redo previously undone op. |
| `revert_ops` | Batch revert multiple ops. |
| `compute_edit_diff` | Word-level diff (word_diff.rs) for edit_block ops. |

### Sync & Pairing (5 + 5 peer management)

| Command | Purpose |
|---------|---------|
| `start_pairing` | Generate passphrase + QR SVG, store session. |
| `confirm_pairing` | Validate passphrase, store peer_ref + cert_hash. |
| `cancel_pairing` | Clear pairing session. |
| `start_sync` | Trigger sync via daemon. Checks backoff, acquires peer lock. |
| `cancel_sync` | Set cancel flag (checked in message loop). |
| `get_device_id` | Return persistent device UUID. |
| `list_peer_refs` | List all paired peers. |
| `get_peer_ref` | Fetch single peer. |
| `delete_peer_ref` | Unpair a peer. |
| `update_peer_name` | Set human-readable peer name. |

### Batch, Export & System (8)

| Command | Purpose |
|---------|---------|
| `count_agenda_batch` | Count agenda items per date (batch). |
| `count_backlinks_batch` | Count backlinks per page (batch). |
| `set_page_aliases` | Replace page's aliases. |
| `get_page_aliases` | List aliases for a page. |
| `resolve_page_by_alias` | Look up page by alias (case-insensitive). |
| `export_page_markdown` | Export as Markdown with resolved `#[ULID]` and `[[ULID]]` + YAML frontmatter. |
| `get_status` | Materializer queue metrics. |
| `get_conflicts` | List conflict-copy blocks. |

---

## 6. Sync System

### Architecture

```
SyncDaemon (background task)
  ├── mDNS Discovery (_agaric._tcp.local.)
  ├── TLS WebSocket Server (responder mode)
  ├── SyncScheduler (per-peer backoff, debounce, resync)
  └── SyncOrchestrator (state machine per session)
```

### Protocol State Machine

`Idle → ExchangingHeads → StreamingOps → ApplyingOps → Merging → Complete`

### Message Types

HeadExchange, OpBatch (1000 ops/chunk), ResetRequired, SnapshotOffer/Accept/Reject, SyncComplete, Error

### Conflict Resolution

| Type | Strategy |
|------|----------|
| Edit divergence | Three-way text merge (diffy). Clean merge or conflict copy. |
| Property conflict | Last-Writer-Wins on created_at with device_id tiebreaker. |
| Move conflict | LWW on created_at with device_id tiebreaker. |
| Delete vs Edit | Edit wins (block resurrected). |
| Move vs Delete | Commutative (no conflict). |

### Scheduler

- Exponential backoff: 1s → 2s → 4s → … → 60s cap. Reset on success.
- Debounced local changes: 3s window.
- Periodic resync: 60s interval.
- Per-peer mutual exclusion via tokio Mutex.

### Certificates

- ECDSA P-256 self-signed via rcgen. Generate-once-then-load.
- SHA-256 cert hash stored in peer_refs for pinning.

---

## 7. Frontend Architecture

### Zustand Stores (7)

| Store | Key State | Purpose |
|-------|-----------|---------|
| `useBootStore` | state: booting/recovering/ready/error | App startup |
| `useBlockStore` | blocks[], focusedBlockId, rootParentId | Block tree CRUD |
| `useNavigationStore` | currentView, pageStack[], selectedBlockId | Page routing (9 views) |
| `useJournalStore` | mode (daily/weekly/monthly/agenda), currentDate | Journal view state |
| `useResolveStore` | cache Map\<ULID, {title, deleted}\> | Global title resolution |
| `useUndoStore` | Per-page undoDepth + redoStack | Page-level undo/redo |
| `useSyncStore` | state, peers[], opsReceived/Sent | Sync UI state |

### Views (9)

journal, search, pages, tags, trash, status, conflicts, history, page-editor — see **section 8** for dedicated per-view breakdown.

### Components (39 domain + 15 shadcn/ui + 1 editor = 55 total)

**Page-level**: PageEditor, PageHeader, PageBrowser, JournalPage (with JournalControls), SearchPanel, TagList, TagFilterPanel, TrashView, ConflictList, HistoryView, StatusPanel

**Block rendering**: BlockTree, SortableBlock, EditableBlock, StaticBlock, FormattingToolbar, BlockContextMenu

**References**: LinkedReferences, UnlinkedReferences, BacklinkFilterBuilder, SourcePageFilter, LinkEditPopover

**Properties**: PagePropertyTable, DiffDisplay

**Agenda**: AgendaResults, AgendaFilterBuilder, DonePanel, DuePanel

**Sync**: DeviceManagement, PairingDialog, QrScanner, UnpairConfirmDialog

**Shell/UI**: BootGate, ErrorBoundary, KeyboardShortcuts, RenameDialog, EmptyState

**Editor**: SuggestionList

**shadcn/ui**: alert-dialog, badge, button, calendar, card, input, popover, scroll-area, separator, sheet, sidebar, skeleton, sonner, tooltip

### Custom Hooks (13)

| Hook | Purpose |
|------|---------|
| `useSyncTrigger` | Auto-sync with exponential backoff (60s base, 10m max) |
| `useSyncEvents` | Listen to Tauri sync events, update stores, reload on data change |
| `useOnlineStatus` | Track navigator.onLine via useSyncExternalStore |
| `useBlockDnD` | Tree-aware drag-and-drop with @dnd-kit (PointerSensor 8px, mobile 250ms) |
| `useBlockProperties` | Task state cycling (none→TODO→DOING→DONE), priority cycling |
| `useBlockResolve` | Batch-resolve block metadata, cache results |
| `useBlockTags` | Load/add/remove/create tags for a block |
| `useUndoShortcuts` | Global Ctrl+Z/Y (outside contentEditable) |
| `usePaginatedQuery` | Cursor-based pagination wrapper |
| `usePollingQuery` | Periodic query with window focus refetch |
| `useViewportObserver` | IntersectionObserver for block virtualization |
| `useIsMobile` | Mobile viewport detection (\<768px) |
| `useRovingEditor` | TipTap instance management (mount/unmount/serialize) |

### Utility Modules (src/lib/)

- `tauri.ts` — Hand-written wrappers with object-style APIs for all 57 commands
- `bindings.ts` — Auto-generated from Rust types via specta
- `tauri-mock.ts` — In-memory backend mock (activates when Tauri absent)
- `tree-utils.ts` — Flat tree manipulation (depth, descendants, DnD projection)
- `announcer.ts` — Screen reader announcements (aria-live)
- `format.ts` — Formatting utilities
- `parse-date.ts` — Date parsing helpers
- `open-url.ts` — URL opening utilities
- `i18n.ts` — i18next setup (scaffolded, not fully implemented)
- `utils.ts` — cn() classname utility (clsx + tailwind-merge)

---

## 8. Views (Sidebar Navigation)

8 sidebar buttons + 1 programmatic view. Each maps to a top-level component rendered by App.tsx based on `useNavigationStore.currentView`.

### 8.1 Journal (`journal`)

**Component**: `JournalPage.tsx` (~1140 lines) + `JournalControls` (inline)
**Store**: `useJournalStore` (mode, currentDate)
**Sidebar icon**: Calendar

4 sub-modes controlled by `useJournalStore.mode`:

| Mode | Description |
|------|-------------|
| **Daily** | Single day page with prev/next navigation and "today" button. Auto-creates today's page on launch. |
| **Weekly** | Mon–Sun calendar grid, each day as a collapsible section. |
| **Monthly** | Calendar grid (react-day-picker) with content indicators; click a day to switch to daily. |
| **Agenda** | Task panels (TODO/DOING/DONE) with priority sorting, collapsible sections, and AgendaFilterBuilder (status, priority, dueDate, scheduledDate, tag dimensions). Default view shows today's dated tasks (due_date + scheduled_date) grouped by date (Overdue/Today/Tomorrow/future) with sort key chain: date ASC → state (DOING>TODO>DONE>null) → priority (1>2>3>null). Supports `groupBy` prop (`'date'`, `'priority'`, `'state'`, or `'none'`), `sortBy` prop (`'date'`, `'priority'`, `'state'`). Sort/Group toolbar (`AgendaSortGroupControls`) persisted in localStorage. |

- Floating calendar picker for date jumping
- Days with content highlighted
- Template support: auto-populates structure on new journal page via `loadJournalTemplate` + `insertTemplateBlocks`
- Keyboard: Alt+Left/Right (prev/next period), Alt+T (go to today)
- See also: **section 15** (Journal / Daily Notes), **section 14** (Property System — fixed-column date fields drive agenda)

### 8.2 Search (`search`)

**Component**: `SearchPanel.tsx` (~214 lines)
**Sidebar icon**: Search

- Full-text search via FTS5 trigram tokenizer (case-insensitive)
- Debounced input (300ms), immediate on Enter/button click
- Cursor-based pagination with "Load more" (limit 50)
- Results show block content with clickable navigation to source page
- CJK limitation notice (trigram tokenizer requires ≥3 chars)
- See also: **section 12** (Search / FTS5 — backend tokenizer, indexing, optimization)

### 8.3 Pages (`pages`)

**Component**: `PageBrowser.tsx` (~246 lines)
**Sidebar icon**: FileText

- Lists all page blocks (`block_type = 'page'`, non-deleted)
- Default sort: ULID ascending (oldest first)
- Cursor-based pagination
- Create new page button (Ctrl+N)
- Delete with confirmation dialog
- Click to navigate to page (switches to page-editor view)

### 8.4 Tags (`tags`)

**Component**: `TagList.tsx` (~195 lines) + `TagFilterPanel.tsx`
**Sidebar icon**: Tag

- Lists all tag blocks (`block_type = 'tag'`)
- Create new tag via inline form
- Delete with confirmation dialog
- Click tag name to navigate to tag page (switches to page-editor)
- **TagFilterPanel**: Boolean tag queries (AND/OR/NOT) via TagExpr
- See also: **section 16** (Tag System — hierarchy, prefix search, TagExpr)

### 8.5 Trash (`trash`)

**Component**: `TrashView.tsx` (~183 lines)
**Sidebar icon**: Trash2

- Shows soft-deleted blocks (`deleted_at IS NOT NULL`)
- Cursor-based pagination
- **Restore**: un-delete (reversible)
- **Purge**: permanent physical delete (non-reversible, confirmation dialog)
- Displays deletion timestamp

### 8.6 Status (`status`)

**Component**: `StatusPanel.tsx` (~274 lines) + `DeviceManagement`
**Sidebar icon**: Activity (with colored dot: green=idle, amber=syncing, red=error, gray=no peers)

- Materializer queue metrics (polled every 5s):
  - Foreground queue depth (ops waiting)
  - Background queue depth (cache/FTS tasks)
  - Total ops dispatched
  - Total background tasks dispatched
- Color-coded queue health (green/amber/red)
- **DeviceManagement** sub-panel: paired peers list, sync stats (ops received/sent, last synced), pair/unpair actions

### 8.7 Conflicts (`conflicts`)

**Component**: `ConflictList.tsx` (~510 lines)
**Sidebar icon**: GitMerge (with red dot when unresolved conflicts exist, polled every 30s)

- Shows blocks where `is_conflict = 1` (sync merge conflict copies)
- Cursor-based pagination
- **Type-specific rendering**: Property conflicts show field-by-field diffs (state, priority, due_date, scheduled_date) with blue styling. Move conflicts show parent_id + position changes with purple styling. Text conflicts show Current:/Incoming: rich content. Falls back to text rendering when no diffs detected.
- Metadata: conflict source block ID, created timestamp (ULID decoded)
- Expandable content preview
- Two actions (two-click confirmation each):
  - **Keep**: edit original with conflict content + delete conflict copy (with undo toast)
  - **Discard**: delete conflict copy (with undo toast)
- **Batch resolution**: Checkbox per conflict, batch toolbar with Select all/Deselect all, Keep all/Discard all. Batch confirmation dialog calls APIs directly (no per-item toasts). Partial failure toast with retry action.
- Navigation link to original block

### 8.8 History (`history`)

**Component**: `HistoryView.tsx` (~627 lines)
**Sidebar icon**: History

- Global operation log browser with multi-select for batch revert
- Filter by op type: edit, create, delete, move, tag, property, attachment, restore, purge
- Word-level diff display for edit operations (via `computeEditDiff`)
- Cursor-based pagination
- Keyboard navigation:
  - j/k: vim-style up/down
  - Space: toggle selection
  - Shift+Click: range select
  - Ctrl+A: select all
  - Enter: revert selected
- Batch revert with confirmation dialog
- See also: **section 11** (Undo/Redo System — reverse.rs, undoStore)

### 8.9 Page Editor (`page-editor`)

**Component**: `PageEditor.tsx` (~129 lines) + PageHeader, BlockTree, LinkedReferences, UnlinkedReferences, PagePropertyTable
**Not in sidebar** — navigated to programmatically via `navigateToPage()` which pushes onto `pageStack`.

- Editable page title (PageHeader)
- Block tree with full outliner editing (BlockTree, see **section 9**)
- Page properties table (PagePropertyTable, see **section 14**)
- Linked references grouped by source page
- Unlinked references (blocks mentioning page but not linked, see **section 17**)
- Zoom-in: breadcrumb trail when viewing a sub-block as root
- Back navigation pops from `pageStack`; empty stack returns to Pages view
- "Add block" button for creating new child blocks

---

## 9. Editor System

### TipTap Configuration

Minimal extension set (no starter-kit). Single roving instance.

**Built-in extensions**: Document, Paragraph, Text, Bold, Italic, Code, CodeBlockLowlight, Heading (1-6), HardBreak, History, Placeholder

### Custom Extensions (7 exported + 1 internal)

| Extension | Trigger | Type | Purpose |
|-----------|---------|------|---------|
| TagRef | programmatic / @ picker | inline atom | `#[ULID]` rendered as chip |
| BlockLink | programmatic / [[ picker | inline atom | `[[ULID]]` rendered as navigable chip |
| ExternalLink | Ctrl+K / autolink / paste | mark | `[text](url)` links |
| AtTagPicker | `@` | suggestion | Tag autocomplete with create-new option |
| BlockLinkPicker | `[[` | suggestion | Page autocomplete with create-new option |
| SlashCommand | `/` | suggestion | Command palette |
| CheckboxInputRule | `- [ ]` / `- [x]` | input rule | Checkbox syntax → TODO/DONE state |
| PriorityShortcuts (internal) | Mod-Shift-1/2/3 | keymap | Priority keyboard shortcuts |

### Slash Commands

**Base**: TODO, DOING, DONE, DATE, DUE, SCHEDULED, LINK, TAG, CODE, EFFORT, ASSIGNEE, LOCATION, TEMPLATE

**Progressive disclosure**: PRIORITY 1/2/3, REPEAT (daily/weekly/monthly/yearly), Heading 1-6, ASSIGNEE (Me/Custom), LOCATION (Office/Home/Remote/Custom)

### Markdown Serializer (`markdown-serializer.ts`, 684 lines)

Zero external dependencies. O(n) bidirectional conversion.

**Supported syntax**: headings, fenced code blocks, \*\*bold\*\*, \*italic\*, \`code\`, \[links\](url), `#[ULID]` tag refs, `[[ULID]]` block links, hard breaks, backslash escaping

**Special**: Mark coalescing (prevents ambiguous delimiters), unclosed mark revert, link grouping, balanced paren tracking for URLs

### Editor Behavior

- **Roving pattern**: Single TipTap instance. Mount on focus, unmount on blur.
- **Transient UI detection**: Suggestion popups, toolbar, date picker keep editor mounted.
- **Enter**: Save + create new sibling below.
- **Backspace on empty**: Delete block, focus previous.
- **Backspace at start**: Merge with previous block.
- **Tab / Shift+Tab**: Indent / dedent.
- **Auto-split**: Multiple paragraphs split into separate blocks on blur.
- **Ctrl+.**: Collapse/expand children (client-side state, not persisted).
- **Zoom-in**: Context menu "Zoom in" on blocks with children. Filters tree to descendants with breadcrumb trail navigation.

---

## 10. Keyboard Shortcuts

| Category | Shortcut | Action |
|----------|----------|--------|
| **Formatting** | Ctrl+B/I/E | Bold / Italic / Code |
| | Ctrl+Shift+C | Toggle code block |
| | Ctrl+K | Insert/edit external link |
| **Block nav** | Arrow Up/Left at start | Focus previous block |
| | Arrow Down/Right at end | Focus next block |
| **Block editing** | Enter | Save + create sibling |
| | Shift+Enter | Hard break within block |
| | Escape | Cancel, discard changes |
| | Backspace (empty) | Delete block |
| | Backspace (at start) | Merge with previous |
| **Organization** | Tab / Shift+Tab | Indent / dedent |
| | Ctrl+Shift+Up/Down | Move block up/down |
| **Task** | Ctrl+Enter | Cycle TODO/DOING/DONE/none |
| | Ctrl+Shift+1/2/3 | Priority 1/2/3 |
| **Collapse** | Ctrl+. | Toggle collapse/expand |
| **Pickers** | @ | Tag picker |
| | [[ | Block link picker |
| | / | Slash command menu |
| **Journal** | Alt+Left/Right | Previous/next period |
| | Alt+T | Go to today |
| **Global** | Ctrl+Z / Ctrl+Y | Undo / redo (page-level) |
| | Ctrl+F | Focus search |
| | Ctrl+N | Create new page |
| | ? | Show keyboard shortcuts help |
| **History view** | Space | Toggle selection |
| | Shift+Click | Range select |
| | Ctrl+A | Select all |
| | Enter | Revert selected |
| | j/k | Vim-style navigation |

---

## 11. Undo/Redo System

**Two-tier model**:

| Tier | Scope | Mechanism |
|------|-------|-----------|
| In-editor | Per mount session | TipTap/ProseMirror History extension. Cleared on blur. |
| Page-level | Per page | `reverse.rs` computes inverse ops from op log. Append-only. |

**Non-reversible**: purge_block, delete_attachment (when no prior add found)

**Frontend**: useUndoStore tracks per-page undoDepth and redoStack. New user action clears redo stack.

---

## 12. Search (FTS5)

- **Tokenizer**: trigram (case_sensitive=0). ~3x larger index for better CJK support.
- **Strip pass**: Remove markdown formatting, resolve `#[ULID]` → tag name, `[[ULID]]` → page title.
- **Optimize**: After every 500 edits or 60 minutes. Segment merge.
- **Pagination**: Cursor-based on (rank, rowid).

---

## 13. Pagination

All list queries use cursor-based keyset pagination.

**Cursor**: Opaque base64-encoded JSON with id, position?, deleted_at?, seq?, rank?.

**Pattern**: Fetch limit+1, detect has_more, trim. Default 50, max 200.

---

## 14. Property System

- **Types**: text, number, date, ref (stored in separate columns on block_properties)
- **Fixed columns**: todo_state, priority, due_date, scheduled_date (denormalized to blocks table for fast indexed queries)
- **Schema registry**: property_definitions table with value_type and options
- **Built-in seeds**: 9 pre-defined properties (todo_state, priority, due_date, scheduled_date, created_at, completed_at, effort, assignee, location)
- **UI**: PagePropertyTable with type-aware inputs, collapsible display
- **Inline chips**: `PropertyChip` renders custom properties in `SortableBlock` (max 3, overflow "+N"). Due/scheduled date chips are clickable (dispatch CustomEvent to open date picker). Property key labels support click-to-rename (create-new + delete-old pattern). Ref values resolved to page titles via `resolveBlockTitle`.
- **Click-to-edit**: Type-aware popovers — text input, select dropdown, ref-type page picker (search-as-you-type with `listBlocks({ blockType: 'page' })`). Ref picker calls `setProperty` with `valueRef`.
- **Repeat properties**: 5 seeded definitions (repeat, repeat-until, repeat-count, repeat-seq, repeat-origin). Repeat-origin is a ref to the recurrence chain source.
- **Repeat slash commands**: 11 `/repeat` variants — standard (daily/weekly/monthly/yearly), from-completion (`.+daily`/`.+weekly`/`.+monthly`), catch-up (`++daily`/`++weekly`/`++monthly`), remove. `formatRepeatLabel()` utility (in `src/lib/repeat-utils.ts`) converts raw values to human-readable labels for badge display.
- **Repeat end-condition commands**: 5 items — `/repeat-until` (opens date picker in `repeat-until` mode), `/repeat-limit` (5/10/20 occurrences via `repeat-count` property), `/repeat-limit-remove` (clears both `repeat-count` and `repeat-until`).
- **Agenda projection**: `list_projected_agenda` command computes virtual future occurrences for repeating tasks within a date range. Queries non-DONE blocks with `repeat` property + date, shifts forward using `shift_date_once`, respects end conditions (`repeat-until`, `repeat-count`/`repeat-seq`). Returns `ProjectedAgendaEntry` (block + projected_date + source). DuePanel renders projected entries with dashed border, muted styling, and "Projected" header.

---

## 15. Journal / Daily Notes

- **4 modes**: Daily, Weekly, Monthly, Agenda
- **Auto-create**: Today's page created on launch + Enter/n keyboard shortcut on empty journal
- **Calendar picker**: react-day-picker with content indicators
- **Agenda panels**: TODO/DOING/DONE with priority sorting
- **Agenda sort/group**: `sortAgendaBlocks()`, `sortByPriority()`, `sortByState()`, `sortAgendaBlocksBy()` dispatcher, `groupByDate()`, `groupByPriority()`, `groupByState()` in `agenda-sort.ts`. Date groups: Overdue, Today, Tomorrow, future dates, No date. Priority groups: P1, P2, P3, No priority. State groups: DOING, TODO, DONE, No state. Sort key chain configurable: date→state→priority (default), priority→date→state, state→date→priority.
- **Agenda toolbar**: `AgendaSortGroupControls` component — "Group by" and "Sort by" popover dropdowns with pill-style buttons. State persisted in localStorage (`agaric:agenda:groupBy`, `agaric:agenda:sortBy`). `AgendaResults` supports `groupBy` and `sortBy` props.
- **Agenda default query**: Shows blocks with `due_date` or `scheduled_date` matching today (via `list_blocks` with `agenda_date`/`agenda_source`), not all TODO blocks.
- **AgendaFilterBuilder**: status, priority, dueDate (6 presets: Today/This week/Overdue/Next 7/14/30 days), scheduledDate (6 presets), tag dimensions

---

## 16. Tag System

- Tags are first-class blocks (block_type='tag')
- Hierarchy via naming convention (e.g., `work/meeting`) — no parent-child relationships
- Prefix-aware LIKE search for hierarchy queries
- TagExpr: AND/OR/NOT boolean expressions
- @picker for inline autocomplete with create-new option

---

## 17. Backlinks & References

- **block_links table**: Derived index from `[[ULID]]` tokens in content
- **Linked references**: Grouped by source page
- **Unlinked references**: Blocks mentioning a page but not linked
- **11 filter types**: PropertyText, PropertyNum, PropertyDate, PropertyIsSet, PropertyIsEmpty, HasTag, HasTagPrefix, Contains, CreatedInRange, BlockType, And/Or/Not
- **Sorting**: Created, PropertyText, PropertyNum, PropertyDate (Asc/Desc)

---

## 18. Error Handling

**AppError** enum (11 variants): Database, Migration, Io, Json, Ulid, NotFound, InvalidOperation, Channel, Snapshot, Validation, NonReversible

All serialize as `{ kind, message }` for Tauri 2 frontend.

---

## 19. Rust Backend Modules (30)

backlink_query, cache, commands, dag, db, device, draft, error, fts, hash, materializer, merge, op, op_log, pagination, pairing, peer_refs, recovery, reverse, snapshot, soft_delete, sync_cert, sync_daemon, sync_events, sync_net, sync_protocol, sync_scheduler, tag_query, ulid, word_diff

---

## 20. Testing Infrastructure

| Layer | Framework | Count |
|-------|-----------|-------|
| Frontend unit/component | Vitest + RTL + vitest-axe | 87 files, ~2937 tests |
| Frontend property-based | fast-check | 1 file, 500 iterations/property |
| Frontend E2E | Playwright | 14 spec files |
| Backend unit | tokio + insta | 15+ modules |
| Backend integration | tokio + insta | 2 files (8755 lines) |
| Backend benchmarks | Criterion | 12 bench files (manual only) |
| Snapshots | insta | 22 .snap files |

**Coverage thresholds**: lines 80%, functions 80%, branches 75%, statements 80%

**Every component test includes**: happy-path render, user interaction, error state, axe a11y audit

---

## 21. Build & CI

### Platforms

| Platform | Output |
|----------|--------|
| Linux | .deb, .rpm, .AppImage |
| Windows | .msi, .exe (NSIS) |
| macOS | .dmg, .app |
| Android | Debug APK (~400MB), Release APK (~24MB with R8) |
| iOS | Blocked by mDNS issue (#522) |

### CI Pipeline (3 jobs)

1. **check** (Ubuntu): biome, tsc, cargo fmt, clippy, nextest, vitest, playwright, sqlx prepare --check
2. **build** (matrix: Linux + Windows + macOS): cargo tauri build
3. **android-build** (Ubuntu): JDK 17 + Android SDK 36 + NDK 27

### Pre-commit (prek, 15 hooks)

trailing-whitespace, end-of-file-fixer, check-yaml/toml/json, check-merge-conflict, check-added-large-files, no-commit-to-branch, biome-check, tsc, no-hsl-rgb-var-wrap, vitest, npm-audit, license-checker, depcheck, cargo-fmt, cargo-clippy, cargo-test, cargo-deny, cargo-machete

---

## 22. Deferred Features (REVIEW-LATER)

| ID | Feature | Phase |
|----|---------|-------|
| 522 | mDNS peer discovery on iOS (manual IP fallback) | iOS |
| 639 | Templates system (dynamic variables, CRUD UI) | Journaling |
| 641 | Scheduling semantics (due/scheduled drive agenda) | Tasks |
| 642 | Agenda filter by creation/completion dates, custom properties | Tasks |
| 644 | Repeating tasks (modes, end conditions, agenda projection) | Tasks |
| 651 | Conflicts view — metadata, resolution, rendering gaps | Sync |
| 654 | Editor block types (tables) | Editor |
| 655 | Inline query blocks (`{{query ...}}` embedded results) | Query |
| 656 | Namespaced pages (`/` separator, tree view) | Pages |
| 657 | Block-level multi-selection (static + batch ops) | Outlining |
| 658 | Custom task keywords (configurable states) | Tasks |
| 660 | Logseq/Markdown import | Import |

---

## 23. Key Dependencies

### Frontend

React 18, @tiptap/react + extensions, zustand, @dnd-kit/core + sortable, react-day-picker, sonner, lucide-react, @radix-ui (popover, alert-dialog, etc.), class-variance-authority, tailwind-merge, clsx, html5-qrcode, lowlight, i18next/react-i18next

### Backend

sqlx (compile-time queries), tokio, serde/serde_json, blake3, ulid, specta/tauri-specta, diffy (three-way merge), zstd, ciborium (CBOR), tokio-tungstenite, rustls, rcgen, mdns-sd, qrcode, criterion, insta
