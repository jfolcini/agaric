# Agaric vs Logseq: Comprehensive Feature Comparison

> Goal: Agaric is meant to fully replace Logseq.
> This document maps every Logseq capability to what we have, what's missing,
> and what needs to be built.

---

## Part 1: Feature-by-Feature Comparison

### 1. Block Model

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Everything is a block (outliner) | Yes -- every piece of content is a bullet | Yes -- `blocks` table, tree via `parent_id` + `position` | None |
| Block nesting / indentation | Unlimited depth, visual indentation | Unlimited depth, visual indentation via `depth` in flat tree | None |
| Block UUIDs | UUID v4 auto-assigned, visible via `id::` property | ULID (uppercase Crockford base32) | None (ULIDs are better -- sortable) |
| Block references `((uuid))` | Inline reference renders source content, live-updating | Not implemented -- `[[ULID]]` links to pages/blocks but does NOT embed content inline | **Critical gap** |
| Block embeds `{{embed ((uuid))}}` | Full content + children rendered inline, editable in-place | Not implemented | **Critical gap** |
| Block properties `key:: value` | Inline `key:: value` syntax on lines after block content | `block_properties` table with typed values (text, num, date, ref). PropertiesPanel UI for viewing/editing. Priority property with color-coded badges | Partial -- general property UI done, no inline `key::` syntax |
| Collapse/expand children | Click arrow or `Ctrl+Up/Down` | Chevron toggle, `Ctrl+.` shortcut, client-side state, focus rescue | Partial -- collapse state lost on page reload (not persisted) |
| Zoom into block (focus mode) | `Alt+Right` focuses on block + descendants only | Not implemented | **Gap** |
| Move block up/down | `Alt+Shift+Up/Down` | Drag-and-drop reordering (tree-aware) + `Ctrl+Shift+Up/Down` keyboard shortcuts | None |
| Block-level selection | `Esc` + arrow keys for multi-block selection | Not implemented | **Gap** |
| Visual hierarchy (bullets / tree lines) | Bullet points + tree lines for nesting | Indentation + tree indent guide lines (`border-l`) for nesting depth. No bullet points | Partial -- tree lines done, no bullets |
| Cross-block undo | Ctrl+Z works across blocks within session | Op-level undo/redo system: `Ctrl+Z`/`Ctrl+Y` shortcuts, per-page undo history, HistoryView with multi-select batch revert. Scoped per page per ADR-02 | Partial -- per-page not per-session (intentional ADR-02) |

### 2. Page Model

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Pages as named containers | One .md/.org file per page | `blocks` with `block_type = 'page'`, content = page title | None |
| Page properties (frontmatter) | First block holds `key:: value` page properties | `block_properties` on page blocks (backend only) | **UI gap** |
| Page aliases | `alias:: JS, ECMAScript` -- multiple names resolve to same page | Not implemented | **Gap** |
| Namespaced pages | `Project/Backend/API` with `/` separator, parent auto-lists children | Not implemented | **Gap** |
| Page tags via property | `tags:: book, fiction` on page frontmatter | Tags exist (`block_tags` junction table) but not as page-level property syntax | Partial -- mechanism exists, syntax/UX missing |
| `title::` override | Display title differs from file/page name | Block content IS the title. No separate title property | Minor gap |
| Auto-created pages from links | Clicking `[[New Page]]` creates the page | `[[` picker has "Create new" option that auto-creates page blocks | None |

### 3. Editor & Formatting

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Markdown support | Full Markdown (headings, lists, tables, code blocks, etc.) | Markdown-based. Frontend uses TipTap with custom serializer (`**bold**`, `*italic*`, `` `code` ``, `[text](url)`) | Subset -- no tables, blockquotes, or lists yet |
| Org-mode support | Full .org format alternative | Not implemented. Org-mode is an inspiration for features (tags, properties, agenda), not a supported format | **Design choice** -- Markdown only |
| **Bold** | `**bold**` | `**bold**` | None |
| *Italic* | `*italic*` | `*italic*` | None |
| ~~Strikethrough~~ | `~~text~~` | Not implemented | **Gap** |
| ==Highlight== | `^^text^^` | Not implemented | **Gap** |
| `Inline code` | `` `code` `` | `` `code` `` | None |
| Headings in blocks | `# H1`, `## H2`, etc. inside blocks | `/h1`–`/h6` slash commands insert heading syntax. TipTap `Heading` extension configured for levels 1-6. Static view renders styled h1-h6 | None |
| Code blocks with syntax highlighting | ````python ... ``` `` | Code blocks parsed + rendered with `lowlight` syntax highlighting (common language set, auto-detect fallback). `<pre><code>` with `hljs` classes | None |
| Math/LaTeX | `$$E=mc^2$$` inline and block | Not implemented | **Gap** |
| Tables | Markdown tables | Not implemented | **Gap** |
| Blockquotes | `> quote` | Not implemented | **Gap** |
| Slash commands `/` | 20+ commands (TODO, template, date, embed, etc.) | `/TODO`, `/DOING`, `/DONE`, `/DATE`, `/PRIORITY 1/2/3`, `/H1`–`/H6` — 13 commands via TipTap Suggestion extension | Partial — 13 commands, no template/embed. Extensible for more |
| Autocomplete for `[[` | Search all pages | Yes -- `block-link-picker` extension, searches pages, "Create new" option | None |
| Autocomplete for `@` | Search all tags | Yes -- `at-tag-picker` extension, searches tags | None |
| Autocomplete for `((` | Search all blocks for reference | Not implemented -- no block reference system | **Gap** (requires block refs first) |
| Autocomplete for `::` | Property name suggestions | Not implemented | **Gap** |
| Multi-line blocks | Content can span multiple lines within one block | `Shift+Enter` for hard break within block. `Enter` creates new sibling | None |

### 4. Linking System

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Page links `[[page]]` | `[[page name]]` -- creates page if needed, case-insensitive match | `[[ULID]]` links rendered as clickable chips with title resolution | Functional but different -- links by ID not name. More robust but less human-readable in raw text |
| Block references `((uuid))` | Inline content preview, live-updating | Not implemented | **Critical gap** |
| Block embeds | `{{embed ((uuid))}}` -- full tree rendered inline, editable | Not implemented | **Critical gap** |
| Page embeds | `{{embed [[page]]}}` -- entire page content inline | Not implemented | **Gap** |
| Tags as links | `#tag` = `[[tag]]` -- tags ARE pages | Tags are separate entities (`block_type = 'tag'`). `#[ULID]` renders as tag chip | Different model -- tags are not pages. This is a design choice, not necessarily a gap |
| External links | `[text](url)` | Markdown-style `[text](url)` supported in serializer and editor. External links open in browser from static view | None |
| Backlinks panel | Linked + Unlinked references at bottom of every page, grouped by source | `BacklinksPanel` component -- shows blocks linking via `[[ULID]]`. No unlinked references | Partial -- no unlinked references |
| Page graph (local) | Visual graph of connections for one page | Not implemented (out of scope per user) | Noted, not priority |
| Custom link labels | `[display text]([[page]])` or `[label](((uuid)))` | Not implemented | **Gap** |

### 5. Properties System

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Block properties | `key:: value` inline syntax | `block_properties` table with `set_property` / `delete_property` / `get_properties` commands. Backend + frontend wrappers complete | Backend + API complete, **no general UI** (task marker is the first property-based UI) |
| Typed values | DB version: Text, Number, Date, DateTime, Checkbox, URL, Node | 4 types: text, num, date, ref (block reference) | Close -- missing DateTime, Checkbox, URL |
| Built-in properties | 17+ (tags, alias, title, icon, template, collapsed, etc.) | None built-in -- all custom | **Gap** -- need to define semantic properties |
| Property-based queries | `{{query (property type book)}}` | `query_by_property` command with cursor-based pagination. No inline query blocks | Partial -- API exists, no embedded query syntax |
| Property name autocomplete | `::` triggers suggestions | Not implemented | **Gap** |
| Property value autocomplete | Suggests previously-used values | Not implemented | **Gap** |
| Comma-separated multi-values | `tags:: a, b, c` parsed as multiple refs | Not supported | **Gap** |

### 6. Tags

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Inline tag syntax | `#tag` or `#[[multi word]]` | `#[ULID]` rendered as styled chip with name | Functional but different -- ULID-based, not name-based |
| Tags as pages | Every tag IS a page (same backlink system) | Tags and pages are separate `block_type` values | **Design difference** -- Logseq unifies, we separate |
| Tag hierarchy / namespaces | `/` separator in tag names | Not implemented | **Gap** |
| Tag filtering | Filter in linked references, simple queries | `TagFilterPanel` with boolean AND/OR, prefix search | Good -- arguably better for structured queries |
| Tag usage counts | Shown in various UIs | `tags_cache` tracks `usage_count` | None |
| Tag autocomplete | `@` triggers search | Yes -- `at-tag-picker` extension | None |
| Tag inheritance (DB version) | Parent tags via `Extends`, child inherits properties | Not implemented | **Gap** (advanced feature) |

### 7. Query System

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Simple queries | `{{query (and [[page]] (task TODO))}}` -- embedded live results | Not implemented -- no inline query blocks | **Major gap** |
| Query operators | `and`, `or`, `not` | `TagExpr` supports `And`, `Or`, `Not` for tag queries only | Very limited scope |
| Date-based queries | `(between -7d today)`, relative dates | `list_blocks` supports `agendaDate` filter (single date, not range) | **Gap** -- no date range queries |
| Task queries | `(task TODO DOING)`, `(priority A)` | Agenda mode queries tasks by status (TODO/DOING/DONE) via `query_by_property`. No inline query blocks | Partial -- agenda mode only, no embedded queries in pages |
| Property queries | `(property type book)`, `(page-property status active)` | `query_by_property` command with cursor-based pagination. Used by agenda mode for task queries | Partial -- single key+value filter, no compound property queries |
| Advanced Datalog queries | Full Datascript query language with custom rules | Not implemented -- backend uses SQL directly | **Gap** (but SQL could serve same purpose) |
| Query result as table | `query-table:: true` with selectable columns | Not implemented | **Gap** |
| Live-updating results | Queries re-evaluate on data change | FTS search and tag queries are live. No inline query blocks | Partial |
| Query sort/transform | `:result-transform`, `:sort-by` | Pagination cursors handle sort order. No user-customizable sort | **Gap** |

### 8. Task Management

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Task markers | `TODO`, `DOING`, `DONE`, `CANCELLED`, `NOW`, `LATER` | TODO/DOING/DONE via block properties. Click to cycle, `Ctrl+Enter` shortcut. Visual icons (Circle/CircleDot/CheckCircle2) | Partial -- 3 states vs Logseq's 6, no CANCELLED/NOW/LATER |
| Priority levels | `[#A]`, `[#B]`, `[#C]` | Priority A/B/C via block properties. Slash commands (`/PRIORITY 1/2/3`), keyboard shortcuts (`Ctrl+Shift+1/2/3`), click-to-cycle badge. Color-coded: A=red, B=yellow, C=blue | None |
| Scheduled dates | `SCHEDULED: <2024-12-27 Fri>` | Org-mode timestamps parsed (`<2024-01-15 Mon>`) but no task scheduling semantics | Partial -- syntax exists, semantics missing |
| Deadline dates | `DEADLINE: <2024-12-31 Tue>` | Same as above | Partial |
| Task cycling | `Ctrl+Enter` toggles TODO/DONE | Click marker or `Ctrl+Enter` cycles TODO → DOING → DONE → none | Comparable |
| Task queries/dashboard | Embedded queries surface tasks across graph | Agenda mode: dedicated task dashboard with collapsible TODO/DOING/DONE sections, paginated. No embedded inline queries on arbitrary pages | Partial -- dedicated view exists, no inline query blocks |
| Custom task keywords | Configurable via `config.edn` | Not implemented | **Gap** |
| Recurring tasks | Via plugins | Not implemented | **Gap** |

### 9. Daily Journal

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Auto-created daily page | Created at midnight, date as title | `JournalPage` component -- auto-creates page with `YYYY-MM-DD` content on first block | Comparable |
| Default landing page | Opens to today's journal | App opens to journal view | None |
| Date navigation | `g n`/`g p` for next/prev day, date picker | Prev/next buttons per mode, calendar date picker, Today button. `Alt+Left/Right` for prev/next (mode-aware: day/week/month), `Alt+T` for today | Partial -- different key bindings than Logseq but functional |
| Scrollable past journals | Past days stacked below today | Daily: single day. Weekly: 7-day sections. Monthly: stacked all-month sections (not a grid). No "Load older days" button or infinite scroll | **Gap** -- monthly renders 28-31 sections with full BlockTrees (performance issue) |
| Journal templates | Auto-populated via `config.edn` | Not implemented | **Gap** |
| Configurable date format | `:journal/page-title-format` | Fixed `YYYY-MM-DD` | Minor gap |
| Natural language dates | Type "next friday" in date picker | Not implemented | **Gap** |
| "On this day" queries | Datalog query for same date last year | Not implemented (requires query system) | **Gap** |
| Auto-create today's journal | Daily page created on app launch | Not implemented — user must click "Add block" on empty today | **UX gap** |

### 10. Search

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Full-text search | `Ctrl+K` / `Cmd+K` global search | `SearchPanel` with FTS5 backend, debounced, paginated | Comparable |
| Search scope | Pages + blocks, filterable | All blocks, no scope filtering | Minor gap |
| Search ranking | BM25-based | FTS5 rank (BM25) with cursor pagination | None |
| Search in linked references | Filter bar in backlinks panel | Server-side backlink filter expressions with `Contains` filter (FTS5 search within backlinks) + 9 other filter types with And/Or/Not composition | **We're better** |
| Recent pages quick access | Shown in search results | Not implemented | **Gap** |
| Unlinked references search | Finds plain-text mentions of page name | Not implemented | **Gap** |

### 11. Sync & Storage

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Local-first | Flat files on disk (.md/.org per page) | SQLite database in app data dir | Both local-first, different storage model |
| File format | Human-readable Markdown or Org-mode files | Binary SQLite database | **Trade-off** -- our format is not human-readable but more robust |
| Cloud sync | Logseq Sync (paid), or DIY via git/iCloud/Dropbox | Full sync pipeline: SyncDaemon background service with mDNS discovery + TLS WebSocket + cert pinning. 5 Tauri commands wired. Exponential backoff. Frontend: periodic sync, offline detection, toast notifications | **Gap** -- protocol + transport + UI ready, 5 Tauri commands missing to connect them |
| Conflict resolution | File-level, can cause issues with git | Three-way merge with diffy, conflict copies, LWW for properties. 4 conflict types handled (edit, property, move, delete-vs-edit) | **We're better** architecturally |
| Multi-device | Via sync solution | LAN sync via SyncDaemon: mDNS discovery of paired peers, immediate sync on appearance, periodic resync every 60s, change-triggered debounced sync (3s window) | None -- fully functional for LAN devices |
| Op log / history | No explicit op log (git history if using git) | Full append-only op log with blake3 hashes, per-device sequence | **We're better** |
| Snapshots / compaction | N/A (file-based) | zstd-compressed CBOR snapshots, 90-day compaction | **We're better** |
| Crash recovery | File system journaling | Explicit recovery at boot (pending snapshots, draft errors) | **We're better** |

### 12. Templates

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Template creation | Block/page with `template:: name` property | Not implemented | **Gap** |
| Template insertion | `/Template` slash command | Not implemented | **Gap** |
| Dynamic variables | `<% today %>`, `<% time %>`, `<% current page %>`, etc. | Not implemented | **Gap** |
| Default journal template | `:default-templates {:journals "name"}` in config | Not implemented | **Gap** |
| Template including parent | `template-including-parent:: true` | Not implemented | **Gap** |

### 13. Import / Export

| Capability | Logseq | Agaric | Gap |
|---|---|---|---|
| Markdown export | Full graph export to .md files | Not implemented | **Gap** |
| JSON/EDN export | Data export | Not implemented | **Gap** |
| OPML export | Outline export | Not implemented | **Gap** |
| Import from Roam | JSON import | Not implemented | **Gap** |
| Import from Notion | Markdown import | Not implemented | **Gap** |
| Publishing as HTML | Static site generation | Not implemented | **Gap** |

### 14. Out of Scope (Noted, Not Priority)

| Feature | Logseq | Agaric | Notes |
|---|---|---|---|
| Graph view | Global + local graph visualization | Not implemented | Not priority per user |
| Plugin/extension system | Marketplace with 100+ plugins | Not implemented | Not priority per user |
| Flashcards / spaced repetition | Built-in cloze deletion + SM-2 review | Not implemented | Not priority per user |
| Whiteboard | Infinite canvas with block embedding | Not implemented | Not priority per user |
| PDF annotation | Built-in reader with highlights as blocks | Not implemented | Not priority per user |

---

## Part 2: Workflow Comparison

### Workflow 1: Daily Journaling

**Logseq approach:**
- Open app -> today's journal auto-created and displayed
- Type anything, add `[[links]]` to topics
- Scroll down to see past days
- Templates auto-populate structure (gratitude, tasks, notes, review)
- Backlinks on topic pages create timeline of thoughts

**Agaric current state:**
- Scrollable multi-day journal view (daily/weekly/monthly modes)
- Each day section with its own BlockTree, date header, "Add block"
- Task markers (TODO/DOING/DONE) with click-to-cycle and Ctrl+Enter
- Block collapse/expand with chevron toggle and Ctrl+. (state not persisted)
- "Open in page editor" link per day
- Calendar date picker with content dots

**Gaps to close:**
1. Journal templates (auto-populate new journal pages)
2. Task queries to surface TODOs across all journal days (agenda mode exists but no inline query blocks)
3. Auto-create today's journal page on app launch
4. "Load older days" / infinite scroll for past entries
5. Monthly view should be calendar grid, not 31 stacked sections

**Verdict: Functional but incomplete.** Core daily journal workflow works well — 4 view modes, keyboard nav (`Alt+Arrow`, `Alt+T`), calendar picker with content dots, agenda mode with task dashboard. Missing: templates, auto-create today on launch, monthly calendar grid view (current stacked sections have performance issues). Getting close to Logseq parity for daily journaling.

---

### Workflow 2: Task Management / GTD

**Logseq approach:**
- Capture: `TODO` markers on journal blocks
- Clarify: Add properties, links to projects/contexts
- Organize: Priority `[#A]`, SCHEDULED/DEADLINE dates
- Review: Query pages surface all open/overdue tasks
- Engage: Dashboard with `DOING`/`NOW` queries

**Agaric current state:**
- Task markers: TODO/DOING/DONE via block properties
- Click or Ctrl+Enter to cycle task state
- Visual task icons (Circle/CircleDot/CheckCircle2)
- Priority A/B/C with color-coded badges, slash commands, keyboard shortcuts (`Ctrl+Shift+1/2/3`)
- Agenda mode with collapsible sections per status (TODO/DOING/DONE), paginated
- Timestamps parsed but no scheduling semantics
- No inline query blocks on arbitrary pages

**Gaps to close:**
1. Scheduled/deadline date semantics (not just timestamp syntax)
2. Inline query blocks (embed task lists in project pages)
3. Date-range queries for "overdue" / "this week" filtering

**Verdict: Mostly functional.** Task markers, priority, agenda dashboard all work. Missing scheduling semantics and inline queries for project pages.

---

### Workflow 3: Zettelkasten / Knowledge Management

**Logseq approach:**
- Atomic ideas as blocks with `[[links]]`
- Block references `((uuid))` for precise cross-referencing
- Block embeds for reusing content in multiple contexts
- Backlinks accumulate connections automatically
- Unlinked references discover implicit connections
- Graph view for exploration

**Agaric current state:**
- Blocks with `[[ULID]]` page links (rendered as chips)
- Backlinks panel shows blocks linking to a given block
- Tags for categorization
- No block references or embeds
- No unlinked references
- No graph view (not priority)

**Gaps to close:**
1. Block references -- inline rendering of referenced block content
2. Block embeds -- full tree rendering with edit-in-place
3. Unlinked references -- FTS search for page title mentions without explicit links
4. Richer backlinks (grouped by source page, with context)

**Verdict: Foundation exists.** Links and backlinks work. Missing the precision tools (references, embeds) that make Zettelkasten powerful.

---

### Workflow 4: Meeting Notes

**Logseq approach:**
- Template with attendees, agenda, notes, action items sections
- Person pages (`[[Alice]]`) accumulate all meetings via backlinks
- Action items as `TODO [[Person]] description` -- tracked in task queries
- Follow-up via queries on person pages

**Agaric current state:**
- Can create page for meeting, add blocks underneath
- Can link to other pages via `[[ULID]]`
- Task markers (TODO/DOING/DONE) for action items
- No templates
- No query system for follow-up

**Gaps to close:**
1. Templates
2. Inline queries for person/project pages

**Verdict: Basic.** Can take notes and mark action items, but none of the workflow automation.

---

### Workflow 5: Project Management

**Logseq approach:**
- Project pages with properties (status, deadline, category)
- Task aggregation via queries across all pages
- PARA method via namespaces or properties
- Kanban view via plugin

**Agaric current state:**
- Project pages with PropertiesPanel (add/edit/delete properties)
- Property-based queries (`query_by_property` command, paginated)
- Tags for categorization with boolean AND/OR queries
- Task markers + priority on blocks
- Agenda mode aggregates all tasks by status
- No namespace support, no inline queries

**Gaps to close:**
1. Inline query blocks (embed task lists in project pages)
2. Namespace support (or equivalent organizational structure)
3. Date-range property queries for deadline tracking

**Verdict: Most primitives done, composition layer missing.** Properties, queries, tasks all work individually. Missing inline queries to compose them into project dashboards on a page.

---

### Workflow 6: Research & Reading Notes

**Logseq approach:**
- Built-in PDF reader with highlight-to-block
- Zotero integration for bibliography
- Web clipper for capturing articles
- Progressive summarization with highlight syntax
- Literature note templates

**Agaric current state:**
- Pages and blocks for notes with external URL links
- Properties for metadata (PropertiesPanel)
- Attachments tracked in backend (not rendered in UI)
- No PDF reader, no web clipper, no highlight syntax

**Gaps to close:**
1. Highlight/mark syntax in editor
2. Attachment/image rendering in UI

**Verdict: Basic.** Can take notes with links and properties. Missing highlight syntax and specialized research tooling.

---

## Part 3: Priority Gap Analysis

### Tier 1 -- Next Up (user-selected priorities)

| # | Feature | Why Critical | Effort |
|---|---------|-------------|--------|
| 1 | **Templates** | Journal/meeting/project templates. Auto-populate daily pages. `/Template` slash command | New: template storage (property or dedicated table), template block trees, insertion logic, dynamic variables (`<% today %>`) |
| 2 | **Scheduled/deadline date semantics** | "Show me overdue tasks", "tasks due this week". Turns date links into actionable scheduling | Backend: agenda_cache query by date range, `SCHEDULED`/`DEADLINE` property conventions. Frontend: date-range filters in agenda mode |
| 3 | **Auto-create today's journal on launch** | Logseq opens ready-to-type. We open to a blank page | Frontend only -- create page block on boot if today's journal doesn't exist |
| 4 | **Persist collapse state** | Outliner users lose their carefully structured view on every reload | localStorage keyed by block ID, or `collapsed` block property |
| 5 | **Strikethrough (`~~text~~`)** | Basic formatting people use constantly for "done but visible" items | Serializer + TipTap Strike extension + StaticBlock rendering |
| 6 | **Highlight (`==text==`)** | Emphasis for progressive summarization, research notes | Serializer + TipTap Highlight extension + StaticBlock rendering |
| 7 | **Date-range queries in agenda** | "This week's tasks", "overdue since last Monday" | Extend agenda mode to filter by scheduled/deadline date ranges, not just status |

### Tier 2 -- Important (improves daily use)

| # | Feature | Notes |
|---|---------|-------|
| 8 | Inline query blocks | Embed live query results in any page (task dashboards, project overviews) |
| 9 | Unlinked references | FTS5 search for page title as plain text -- serendipity engine |
| 10 | Zoom into block (focus mode) | Show only a block + descendants |
| 11 | Blockquotes (`> quote`) | Common formatting |
| 12 | Tables | Structured data in blocks |
| 13 | Bullet points in outliner | Tree lines done, but no visible bullet dots at each block |

### Tier 3 -- Nice to Have (polish and parity)

| # | Feature | Notes |
|---|---------|-------|
| 14 | Page aliases | Multiple names for same page |
| 15 | Namespaced pages | Hierarchical organization |
| 16 | Import/export | Migration from Logseq, backups |
| 17 | Math/LaTeX rendering | Academic use |
| 18 | Block-level selection (multi-select) | Bulk operations |
| 19 | Custom link labels for internal links | `[display]([[page]])` |
| 20 | CANCELLED/WAITING task states | GTD completeness |
| 21 | Block references `((id))` | Inline rendering of referenced block content |
| 22 | Block/page embeds `{{embed}}` | Full subtree rendered inline, editable |

### Tier 4 -- Deferred (noted, not priority)

| Feature | Notes |
|---------|-------|
| Graph view | Visual exploration |
| Plugin system | Extensibility |
| Flashcards | Spaced repetition |
| Whiteboard | Infinite canvas |
| PDF annotation | Built-in reader |
| Collaborative editing | Real-time multi-user |

---

## Part 4: What We Do Better Than Logseq

| Area | Agaric Advantage | Logseq Limitation |
|---|---|---|
| **Journal views** | 4 modes (daily/weekly/monthly/agenda) with calendar picker + keyboard nav | Single scrollable daily view |
| **Task dashboard** | Dedicated agenda mode with collapsible sections per state | Requires manually writing Datalog queries |
| **Backlink filtering** | Server-side expression tree: 10 filter types (property text/num/date, tag, FTS, date range, block type) + And/Or/Not composition, keyset pagination | Basic filter bar with simple matching |
| **Formatting toolbar** | BubbleMenu with bold/italic/code/link/page-link/tag/codeblock/priority 1-2-3/date/undo/redo + Radix tooltips with shortcut hints (11 buttons) | None (keyboard shortcuts only) |
| **Sync architecture** | Full sync pipeline: SyncDaemon auto-sync orchestrator + three-way merge + TLS WebSocket + mDNS continuous discovery + cert pinning + ChaCha20-Poly1305 pairing. 5 Tauri commands, exponential backoff, offline detection. Fully wired end-to-end | File-based sync is fragile, conflicts are file-level |
| **Data integrity** | Every op is hash-verified (blake3), crash recovery at boot, op-level undo/redo | File corruption possible, no checksums |
| **Search** | FTS5 with trigram tokenizer (CJK substring search), BM25 ranking, cursor pagination | Standard unicode61 tokenizer, no CJK substring support |
| **Performance architecture** | CQRS materializer, cursor-based pagination everywhere, depth limits (max 20), Tauri 2 | Datascript in-memory DB can be slow for large graphs |
| **Storage efficiency** | Single SQLite file with WAL, zstd-compressed snapshots | One file per page = thousands of small files |
| **Structured properties** | Typed properties (text, num, date, ref) with validation + PropertiesPanel UI | Properties are untyped strings in file graph |
| **ID system** | ULIDs are sortable, case-normalized, deterministic ordering | UUID v4 is random, not sortable |
| **Soft delete** | Cascade soft-delete with restore + purge, timestamp verification | Delete is file deletion or block removal |
| **Undo/redo history** | Op-level undo/redo + HistoryView with multi-select batch revert, filter by op type, payload preview | No explicit undo history UI |
| **Test coverage** | ~3,300 tests across 3 layers (~1,178 Rust + ~2,123 Vitest + E2E Playwright) | Community-reported quality issues |
| **Desktop performance** | Tauri 2 (Rust + WebView) -- small binary, low memory | Electron -- large binary, high memory |
| **Android** | Tauri 2 Android target (spike working, IPC confirmed) | Electron-based, no native mobile |
| **Accessibility** | ~50% ARIA coverage on core components (toolbar, blocks, journal, context menu), keyboard navigation, semantic HTML | Basic keyboard shortcuts, limited ARIA |

---

## Part 5: Summary Scorecard

| Category | Logseq | Agaric | Notes |
|---|:---:|:---:|---|
| Block CRUD | 10 | 9 | Collapse works (not persisted). Tree indent lines done, no bullets. Move up/down via keyboard + DnD. Op-level undo per page, HistoryView for batch revert. Depth limit (20). No multi-block selection, no zoom/focus mode |
| Page management | 9 | 7 | Missing aliases, namespaces |
| Editor formatting | 9 | 8 | Bold/italic/code/headings (h1-h6 via slash commands)/code blocks with lowlight syntax highlighting + 11-button formatting toolbar with Radix tooltips. No tables, highlight, strikethrough, blockquotes |
| Linking system | 10 | 7 | Page links + backlinks + external links + server-side backlink filter expressions (10 filter types + And/Or/Not). Missing block refs, embeds, unlinked refs |
| Properties | 8 | 8 | Full system: backend + PropertiesPanel + priority badges + batch fetch + query_by_property |
| Tags | 8 | 7 | Boolean AND/OR/NOT filtering. Tags not unified with pages (design choice) |
| Query system | 9 | 5 | Tag queries + FTS + property queries + agenda mode. No inline query blocks, no compound queries |
| Task management | 8 | 8 | TODO/DOING/DONE + priority A/B/C (slash commands + Ctrl+Shift+1/2/3 + click-to-cycle badges) + agenda dashboard + context menu actions. No scheduling/deadline semantics |
| Daily journal | 8 | 8 | 4 modes (daily/weekly/monthly/agenda) + calendar picker with content dots + keyboard nav (Alt+Arrow, Alt+T). No templates, no auto-create today, monthly view is stacked sections not grid |
| Search | 8 | 8 | FTS5 with trigram tokenizer (CJK substring search) + BM25 ranking + FTS in pickers + batch resolve. Missing scope filters, unlinked refs |
| Templates | 7 | 0 | Not started -- **top priority** |
| Sync/storage | 5 | 10 | Full sync pipeline: SyncDaemon orchestrator + three-way merge + TLS WebSocket + mDNS discovery + cert pinning + pairing crypto + 5 Tauri commands + exponential backoff + offline detection. Fully wired end-to-end |
| Data integrity | 4 | 9 | Op log + blake3 hashing + recovery + undo hardening + error injection testing |
| Performance arch | 6 | 8 | CQRS + cursor pagination + depth limits + Tauri 2 |
| Import/export | 7 | 0 | Not started |

**Totals: Logseq 116 / Agaric 102** (88%)

**Overall: Agaric has closed most original gaps and now exceeds Logseq in sync architecture (fully automated LAN sync with SyncDaemon), data integrity, search (CJK trigram), backlink filtering (server-side expression tree), undo/redo history, formatting toolbar, and journal views. Sync is now fully wired end-to-end. The next sprint is templates + UX polish (auto-create today, collapse persistence, strikethrough/highlight, monthly calendar grid) + date-aware task scheduling. Block refs/embeds are deferred -- not needed for the target workflow.**

---

## Appendix: Research Sources

- Logseq Documentation: https://docs.logseq.com/
- Logseq GitHub: https://github.com/logseq/logseq
- Logseq Blog: https://blog.logseq.com/
- Logseq Docs Repo: https://github.com/logseq/docs
- Awesome Logseq: https://github.com/logseq/awesome-logseq
