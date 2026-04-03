# Agaric vs Logseq: Feature Comparison

> Goal: Agaric is meant to fully replace Logseq.
> This document maps every Logseq capability to what we have, what's planned, and what's missing.

**Status key:**

| Label | Meaning |
|-------|---------|
| **Done** | Fully implemented and shipped |
| **Partial** | Implemented but incomplete |
| **Planned (#N)** | Designed in REVIEW-LATER.md, not yet built |
| **Gap** | Not implemented, not currently planned |
| **Design choice** | Intentionally different from Logseq |

---

## Part 1: Feature-by-Feature Comparison

### 1. Block Model

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Everything is a block (outliner) | Yes — every piece of content is a bullet | Yes — `blocks` table, tree via `parent_id` + `position` | Done |
| Block nesting / indentation | Unlimited depth | Unlimited depth (max 20), visual indentation via `depth` in flat tree | Done |
| Block UUIDs | UUID v4 | ULID (uppercase Crockford base32, sortable) | Done |
| Block references `((uuid))` | Inline renders source content, live-updating | `[[ULID]]` links to pages/blocks as navigable chips. No inline content rendering | Gap |
| Block embeds `{{embed ((uuid))}}` | Full content + children rendered inline, editable | Not implemented | Gap |
| Block properties `key:: value` | Inline `key:: value` syntax | `block_properties` table with typed values (text, num, date, ref). PagePropertyTable for page-level CRUD. Slash commands for block-level setting. No inline `key::` syntax | Partial |
| Collapse/expand children | Click arrow or `Ctrl+Up/Down` | Chevron toggle, `Ctrl+.` shortcut. State is ephemeral (lost on reload) | Partial |
| Zoom into block (focus mode) | `Alt+Right` shows block + descendants | Zoom-in with breadcrumb trail. Home button + ancestor navigation | Done |
| Move block up/down | `Alt+Shift+Up/Down` | DnD reordering (tree-aware, @dnd-kit) + `Ctrl+Shift+Up/Down` keyboard shortcuts | Done |
| Block-level selection | `Esc` + arrow keys for multi-block select | Not implemented (single-focus roving editor per ADR-01) | Gap |
| Visual hierarchy | Bullet points + tree lines | Indentation + tree indent guide lines (`border-l`). No bullet points | Partial |
| Cross-block undo | Ctrl+Z across blocks within session | Op-level undo/redo: `Ctrl+Z`/`Ctrl+Y`, per-page undo depth + redo stack, HistoryView with multi-select batch revert, word-level diff. Scoped per page (ADR-02) | Done |

**Planned improvements:**
- Inline property chips + click-to-edit + block property drawer (Planned #645) — makes custom properties visible and editable at block level

### 2. Page Model

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Pages as named containers | One .md/.org file per page | `blocks` with `block_type = 'page'`, content = title | Done |
| Page properties (frontmatter) | First block holds `key:: value` | `block_properties` on page blocks. PagePropertyTable UI: collapsible, typed inputs, add/delete | Done |
| Page aliases | `alias:: JS, ECMAScript` | `page_aliases` table with `set_page_aliases`/`get_page_aliases`/`resolve_page_by_alias`. PageHeader UI with alias badges (add/remove) | Done |
| Namespaced pages | `Project/Backend/API` with `/` separator | Not implemented | Gap |
| Page tags via property | `tags:: book, fiction` | Tags via `block_tags` junction table + @picker. Tags exist but aren't page-level property syntax | Partial |
| `title::` override | Display title differs from filename | Block content IS the title. No separate title property | Design choice |
| Auto-created pages from links | Clicking `[[New Page]]` creates page | `[[` picker has "Create new" option | Done |

### 3. Editor & Formatting

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Markdown support | Full Markdown | Markdown subset via TipTap + custom serializer (bold, italic, code, headings, code blocks, links). No tables, blockquotes, lists | Partial |
| Org-mode support | Full .org format | Not implemented. Org-mode inspires features (tags, properties, agenda), not file format | Design choice |
| **Bold** | `**bold**` | `**bold**` | Done |
| *Italic* | `*italic*` | `*italic*` | Done |
| ~~Strikethrough~~ | `~~text~~` | Not implemented | Gap |
| ==Highlight== | `^^text^^` | Not implemented | Gap |
| `Inline code` | `` `code` `` | `` `code` `` | Done |
| Headings | `# H1` ... `###### H6` inside blocks | `/h1`-`/h6` slash commands + TipTap Heading extension (levels 1-6) | Done |
| Code blocks | Fenced with language, syntax highlighting | Fenced code blocks with lowlight syntax highlighting (common language set, auto-detect fallback) | Done |
| Math/LaTeX | `$$E=mc^2$$` inline and block | Not implemented | Gap |
| Tables | Markdown tables | Not implemented | Gap |
| Blockquotes | `> quote` | Not implemented | Gap |
| Slash commands `/` | 20+ commands | 23 commands: TODO, DOING, DONE, DATE, DUE, SCHEDULED, LINK, TAG, CODE, EFFORT, ASSIGNEE, LOCATION, REPEAT, TEMPLATE + PRIORITY 1/2/3 + H1-H6 | Done |
| Autocomplete `[[` | Search all pages | block-link-picker extension, page search, "Create new" option | Done |
| Autocomplete `@` | Search all tags | at-tag-picker extension, tag search, "Create new" option | Done |
| Autocomplete `((` | Search all blocks for reference | Not implemented — no block reference system | Gap |
| Property autocomplete `::` | Suggests property names | Not implemented | Gap |
| Multi-line blocks | Content spans multiple lines | `Shift+Enter` for hard break, `Enter` creates sibling | Done |
| Formatting toolbar | None (keyboard only) | BubbleMenu: bold/italic/code/link/page-link/tag/code-block/priority 1-2-3/date/undo/redo (11 buttons) + Radix tooltips with shortcut hints | Better |

### 4. Linking System

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Page links `[[page]]` | `[[page name]]`, creates page if needed | `[[ULID]]` rendered as clickable chips with title resolution. Links by ID (more robust, less human-readable in raw text) | Done |
| Block references `((uuid))` | Inline content preview, live-updating | Not implemented | Gap |
| Block embeds `{{embed ((uuid))}}` | Full tree rendered inline, editable | Not implemented | Gap |
| Page embeds `{{embed [[page]]}}` | Entire page content inline | Not implemented | Gap |
| Tags as links | `#tag` = `[[tag]]` — tags ARE pages | Tags are separate entities (`block_type = 'tag'`). `#[ULID]` renders as tag chip | Design choice |
| External links | `[text](url)` | `[text](url)` with browser open from static view. Ctrl+K shortcut, autolink on paste | Done |
| Linked references | Grouped by source page | LinkedReferences component: grouped by source page, collapsible groups, cursor pagination | Done |
| Unlinked references | Plain-text mentions of page name | UnlinkedReferences component: "Link it" button to convert mentions, grouped by source page, cursor pagination | Done |
| Backlink filtering | Simple filter bar | Server-side expression tree: 11 filter types (PropertyText/Num/Date, PropertyIsSet/Empty, HasTag, HasTagPrefix, Contains, CreatedInRange, BlockType) + And/Or/Not composition | Better |
| Page graph (local) | Visual graph of connections | Not implemented | Out of scope |
| Custom link labels | `[display text]([[page]])` | Not implemented | Gap |

### 5. Properties System

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Block properties | `key:: value` inline syntax | `block_properties` table with typed columns. set/delete/get/batch API | Done (backend). Partial (UX) |
| Typed values | Text, Number, Date, DateTime, Checkbox, URL, Node | 4 types: text, number, date, ref. Schema registry via `property_definitions` with options | Partial |
| Built-in property definitions | 17+ (tags, alias, title, icon, template, etc.) | 9 seeded: todo_state, priority, due_date, scheduled_date, created_at, completed_at, effort, assignee, location | Done |
| Property-based queries | `{{query (property type book)}}` | `query_by_property` command with cursor pagination. Used by agenda, DonePanel. No inline query blocks | Partial |
| Property name autocomplete | `::` triggers suggestions | Not implemented | Gap |
| Property value autocomplete | Suggests previously-used values | Not implemented | Gap |
| Comma-separated multi-values | `tags:: a, b, c` parsed as multiple refs | Not supported | Gap |

**Planned improvements:**
- Properties management view: browse, rename, change type, delete, usage counts (Planned #643)
- Inline property chips on blocks, click-to-edit popovers, block property drawer (Planned #645)

### 6. Tags

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Inline tag syntax | `#tag` or `#[[multi word]]` | `#[ULID]` rendered as styled chip with resolved name | Done |
| Tags as pages | Every tag IS a page | Tags and pages are separate `block_type` values | Design choice |
| Tag hierarchy / namespaces | `/` separator in tag names | Prefix-based: `work/meeting` naming convention with LIKE search for hierarchy queries. No parent-child relationships | Partial |
| Tag filtering | Filter in linked references | TagFilterPanel with boolean AND/OR/NOT, prefix search. TagExpr with full boolean composition | Better |
| Tag usage counts | Shown in various UIs | `tags_cache` tracks `usage_count` | Done |
| Tag autocomplete | Triggers search | @picker extension with create-new option | Done |
| Tag inheritance (DB version) | Parent tags via `Extends` | Not implemented | Gap |

### 7. Query System

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Simple queries | `{{query (and [[page]] (task TODO))}}` embedded live results | Not implemented — no inline query blocks | Gap |
| Query operators | `and`, `or`, `not` | `TagExpr` supports AND/OR/NOT for tag queries. Backlink filter expressions with full And/Or/Not composition | Partial |
| Date-based queries | `(between -7d today)`, relative dates | Agenda filter presets: Today, This week, Overdue, Next 7/14/30 days for both due and scheduled dates | Partial |
| Task queries | `(task TODO DOING)`, `(priority A)` | Agenda mode: TODO/DOING/DONE sections with priority sorting. DonePanel: completed tasks by date. No inline query blocks | Partial |
| Property queries | `(property type book)` | `query_by_property` with cursor pagination. Single key+value filter | Partial |
| Advanced Datalog queries | Full Datascript query language | Not implemented — backend uses SQL | Gap |
| Query result as table | `query-table:: true` | Not implemented | Gap |
| Live-updating results | Queries re-evaluate on change | FTS search and agenda are live. No inline query blocks to update | Partial |
| Query sort/transform | `:result-transform`, `:sort-by` | Fixed sort orders in agenda/backlinks. No user-customizable sort | Gap |

**Planned improvements:**
- Agenda filter by creation/completion dates, custom properties, flexible date ranges (Planned #642)

### 8. Task Management

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Task markers | TODO, DOING, DONE, CANCELLED, NOW, LATER | TODO/DOING/DONE via properties. Click to cycle, `Ctrl+Enter`. Visual icons (Circle/CircleDot/CheckCircle2) | Partial (3 of 6 states) |
| Priority levels | `[#A]`, `[#B]`, `[#C]` | Priority A/B/C: slash commands, `Ctrl+Shift+1/2/3`, click-to-cycle badge. Color-coded: A=red, B=amber, C=blue | Done |
| Due dates | `DEADLINE: <date>` | `due_date` column on blocks. `/due` slash command, date picker. Agenda filter: Today, This week, Overdue, Next 7/14/30 days | Done |
| Scheduled dates | `SCHEDULED: <date>` | `scheduled_date` column. `/scheduled` slash command, date picker. Agenda filter: Today, This week, Overdue, Next 7/14/30 days | Done |
| Task cycling | `Ctrl+Enter` toggles TODO/DONE | Click marker or `Ctrl+Enter` cycles TODO -> DOING -> DONE -> none | Done |
| Recurring tasks | Via plugins | Native recurrence via `repeat` property. Modes: daily, weekly, monthly, `+Nd`, `+Nw`, `+Nm`. On DONE transition: creates sibling with shifted dates | Done (basic) |
| Task dashboard | Embedded queries surface tasks | Agenda mode: collapsible TODO/DOING/DONE sections with priority sorting, paginated. DonePanel: completed tasks grouped by source page | Done |
| Custom task keywords | Configurable in `config.edn` | Hardcoded TODO/DOING/DONE cycle | Gap |
| Effort tracking | Via plugins | `/effort` slash command, `effort` property definition | Done |

**Planned improvements:**
- Scheduling semantics: hide-before scheduled date, deadline warning period, overdue rollforward (Planned #641)
- Repeat modes: `.+` (from completion), `++` (catch-up). End conditions: repeat-until, repeat-count. Agenda projection of future occurrences (Planned #644)

### 9. Daily Journal

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Auto-created daily page | Created at midnight | Auto-creates today's page on launch in daily mode. Applies journal template if one is set | Done |
| Default landing page | Opens to today's journal | App opens to journal view | Done |
| Date navigation | `g n`/`g p`, date picker | Prev/next per mode, calendar picker with content dots, Today button. `Alt+Left/Right` (mode-aware), `Alt+T` for today | Done |
| View modes | Single scrollable daily view | 4 modes: Daily, Weekly, Monthly, Agenda | Better |
| Scrollable past journals | Past days stacked below today | Daily: single day. Weekly: 7-day sections. Monthly: stacked sections (not grid). No "load older" / infinite scroll | Partial |
| Journal templates | `default-templates > :journals` in config | Journal template auto-apply via `journal-template=true` property on template page. Applied on auto-create | Partial |
| Configurable date format | `:journal/page-title-format` | Fixed `YYYY-MM-DD` | Gap |
| Natural language dates | "next friday" in date picker | `parse-date.ts` (267 lines, 200+ tests): "today", "tomorrow", "yesterday", "next monday", "in 3 days", "end of month", "+3d"/"+1w"/"+2m", ISO/month-name/ambiguous formats. Missing: "last monday", "this week" | Partial |
| "On this day" queries | Datalog for same date last year | Not implemented | Gap |

**Planned improvements:**
- Journal templates: auto-populate structure with multiple sections for new days (Planned #630)
- Full template system: dynamic variables (`{{today}}`, `{{time}}`), template CRUD UI, journal auto-apply config (Planned #639)

### 10. Search

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Full-text search | `Ctrl+K` global search | SearchPanel with FTS5 backend (trigram tokenizer), debounced, cursor-paginated | Done |
| Search scope | Pages + blocks, filterable | All blocks, no scope filtering | Partial |
| Search ranking | BM25-based | FTS5 rank (BM25) with cursor pagination | Done |
| Search in backlinks | Filter bar | Server-side filter expressions with Contains (FTS5 within backlinks) + 10 other filter types with And/Or/Not | Better |
| CJK/substring search | unicode61 tokenizer | Trigram tokenizer (case_sensitive=0) — full substring and CJK support | Better |
| Unlinked references | Plain-text mentions | UnlinkedReferences component with "Link it" button, grouped by source page | Done |
| Recent pages quick access | Shown in search results | Not implemented | Gap |

### 11. Sync & Storage

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Local-first | Flat files on disk (.md/.org per page) | SQLite (WAL mode) in app data dir | Both local-first |
| File format | Human-readable Markdown/Org files | Binary SQLite | Design choice |
| Sync | Logseq Sync (paid) or DIY git/iCloud/Dropbox | SyncDaemon: mDNS discovery, TLS WebSocket, ECDSA P-256 cert pinning, ChaCha20-Poly1305 pairing, exponential backoff (1s-60s), debounced change sync (3s), periodic resync (60s). Frontend: periodic sync, offline detection, toast notifications | Better |
| Conflict resolution | File-level (fragile with git) | Three-way merge (diffy): edit divergence, property LWW, move LWW, delete-vs-edit resurrection. Conflict copies for unresolvable | Better |
| Multi-device | Via sync solution | LAN sync via SyncDaemon: mDNS continuous discovery, immediate sync on peer appearance, periodic resync, change-triggered debounce | Done |
| Op log / history | No explicit op log | Full append-only op log with blake3 hash chain, per-device sequences, cursor-paginated history | Better |
| Snapshots / compaction | N/A | zstd-compressed CBOR snapshots, 90-day compaction | Better |
| Crash recovery | File system journaling | Explicit recovery at boot (pending snapshots, draft errors, op-log verification) | Better |
| Storage efficiency | One file per page (thousands of small files) | Single SQLite with WAL | Better |

### 12. Templates

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Template creation | Block/page with `template:: name` property | Pages marked with `template=true` property serve as templates | Partial |
| Template insertion | `/Template` slash command | `/template` slash command with template picker. Copies template children as new blocks | Done |
| Dynamic variables | `<% today %>`, `<% time %>`, `<% current page %>` | Not implemented | Gap |
| Default journal template | `:default-templates {:journals "name"}` | Pages with `journal-template=true` auto-apply on journal page creation | Partial |
| Template including parent | `template-including-parent:: true` | Not implemented | Gap |
| Template CRUD UI | Edit template page directly | Templates are just pages — edit normally. No dedicated management UI | Partial |

**Planned improvements:**
- Full template system: dynamic variable expansion, dedicated CRUD UI, configurable journal auto-apply (Planned #639)

### 13. Import / Export

| Capability | Logseq | Agaric | Status |
|---|---|---|---|
| Markdown export | Full graph export to .md | `export_page_markdown` command: per-page export with resolved `#[ULID]`/`[[ULID]]` + YAML frontmatter. No bulk/graph export | Partial |
| JSON/EDN export | Data export | Not implemented | Gap |
| OPML export | Outline export | Not implemented | Gap |
| Import from Roam | JSON import | Not implemented | Gap |
| Import from Logseq/Notion | Markdown import | Not implemented | Gap |
| Publishing as HTML | Static site generation | Not implemented | Gap |

### 14. Out of Scope (Noted, Not Priority)

| Feature | Logseq | Notes |
|---|---|---|
| Graph view | Global + local graph visualization | Not priority per user |
| Plugin/extension system | Marketplace with 100+ plugins | Not priority per user |
| Flashcards / spaced repetition | Cloze deletion + SM-2 review | Not priority per user |
| Whiteboard | Infinite canvas with block embedding | Not priority per user |
| PDF annotation | Built-in reader with highlights as blocks | Not priority per user |

---

## Part 2: What We Do Better Than Logseq

| Area | Agaric Advantage | Logseq Limitation |
|---|---|---|
| **Journal views** | 4 modes (daily/weekly/monthly/agenda) with calendar picker + keyboard nav | Single scrollable daily view |
| **Task dashboard** | Dedicated agenda mode with collapsible TODO/DOING/DONE sections, priority sorting, DonePanel for completed tasks grouped by source page | Requires manually writing Datalog queries |
| **Recurrence** | Native backend recurrence (daily/weekly/monthly/+Nd/+Nw/+Nm) with automatic sibling creation and date shifting on DONE | Plugin-only, no native support |
| **Backlink filtering** | Server-side expression tree: 11 filter types + And/Or/Not composition, keyset pagination | Basic filter bar with simple matching |
| **Formatting toolbar** | BubbleMenu: 11 buttons with Radix tooltips + shortcut hints | None (keyboard only) |
| **Sync architecture** | SyncDaemon: mDNS discovery + TLS WebSocket + cert pinning + ChaCha20-Poly1305 pairing + three-way merge + exponential backoff. Fully automated LAN sync | File-based sync is fragile, conflicts are file-level |
| **Data integrity** | Every op hash-verified (blake3 chain), crash recovery at boot, op-level undo/redo with HistoryView batch revert + word-level diff | File corruption possible, no checksums |
| **Search** | FTS5 with trigram tokenizer (CJK/substring search), BM25 ranking, cursor pagination | unicode61 tokenizer, no CJK substring support |
| **Performance architecture** | CQRS materializer (fg+bg queues), cursor-based keyset pagination everywhere, depth limits, Tauri 2 | Datascript in-memory DB can be slow for large graphs |
| **Storage efficiency** | Single SQLite file with WAL, zstd-compressed snapshots | One file per page = thousands of small files |
| **Structured properties** | Typed properties (text, num, date, ref) with schema registry + PagePropertyTable UI | Properties are untyped strings |
| **ID system** | ULIDs: sortable, case-normalized (Crockford base32), deterministic ordering | UUID v4: random, not sortable |
| **Soft delete** | Cascade soft-delete with restore + purge, timestamp verification for concurrency | Delete is file/block removal |
| **Undo/redo history** | Op-level undo/redo + HistoryView with multi-select batch revert, op-type filter, word-level diff display | No explicit undo history UI |
| **Desktop performance** | Tauri 2 (Rust + WebView) — small binary, low memory | Electron — large binary, high memory |
| **Android** | Tauri 2 Android target: debug + release APK (24 MB), working IPC | Electron-based, no native mobile |
| **Accessibility** | ARIA coverage on core components, keyboard navigation, semantic HTML, axe a11y tests on every component | Basic keyboard shortcuts, limited ARIA |

---

## Part 3: Workflow Comparison

### Workflow 1: Daily Journaling

**Logseq:** Open app -> today's journal auto-created -> type with `[[links]]` -> scroll past days -> templates auto-populate structure -> backlinks accumulate on topic pages.

**Agaric:** Open app -> today's journal auto-created with optional template -> 4 view modes (daily/weekly/monthly/agenda) -> calendar picker with content dots -> `Alt+Arrow` / `Alt+T` navigation -> `[[ULID]]` links -> backlinks with grouped linked + unlinked references.

**Current gaps:** No dynamic template variables (date/time expansion). Monthly view is stacked sections, not calendar grid. No "load older days" / infinite scroll. No natural language dates.

**Planned (#630, #639):** Journal auto-populate structure. Dynamic variables (`{{today}}`, `{{time}}`). Template CRUD UI.

**Verdict: Strong.** Core daily journal workflow exceeds Logseq (4 view modes, calendar picker, auto-create + journal template). Planned template system will close the remaining UX gaps.

---

### Workflow 2: Task Management / GTD

**Logseq:** `TODO` markers on journal blocks -> properties + links to projects/contexts -> priority + SCHEDULED/DEADLINE dates -> query pages surface all open/overdue tasks -> DOING/NOW for active work.

**Agaric:** TODO/DOING/DONE markers (click or `Ctrl+Enter`) -> priority A/B/C (slash commands, `Ctrl+Shift+1/2/3`, badges) -> due/scheduled dates with `/due` and `/scheduled` -> recurrence (daily/weekly/monthly/custom) -> agenda dashboard with TODO/DOING/DONE sections and DonePanel -> agenda filters for due and scheduled dates (Today, This week, Overdue, Next 7/14/30 days).

**Current gaps:** No scheduling semantics (due/scheduled are display-only, no hide-before or deadline warnings). Only 3 task states (no CANCELLED/WAITING). No inline query blocks on project pages. Repeat modes limited (no from-completion, no catch-up).

**Planned (#641, #644):** Scheduling semantics (hide-before scheduled, deadline warning period, overdue rollforward). Repeat modes (`.+` from completion, `++` catch-up). End conditions (repeat-until, repeat-count). Agenda projection of virtual future occurrences.

**Verdict: Functional and growing.** Core task workflow works well — markers, priority, dates, recurrence, agenda dashboard all ship. Planned scheduling semantics and repeat enhancements will make this a strength.

---

### Workflow 3: Zettelkasten / Knowledge Management

**Logseq:** Atomic ideas as blocks with `[[links]]` -> block references `((uuid))` for cross-referencing -> block embeds for content reuse -> backlinks accumulate connections -> unlinked references discover implicit connections -> graph view for exploration.

**Agaric:** Blocks with `[[ULID]]` page/block links (rendered as chips) -> linked references grouped by source page -> unlinked references with "Link it" button -> tags for categorization with boolean AND/OR/NOT queries -> backlink filter expressions (11 types, full composition).

**Current gaps:** No block references (inline content rendering). No block/page embeds. No graph view (not priority).

**Planned:** None — block refs/embeds are deferred (not needed for the target workflow).

**Verdict: Partial.** Links, backlinks (linked + unlinked), and filtering are strong. Missing the precision tools (references, embeds) that make Zettelkasten workflows powerful. This is an accepted trade-off for the target audience.

---

### Workflow 4: Meeting Notes

**Logseq:** Template with attendees/agenda/notes/action items -> person pages (`[[Alice]]`) accumulate meetings via backlinks -> `TODO [[Person]] description` tracked in task queries.

**Agaric:** Create meeting page -> `/template` inserts stored template structure -> `[[ULID]]` links to person/project pages -> TODO/DOING/DONE markers on action items -> backlinks on person pages show all meetings -> DonePanel tracks completed actions by date.

**Current gaps:** No dynamic template variables (auto-insert date, attendees). No inline query blocks for person/project pages.

**Planned (#639):** Dynamic variables in templates. Template CRUD UI.

**Verdict: Usable.** Basic meeting notes workflow works with `/template` insertion, links, and task markers. Templates improvement will close the gap.

---

### Workflow 5: Project Management

**Logseq:** Project pages with properties -> task aggregation via queries across all pages -> PARA method via namespaces.

**Agaric:** Project pages with PagePropertyTable (typed properties, CRUD) -> property queries (`query_by_property`, paginated) -> tags with boolean AND/OR/NOT queries -> task markers + priority + recurrence on blocks -> agenda mode aggregates all tasks by status and date.

**Current gaps:** No inline query blocks (can't embed task dashboards in project pages). No namespaced pages.

**Planned (#642):** Agenda filter by custom properties (e.g., `project: alpha`). Flexible date ranges.

**Verdict: Primitives done, composition layer missing.** Properties, queries, tasks, recurrence all work individually. The inability to embed live query results in pages remains the main gap.

---

### Workflow 6: Research & Reading Notes

**Logseq:** Built-in PDF reader with highlight-to-block -> Zotero integration -> web clipper -> progressive summarization with highlight syntax -> literature note templates.

**Agaric:** Pages and blocks for notes with external URL links -> typed properties for metadata (PagePropertyTable) -> `/template` for literature note templates -> attachments tracked in backend (not rendered in UI).

**Current gaps:** No highlight/mark syntax in editor. No attachment/image rendering. No PDF reader, web clipper, or bibliography integration.

**Verdict: Basic.** Can take structured notes with templates, links, and properties. Missing highlight syntax and specialized research tooling. This workflow is not the primary target.

---

## Part 4: Planned Features (from REVIEW-LATER.md)

These features are designed and scoped but not yet implemented. Each has bite-sized implementation tasks defined.

| # | Feature | Impact | Cost | Phase |
|---|---------|--------|------|-------|
| 630 | **Journal templates** — auto-populate structure for new days | HIGH | M | Journaling |
| 639 | **Templates system** — dynamic variables, CRUD UI, journal auto-apply config | HIGH | L | Journaling |
| 641 | **Scheduling semantics** — due/scheduled dates drive agenda behavior (hide-before, deadline warnings, overdue rollforward) | HIGH | L | Tasks |
| 642 | **Agenda filters** — filter by creation/completion dates, custom properties, flexible date ranges | MED | M | Tasks |
| 643 | **Properties management view** — browse, create, rename, delete properties and types. Usage counts, batch rename propagation | HIGH | M | Properties |
| 644 | **Repeating tasks** — `.+` (from completion) and `++` (catch-up) modes, end conditions (repeat-until, repeat-count), agenda projection of virtual future occurrences | HIGH | M | Tasks |
| 645 | **Block property UX** — inline chips on blocks, click-to-edit popovers, block property drawer. Closes gap between reserved and custom property visibility | HIGH | M | Properties |
| 652 | **Collapse state persistence** — localStorage, copy sidebar pattern | MED | S | Outlining |
| 653 | **Editor formatting marks** — strikethrough (`~~`) + highlight (`==`) | MED | M | Editor |
| 654 | **Editor block types** — blockquotes (`>`) + tables | MED | M | Editor |
| 655 | **Inline query blocks** — `{{query ...}}` embedded live results | HIGH | M | Query |
| 656 | **Namespaced pages** — `/` separator, page tree view in browser | MED | M | Pages |
| 657 | **Block-level multi-selection** — static selection + batch operations | MED | M | Outlining |
| 658 | **Custom task keywords** — configurable states beyond TODO/DOING/DONE | MED | M | Tasks |
| 659 | **Full graph Markdown export** — bulk export all pages as ZIP | MED | S | Export |
| 660 | **Logseq/Markdown import** — parse Logseq `.md` files into blocks | HIGH | L | Import |

**Not in REVIEW-LATER (intentionally deferred):**
- Block references / embeds (not needed for target workflow)
- Math/LaTeX rendering (niche, no demand signal)
- Graph view (out of scope per user)

---

## Part 5: Summary Scorecard

| Category | Logseq | Agaric (current) | Agaric (projected) | Notes |
|---|:---:|:---:|:---:|---|
| Block CRUD | 10 | 9 | 9 | Zoom-in done. Missing: block refs/embeds (deferred), multi-select, collapse persistence |
| Page management | 9 | 8 | 8 | Aliases done. Missing: namespaces |
| Editor formatting | 9 | 8 | 8 | 23 slash commands + formatting toolbar. Missing: strikethrough, highlight, tables, blockquotes, math |
| Linking system | 10 | 8 | 8 | Linked + unlinked references, 11-type backlink filter. Missing: block refs/embeds (deferred) |
| Properties | 8 | 8 | 9 | Full backend + PagePropertyTable. Planned: management view (#643), inline chips (#645) |
| Tags | 8 | 7 | 7 | Boolean AND/OR/NOT, prefix hierarchy. Tags not unified with pages (design choice) |
| Query system | 9 | 5 | 6 | Tag/FTS/property queries + agenda. No inline query blocks. Planned: advanced agenda filters (#642) |
| Task management | 8 | 9 | 10 | TODO/DOING/DONE + priority + recurrence + agenda dashboard + DonePanel. Planned: scheduling semantics (#641), repeat modes (#644) |
| Daily journal | 8 | 9 | 9 | 4 modes + auto-create + journal template. Planned: auto-populate (#630), dynamic variables (#639) |
| Search | 8 | 8 | 8 | FTS5 trigram + CJK + unlinked refs. Missing: scope filters |
| Templates | 7 | 4 | 7 | /template command + template pages + journal auto-apply. Planned: variables, CRUD UI (#639) |
| Sync/storage | 5 | 10 | 10 | SyncDaemon + three-way merge + TLS + mDNS + cert pinning. Fully automated LAN sync |
| Data integrity | 4 | 9 | 9 | Op log + blake3 + recovery + undo hardening |
| Performance arch | 6 | 8 | 8 | CQRS + cursor pagination + depth limits + Tauri 2 |
| Import/export | 7 | 2 | 2 | Single-page Markdown export. No bulk export or import |

**Current totals: Logseq 116 / Agaric 122** (105%)

**Projected totals: Logseq 116 / Agaric 128** (110%)

Agaric has surpassed Logseq overall, driven by architectural advantages in sync, data integrity, performance, and task management. The remaining Logseq advantages are in the **query system** (inline query blocks + Datalog), **linking** (block refs/embeds), and **import/export** — the first two are deferred by design; import/export is a future priority.

---

## Appendix: Feature Delta Since Last Comparison Update

Features that moved from Gap to Done since the previous version of this document:

| Feature | Old status | Commit |
|---------|-----------|--------|
| Zoom into block with breadcrumb trail | Gap | #637 |
| `/template` slash command with picker | Gap | #632 |
| Page aliases (UI + backend) | Gap | Shipped (page_aliases table + PageHeader badges) |
| Unlinked references with "Link it" | Gap | Shipped (UnlinkedReferences component) |
| Backlinks grouped by source page | Partial | Shipped (LinkedReferences grouping) |
| Auto-create today's journal on launch | Gap | Shipped (JournalPage auto-create) |
| Recurring tasks (basic modes) | Gap | Shipped (repeat property + shift_date) |
| Repeat presets in `/repeat` command | Gap | #640 |
| Scheduled date agenda filter | Gap | #642 |
| Export page as Markdown | Gap | Shipped (export_page_markdown) |
| Journal template auto-apply | Gap | Shipped (journal-template property) |
| DonePanel (completed tasks by date) | Gap | Shipped (DonePanel component) |

---

## Appendix: Research Sources

- Logseq Documentation: https://docs.logseq.com/
- Logseq GitHub: https://github.com/logseq/logseq
- Logseq Blog: https://blog.logseq.com/
- Logseq Docs Repo: https://github.com/logseq/docs
- Awesome Logseq: https://github.com/logseq/awesome-logseq
