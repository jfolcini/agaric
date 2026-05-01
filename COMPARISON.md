# Agaric vs Logseq: Feature Comparison

> **Verified as of 2026-04-25.** Version-specific claims (Logseq release versions, Agaric APK size, feature counts) reflect the state of the repo and the upstream Logseq release notes on this date. Re-verify before relying on numeric claims older than ~3 months.
>
> Goal: Agaric is meant to fully replace Logseq for the author's personal workflow.
> This document maps every Logseq capability to what we have, what's planned, and what's missing.
>
> **Methodology:** Logseq features verified against official documentation (docs.logseq.com, GitHub logseq/docs), release notes (0.10.15, Dec 2025), and community forums (discuss.logseq.com). Last updated 2026-04-08 (session 256).

**Status key:**

| Label | Meaning |
| ------- | --------- |
| **Done** | Fully implemented and shipped |
| **Partial** | Implemented but incomplete |
| **Planned (#N)** | Designed in REVIEW-LATER.md, not yet built |
| **Gap** | Not implemented, not currently planned |
| **Design choice** | Intentionally different from Logseq |
| **Better** | Agaric implementation exceeds Logseq |

---

## Context: Two Different Animals

**Logseq** is a mature, open-source knowledge management platform (41.9k GitHub stars, 23.5k+ commits, large community). Written in ClojureScript, runs on Electron. Currently undergoing a major transition from file-based storage to a "DB version" (SQLite + Datascript backend) which is in beta with data loss warnings. Last stable release: 0.10.15 (Dec 2025). Desktop binaries: ~190 MB.

**Agaric** is a personal-use local-first app. Written in Rust + React, runs on Tauri 2. SQLite-backed from the start. Production Android APK: 24 MB. Designed to replace Logseq for one specific user's workflow — daily journaling, task management, and project notes — without trying to replicate features outside that scope (graph view, whiteboards, PDF annotation, plugins).

---

## Part 1: Feature-by-Feature Comparison

### 1. Block Model

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Everything is a block (outliner) | Yes — every piece of content is a bullet | Yes — `blocks` table, tree via `parent_id` + `position` | Done |
| Block nesting / indentation | Unlimited depth in practice | Unlimited depth (max 20), visual indentation via `depth` in flat tree | Done |
| Block UUIDs | UUID v4 (random, not sortable) | ULID (uppercase Crockford base32, sortable, time-encoded) | Done |
| Block references `((uuid))` | Inline renders source content, live-updating. Reference counter shows all refs grouped by page | `((ULID))` block references via FTS picker, violet chips (first-line preview, hover tooltip with full content). Click-to-navigate. Tracked in `block_links` table. No inline editable content or reference counter | Partial |
| Block embeds `{{embed ((uuid))}}` | Full content + children rendered inline, editable in-place | Not implemented | Gap |
| Block properties `key:: value` | Inline `key:: value` syntax parsed from content. `::` autocomplete for names and values | `block_properties` table with 5 typed values (text, num, date, select, ref). `::` triggers property name autocomplete. PagePropertyTable + BlockPropertyDrawer for CRUD. PropertyChip inline display (max 3, click-to-edit). AddPropertyPopover | Done |
| Collapse/expand children | Click arrow or `Ctrl+Up/Down`. State persisted via `collapsed` property in block | Chevron toggle, `Ctrl+.` shortcut. State persisted in localStorage (survives reload) | Done |
| Zoom into block (focus mode) | `Alt+Right` shows block + descendants as focus page | Zoom-in with breadcrumb trail. Home button + ancestor navigation | Done |
| Move block up/down | `Alt+Shift+Up/Down` | DnD reordering (tree-aware, @dnd-kit) + `Ctrl+Shift+Up/Down` keyboard shortcuts | Done |
| Block-level selection | `Esc` + arrow keys for multi-block select | Ctrl+Click toggle, Shift+Click range, Ctrl+A select all, batch toolbar (Delete + Set todo state) | Done |
| Cross-block undo | Ctrl+Z across blocks within session. No explicit history UI | Op-level undo/redo: `Ctrl+Z`/`Ctrl+Y`, per-page undo depth + redo stack, HistoryView with multi-select batch revert, word-level diff | Better |

### 2. Page Model

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Pages as named containers | One .md/.org file per page (file version). Entity in Datascript DB (DB version) | `blocks` with `block_type = 'page'`, content = title | Done |
| Page properties (frontmatter) | First block holds `key:: value` pairs (page-level). Property autocomplete | `block_properties` on page blocks. PagePropertyTable UI: collapsible, typed inputs, add/delete | Done |
| Page aliases | `alias:: JS, ECMAScript` — comma-separated, creates links | `page_aliases` table with `set_page_aliases`/`get_page_aliases`/`resolve_page_by_alias`. PageHeader UI with alias badges | Done |
| Namespaced pages | `Project/Backend/API` with `/` separator. Hierarchy navigation | Tree view in PageBrowser, breadcrumb navigation, create-under flow, search respects hierarchy | Done |
| Page tags via property | `tags:: book, fiction` — comma-separated, auto-treated as page refs | Tags via `block_tags` junction table + @picker. Tags exist but aren't page-level property syntax | Partial |
| `title::` override | Display title differs from filename | Block content IS the title. No separate title property | Design choice |
| Auto-created pages from links | Clicking `[[New Page]]` creates page automatically | `[[` picker has "Create new" option | Done |

### 3. Editor & Formatting

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Markdown support | Full Markdown (file version). WYSIWYG-ish in editor | Markdown subset via TipTap + custom serializer (bold, italic, code, headings, code blocks, links, tables, blockquotes). No lists (blocks ARE list items) | Partial |
| Org-mode support | Full `.org` format — Org-mode properties, headings, lists | Not implemented. Org-mode inspires features (tags, properties, agenda), not file format | Design choice |
| **Bold** | `**bold**` | `**bold**` | Done |
| *Italic* | `*italic*` | `*italic*` | Done |
| ~~Strikethrough~~ | `~~text~~` | `~~text~~` with `Ctrl+Shift+S` toggle | Done |
| ==Highlight== | `^^text^^` (Logseq-specific syntax) | `==text==` with `Ctrl+Shift+H` toggle | Done |
| `Inline code` | `` `code` `` | `` `code` `` | Done |
| Headings | `# H1` ... `###### H6` inside blocks | `/h1`-`/h6` slash commands + TipTap Heading extension (levels 1-6) | Done |
| Code blocks | Fenced with language, syntax highlighting | Fenced code blocks with lowlight syntax highlighting (common language set, auto-detect fallback) | Done |
| Math/LaTeX | `$$E=mc^2$$` inline and block — native rendering | Not implemented | Gap |
| Tables | Markdown tables | Pipe-delimited markdown tables, TipTap extensions, `/table` slash command | Done |
| Blockquotes | `> quote` | TipTap Blockquote extension, markdown `>` syntax | Done |
| Slash commands `/` | ~20+ commands (task markers, dates, links, templates, etc.) | 17 base + progressive disclosure: TODO, DOING, DONE, DATE, DUE, SCHEDULED, LINK, TAG, CODE, EFFORT, ASSIGNEE, LOCATION, REPEAT, TEMPLATE, QUOTE, TABLE, QUERY + PRIORITY 1/2/3 + H1-H6 + repeat variants | Done |
| Autocomplete `[[` | Search all pages, create new | block-link-picker extension, page search, "Create new" option | Done |
| Autocomplete `@` | N/A (Logseq uses `#` for tags) | at-tag-picker extension, tag search, "Create new" option | Done |
| Autocomplete `((` | Search all blocks for reference, inline preview | `((` trigger opens block reference picker with FTS search. Renders as violet chip with first-line preview + hover tooltip | Done |
| Property autocomplete `::` | Suggests property names and values from usage history | `::` triggers property name autocomplete picker (suggests existing property keys). No value autocomplete | Partial |
| Multi-line blocks | `Shift+Enter` for line break | `Shift+Enter` for hard break, `Enter` creates sibling | Done |
| Formatting toolbar | No visible toolbar — keyboard-only formatting | FormattingToolbar: 20 buttons (bold, italic, code, strikethrough, highlight, link, page-link, tag, code-block, quote, heading, priority, date, due-date, scheduled-date, todo, properties, undo, redo, discard) + Radix tooltips with shortcut hints | Better |

### 4. Linking System

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Page links `[[page]]` | `[[page name]]` — human-readable names, creates page if needed | `[[ULID]]` rendered as clickable chips with title resolution. Links by ID (robust to renames, less human-readable in raw text) | Done |
| Block references `((uuid))` | Inline content preview with live-updating. Editable in some contexts. Reference counter | `((ULID))` FTS picker. Violet chip (first-line truncated to 60 chars), hover tooltip (full content to 300 chars), click-to-navigate. Tracked in `block_links`. Not inline-editable, no reference counter | Partial |
| Block embeds `{{embed ((uuid))}}` | Full tree rendered inline, editable | Not implemented | Gap |
| Page embeds `{{embed [[page]]}}` | Entire page content inline | Not implemented | Gap |
| Tags as links | `#tag` = `[[tag]]` — tags ARE pages. Backlinks accumulate | Tags are separate entities (`block_type = 'tag'`). `#[ULID]` renders as tag chip. Separate namespaces for tags vs pages | Design choice |
| External links | `[text](url)` | `[text](url)` with browser open from static view. Ctrl+K shortcut, autolink on paste | Done |
| Linked references | Grouped by source page. Simple filter bar | LinkedReferences component: grouped by source page, collapsible groups, cursor pagination | Done |
| Unlinked references | Plain-text mentions of page name | UnlinkedReferences component: "Link it" button to convert mentions, grouped by source page, cursor pagination | Done |
| Backlink filtering | Simple filter bar with basic matching | Server-side expression tree: 17 filter types (PropertyText/Num/Date, PropertyIsSet/Empty, HasTag, HasTagPrefix, Contains, CreatedInRange, BlockType, TodoState, Priority, DueDate, ScheduledDate, SourcePage) + And/Or/Not composition | Better |
| Page graph (local + global) | Visual graph of connections (local per-page + global). Can be slow with large graphs | Not implemented | Out of scope |
| Custom link labels | `[display text]([[page]])` | Not implemented | Gap |

### 5. Properties System

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Block properties | Inline `key:: value` syntax. Parsed from content automatically | `block_properties` table with typed columns. set/delete/get/batch API. `::` property name autocomplete. PropertyChip inline display (max 3, click-to-edit popovers). BlockPropertyDrawer for full CRUD | Done |
| Typed values | Text, Number, Date, DateTime, Checkbox, URL, Node (file version). DB version adds Classes with typed schema | 5 types: text, number, date, select, ref. Schema registry via `property_definitions` with select options. Ref-type picker with page search | Partial |
| Built-in properties | ~15+ editable (icon, title, tags, template, template-including-parent, alias, filters, public, exclude-from-graph-view) + hidden (collapsed, id, created-at, updated-at, query-table, query-properties, query-sort-by, query-sort-desc) | 14 seeded: todo_state, priority, due_date, scheduled_date, created_at, completed_at, effort, assignee, location, repeat, repeat-until, repeat-count, repeat-seq, repeat-origin | Done |
| Property-based queries | `{{query (property type book)}}` — simple queries. Full Datalog for complex queries | `query_by_property` command with cursor pagination. Used by agenda, DonePanel. Inline query blocks `{{query type:tag expr:...}}` | Partial |
| Property name autocomplete | `::` triggers suggestions from usage history | `::` triggers property picker with existing property keys, ordered by usage. Follows same pattern as `@` and `[[` pickers | Done |
| Property value autocomplete | Suggests previously-used values for that property | Not implemented | Gap |
| Comma-separated multi-values | `tags:: a, b, c` parsed as multiple page refs. Configurable for custom properties | Not supported | Gap |
| DB version: Classes & typed schema | DB version introduces "Classes" (like database tables) with typed property definitions, tag-based organization, table views | Not applicable — Agaric uses typed `property_definitions` from the start | Design choice |

### 6. Tags

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Inline tag syntax | `#tag` or `#[[multi word]]` — tags are page references | `#[ULID]` rendered as styled chip with resolved name | Done |
| Tags as pages | Every tag IS a page — `#book` = `[[book]]` | Tags and pages are separate `block_type` values. Separate namespaces | Design choice |
| Tag hierarchy / namespaces | `/` separator in tag names. DB version: tag inheritance via `Extends` | Prefix-based: `work/meeting` naming convention with LIKE search. Materialized `block_tag_inherited` cache: blocks inherit ancestor tags, O(1) lookups, incrementally maintained by materializer + command handlers on 7 op types | Done |
| Tag filtering | Filter in linked references | TagFilterPanel with boolean AND/OR/NOT, prefix search. TagExpr with full boolean composition | Better |
| Tag usage counts | Shown in various UIs | `tags_cache` tracks `usage_count` | Done |
| Tag autocomplete | `#` triggers search | @picker extension with create-new option | Done |
| Tag inheritance (DB version) | Parent tags via `Extends` relationship. Schema inheritance | Ancestor-based tag inheritance: `block_tag_inherited` materialized table, propagation on add/remove/move/create/delete/restore/purge, background rebuild safety net. No `Extends` schema inheritance | Partial |

### 7. Query System

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Simple queries | `{{query (and [[page]] (task TODO))}}` — embedded live results | `{{query type:tag expr:...}}` syntax with live results in static view. Supports tag, property, and backlink queries | Done |
| Query operators | `and`, `or`, `not` — boolean composition around any filter | `TagExpr` supports AND/OR/NOT for tag queries. Backlink filter expressions with full And/Or/Not composition | Done |
| Query filters | `between`, `page`, `property`, `task`, `priority`, `page-property`, `page-tags`, `all-page-tags`, `sort-by` | Tag, property key/value, backlink filter (17 types), agenda date presets | Partial |
| Date-based queries | `(between -7d +7d)`, relative dates with symbols (today, yesterday, tomorrow), `+/-` with units (y/m/w/d/h/min) | Agenda filter presets: Today, This week, This month, Overdue, Next 7/14/30 days. `parse-date.ts` for natural language | Partial |
| Task queries | `(task TODO DOING)`, `(priority A B C)` | Agenda mode: TODO/DOING/DONE sections with priority sorting. DonePanel: completed tasks by date | Done |
| Property queries | `(property type book)` — matches page refs in values | `query_by_property` with cursor pagination. Single key+value filter | Partial |
| Advanced Datalog queries | Full Datascript query language: complex graph traversal, aggregations, custom transformations, rule definitions. Steep learning curve | Not applicable — backend uses SQL. Simpler but less expressive | Gap |
| Query result as table | `query-table:: true` renders results as sortable table with column selection | QueryResultTable component: sortable columns, column definitions, click-to-navigate. Used by inline query blocks | Done |
| Live-updating results | Queries re-evaluate on data change | FTS search, agenda, and inline query blocks are live-updating | Done |
| Query sort/transform | `:result-transform` (custom fn), `:sort-by` (property-based), `:query-sort-by`/`:query-sort-desc` built-in properties | Fixed sort orders in agenda/backlinks. AgendaSortGroupControls for agenda (date/priority/state). No user-customizable sort on queries | Partial |

### 8. Task Management

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Task markers | Two flavors: `LATER`/`NOW`/`DONE` (default) or `TODO`/`DOING`/`DONE`. Additional: `CANCELLED`, `IN-PROGRESS`, `WAIT`/`WAITING` | Configurable task keywords via localStorage + PropertiesView settings UI. Default: TODO/DOING/DONE. Click to cycle, `Ctrl+Enter`. Visual icons (Circle/CircleDot/CheckCircle2) | Done |
| Priority levels | `[#A]`, `[#B]`, `[#C]` via `/A`, `/B`, `/C` commands | Priority A/B/C: slash commands, `Ctrl+Shift+1/2/3`, click-to-cycle badge. Color-coded: A=red, B=amber, C=blue | Done |
| Due dates | `DEADLINE: <2025-01-15 Wed>` — Org-mode syntax. `/Deadline` command with date picker | `due_date` column on blocks. `/due` slash command, date picker. Agenda filter: Today, This week, Overdue, Next 7/14/30 days | Done |
| Scheduled dates | `SCHEDULED: <2025-01-15 Wed>` — Org-mode syntax. `/Scheduled` command. Configurable future-days display via `:scheduled/future-days` | `scheduled_date` column. `/scheduled` slash command, date picker. Agenda filter: same presets. Hide-before toggle | Done |
| Task cycling | `Ctrl+Enter` cycles through workflow markers | Click marker or `Ctrl+Enter` cycles TODO -> DOING -> DONE -> none | Done |
| Recurring tasks | **Native.** Repeater in DEADLINE/SCHEDULED syntax: `.+` (from completion), `++` (catch-up/same day), `+` (from original). Intervals: `Nd`, `Nw`, `Nm`. Date picker "Add repeater" button | Native recurrence via `repeat` property. 3 modes: default, from-completion (`.+`), catch-up (`++`). End conditions: repeat-until, repeat-count. Agenda projection of future occurrences. On DONE: creates sibling with shifted dates | Better |
| Task dashboard | Journal pages show upcoming SCHEDULED/DEADLINE blocks automatically. Custom views require Datalog queries | Agenda mode: collapsible TODO/DOING/DONE sections with priority sorting, paginated. DonePanel: completed tasks grouped by source page. DuePanel: overdue accumulation. Sort/group toolbar | Better |
| Custom task keywords | Configurable in `config.edn` — two built-in flavors + direct typing of CANCELLED, etc. | Configurable via localStorage, PropertiesView settings UI | Done |
| Effort tracking | No native effort tracking. Available via custom properties | `/effort` slash command, `effort` property definition (seeded) | Better |
| Time tracking | Built-in time tracker: logs time between task state transitions. Toggleable via settings | Not implemented | Gap |
| Overdue task accumulation | Via embedded queries on journal pages | DuePanel shows overdue tasks on today's view | Done |
| Scheduled date hide-before | `SCHEDULED` blocks hidden until date. Configurable via `:scheduled/future-days` | localStorage toggle in DuePanel | Done |
| Deadline warning period | Configurable future-days display | Configurable N days in PropertiesView | Done |

### 9. Daily Journal

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Auto-created daily page | Created on app launch for today | Auto-creates today's page on launch in daily mode. Applies journal template if set | Done |
| Default landing page | Opens to today's journal | App opens to journal view | Done |
| Date navigation | `g n`/`g p` (next/prev day), date picker | Prev/next per mode, calendar picker with content dots, Today button. `Alt+Left/Right` (mode-aware), `Alt+T` for today | Done |
| View modes | Single scrollable daily view — past days stacked below today | 4 modes: Daily, Weekly, Monthly, Agenda | Better |
| Scrollable past journals | Infinite scroll of past days stacked below | Daily: single day. Weekly: 7-day sections. Monthly: calendar grid with content indicators | Partial |
| Journal templates | `default-templates {:journals "template-name"}` in `config.edn`. Dynamic variables: `<% today %>`, `<% time %>`, `<% current page %>` | Template pages via property, `/template` slash command, journal auto-apply, dynamic variables, kebab menu "Save as template" | Done |
| Configurable date format | `:journal/page-title-format` in `config.edn` | Fixed `YYYY-MM-DD` | Gap |
| Natural language dates | In date pickers: "today", "tomorrow", "yesterday", relative dates | `parse-date.ts` (267 lines, 200+ tests): "today", "tomorrow", "yesterday", "next monday", "in 3 days", "end of month", "+3d"/"+1w"/"+2m", ISO/month-name. Missing: "last monday", "this week" | Partial |
| "On this day" queries | Possible via Datalog (query same date last year) | Not implemented | Gap |

### 10. Search

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Full-text search | `Ctrl+K` global search. Desktop only for full-text queries | SearchPanel with FTS5 backend (trigram tokenizer), debounced, cursor-paginated | Done |
| Search scope | Pages + blocks, filterable by type | All blocks, no scope filtering | Partial |
| Search ranking | BM25-based | FTS5 rank (BM25) with cursor pagination | Done |
| Search in backlinks | Via filter bar | Server-side filter expressions with Contains (FTS5 within backlinks) + 16 other filter types with And/Or/Not | Better |
| CJK/substring search | unicode61 tokenizer — no substring matching, limited CJK | Trigram tokenizer (case_sensitive=0) — full substring and CJK support | Better |
| Unlinked references | Plain-text mentions | UnlinkedReferences component with "Link it" button, grouped by source page | Done |
| Recent pages quick access | Shown in search results and command palette | Not implemented | Gap |

### 11. Sync & Storage

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Local-first | Flat .md/.org files on disk (file version). SQLite + Datascript (DB version) | SQLite (WAL mode) in app data dir | Both local-first |
| File format | Human-readable Markdown/Org files (file version). Opaque DB (DB version) | Binary SQLite | Design choice |
| Sync | **Logseq Sync** (BETA, paid $5-15/mo via Open Collective): encrypted, up to 10 graphs, AWS-hosted. Do not use with other sync services. DB version: RTC (Real Time Collaboration) in **alpha**. DIY: git, iCloud, Dropbox (fragile, conflict-prone) | SyncDaemon: mDNS discovery, TLS WebSocket, ECDSA P-256 cert pinning, ChaCha20-Poly1305 pairing, exponential backoff (1s-60s), debounced change sync (3s), periodic resync (60s). Free, no account required, fully automated LAN sync | Better |
| Conflict resolution | File-level for DIY sync (fragile). Logseq Sync: "Smart Merge" (0.9.14+). DB version RTC: still alpha, data loss reported (db-test #781, Mar 2026) | Three-way merge (diffy): edit divergence, property LWW, move LWW, delete-vs-edit resurrection. Type-specific UI rendering. Batch resolution (multi-select keep/discard). Source device info | Better |
| Multi-device | Via Logseq Sync (paid) or DIY sync | LAN sync via SyncDaemon: mDNS continuous discovery, immediate sync on peer appearance, periodic resync, change-triggered debounce | Done |
| Op log / history | No explicit op log. `created-at`/`updated-at` timestamps only | Full append-only op log with blake3 hash chain, per-device sequences, cursor-paginated history | Better |
| Snapshots / compaction | N/A (file-based). DB version: SQLite DB file | zstd-compressed CBOR snapshots, 90-day compaction | Better |
| Crash recovery | File system journaling. No explicit recovery | Explicit recovery at boot (pending snapshots, draft errors, op-log verification) | Better |
| Storage efficiency | One file per page = thousands of small files (file version). Single SQLite file (DB version) | Single SQLite with WAL | Better |
| Encryption | Logseq Sync: age encryption (end-to-end). File version: none (plain text on disk) | TLS in transit. No at-rest encryption (SQLite file) | Tie |
| Manual IP entry / mDNS fallback | N/A | last_address on peer_refs, sync daemon fallback, DeviceManagement UI | Done |
| Offline state indication | N/A | useSyncStore 'offline' state, StatusPanel display | Done |

### 12. Templates

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Template creation | Block/page with `template:: name` property | Pages marked with `template=true` property. Kebab menu "Save as template" | Done |
| Template insertion | `/Template` slash command — select from list | `/template` slash command with template picker. Copies template children as new blocks | Done |
| Dynamic variables | `<% today %>`, `<% time %>`, `<% current page %>` | Same variables: `<% today %>`, `<% time %>`, etc. Expansion at insertion time | Done |
| Default journal template | `:default-templates {:journals "name"}` in config.edn | Pages with `journal-template=true` auto-apply on journal page creation | Done |
| Template including parent | `template-including-parent:: true` — built-in property, includes parent block content | Not implemented | Gap |
| Template CRUD UI | Edit template page directly. No dedicated management UI | Templates are pages — edit normally. Kebab menu "Save as template", template picker | Done |

### 13. Import / Export

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Markdown export | Full graph export to .md files | Per-page `export_page_markdown` + full graph export as ZIP (`export_all_pages_markdown`). Resolved `#[ULID]`/`[[ULID]]` + YAML frontmatter | Done |
| JSON/EDN export | Data export in multiple formats | Not implemented | Gap |
| OPML export | Outline export | Not implemented | Gap |
| Import from Roam | JSON import | Not implemented | Gap |
| Import from Logseq | N/A | Logseq import: parse indented markdown, properties, block ref stripping, tab normalization, YAML frontmatter stripping, file picker UI | Done |
| Import from Notion | Markdown import (manual) | Not directly supported (but Logseq import covers markdown) | Partial |
| Publishing as HTML | Static site generation (`public:: true` pages) | Not implemented | Gap |
| SQLite DB export/import | DB version: SQLite file export | N/A — SQLite is the native format | Design choice |

### 14. Mobile

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| iOS app | File version: available on App Store. DB version: alpha (sign-up form). Sync issues frequently reported | Not implemented (Tauri 2 supports iOS but mDNS issue #522 blocks it) | Gap |
| Android app | File version: APK available (32.9 MB for 0.10.15). DB version: "coming soon" as of early 2026. Forum reports: "very slow" (discuss.logseq.com, Mar 2026) | Tauri 2 Android target: debug + release APK (24 MB), working IPC. Smaller and faster | Better |
| Mobile sync | Logseq Sync or DIY (iCloud/Dropbox). Background sync not supported — frequent feature request | LAN sync via SyncDaemon (same as desktop) | Done |
| Mobile editor quality | Full editor on mobile. Performance complaints on Android | Full editor (same as desktop, responsive layout) | Done |

### 15. Out of Scope (Noted, Not Priority)

| Feature | Logseq | Notes |
| --- | --- | --- |
| Graph view | Global + local graph visualization. Can be slow with large graphs | Not priority per user |
| Plugin/extension system | Marketplace with 200+ plugins (themes, tools, integrations). Incompatible with DB version currently | Not priority per user |
| Flashcards / spaced repetition | Cloze deletion + SM-2 review (built-in, toggleable) | Not priority per user |
| Whiteboard | Infinite canvas (tldraw fork) with block/page embedding, shapes, drawings, connectors. `.edn` files in `whiteboards/` folder | Not priority per user |
| PDF annotation | Built-in reader with highlight-to-block. Zotero integration | Not priority per user |
| Zotero integration | Native citation management with `@` citekey syntax | Not priority per user |

---

## Part 2: What We Do Better Than Logseq

| Area | Agaric Advantage | Logseq Limitation |
| --- | --- | --- |
| **Journal views** | 4 modes (daily/weekly/monthly/agenda) with calendar picker + keyboard nav | Single scrollable daily view |
| **Task dashboard** | Dedicated agenda mode with collapsible TODO/DOING/DONE sections, priority sorting, DonePanel, DuePanel with overdue accumulation, sort/group toolbar | SCHEDULED/DEADLINE blocks shown on journal; custom dashboards require Datalog |
| **Recurrence** | Native backend recurrence with 3 modes, end conditions (repeat-until/repeat-count), agenda projection of virtual future occurrences, automatic sibling creation on DONE | Native repeater syntax (`.+`, `++`, `+`) but no end conditions, no future projection, no dedicated repeat UI |
| **Backlink filtering** | Server-side expression tree: 17 filter types + And/Or/Not composition, keyset pagination | Simple filter bar with basic matching |
| **Formatting toolbar** | BubbleMenu: 20 buttons (bold, italic, strikethrough, highlight, code, headings 1-4, link, blockquote, bullet/ordered/task lists, undo/redo, indent/dedent, text color, divider) with Radix tooltips + shortcut hints | No visible toolbar — keyboard-only |
| **Sync architecture** | Free LAN sync: mDNS discovery + TLS WebSocket + cert pinning + three-way merge + exponential backoff. No account, no cloud, no subscription | Logseq Sync: paid BETA ($5-15/mo), AWS-hosted, 10 graph limit. DIY sync is fragile |
| **Conflict resolution** | Three-way merge with type-specific rendering (property diffs, move diffs, text). Batch resolution UI with multi-select keep/discard. Source device info | File-level conflicts (DIY) or "Smart Merge" (Sync BETA). DB version RTC alpha has data loss reports |
| **Data integrity** | Every op hash-verified (blake3 chain), crash recovery at boot, op-level undo/redo with HistoryView batch revert + word-level diff | No checksums or hash chains. `created-at`/`updated-at` timestamps only |
| **Search** | FTS5 with trigram tokenizer (CJK/substring search), BM25 ranking, cursor pagination | unicode61 tokenizer, no substring matching, limited CJK support |
| **Performance architecture** | CQRS materializer (fg+bg queues), cursor-based keyset pagination everywhere, depth limits, Tauri 2 (Rust + WebView, ~24 MB Android APK) | Electron (~190 MB desktop). Datascript in-memory DB can be slow for large graphs. Forum: "Android app very slow" (Mar 2026) |
| **Storage efficiency** | Single SQLite file with WAL, zstd-compressed snapshots | One file per page = thousands of small files (file version). DB version moves to SQLite but is in beta |
| **Structured properties** | Typed properties (text, num, date, ref) with schema registry from day one | Properties are untyped strings parsed from content (file version). DB version introduces typed properties but is still beta |
| **ID system** | ULIDs: sortable, time-encoded, case-normalized (Crockford base32), deterministic ordering | UUID v4: random, not sortable, no time information |
| **Soft delete** | Cascade soft-delete with restore + purge, timestamp verification for concurrency | Delete is file/block removal (file version). No explicit trash/restore in file version |
| **Undo/redo history** | Op-level undo/redo + HistoryView with multi-select batch revert, op-type filter, word-level diff display | Session-level undo only. No explicit undo history UI |
| **Tag inheritance** | Materialized `block_tag_inherited` table: blocks automatically inherit ancestor tags, O(1) lookups, incrementally maintained on 7 op types | File version: no tag inheritance. DB version: `Extends` relationship (still beta) |
| **Inline queries** | 3 query types (tag, property, backlinks) as live-updating embedded blocks with table/list rendering, click-to-navigate | `{{query}}` blocks with simple or Datalog syntax. More flexible but steeper learning curve |
| **Accessibility** | ARIA coverage on core components, keyboard navigation, semantic HTML, axe a11y tests on 100+ components (~12,000+ total tests: ~3,400 Rust + ~8,700 frontend) | Basic keyboard shortcuts, limited ARIA coverage |

---

## Part 3: What Logseq Does Better

This section is important for honesty. These are areas where Logseq has capabilities we don't match.

| Area | Logseq Advantage | Agaric Limitation |
| --- | --- | --- |
| **Block references & embeds** | `((uuid))` inline content rendering (live-updating). `{{embed}}` for blocks and pages. Fundamental to Zettelkasten workflow | Block references: `((` FTS picker, violet chips with hover tooltip. No inline content embedding (`{{embed}}`), no ref counter, no inline editing of referenced content |
| **Advanced queries (Datalog)** | Full Datascript query language: graph traversal, aggregations, custom transforms, rule definitions. Extremely powerful for power users | SQL-based queries. Simpler but less expressive. No user-facing query language |
| **Human-readable format** | Plain .md/.org files on disk. Readable in any text editor. Version-controllable with git. True data ownership | Binary SQLite file. Readable only through app or SQL tools. Export available but not the primary format |
| **Plugin ecosystem** | 200+ community plugins covering themes, tools, integrations (Zotero, web clipper, kanban, etc.). Marketplace with one-click install | No plugin system. All features must be built-in |
| **Graph visualization** | Global + local graph view. Visual discovery of connections between pages/blocks | Not implemented (out of scope) |
| **Whiteboard** | Infinite spatial canvas (tldraw) with block/page embedding, shapes, drawings, connectors, YouTube/tweet embeds | Not implemented (out of scope) |
| **PDF annotation** | Built-in PDF reader with highlight-to-block extraction. Highlights become blocks linked to source | Not implemented (out of scope) |
| **Org-mode format** | Full .org support — important for Emacs/Org-mode users migrating | Design choice — Org-mode inspires features but not file format |
| **Math/LaTeX** | Native `$$` rendering for mathematical notation | Not implemented |
| **Community & ecosystem** | 41.8k GitHub stars, active Discord, forum, plugin developers, documentation. Large knowledge base of community workflows | Personal project, single user |
| **Configurable date format** | `:journal/page-title-format` in config.edn | Fixed YYYY-MM-DD |
| **iOS** | File version on App Store. DB version in alpha | Not implemented (blocked by mDNS issue) |
| **Time tracking** | Built-in time tracker logging state transitions | Not implemented |
| **Template including parent** | `template-including-parent:: true` built-in property | Not implemented |

---

## Part 4: The DB Version Factor

Logseq is undergoing a fundamental architectural shift from file-based storage to a "DB version" backed by SQLite + Datascript. This is worth examining because it directly affects the comparison.

**What the DB version promises:**

- SQLite storage (like Agaric already has)
- Typed properties with Classes (like database tables)
- Tag inheritance via `Extends`
- RTC (Real Time Collaboration) sync — multi-user, cloud-based
- New mobile app (iOS in alpha, Android "coming soon")
- Better query performance (no more loading entire graph into memory)

**Current reality (as of April 2026):**

- DB version is in **beta** — "data loss is possible" (official README)
- RTC sync is in **alpha** — data loss reported (db-test issue #781)
- 241 open issues in logseq/db-test repo
- Specific issues: sync doesn't resume after internet reconnects (#780), synced files differ in size (#783), large blocks not editable (#782), rendering blanked out when scrolling (#785), terrible performance with numbered lists (#784)
- iOS app in alpha (sign-up required), Android "coming soon"
- Plugin ecosystem not compatible with DB version
- No migration path from file version yet fully established (community posting "Data structures for bridging Logseq-MD to Logseq-DB", Mar 2026)
- Community uncertainty: "Logseq project status?" thread with 40 replies (Mar 2026), "Preparing a Logseq graph for migration to Obsidian" (Apr 2026)

**What this means for the comparison:**

- Many of Logseq's announced improvements (typed properties, SQLite, RTC) are not yet stable
- Agaric has had SQLite + typed properties + LAN sync as stable, shipped features from the start
- The DB version narrows some of Agaric's architectural advantages (storage efficiency, structured properties) — but only once it stabilizes
- The DB version introduces new capabilities Agaric doesn't have (RTC multi-user, Classes/schema inheritance) — but these aren't relevant to the single-user target workflow

---

## Part 5: Workflow Comparison

### Workflow 1: Daily Journaling

**Logseq:** Open app -> today's journal auto-created -> type with `[[links]]` -> scroll past days -> templates auto-populate structure -> backlinks accumulate on topic pages.

**Agaric:** Open app -> today's journal auto-created with optional template -> 4 view modes (daily/weekly/monthly/agenda) -> calendar picker with content dots -> `Alt+Arrow` / `Alt+T` navigation -> `[[ULID]]` links -> backlinks with grouped linked + unlinked references.

**Logseq advantage:** Infinite scroll of past days. Configurable date format. `[[page name]]` links are human-readable in raw text.

**Agaric advantage:** 4 view modes give better overview of week/month. Calendar picker with content indicators. Keyboard-driven navigation.

**Verdict: Agaric.** The 4 view modes and calendar picker are a significant workflow improvement over Logseq's single scrollable view.

---

### Workflow 2: Task Management / GTD

**Logseq:** `TODO`/`LATER` markers on journal blocks -> `[#A]` priority + `SCHEDULED`/`DEADLINE` dates -> repeater syntax for recurrence -> SCHEDULED/DEADLINE blocks appear on future journal pages -> custom Datalog queries for task aggregation.

**Agaric:** Configurable task keywords (click or `Ctrl+Enter`) -> priority A/B/C (slash commands, shortcuts, badges) -> due/scheduled dates -> recurrence (3 modes + end conditions + future projection) -> scheduling semantics (overdue accumulation, hide-before, deadline warnings) -> agenda dashboard with TODO/DOING/DONE sections, DonePanel, DuePanel -> sort/group toolbar (date/priority/state).

**Logseq advantage:** Built-in time tracking between state transitions. More task keyword variants (CANCELLED, IN-PROGRESS, WAIT/WAITING) out of the box.

**Agaric advantage:** Dedicated agenda dashboard without writing queries. Recurrence end conditions. Future occurrence projection. DonePanel for review. Sort/group controls.

**Verdict: Agaric.** The agenda dashboard, recurrence end conditions, and future projection are features Logseq simply doesn't have natively.

---

### Workflow 3: Zettelkasten / Knowledge Management

**Logseq:** Atomic ideas as blocks with `[[links]]` -> block references `((uuid))` for cross-referencing -> block embeds for content reuse -> backlinks accumulate connections -> unlinked references discover implicit connections -> graph view for exploration -> Datalog queries for complex retrieval.

**Agaric:** Blocks with `[[ULID]]` page/block links (rendered as chips) -> block references via `((` with FTS picker (violet chips, hover tooltip) -> linked references grouped by source page -> unlinked references with "Link it" button -> tags for categorization with boolean AND/OR/NOT queries -> backlink filter expressions (17 types, full composition).

**Logseq advantage:** Block embeds show referenced content inline. Graph view enables visual exploration. Datalog enables complex cross-graph queries.

**Agaric advantage:** Better backlink filtering (17 types with boolean composition vs. simple filter bar). Better search (trigram tokenizer for CJK/substring). Block references with FTS-powered picker.

**Verdict: Logseq.** Block embeds and graph view are important for Zettelkasten workflows. Agaric now has block references but still lacks inline content embedding, which limits content reuse in this workflow.

---

### Workflow 4: Meeting Notes

**Logseq:** Template with attendees/agenda/notes/action items -> `[[Alice]]` person pages accumulate meetings via backlinks -> `TODO [[Person]] description` tracked in task queries.

**Agaric:** Create meeting page -> `/template` inserts template with `<% today %>`, `<% time %>` -> `[[ULID]]` links to person/project pages -> TODO/DOING/DONE on action items -> backlinks on person pages show all meetings -> DonePanel tracks completed actions.

**Current gaps:** None significant for the core meeting notes workflow.

**Verdict: Comparable.** Both handle this workflow well. Logseq's human-readable `[[page name]]` links are slightly more natural for meeting notes. Agaric's formatting toolbar is slightly better for quick formatting.

---

### Workflow 5: Project Management

**Logseq:** Project pages with properties -> task aggregation via Datalog queries -> PARA method via namespaces.

**Agaric:** Project pages with PagePropertyTable (typed properties, CRUD) -> property queries (paginated) -> tags with boolean queries -> task markers + priority + recurrence -> agenda mode aggregates all tasks -> namespaced pages for PARA -> inline query blocks.

**Logseq advantage:** Datalog can aggregate across all pages in complex ways. DB version Classes could provide structured project schemas.

**Agaric advantage:** Agenda dashboard aggregates tasks without query writing. Inline query blocks embed live results. Sort/group controls.

**Verdict: Agaric.** The built-in agenda and inline queries handle project task tracking better out of the box. Logseq's Datalog is more powerful but requires significant user knowledge.

---

### Workflow 6: Research & Reading Notes

**Logseq:** Built-in PDF reader with highlight-to-block -> Zotero integration -> web clipper (plugin) -> progressive summarization with `^^highlight^^` syntax -> block embeds for literature note templates -> graph view for topic exploration.

**Agaric:** Pages and blocks for notes with external URL links -> typed properties for metadata -> `/template` for literature note templates -> attachments tracked in backend.

**Logseq advantage:** PDF reader, Zotero integration, web clipper, and block embeds are purpose-built for research workflows. This is a strong Logseq use case.

**Agaric limitation:** No PDF reader, no citation management, no attachment rendering in UI.

**Verdict: Logseq.** Research workflows need PDF annotation, citation tools, and block embeds. Agaric can take notes but lacks the specialized tooling.

---

## Part 6: Summary Scorecard

Scoring: 1-10 per category based on shipped, stable functionality. Not promises or beta features.

| Category | Logseq | Agaric | Notes |
| --- | :---: | :---: | --- |
| Block CRUD | 10 | 10 | Both excellent. Logseq: refs/embeds. Agaric: multi-select batch toolbar |
| Page management | 9 | 9 | Both: aliases, namespaces. Logseq: configurable titles. Agaric: tree view, breadcrumbs |
| Editor formatting | 9 | 9 | Both: strikethrough/highlight with shortcuts. Logseq: math, org-mode. Agaric: 20-button toolbar, text color, tables |
| Linking system | 10 | 8 | Logseq: block refs + embeds + graph view. Agaric: block refs (FTS picker, violet chips, hover tooltip) + backlink filtering. No embeds or graph |
| Properties | 7 | 8 | Logseq: inline syntax, autocomplete. Agaric: typed from start, PropertyChip, schema registry, `::` autocomplete |
| Tags | 8 | 8 | Logseq: tags=pages (more connected). Agaric: boolean tag queries + materialized tag inheritance |
| Query system | 9 | 7 | Logseq: Datalog + simple queries + table view. Agaric: inline query blocks (3 types) with table/list rendering + agenda |
| Task management | 7 | 10 | Agaric: agenda dashboard + recurrence end conditions + future projection + sort/group |
| Daily journal | 7 | 9 | Agaric: 4 modes + calendar picker. Logseq: infinite scroll + configurable format |
| Search | 7 | 8 | Agaric: trigram tokenizer + CJK + advanced backlink filters. Logseq: desktop-only full-text |
| Templates | 7 | 7 | Both: slash command + dynamic variables + journal template |
| Sync/storage | 5 | 9 | Agaric: free LAN sync, shipped. Logseq Sync: paid BETA. DIY sync fragile |
| Data integrity | 3 | 9 | Agaric: hash chains + crash recovery + undo history. Logseq: timestamps only |
| Performance | 5 | 8 | Agaric: Tauri 2 + CQRS + cursor pagination. Logseq: Electron, memory-heavy |
| Import/export | 7 | 6 | Logseq: multiple formats + publishing. Agaric: MD export + Logseq import |
| Mobile | 6 | 7 | Agaric: 24 MB Android APK, good perf. Logseq: Android slow, iOS available but limited |
| Extras | 9 | 0 | Logseq: graph view, whiteboards, PDF reader, flashcards, plugins |

Totals: **Logseq 125 / Agaric 132**

The gap has widened since the initial comparison due to block references, tag inheritance, inline queries, and formatting improvements. Logseq's 9 in "Extras" covers real functionality (graph view, whiteboards, PDF reader, flashcards, 200+ plugins) that Agaric doesn't attempt. For the target workflow (daily journaling + task management + project notes), Agaric's advantages in sync, data integrity, performance, and task management are decisive. For broader knowledge management workflows (Zettelkasten, research), Logseq's linking system and Datalog queries remain superior.

**Key insight:** Agaric doesn't try to be a universal Logseq replacement. It replaces Logseq specifically for a workflow centered on journaling, tasks, and project notes — and does so with better architecture, better task tooling, and zero subscription costs. Users who rely heavily on block references, graph view, PDF annotation, or plugins should stay with Logseq.

---

## Part 7: Remaining Improvement Opportunities

These are the highest-impact gaps that could further narrow the comparison. Ordered by estimated workflow impact for the target user.

| Gap | Impact | Effort | Notes |
| --- | --- | --- | --- |
| **Block embeds** (`{{embed}}`) | High | Medium | Would complete the block reference story. Render referenced block content inline (read-only). Required for full Zettelkasten parity |
| **Property value autocomplete** | Medium | Low | Suggest previously-used values when editing properties. Logseq does this; we have `::` key autocomplete but not value autocomplete |
| **Custom link labels** `[text]([[page]])` | Medium | Low | Human-readable link text instead of showing page name. Logseq supports this syntax |
| **Block reference counter** | Low | Low | Show count of references to a block (e.g., "3 refs"). Helps discover highly-referenced content |
| **Math/LaTeX rendering** | Low | Medium | `$$` notation for mathematical expressions. Niche but Logseq has it |
| **Configurable date format** | Low | Low | Currently fixed `YYYY-MM-DD`. Logseq allows `:journal/page-title-format` |

---

## Appendix: Research Sources

- Logseq Documentation: <https://docs.logseq.com/> (client-rendered SPA)
- Logseq Docs Repository: <https://github.com/logseq/docs> (raw Markdown sources)
- Logseq GitHub: <https://github.com/logseq/logseq> (41.9k stars, 920 open issues)
- Logseq Blog: <https://blog.logseq.com/> (last post: Aug 2024)
- Logseq Forum: <https://discuss.logseq.com/> (active, latest topics Apr 2026)
- Logseq DB Test Issues: <https://github.com/logseq/db-test/issues> (241 open, Apr 2026)
- Logseq Releases: <https://github.com/logseq/logseq/releases> (0.10.15, Dec 2025)
- Logseq Tasks Doc: <https://raw.githubusercontent.com/logseq/docs/master/pages/Tasks.md>
- Logseq Properties Doc: <https://raw.githubusercontent.com/logseq/docs/master/pages/Properties.md>
- Logseq Queries Doc: <https://raw.githubusercontent.com/logseq/docs/master/pages/Queries.md>
- Logseq Advanced Queries Doc: <https://raw.githubusercontent.com/logseq/docs/master/pages/Advanced%20Queries.md>
- Logseq Sync Doc: <https://raw.githubusercontent.com/logseq/docs/master/pages/Logseq%20Sync.md>
- Logseq Built-in Properties: <https://raw.githubusercontent.com/logseq/docs/master/pages/Built-in%20Properties.md>
- Logseq Block Reference: <https://raw.githubusercontent.com/logseq/docs/master/pages/Block%20Reference.md>
- Logseq Whiteboard: <https://raw.githubusercontent.com/logseq/docs/master/pages/Whiteboard.md>
- Logseq DB README: <https://raw.githubusercontent.com/logseq/logseq/master/deps/db/README.md>
