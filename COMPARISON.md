# Agaric vs Logseq: Feature Comparison

> **Revision 2026-10-21.** Every Agaric row was re-verified against `origin/main` at `15f3f9705`
> (v0.20.0); every Logseq row was re-verified against upstream repositories, release assets, docs
> commits and the marketplace manifest on the same day. The method changed: three audits, one on the
> editor and linking, one on data, sync and project risk, and one on Logseq upstream, each required to
> cite a PR number or `path:symbol`. Claims that could not be verified are labelled **unverified**.
>
> Between revisions, some rows were patched in place (through ~#4806, plus the 2026-10-17 Tables and
> Slash-command edits) while the header still named the old commit. This revision supersedes those
> patches.
>
> **Still deliberately less flattering, now to both sides.** The 2026-08-30 revision corrected an
> overclaiming predecessor (Agaric 154, Logseq 127). This revision corrects the 2026-08-30 revision in
> both directions. That revision overstated Agaric's search edge over Logseq 2.0 and its template
> atomicity. It also described an Agaric that has since shipped embeds, page mode and CI-verified sync.
> See [Part 10](#part-10-corrections-log).
>
> Goal: Agaric is meant to fully replace Logseq for the author's personal workflow. This document
> maps every Logseq capability to what Agaric has, what is missing, and what Agaric claims to have but
> does not.

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

## Part 0: Read This First

### 1. There are two Logseqs

- **Logseq OG**, the file/Markdown version at `github.com/logseq/og`. Its only release is **1.0.0
  (2026-04-15)**, and its last commit was **2026-05-28** (an Electron 41.7.1 bump), about 21 weeks
  before this audit. It has 335 stars, 18 open issues and 13 open PRs. The team's maintenance-mode
  statement ("maintenance and reliability rather than new feature development") appears only in a
  forum post (secondary source), not in the README.
- **Logseq 2.0**, the DB version at `github.com/logseq/logseq`. **2.0.2 was released 2026-10-07**,
  still titled "(Beta Testing)". The README still warns: *"The DB version is in beta status while
  the new mobile app and RTC is in alpha. This means that **data loss is possible**."* No GA date is
  published.

Every row below says *which* Logseq it compares against. OG is frozen. 2.0 is a beta that removed
whiteboards, slides, Excalidraw, built-in Zotero, org-mode, `{{query}}` macros and the journal-title
format. Only ~21% of marketplace packages declare DB support. Whether 2.0 also removed `((uuid))`
syntax is **unverified** (Part 6).

### 2. What changed since 2026-08-30, in both directions

**Agaric** merged about **1,076 PRs** (969 non-bot, all by one human author, plus 107 Dependabot) and
went from **0.9.9 to 0.20.0: 14 releases in 54 days**. It shipped most of what the last revision said
was not moving:

- block and page embeds, the reference peek, link kinds and link labels;
- page mode, the Markdown reveal and Edit as Markdown;
- live inline queries and reachable tag inheritance;
- per-agent MCP tokens;
- attachment convergence in sync, and a two-device sync suite that CI requires.

In the last 475 commits (2026-10-14 to 10-21), `feat` was ~14%, against 1 in 75 in the previous
revision's window. The pace had costs. **0.15.0 aborted on every Android launch**, and priority levels
regressed from configurable to a fixed 1/2/3 (#6017).

**Logseq** made one stable-channel release, **2.0.2**, still beta and mostly fixes. It merged 365 PRs
since 2026-08-30, of which 4 were `feat`. Beyond that release, Logseq shipped three things:

- a native iOS app in TestFlight (2026-10-20);
- an Android APK in the release assets;
- sync opened to all $5/month and $15/month Open Collective backers (docs, 2026-10-21).

A token-authenticated REST API landed on master after 2.0.2. **OG had no commits.**

### 3. This revision corrects the last one, in both directions

The 2026-08-30 revision got several things wrong:

- It credited Agaric with CJK and substring search that Logseq lacks. That holds against OG only:
  2.0 has used a trigram FTS5 index since 2024.
- It called template insertion "atomic", which it never was.
- It miscounted the built-in properties.
- It said 2.0's Android app had not opened even for alpha, while listing a 2.0.1 APK in its own
  binary sizes.
- It listed `((uuid))` as removed with no source.
- In the pessimistic direction, it said unknown editor nodes are dropped silently. They raise a
  toast.

[Part 10](#part-10-corrections-log) lists every correction.

---

## Part 1: Context — Three Animals

**Logseq OG 1.0.0** (frozen, 2026-04-15) is ClojureScript on Electron, with plain `.md`/`.org` files
on disk. It gets security and dependency patches only, and none since 2026-05-28. Its chronic weakness,
performance at scale, will not be fixed, because the fix *was* the DB rewrite. Binaries (2026-08-30
figures): Linux AppImage 187 MB, macOS arm64 dmg 190 MB, Windows exe 221 MB, Android APK 32.9 MB.

**Logseq 2.0.2** (beta, 2026-10-07) is SQLite + DataScript, with typed properties, tags-as-classes
with multiple inheritance, and a real views system. It is more capable than OG in data modelling, and
riskier:

- 274 open issues in `logseq/db-test`;
- RTC sync in alpha per the README;
- iOS in TestFlight only;
- Android as a GitHub-release APK only;
- an official data-loss warning.

Binaries: Linux AppImage 168 MB, macOS arm64 dmg 169 MB (x64 163 MB), Windows NSIS 146 MB, Android APK
42.1 MB.

**Agaric 0.20.0** is Rust + React on Tauri 2, SQLite from the start, and the Loro CRDT engine, with
peer-to-peer sync on one network (plus an opt-in relay). It has a single maintainer, is pre-1.0 and
has no public user base. Its engineering discipline is heavy for a personal project:

- 6,284 Rust test functions, 903 frontend and e2e test files and 8 fuzz targets (2026-08-30 counts,
  not recounted);
- a 100K-block benchmark SLO gate;
- SLSA provenance;
- a required real-backend e2e lane (#5996) that a release must pass before it publishes.

Its product surface is narrower than 2.0's on data modelling and ecosystem. Its riskiest areas are
sync beyond one network and long-horizon durability, since it has no backup.

**Project health, for calibration (2026-10-21):**

| | Logseq OG | Logseq 2.0 | Agaric |
| --- | --- | --- | --- |
| Stars | 335, 63 forks | 45.3k, 2.8k forks | private |
| Activity since 2026-08-30 | 0 commits | 365 merged PRs; 957 commits from 2.0.1 to 2.0.2 | ~1,076 merged PRs (969 non-bot) |
| Releases since 2026-08-30 | 0 | 1 (2.0.2) | 14 (0.10.0 → 0.20.0) |
| Distinct authors | — | 26 contributors from 2.0.1 to 2.0.2, plus AI-agent co-authors | 1 human (all 969 non-bot PRs) |
| Open issues | 18 + 13 PRs | 813 + 181 PRs; 274 in `db-test` | not recounted (130 on 2026-08-30) |
| Funding | $4.1M seed (2022) + Open Collective: est. annual budget $238,198, balance $43,428 | same | none |
| Bus factor | — | ~4 (2026-08-30 estimate; core authors tiensonqin, RCmerci, yuxi-liu-wired, megayu) | **1** |

---

## Part 2: Feature-by-Feature

Where OG and 2.0 differ materially, the Logseq column says so. Agaric evidence is a PR number, a
commit hash, or a repo-rooted `path:symbol`.

### 1. Block Model

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Everything is a block | Yes. 2.0 unifies blocks and pages as "nodes" | Yes. `blocks` table, tree via `parent_id` + `position`. `block_type` is a closed enum: `content \| tag \| page` | Done |
| Block nesting depth | Unlimited in practice | **Capped at 20** (`MAX_BLOCK_DEPTH` in `src-tauri/agaric-store/src/block_descendants.rs`), enforced backend-side; import caps at 19 | Partial |
| Block IDs | UUID v4 (random, unsortable) | ULID (Crockford base32, sortable, time-encoded) | Better |
| Block references | `((uuid))` renders the source block's **content** inline, live; hover shows breadcrumb + children; **reference-count badge** on the source block. 2.0.2: refs to deleted nodes show as broken (#13551) | `((ULID))` renders a chip with the target's **first line, 60 chars**. A **peek** (350 ms dwell or `Alt+↓`) shows full content, a space › page breadcrumb, the ref count, Open and Copy reference (`src/components/BlockRefPeek.tsx`, #4947); unresolved refs are labelled (e385ff0f0). No inline content, no children, no badge on the source, no peek on touch | Partial |
| Block embeds | `{{embed ((uuid))}}`: full subtree, **editable in place**. 2.0: unified `/Node embed`; 2.0.2 applies embed actions to the embed (#13099) | `{{embed ((ULID))}}` via `/embed` or the picker, rendered live (#4572), editable in place behind a per-embed unlock (#4809). Rows show **content only**: no checkbox, priority, date chips, properties or attachments. Depth ≤ 3, 32 rows (`MAX_EMBED_DEPTH`, `EMBED_MOUNT_LIMIT` in `src/lib/embed-token.ts`); arrows do not descend; no structural edits; not unlockable in page mode | Partial |
| Block properties | `key:: value` parsed from content; 2.0: typed property rows | `block_properties` with **7** typed values; `::` name autocomplete; inline chips incl. ref and boolean (#5862); BlockPropertyDrawer | Done |
| Collapse/expand | State persisted **in the block** (`collapsed::`), so it travels between devices | Chevron + `Ctrl+.`, persisted in `localStorage` per page, shared by page mode: **device-local, not synced**. Imported `collapsed::` applies on the importing device only (#5214) | Partial |
| Zoom into block | `Alt+Right`, a real route with a URL | Zoom with breadcrumb, but ephemeral `useState`: **not deep-linkable, not in the back-stack**; page mode has no zoom | Partial |
| Move block up/down | `Alt+Shift+Up/Down` | DnD (depth-projecting, cap-aware, subtree-safe) + `Ctrl+Shift+Up/Down`; gutter drag in page mode (#6015) | Done |
| Block-level multi-select | `Esc` + arrows; 2.0 adds bulk set-property / bulk tag | Ctrl+Click, Shift+Click, Ctrl+A, and a keyboard selection cursor (`Ctrl+Space`, `Ctrl+Arrow`; 44215a97a). Batch actions: **three**: set todo state, cycle priority, delete. No batch indent, move or tag; `CANCELLED` missing from the batch menu | Partial |
| Subtree copy/paste | Yes; 2.0.2 keeps the subtree when copying or moving an ancestor | Indented-Markdown outline grammar; refs preserved; `[[Name]]`/`#tag` internalized on paste (#5153, #5154, #5166); cut/paste in page mode keeps ids and refs (#6019) | Done |
| Cross-block undo | Session-level `Ctrl+Z`, no history UI | Op-level undo/redo, per-page depth + redo stack, HistoryView with batch revert and word-level diff. Caveat: page mode's `Ctrl+Z` does not revert task state, dates, properties or attachments (`docs/features/editor.md`; runtime unverified) | Better |
| Turn into | Slash commands per block type; 2.0.2 adds "Clear heading" | Toolbar menu, block menu, `/turn`, `Ctrl+Shift+L` (#5760; key moved by #6022), page mode (#6027): H1–H3, quote, code, lists, callout | Done |

### 2. Page Model

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Pages as containers | One file per page (OG); node entity (2.0) | `blocks` with `block_type = 'page'`, content = title | Done |
| Page properties | First block holds `key:: value` | `block_properties` on page blocks; PagePropertyTable; front matter in Edit as Markdown (#5220) | Done |
| Page aliases | `alias:: JS, ECMAScript` | `page_aliases` + header badges; alias edits are ops, so undoable and synced (#5563); MCP `set_page_aliases` (#5570) | Done |
| Namespaced pages | `Project/Backend/API`; 2.0 replaces namespaces with tag hierarchy | Tree view in PageBrowser, breadcrumbs, create-under flow (#4734, #4874) | Done |
| Page tags via property | `tags:: book, fiction` → page refs. 2.0: tags are classes | `block_tags` + picker; `tags::` read on import (#5214) and `tags:` in Edit as Markdown front matter (#5220). No in-page `tags::` syntax | Partial |
| Unique names per context | 2.0: page names unique **per tag** (`Apple #Company` vs `Apple #Fruit`); 2.0.2 rejects creating a page tagged `#Tag` (#13221) | Titles unique **per space** (`reject_duplicate_page_title` in `src-tauri/src/commands/blocks/crud.rs`, #4782); tags too (#5281). Command-level only, no DB constraint; pages without a space exempt; duplicates created offline on two devices **unverified** | Partial |
| Auto-created pages from links | Clicking `[[New Page]]` creates it | `[[` picker "Create", typed `[[text]]`; the New page dialog lists similar names (#5645); a broken-link chip is removed on click, `Ctrl+Z` restores (#5863) | Done |
| Move page between contexts | Multi-graph = separate folders | **Move to space** from the kebab and batch-move from the Pages view; closes the page in every tab (#5753) | Better |
| **Edit as Markdown** | OG: the page *is* a Markdown file. 2.0: no editable source; Markdown Mirror is one-way (secondary source) | Page kebab → full-page Markdown source: front matter, `-` bullet per block, per-line ids, `[ ]` tasks, `key::` lines; Edit / Preview / Changes; merge on a stale save (#5159); save report with Undo; draft recovery (#5151, #5157, #5221, #5696, #5793) | Done |

### 3. Editor & Formatting

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Markdown support | Full Markdown (OG) | **Subset**, one CommonMark grammar shared by import, source and paste (#5165, #5168). Ships bold, italic, code, strike, highlight, underline, headings, fences, math, tables, quotes/callouts, ordered/bullet/task lists, images, rules, autolinks. **Missing: setext headings, indented code, reference links, footnotes, definition lists, inline/block HTML (only `<u>`), sub/superscript** | Partial |
| Markdown round-trip | Files are the source of truth | **Normalizing, not preserving** (#5148, #5161, #5164). `hardBreak` in a table cell → space; adjacent quotes merge; CRLF → LF; underline as `<u>`. Unknown nodes are dropped **with a once-per-session toast** (`src/editor/markdown-serialize-toast.ts`; page-mode wiring unverified) | Partial |
| Org-mode | Full `.org` (OG only; 2.0 dropped it) | Not an editing format; import reads Org TODO, `[#A]`, SCHEDULED/DEADLINE (#5174) | Design choice |
| Bold / italic / strike / highlight / code | `**` `*` `~~` `^^text^^` `` ` `` | `**` `*` `~~` `==` `` ` ``, each with a shortcut; CommonMark flanking rules (#5208, #5210); inline code `Ctrl+Shift+K` (#6022) | Done |
| Underline | No dedicated mark | Underline mark, `Ctrl+U` | Better |
| Headings | `# H1`–`###### H6`; 2.0.2 "Clear heading" slash | `/h1`–`/h6`, `Ctrl+Alt+1..6`; Turn into offers H1–H3 only | Done |
| Code blocks | Fenced, syntax-highlighted | Fenced with lowlight, language popover (block mode; page mode unverified) | Done |
| Math / LaTeX | `$$…$$` native; 2.0.2 math-block save fix (#13672); a forum report of LaTeX breaking in 2.0.2 is unverified | `$…$` inline + `$$…$$` block, KaTeX lazy-loaded, raw-source node view (#5642, #5704) | Done |
| **Mermaid diagrams** | **Plugin only** | ```` ```mermaid ```` fences render inline in editor and renderer, raw-source toggle, lazy-loaded (#5642, #5690) | **Better** |
| Tables | Markdown tables | Pipe tables; `/table` opens a size grid (#5774). Row/column ops live only in the block-mode toolbar, none in page mode | Better |
| Callouts | Plugin/CSS convention | 5 built-in types, `> [!TYPE]` shape, type chosen from the block menu (#5694) | Better |
| Lists | Outline bullets are the list | Real ordered/bullet/task list nodes, plus `listStyle` bullet and numbered *blocks* with Enter/Backspace continuation (#4552, #4807) in both modes (#5825) | Done |
| Slash commands | ~20+; 2.0.2: `/code`, `/calc`, `/quote` on a non-empty block insert a new block (#13736) | Base commands plus sub-options surfaced as you type, recents band; includes `/embed`, `/voice`, `/turn`. Page mode runs the same handlers (#5866) except `/duplicate` and `/template` | Better |
| Inline pickers | `[[`, `((`, `/`, `#` | **Eight**: `[[`, `@`, `#` (#5205), `((`, `/`, `::`, `:` (emoji), `{{` (query) | Better |
| Formatting toolbar | None (keyboard only) | Standing bar with Format and Turn-into popovers, link/ref/tag/query/emoji/table/priority/date/todo/property controls, undo/redo, width-aware overflow, plus a selection bubble. **Block mode only**: page mode has the bubble, slash and block menu | Better |
| Property value autocomplete | Suggests previously-used values | **Only in the search DSL's `prop:key=value`.** The `::` picker completes keys only | Partial |
| **Page mode** | Block-at-a-time editing in both versions (2.0.2 still a per-block textarea, #13211) | One WYSIWYG document per page, saved per block, ids kept (#5721; follow-ups #5805 to #6030 add tasks, dates, properties, lists, attachments, slash, queries, embeds, block menu, gutter, paste, Turn into, undo grouping). `Ctrl+E` or Settings › Editor. **Fenced:** off by default (`EDIT_MODE_PREFERENCE` in `src/lib/preferences.ts`); desktop only; pages over `PAGE_MODE_BLOCK_CAP` (500) and journal views stay in blocks; no toolbar, zoom, `/template`, `/duplicate`, table ops or embed unlock; markers commit when the caret leaves a block | Done (opt-in) |
| **Markdown reveal** | The block being edited *is* raw source (textarea) | WYSIWYG that shows the syntax around the caret for bold, italic, code, strike, highlight, heading `#`, external links and chips; not for lists, quotes, fences, math, tables or underline (`src/editor/extensions/markdown-reveal.ts`; #5699, #5750, #5988, #6020, #6024). On by default | Done |
| **Markdown paste** | Not re-verified this revision | Multi-line Markdown splices into blocks; HTML goes through the same tree; `Ctrl+Shift+V` pastes plain; a toast offers Undo and "Paste as text" (`src/components/block-tree/paste-into-block.ts`, `src/editor/html-to-blocks.ts`; #5154, #5166, #6019) | Done |
| Typed tags and task markers | `#tag`, `TODO` typed in text are native | `#name` becomes a tag on a boundary or save (#5205, #5215, #5777); `[ ]`, `[/]`, `[x]`, `[-]` become task states (`src/editor/extensions/task-paragraph.ts`) | Done |
| **Obsidian-style chords** | Own keymap (`g n` / `g p`, `Alt+Right` zoom), configurable | `Ctrl+E` page mode, `Ctrl+1..9` tabs, `Ctrl+Shift+T` reopen tab, `Ctrl+O` quick switcher, `Ctrl+P` palette, `Ctrl+Alt+←/→` back/forward, `Alt+1..9` spaces (#6022, `src/lib/keyboard-config/catalog.ts`); all rebindable | Done |
| Images and media | Images; 2.0.2 resizable video embeds, JPEG XL | Resize handle (#5343), collapsible (#4859), voice notes (#5484, #5833) | Done |

### 4. Linking System

Still Agaric's weakest domain, but no longer a list of absences: embeds, link kinds, the peek and
link labels all shipped after 2026-08-30.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Page links | `[[page name]]`, human-readable in the raw file; 2.0.2 rename updates link mirrors | `[[ULID]]` chips, title resolved at render. Robust to renames; **opaque in raw text**. Picker searches **pages only**. An unresolvable target still reads `[[01HZAB12...]]`, now as a removable chip (#5863) | Partial |
| Block references | Live inline content + count badge + hover breadcrumb/children | Chip + peek (see §1). The peek shows full content, but nothing renders inline, and there are no children and no in-place editing | Partial |
| Hover preview | Breadcrumb + children on hover | The peek: pointer only, mounted in page and journal views (`src/hooks/useBlockRefPeek.ts`) | Done |
| Block embeds | `{{embed ((uuid))}}`, editable in place | Content-only rows, editable behind an unlock (see §1) | Partial |
| Page embeds | `{{embed [[page]]}}` | `{{embed [[ULID]]}}` renders the page's top-level blocks, with the block-embed limits (`src/lib/embed-token.ts`, #4572) | Partial |
| Custom link labels | `[label](((uuid)))` and `[text]([[page]])` | `[[Page\|label]]`, stored as `[[ULID\|label]]` (#5175); `[[Page#Heading]]` links the heading block (#5178). Logseq's `[label](((uuid)))` form is not parsed | Partial |
| Reference counter | Per-block count badge on the source block | Page totals in the Linked References header, per-day badges in journal views, and a count in the peek. **No badge on a referenced block** | Partial |
| Linked references | Grouped by page, filter bar; 2.0.2 shows them on tag pages (#13440) | Grouped by source page, paginated, server-side filters, with an All / Page links / Block refs toggle (#4943). On a **block** only while it is zoomed (`src/components/backlinks/LinkedReferences.tsx`, #4945) | Partial |
| Unlinked references | Plain-text mentions; 2.0.2 matches aliases (#13706) | "Link it" conversion, grouped, paginated. Pages only (`src/components/pages/PageEditor.tsx`); absent from journal days | Partial |
| Link kinds distinguishable | Refs and links are distinct entities | `block_links` carries a kind (`src-tauri/migrations/0119_block_links_kind.sql`, #4943); a block embed counts as a block ref, a page embed as a page link | Done |
| Backlink filtering | Simple filter bar | Server-side `FilterExpr` tree with And/Or/Not and keyset pagination; Created date and source-page include (#5595), sort picker (#5702) | Better |
| Graph view | Local + global; 2.0 ships Graph View V2 | Global force-directed graph plus local graph (#5459), select-and-walk (#5537), labels (#5540), restored layout (#5514). The edge set is capped (`PAGE_LINKS_EDGE_CAP`) | Done |
| Link fidelity on export | Files already contain the names; 2.0.2 exports a ref to a missing block as `((uuid))` (#13717) | Export rewrites `[[ULID]]`→`[[Title]]`, `#[ULID]`→`#name`, `((ULID))`→`[[Page#^ULID]]`, labels to `[[Title\|label]]`. The docs say anchors re-import as block refs (runtime unverified) | Better |

### 5. Properties

Logseq 2.0 turned this into its strongest domain. Agaric is behind, not ahead.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Typed values | OG: untyped text. **2.0: typed** Text, Number, Date, DateTime, Checkbox, Url, Node, and the `:schema :type` registry lists more (e.g. `:page`), with correct numeric sort; 2.0.2 adds Number defaults (#13724) | **7 types**: text, number, date, select, ref, boolean, **url** (`src-tauri/migrations/0120_property_definitions_allow_url.sql`, #5142) | Done |
| Schema registry | 2.0: properties are pages with their own config | `property_definitions` (STRICT), CRUD; a declaration is refused if stored values would violate it. The built-ins are code constants (`BUILTIN_PROPERTY_DEFS` in `src-tauri/agaric-store/src/op.rs`) and editing one is refused (`BuiltinPropertyLocked`, #6017). No key rename, retype or usage count (#5841) | Done |
| Multi-value | OG: opt-in comma splitting. **2.0: first-class multi-value on most types** | **Absent.** `PRIMARY KEY (block_id, key)` makes it structurally impossible | Gap |
| Default values / choices | 2.0: default value, enum choices with icons + ordering, per-tag scoping, checkbox-state mapping | `select` options only; `todo_state` and `priority` options now frozen (#6017) | Partial |
| Property display control | 2.0: UI position, hide-by-default, hide-empty | Fixed layout: inline chips (ref and boolean chips, #5862) + drawer | Gap |
| Constrained references | 2.0: a Node property can be constrained to nodes carrying a given tag | `ref` type accepts any page | Partial |
| Bidirectional properties | 2.0: reverse lists surface on the target automatically | **Absent** | Gap |
| Built-in properties | ~15 editable + ~8 hidden | **14 code-defined built-ins**: `todo_state`, `priority`, `due_date`, `scheduled_date`, `created_at`, `completed_at`, five `repeat*` keys, `space`, `is_space`, `listStyle` (migration 0128). `status`, `url`, `effort`, `assignee`, `location` remain seeded, editable definitions; `due` was dropped | Done |
| Property-based queries | Simple `(property k v)` + full Datalog | 10 operators across number, date, text and ref values in the query builder (#4569, `src/components/PageBrowser/add-filter/vocab.ts`); the Pages browser filter still offers 4; boolean is existence-only | Done |

### 6. Tags

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Inline tag syntax | `#tag` / `#[[multi word]]`: tags are pages | `#[ULID]` chip with resolved name; typed `#name` becomes a tag on blur or save (#5777) | Done |
| Tags as pages | Yes. **2.0: tags are classes/supertags**: properties on a tag are inherited by tagged nodes; 2.0.2: tags extending Card are flashcards (#13540) | Tags and pages are separate `block_type`s. The read-only tag page lists tagged pages and blocks (#5695); tag colours are device-local, not synced (#5784) | Design choice |
| Tag hierarchy | OG: `/` naming. **2.0: `Extends`, with multiple inheritance and a tag tree** | Prefix convention (`work/meeting`) matched with `LIKE` | Partial |
| Boolean tag queries | Via query DSL | `TagExpr` with Tag/Prefix/And/Or/Not, depth-gated, compiled to one pushed-down id-set subquery | Better |
| Tag inheritance in queries | 2.0: inherited class properties are queryable | Reachable from the Tags view's "include inherited" toggle (off by default; `src/components/filters/TagFilterPanel.tsx`, #4925), the `under:#tag` search token behind the tag page's "Search everything under #tag" (#5797), and MCP `search`. **Not** in `FilterPrimitive`, inline `{{query}}`, agenda filters or Advanced Query. Cache vs SQL agreement audited (#5671) | Partial |
| Tag usage counts | Shown in UIs | `tags_cache.usage_count` | Done |

### 7. Query System

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Simple queries | OG: `{{query (and [[page]] (task TODO))}}`, filters `and/or/not`, page ref, free text, `between`, `property`, `task`, `priority`, `page`, `namespace`, `page-property`, `page-tags`, `all-page-tags`, `sample`, `sort-by`. **2.0 replaces `{{query}}` with `/Query` nodes** and drops `all-page-tags` and `sort-by`; 2.0.2 isolates query errors (#13767) | `{{query …}}` blocks plus a **structured `v2:<base64url(JSON)>` payload** carrying an arbitrary `FilterExpr`; legacy text queries reroute onto the rich engine when translatable; the `backlinks` query type lists results again (#5815) | Done |
| Filter vocabulary | See above | **23 primitives** (`FilterPrimitive` in `src-tauri/agaric-store/src/filters/primitive.rs`): Tag, TagOrRef, ChildOf, PathGlob, HasProperty, LastEdited, Space, Priority, State, BlockType, DueDate, Scheduled, Created, **LinksTo, LinkedFrom, HasParentMatching**, Orphan, Stub, HasNoInboundLinks, Regex, CaseSensitive, WholeWord, Snippet | Better |
| Graph traversal | Full Datalog: arbitrary joins, variable-length paths, rules | **One hop plus ancestors.** `LinksTo`/`LinkedFrom` take a concrete id; `HasParentMatching` recurses (depth ≤ 50). No transitive closure, joins or rules | Partial |
| Result transforms | `:result-transform` and `:view` evaluated by SCI (sandboxed Clojure) | **Absent.** Five fixed folds (count/sum/avg/min/max) | Gap |
| Grouping | 2.0: group-by in the Views system | All 7 group keys reachable in the builder (#4804, `src/components/AdvancedQuery/QueryControlsBar.tsx`); groups show a bounded preview with no expand | Done |
| Aggregation | `{{function (sum :qty)}}` + arbitrary SCI functions | count/sum/avg/min/max, global + per-group; the target can be a property (#4804) | Partial |
| Sorting | `sort-by`, table-header sort; 2.0.2 sorts missing values last (#13485) | Multi-key over a closed column set + bm25 relevance | Done |
| Query result table | `query-table:: true` + column picker; 2.0: Table/List/Gallery views with pinned, resizable columns and inline editing | Columns auto-derived from properties on the loaded page; **no column picker** | Partial |
| Live-updating results | Yes (DataScript reactivity) | Inline queries refetch on property and graph-structure events, including ones arriving by sync (`src/hooks/useQueryExecution.ts`, #5316) | Done |
| Saved queries | Query nodes live in the graph | Saved views were invisible after a space migration until #5828; they are now per-space `localStorage`, **not synced**, and old views stay invisible | Partial |
| User-facing query language | Text you can read, diff, paste, version | **None.** `v2:<base64url(JSON)>` only; a text language was explicitly dropped in #4804 | Gap |
| Cross-space queries | Multi-graph search is manual | **Impossible.** `space_id` is mandatory, including MCP `query` | Gap |

### 8. Task Management

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Task markers | OG: `LATER/NOW/DONE` or `TODO/DOING/DONE` + `CANCELED`, `WAIT/WAITING`, configurable. **2.0: one customizable, user-extensible set** | `none → TODO → DOING → DONE → CANCELLED → none`, locked in `src/lib/task-states.ts`, and since #6017 `todo_state` is a locked built-in. No WAITING | Partial |
| Priority levels | `[#A] [#B] [#C]`, fixed | **Fixed 1/2/3** (`PRIORITY_LEVELS` in `src/lib/priority-levels.ts`). #6017 removed the configurable levels; out-of-range legacy values get a neutral badge. Click-to-cycle, slash, `Ctrl+Shift+1/2/3`. On par with Logseq, **a regression from Better** | Done |
| Due / scheduled dates | Org-style `DEADLINE:` / `SCHEDULED:` lines | `due_date` / `scheduled_date` columns, slash commands, date pickers | Done |
| Recurrence | Repeaters `+` / `.+` / `++`, `Nd/Nw/Nm`. OG's `.+` advances from the *original* timestamp, contradicting its docs. 2.0.2: repeats advance in the local calendar, monthly without drift (#13615) | Modes `+` / `.+` / `++`; daily/weekly/monthly/**yearly**, `+Nd/+Nw/+Nm/+Ny`; end conditions; write-time validation; MCP `set_property` on `todo_state` recurs like the app (#5919, #5957). Completing creates a **new sibling**, so a daily habit accumulates one block per occurrence | Better |
| Recurrence projection | None | Projected occurrences in the Due Panel **and** the Agenda's Projected list (b5ac3a590) | Better |
| Task dashboard | OG: a "Scheduled tasks and deadlines" section + two default queries; no real agenda. 2.0: tag pages carry a Table view | Agenda with 8 filter dimensions, sort, group, cursor pagination; DonePanel; DuePanel; `UnfinishedTasks` rollover | Better |
| Time tracking | **OG: built-in, on by default** (`:LOGBOOK:` clocks). **2.0: status-change history with time spent** (display fix #13695) | **Absent** | Gap |
| Effort tracking | Arbitrary custom properties | `/effort`, a fixed 6-option select; `effort` is now a removable, non-built-in definition | Done |
| Overdue accumulation | Via embedded queries | DuePanel overdue section + the `UnfinishedTasks` rollover | Better |
| Deadline warning period | `:scheduled/future-days` | Configurable 0–90 days in **Settings → Tasks & reminders** (#5635) | Done |
| Task / deadline notifications | Plugins only | **Desktop, while running** (#4806, `src-tauri/src/reminders.rs`): one notification per open task on its `due_date`. Nothing with the app closed, on Android, for `scheduled_date`, ahead of time or as catch-up; #5839 fixed the job running every other tick | Partial |
| Calendar integration | Plugins only | **Absent, deliberately reverted** (migration 0091). No CalDAV, no ICS | Gap |

### 9. Daily Journal

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Auto-created daily page | On launch; 2.0.2 keeps date-only `createJournalPage` on that day (#13597) | On launch with template applied; pages created in Stream or by the date picker reach Day mode (db7452269) | Done |
| View modes | One scrollable view; 3 journals, +7 per scroll, not configurable | **5 modes**: Daily, Weekly, Monthly, Agenda, Stream; the week view copies, cuts and pastes a selection across days (2a6d1adbc) | Better |
| Date navigation | `g n` / `g p`, date picker | Prev/next per mode, `Alt+Left/Right`, `Alt+T`, calendar with 4 content-dot types, a global date-jump header | Better |
| Drag-to-reschedule | No | Drop zones on weekly day sections, with a keyboard equivalent | Better |
| Configurable date format | **OG: `:journal/page-title-format`. 2.0 REMOVED the knob** | A 5-value allowlist in Settings → Appearance; display-only, stored identity stays ISO | Partial |
| Natural language dates | In date pickers | `today`, `tomorrow`, `next <weekday>`, `in N days`, `end of month`, `+Nd`, ISO and more (`src/lib/parse-date.ts`). Missing: `last <weekday>`, `this week`, `next month`, `+Ny` | Partial |
| Journal templates | `:default-templates {:journals …}`. 2.0: apply-template-to-tag | Template pages applied wherever a day is created (app, MCP, Quick Capture) in the caller's transaction, so one undo reverts both, with properties carried (#5373, #5395). The per-space override was retired (#5405) | Better |
| "On this day" | Possible via Datalog | **Absent** | Gap |

### 10. Search

Agaric's strongest domain. Its index advantage now holds against OG only.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Full-text search | **OG**: FTS5 with the default `unicode61` tokenizer on desktop, `LIKE` fallback; browser uses Fuse.js. **2.0**: FTS5 with `tokenize="trigram"` in the DB worker since 2024-07-20, `LIKE` for ≤ 2-char queries; 2.0.2 reindex and Unicode fixes (#13475, #13761) | FTS5 trigram, bm25, keyset pagination, same engine on every platform | Better vs OG; tie vs 2.0 |
| CJK / substring search | **OG: broken**: `unicode61` cannot segment CJK. **2.0: same engine class as Agaric**; CJK behaviour not tested | Substring and CJK via trigram; 1–2 character queries show an advisory banner | Better vs OG; tie vs 2.0 (untested) |
| Semantic search | **2.0**: hybrid vector + keyword (#12710), opt-in, macOS ARM64 only, off by default | **Absent** | Gap |
| Search filter language | Combine `Ctrl+K` with filters informally | **Inline DSL**: 12 prefixes (`tag:`, `under:`, `path:`, `not-path:`, `state:`, `not-state:`, `priority:`, `not-priority:`, `due:`, `scheduled:`, `prop:`, `not-prop:`) plus bare `#tag` (`src/lib/search-query/register.ts`), with validation, chips, autocomplete, helper popover. Conjunction-only (unverified: `docs/features/views.md` lists AND/OR/NOT) | Better |
| Search scope | Pages + blocks, filterable | Space scope, page-name GLOB include/exclude, block-type filter, partitioned palette endpoint: **19** filter fields (`SearchFilter` in `src-tauri/agaric-store/src/search_types.rs`); result counts say what they count (#5810) | Better |
| **In-page find (`Ctrl+F`)** | **None** | Case, whole-word and **regex** toggles, live counter, cycling, Unicode-correct folding | **Better** |
| Long-block indexing | **OG**: blocks over `:block/content-max-length` (10000) become unsearchable. 2.0: unverified | Per-block FTS cap with explicit handling | Better vs OG |
| Recent pages | In search results | Per-space "Recent" list on an empty query | Done |

### 11. Spaces (Workspaces)

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Multiple contexts | One graph per instance; 2.0 adds tabs and windows | `space` blocks partition one DB; every command takes one space (#5538, #5546) | Better |
| Per-space journal / tabs / recents | N/A | Journal keyed `(date, space)`; `tabsBySpace` + `recentPagesBySpace` | Better |
| Per-space identity | N/A | Accent colour, top stripe, sidebar badge, window-title prefix | Better |
| Quick switching | Graph switcher | `Alt+1` … `Alt+9`, rebindable (#6022) | Better |
| Cross-space links | N/A | Enforced at write time; broken-link chip, click removes, `Ctrl+Z` restores | Better |
| Manage UI | N/A | Settings › Spaces: create, rename, accent, "Open on launch" (#5362), safety-checked delete | Better |
| **Per-space sync scope** | N/A | **Not a thing.** A session syncs every space; no selective sync | Gap |

### 12. AI / Agent Integration

Both sides moved. Agaric's MCP became per-agent and grew to 36 tools. Logseq 2.0's MCP became
reachable from the browser, and a token-scoped REST API landed on master after 2.0.2.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| MCP server | **2.0** (desktop Settings → AI, or the CLI): `pretend` dry-run, undo/redo integration; 2.0.2: `/mcp` usable from browser MCP clients (#13312), CLI password login (#13270) | `agaric-mcp` sidecar over one Unix socket / named pipe, owner-only, never TCP, off by default. Each client is an **agent** with a name, mode (RO/RW), space allow-list and token (#5759, `src-tauri/migrations/0125_mcp_agents.sql`); Settings lists, creates and revokes agents (#5710). Tokens sit plaintext in a device-local table | Tie |
| Tool surface | Search/create/list; 2.0.2 `upsert block --blocks` takes Markdown (#13377). The docs' "editing pages, tags and properties TODO" dates from 2026-04-28; current state unverified | **18 read-only + 18 read-write** (RW serves the RO set): adds page/block history, journal, trash, `resolve`, `query` (#5542), `append_markdown` and `edit_page_markdown` (#5462, #5554), `move_blocks`, `batch`, `undo`, `set_page_aliases` (#5570), `move_page_to_space`; links by name (#5539) | Better |
| Auditability | Undo/redo integration | Every op stamped `agent:<name>`; a 100-entry **in-memory** activity log (`src-tauri/src/mcp/activity.rs`); **the History view does not distinguish agent ops** (`docs/features/views.md`) | Partial |
| Isolation | Graph-scoped; master-only PATs carry read/write scopes, expiry, revocation (#13019) | Per-agent token, mode and space allow-list, but **"not isolation"** per `docs/features/agent-access.md`: links, history and refusal messages cross spaces; no rate limiting | Partial |
| Programmable API | Plugin API (`@logseq/libs` 0.3.4) and a local HTTP server (port and method count unverified); RTC semantic REST API with graph-scoped tokens merged 2026-10-10 (#13019), E2EE graphs 10-11 (#13671): **after 2.0.2, in no release** | MCP only | Gap |
| In-app AI features | GPT plugins; 2.0 semantic search (§10) | **None**; voice notes record only (#5833) | Gap |

### 13. Sync & Storage

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Transport | OG: files + third-party sync. 2.0: RTC to a server | **iroh QUIC over UDP** (iroh 1.3.0, pinned `=1.3.0` in `src-tauri/agaric-sync/Cargo.toml`), TLS 1.3 in the handshake, ALPN `agaric/sync/0` (`SYNC_ALPN` in `src-tauri/agaric-sync/src/transport/service.rs`) | Done |
| Cost / account / server | **2.0**: open to all Open Collective Backers ($5/month) and Sponsors ($15/month); self-hostable only by running the sync server (docs, 2026-10-21). OG: none built in | **Free, no account, no server.** Two devices pair and sync directly | Better |
| Peer identity | Account-based | ed25519 endpoint id, TOFU-bound into `peer_refs.endpoint_id`; key stored as raw bytes at `0600`, **not in an OS keychain** | Done |
| Discovery | Server | **mDNS only** (`_agaricv1._udp.local.`, plus an Android `MulticastLock`). Devices on different networks cannot find each other | Done (one network) |
| Pairing | Account login | 4-word passphrase or QR, proven inside the first `HeadExchange`; 5-minute window; fixes #5573, #5612, #5673, #5718 | Done |
| Pairing fallback | N/A | The QR (v2, #4702) carries the responder's dial address and device id, so a first pair needs no multicast; passphrase-only pairing still does | Done |
| Remote / internet sync | 2.0 RTC syncs over the internet; the README still calls RTC **alpha** | LAN by default. An **opt-in relay** (#5135, `internet_relay_url` in `src-tauri/agaric-sync/src/transport/endpoint.rs`) carries traffic between peers that have **already discovered each other**; it does not discover | Design choice |
| Conflict resolution | OG: file-level (fragile). 2.0 RTC: alpha; 2.0.2 keeps property-value replacements together. The July 2026 iOS data-loss incident was not re-verified | **Loro CRDT** per space: `LoroTree`, `LoroText`, `LoroMap`; SQL tree columns are derived. Move/replay ordering fixed (#5711, #5720); purges wait until every space lands (#5712) | Better |
| **What does not converge** | — | **Attachments now converge**: in the engine, hashed and byte-verified (#5608, #5728). Before 2026-10-17 no attachment ever reached a peer. Still true: the **op log is audit-only across peers**, and the **quarantine is invisible**: `list_quarantined_slots` has no IPC or frontend caller, so the UI still says "synced" | Partial |
| Sync direction | Bidirectional | **A session is a pull** (responder → initiator, `docs/architecture/sync-protocol-spec.md`); two-way needs two sessions, which the scheduler runs | Partial |
| **Multi-device, verified** | Widely used (and widely complained about) | **CI-verified two-way**: `e2e-tauri/sync-two-device.e2e.ts` against a headless peer (`e2e-tauri/sync-peer.ts`) pairs, edits each way, sets a property, moves, makes concurrent edits to one block, sends an image each way, cancels and unpairs; required on `main` via `e2e-tauri-gate` (#5996). **In daily use between Android and Linux, both directions** (maintainer report, 2026-10-21). Unproven: devices on different networks, a restrictive network; there is no iOS | Done (one network) |
| Sync controls | — | **Cancel** at dial or mid-session (#6026); per-peer **progress** in messages, files and bytes (#5997); a named engine-version mismatch (#5728) | Done |
| Op log / history | Timestamps only | Append-only blake3 hash chain, SQL-trigger-enforced, per-device sequences, paginated history; the legacy CBOR path that wiped it is deleted (#4693) | Better |
| Snapshots / compaction | 2.0: **hourly automated backups, last 12 retained** | The whole-vault zstd-CBOR blob is gone (#4693, #4727); catch-up is a per-space Loro merge with bounded payloads (#5838); compaction = purge + watermark. Residual: the disaster-path op-log replay buffers the whole log; peak RAM unmeasured | Done |
| **Backup / restore** | 2.0: automated hourly | **None.** The only exit is a lossy Markdown ZIP | Gap |
| Crash recovery | Filesystem journaling | Four-step boot recovery plus engine-first reprojection; an integrity check in Settings › App health (#5360, #5361); engine vs SQL audits (#5671) | Better |
| Encryption at rest | OG's Logseq Sync: age end-to-end. 2.0: encryption password (Settings › Encryption); E2EE key wrapping merged (#13671), deployment unconfirmed | **None.** Database, attachments and the ed25519 key sit behind filesystem permissions | Logseq |
| Supply-chain assurance | Standard CI | SLSA provenance, Scorecard, CodeQL, blocking `cargo-deny`/`cargo-audit`, threat model; a release publishes only after the real-backend lane passes (fda49ef52). **No desktop code signing** | Better |

### 14. Templates

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Template creation | Block/page with `template:: name` | `template=true` pages, "Save as template", a Templates view | Better |
| Template insertion | `/Template` picker | `/template` picker: one `createBlocksBatch` per depth level, so an error leaves earlier levels in place (`insertTemplateBlocks` in `src/lib/template-utils.ts`). **Not atomic.** Absent in page mode | Done |
| Dynamic variables | `<% today %>`, `<% time %>`, `<% current page %>` | Two grammars: legacy (`today`, `time`, `date±N`, `weekday`, … with `:FORMAT`) and `{{date}}`, `{{time}}`, `{{title}}`, `{{cursor}}`; journal weekday/month names English-only (`src-tauri/src/commands/journal.rs`) | Better |
| Default journal template | `:default-templates` | `journal-template=true` pages, applied in the caller's transaction (#5395) | Better |
| Template including parent | `template-including-parent:: true` | **Absent** | Gap |
| **Block properties in templates** | Carried through; 2.0.2 tag-template fixes | **Journal templates carry them** (`copy_page_blocks_in_tx` in `src-tauri/src/commands/pages/markdown.rs`, #5395); **`/template` still drops them** (`properties: {}`) | Partial |

### 15. Import / Export

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Import formats | OG: Roam JSON, OPML, Markdown. 2.0: SQLite, File-to-DB, EDN | Markdown (file / files / folder), Obsidian vault, `.enex`, `.jex`, BibTeX / CSL-JSON (`src/components/settings/ImportSection.tsx`) | Better |
| Import from Logseq | N/A; 2.0.2 improves File-to-DB fidelity | Bullets → tree, `key::` properties, front matter, `[[Page]]`/`#tag` → real refs; reads `id::`, `collapsed::`, `heading::` (#5214), Org markers (#5174); folder imports link notes and skip non-Markdown (#5773) | Partial |
| **What Logseq import drops** | — | Import is per file: a `((uuid))` to a block in the **same** file resolves via `id::`; one to another file is stripped with a warning (`parse_logseq_markdown` in `src-tauri/agaric-engine/src/import.rs`). `journals/` is not treated as journal dates; blocks past depth 19 dropped; `config.edn`, `{{query}}`, `{{embed}}`, whiteboards dropped | Gap |
| Import merge | N/A | **No merge**: importing one corpus on two synced devices duplicates pages | Gap |
| Import from Roam | Native JSON | **Absent** | Gap |
| Markdown export | Full graph | **"Export All"** (space) and **"Export all spaces"** ZIPs with `assets/` and `export-report.txt` (`src/lib/export-graph.ts`). Per-page `Ctrl+Shift+E` **copies to the clipboard**, with attachments as filename stand-ins, not a file | Better |
| **What export drops** | Files are the format | History, trash, **property definitions**, saved queries, tag colours, space settings, keyboard map, sync state; built client-side with JSZip, so a large vault sits in memory | Partial |
| JSON / EDN / OPML export | OG: EDN, JSON, OPML, Roam JSON, HTML, Markdown. 2.0: SQLite, SQLite+assets zip, **Build EDN** (block, page or full schema) | **None** | Gap |
| HTML publishing | OG: read-only SPA. **2.0: Logseq Publish** (paid, password-protectable, self-hostable); 2.0.2 excludes private pages (#13691) | **Absent** | Gap |

### 16. Mobile & Platforms

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Desktop | Linux, Windows, macOS | Linux (deb/rpm/AppImage), Windows (MSI), macOS (x86_64 + aarch64 dmg) | Done |
| Android | F-Droid serves the **file version** 0.10.15 (2025-12-18); Google Play inconclusive. **2.0.2 ships `Logseq-android-2.0.2.apk` (42.1 MB) as a GitHub release asset**, on no store; native or WebView unverified; a native Android app is "in development" | Signed APK, **arm64-v8a, API 30+, sideload-only**. **0.15.0 aborted on every launch** (`ndk-context` double init after a tao bump), fixed; a release now fails without the keystore (fda49ef52) | Tie |
| iOS | App Store still **0.10.9 (2024-04-23)**. **2.0: native iOS app in TestFlight since 2026-10-20**, "under App Store review" per the 2.0.2 notes | **Absent**: no target, no work | Gap |
| Mobile sync | RTC (alpha); the new iOS app claims background sync | LAN sync, **foreground only** (`docs/architecture/sync-and-network.md`); in daily Android ↔ Linux use (maintainer report) | Partial |
| Phone UI | 2.0.2 popup and safe-area fixes | Phone layout overhaul with 44 px targets (#5941, #5948, #5955, #5957, #5958, #5969); no Android device lane in CI | Done |
| Mobile plugins | **None on mobile, in either version** | N/A | Tie |

### 17. Out of Scope for Agaric

| Feature | Logseq | Notes |
| --- | --- | --- |
| Plugin / extension system | **~625 marketplace packages (~71 themes)**; ~132 declare `supportsDB` (~21%) and ~309 declare `effect: true` (~49%, **un-sandboxed in the host origin**). Approximate hand tally of `plugins.json` (~2026-10-19), not like-for-like with the 2026-08-30 count; the docs still say "65+" | **No plugin API, no custom CSS, no user scripts.** 6 built-in themes plus an OS-following auto, font sizes, motion controls, full keyboard rebinding. MCP is the only seam, and it grew (§12) |
| Flashcards / SRS | OG: SM-5. **2.0: FSRS, does not import SM-5 data**; 2.0.2 "practice again" (#13410) | Not priority per user |
| Whiteboard | OG: tldraw fork. **2.0: REMOVED**, with slides and Excalidraw | Not priority per user |
| PDF highlight-to-block | OG: highlights become blocks on an `hls__` page. 2.0: `#PDF Annotation` tag; 2.0.2 imports annotations | pdf.js reader with highlight + comment; saving bakes annotations into a new attachment and deletes the original, leaving inline `attachment:<id>` refs dangling (2026-08-30 finding, not re-audited) |
| Zotero | OG: built-in. **2.0: REMOVED**, community plugin | BibTeX/CSL-JSON importer to typed reference pages |
| Org-mode | OG only; 2.0 dropped it | Design choice |

---

## Part 3: Where Agaric Genuinely Wins

Trimmed to claims that survived verification on 2026-10-21.

| Area | Agaric advantage | Against |
| --- | --- | --- |
| **Sync without a server** | **Free, no account, no server, no subscription**: two devices pair once with a passphrase or QR and converge through a Loro CRDT. Attachments converge too. Two-way sync is required in CI and in daily Android ↔ Linux use (maintainer report) | **2.0**: paid ($5/month minimum), self-hostable only by running a server, README says alpha. **OG**: no built-in sync. 2.0's Markdown Mirror is one-way, so Syncthing-style file sync of a 2.0 graph is not equivalent |
| **Search** | A 12-prefix filter DSL with validation and autocomplete, 19 filter fields, and `Ctrl+F` in-page find with regex | 2.0 has the same trigram index class, so the CJK and substring edge holds **against OG only**. 2.0 has opt-in macOS semantic search that Agaric lacks |
| **Journal** | 5 view modes, a content-dot calendar, drag-to-reschedule, `Alt`-key navigation, templates applied wherever a day is created, and a date format **that 2.0 removed** | One scrollable view with hardcoded 3+7 pagination |
| **Task dashboard** | A real agenda: 8 filter dimensions, sort and group, projected occurrences, DuePanel, DonePanel, `UnfinishedTasks` rollover | No agenda view; a `:scheduled/future-days` section and two default queries |
| **Recurrence** | Yearly intervals, three modes, end conditions, write-time validation, projection | No end conditions, no projection; OG's `.+` contradicts its docs |
| **Backlink filtering** | Server-side boolean tree over the filter predicates with keyset pagination | A filter bar |
| **Data integrity** | blake3 hash chain, SQL-enforced append-only, four-step boot recovery, an integrity check and engine vs SQL audits, op-level undo with batch revert | 2.0's README carries an official data-loss warning; 274 open `db-test` issues |
| **Conflict resolution** | Loro CRDT: blocks, text, properties, tags, moves and attachments converge without a user-facing conflict | File-level conflicts (OG) or alpha RTC (2.0) |
| **Spaces** | Per-space journal, tabs, recents, identity, `Alt+1..9`, write-time cross-space enforcement, page move between spaces | One graph per instance |
| **Editor breadth** | Native Mermaid, KaTeX, 5 callout types, 8 inline pickers, a block-mode toolbar, the Markdown reveal, opt-in page mode, Edit as Markdown, Markdown paste | Mermaid is a plugin; no toolbar; no page-as-document mode |
| **Agent access** | 36 MCP tools, per-agent tokens, modes and space allow-lists | 2.0's MCP is narrower; its REST API is on master, in no release |
| **ID durability** | ULIDs; renames propagate; export externalizes them and re-import re-internalizes them | UUID v4; OG stores link text |
| **Supply chain** | SLSA provenance, Scorecard, CodeQL, blocking audits, a threat model, a release gated on a real-backend lane | Standard OSS CI |

**What keeps the sync win from being "out of the box" today.** The sync win is real only on one network:

- Discovery is mDNS-only, so devices on different networks cannot find each other. The opt-in relay
  helps only peers that have already found each other.
- Android syncs only in the foreground.
- There is no backup or restore.
- A quarantined slot is invisible while the UI says "synced".
- Nobody has shown it working across networks or on a restrictive one.

These five, ranked, open [Part 9](#part-9-what-would-actually-make-agaric-superior).

---

## Part 4: Where Logseq Genuinely Wins

| Area | Logseq advantage | Agaric limitation |
| --- | --- | --- |
| **Transclusion** | Refs render live content inline, with children and a count badge; embeds show whole blocks with their task and property UI | Embeds show content-only rows and cannot be unlocked in page mode. Refs are chips with a pointer-only peek. No per-block badge, no peek on touch |
| **Data modelling (2.0)** | Typed properties with defaults, choices, multi-value, display position; tags as classes; `Extends`; bidirectional properties; per-tag name uniqueness | 7 types, no multi-value, inheritance outside the query vocabulary, no reverse properties, built-ins locked, priorities fixed |
| **Query power** | Simple DSL + Datalog + SCI transforms + Views with column control + aggregation macros | A deep engine with a fuller builder, but **no user-facing query language** (dropped in #4804), no transforms, one-hop traversal, single-space |
| **Human-readable storage** | OG: plain `.md`/`.org` files. 2.0: Markdown Mirror writes a plain-Markdown projection, **one-way** per a secondary source | One SQLite file plus Loro state. Edit as Markdown gives a per-page source view in-app; export is a projection that drops the schema and history |
| **Exit story** | EDN, JSON, OPML, Roam JSON, HTML, Markdown; 2.0's **Build EDN** exports the whole schema | Markdown + assets only |
| **Ecosystem** | ~625 packages, a plugin API, a CLI, custom.css/custom.js, and a REST API on master | **Nothing** but MCP |
| **Publishing** | HTML SPA (OG) or hosted per-page publishing (2.0) | Absent |
| **Time tracking** | Built-in (OG); status history with time spent (2.0) | Absent |
| **Remote sync** | 2.0 RTC syncs any two devices on the internet (paid, alpha) | **Discovery is LAN-only.** QR pairing needs no multicast (#4702) and an opt-in relay exists (#5135), but only between peers already found on one network |
| **Backups** | 2.0: automated hourly, last 12 retained | None |
| **Platform reach** | 2.0: native iOS in TestFlight, Android APK; OG on the App Store and F-Droid | Android sideload only; no iOS |
| **Community** | 45.3k stars, 2.8k forks, an active forum, years of workflows | One maintainer, no public user base |
| **Research workflow** | PDF highlight-to-block, Zotero (OG), a mature reader | Reader with annotation, BibTeX import, no highlight-to-block |

---

## Part 5: Agaric's Self-Inflicted Problems

These are not gaps against Logseq. They are places where Agaric paid for a feature and does not
collect the benefit, or where its own documentation is wrong. Each carries its 2026-10-21 verdict.

### Built but not fully reachable

| Thing | Cost paid | Verdict (2026-10-21) |
| --- | --- | --- |
| **`block_tag_inherited`** | A materialized table, five propagation paths, a rebuild job, an invariant | **Partly fixed.** Reachable from the Tags-view toggle (#4925), `under:` (#5797) and MCP `search`; not from `FilterPrimitive`, inline queries, agenda filters or Advanced Query |
| **`listStyle` block-level lists** | A full read pipeline + decoration | **Fixed**: written by Turn into, slash and `-` / `1.` (#4552); Enter / Backspace continue (#4807) |
| **Advanced query engine depth** | 10 property operators, 4 value types, 7 group keys, property aggregates | **Fixed for the engine/UI gap** (#4569, #4804). Remaining: bounded group preview, no column picker, no text language |
| **Saved views** | A saved-view UI and storage | **Partly fixed**: invisible since a space migration until #5828; now per-space `localStorage`, not synced; old views stay invisible |
| **The notification subsystem** | OS plumbing on three platforms, a settings tab, a permission flow | **Partly fixed**: desktop `due_date` reminders while the app runs (#4806). No Android, catch-up, lead time or `scheduled_date` |
| **The sync quarantine** | A quarantine table, boot fields `sync_inbox_quarantined` and `sync_inbox_quarantine_pending` | **Still true**: `list_quarantined_slots` has no IPC or frontend caller; the fields reach logs only |
| **i18next** | ~3,056 keys across 13 namespaces (2026-08-30 count) | Two locales, `es` partial (#4555); not re-audited |

### Documentation that is false

- **Fixed:** `docs/features/tags-and-links.md` "render the target block's content inline, kept live".
  It now describes the chip, the peek and embeds.
- **Still true:** `docs/features/pickers-and-slash.md` says `[[` targets "the page or block". The
  picker is pages-only. Fixed: the `((` edit-in-place embed claim and the `/property` command.
- **New drift:** `docs/features/pickers-and-slash.md` calls `/embed` read-only, while
  `docs/features/tags-and-links.md` says embeds are editable behind the unlock.
- **Fixed in this revision:** `docs/features/sync.md` and `docs/FEATURE-MAP.md` said two-way sync was
  "unverified (#3507)"; they now cite the CI suite and daily use.
- **Fixed:** the three docs that claimed a pairing fallback. QR v2 exists and `docs/features/sync.md`
  describes it accurately.
- **Partly fixed:** `docs/features/journal-and-agenda.md` placed recurrence projection in Agenda
  mode, which is now true (b5ac3a590). Its "no date" and "custom range" preset claims were not
  re-checked.
- **Probably still wrong:** `docs/features/agent-access.md` documents
  `agaric://settings/agent-access`, but the tab id is `agent` and no alias was found. Runtime is
  unverified.
- **Fixed:** the stale docblocks in `advanced_query.rs` and `AdvancedQueryView.tsx`.

### Quality signals that do not mean what they appear to

- **Mutation testing cannot fail a build.** This is still true: `stryker.config.mjs` sets no
  `thresholds.break`, and the PR mutation job is informational.
- **Fuzzing and the benchmark SLO gate run weekly**, not per-PR.
- **The 100K-block benchmark measures latency only.** Peak memory is unmeasured. There is no
  Android performance number and no sync-at-scale test. Boot at 100K blocks is ~1.4 s median
  (session 2424).
- **`revert_ops` is permanently ~6× over budget**
  (`revert_gate_skipped` in `src-tauri/benches/interactive_slo.rs`).
- **The main block editor is lazily mounted, not virtualized.** Row hydration is deferred
  (`src/components/block-tree/use-block-mount-limit.ts`). That cut a 500-block page's worst frame
  from 1,316 ms to 142 ms (session 1914). Rows stay mounted once hydrated.
- **Accessibility depth is uneven**, by the 2026-08-30 counts (not recounted): 597
  `toHaveNoViolations` assertions under `src/`, but only 4 of 110 e2e specs run axe in a browser.

---

## Part 6: The Logseq 2.0 Factor

**2.0 is where Logseq's development happens; OG is frozen.** Benchmarking Agaric against OG is
benchmarking against a product that will not change again.

| Component | Status (2026-10-21) | Effect on this comparison |
| --- | --- | --- |
| SQLite storage | Beta (2.0.2, 2026-10-07); README "data loss is possible"; 274 open `db-test` issues | Neutralizes Agaric's storage-efficiency argument |
| Typed properties, classes, `Extends` | Beta, **deeper than Agaric's** | Logseq's lead |
| Views (Table/List/Gallery) | Beta; 2.0.2 sort and filter fixes (#13485, #13486, #13487) | Exceeds Agaric's result table |
| **Markdown Mirror** | Shipped, opt-in; **one-way** per a 2026-05-16 forum post (secondary); no evidence two-way shipped | Restores plain-text *reading*, not an edit or sync path |
| **MCP server + CLI** | Shipped; 2.0.2 adds CLI password login (#13270), Markdown upsert (#13377), browser `/mcp` (#13312) | Removes Agaric's exclusivity; Agaric's tool surface and per-agent scoping are deeper |
| **REST API with tokens** | Merged to master 2026-10-10 (#13019), E2EE graphs 10-11 (#13671); after 2.0.2, nightly only | A programmable API Agaric lacks, once released |
| RTC sync | Open to all Open Collective Backers ($5/month) and Sponsors ($15/month), self-hostable by running the server (docs, 2026-10-21); E2EE code merged (#13671), production deployment **unconfirmed**; README still says alpha | Logseq syncs across networks for a fee; Agaric syncs free and serverless on one network |
| iOS app | Native app in **TestFlight since 2026-10-20** (invites 10-21), "under App Store review"; the App Store still serves 0.10.9 | Agaric has nothing |
| Android app | `Logseq-android-2.0.2.apk` (42.1 MB) in the **GitHub release assets**, on no store; native or WebView unverified; a native app is in development, undated | Parity with Agaric's sideload APK |
| Semantic search | Opt-in, macOS ARM64 only, off by default (#12710) | Agaric has none |
| Plugin compatibility | **~132 of ~625 packages declare DB support (~21%)**: approximate hand tally, ~2026-10-19 | The ecosystem advantage is real, and most of it is not DB-ready |
| Removed in 2.0 | Whiteboards, slides, Excalidraw, built-in Zotero, org-mode, `{{query}}` macros (→ `/Query`), the `all-page-tags` and `sort-by` filters, `:journal/page-title-format`, SM-5 flashcard data. **`((uuid))` removal: unverified**: no source found, and #13717 still exports `((uuid))` | Several Logseq advantages this document used to cite no longer exist in the version being developed |

**Honest read:** Logseq 2.0 is more capable than Agaric on data modelling, queries, ecosystem,
portability and platform reach. It is less trustworthy on data integrity, and its sync is paid and
alpha. Agaric's sync is free, serverless, CI-verified and in daily use, but only on one network.
Both carry real risk: 2.0 is a beta with an official data-loss warning, and Agaric is a pre-1.0 app
with one author that shipped 14 releases in 54 days, one of which crashed on every Android launch.

---

## Part 7: Who Should Use Which

| Persona | Better fit | Why |
| --- | --- | --- |
| **Journaling** | Agaric | 5 view modes, a content-dot calendar, drag-to-reschedule, templates applied wherever a day is created (#5395), and a date format 2.0 removed. Logseq gives one scrollable view. Logseq keeps readable `[[page name]]` in raw text; Agaric's `[[ULID]]` reads only after export |
| **Tasks / GTD** | Agaric | An agenda with 8 filter dimensions, projected occurrences (b5ac3a590), recurrence with end conditions, and desktop reminders that fire (#4806). Gaps: no `WAITING`, no time tracking, priorities fixed at 1–3 (#6017), no reminders on Android or with the app closed, and one block left per completed recurrence |
| **Long-form writing** | Agaric | Page mode (#5721) with the Markdown reveal edits a page as one WYSIWYG document over blocks, and Edit as Markdown gives the raw source. Logseq's document mode (`t d`) adds a CSS class that hides bullets (shown on hover) and can make Enter insert a newline, but each block is still its own textarea (logseq/logseq `frontend/components/block.cljs`, `doc-mode-enter-for-new-line?` in `frontend/handler/editor.cljs`). Limits: page mode is opt-in, desktop-only and capped at 500 blocks, and callouts, quotes, fences and math do not reveal (#5691) |
| **Zettelkasten** | Close; Logseq slightly ahead | Agaric now has embeds, the peek, link kinds, labels and linked references on a zoomed block. Logseq still renders ref content inline, shows a per-block reference count, and embeds whole blocks with their task and property UI |
| **Meeting notes** | Agaric | The Templates view, `{{cursor}}`, live inline queries and the agenda for action items. Bug: `/template` drops block properties, so pre-set TODOs insert as plain text; journal templates keep them |
| **Project management** | Split | Agaric's agenda and live queries aggregate without query-writing. 2.0's supertags, multi-value properties and per-tag tables model a project schema better |
| **Multi-device, no cloud** | Agaric | Free, serverless, no account. CI-verified two-way and in daily Android ↔ Linux use (maintainer report). Logseq 2.0 needs a $5/month tier or a self-hosted server, and its sync is alpha. Limits: one network, Android in the foreground only, no backup |
| **Research / reading** | Logseq | Highlight-to-block, Zotero (OG) and full embeds |
| **Plugin tinkerers** | Logseq | ~625 marketplace packages, a plugin API, custom CSS/JS. Agaric offers MCP only |
| **iPhone** | Neither yet | Agaric has no iOS app. Logseq offers a 2024 file-version App Store app or the 2.0 TestFlight |

**The core set.** Most people use a reduced core: journal, pages and links, tasks, search, templates,
and sync between their own devices. On that set the scorecard puts Agaric at parity or ahead, with
two exceptions. On linking substance it trails (7 against 9–10). For anyone who needs plain files or
an iPhone, it is not an option. The losses outside the core are real: data modelling, queries as
text, the ecosystem, publishing and portability.

---

## Part 8: Scorecard

Scoring shipped, stable functionality 1-10. Logseq 2.0 is scored on what a release ships (not
master), with its beta status called out separately rather than deducted twice.

| Category | Logseq OG (frozen) | Logseq 2.0 (beta) | Agaric | Change vs. 2026-08-30 revision |
| --- | :---: | :---: | :---: | --- |
| Block CRUD | 9 | 9 | 9 | — (embeds and the selection cursor, against the depth cap of 20, device-local collapse, ephemeral zoom and three batch actions) |
| Page management | 9 | 9 | **9** | **+1** (unique titles per space, alias ops, Edit as Markdown, page mode; uniqueness is command-level only) |
| Editor formatting | 8 | 8 | **9** | **+1** (Markdown reveal, page mode, Markdown paste, CommonMark flanking; still lossy round-trip and an inline subset; page mode opt-in, desktop-only, no toolbar) |
| Linking system | 10 | 9 | **7** | **+2** (embeds, link kinds, peek, labels, linked refs on a zoomed block; no inline ref content, no per-block badge, pages-only picker) |
| Properties | 6 | **10** | 7 | — (`url` and chips, against frozen task and priority options; no multi-value, rename or retype) |
| Tags | 8 | **10** | **7** | **+1** (inheritance reachable, tag-page contents; still outside the query vocabulary) |
| Query system | 9 | 9 | **7** | **+1** (live inline queries, 10 operators and 7 group keys in the UI, property aggregates; no text language, transforms or cross-space) |
| Task management | 7 | 8 | 8 | — (Agenda projection and desktop reminders, against the priority regression (#6017), no `WAITING`, no time tracking) |
| Daily journal | 8 | 7 | **9** | — |
| Search | 5 | **7** | **9** | **2.0 +1**: its trigram FTS5 dates from 2024, so 6 was an audit error; plus opt-in semantic search. **Agaric held**: the index edge over 2.0 is gone, but the 12-prefix filter language, 19-field scope and regex in-page find have no 2.0 equivalent |
| Templates | 7 | 8 | 7 | — (journal templates carry properties; `/template` drops them and is not atomic) |
| Spaces | 2 | 3 | **9** | — |
| AI / agent access | 2 | 8 | **9** | **Agaric +1** (36 tools, per-agent tokens, modes and space allow-lists; not isolation). **2.0 held**: the proposed +1 rests on the REST API (#13019), which merged after 2.0.2 and is in no release |
| Sync / storage | 4 | 5 | **7** | **+2.** Two of the three deductions behind the 5 are gone: two-way sync is CI-verified and in daily Android ↔ Linux use, and QR pairing needs no multicast. Attachments converge, and the snapshot OOM is gone. Not 8: no backup, mDNS-only discovery, foreground-only Android, invisible quarantine |
| Data integrity | 3 | 4 | **8** | — (integrity check and audits added; invisible quarantine, no backup, late convergence bugs #5608, #5712) |
| Performance | 3 | 7 | 7 | — (lazy hydration; revert over budget, memory unmeasured) |
| Import / export | 9 | 8 | 6 | — (better grammar and Logseq fidelity; no structured export, clipboard-only per-page export) |
| Mobile | 5 | **4** | 5 | **2.0 +1** (native iOS in TestFlight, Android APK in release assets; no store listing) |
| Extensibility / ecosystem | 9 | 6 | **2** | **+1** (MCP agents; no plugin API, CSS or scripting) |
| Project risk | 4 | 5 | **3** | — (one human author on all 969 non-bot PRs; 14 releases in 54 days; 0.15.0 crashed every Android launch; pre-1.0) |
| **Total** | **127** | **144** | **144** | previously 127 / 142 / 134 |

**Read this total carefully.** Unweighted category sums are a weak instrument. They treat
"Extensibility" and "Data integrity" as equally important, which they are not for a single user.

- **On raw capability, Logseq 2.0 and Agaric are now level, 144 to 144.** The 8-point gap closed
  because Agaric shipped embeds, page mode, live queries and verified sync while 2.0 shipped mostly
  fixes. A tie is inside this instrument's noise. One 2.0 release carrying its REST API, or a store
  listing, tips it back.
- **Weighted for the target workflow** (journaling, tasks, project notes, one person, no cloud),
  **Agaric wins clearly**. It leads on journal (9-7), search (9-7), spaces (9-3), sync (7-5), data
  integrity (8-4) and agent access (9-8), and ties on tasks (8-8) with the better dashboard. Its
  losses are linking (7-9), properties and tags (7-10 each), queries (7-9), ecosystem (2-6) and
  portability (6-8).
- **Sync is the differentiator, within one network.** It is free, with no server and no account.
  Logseq's equivalent costs $5/month, runs through a server, and is alpha. On any other network,
  Agaric's devices cannot find each other, and on Android Agaric syncs only in the foreground.

---

## Part 9: What Would Actually Make Agaric Superior

### Sync first: the path to the killer feature

Ranked by how much each one stands between a user and sync that works out of the box:

1. **Discovery across networks.** Discovery is mDNS-only. The opt-in relay (#5135) carries traffic
   only between peers that have already found each other, and the QR carries a LAN address. Two
   devices on different networks cannot sync at all.
2. **Background sync on Android.** Sync is foreground-only
   (`docs/architecture/sync-and-network.md`), so a phone catches up only while it is open.
3. **Backup and restore.** None exists. Agaric stores everything in one opaque file and needs this
   more than Logseq 2.0, which keeps hourly snapshots and the last 12.
4. **Surface the quarantine.** `list_quarantined_slots` has no caller. A slot that cannot apply
   disappears while the UI says "synced", which is the worst failure mode for a local-first app.
5. **Close the proof gap.** Different-network and restrictive-network use is unproven.

### The 2026-08-30 list, with verdicts

| # | Item | Verdict | What remains |
| --- | --- | --- | --- |
| 1 | Fix the false documentation | Partial | `[[` "page or block", the `/embed` drift, the agent-access deep link (Part 5); the sync "unverified" line is fixed in this revision |
| 2 | Wire or delete `block_tag_inherited` and `listStyle` | Partial | `listStyle` done; inheritance not in `FilterPrimitive` or inline queries |
| 3 | Finish the notification scheduler | Partial | Android, closed-app delivery, catch-up, `scheduled_date` |
| 4 | Make sync provable | Done (one network) | CI suite required by `e2e-tauri-gate` (#5996) + daily Android ↔ Linux use; the residue is sync item 5 |
| 5 | Pairing fallback without multicast | Done for QR (#4702) | Passphrase-only pairing still needs multicast |
| 6 | Surface quarantined slots and op origin | Open | Sync item 4; the History view still does not render `agent:` origin |
| 7 | Ship backup/restore | Open | Sync item 3 |
| 8 | Fix template block-property loss and the PDF dangling ref | Partial | Journal templates fixed (#5395); `/template` drops properties; PDF not re-checked |
| 9 | Block and page embeds | Done, with limits (#4572, #4809) | Task and property UI in embed rows; unlock in page mode |
| 10 | Give references substance | Mostly done (#4943, #4945, #4947) | A per-block count badge; peek on touch; inline content |
| 11 | A user-facing query language | Open | Dropped in #4804; still the cheapest way to expose the engine |
| 12 | Make inline queries live | Done (#5316) | — |
| 13 | Multi-value properties | Open | `PRIMARY KEY (block_id, key)` |
| 14 | A structured export | Open | JSON or EDN with definitions, history and saved queries |
| 15 | An answer to bus factor 1 | Open | MCP grew (36 tools, per-agent scoping) but is not a plugin API |
| 16 | Is LAN-only still right? | Partial | Opt-in relay shipped; discovery is still one network: sync item 1 |
| 17 | Where does the hardening loop end? | Answered for this window | `feat` ~14% of recent commits and Python guards deleted or ported (#5579). The new question is cadence: 14 releases in 54 days, and 0.15.0 crashed on every Android launch before the real-backend release gate (fda49ef52) |

---

## Part 10: Corrections Log

What each revision changed about the one before it.

### 2026-10-21 revision

#### Audit errors in the 2026-08-30 revision

| Claim | Reality |
| --- | --- |
| Logseq's `unicode61` tokenizer cannot segment CJK; Agaric's CJK/substring search is "Better" | True for **OG only**. 2.0 creates `fts5(…, tokenize="trigram")` (`frontend/worker/search.cljs` upstream, since 2024-07-20) |
| Template insertion is a "single batched IPC, atomic" | One `createBlocksBatch` per depth level; an error stops after earlier levels landed (`insertTemplateBlocks` in `src/lib/template-utils.ts`). Never true |
| 2.0 "Android not open even for alpha" | The 2026-08-30 revision itself listed a 37.8 MB 2.0.1 APK; 2.0.2 ships one as a release asset |
| 2.0 removed the `((uuid))` syntax | No source found; #13717 still exports `((uuid))`. Unverified |
| Markdown Mirror "restores external access" | One-way per the only dated source (secondary). Reading, not editing |
| 2.0 has "6 real types" (listing seven) | Seven named, and the `:schema :type` registry lists more |
| Unknown editor nodes are "silently dropped" | Dropped with a once-per-session toast (`src/editor/markdown-serialize-toast.ts`). Pessimistic error |
| Per-page `Ctrl+Shift+E` exports a file | It copies to the clipboard, with attachments as filename stand-ins |
| Logseq import drops "blocks past depth 99" | The import cap is 19 (`MAX_IMPORT_DEPTH` = `MAX_BLOCK_DEPTH` − 1) |
| Agaric "23 primitives" | **Stands**: `FilterPrimitive` has 23 variants on `15f3f9705`. An audit proposed 24; the code does not support it |

#### Claims overtaken by changes since 2026-08-30

| Claim | Now |
| --- | --- |
| Part 0: "Logseq shipped a major version while Agaric shipped one feature"; the project is "improving its own immune system" | ~1,076 PRs and 14 releases; embeds, page mode, live queries, CI-verified sync. Logseq shipped one beta point release |
| No block or page embeds | Shipped with limits (#4572, #4809) |
| The full-content hover was removed (#4228) | The peek restores it, pointer only (#4947) |
| `block_links` has no kind discriminator | Migration 0119, #4943 |
| Linked references never on a block; custom labels absent; unique titles not modelled | On a zoomed block (#4945); `[[Page\|label]]` (#5175); unique per space (#4782) |
| Tag inheritance is **Dead** | Partial: toggle (#4925), `under:` (#5797) |
| Inline queries are not live; grouping 5 of 7 in the UI | Live (#5316); all 7 (#4804) |
| Priority levels "Configurable", **Better** | Fixed 1/2/3 (#6017): **a regression** |
| "20 seeded" built-in properties | 14 code-defined built-ins (#6017, migration 0128) |
| `block_properties` has "6 typed values" | 7, with `url` (#5142) |
| Recurrence projection in the Due Panel, "not Agenda" | Both (b5ac3a590) |
| Deadline warning in "Settings → General"; a per-space journal-template override | Settings → Tasks & reminders (#5635); override retired (#5405) |
| Spaces switch with `Ctrl+1..9` (the 2026-08-30 text before its in-place patch) | `Alt+1..9`; `Ctrl+1..9` switches tabs (#6022) |
| "Table dimension syntax with a grid picker"; seven inline pickers | `/tableRxC` removed (#5766); eight pickers with `#` (#5205) |
| MCP: two RO/RW sockets, 17 tools, no auth or per-agent scoping | One socket, per-agent tokens, modes and spaces (#5759); 36 tools |
| Two-way sync unverified | CI-verified (#5589, #5604, #5996) and in daily Android ↔ Linux use (maintainer report) |
| Attachments never converge; snapshots hold the vault in RAM with an ~18 s lock; legacy CBOR catch-up wipes the op log | Converge (#5608, #5728); blob gone (#4693, #4727) |
| LAN only, "relays cleared" | An opt-in relay (#5135), off by default |
| Every `((block-ref))` stripped on Logseq import | Same-file refs resolve via `id::` (#5214) |
| 2.0.1, iOS "invite-only alpha", sync "paid/invite-only" | 2.0.2; iOS TestFlight; sync open to $5/$15 backers |

#### Stale external numbers, refreshed

- **2.0 version and repo:** 2.0.1 (2026-07-13), 44,687 stars, 858 issues + 107 PRs, 346 `db-test`
  issues → 2.0.2 (2026-10-07), 45.3k stars, 2.8k forks, 813 issues + 181 PRs, 274 `db-test` issues.
- **OG:** 268 stars and ~17 issues → 335 stars, 63 forks, 18 issues and 13 PRs.
- **2.0 binaries:** 135–174 MB plus a 37.8 MB APK → 141–169 MB plus a 42.1 MB APK.
- **Funding:** "~$252k/yr Open Collective" → an estimated annual budget of $238,197.74, with
  $761,717.86 raised in total and a $43,427.67 balance.
- **Plugins:** "110 of ~615" → ~132 of ~625 (approximate, and not like-for-like).
- **Dropped as not re-derived:** "324 contributors", "2,257 commits / 46 authors in six months",
  "44% no push in 2+ years", "~85 methods", "127.0.0.1:12315".

### 2026-08-30 revision

What that revision changed about the 2026-08-04 one.

#### Claims that were false

| Previous claim | Reality |
| --- | --- |
| Sync uses "mTLS WebSocket with TOFU cert pinning (ECDSA P-256), plaintext-JSON pairing handshake" | That stack was **deleted**. Transport is iroh QUIC/UDP with TLS 1.3 in-handshake and ed25519 endpoint ids |
| Notifications include "task/deadline reminders via `notifyTask`" | `notifyTask` had one production caller: the "send test" button |
| "Manual IP entry / mDNS fallback — Done" | No first-pairing fallback existed (#3952) |
| Multi-device sync "Done", sync architecture "Better" | The repo's own docs said two-way sync was unverified (#3507) |
| Tag inheritance is a working capability | Materialized and maintained, read by no query surface |
| Inline query blocks are "live-updating" | `staleTime: Infinity`, no invalidation |
| "Unlimited depth (max 20)" | Depth is hard-capped at 20, backend-enforced |
| "No lists (blocks ARE list items)" | Ordered, bullet and task lists ship as real nodes |
| Block refs have a "hover tooltip with full content to 300 chars" | Removed in #4228 |
| Logseq import: "block ref stripping" listed as a feature | It is data loss |
| iOS blocked by "mDNS issue #522" | #522 is closed and was about manual IP entry; there is no iOS work |
| MCP is "read-only by default" | Two sockets, read-only and read-write, 17 tools |
| Deadline warning configured "in PropertiesView" | Settings → General |
| Recurrence projection appears in Agenda mode | Due Panel |
| Agenda has "collapsible TODO/DOING/DONE sections" | Grouping is user-selectable and defaults to page |

#### Claims that were overstated

| Previous claim | Correction |
| --- | --- |
| Advanced-query builder offers the full engine | 4 of 10 property operators, Text only, 5 of 7 group keys, column-only aggregates |
| Effort tracking "Better" | A fixed 6-option select with no rollup |
| Encryption "Tie" | Agaric has none at rest; Logseq Sync has age end-to-end |
| Snapshots/compaction "Better" | Whole-vault RAM buffering and an ~18 s write-lock hold at 100K blocks |
| Android "Better" | arm64-only, API 30+, sideload-only is narrower than Logseq's reach |
| "Cursor pagination everywhere" | The main block editor is not virtualized |
| Spaces include "sync-scope" | A session syncs every space |
| "~15,000+ tests" | 6,284 Rust test functions, 903 frontend and e2e test files |
| "axe a11y tests on 100+ components" | 597 assertions across 284 files, but only 4 of 110 e2e specs run axe |
| A draft of that revision: "there is no skip-link anywhere" | False in the pessimistic direction: `src/App.tsx` renders one |
| "Extras" row (Logseq 9 / Agaric 3) | Retired into "Extensibility / ecosystem" |

---

## Part 11: Coming from Logseq or Obsidian

Popularity comes from download counts, not guesses. Obsidian figures are the `downloads` field of
`community-plugin-stats.json`, joined to `community-plugins.json` for names (obsidianmd/obsidian-releases,
fetched 2026-10-21, 9,235 plugins). Logseq figures sum the release-asset downloads per package in the
marketplace's `stats.json` (logseq/marketplace, last refreshed 2026-10-19, 667 entries; `stat.json`
does not exist). Release-asset sums are approximate. Core features have no usage data, so they are
listed by area, not by rank.

### Coming from Obsidian

| Obsidian core feature | Agaric | Status |
| --- | --- | --- |
| Plain Markdown files in a folder vault | SQLite + Loro state. The Obsidian vault importer maps folders to namespaced titles; export is a ZIP; Edit as Markdown edits one page's source | Design choice |
| Live Preview | Page mode + the reveal for inline marks, links, chips and headings. Open (#5691): block-level reveal for callouts, quotes, fences and math, pages over 500 blocks, touch | Partial |
| Wikilinks and aliases | `[[` picker, typed `[[text]]`, `[[Page\|label]]`, `[[Page#Heading]]`, aliases as ops. Stored as ULIDs, so not readable as raw text. `Ctrl`/`Cmd`+click and `Alt+Enter` navigation in progress (#5691) | Done |
| Page preview on hover | Block refs peek (#4947); `Ctrl`+hover page preview in progress (#5691) | Partial |
| Backlinks | Linked and unlinked references with filters and a kind toggle | Done |
| Graph view | Global + local graph | Done |
| Canvas | None | Gap |
| Daily notes, Templates | Journal with 5 modes; templates with two variable grammars | Done |
| Command palette, quick switcher, chords | `Ctrl+P`, `Ctrl+O`, `Ctrl+E`, `Ctrl+1..9`, `Ctrl+Shift+T` (#6022) | Done |
| Tabs | Per-space tabs, `Ctrl+1..9`, reopen. Open (#5691): drag to reorder, middle-click to close, drag a page into the editor to link it | Partial |
| Properties (YAML) | Typed properties; front matter read on import and in Edit as Markdown. No list (multi-value) properties | Partial |
| Tags, nested tags | `#tag` chips, prefix hierarchy, boolean tag queries | Done |
| Search | Trigram FTS, the filter DSL, `Ctrl+F` with regex. Not compared feature by feature with Obsidian's operators | Done |
| Outline | Page outline (#5697) | Done |
| File explorer, folders | Pages browser, namespaces, spaces; no folders | Design choice |
| Embeds `![[…]]` | `{{embed}}` for blocks and pages, with content-only rows. Obsidian import maps `![[file]]` to attachments today; note, heading and block embeds on import are decided but not built (#5691, #6032) | Partial |
| Sync (paid: $4/month billed annually, $5 monthly) | Free peer-to-peer sync on one network | Design choice |
| Publish (paid: $8–10 per site per month) | None | Gap |
| Mobile (App Store, Google Play) | Android sideload APK; no iOS | Partial |

| Top community plugins (downloads) | Agaric equivalent | Status |
| --- | --- | --- |
| Excalidraw (8.63M) | None; whiteboards are out of scope | Gap |
| Templater (5.97M) | Template variables and `{{cursor}}`; no scripting | Partial |
| Dataview (5.18M) | `{{query}}` with the builder, 23 primitives, live results; no text query language, no JS | Partial |
| Tasks (4.47M) | Agenda, due/scheduled dates, recurrence with end conditions, projection | Done |
| Git (3.33M) | No files to commit; op-log history with revert in HistoryView | Design choice |
| Advanced Tables (3.30M) | Pipe tables, size grid, row/column ops in the block-mode toolbar | Partial |
| Calendar (3.21M) | Journal calendar with content dots | Done |
| Style Settings (2.79M), Minimal Theme Settings (1.86M) | 6 fixed themes plus auto, no custom CSS | Gap |
| Copilot (2.77M), Claudian (2.48M): AI agents in the vault | MCP with 36 tools and per-agent tokens; the agent runs outside the app | Partial |
| Kanban (2.77M) | None | Gap |
| Remotely Save (2.32M): sync through cloud storage | Peer-to-peer sync on one network; no cloud target | Design choice |
| Iconize (2.27M) | None; tag colours and space accents only | Gap |
| TaskNotes (2.26M): tasks with time tracking | Tasks yes, time tracking no | Partial |
| QuickAdd (2.26M) | Quick Capture (`src/components/settings/QuickCaptureRow.tsx`) | Partial |
| Editing Toolbar (2.06M) | Formatting toolbar, block mode only | Done |
| Omnisearch (2.02M) | FTS over blocks; PDF and OCR search not checked | Partial |
| Importer (1.83M) | Built-in Obsidian, Evernote, Joplin, Markdown and BibTeX importers | Done |
| Outliner (1.46M) | Agaric is an outliner | Done |

**What a migrant should know.**

- The vault stops being files: notes live in one SQLite database, and links are ULIDs.
- The daily loop is there: daily notes, links, backlinks, tasks, templates, the palette and the
  chords.
- Excalidraw, Canvas, Kanban, Publish and theming are not.
- Live Preview's counterpart, page mode, is opt-in, desktop-only and capped at 500 blocks.
- Sync is free but works on one network only. Obsidian Sync works anywhere for $4–5 a month.

### Coming from Logseq

| Logseq core feature | Agaric (detail in Part 2) | Status |
| --- | --- | --- |
| Outliner, block refs `((…))` | Chips + peek; no inline content, no per-block count (§1, §4) | Partial |
| Block and page embeds | Content-only rows, editable behind an unlock (§1) | Partial |
| Journals | 5 view modes, calendar, templates (§9) | Better |
| Properties | 7 types; no multi-value, defaults or reverse properties (§5) | Partial |
| Tags as classes (2.0) | Tags and pages are separate; no supertags (§6) | Design choice |
| Queries (simple DSL, Datalog) | Builder and `v2:` payloads, live; no text language (§7) | Partial |
| Tasks and the scheduled section | Agenda, projection, rollover (§8) | Better |
| Templates | Templates view and variables; `/template` drops properties (§14) | Done |
| Namespaces | Tree view and breadcrumbs (§2) | Done |
| Graph view | Global + local (§4) | Done |
| PDF annotation | Reader with highlights and comments; no highlight-to-block (§17) | Partial |
| Flashcards, whiteboards | None; 2.0 also removed whiteboards (§17) | Gap |
| Sync | Free on one network, against paid RTC (§13) | Design choice |
| Plain files (OG) | SQLite + Loro (§15) | Design choice |
| Importing a Logseq graph | Per file; a `((uuid))` into another file is stripped with a warning (§15) | Partial |

| Top marketplace packages (downloads) | Agaric equivalent | Status |
| --- | --- | --- |
| Journals calendar (269,582) | Journal calendar with content dots | Done |
| Bullet Threading (237,946) | Not found; indent guides appear only while dragging (`src/components/editor/BlockListRenderer.tsx`) | Gap |
| Tabs (211,249) | Per-space tabs | Done |
| TODO List (204,672) | DuePanel and agenda | Done |
| Themes: Bonofix (163,666), Dev (95,760), Catppuccin (73,925), Atlas (53,982) | 6 fixed themes plus auto, no custom CSS | Gap |
| Markmap (126,558) | None | Gap |
| Tags (124,850) | Tags view with usage counts | Done |
| Markdown Table Editor (118,367) | Size grid and toolbar row/column ops | Partial |
| PDF Export (106,695) | Not found | Gap |
| GPT-3 OpenAI (84,893) | No in-app AI; MCP agents run outside | Gap |
| Agenda (82,818) | Agenda mode | Better |
| Heatmap (80,406) | Calendar dots and counts, no heatmap | Gap |
| Awesome UI (71,753), Awesome Styler (51,390) | Fixed layout, no custom CSS | Gap |
| Link Preview (60,107) | External link preview on hover, behind a setting (#3684, `src/components/settings/EditorTab.tsx`) | Done |
| Kanban (59,129) | None | Gap |
| Block to page (53,440) | Not found | Gap |
| TODO Master (50,938) | No progress bar found | Gap |
| Git (49,524) | No files; op-log history | Design choice |

**What a migrant should know.**

- Import is per file, so cross-file block refs are lost, and `journals/` files do not become journal
  days.
- Links become ULID chips that survive renames.
- Supertags and multi-value properties have no equivalent.
- Journals, tasks, search and spaces are stronger.
- Sync is free and needs no server, but works on one network only.
- Most of the top plugins map to built-ins or to nothing; there is no plugin API to fill the gap.

---

## Appendix: Method and Sources

**Agaric claims** were verified on 2026-10-21 by three audits. Two cover Agaric: one for Part 2
§1–4, 14 and 15, and one for §5–13, 16, 17, Parts 5 and 9, and project risk. The third covers Logseq
upstream. They read a `git archive` of `origin/main` at `15f3f9705` (v0.20.0), because the working
checkout is shallow (history from 2026-10-14). PR counts come from GitHub search. PR attribution for
2026-08-30 to 10-14 leans on session logs, and a short hash is cited where a squash title carries
only an issue number. No runtime behaviour was exercised in these audits, apart from the CI suites
named in §13 and the maintainer's daily-use report.

**Logseq claims** were verified on 2026-10-21 against:

- <https://github.com/logseq/logseq/releases> (2.0.2, 2026-10-07), its assets, the 2.0.1...2.0.2
  compare, and the master README
- <https://github.com/logseq/og/releases> (OG 1.0.0, 2026-04-15) and its commit history
- <https://github.com/logseq/db-test/issues> (274 open)
- <https://github.com/logseq/docs> commits, including 628cdde (2026-10-21, sync access) and the 2.0.2
  changelog
- Source reads in `logseq/logseq`: `frontend/worker/search.cljs` (trigram FTS5),
  `deps/db/src/logseq/db/frontend/property.cljs` (property types); `logseq/og`'s electron
  `search.cljs` (`unicode61`)
- <https://github.com/logseq/marketplace> `plugins.json` (approximate hand tally)
- <https://opencollective.com/logseq> and its 2026-10-20 update (native iOS app)
- <https://discuss.logseq.com> (secondary: OG maintenance statement, Markdown Mirror)
- Store listings: Apple App Store (0.10.9, 2024-04-23), F-Droid (0.10.15, 2025-12-18)
- `logseq/logseq` master: `frontend/components/block.cljs`, `frontend/handler/editor.cljs` and
  `frontend/modules/shortcut/config.cljs` (document mode)
- <https://raw.githubusercontent.com/logseq/marketplace/master/stats.json> (package downloads)

**Obsidian claims** (Part 11) were checked on 2026-10-21 against
<https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json>,
`community-plugins.json` in the same repo, <https://obsidian.md/pricing> and
<https://obsidian.md/download>. The Agaric side of Part 11 cites #5691 for Obsidian-parity work in
progress, and a source search (not a runtime check) for the plugins marked "not found".

**Explicitly unverified** and not asserted above:

- **Logseq:** retail RTC pricing and any 2.0 GA date; whether the 2.0.2 Android APK is native or
  WebView; App Store review status; Google Play; production RTC E2EE; the July 2026 iOS data-loss
  incident; total contributor counts; marketplace counts beyond a hand tally; a two-way Markdown
  Mirror; the `((uuid))` removal; 2.0's plugin-API size and local HTTP port; 2.0's long-block and
  mobile-search behaviour; CJK on 2.0.
- **Agaric:** runtime behaviour of page mode (undo, code-language selection, table ops); duplicate
  page titles created offline; whether search AND/OR/NOT applies to filters; the agent-access deep
  link at runtime; cross-page anchor re-import; the ~24 MB Android APK size in the README;
  different-network and restrictive-network sync.
