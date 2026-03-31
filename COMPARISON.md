# Block Notes vs Logseq: Comprehensive Feature Comparison

> Goal: Block Notes is meant to fully replace Logseq.
> This document maps every Logseq capability to what we have, what's missing,
> and what needs to be built.

---

## Part 1: Feature-by-Feature Comparison

### 1. Block Model

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Everything is a block (outliner) | Yes -- every piece of content is a bullet | Yes -- `blocks` table, tree via `parent_id` + `position` | None |
| Block nesting / indentation | Unlimited depth, visual indentation | Unlimited depth, visual indentation via `depth` in flat tree | None |
| Block UUIDs | UUID v4 auto-assigned, visible via `id::` property | ULID (uppercase Crockford base32) | None (ULIDs are better -- sortable) |
| Block references `((uuid))` | Inline reference renders source content, live-updating | Not implemented -- `[[ULID]]` links to pages/blocks but does NOT embed content inline | **Critical gap** |
| Block embeds `{{embed ((uuid))}}` | Full content + children rendered inline, editable in-place | Not implemented | **Critical gap** |
| Block properties `key:: value` | Inline `key:: value` syntax on lines after block content | `block_properties` table with typed values (text, num, date, ref). PropertiesPanel UI for viewing/editing. Priority property with color-coded badges | Partial -- general property UI done, no inline `key::` syntax |
| Collapse/expand children | Click arrow or `Ctrl+Up/Down` | Chevron toggle, `Ctrl+.` shortcut, client-side state, focus rescue | Partial -- collapse state lost on page reload (not persisted) |
| Zoom into block (focus mode) | `Alt+Right` focuses on block + descendants only | Not implemented | **Gap** |
| Move block up/down | `Alt+Shift+Up/Down` | Drag-and-drop reordering (tree-aware) | Partial -- no keyboard shortcut for move up/down |
| Block-level selection | `Esc` + arrow keys for multi-block selection | Not implemented | **Gap** |
| Visual hierarchy (bullets / tree lines) | Bullet points + tree lines for nesting | Indentation only — no bullets or tree lines | **UX gap** |
| Cross-block undo | Ctrl+Z works across blocks within session | Undo scoped per block mount — Ctrl+Z never crosses flush boundary | **UX gap** (intentional ADR-02, but frustrating) |

### 2. Page Model

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Pages as named containers | One .md/.org file per page | `blocks` with `block_type = 'page'`, content = page title | None |
| Page properties (frontmatter) | First block holds `key:: value` page properties | `block_properties` on page blocks (backend only) | **UI gap** |
| Page aliases | `alias:: JS, ECMAScript` -- multiple names resolve to same page | Not implemented | **Gap** |
| Namespaced pages | `Project/Backend/API` with `/` separator, parent auto-lists children | Not implemented | **Gap** |
| Page tags via property | `tags:: book, fiction` on page frontmatter | Tags exist (`block_tags` junction table) but not as page-level property syntax | Partial -- mechanism exists, syntax/UX missing |
| `title::` override | Display title differs from file/page name | Block content IS the title. No separate title property | Minor gap |
| Auto-created pages from links | Clicking `[[New Page]]` creates the page | `[[` picker has "Create new" option that auto-creates page blocks | None |

### 3. Editor & Formatting

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Markdown support | Full Markdown (headings, lists, tables, code blocks, etc.) | Org-mode based. Frontend uses TipTap with custom serializer | Different format -- see Org-mode section |
| Org-mode support | Full .org format alternative | Org-mode inline syntax: `*bold*`, `/italic/`, `~code~` | Partial -- inline only, no headings/lists/tables/drawers |
| **Bold** | `**bold**` | `*bold*` (org-mode) | None (different syntax, same feature) |
| *Italic* | `*italic*` | `/italic/` (org-mode) | None |
| ~~Strikethrough~~ | `~~text~~` | Not implemented in org parser | **Gap** |
| ==Highlight== | `^^text^^` | Not implemented | **Gap** |
| `Inline code` | `` `code` `` | `~code~` (org-mode) | None |
| Headings in blocks | `# H1`, `## H2`, etc. inside blocks | Parsed and rendered in static view (styled h1-h6). No syntax highlighting in editor | Partial -- static rendering works, editor support incomplete |
| Code blocks with syntax highlighting | ````python ... ``` `` | Code blocks parsed + rendered in `<pre><code>` blocks. No syntax highlighting | Partial -- no language-aware highlighting |
| Math/LaTeX | `$$E=mc^2$$` inline and block | Not implemented | **Gap** |
| Tables | Markdown tables | Not implemented | **Gap** |
| Blockquotes | `> quote` | Not implemented | **Gap** |
| Slash commands `/` | 20+ commands (TODO, template, date, embed, etc.) | `/TODO`, `/DOING`, `/DONE`, `/date`, `/PRIORITY HIGH/MED/LOW` — 7 commands via TipTap Suggestion extension | Partial — framework built, 7 commands. Extensible for more |
| Autocomplete for `[[` | Search all pages | Yes -- `block-link-picker` extension, searches pages, "Create new" option | None |
| Autocomplete for `#` | Search all tags | Yes -- `tag-picker` extension, searches tags | None |
| Autocomplete for `((` | Search all blocks for reference | Not implemented -- no block reference system | **Gap** (requires block refs first) |
| Autocomplete for `::` | Property name suggestions | Not implemented | **Gap** |
| Multi-line blocks | Content can span multiple lines within one block | `Shift+Enter` for hard break within block. `Enter` creates new sibling | None |

### 4. Linking System

| Capability | Logseq | Block Notes | Gap |
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

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Block properties | `key:: value` inline syntax | `block_properties` table with `set_property` / `delete_property` / `get_properties` commands. Backend + frontend wrappers complete | Backend + API complete, **no general UI** (task marker is the first property-based UI) |
| Typed values | DB version: Text, Number, Date, DateTime, Checkbox, URL, Node | 4 types: text, num, date, ref (block reference) | Close -- missing DateTime, Checkbox, URL |
| Built-in properties | 17+ (tags, alias, title, icon, template, collapsed, etc.) | None built-in -- all custom | **Gap** -- need to define semantic properties |
| Property-based queries | `{{query (property type book)}}` | `query_by_tags` supports tag-based queries. No property-based query command | **Gap** |
| Property name autocomplete | `::` triggers suggestions | Not implemented | **Gap** |
| Property value autocomplete | Suggests previously-used values | Not implemented | **Gap** |
| Comma-separated multi-values | `tags:: a, b, c` parsed as multiple refs | Not supported | **Gap** |

### 6. Tags

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Inline tag syntax | `#tag` or `#[[multi word]]` | `#[ULID]` rendered as styled chip with name | Functional but different -- ULID-based, not name-based |
| Tags as pages | Every tag IS a page (same backlink system) | Tags and pages are separate `block_type` values | **Design difference** -- Logseq unifies, we separate |
| Tag hierarchy / namespaces | `/` separator in tag names | Not implemented | **Gap** |
| Tag filtering | Filter in linked references, simple queries | `TagFilterPanel` with boolean AND/OR, prefix search | Good -- arguably better for structured queries |
| Tag usage counts | Shown in various UIs | `tags_cache` tracks `usage_count` | None |
| Tag autocomplete | `#` triggers search | Yes -- `tag-picker` extension | None |
| Tag inheritance (DB version) | Parent tags via `Extends`, child inherits properties | Not implemented | **Gap** (advanced feature) |

### 7. Query System

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Simple queries | `{{query (and [[page]] (task TODO))}}` -- embedded live results | Not implemented -- no inline query blocks | **Major gap** |
| Query operators | `and`, `or`, `not` | `TagExpr` supports `And`, `Or`, `Not` for tag queries only | Very limited scope |
| Date-based queries | `(between -7d today)`, relative dates | `list_blocks` supports `agendaDate` filter (single date, not range) | **Gap** -- no date range queries |
| Task queries | `(task TODO DOING)`, `(priority A)` | Not implemented -- no task system | **Major gap** |
| Property queries | `(property type book)`, `(page-property status active)` | Not implemented | **Gap** |
| Advanced Datalog queries | Full Datascript query language with custom rules | Not implemented -- backend uses SQL directly | **Gap** (but SQL could serve same purpose) |
| Query result as table | `query-table:: true` with selectable columns | Not implemented | **Gap** |
| Live-updating results | Queries re-evaluate on data change | FTS search and tag queries are live. No inline query blocks | Partial |
| Query sort/transform | `:result-transform`, `:sort-by` | Pagination cursors handle sort order. No user-customizable sort | **Gap** |

### 8. Task Management

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Task markers | `TODO`, `DOING`, `DONE`, `CANCELLED`, `NOW`, `LATER` | TODO/DOING/DONE via block properties. Click to cycle, `Ctrl+Enter` shortcut. Visual icons (Circle/CircleDot/CheckCircle2) | Partial -- 3 states vs Logseq's 6, no CANCELLED/NOW/LATER |
| Priority levels | `[#A]`, `[#B]`, `[#C]` | Not implemented | **Gap** |
| Scheduled dates | `SCHEDULED: <2024-12-27 Fri>` | Org-mode timestamps parsed (`<2024-01-15 Mon>`) but no task scheduling semantics | Partial -- syntax exists, semantics missing |
| Deadline dates | `DEADLINE: <2024-12-31 Tue>` | Same as above | Partial |
| Task cycling | `Ctrl+Enter` toggles TODO/DONE | Click marker or `Ctrl+Enter` cycles TODO → DOING → DONE → none | Comparable |
| Task queries/dashboard | Embedded queries surface tasks across graph | Not implemented | **Gap** |
| Custom task keywords | Configurable via `config.edn` | Not implemented | **Gap** |
| Recurring tasks | Via plugins | Not implemented | **Gap** |

### 9. Daily Journal

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Auto-created daily page | Created at midnight, date as title | `JournalPage` component -- auto-creates page with `YYYY-MM-DD` content on first block | Comparable |
| Default landing page | Opens to today's journal | App opens to journal view | None |
| Date navigation | `g n`/`g p` for next/prev day, date picker | Prev/next buttons per mode, calendar date picker, Today button. No keyboard shortcuts (g n/g p) | Partial -- no keyboard shortcuts for journal navigation |
| Scrollable past journals | Past days stacked below today | Daily: single day. Weekly: 7-day sections. Monthly: stacked all-month sections (not a grid). No "Load older days" button or infinite scroll | **Gap** -- monthly renders 28-31 sections with full BlockTrees (performance issue) |
| Journal templates | Auto-populated via `config.edn` | Not implemented | **Gap** |
| Configurable date format | `:journal/page-title-format` | Fixed `YYYY-MM-DD` | Minor gap |
| Natural language dates | Type "next friday" in date picker | Not implemented | **Gap** |
| "On this day" queries | Datalog query for same date last year | Not implemented (requires query system) | **Gap** |
| Auto-create today's journal | Daily page created on app launch | Not implemented — user must click "Add block" on empty today | **UX gap** |

### 10. Search

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Full-text search | `Ctrl+K` / `Cmd+K` global search | `SearchPanel` with FTS5 backend, debounced, paginated | Comparable |
| Search scope | Pages + blocks, filterable | All blocks, no scope filtering | Minor gap |
| Search ranking | BM25-based | FTS5 rank (BM25) with cursor pagination | None |
| Search in linked references | Filter bar in backlinks panel | Not implemented | **Gap** |
| Recent pages quick access | Shown in search results | Not implemented | **Gap** |
| Unlinked references search | Finds plain-text mentions of page name | Not implemented | **Gap** |

### 11. Sync & Storage

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Local-first | Flat files on disk (.md/.org per page) | SQLite database in app data dir | Both local-first, different storage model |
| File format | Human-readable Markdown or Org-mode files | Binary SQLite database | **Trade-off** -- our format is not human-readable but more robust |
| Cloud sync | Logseq Sync (paid), or DIY via git/iCloud/Dropbox | Not implemented -- infrastructure exists (peer_refs, DAG, merge) but no sync protocol | **Gap** -- backend ready, transport missing |
| Conflict resolution | File-level, can cause issues with git | Three-way merge with diffy, conflict copies, LWW for properties | **We're better** architecturally |
| Multi-device | Via sync solution | Not yet -- single device | **Gap** |
| Op log / history | No explicit op log (git history if using git) | Full append-only op log with blake3 hashes, per-device sequence | **We're better** |
| Snapshots / compaction | N/A (file-based) | zstd-compressed CBOR snapshots, 90-day compaction | **We're better** |
| Crash recovery | File system journaling | Explicit recovery at boot (pending snapshots, draft errors) | **We're better** |

### 12. Templates

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Template creation | Block/page with `template:: name` property | Not implemented | **Gap** |
| Template insertion | `/Template` slash command | Not implemented | **Gap** |
| Dynamic variables | `<% today %>`, `<% time %>`, `<% current page %>`, etc. | Not implemented | **Gap** |
| Default journal template | `:default-templates {:journals "name"}` in config | Not implemented | **Gap** |
| Template including parent | `template-including-parent:: true` | Not implemented | **Gap** |

### 13. Import / Export

| Capability | Logseq | Block Notes | Gap |
|---|---|---|---|
| Markdown export | Full graph export to .md files | Not implemented | **Gap** |
| JSON/EDN export | Data export | Not implemented | **Gap** |
| OPML export | Outline export | Not implemented | **Gap** |
| Import from Roam | JSON import | Not implemented | **Gap** |
| Import from Notion | Markdown import | Not implemented | **Gap** |
| Publishing as HTML | Static site generation | Not implemented | **Gap** |

### 14. Out of Scope (Noted, Not Priority)

| Feature | Logseq | Block Notes | Notes |
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

**Block Notes current state:**
- Scrollable multi-day journal view (daily/weekly/monthly modes)
- Each day section with its own BlockTree, date header, "Add block"
- Task markers (TODO/DOING/DONE) with click-to-cycle and Ctrl+Enter
- Block collapse/expand with chevron toggle and Ctrl+. (state not persisted)
- "Open in page editor" link per day
- Calendar date picker with content dots

**Gaps to close:**
1. Journal templates (auto-populate new journal pages)
2. Task queries to surface TODOs across all journal days
3. Auto-create today's journal page on app launch
4. "Load older days" / infinite scroll for past entries
5. Monthly view should be calendar grid, not 31 stacked sections
6. Keyboard shortcuts for date navigation (g n / g p / g t)

**Verdict: Functional but incomplete.** Core daily journal workflow works for a single day, but multi-day views are problematic (monthly is a performance issue), no templates, no task dashboard, and no keyboard navigation shortcuts. Not ready to replace Logseq for serious journalers.

---

### Workflow 2: Task Management / GTD

**Logseq approach:**
- Capture: `TODO` markers on journal blocks
- Clarify: Add properties, links to projects/contexts
- Organize: Priority `[#A]`, SCHEDULED/DEADLINE dates
- Review: Query pages surface all open/overdue tasks
- Engage: Dashboard with `DOING`/`NOW` queries

**Block Notes current state:**
- Task markers: TODO/DOING/DONE via block properties
- Click or Ctrl+Enter to cycle task state
- Visual task icons (Circle/CircleDot/CheckCircle2)
- Timestamps parsed but no scheduling semantics
- No task queries or dashboard

**Gaps to close:**
1. Priority system ([#A], [#B], [#C])
2. Scheduled/deadline date semantics (not just timestamp syntax)
3. Task query commands (filter by marker, priority, date range)
4. Dashboard view (or inline query blocks)

**Verdict: Started.** Task markers work. Missing priority, scheduling semantics, and task queries.

---

### Workflow 3: Zettelkasten / Knowledge Management

**Logseq approach:**
- Atomic ideas as blocks with `[[links]]`
- Block references `((uuid))` for precise cross-referencing
- Block embeds for reusing content in multiple contexts
- Backlinks accumulate connections automatically
- Unlinked references discover implicit connections
- Graph view for exploration

**Block Notes current state:**
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

**Block Notes current state:**
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

**Block Notes current state:**
- Can create project pages
- Properties exist in backend but no UI
- Tags for categorization
- No queries for aggregation
- No namespace support

**Gaps to close:**
1. Property UI (view/edit on blocks and pages)
2. Property-based queries
3. Namespace support (or equivalent organizational structure)
4. Task aggregation

**Verdict: Infrastructure exists, UX doesn't.**

---

### Workflow 6: Research & Reading Notes

**Logseq approach:**
- Built-in PDF reader with highlight-to-block
- Zotero integration for bibliography
- Web clipper for capturing articles
- Progressive summarization with highlight syntax
- Literature note templates

**Block Notes current state:**
- Can create pages and blocks for notes
- Attachments tracked in backend (not rendered in UI)
- No PDF reader
- No web clipper
- No highlight syntax

**Gaps to close:**
This is a deep feature set. Minimum viable:
1. Highlight/mark syntax in editor
2. Attachment rendering in UI (at least images)
3. External link syntax and rendering

**Verdict: Not started** on the specialized tooling. Basic note-taking works.

---

## Part 3: Priority Gap Analysis

### Tier 1 -- Critical (blocks core Logseq replacement)

| # | Feature | Why Critical | Backend Ready? |
|---|---------|-------------|----------------|
| 1 | **Task markers** (TODO/DOING/DONE) | Enables GTD, meeting action items, project management | **Done** -- `set_property` command + cycling UI |
| 2 | **Block references** `((id))` | Core Zettelkasten, reuse of ideas | Need new inline syntax + resolver |
| 3 | **Block embeds** `{{embed ((id))}}` | Content reuse, editable in context | Need embed component + renderer |
| 4 | **Collapse/expand** | Essential for large outlines | **Done** -- chevron toggle, Ctrl+., client-side state |
| 5 | **Properties UI** | Backend supports it, users can't see/edit them | Frontend only |
| 6 | **Slash commands** `/` | Discovery, task creation, template insertion | **Partial** -- framework + 4 commands (/TODO /DOING /DONE /date) |
| 7 | **Inline queries** | Task dashboards, project overviews | Need query block renderer + backend support |

### Tier 2 -- Important (enables key workflows)

| # | Feature | Why Important | Backend Ready? |
|---|---------|--------------|----------------|
| 8 | Templates | Reusable structures for journals, meetings, projects | Need template storage + insertion |
| 9 | Scrollable past journals / "Load older days" | Journal-centric workflow | **Not implemented** -- monthly view is 28-31 stacked sections |
| 10 | Property-based queries | Project management, PARA method | Need new query command |
| 11 | Scheduled/deadline semantics | Task management with dates | Timestamps parsed, need semantic layer |
| 12 | Strikethrough + highlight syntax | Formatting parity | Serializer extension |
| 13 | Move block up/down keyboard shortcut | Fast outliner editing | Frontend only |
| 14 | Zoom into block | Focus on subtree | Frontend only |
| 15 | Persist collapse state | Users lose outline on reload | localStorage or block property |
| 16 | Visual tree lines / bullets | Outline hard to scan without hierarchy cues | CSS + component change |
| 17 | Auto-create today's journal on launch | First-time UX is blank | Frontend only |
| 18 | Journal keyboard nav shortcuts (g n / g p) | Power users expect fast date nav | Frontend only |
| 19 | Monthly view as calendar grid | Current stacked view renders 31 BlockTrees | Replace renderMonthly() |
| 20 | Batch property fetch (single IPC) | Current N+1 fetch slows page load | New backend command |
| 21 | Global resolve cache (Zustand store) | Duplicated listBlocks calls per mount | Refactor |

### Tier 3 -- Nice to Have (polish and parity)

| # | Feature | Notes |
|---|---------|-------|
| 16 | Page aliases | Multiple names for same page |
| 17 | Namespaced pages | Hierarchical organization |
| 18 | Unlinked references | Discover implicit connections |
| 19 | Code blocks with syntax highlighting | Rich content |
| 20 | Math/LaTeX rendering | Academic use |
| 21 | Tables | Structured data in blocks |
| 22 | Headings within blocks | Document structure |
| 23 | Block-level selection (multi-select) | Bulk operations |
| 24 | Import/export | Migration and backup |
| 25 | Custom link labels | `[display](target)` |

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

Not everything is a gap. Block Notes has architectural advantages:

| Area | Block Notes Advantage | Logseq Limitation |
|---|---|---|
| **Sync foundation** | Append-only op log, DAG-based merge, three-way conflict resolution, blake3 integrity | File-based sync is fragile, conflicts are file-level |
| **Data integrity** | Every op is hash-verified, crash recovery at boot | File corruption possible, no checksums |
| **Performance architecture** | CQRS materializer, cursor-based pagination everywhere, FTS5 with proper ranking | Datascript in-memory DB can be slow for large graphs |
| **Storage efficiency** | Single SQLite file with WAL, zstd-compressed snapshots | One file per page = thousands of small files |
| **Structured properties** | Typed properties (text, num, date, ref) with validation | Properties are untyped strings in file graph |
| **ID system** | ULIDs are sortable, case-normalized, deterministic ordering | UUID v4 is random, not sortable |
| **Soft delete** | Cascade soft-delete with restore + purge, timestamp verification | Delete is file deletion or block removal |
| **Test coverage** | 1,571 tests across 3 layers (Rust, Vitest, Playwright) | Community-reported quality issues |
| **Desktop performance** | Tauri 2 (Rust + WebView) -- small binary, low memory | Electron -- large binary, high memory |

---

## Part 5: Summary Scorecard

| Category | Logseq | Block Notes | Notes |
|---|:---:|:---:|---|
| Block CRUD | 10 | 9 | Collapse state not persisted. No visual bullets/tree lines. Cross-block undo missing |
| Page management | 9 | 7 | Missing aliases, namespaces, page properties UI |
| Editor formatting | 9 | 7 | Bold/italic/code + headings/code blocks with syntax highlighting. /PRIORITY commands. No tables, highlight, strikethrough |
| Linking system | 10 | 5 | Have page links + backlinks + external links. Missing block refs, embeds, unlinked refs |
| Properties | 8 | 8 | Full property system: backend + PropertiesPanel UI + priority badges + property-based filtering + query_by_property |
| Tags | 8 | 7 | Good filtering. Tags not unified with pages (design choice) |
| Query system | 9 | 4 | Tag queries + FTS + property queries. No inline queries yet |
| Task management | 8 | 7 | TODO/DOING/DONE + priority [A/B/C] + agenda mode + /commands. No scheduling, deadline semantics |
| Daily journal | 8 | 7 | Tri-mode + agenda mode, calendar picker, keyboard nav. No templates, no auto-create today |
| Search | 8 | 7 | Good FTS5. Missing scope filters, unlinked references |
| Templates | 7 | 0 | Not started |
| Sync/storage | 5 | 8 | Our architecture is fundamentally better, but sync not exposed yet |
| Data integrity | 4 | 9 | Op log + hashing + recovery is far ahead |
| Performance arch | 6 | 8 | CQRS + cursor pagination + Tauri 2. N+1 property fetch, resolve preload issues |
| Import/export | 7 | 0 | Not started |

**Overall: Block Notes has a rock-solid foundation (data model, sync, integrity, performance) but is missing the user-facing features that make Logseq's workflows possible. The priority is building up from Tier 1 gaps. Key UX issues (collapse persistence, cross-block undo, visual hierarchy, monthly view) need fixing alongside feature gaps.**

---

## Appendix: Research Sources

- Logseq Documentation: https://docs.logseq.com/
- Logseq GitHub: https://github.com/logseq/logseq
- Logseq Blog: https://blog.logseq.com/
- Logseq Docs Repo: https://github.com/logseq/docs
- Awesome Logseq: https://github.com/logseq/awesome-logseq
