# Agaric vs Logseq: Feature Comparison

> **Revision 2026-08-30.** Full re-audit. Every Agaric row in this revision was verified against
> code on `main` (`12a4cab`, v0.9.9) by seven parallel domain audits; every Logseq row was
> re-verified against upstream repositories, release assets, docs sources and the marketplace
> manifest on 2026-08-30. Claims that could not be verified are labelled **unverified** rather
> than repeated from the previous revision.
>
> **This revision is deliberately less flattering than the last one.** The previous revision
> (2026-08-04, resting on a 2026-06-17 review) scored Agaric 154 to Logseq's 127. That result did
> not survive contact with the code. It rested on a description of a sync stack that no longer
> exists, credited reminders that never fire, credited a tag-inheritance capability no query can
> reach, and compared against a Logseq that has since shipped a major version. See
> [Part 10](#part-10-corrections-log) for the full corrections log.
>
> Goal: Agaric is meant to fully replace Logseq for the author's personal workflow. This document
> maps every Logseq capability to what Agaric has, what is missing, and — new in this revision —
> what Agaric claims to have but does not.

**Status key:**

| Label | Meaning |
| ------- | --------- |
| **Done** | Fully implemented and shipped |
| **Partial** | Implemented but incomplete |
| **Gap** | Not implemented |
| **Dead** | Code exists but no user can reach it |
| **Design choice** | Intentionally different from Logseq |
| **Better** | Agaric implementation exceeds Logseq's, verified |

---

## Part 0: Read This First — Three Things Changed

### 1. There is no longer one Logseq to compare against

On **2026-04-24** Logseq split into two products, and the previous revision of this document
predates that split entirely:

- **Logseq OG** — the file/Markdown version, moved to `github.com/logseq/og`. Officially in
  **maintenance mode**: "Our focus will be on maintenance and reliability rather than new feature
  development." Only release **1.0.0 (2026-04-15)**; last commit on its branch **2026-05-28** (an
  Electron 41.7.1 security bump). 268 stars, ~17 open issues.
- **Logseq 2.0** — the DB version, `github.com/logseq/logseq`. **2.0.1 released 2026-07-13**,
  self-described as beta. The README still warns: *"The DB version is in beta status while the new
  mobile app and RTC is in alpha. This means that **data loss is possible**."*

Every comparison row below must therefore say *which* Logseq. Comparing Agaric to "Logseq" without
that qualifier is now meaningless: the file version is frozen, and the database version is a beta
that removed whiteboards, slides, Excalidraw, built-in Zotero, the `((uuid))` syntax, org-mode,
`{{query}}` macros, half the `config.edn` surface, and compatibility with ~80% of the plugin
ecosystem.

### 2. Logseq shipped a major version while Agaric shipped one feature

Logseq, in the ~10 weeks since this document was last revised: **2.0 beta released**, Markdown
Mirror (a plain-markdown projection of a DB graph written to disk), Graph View V2, a bundled CLI
with terminal queries, **a native MCP server**, structured Table/List/Gallery views, an `:asset`
property type, publishing with password-protected pages, a recycle bin, multi-tab/multi-window,
hourly automated backups, and an FSRS flashcard rewrite. 2,257 commits in six months across 46
authors.

Agaric, over the same window: **one `feat` commit**. Of the 76 commits reachable from `main` in
this (shallow) checkout, 40 are `fix`, 13 `docs`, 7 `refactor`, 7 `ci`, 6 `test`, 1 `chore`, 1
`perf`, 1 `feat` — recount with
`git log --pretty=%s | grep -oE '^[a-z]+' | sort | uniq -c | sort -rn`. The window is the clone's
depth, not a fixed date range, so the absolute count moves between checkouts; the *shape* is the
finding. The last ~460
session logs are guards, fuzzers, mutation harnesses, review follow-ups and guards that check other
guards. The open backlog (130 issues) contains almost no product work — it is dominated by
`mutation-harness clone pins`, `session-log numbering`, `guards that fail open`, and sync
hardening.

This is the single most important finding in this document, and it is not a code-quality
criticism — the engineering rigour is real and unusual. It is a **direction** criticism: for ten
weeks the project has been improving its own immune system while the gap that actually blocks
Logseq replacement (block embeds, reference depth, a trustworthy sync story) stayed exactly where
it was.

### 3. This document was materially wrong about Agaric

Not out of date — wrong. The previous revision described sync as "mTLS WebSocket with TOFU cert
pinning (ECDSA P-256)"; that stack was **deleted** in the iroh cutover. It credited "task/deadline
reminders"; no reminder has ever fired, because there is no scheduler. It credited tag inheritance
as a working capability; no query surface consumes it. It rated multi-device sync **Done** and
**Better** while the repository's own docs say a full two-way sync end-to-end **remains
unverified**.

A comparison document that overstates its own side is worse than no document, because it is used
to decide what to build next. [Part 10](#part-10-corrections-log) tabulates 24 of the 30 corrections (15 false, 9
overstated); the remaining six are the false documentation claims in
[Part 5](#part-5-agarics-self-inflicted-problems), which are defects in `docs/features/*`
rather than in this document.

---

## Part 1: Context — Three Animals

**Logseq OG 1.0.0** (frozen, 2026-04-15) — ClojureScript on Electron, plain `.md`/`.org` files on
disk. Feature-complete and going nowhere: security and dependency patches only. Its chronic
weakness — performance at scale — will now never be fixed, because the fix *was* the DB rewrite.
Binaries: Linux AppImage 187 MB, macOS arm64 dmg 190 MB, Windows exe 221 MB, Android APK 32.9 MB.

**Logseq 2.0.1** (beta, 2026-07-13) — SQLite + DataScript, typed properties, tags-as-classes with
multiple inheritance, a real views system. Genuinely more capable than OG in data modelling, and
genuinely riskier: 346 open issues in `logseq/db-test` (issues filed the day of this audit), RTC
sync in alpha, iOS invite-only alpha, Android not yet open for alpha, and an official data-loss
warning. Binaries: Linux AppImage 174 MB, macOS arm64 dmg 161 MB, Windows NSIS 135 MB, Android APK
37.8 MB.

**Agaric 0.9.9** — Rust + React on Tauri 2, SQLite from the start, Loro CRDT engine, LAN-only
peer sync. Single maintainer, pre-1.0, no public user base. Its engineering discipline is
exceptional for a personal project (6,284 Rust test functions, 905 test files, 8 fuzz targets, a
100K-block benchmark SLO gate, SLSA provenance, a written threat model with an assurance case). Its
product surface is narrower than either Logseq, and its riskiest areas are the ones a single user
cannot test alone: multi-device sync and long-horizon data durability.

**Project health, for calibration:**

| | Logseq OG | Logseq 2.0 | Agaric |
| --- | --- | --- | --- |
| Stars | 268 (new repo) | 44,687 | private |
| Commits, last 6 months | ~0 (frozen) | 2,257 | not measurable (shallow clone) |
| Distinct authors, 6 months | ~1 | 46 | 1 |
| Open issues | ~17 | 858 + 107 PRs | 130 |
| Funding | $4.1M seed (2022) + ~$252k/yr Open Collective | same | none |
| Bus factor | — | ~4 (top 4 authors ≈ 90% of commits) | **1** |

---

## Part 2: Feature-by-Feature

Where OG and 2.0 differ materially, the Logseq column says so.

### 1. Block Model

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Everything is a block | Yes. 2.0 unifies blocks and pages as "nodes" | Yes — `blocks` table, tree via `parent_id` + `position`. `block_type` is a closed enum: `content \| tag \| page` | Done |
| Block nesting depth | Unlimited in practice | **Capped at 20**, enforced backend-side (`src-tauri/agaric-store/src/block_descendants.rs:64`); create/move past it returns a validation error | Partial |
| Block IDs | UUID v4 (random, unsortable) | ULID (Crockford base32, sortable, time-encoded) | Better |
| Block references | `((uuid))` renders the source block's **content** inline, live; hover shows breadcrumb + children; **reference-count badge** on the source block | `((ULID))` renders a chip with the target's **first line, 60 chars**, echoed into a native `title=`. The 300-char hover tooltip was **removed** (#4228). Click navigates | Partial |
| Block embeds | `{{embed ((uuid))}}` — full subtree, **editable in place**. 2.0: unified `/Node embed` | **Absent.** No embed feature of any kind exists (repo-wide search finds only the `{{query}}` picker) | Gap |
| Block properties | `key:: value` parsed from content; 2.0: typed property rows | `block_properties` with 6 typed values; `::` name autocomplete; PropertyChip inline display; BlockPropertyDrawer | Done |
| Collapse/expand | State persisted **in the block** (`collapsed::`) — travels between devices | Chevron + `Ctrl+.`, persisted in `localStorage` per page — **device-local, not synced** | Partial |
| Zoom into block | `Alt+Right`, a real route with a URL | Zoom with breadcrumb, but ephemeral `useState` — **not deep-linkable, not restored on reload, not in the back-stack** | Partial |
| Move block up/down | `Alt+Shift+Up/Down` | DnD (depth-projecting, cap-aware, subtree-safe) + `Ctrl+Shift+Up/Down` | Done |
| Block-level multi-select | `Esc` + arrows; 2.0 adds bulk set-property / bulk tag | Ctrl+Click, Shift+Click, Ctrl+A. Batch actions: **three** — set todo state, cycle priority, delete. No batch indent/dedent, move, or tag; `CANCELLED` missing from the batch todo menu | Partial |
| Subtree copy/paste | Yes | Indented-markdown outline grammar; refs preserved verbatim; `[[Name]]`/`#tag` internalized to ULIDs on paste | Done |
| Cross-block undo | Session-level `Ctrl+Z`, no history UI | Op-level undo/redo, per-page depth + redo stack, HistoryView with multi-select batch revert and word-level diff | Better |

### 2. Page Model

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Pages as containers | One file per page (OG); node entity (2.0) | `blocks` with `block_type = 'page'`, content = title | Done |
| Page properties | First block holds `key:: value` | `block_properties` on page blocks; PagePropertyTable UI | Done |
| Page aliases | `alias:: JS, ECMAScript` | `page_aliases` table + PageHeader alias badges | Done |
| Namespaced pages | `Project/Backend/API`; 2.0 replaces namespaces with tag hierarchy | Tree view in PageBrowser, breadcrumbs, create-under flow | Done |
| Page tags via property | `tags:: book, fiction` → page refs. 2.0: tags are classes | Tags via `block_tags` junction + `@` picker. Not page-level property syntax | Partial |
| Unique names per context | 2.0: page names unique **per tag** (`Apple #Company` vs `Apple #Fruit`) | Titles are block content; uniqueness not modelled | Gap |
| Auto-created pages from links | Clicking `[[New Page]]` creates it | `[[` picker has "Create new" | Done |
| Move page between contexts | Multi-graph = separate folders | **Move to space** from the page kebab **and batch-move from the Pages view** | Better |

### 3. Editor & Formatting

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Markdown support | Full Markdown (OG) | **Subset.** Ships: bold, italic, code, strike, highlight, underline, headings, code fences, math, tables, blockquotes/callouts, ordered/bullet/task lists, images, rules, autolinks. **Missing: setext headings, indented code blocks, reference links, footnotes, definition lists, inline/block HTML (only `<u>`), sub/superscript** | Partial |
| Markdown round-trip | Files are the source of truth | **Normalizing, not preserving.** Pinned lossy cases: `hardBreak` in a table cell → space; adjacent blockquotes merge; CRLF → LF; underline stored as `<u>`. Unknown inline nodes are **silently dropped** | Partial |
| Org-mode | Full `.org` (OG only; 2.0 dropped it) | Not implemented | Design choice |
| Bold / italic / strike / highlight / code | `**` `*` `~~` `^^text^^` `` ` `` | `**` `*` `~~` `==` `` ` ``, each with a shortcut | Done |
| Underline | No dedicated mark | Underline mark, `Ctrl+U` | Better |
| Headings | `# H1`–`###### H6` | `/h1`–`/h6` + Turn-into popover, levels 1-6 | Done |
| Code blocks | Fenced, syntax-highlighted | Fenced with lowlight (curated grammar set), language popover | Done |
| Math / LaTeX | `$$…$$` native | `$…$` inline + `$$…$$` block, KaTeX lazy-loaded, raw-source node view, round-trips | Done |
| **Mermaid diagrams** | **Plugin only** | ```` ```mermaid ```` fences render inline in both the editor and the read-only renderer, with a raw-source toggle; lazy-loaded | **Better** |
| Tables | Markdown tables | Pipe tables + `/table`, `/table RxC` dimension syntax, `/table-no-header`, a grid picker, contextual table-ops popover | Better |
| Callouts | Plugin/CSS convention | 5 built-in types (info/warning/tip/error/note), `> [!TYPE]` shape, slash commands | Better |
| Lists | Outline bullets are the list | **Real ordered/bullet/task list nodes and markdown grammar, plus nested sub-lists** — the previous revision's "no lists" claim was wrong | Done |
| Slash commands | ~20+ | **33 base entries + 51 expansions = 84**, plus a synthetic `table RxC`; recents band on empty query | Better |
| Inline pickers | `[[`, `((`, `/`, `#` | **Seven**: `[[`, `@`, `((`, `/`, `::`, `:` (emoji), `{{` (query, with ghost-text hint) | Better |
| Formatting toolbar | None — keyboard only | Standing bar: **Format popover** (6 caret marks), **Turn-into popover** (9 block types), internal-link, block-ref, tag, insert-query, emoji, table grid, cycle-priority, date/due/scheduled, todo, properties, undo/redo/discard, width-aware overflow. Plus a selection bubble menu (6 marks + external link) | Better |
| Property value autocomplete | Suggests previously-used values | **Only in the search DSL's `prop:key=value`.** Not in the `::` editor picker, and not in the filter popover used by Pages and the query builder | Partial |

### 4. Linking System

This is Agaric's weakest domain and the previous revision scored it too generously.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Page links | `[[page name]]` — human-readable in the raw file | `[[ULID]]` chips, title resolved at render. Robust to renames; **opaque in raw text**. Picker searches **pages only**. Unresolvable target degrades to a literal `[[01HZAB12...]]` | Partial |
| Block references | Live inline content + count badge + hover breadcrumb/children | Chip with a 60-char first line and a native `title=`. No inline content, no children, no in-place editing, and since #4228 no full-content reveal | Partial |
| Block embeds | `{{embed ((uuid))}}`, editable in place | **Absent** | Gap |
| Page embeds | `{{embed [[page]]}}` | **Absent.** Nearest primitive is `{{query}}`, which produces a filtered *list*, not a transcluded subtree | Gap |
| Custom link labels | `[label](((uuid)))` and `[text]([[page]])` | **Absent.** `[label]([[ULID]])` parses as an external link with a literal href | Gap |
| Reference counter | Per-block count badge on the source block | **Page-level only** — a total in the Linked References header, and per-day backlink badges in journal week/month views. No per-block counter, no badge on a referenced block | Partial |
| Linked references | Grouped by page, filter bar | Grouped by source page, collapsible, cursor-paginated, server-side filters. **Mounted on pages and journal days only — never on a block**, though the backend accepts any block id | Partial |
| Unlinked references | Plain-text mentions | "Link it" conversion, grouped, paginated. **Mounted only on `PageEditor`** (absent from journal day sections) | Partial |
| Link kinds distinguishable | Refs and links are distinct entities | **No.** `block_links` has no kind discriminator — `[[ULID]]` and `((ULID))` share one `(source, target)` primary key, so no surface can separate page links from block refs without a migration | Gap |
| Backlink filtering | Simple filter bar | Server-side `FilterExpr` boolean tree over 23 predicates with And/Or/Not and keyset pagination | Better |
| Graph view | Local + global; 2.0 ships a rebuilt Graph View V2 for large graphs | Global force-directed graph (d3-force in a worker) + per-page local 1/2-hop neighbourhood. **Edge set is capped** (`PAGE_LINKS_EDGE_CAP`) with a `truncated` flag | Done |
| Link fidelity on export | Files already contain the names | Export rewrites `[[ULID]]`→`[[Title]]`, `#[ULID]`→`#name`, `((ULID))`→`[[Page#^ULID]]` anchors; same-page anchors **re-import as real block refs** | Better |

### 5. Properties

Logseq 2.0 turned this into its strongest domain. Agaric is now behind, not ahead.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Typed values | OG: untyped text. **2.0: 6 real types** (Text, Number, Date, DateTime, Checkbox, Url, Node) with correct numeric sort | **6 types**: text, number, date, select, ref, **boolean** (the previous revision said 5 — boolean has shipped end-to-end since migration 0043) | Done |
| Schema registry | 2.0: properties are pages with their own config | `property_definitions` (STRICT), full CRUD, and a declaration is now refused if stored values would violate it | Done |
| Multi-value | OG: opt-in comma splitting. **2.0: first-class multi-value on all types but Checkbox/DateTime** | **Absent.** `PRIMARY KEY (block_id, key)` makes it structurally impossible | Gap |
| Default values / choices | 2.0: default value, enum choices with icons + ordering, per-tag scoping, checkbox-state mapping | `select` options only | Partial |
| Property display control | 2.0: UI position (row / start / under / end), hide-by-default, hide-empty | Fixed: PropertyChip (max 3) + drawer | Gap |
| Constrained references | 2.0: a Node property can be constrained to nodes carrying a given tag | `ref` type accepts any page | Partial |
| Bidirectional properties | 2.0: reverse lists surface on the target automatically | **Absent** | Gap |
| Built-in properties | ~15 editable + ~8 hidden | 20 seeded (`status`, `due`, `url`, `todo_state`, `priority`, `due_date`, `scheduled_date`, `created_at`, `completed_at`, `effort`, `assignee`, `location`, `repeat`, `repeat-until`, `repeat-count`, `repeat-seq`, `repeat-origin`, `space`, `is_space`, `listStyle`) — `space` and `is_space` (`src-tauri/migrations/0035_spaces.sql:5-7`) are internal markers, but they are seeded rows like the rest | Done |
| Property-based queries | Simple `(property k v)` + full Datalog | Typed predicates with 10 operators in the engine — **4 of them, Text-only, in the UI** | Partial |

### 6. Tags

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Inline tag syntax | `#tag` / `#[[multi word]]` — tags are pages | `#[ULID]` chip with resolved name | Done |
| Tags as pages | Yes. **2.0: tags are classes/supertags** — properties defined on a tag are inherited by every tagged node, and edits propagate live | Tags and pages are separate `block_type` values, separate namespaces | Design choice |
| Tag hierarchy | OG: `/` naming. **2.0: `Extends`, with multiple inheritance and a tag tree** | Prefix convention (`work/meeting`) matched with `LIKE` | Partial |
| Boolean tag queries | Via query DSL | `TagExpr` with Tag/Prefix/And/Or/Not, depth-gated, compiled to one pushed-down id-set subquery | Better |
| Tag inheritance in queries | 2.0: inherited class properties are queryable | **Unreachable.** `block_tag_inherited` is materialized, incrementally maintained across 5 propagation paths, and has a rebuild job. The resolver does read it — `src-tauri/agaric-store/src/tag_query/resolve.rs:35,123` branches on `include_inherited` — but **no production caller ever enables it**: `src/lib/tauri/queries.ts:240` coerces to `false`, and the Rust commands default `None` to `false` (`src-tauri/src/commands/tags.rs:549,599`). Only tests pass anything else. The shared filter vocabulary has no inherited-tag path at all. Inherited tags are *displayed* on a block and nothing more | **Dead** |
| Tag usage counts | Shown in UIs | `tags_cache.usage_count` | Done |

### 7. Query System

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Simple queries | `{{query (and [[page]] (task TODO))}}`; full filter vocabulary: `and/or/not`, page ref, free text, `between` (incl. `created-at`/`last-modified-at`), `property`, `task`, `priority`, `page`, `namespace`, `page-property`, `page-tags`, `all-page-tags`, `sample`, `sort-by`. 2.0 makes queries `#Query` nodes | `{{query …}}` blocks, plus a **structured `v2:<base64url(JSON)>` payload** carrying an arbitrary `FilterExpr`, authored by the query builder's Advanced mode; legacy text queries are transparently rerouted onto the rich engine when faithfully translatable | Done |
| Filter vocabulary | See above | **23 primitives**: Tag, TagOrRef, ChildOf, PathGlob, HasProperty, LastEdited, Space, Priority, State, BlockType, DueDate, Scheduled, Created, **LinksTo, LinkedFrom, HasParentMatching**, Orphan, Stub, HasNoInboundLinks, Regex, CaseSensitive, WholeWord, Snippet | Better |
| Graph traversal | Full Datalog: arbitrary joins, variable-length paths, rules | **One hop plus ancestors.** `LinksTo`/`LinkedFrom` take a *concrete* block id, not a nested expression; `HasParentMatching` recurses (depth ≤ 50). No transitive closure, no joins, no rules | Partial |
| Result transforms | `:result-transform` and `:view` evaluated by SCI (sandboxed Clojure) | **Absent.** Five fixed scalar folds (count/sum/avg/min/max) over two columns or one property | Gap |
| Grouping | 2.0: group-by in the Views system | 7 group keys incl. property and date-bucket — **5 of 7 in the UI**; groups show a count and a **hard 10-row preview with no expand affordance** | Partial |
| Aggregation | `{{function (sum :qty)}}` + arbitrary SCI functions | count/sum/avg/min/max, global + per-group; **UI targets columns only** | Partial |
| Sorting | `sort-by`, `query-sort-by`, table-header sort | Multi-key over a closed column set + bm25 relevance | Done |
| Query result table | `query-table:: true` + `query-properties::` column picker; 2.0: full Views (Table/List/Gallery) with pinned/resizable/draggable columns, inline cell editing, EDN export | Columns **auto-derived** from properties present on the loaded page; client-side sort over that page only; **no column picker** | Partial |
| Live-updating results | Yes — DataScript reactivity | **No.** `staleTime: Infinity`, `gcTime: Infinity`, no invalidation of the query key anywhere. Inline blocks refetch on **mount and on expression change**, not on data change | Partial |
| User-facing query language | Text you can read, diff, paste, and version-control | **None.** The only textual form is `v2:<base64url(JSON)>`, deliberately opaque; saved views are JSON in a hidden property | Gap |
| Cross-space queries | Multi-graph search is manual | **Impossible.** `space_id` is mandatory and forced into every advanced query | Gap |

### 8. Task Management

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Task markers | OG: `LATER/NOW/DONE` or `TODO/DOING/DONE` + `CANCELED`, `IN-PROGRESS`, `WAIT/WAITING`, switchable in config. **2.0: one customizable set** — Backlog, Todo, Doing, In Review, Done, Canceled, **user-extensible** | `none → TODO → DOING → DONE → CANCELLED → none`, **hard-locked in a frontend constant**. The backend would accept a custom value; the UI forbids editing it | Partial |
| Priority levels | `[#A] [#B] [#C]`, fixed | **Configurable** via the `priority` property definition's options (defaults 1/2/3); click-to-cycle badge, slash commands and `Ctrl+Shift+1/2/3` for the defaults | Better |
| Due / scheduled dates | Org-style `DEADLINE:` / `SCHEDULED:` lines | `due_date` / `scheduled_date` columns, slash commands, date pickers | Done |
| Recurrence | Repeaters `+` / `.+` / `++`, intervals `Nd/Nw/Nm`. **Note: OG's implementation contradicts its own docs** — `.+` advances from the *original* timestamp, not the completion date | Modes `+` / `.+` / `++`; intervals daily/weekly/monthly/**yearly** and `+Nd/+Nw/+Nm/+Ny`; end conditions (`repeat-until`, `repeat-count`, `repeat-seq`, `repeat-origin`); write-time grammar validation with a user-facing reason. **Completing creates a new sibling and leaves the completed block behind** — a long-lived daily habit accumulates one block per occurrence, where Logseq advances one block in place | Better |
| Recurrence projection | None | Projected future occurrences — **in the Due Panel**, not Agenda mode (the previous revision said Agenda) | Better |
| Task dashboard | OG: a "Scheduled tasks and deadlines" section windowed by `:scheduled/future-days` (default 7), plus two default journal queries. **There is no real agenda view**; agenda UX is plugin territory. 2.0: every tag page carries a Table view of its instances | Agenda mode with 8 filter dimensions (status, priority, due, scheduled, completed, created, tag, property), sort (date/priority/state/page), group (same + none), cursor pagination; DonePanel; DuePanel with source pills; **`UnfinishedTasks` rollover** on today's view grouping pre-today open tasks into yesterday / this week / older | Better |
| Time tracking | **OG: built-in and on by default** — `:LOGBOOK: CLOCK:` drawers written on state transitions. **2.0: replaced by queryable status-change history** with spent-time display | **Absent** | Gap |
| Effort tracking | Arbitrary custom properties | `/effort` with a **fixed 6-option select** (15m/30m/1h/2h/4h/1d); no custom values, no rollup, no reporting | Done |
| Overdue accumulation | Via embedded queries | DuePanel overdue section + the `UnfinishedTasks` rollover | Better |
| Deadline warning period | `:scheduled/future-days` | Configurable 0-90 days in **Settings → General** (not PropertiesView, as previously stated) | Done |
| Task / deadline notifications | Plugins only | **Stub.** OS notification plumbing, an enable toggle, a permission request, and a "send test notification" button — which is the *only* production caller. **No scheduler, no dedupe ledger, no snooze: no reminder ever fires.** The Rust module says so itself | Partial |
| Calendar integration | Plugins only | **Absent, and deliberately reverted** — migration 0091 drops the Google Calendar tables. No CalDAV, no ICS import or export | Gap |

### 9. Daily Journal

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Auto-created daily page | On launch | On launch in daily mode, with template applied | Done |
| View modes | Single scrollable view; infinite scroll starts at 3 journals, +7 per scroll, **not configurable** | **5 modes**: Daily, Weekly, Monthly, Agenda, Stream (infinite scroll) | Better |
| Date navigation | `g n` / `g p`, date picker | Prev/next per mode, `Alt+Left/Right`, `Alt+T`, calendar dropdown with **4 content-dot types** (page/due/scheduled/property) and counts; plus a global date-jump header outside the journal | Better |
| Drag-to-reschedule | No | HTML5 drop zones on weekly day sections, with a documented keyboard equivalent | Better |
| Configurable date format | **OG: `:journal/page-title-format` (default `MMM do, yyyy`). 2.0 REMOVED the knob** | **Shipped** — a 5-value allowlist in Settings → Appearance (`locale`, `yyyy-MM-dd`, `MMMM d, yyyy`, `dd/MM/yyyy`, `EEE, MMM d`). **Display-only**: stored page identity stays ISO, so exports and links are never human-formatted | Partial |
| Natural language dates | In date pickers | `today`, `tomorrow`, `yesterday`, `next <weekday>`, `next week`, `in N days/weeks/months`, `end of month`, `+Nd/+Nw/+Nm`, ISO, `MM-DD`, `15-Apr-2026`. Missing: `last <weekday>`, `this week`, `next month`, `+Ny` | Partial |
| Journal templates | `:default-templates {:journals …}`. 2.0: apply-template-to-tag | Template pages via property, auto-applied, **plus a per-space journal-template override** | Better |
| "On this day" | Possible via Datalog | **Absent** | Gap |

### 10. Search

Agaric's strongest domain, and the previous revision understated it.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Full-text search | SQLite FTS5 with the **`unicode61` tokenizer**, desktop only. Mobile/browser uses fuse.js fuzzy matching **with the page-content index disabled entirely** | FTS5 **trigram** tokenizer, bm25 ranking, keyset cursor pagination, same engine on every platform | Better |
| CJK / substring search | **Broken.** `unicode61` has no CJK segmentation, so CJK queries fall through to an unranked `LIKE '%…%'` path. Multiple long-standing open issues | Full substring and CJK support via trigram. **Trade-off**: 1-2 character queries have no useful index and the UI shows an advisory banner | Better |
| Search filter language | "Combine `Ctrl+K` with filters informally" | **A real inline DSL**: 11 token prefixes (`tag:`, `path:`, `not-path:` with GLOB + brace expansion, `state:`, `not-state:`, `priority:`, `not-priority:`, `due:`, `scheduled:`, `prop:k=v`, `not-prop:k=v`) plus bare `#tag`, with a tokenizer, validator with structured error codes, chip round-tripping, per-token autocomplete and a helper popover. **Conjunction-only — no OR, no grouping** | Better |
| Search scope | Pages + blocks, filterable | Space scope, page-name GLOB include/exclude, block-type filter, and a partitioned pages-vs-blocks endpoint for the palette. 18 filter fields total | Better |
| **In-page find (`Ctrl+F`)** | **None** | Browser-style toolbar: case-sensitive, whole-word and **regex** toggles, live match counter, next/prev cycling, focus restore, mobile embedded variant, Unicode-correct folding including Greek final-sigma collapse | **Better** |
| Long-block indexing | **Blocks over `:block/content-max-length` (10000) become silently unsearchable and uneditable** | Per-block FTS cap with explicit handling | Better |
| Recent pages | In search results | Per-space "Recent" list when the query is empty | Done |

### 11. Spaces (Workspaces)

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Multiple contexts | One graph per instance; multi-graph = switch folders. 2.0 adds multiple tabs and windows | Multiple `space` blocks partition one DB into independent contexts | Better |
| Per-space journal / tabs / recents | N/A | Journal keyed `(date, space)`; `tabsBySpace` + `recentPagesBySpace` | Better |
| Per-space identity | N/A | Accent colour (6 swatches), top stripe, sidebar badge, window-title prefix | Better |
| Quick switching | Graph switcher | `Ctrl+1` … `Ctrl+9`, rebindable | Better |
| Cross-space links | N/A | Broken-link chip; click removes the ref, `Ctrl+Z` restores; enforced at **write** time so the link can't be created accidentally | Better |
| Manage UI | N/A | Create, inline rename, accent picker, per-space journal template, safety-checked delete (empty spaces only, never the last) | Better |
| **Per-space sync scope** | N/A | **Not a thing.** Messages are per-space but a session syncs **every** space in the registry. No selective sync, no per-space opt-in | Gap |

### 12. AI / Agent Integration

The previous revision scored this 9-to-1. That is no longer true: **Logseq 2.0 ships its own MCP
server.**

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| MCP server | **2.0 ships one** (desktop Settings → AI, or via the CLI): search, create and list pages, tags, properties, blocks, with a `pretend` dry-run mode and undo/redo integration | `agaric-mcp` stdio sidecar over a Unix socket / Windows named pipe with an owner-only DACL. Never TCP. **Two** endpoints — read-only and read-write — **both off by default**, each gated by its own marker file and toggle | Tie |
| Tool surface | Search/create/list; editing pages, tags and properties still TODO | **10 read-only** (list_pages, get_page, search, get_block, list_backlinks, list_tags, list_property_defs, get_agenda, journal_for_date, list_spaces) + **6 read-write** (append_block, update_block_content, set_property, add_tag, create_page, delete_block) | Better |
| Auditability | Undo/redo integration | Every op stamped `agent:<name>` in the op log; a 100-entry **in-memory** activity ring (dies on restart, not synced) and a session-revert bounded by that ring. **The History view does not render op origin**, so once the ring rolls over nothing in the UI identifies agent edits | Partial |
| Isolation | Graph-scoped | **`space_id` is not an isolation boundary.** Reads are vault-wide by design; a rejected write *tells the agent the target's real space*. No auth, no rate limiting, no per-agent scoping. Once RW is enabled, any local process that can open the socket has full reversible write access to the whole vault | Gap |
| Programmable API | Plugin API (~85 methods) **plus a local HTTP server** on `127.0.0.1:12315` with bearer auth exposing the same surface | MCP only | Gap |
| In-app AI features | GPT plugins; voice capture + transcription in progress | **None** | Gap |

### 13. Sync & Storage

The previous revision described a transport that no longer exists and rated the result "Better".
Both are corrected here.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Transport | OG: files + third-party sync. 2.0: RTC over the network | **iroh QUIC over UDP** (`iroh 1.0.3`), TLS 1.3 inside the QUIC handshake, ALPN `agaric/sync/0`. The previous mTLS/WebSocket/rustls/rcgen stack was **deleted** in the cutover | Done |
| Peer identity | Account-based | **ed25519 endpoint id**, TOFU-bound into `peer_refs.endpoint_id` after the first successful session. Key stored as raw bytes at mode `0600`, **not in an OS keychain**. There is no certificate and no cert pinning | Done |
| Discovery | Cloud | mDNS `_agaric._udp.local.`, plus a `MulticastLock` on Android | Done |
| Pairing | Account login | 4-word EFF passphrase or QR, proven by a domain-separated blake3 proof inside the first `HeadExchange`; 5-minute ephemeral window | Done |
| **Pairing fallback** | N/A | **None.** The QR carries only the passphrase — no host, port or key — and the endpoint id is only learned *after* a successful session. On guest WiFi, with AP isolation, with multicast disabled, or across two subnets, **first-ever pairing is impossible by any route the UI exposes** (#3952). Three docs claim a fallback exists; it does not | Gap |
| Remote / internet sync | Logseq Sync / RTC (paid, invite-only via Open Collective backer tiers, self-hostable; E2EE still being built) | **LAN only, by construction.** Relays cleared, IP transports cleared, address lookup cleared, DNS resolver answers nothing, binding refused in publicly-routable space | Design choice |
| Conflict resolution | OG: file-level (fragile). 2.0 RTC: alpha, with a documented net-data-loss incident on iOS in July 2026 | **Loro CRDT** per space: `LoroTree` for hierarchy (move-as-CRDT, fractional index), `LoroText` for content, `LoroMap` for properties and tags. SQL `parent_id`/`position` are derived, not merged | Better |
| **What does not converge** | — | **Attachments** are the only op types outside the engine (rebuilt from the *device-local* op log); the **op log itself is audit-only across peers**; an inbox slot unsatisfiable for N boots is moved to a **quarantine table that no frontend code reads** — it is `tracing::error!` and nothing else, while the UI still says "synced" | Partial |
| Sync direction | Bidirectional | **A session is a pull**: data flows responder → initiator only. Two-way convergence requires two independently-initiated sessions | Partial |
| **Multi-device, verified** | Widely used (and widely complained about) | **Unverified.** The repo's own docs: *"A full two-way sync end to end is still unverified (#3507)."* One first-pair has been observed on real hardware, unidirectional, after clearing a phone VPN and a desktop firewall | Partial |
| Op log / history | Timestamps only | Append-only blake3 hash chain over 5 preimage fields, SQL-trigger-enforced, per-device sequences, cursor-paginated history. **Caveat**: the legacy CBOR catch-up path wipes the op log, resetting history and undo to empty | Better |
| Snapshots / compaction | 2.0: **hourly automated backups, last 12 retained** | zstd + CBOR snapshots, 90-day compaction, two-phase crash-safe write. **`collect_tables` materializes the whole vault in RAM** (acknowledged OOM risk), and `apply_snapshot` at 100K blocks holds the write lock ~18 s — long enough that a concurrent writer waits out the 5 s `busy_timeout` and fails | Partial |
| **Backup / restore** | 2.0: automated hourly | **None.** No in-app backup, no restore, no cloud copy. The only exit is a lossy Markdown ZIP | Gap |
| Crash recovery | Filesystem journaling | Four-step boot recovery plus a disaster path: recreate missing tables, op-log replay, engine-first reprojection from `loro_doc_state`, attachment replay, all gated by a persisted retry marker | Better |
| Encryption at rest | OG: none. Logseq Sync: age end-to-end | **None.** SQLCipher explicitly rejected. The database, the attachments **and the ed25519 private key** sit behind filesystem permissions and whatever the OS provides | Logseq |
| Supply-chain assurance | Standard CI | SLSA build provenance on every artifact, OpenSSF Scorecard, CodeQL, blocking `cargo-deny`/`cargo-audit`, a written STRIDE threat model with an assurance case. **No Windows code signing; macOS notarization is an explicit no-go** | Better |

### 14. Templates

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Template creation | Block/page with `template:: name` | `template=true` pages, kebab "Save as template", **plus a dedicated Templates view** (create, search, preview, journal-template badge, un-template) | Better |
| Template insertion | `/Template` picker | `/template` picker, single batched IPC, atomic | Done |
| Dynamic variables | `<% today %>`, `<% time %>`, `<% current page %>` | **Two grammars.** Legacy: `today`, `time`, `datetime`, `page title`, `date±N`, `weekday`, `month`, `isoweek`, each with optional `:FORMAT`. Modern: `{{date}}`, `{{date:FMT}}`, `{{time}}`, `{{title}}`, `{{cursor}}` (caret placement) | Better |
| Default journal template | `:default-templates` | `journal-template=true` pages, plus a per-space override | Better |
| Template including parent | `template-including-parent:: true` | **Absent** | Gap |
| **Block properties in templates** | Carried through | **Dropped.** Every block created from a template passes `properties: {}` — a template containing tasks with states, priorities or due dates inserts as plain content. Undocumented until this revision | Gap |

### 15. Import / Export

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Import formats | Roam JSON, OPML, Markdown | **Six**: Markdown (single file / multi-file / folder), **Obsidian vault**, **Evernote `.enex`**, **Joplin `.jex`**, **BibTeX / CSL-JSON bibliography** to typed reference pages | Better |
| Import from Logseq | N/A | Indented bullets → block tree, `key:: value` properties, YAML frontmatter (incl. `aliases`/`tags` into real alias rows and tag associations), `[[Page]]` → real refs, `#tag`/`#[[multi word]]` → real tags, folder path → namespaced title, `^block-id` anchors, attachments from sibling files on a folder pick | Partial |
| **What Logseq import drops** | — | **Every `((block-ref))` is stripped and the target reference deleted** — the code itself calls this data-lossy, and the previous revision listed it as a *feature*. **No journal awareness**: `journals/2026_08_30.md` imports as a page *titled* `journals/2026_08_30`, not as that date's journal. Also dropped: `config.edn`, `{{query}}`, `{{embed}}`, whiteboards, reserved keys, blocks past depth 99. A single-file pick ships no attachments | Gap |
| Import merge | N/A | **No merge.** Importing the same corpus on two synced devices produces duplicate parallel pages with colliding titles | Gap |
| Import from Roam | Native JSON | **Absent** | Gap |
| Markdown export | Full graph | Per-page (`Ctrl+Shift+E`) with YAML frontmatter; **"Export All"** (active space) and **"Export all spaces"** (whole vault, one folder per space); attachments written to `assets/` with links rewritten; descendant block properties round-trip; `export-report.txt` and a partial-success toast on any skip; Zip-Slip hardened | Better |
| **What export drops** | Files are the format | Op-log and history, trash contents, **typed property definitions (the schema)**, saved queries, tag colours, starred pages, space accent colours, per-space journal templates, keyboard customizations, sync/peer state, drafts, tabs and recents. Built client-side with JSZip, so a large vault is held entirely in browser memory | Partial |
| JSON / EDN / OPML export | OG: **EDN, JSON, OPML, Roam JSON, HTML, Markdown**. 2.0: SQLite `.db`, SQLite+assets zip, **Build EDN** (export/import a block, page, or the graph's entire tag+property *schema*) | **None** | Gap |
| HTML publishing | OG: self-contained read-only SPA with search. **2.0: hosted Logseq Publish** (paid, per-page, password-protectable, self-hostable) | **Absent** | Gap |

### 16. Mobile & Platforms

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Desktop | Linux, Windows, macOS | Linux (deb/rpm/AppImage), Windows (MSI), macOS (x86_64 + aarch64 dmg) | Done |
| Android | Public stores serve the **old file version** — F-Droid 0.10.15 (2025-12-18, 32 MiB); no official Google Play listing. **2.0's native Android app has not opened even for alpha testing** | Signed release APK in the pipeline, **arm64-v8a only, API 30+, sideload-only**. No Play Store, no F-Droid. ~24 MB per the project README (unverified in this audit) | Tie |
| iOS | App Store serves **0.10.9, last updated 2024-04-23** (4.4★, reviews cite "slow and janky"). **2.0's native iOS app is invite-only alpha** | **Absent** — no code, no target, no tracked blocker. (The previous revision blamed issue #522; #522 is closed and was about manual IP entry, not iOS) | Gap |
| Mobile sync | Sync/RTC, with a documented July 2026 DB-sync data-loss incident on iOS | LAN sync, **foreground only** — Doze kills UDP sessions | Partial |
| Mobile plugins | **None on mobile, in either version** | N/A | Tie |

### 17. Out of Scope for Agaric

| Feature | Logseq | Notes |
| --- | --- | --- |
| Plugin / extension system | **593-615 marketplace packages** — but **only ~110 (18%) work on 2.0**, 44% have had no push in 2+ years, and 52% declare `effect: true`, i.e. they run **un-sandboxed in the host origin** | Agaric has **no plugin API, no custom CSS, no theme authoring, no user scripts**. It ships 7 built-in themes, 3 font sizes, motion and tooltip controls, and full keyboard rebinding. MCP is the only extension seam |
| Flashcards / SRS | OG: SM-5 with an OF matrix, 3 rating buttons, state in block properties. **2.0: rewritten on FSRS with 4 ratings — and explicitly does not import SM-5 data** | Not priority per user |
| Whiteboard | OG: a tldraw fork with portals, embeds, connectors. **2.0: REMOVED** ("hopefully available as a plugin"). Slides and Excalidraw removed too | Not priority per user |
| PDF highlight-to-block | OG: highlights become real blocks on an `hls__<name>` page, queryable, with jump-back chips. 2.0: `#PDF Annotation` tag with a cross-PDF table | Agaric ships a pdf.js v6 reader with **highlight + pinned comment** annotation (no ink). Saving **bakes annotations into a new attachment and deletes the original**, which is correct for sync but leaves any inline `attachment:<id>` reference in block content dangling. No highlight-to-block |
| Zotero | OG: built-in (requires Zotero cloud sync). **2.0: REMOVED**, now a community plugin | Agaric ships a **BibTeX/CSL-JSON importer** to typed reference pages — narrower, but native and offline |
| Org-mode | OG only; 2.0 dropped it | Design choice |

---

## Part 3: Where Agaric Genuinely Wins

Trimmed to claims that survived verification.

| Area | Agaric advantage | Against |
| --- | --- | --- |
| **Search** | Trigram FTS5 (real CJK + substring), an 11-prefix filter DSL with validation and autocomplete, 18 filter fields, and a `Ctrl+F` in-page find with regex that Logseq has no equivalent of | Logseq's `unicode61` tokenizer cannot segment CJK and falls back to an unranked `LIKE`; mobile search has no page-content index at all |
| **Journal** | 5 view modes incl. an infinite stream, a calendar with 4 content-dot types, drag-to-reschedule, `Alt`-key navigation, per-space journal templates, and a configurable date format **that Logseq 2.0 removed** | Logseq has one scrollable view with a hardcoded 3+7 pagination |
| **Task dashboard** | A real agenda: 8 filter dimensions, sort and group controls, DuePanel with source pills, DonePanel, and an `UnfinishedTasks` rollover | Logseq has no agenda view — it has a `:scheduled/future-days` section and two default queries; real agenda UX is a plugin |
| **Recurrence** | 4 interval units incl. yearly, three modes, end conditions, write-time validation, future projection | Logseq's repeaters have no end conditions, no projection — **and its `.+`/`++` implementation contradicts its own documentation** |
| **Backlink filtering** | Server-side boolean expression tree over 23 predicates with keyset pagination | A filter bar |
| **Data integrity** | blake3 hash chain with SQL-enforced append-only, four-step boot recovery, engine-first reprojection, op-level undo with a batch-revert history UI | Timestamps. Both Logseq versions carry active data-loss reports; 2.0's README carries an official warning |
| **Conflict resolution** | Loro CRDT — blocks, text, properties, tags and moves converge with no user-facing conflict | File-level conflicts (OG) or alpha RTC (2.0) |
| **Spaces** | Per-space journal, tabs, recents, accent identity, hotkeys, write-time cross-space link enforcement, and page move/batch-move between spaces | One graph per instance |
| **Editor breadth** | Native Mermaid, KaTeX, 5 callout types, table dimension syntax with a grid picker, 84 slash entries, 7 inline pickers, a two-popover toolbar | Mermaid is a plugin; there is no toolbar at all |
| **ID durability** | ULIDs — sortable, time-encoded; renames propagate everywhere; export externalizes them to readable titles and re-import re-internalizes them | UUID v4, and OG stores link text that breaks on rename |
| **Cost and privacy** | Free, no account, no cloud, no telemetry | RTC is paid and invite-only; E2EE is still being built |
| **Supply chain** | SLSA provenance, Scorecard, CodeQL, blocking dependency audits, a written threat model | Standard OSS CI |

---

## Part 4: Where Logseq Genuinely Wins

| Area | Logseq advantage | Agaric limitation |
| --- | --- | --- |
| **Transclusion** | `{{embed}}` for blocks and pages, editable in place; refs render live content with breadcrumbs, children, and a count badge | **No embeds of any kind.** Refs are 60-character chips; the hover reveal was removed in #4228 |
| **Data modelling (2.0)** | Typed properties with defaults, enum choices, multi-value, display position; tags as classes; `Extends` multiple inheritance; bidirectional properties; per-tag name uniqueness | 6 types, no multi-value, no inheritance reachable from queries, no reverse properties |
| **Query power** | Simple DSL + full Datalog + SCI result transforms + query tables with a column picker + aggregation macros + a rich relative-timestamp input vocabulary | A powerful engine behind a narrower UI, **no user-facing query language**, no transforms, one-hop traversal, single-space |
| **Human-readable storage** | OG: plain `.md`/`.org` — greppable, diffable, git-able. **2.0: Markdown Mirror writes a plain-markdown projection to disk**, so even the DB version restores external access | A single SQLite file plus an opaque Loro blob plus a proprietary CBOR/zstd snapshot format. Export is a projection, and it drops the schema and all history |
| **Exit story** | EDN, JSON, OPML, Roam JSON, HTML, Markdown; 2.0's **Build EDN** exports the entire tag+property schema as portable text | Markdown + assets only. Your prose leaves; your schema, history, trash, saved queries and space configuration do not |
| **Ecosystem** | ~549 plugins + 66 themes, a ~85-method plugin API, a local HTTP API, a CLI, custom.css/custom.js | **Nothing.** No plugin API, no custom CSS, no user scripts, 7 fixed themes |
| **Publishing** | Self-contained HTML SPA (OG) or hosted per-page publishing with password protection (2.0) | Absent |
| **Time tracking** | Built-in, on by default (OG); queryable status-change history (2.0) | Absent |
| **Remote sync** | Works between any two devices on the internet | **LAN only, and first pairing requires working multicast with no fallback** |
| **Backups** | 2.0: automated hourly, last 12 retained | None |
| **Community** | 44.7k stars, 324 contributors, an active forum, years of documented workflows | One maintainer, no users |
| **Research workflow** | PDF highlight-to-block, Zotero (OG), a mature reader | Reader with annotation, BibTeX import, no highlight-to-block |

---

## Part 5: Agaric's Self-Inflicted Problems

New section. These are not gaps against Logseq — they are places where Agaric has paid the cost of
a feature and is not collecting the benefit, or where the project's own documentation is wrong. For
a project whose stated aim is superiority, these are the cheapest wins available.

### Built but unreachable

| Thing | Cost paid | Benefit collected |
| --- | --- | --- |
| **`block_tag_inherited`** | A materialized table, five incremental propagation paths across 7 op types, a background rebuild job, and a documented invariant | **Zero in production.** The read path exists and is exercised only by tests: `src-tauri/agaric-store/src/tag_query/resolve.rs:35,123` branches on `include_inherited`, but `src/lib/tauri/queries.ts:240` coerces it to `false` and the commands default `None` to `false` (`src-tauri/src/commands/tags.rs:549,599`), so no production call ever sets it true. Inherited tags are displayed on a block and nothing else |
| **`listStyle` block-level lists** | A full read pipeline: property → `ListMarkerContext` → `computeListOrdinals` → `ListMarker`, plus a ProseMirror decoration | **Zero.** `setListStyle` and `clearListStyle` have **no production callers**. Slash commands still write a `1.` or `-` markdown prefix, so the app carries two competing list models and pays for both |
| **Advanced query engine depth** | 10 property operators, 4 value types, 7 group keys, property aggregates | Partial. The builder exposes **4 operators, Text only, 5 group keys, column-only aggregates**. The rest is reachable only by hand-editing saved-view JSON |
| **The notification subsystem** | OS plumbing on three platforms, a settings tab, a permission flow | **Zero reminders.** The only production caller is the "send test notification" button |
| **i18next** | ~3,056 translated keys across 13 namespaces, every visible string routed through `t()` | **One locale.** Zero locale files exist and the module docblock forbids adding any |

### Documentation that is actively false

These mislead the next audit — and misled this document's previous revision:

- `docs/features/tags-and-links.md` claims block references *"render the target block's content
  inline, kept live … editing the source rewrites every embed."* They render a 60-character title
  chip. This is the single most misleading line in the docs.
- `docs/features/pickers-and-slash.md` claims `[[` targets "the page **or block** you pick" (the
  picker filters to pages), that `((` "embeds the contents of another block … edit-in-place", and
  that a `/property` slash command exists (it does not).
- Three documents claim a sync pairing fallback that does not exist (#3952).
- `docs/features/journal-and-agenda.md` advertises "no date" and "custom range" agenda presets that
  are not in the option set, and attributes recurrence projection to Agenda mode instead of the Due
  Panel.
- `docs/features/agent-access.md` documents `agaric://settings/agent-access`; the real tab id is
  `agent`, and an unknown tab is silently dropped, so the documented deep link does nothing.
- `src-tauri/src/commands/advanced_query.rs` still says "Structural-only: no full-text, grouping, or
  aggregation" — all three now flow through it. `AdvancedQueryView.tsx` says "Saved views remain an
  explicit follow-up" in a file that imports and renders `SavedViews`.

### Quality signals that do not mean what they appear to

- **Mutation testing cannot fail a build.** Stryker runs diff-scoped with `thresholds.break` unset:
  it is informational. Do not cite it as a gate.
- **Fuzzing and the benchmark SLO gate run weekly**, not per-PR.
- **The 100K-block benchmark measures latency only.** Peak memory at N blocks is explicitly not
  measured, there is no Android performance number, no sync-at-scale test, and no
  multi-thousand-attachment test.
- **`revert_ops` is permanently ~6× over its own budget** (~1.2 s against a 200 ms ceiling for a
  50-op batch) and is gated out of the default run.
- **The main block editor is not virtualized.** Virtualization exists in Trash, History, Agenda,
  backlinks and the emoji picker — not in the surface where a user types.
- **Accessibility depth is uneven**: 597 `toHaveNoViolations` assertions across 284 files under
  `src/` (`grep -rho toHaveNoViolations src | wc -l`, `grep -rl … | wc -l`) is genuinely
  strong, but only **4 of 110** end-to-end specs run axe in a real browser, and there is no
  skip-link anywhere.

---

## Part 6: The Logseq 2.0 Factor

The previous revision treated the DB version as a distant beta that narrowed some of Agaric's
architectural advantages "once it stabilizes". It has since shipped a release, and the framing
needs to change: **2.0 is where Logseq's development happens, and OG is frozen.** A comparison that
benchmarks Agaric against OG is benchmarking against a product that will not change again.

| Component | Status (2026-08-30) | Effect on this comparison |
| --- | --- | --- |
| SQLite storage | Beta, "data loss is possible" per README | Neutralizes Agaric's storage-efficiency argument |
| Typed properties, classes, `Extends` | Beta, and **deeper than Agaric's** | Reverses the previous revision's advantage |
| Views (Table/List/Gallery) | Beta | Exceeds `QueryResultTable` |
| **Markdown Mirror** | Shipped | **Blunts the "binary vs plain text" argument in Logseq's favour** |
| **MCP server** | Shipped | Removes Agaric's exclusivity on agent access |
| CLI with terminal queries | Shipped, bundled | Agaric has no CLI |
| RTC sync | **Alpha**, paid/invite-only, E2EE in development, with a July 2026 net-data-loss incident on iOS | Agaric's CRDT convergence remains architecturally stronger — but unverified in the field |
| iOS app | Invite-only alpha | Agaric has nothing |
| Android app | Not open for alpha | Agaric ships a signed APK |
| Plugin compatibility | **~110 of 615 packages (18%)** | Logseq's ecosystem advantage is real but currently 80% broken on 2.0 |
| Removed in 2.0 | Whiteboards, slides, Excalidraw, built-in Zotero, `((uuid))` syntax, org-mode, `{{query}}` macros, `:journal/page-title-format`, ~30 config keys, SM-5 flashcard data | Several Logseq advantages this document used to cite **no longer exist in the version being developed** |

**Honest read:** Logseq 2.0 is more capable than Agaric on data modelling, queries, ecosystem and
portability, and less trustworthy than Agaric on data integrity and convergence. It is a beta with
an official data-loss warning; Agaric is a pre-1.0 single-user app whose sync has never been
verified two-way end to end. Neither of those is a comfortable position, and they are roughly
symmetric risks — which is not what the previous revision implied.

---

## Part 7: Workflows

**Daily journaling — Agaric.** Five view modes, a content-dot calendar, drag-to-reschedule,
keyboard navigation, per-space templates, and a configurable date format that 2.0 removed. Logseq
gives one scrollable view. The one thing Logseq still does better is that `[[page name]]` is
readable in the raw file; Agaric's `[[ULID]]` is not, though export resolves it.

**Task management / GTD — Agaric, with caveats.** A real agenda dashboard with 8 filter dimensions,
recurrence with end conditions and projection, and an unfinished-task rollover — none of which
Logseq has natively. But: task states are hard-locked (no `WAITING`), there is no time tracking
(Logseq OG has it on by default), **no reminder ever fires**, and every completed recurrence leaves
a block behind.

**Zettelkasten — Logseq, decisively.** This is not close. Block embeds are the mechanism the
workflow runs on, and Agaric has none. Its references are 60-character chips with no inline
content, no children, no in-place editing, no per-block reference count, and no per-block backlinks
surface. `block_links` cannot even distinguish a page link from a block reference. Agaric's better
backlink *filtering* does not compensate for weaker backlink *substance*.

**Meeting notes — comparable.** Both handle it. Logseq's readable links and Agaric's toolbar and
templates roughly cancel out. Agaric's edge: the Templates view and `{{cursor}}` placement. Its
bug: templates drop block properties, so a meeting template with pre-set TODO action items inserts
them as plain text.

**Project management — Agaric for out-of-the-box, Logseq 2.0 for modelling.** Agaric's agenda
aggregates without query-writing. But 2.0's supertags with inherited properties and per-tag table
dashboards are a genuinely better way to model a project schema, and Agaric cannot express
multi-value properties at all.

**Research and reading — Logseq.** Highlight-to-block extraction, Zotero (OG), and embeds are
purpose-built for this. Agaric annotates PDFs and imports BibTeX, which is narrower — and its
annotation save path leaves inline attachment references dangling.

---

## Part 8: Scorecard

Scoring shipped, stable functionality 1-10. Logseq 2.0 is scored on what it does, with its beta
status called out separately rather than deducted twice.

| Category | Logseq OG (frozen) | Logseq 2.0 (beta) | Agaric | Change vs. previous revision |
| --- | :---: | :---: | :---: | --- |
| Block CRUD | 9 | 9 | 9 | −1 (rescale — Logseq also 10→9; relative standing unchanged) |
| Page management | 9 | 9 | 8 | −1 (no per-block backlinks) |
| Editor formatting | 8 | 8 | 8 | −1 (markdown subset, lossy round-trip) |
| Linking system | 10 | 9 | **5** | **−3** (no embeds, thinner refs, no link kinds) |
| Properties | 6 | **10** | 7 | −1 (2.0 overtook it) |
| Tags | 8 | **10** | 6 | −2 (inheritance is dead code) |
| Query system | 9 | 9 | 6 | −1 (UI far narrower than engine; not live) |
| Task management | 7 | 8 | 8 | **−2** (no reminders, locked states, no time tracking) |
| Daily journal | 8 | 7 | **9** | — |
| Search | 5 | 6 | **9** | **+1** (in-page find, filter DSL) |
| Templates | 7 | 8 | 7 | — (block properties dropped) |
| Spaces | 2 | 3 | **9** | −1 (sync is not per-space) |
| AI / agent access | 2 | 8 | 8 | **−1, and Logseq +7** (2.0 ships MCP) |
| Sync / storage | 4 | 5 | **5** | **−4** (two-way unverified, no pairing fallback, no backup) |
| Data integrity | 3 | 4 | **8** | −1 (invisible quarantine, snapshot OOM) |
| Performance | 3 | 7 | 7 | −1 (editor unvirtualized, revert over budget) |
| Import / export | 9 | 8 | 6 | — (more importers, but no structured export) |
| Mobile | 5 | 3 | 5 | −2 (arm64-only, sideload-only, foreground sync) |
| Extensibility / ecosystem | 9 | 6 | **1** | new category |
| Project risk | 4 | 5 | **3** | new category (bus factor 1, pre-1.0) |
| **Total** | **127** | **142** | **134** | previously "Logseq 127 / Agaric 154" |

**Read this total carefully.** Unweighted category sums are a weak instrument — they treat
"Extensibility" and "Data integrity" as equally important, which they are not for a single user.
The honest summary is:

- **On raw capability, Logseq 2.0 is now ahead of Agaric.** That is a change, and it happened
  because 2.0 shipped while Agaric hardened.
- **Weighted for the actual target workflow** — journaling, tasks, project notes, one person, no
  cloud — Agaric still wins clearly: it takes journal (9-7), search (9-6), spaces (9-3), data
  integrity (8-4) and task management (8-8 with a better dashboard), and its losses are
  concentrated in linking, ecosystem and portability.
- **Agaric's remaining wins are narrower than the previous revision claimed**, and two of them
  (AI/MCP, sync) were overstated outright.

---

## Part 9: What Would Actually Make Agaric Superior

Ordered by impact-per-unit-effort for the stated goal. The first tier costs almost nothing and buys
back credibility; the second tier is the real product work.

### Tier 0 — Stop claiming things that are not true (days)

- **1. Fix the false documentation** listed in Part 5. A tags-and-links doc that describes live
  transclusion the app does not have will keep producing wrong roadmaps.
- **2. Either wire up or delete `block_tag_inherited` and `listStyle`.** Both are maintained, tested,
  documented, and unreachable. Wiring inheritance into `FilterPrimitive::Tag` is a small change
  with a real user-visible payoff; deleting is also fine. Carrying them is not.
- **3. Ship the notification scheduler or remove the feature from the UI.** A settings tab that
  suggests reminders exist, when the only code path is a test button, is worse than no tab.

### Tier 1 — Close the credibility gaps (weeks)

- **4. Make sync provable.** Two-way convergence has never been verified end to end (#3507). Until a
  scripted two-device test runs in CI and passes, "sync" cannot be scored as a strength and should
  not be advertised as one. This is the single largest risk in the product: it is the feature most
  likely to lose data and the one with the least field evidence.
- **5. Give pairing a fallback that does not require multicast** (#3952 / #4037). Put the endpoint id
  and address in the QR payload. Today, a guest network or an AP-isolated WiFi makes first pairing
  *impossible*, and three docs claim otherwise.
- **6. Surface quarantined sync slots and op origin.** Silent failure while the UI says "synced" is
  the worst possible failure mode for a local-first app. The History view should also render
  `agent:` origins — the data is already in the op log.
- **7. Ship backup/restore.** Hourly automatic snapshots with retention, restorable from Settings.
  Logseq 2.0 ships this; Agaric, which stores everything in one opaque file, needs it more.
- **8. Fix template block-property loss** and the PDF-annotation dangling reference. Both are small,
  both are data-fidelity bugs.

### Tier 2 — The actual Logseq gap (months)

- **9. Block and page embeds.** This is the one structural feature that keeps Logseq strictly better
  for knowledge work, and it has been the top item on this list through at least three revisions
  without moving. Read-only inline rendering of a referenced subtree would close most of it.
- **10. Give references substance**: restore a full-content hover, add a per-block reference count,
  surface linked references on a *block* (the backend already accepts a block id), and add a
  kind discriminator to `block_links` so refs and links can be told apart.
- **11. A user-facing query language.** `v2:<base64url(JSON)>` cannot be read, diffed, shared or
  version-controlled. A small readable text syntax that compiles to the existing `FilterExpr`
  would unlock the engine's real depth — which the builder currently hides — at a fraction of
  the cost of building more UI.
- **12. Make inline queries live.** Invalidate the `queryExecution` key on materializer events. The
  doc has claimed this for two revisions; the code has never done it.
- **13. Multi-value properties.** The `PRIMARY KEY (block_id, key)` constraint blocks the most common
  Logseq property idiom (`tags:: a, b, c`) and any future class-like modelling.
- **14. A structured export.** JSON or EDN carrying property definitions, history and saved queries.
  Today, leaving Agaric means leaving the schema behind — which undercuts the entire local-first
  ownership argument.

### Tier 3 — Strategic questions the roadmap does not currently ask

- **15. What is the answer to a bus factor of 1?** Logseq's ecosystem advantage is not really 549
  plugins; it is that other people can extend it without the maintainer. Agaric has no plugin
  API, no custom CSS, no scripting. MCP is a genuinely interesting answer — an agent *is* an
  extension mechanism — but only if the surface grows and gains real scoping.
- **16. Is LAN-only still the right constraint?** iroh is already the transport, and relays were
  deliberately disabled. That is a defensible privacy stance, but it means two devices in two
  buildings cannot sync at all, and no amount of CRDT quality compensates.
- **17. Where does the hardening loop end?** The engineering quality here is unusual and worth
  protecting. But 130 open issues with essentially no product work, ~460 consecutive sessions of
  guards and mutation harnesses, and one `feat` commit in the window means the *quality* of a
  feature set that is losing ground on capability. A guard that checks other guards has a
  smaller expected payoff than block embeds.

---

## Part 10: Corrections Log

What this revision changes about the previous one. Grouped by severity.

### Claims that were false

| Previous claim | Reality |
| --- | --- |
| Sync uses "mTLS WebSocket with TOFU cert pinning (ECDSA P-256), plaintext-JSON pairing handshake" | That entire stack was **deleted**. Transport is iroh QUIC/UDP with TLS 1.3 in-handshake and ed25519 endpoint ids. There is no certificate and no cert pinning |
| Notifications include "task/deadline reminders via `notifyTask`" | `notifyTask` has one production caller: the "send test" button. No scheduler, no reminders |
| "Manual IP entry / mDNS fallback — Done" | No first-pairing fallback exists (#3952); three docs wrongly claim one |
| Multi-device sync "Done", sync architecture "Better" | The repo's own docs say full two-way sync end to end **remains unverified** (#3507). A session is one-directional |
| Tag inheritance is a working capability | Materialized and maintained, **read by no query surface** |
| Inline query blocks are "live-updating" | `staleTime: Infinity`, no invalidation. They refetch on mount and on expression change only |
| "Unlimited depth (max 20)" | Self-contradictory. Depth is hard-capped at 20, backend-enforced |
| "No lists (blocks ARE list items)" | Ordered, bullet and task lists all ship as real nodes and markdown grammar |
| Block refs have a "hover tooltip with full content to 300 chars" | Removed in #4228; now a native `title=` carrying the same 60-char string the chip shows |
| Logseq import: "block ref stripping" listed as a feature | It is **data loss** — the code says so |
| iOS blocked by "mDNS issue #522" | #522 is closed and was about manual IP entry. There is no iOS blocker; there is no iOS work |
| MCP is "read-only by default" | Two sockets, read-only **and read-write**, 16 tools; `space_id` is not an isolation boundary |
| Deadline warning configured "in PropertiesView" | Settings → General |
| Recurrence projection appears in Agenda mode | Due Panel |
| Agenda has "collapsible TODO/DOING/DONE sections" | Grouping is user-selectable and defaults to **page**; sort defaults to state |

### Claims that were overstated

| Previous claim | Correction |
| --- | --- |
| Advanced-query builder "offers the filter chips, nested boolean builder, group/sort/aggregate controls" | It offers a strict subset: 4 of 10 property operators, Text values only, 5 of 7 group keys, column-only aggregates |
| Effort tracking "Better" | A fixed 6-option select with no rollup or reporting |
| Encryption "Tie" | Agaric has none at rest; Logseq Sync has age end-to-end. Not a tie |
| Snapshots/compaction "Better" | True, but whole-vault RAM buffering and an ~18 s write-lock hold at 100K blocks are unqualified costs |
| Android "Better" | Nothing measured supports it; arm64-only, API 30+, sideload-only is strictly narrower than Logseq's reach |
| "Cursor pagination everywhere" | The main block editor is not virtualized |
| Spaces include "sync-scope" | A session syncs every space; there is no selective sync |
| "~15,000+ tests: ~3,000 Rust + ~12,000 frontend across ~550 files" | Undercount: **6,284 Rust test functions**, 793 frontend test files, 110 Playwright specs, ~905 test files total |
| "axe a11y tests on 100+ components" | 597 `toHaveNoViolations` assertions across 284 files under `src/` — but only 4 of 110 e2e specs run axe in a browser |
| Previous "Extras" row (Logseq 9 / Agaric 3) | Retired, not rescored. Its contents split between "Extensibility / ecosystem" (new) and rows that already covered them. Those 3 Agaric points are part of the 154→134 arithmetic and do not correspond to any capability loss |

### Claims that were understated

Agaric ships, unmentioned in the previous revision: **in-page find with regex**; the **search filter
DSL**; **Mermaid diagrams**; **boolean properties**; **Obsidian, Evernote, Joplin and BibTeX
importers**; **all-spaces export with attachments and round-trippable block-ref anchors**;
**configurable journal date format**; the **Templates management view**; the `{{ }}` **template
variable grammar** with `{{cursor}}`; **drag-to-reschedule**; the **`UnfinishedTasks` rollover**;
**move/batch-move page between spaces**; **relational query predicates** (`LinksTo`, `LinkedFrom`,
`HasParentMatching`); **structured `v2:` inline query payloads**; and a **dedicated Query view**.

### Stale external numbers, now refreshed

"Logseq 0.10.15 (Dec 2025), 41.9k stars, ~190 MB binaries, 32.9 MB APK, 241 open db-test issues,
65+ DB-compatible plugins" → Logseq OG 1.0.0 (2026-04-15) and Logseq 2.0.1 (2026-07-13); 44,687
stars; 2.0 binaries 135-174 MB with a 37.8 MB APK; 346 open db-test issues; 110 of ~615 marketplace
packages DB-compatible.

---

## Appendix: Method and Sources

**Agaric claims** were verified by seven parallel domain audits against `main` at `12a4cab`
(v0.9.9) on 2026-08-30, each required to cite `file:line` evidence and to flag doc claims it could
not confirm in code. Test and coverage counts were recomputed rather than carried forward; the
counting commands are recorded in the audit notes. One methodological caveat: the working checkout
is a **shallow clone** (76 commits, all dated 2026-08-26 onward), so "what shipped since the last
review" was reconstructed from session logs and in-code issue references rather than from
`git log`.

**Logseq claims** were verified on 2026-08-30 against:

- <https://github.com/logseq/logseq/releases> (2.0.1, 2026-07-13) and the master README
- <https://github.com/logseq/og/releases> (OG 1.0.0, 2026-04-15) and its commit history
- The product-split announcement, 2026-04-24: <https://logseq.io/page/b2ad9ce1-9cb7-4436-8083-54cb4516d324/df4dc09d-0a12-4c87-904e-22a9bf4c350a>
- <https://github.com/logseq/db-test/issues> (346 open)
- <https://github.com/logseq/docs> — `db-version.md`, `db-version-changes.md`, and the file-version
  pages for Queries, Advanced Queries, Properties, Tasks, Templates, Export, Publishing
- Source reads in `logseq/logseq` and `logseq/og` for repeater semantics, the FTS5 tokenizer,
  time-tracking defaults, journal pagination constants and the SCI query sandbox
- <https://github.com/logseq/marketplace> `plugins.json` and `stats.json` (package counts, DB
  support, staleness)
- <https://opencollective.com/logseq>, <https://discuss.logseq.com>, <https://news.ycombinator.com/item?id=48896229>
- Store listings: Apple App Store (0.10.9, 2024-04-23), F-Droid (0.10.15, 2025-12-18)

**Explicitly unverified** and therefore not asserted anywhere above: Logseq's retail RTC/Pro pricing
at GA (only Open Collective backer tiers are documented), any GA date for the DB version, Logseq
team headcount, Google Play listing status, and Agaric's ~24 MB Android APK size (self-reported in
the project README; not reproducible in this audit).
