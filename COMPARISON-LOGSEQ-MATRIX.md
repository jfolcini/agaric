# Agaric and Logseq: the feature matrix

> **As of November 2026.** The row-by-row detail behind [Agaric and Logseq](COMPARISON-LOGSEQ.md), which is the page to read first. Agaric cells describe `main` and cite the code or the feature docs. Logseq cells come from its README, documentation, release notes and announcements; "OG" is the file version and "2.0" the DB version, and a claim that could not be confirmed there says **unverified**. Cells that cite Logseq's source code or a release's pull requests come from an audit earlier in the month and were not all re-read. Logseq was not installed or run.

**Status** is Agaric against the Logseq capability in the same row:

| Label | Meaning |
| --- | --- |
| **Done** | Implemented |
| **Partial** | Implemented but incomplete |
| **Gap** | Not implemented |
| **Design choice** | Intentionally different |
| **Better** | Agaric's implementation goes further |
| **Tie** | Both have it to the same degree, or neither does |

## 1. Block Model

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Everything is a block | Yes. 2.0 unifies blocks and pages as "nodes" | Yes. `blocks` table, tree via `parent_id` + `position`. `block_type` is a closed enum: `content \| tag \| page` | Done |
| Block nesting depth | Unlimited in practice | **Capped** at `MAX_BLOCK_DEPTH` (`src-tauri/agaric-store/src/block_descendants.rs`), enforced backend-side; an import flattens deeper blocks to `MAX_IMPORT_DEPTH` | Partial |
| Block IDs | UUID v4 (random, unsortable) | ULID (Crockford base32, sortable, time-encoded) | Better |
| Block references | OG: `((uuid))` links a block. That the link renders the block's content inline, with a reference count on the source, is **unverified** in the docs. 2.0: blocks are referenced with `[[ ]]`, as pages are, and `(( ))` is gone (`db-version-changes.md`); refs to deleted nodes show as broken (#13551) | `((ULID))` renders a chip with the target's **first line**, cut at `TITLE_MAX_LEN`. A **peek** (a short hover or `Alt+↓`) shows full content, a space › page breadcrumb, the ref count, Open and Copy reference (`src/components/BlockRefPeek.tsx`, #4947); unresolved refs are labelled (`unresolvedBlockRefLabel` in `src/lib/block-title.ts`). No inline content, no children, no badge on the source, no peek on touch (#6746) | Partial |
| Block embeds | `{{embed ((uuid))}}` embeds the whole block (docs); editing it in place is **unverified** in the docs. 2.0: unified `/Node embed`; 2.0.2 applies embed actions to the embed (#13099) | `{{embed ((ULID))}}` via `/embed`, the picker, or `![[Name]]` / `![[Name#Heading]]` typed as a whole block (#6313), the block and its subtree rendered live (#4572), editable in place behind a per-embed unlock (#4809). Rows show **content only**: no checkbox, priority, date chips, properties or attachments (#6747). Depth and row count are capped (`MAX_EMBED_DEPTH`, `EMBED_MOUNT_LIMIT` in `src/lib/embed-token.ts`); arrows do not descend; no structural edits; not unlockable in page mode | Partial |
| Block properties | `key:: value` parsed from content; 2.0: typed property rows | `block_properties` with typed values (`VALUE_TYPES` in `src/lib/property-utils.ts`); `::` name autocomplete; inline chips incl. ref and boolean (#5862); BlockPropertyDrawer | Done |
| Collapse/expand | State persisted **in the block** (`collapsed::`), so it travels between devices | Chevron + `Ctrl+.`, persisted in `localStorage` per page, shared by page mode: **device-local, not synced**. Imported `collapsed::` applies on the importing device only (#5214); whether folds should sync is open (#6756) | Partial |
| Zoom into block | `Alt+Right`, a real route with a URL | Zoom with breadcrumb, but ephemeral `useState`: **not deep-linkable, not in the back-stack**; page mode has no zoom | Partial |
| Move block up/down | `Alt+Shift+Up/Down` | DnD (depth-projecting, cap-aware, subtree-safe) + `Ctrl+Shift+Up/Down`; gutter drag in page mode (#6015) | Done |
| Block-level multi-select | `Esc` + arrows; 2.0 adds bulk set-property / bulk tag | `Esc` in the editor selects the block, and `Shift+↑/↓` past a block's edge goes on to select blocks (#6588, #6622); also Ctrl+Click, Shift+Click, Ctrl+A, and a keyboard selection cursor (`Ctrl+Space`, `Ctrl+Arrow`). From two blocks the batch bar sets todo state, cycles priority and deletes, with one Undo for the batch. The bar has no indent, move or tag, though the indent key and a drag act on the whole selection (`docs/features/keyboard.md`); `CANCELLED` is missing from the batch menu | Partial |
| Subtree copy/paste | Yes; 2.0.2 keeps the subtree when copying or moving an ancestor | Indented-Markdown outline grammar; refs preserved; `[[Name]]`/`#tag` internalized on paste (#5153, #5154, #5166); cut/paste in page mode keeps ids and refs (#6019) | Done |
| Cross-block undo | Session-level `Ctrl+Z`, no history UI | Op-level undo/redo, per-page depth + redo stack, HistoryView with batch revert, word-level diff and a badge on the ops an MCP agent wrote. Undo survives a sync, and an undo of a change another device has since written over puts your text back (#6671); a revert that would recreate a taken page title or tag name is refused (#6100). Caveat: in page mode, `Ctrl+Z` in the document does not take back a change of task state, date, property or attachment (`docs/features/editor.md`) | Better |
| Turn into | Slash commands per block type; 2.0.2 adds "Clear heading" | Toolbar menu, block menu, `/turn`, `Ctrl+Shift+L` (#5760; key moved by #6022), page mode (#6027): H1–H3, quote, code, lists, callout | Done |

## 2. Page Model

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Pages as containers | One file per page (OG); node entity (2.0) | `blocks` with `block_type = 'page'`, content = title | Done |
| Page properties | First block holds `key:: value` | `block_properties` on page blocks; PagePropertyTable; front matter in Edit as Markdown (#5220) | Done |
| Page aliases | `alias:: JS, ECMAScript` | `page_aliases` + header badges; alias edits are ops, so undoable and synced (#5563); MCP `set_page_aliases` (#5570) | Done |
| Namespaced pages | `Project/Backend/API`; 2.0 replaces namespaces with tag hierarchy | Tree view in PageBrowser, breadcrumbs, create-under flow (#4734, #4874) | Done |
| Page tags via property | `tags:: book, fiction` → page refs. 2.0: tags are classes | `block_tags` + picker; `tags::` read on import (#5214) and `tags:` in Edit as Markdown front matter (#5220). No in-page `tags::` syntax | Partial |
| Unique names per context | 2.0: page names unique **per tag** (`Apple #Company` vs `Apple #Fruit`); 2.0.2 rejects creating a page tagged `#Tag` (#13221) | Titles and aliases unique **per space** under one folded name key (`reject_duplicate_page_title` in `src-tauri/src/commands/blocks/crud.rs`, #4782, #6278); tags too (#5281). Names two devices created while apart are settled after a sync: the newer page is renamed `Name (2)` with a toast, two same-named tags merge into the older, two pages for one journal day merge (#6278, `e2e-tauri/page-name-tie-sync.e2e.ts`). Command-level only, no DB constraint; pages without a space exempt | Done |
| Auto-created pages from links | Clicking `[[New Page]]` creates it | `[[` picker "Create", typed `[[text]]`, and the palette's *Create page "…"* when a search matches nothing; the New page dialog lists similar names (#5645); a broken-link chip is removed on click, `Ctrl+Z` restores (#5863) | Done |
| Move page between contexts | Multi-graph = separate folders | **Move to space** from the kebab and batch-move from the Pages view; closes the page in every tab (#5753). It lists the property values the destination defines differently and drops them only once confirmed, and one undo restores them (#5841). A move is refused when the destination already holds the page's title or one of its aliases (#6105) | Better |
| **Edit as Markdown** | OG: the page *is* a Markdown file. 2.0: no editable source | Page kebab or page mode's footer → a full-page Markdown buffer in the one text format (#6277): front matter, a paragraph per plain block, `-` / `1.` / `- [ ]` only on list and task blocks, `key::` lines, block ids carried out of sight. The block toolbar, the pickers and the block keys work in it; Edit / Preview / Changes; merge on a stale save (#5159); save report with Undo; draft recovery | Done |
| **Plain Markdown files on disk** | OG: the files are the store, on every platform. 2.0: a read-only Markdown projection of a DB graph, opt-in per graph, with two-way sync in development on a branch (forum changelog); whether a release carries it is **unverified** | **Markdown mirror** (#5363; Settings → Data; `src-tauri/src/mirror/mod.rs`): every page of every space, or of the spaces switched on, as a `.md` file in the form Edit as Markdown writes, kept current. A file keeps its own bullets, numbering and indents, and only the lines of changed blocks are rewritten (`src-tauri/src/mirror/splice.rs`). **Two-way** (*Read changes back*, on by default; `src-tauri/src/mirror/ingest.rs`): a file edited outside is read back once it settles, as are a new file, a rename and a move between space folders; a file deleted outside moves its page to the Trash. Each ingest is one undo, and a block both sides changed is kept twice with a warning. Attachments can be copied beside the pages (`src-tauri/src/mirror/assets.rs`). **Fenced:** off by default, desktop only, one device per folder, and it starts from an empty folder; it pauses instead of emptying the vault when the folder or its marker is missing. On `main`; the latest release has the writing half only | Better vs 2.0; short of OG |

## 3. Editor & Formatting

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Markdown support | Full Markdown (OG) | **Subset**, one grammar shared by import, paste, Edit as Markdown, copy, export, the mirror and MCP (#6277). Ships bold, italic, code, strike, highlight, underline, headings, backtick and tilde fences, math, tables with column alignment, quotes/callouts, ordered/bullet/task lists, images, rules, autolinks and **footnotes** (#6033). **Missing:** setext headings, which read as text (`docs/architecture/editor-and-content.md`), and indented code, reference links, definition lists, HTML other than `<u>` and sub/superscript (no reader in `src/editor/markdown-parse/parser.ts`) | Partial |
| Markdown round-trip | Files are the source of truth | **Normalizing in the database, form-keeping in the mirror.** Stored text is the editor's form (#5148, #5161, #5164, #6277): CRLF → LF, underline as `<u>`, another tool's highlight and math rewritten to Agaric's. A mirrored file keeps its own bullets, numbering and indents, and only the lines of changed blocks are rewritten (`src-tauri/src/mirror/splice.rs`, property-tested; #6505, #6507). Unknown editor nodes are dropped **with a once-per-session toast** (`src/editor/markdown-serialize-toast.ts`) | Partial |
| Org-mode | Full `.org` (OG only; 2.0 dropped it) | Not an editing format. `.org` files import as an outline (#6033): headlines, TODO keywords including `#+TODO` sets, `[#A]`, SCHEDULED/DEADLINE, drawers, tags and links. Org emphasis stays text, and there is no `.org` export | Design choice |
| Bold / italic / strike / highlight / code | `**` `*` `~~` `^^text^^` `` ` `` | `**` `*` `~~` `==` `` ` ``, each with a shortcut; CommonMark flanking rules (#5208, #5210); inline code `Ctrl+Shift+K` (#6022) | Done |
| Underline | No dedicated mark | Underline mark, `Ctrl+U` | Better |
| Headings | `# H1`–`###### H6`; 2.0.2 "Clear heading" slash | `/h1`–`/h6`, `Ctrl+Alt+1..6`; Turn into offers H1–H3 only | Done |
| Code blocks | Fenced, syntax-highlighted | Fenced with lowlight; the language is picked in the block toolbar or page mode's code bubble (`docs/features/editor.md`) | Done |
| Math / LaTeX | `$$…$$` native; 2.0.2 math-block save fix (#13672); a forum report of LaTeX breaking in 2.0.2 is unverified | `$…$` inline + `$$…$$` block, KaTeX lazy-loaded, raw-source node view (#5642, #5704) | Done |
| **Mermaid diagrams** | **Plugin only** | ```` ```mermaid ```` fences render inline in editor and renderer, raw-source toggle, lazy-loaded (#5642, #5690) | **Better** |
| Tables | Markdown tables | Pipe tables that keep their column alignment (#6277); `/table` opens a size grid (#5774); a handle on each row and column, in blocks and in page mode, inserts, moves, sorts and deletes, and drags to move; `Alt+Shift+Arrows` move the cursor's row or column (#6607) | Better |
| Callouts | Plugin/CSS convention | The built-in styles (`CALLOUT_TYPES` in `src/components/RichContentRenderer/context.ts`), `> [!TYPE]` shape, type chosen from the block menu (#5694). Obsidian's, GitHub's and GitLab's types show in the nearest style and keep their name; `-` / `+` fold a callout to its title, not saved (#6033, #6277) | Better |
| Lists | Outline bullets are the list | Real ordered/bullet/task list nodes, plus `listStyle` bullet and numbered *blocks* with Enter/Backspace continuation (#4552, #4807) in both modes (#5825). A task is a third kind: it shows its checkbox and no marker, and becoming one takes the bullet or number off (#6167) | Done |
| Slash commands | ~20+; 2.0.2: `/code`, `/calc`, `/quote` on a non-empty block insert a new block (#13736) | Base commands plus sub-options surfaced as you type, recents band; includes `/embed`, `/voice`, `/turn` and `/meeting` (#5364). Page mode runs the same handlers (#5866) except `/duplicate`, `/template` and `/meeting` | Better |
| Inline pickers | `[[`, `((`, `/`, `#` | `[[`, `@`, `#` (#5205), `((`, `/`, `::`, `:` (emoji), `{{` (query) | Better |
| Formatting toolbar | None (keyboard only) | Standing bar with Format and Turn-into popovers, link/ref/tag/query/emoji/table/priority/date/todo/property controls, undo/redo, width-aware overflow, plus a selection bubble. The same bar sits above page mode and the Edit as Markdown buffer, pinned above the keyboard on touch (#5691) | Better |
| Property value autocomplete | Suggests previously-used values | **Only in the search DSL's `prop:key=value`.** The `::` picker completes keys only | Partial |
| **Page mode** | Block-at-a-time editing in both versions (2.0.2 still a per-block textarea, #13211) | One WYSIWYG document per page, saved per block, ids kept (#5721, #5691): the block toolbar, a grip and chevron per block, bubble menus for links, tables and code, touch support, and the journal's Daily view. `Ctrl+E` or Settings › Editor. **Fenced:** off by default (`EDIT_MODE_PREFERENCE` in `src/lib/preferences.ts`); pages over `PAGE_MODE_BLOCK_CAP` blocks (`src/editor/page-mode/page-mode-fit.ts`) and the journal's week and stream views stay in blocks (#6079); every block is drawn, so a key costs more the longer the page (#6224); no zoom, `/template`, `/duplicate`, `/meeting` or embed unlock; markers commit when the caret leaves a block | Done (opt-in) |
| **Markdown reveal** | The block being edited *is* raw source (textarea) | WYSIWYG that shows the syntax around the caret: the markers of bold, italic, code, strike and highlight, a heading's `#`, an external link, chips and, to read only, a quote's `>`, a callout's first line, code fences, math `$` and footnote brackets. Not lists, tables or underline (`src/editor/extensions/markdown-reveal.ts`; #5699, #5750, #5988, #6020, #6024, #5691). On by default | Done |
| **Markdown paste** | Not re-verified this revision | Multi-line Markdown splices into blocks; HTML goes through the same reader; `Ctrl+Shift+V` pastes plain; a toast offers Undo and "Paste as text" (`src/components/block-tree/paste-into-block.ts`, `src/editor/html-to-blocks.ts`; #5154, #5166, #6019). A paste also reads Obsidian Tasks fields, `![[Note]]` embeds and Logseq's `^^highlight^^` (#6277, #6033) | Done |
| Typed tags and task markers | `#tag`, `TODO` typed in text are native | `#name` becomes a tag on a boundary or save (#5205, #5215, #5777); `[ ]`, `[/]`, `[x]`, `[-]` become task states (`src/editor/extensions/task-paragraph.ts`) | Done |
| **Obsidian-style chords** | Own keymap (`g n` / `g p`, `Alt+Right` zoom), configurable | `Ctrl+E` page mode, `Ctrl+1..9` tabs, `Ctrl+Shift+T` reopen tab, `Ctrl+O` quick switcher, `Ctrl+P` palette, `Ctrl+Alt+←/→` back/forward, `Alt+1..9` spaces (#6022, `src/lib/keyboard-config/catalog.ts`); all rebindable | Done |
| Images and media | Images; 2.0.2 resizable video embeds, JPEG XL | Resize handle (#5343), collapsible (#4859), voice notes (#5484, #5833). A recording block pairs its audio with a transcript whose timestamps seek the player (#5410); `/meeting` makes a dated meeting page from a template (#5364); the OS voice reads a block or page aloud on macOS, Windows and Android, not Linux (#5745, #6484, `src-tauri/src/commands/speech.rs`) | Done |

## 4. Linking System

Agaric's weakest domain against Logseq: block references are chips, not inline content.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Page links | `[[page name]]`, human-readable in the raw file; 2.0.2 rename updates link mirrors | `[[ULID]]` chips, title resolved at render. Robust to renames, and opaque only inside the database: Edit as Markdown, copy, export, the mirror and MCP all write `[[Title]]` (#6277). A typed `[[Page#Heading]]` or `[[Page#^id]]` stores a reference to that block (#6033). `Ctrl+click`, a middle click and `Alt+Enter` follow a link, the first two into a background tab (#5691). Picker searches **pages only**. An unresolvable target reads `[[01HZAB12...]]` as a removable chip (#5863) | Partial |
| Block references | See §1; inline content and a count badge are **unverified** in the docs | Chip + peek (see §1). The peek shows full content, but nothing renders inline, and there are no children and no in-place editing | Partial |
| Hover preview | Breadcrumb + children on hover | The block-ref peek (`src/hooks/useBlockRefPeek.ts`), and a preview of a page's first blocks on `Ctrl`/`Cmd` + hover over a page link (#5691). Pointer only: on touch a chip opens its target | Done |
| Block embeds | `{{embed ((uuid))}}` embeds the whole block (see §1) | Content-only rows, editable behind an unlock (see §1) | Partial |
| Page embeds | `{{embed [[page]]}}` | `{{embed [[ULID]]}}` renders the page's top-level blocks, with the block-embed limits; a whole-block `![[Name]]` makes one, creating the page if no page has the name (#6313) (`src/lib/embed-token.ts`, #4572) | Partial |
| Custom link labels | `[label](((uuid)))` and `[text]([[page]])` | `[[Page\|label]]`, stored as `[[ULID\|label]]` (#5175); `[[Page#Heading]]` links the heading block (#5178). Logseq's `[label]([[Page]])` is read on import and paste and keeps its label (`docs/features/import-export.md`); its `[label](((uuid)))` form was not found in the reader | Partial |
| Reference counter | Per-block count badge on the source block | Page totals in the Linked References header, per-day badges in journal views, and a count in the peek. **No badge on a referenced block** | Partial |
| Linked references | Grouped by page, filter bar; 2.0.2 shows them on tag pages (#13440) | Grouped by source page, paginated, server-side filters, with an All / Page links / Block refs toggle (#4943). On a **block** only while it is zoomed (`src/components/backlinks/LinkedReferences.tsx`, #4945) | Partial |
| Unlinked references | Plain-text mentions; 2.0.2 matches aliases (#13706) | "Link it" conversion, grouped, paginated. Pages only (`src/components/pages/PageEditor.tsx`); absent from journal days | Partial |
| Link kinds distinguishable | Refs and links are distinct entities | `block_links` carries a kind (`src-tauri/migrations/0119_block_links_kind.sql`, #4943); a block embed counts as a block ref, a page embed as a page link | Done |
| Backlink filtering | Simple filter bar | Server-side `FilterExpr` tree with And/Or/Not and keyset pagination; Created date and source-page include (#5595), sort picker (#5702) | Better |
| Graph view | Local + global; 2.0 ships Graph View V2 | Global force-directed graph plus local graph (#5459), select-and-walk (#5537), labels (#5540), restored layout (#5514). The edge set is capped (`PAGE_LINKS_EDGE_CAP`) | Done |
| Link fidelity on export | Files already contain the names; 2.0.2 exports a ref to a missing block as `((uuid))` (#13717) | Export, copy and the mirror write `[[Title]]`, `#name`, a label as `[[Title\|label]]`, a block ref as `[[Page#Heading]]` or `[[Page#^id]]`, an embed as `![[…]]` and a ref-typed value as a link (#6277, #6457). A folder import of an export restores block refs and embeds, pinned by a test (#6502) | Better |

## 5. Properties

Logseq 2.0 turned this into its strongest domain. Agaric is behind, not ahead.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Typed values | OG: untyped text. **2.0: typed** Text, Number, Date, DateTime, Checkbox, Url, Node, and the `:schema :type` registry lists more (e.g. `:page`), with correct numeric sort; 2.0.2 adds Number defaults (#13724) | Text, number, date, select, ref, boolean, **url** (`src-tauri/migrations/0120_property_definitions_allow_url.sql`, #5142) | Done |
| Schema registry | 2.0: properties are pages with their own config | `property_definitions` **per space** (`src-tauri/migrations/0129_property_definitions_per_space.sql`), synced as ops with the later change to a key winning (#5841). Settings › Properties shows how many live blocks use each key, renames a key, merges it into another, changes its type with a preview, renames a select option, and lists, converts or moves the values that do not fit (#5841, #6206), which are marked on their chip, in the Properties table and in the drawer (#6238). The built-ins are code constants (`BUILTIN_PROPERTY_DEFS` in `src-tauri/agaric-store/src/op.rs`) and locked (`BuiltinPropertyLocked`, #6017) | Done |
| Multi-value | OG: opt-in comma splitting. **2.0: first-class multi-value on most types** | **Absent.** `PRIMARY KEY (block_id, key)` makes it structurally impossible (#6741) | Gap |
| Default values / choices | 2.0: default value, enum choices with icons + ordering, per-tag scoping, checkbox-state mapping | `select` options only; `todo_state` and `priority` options now frozen (#6017) | Partial |
| Property display control | 2.0: UI position, hide-by-default, hide-empty | Fixed layout: inline chips (ref and boolean chips, #5862) + drawer | Gap |
| Constrained references | 2.0: a Node property can be constrained to nodes carrying a given tag | `ref` type accepts any page | Partial |
| Bidirectional properties | 2.0: reverse lists surface on the target automatically | **Absent** | Gap |
| Built-in properties | ~15 editable + ~8 hidden | Code-defined built-ins (`BUILTIN_PROPERTY_DEFS` in `src-tauri/agaric-store/src/op.rs`): `todo_state`, `priority`, `due_date`, `scheduled_date`, `created_at`, `completed_at`, the `repeat*` keys, `space`, `is_space`, `listStyle` and, since #5364, `meeting_date`. `status`, `url`, `effort`, `assignee`, `location` are the editable definitions a new space starts with | Done |
| Property-based queries | Simple `(property k v)` + full Datalog | Comparison, range and existence operators across number, date, text and ref values in the query builder (`ALL_PROPERTY_OPS` in `src/components/PageBrowser/add-filter/vocab.ts`, #4569); the Pages browser filter offers the smaller `PROPERTY_OPS`; boolean is existence-only | Done |

## 6. Tags

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Inline tag syntax | `#tag` / `#[[multi word]]`: tags are pages | `#[ULID]` chip with resolved name; typed `#name` becomes a tag on blur or save (#5777), by Obsidian's rule that a tag starts the text or follows whitespace. A new tag name holds no whitespace, so `#[[multi word]]` becomes `multi-word` (`docs/features/tags-and-links.md`) | Done |
| Tags as pages | Yes. **2.0: tags are classes/supertags**: properties on a tag are inherited by tagged nodes; 2.0.2: tags extending Card are flashcards (#13540) | Tags and pages are separate `block_type`s. The read-only tag page lists tagged pages and blocks (#5695); tag colours sync as the tag's `color` property (#6544). A writable tag page and tags as classes are an open design question (#6755) | Design choice |
| Tag hierarchy | OG: `/` naming. **2.0: `Extends`, with multiple inheritance and a tag tree** | Prefix convention (`work/meeting`) matched with `LIKE` | Partial |
| Boolean tag queries | Via query DSL | `TagExpr` with Tag/Prefix/And/Or/Not, depth-gated, compiled to one pushed-down id-set subquery | Better |
| Tag inheritance in queries | 2.0: inherited class properties are queryable | Reachable from the Tags view's *Include nested blocks* switch (off by default; `src/components/filters/TagFilterPanel.tsx`, #4925), the `under:#tag` search token behind the tag page's "Search everything under #tag" (#5797), MCP `search`, and since #6742 the `TagUnder` filter leaf: `under:#tag` in a typed `{{query}}` block and MCP `query`. **Not** in the query builder's form, agenda filters or the Advanced Query view. Cache vs SQL agreement audited (#5671) | Partial |
| Tag usage counts | Shown in UIs | `tags_cache.usage_count`: live blocks in the tag's own space; template pages and their blocks are not counted (#6659) | Done |

## 7. Query System

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Simple queries | OG: `{{query (and [[page]] (task TODO))}}`, filters `and/or/not`, page ref, free text, `between`, `property`, `task`, `priority`, `page`, `namespace`, `page-property`, `page-tags`, `all-page-tags`, `sample`, `sort-by`. **2.0 replaces `{{query}}` with `/Query` nodes** and drops `all-page-tags` and `sort-by`; 2.0.2 isolates query errors (#13767) | `{{query …}}` blocks plus a **structured `v2:<base64url(JSON)>` payload** carrying an arbitrary `FilterExpr`; legacy text queries reroute onto the rich engine when translatable; the `backlinks` query type lists results again (#5815) | Done |
| Filter vocabulary | See above | The `FilterPrimitive` variants (`src-tauri/agaric-store/src/filters/primitive.rs`): Tag, TagOrRef, ChildOf, PathGlob, HasProperty, LastEdited, Space, Priority, State, BlockType, DueDate, Scheduled, Created, **LinksTo, LinkedFrom, HasParentMatching**, Orphan, Stub, HasNoInboundLinks, Regex, CaseSensitive, WholeWord, Snippet. Template pages and their blocks are left out unless a filter names the `template` property (#6643) | Better |
| Graph traversal | Full Datalog: arbitrary joins, variable-length paths, rules | **One hop plus ancestors.** `LinksTo`/`LinkedFrom` take a concrete id; `HasParentMatching` recurses (to `FilterExpr::MAX_DEPTH`). No transitive closure, joins or rules | Partial |
| Result transforms | `:result-transform` and `:view` evaluated by SCI (sandboxed Clojure) | **Absent.** Fixed folds (count/sum/avg/min/max); computed columns are an open design question (#6757) | Gap |
| Grouping | 2.0: group-by in the Views system | Every `GroupKey` is reachable in the builder (#4804, `src/components/AdvancedQuery/QueryControlsBar.tsx`). The list layout shows a bounded preview per group with no expand. Grouped by state or a select property, *View › Board* (`src/components/AdvancedQuery/QueryBoard.tsx`) lays the groups out as columns that load more on their own, with a *Move to…* menu that sets the state or property, undoable (#6542) | Done |
| Aggregation | `{{function (sum :qty)}}` + arbitrary SCI functions | count/sum/avg/min/max, global + per-group; the target can be a property (#4804) | Partial |
| Sorting | `sort-by`, table-header sort; 2.0.2 sorts missing values last (#13485) | Multi-key over a closed column set + bm25 relevance | Done |
| Query result table | `query-table:: true` + column picker; 2.0: Table/List/Gallery views with pinned, resizable columns and inline editing | Columns derived from the loaded rows' properties until picked; a column picker chooses and orders them, kept in the block; no widths or inline editing (#6743) | Partial |
| Live-updating results | Yes (DataScript reactivity) | Inline queries refetch on property and graph-structure events, including ones arriving by sync (`src/hooks/useQueryExecution.ts`, #5316) | Done |
| Saved queries | Query nodes live in the graph | Each saved view is a page of its space carrying the internal `saved_view` property (`src/lib/saved-views.ts`, #6544): it syncs, a deleted one waits in the Trash, and it stays out of page lists, the `[[` picker, the graph and search. The Pages view and Advanced Query both use them | Done |
| User-facing query language | Text you can read, diff, paste, version | **Partial.** A query block takes the search box's filter syntax as typed text (`{{query tag:#work state:TODO}}`, `src/lib/query-text.ts`), running every token the search box runs, free text and relative dates included, its tokens joined by AND, with no OR or groups yet (#6742); the builder writes that text for a filter it can say and `v2:<base64url(JSON)>` for the rest (#6628) | Partial |
| Cross-space queries | Multi-graph search is manual | **Impossible.** `space_id` is mandatory, including MCP `query` | Gap |

## 8. Task Management

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Task markers | OG: `LATER/NOW/DONE` or `TODO/DOING/DONE` + `CANCELED`, `WAIT/WAITING`, configurable. **2.0: one customizable, user-extensible set** | `none → TODO → DOING → DONE → CANCELLED → none`, locked in `src/lib/task-states.ts`, and since #6017 `todo_state` is a locked built-in. No WAITING | Partial |
| Priority levels | `[#A] [#B] [#C]`, fixed | **Fixed 1/2/3** (`PRIORITY_LEVELS` in `src/lib/priority-levels.ts`). #6017 removed the configurable levels; out-of-range legacy values get a neutral badge. Click-to-cycle, slash, `Ctrl+Shift+1/2/3`. On par with Logseq, **a regression from Better** | Done |
| Due / scheduled dates | Org-style `DEADLINE:` / `SCHEDULED:` lines | `due_date` / `scheduled_date` columns, slash commands, date pickers | Done |
| Recurrence | Repeaters `+` / `.+` / `++`, `Nd/Nw/Nm`. OG's `.+` advances from the *original* timestamp, contradicting its docs. 2.0.2: repeats advance in the local calendar, monthly without drift (#13615) | Modes `+` / `.+` / `++`; daily/weekly/monthly/**yearly**, `+Nd/+Nw/+Nm/+Ny`; end conditions; write-time validation; MCP `set_property` on `todo_state` recurs like the app (#5919, #5957). Completing creates a **new sibling**, so a daily habit accumulates one block per occurrence | Better |
| Recurrence projection | None | Projected occurrences in the Due Panel **and** the Agenda's Projected list (`docs/features/journal-and-agenda.md`) | Better |
| Task dashboard | OG: a "Scheduled tasks and deadlines" section + two default queries; no real agenda. 2.0: tag pages carry a Table view | Agenda with stackable filter dimensions (`ALL_DIMENSIONS` in `src/lib/filter-dimension-metadata.ts`), sort, group, cursor pagination; DonePanel; DuePanel; `UnfinishedTasks` rollover | Better |
| Time tracking | **OG: built-in, on by default** (`:LOGBOOK:` clocks). **2.0: status-change history with time spent** (display fix #13695) | **Absent** (#6745) | Gap |
| Effort tracking | Arbitrary custom properties | `/effort`, a fixed select (`EFFORT_COMMANDS` in `src/lib/slash-commands.ts`); `effort` is now a removable, non-built-in definition | Done |
| Overdue accumulation | Via embedded queries | DuePanel overdue section + the `UnfinishedTasks` rollover | Better |
| Deadline warning period | `:scheduled/future-days` | Configurable in **Settings → Tasks & reminders** (#5635) | Done |
| Task / deadline notifications | Plugins only | **Desktop, while running, off by default** (#4806, `ReminderSettings` in `src-tauri/src/reminders.rs`): one notification per open task on its `due_date`. Nothing with the app closed, on Android, for `scheduled_date`, ahead of time or as catch-up; #5839 fixed the job running every other tick | Partial |
| Calendar integration | Plugins only | **Absent, deliberately reverted** (migration 0091). No CalDAV, no ICS | Gap |

## 9. Daily Journal

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Auto-created daily page | On launch; 2.0.2 keeps date-only `createJournalPage` on that day (#13597) | On launch with template applied; pages created in Stream or by the date picker reach Day mode | Done |
| View modes | One scrollable view; 3 journals, +7 per scroll, not configurable | Daily, Weekly, Monthly, Agenda and Stream (`JournalMode` in `src/stores/journal.ts`); the Daily day opens as a page does, with the Blocks \| Page switch and `Ctrl+E`, while Weekly and Stream edit in blocks (#6077); the week view copies, cuts and pastes a selection across days | Better |
| Date navigation | `g n` / `g p`, date picker | Prev/next per mode (none in Stream and Agenda), `Alt+Left/Right`, `Alt+T`, a calendar with content dots per day (`DOT_MODIFIERS` in `src/components/journal/JournalCalendarDropdown.tsx`); a *Today* button in every other view's header (`src/components/agenda/GlobalDateControls.tsx`, not on a touch phone) | Better |
| Drag-to-reschedule | No | Drop zones on weekly day sections, with a keyboard equivalent | Better |
| Configurable date format | **OG: `:journal/page-title-format`. 2.0 REMOVED the knob** | An allowlist of display formats in Settings → General (`JOURNAL_DATE_FORMATS` in `src/lib/preferences.ts`); display-only, stored identity stays ISO. A day's title is drawn in it in pickers, the Agenda, panels, search and references (`displayPageTitle` in `src/lib/date-utils.ts`, #6592), not in link chips or Pages rows | Partial |
| Natural language dates | In date pickers | `today`, `tomorrow`, `next <weekday>`, `in N days`, `end of month`, `+Nd`, ISO and more (`src/lib/parse-date.ts`). Missing: `last <weekday>`, `this week`, `next month`, `+Ny` | Partial |
| Journal templates | `:default-templates {:journals …}`. 2.0: apply-template-to-tag | Template pages applied wherever a day is created (app, MCP, Quick Capture) in the caller's transaction, so one undo reverts both, with properties carried (#5373, #5395). The per-space override was retired (#5405) | Better |
| "On this day" | Possible via Datalog | **Absent** | Gap |

## 10. Search

Agaric's strongest domain. Its index advantage now holds against OG only.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Full-text search | **OG**: FTS5 with the default `unicode61` tokenizer on desktop, `LIKE` fallback; browser uses Fuse.js. **2.0**: FTS5 with `tokenize="trigram"` in the DB worker since 2024-07-20, `LIKE` for ≤ 2-char queries; 2.0.2 reindex and Unicode fixes (#13475, #13761) | FTS5 trigram, bm25, keyset pagination, same engine on every platform | Better vs OG; tie vs 2.0 |
| CJK / substring search | **OG: broken**: `unicode61` cannot segment CJK. **2.0: same engine class as Agaric**; CJK behaviour not tested | Substring and CJK via trigram; a word under three characters is dropped from the query (`TRIGRAM_MIN_LEN` in `src-tauri/agaric-store/src/fts/search/sanitizer.rs`), a two-character CJK word included, and the search box says so (#6752) | Better vs OG; tie vs 2.0 (untested) |
| Semantic search | **2.0**: hybrid vector + keyword (#12710), opt-in, macOS ARM64 only, off by default | **Absent** | Gap |
| Search filter language | Combine `Ctrl+K` with filters informally | **Inline DSL**: `tag:`, `under:`, `path:`, `not-path:`, `state:`, `not-state:`, `priority:`, `not-priority:`, `due:`, `scheduled:`, `prop:`, `not-prop:` and bare `#tag` (`src/lib/search-query/register.ts`), with validation, chips, autocomplete and a helper popover. Different filter kinds AND; repeated `state:`, `priority:` and `path:` OR; repeated `tag:` and `prop:` AND; `AND` / `OR` / `NOT` act on the free text only (`docs/SEARCH.md`) | Better |
| Search scope | Pages + blocks, filterable | Space scope, page-name GLOB include/exclude, block-type filter, partitioned palette endpoint: the fields of `SearchFilter` (`src-tauri/agaric-store/src/search_types.rs`); result counts say what they count (#5810) | Better |
| **In-page find (`Ctrl+F`)** | **None** | Case, whole-word and **regex** toggles, live counter, cycling, Unicode-correct folding; `Ctrl+H` replaces one or all matches in blocks and in page mode, and the Search view replaces across pages with a preview and an undo (`docs/SEARCH.md`) | **Better** |
| Long-block indexing | **OG**: blocks over `:block/content-max-length` (10000) become unsearchable. 2.0: unverified | Per-block FTS cap with explicit handling | Better vs OG |
| Recent pages | In search results | Per-space "Recent" list on an empty query | Done |

## 11. Spaces (Workspaces)

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Multiple contexts | One graph per instance; 2.0 adds tabs and windows | `space` blocks partition one DB; every command takes one space (#5538, #5546) | Better |
| Per-space journal / tabs / recents | N/A | Journal keyed `(date, space)`; `tabsBySpace` + `recentPagesBySpace` | Better |
| Per-space identity | N/A | Accent colour, top stripe (`SpaceTopStripe`), sidebar badge, the space's name in the window title (`docs/features/spaces.md`) | Better |
| Quick switching | Graph switcher | `Alt+1` … `Alt+9`, rebindable (#6022) | Better |
| Cross-space links | N/A | Enforced at write time; broken-link chip, click removes, `Ctrl+Z` restores | Better |
| Manage UI | N/A | Settings › Spaces: create, rename, accent, "Open on launch" (#5362), safety-checked delete | Better |
| **Per-space sync scope** | N/A | **Not a thing.** A session syncs every space; no selective sync | Gap |

## 12. AI / Agent Integration

Agaric's MCP is scoped per agent. Logseq 2.0's MCP is served over a local HTTP port and is reachable from browser clients.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| MCP server | **2.0** (desktop Settings → AI, or the CLI), served by the local HTTP server at `127.0.0.1:12315` with a bearer token (docs): `pretend` dry-run, undo/redo integration; 2.0.2: `/mcp` usable from browser MCP clients (#13312), CLI password login (#13270) | `agaric-mcp` sidecar over one Unix socket / named pipe, owner-only, never TCP, off by default. Each client is an **agent** with a name, mode (RO/RW), space allow-list and token (#5759, `src-tauri/migrations/0125_mcp_agents.sql`); Settings lists, creates and revokes agents (#5710). Tokens sit plaintext in a device-local table | Tie |
| Tool surface | Search, create and list pages, tags and properties, add blocks, edit block titles; 2.0.2 `upsert block --blocks` takes Markdown (#13377). The docs' TODO list still reads "Edit pages, tags and properties" and "Read and write block children" | A read-only set and a read-write set (`src-tauri/src/mcp/registry.rs`; a read-write agent gets both): page/block history, journal, trash, `resolve`, `query` (#5542), `list_property_defs`, `capture`, `restore_block`, `get_page_markdown`, `append_markdown` and `edit_page_markdown` in the one text format (#5462, #5554, #6277), `move_blocks`, `batch`, `undo`, `set_page_aliases` (#5570), `move_page_to_space`, `attach_file`, `list_attachments` and `add_meeting` (#5410, #5364); links by name (#5539) | Better |
| Auditability | Undo/redo integration | Every op stamped `agent:<name>`; the History view badges each agent op with its agent's name (`src/components/HistoryListItem/HistoryItemCore.tsx`), with no filter by agent; an **in-memory** activity log of `ACTIVITY_RING_CAPACITY` entries with session revert (`src-tauri/src/mcp/activity.rs`) | Done |
| Isolation | Graph-scoped; master-only PATs carry read/write scopes, expiry, revocation (#13019) | Per-agent token, mode and space allow-list, but **"not isolation"** per `docs/features/agent-access.md`: links, history and refusal messages cross spaces; no rate limiting | Partial |
| Programmable API | Plugin API (`@logseq/libs`), a local HTTP server at `127.0.0.1:12315` with a token (docs), a `logseq` CLI and nbb scripting. A REST API with graph-scoped tokens is merged on master (#13019); whether a release carries it is **unverified** | MCP, `agaric-mcp call <tool> <json>` for scripts with the same token, mode and spaces, and `agaric://` links (page, block, settings, `capture?text=`; desktop only; the page menu's *Copy app link* copies the page's) (`docs/features/agent-access.md`). On desktop the Markdown mirror is a second seam: its files are written and read back, so any tool can edit them (#5363). No plugin API and no change notifications (#6552) | Partial |
| In-app AI features | GPT plugins; 2.0 semantic search (§10) | **None**; voice notes record only (#5833) | Gap |

## 13. Sync & Storage

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Transport | OG: files + third-party sync. 2.0: RTC to a server | **iroh QUIC over UDP** (iroh, pinned exactly in `src-tauri/agaric-sync/Cargo.toml`), TLS 1.3 in the handshake, ALPN `agaric/sync/0` (`SYNC_ALPN` in `src-tauri/agaric-sync/src/transport/service.rs`) | Done |
| Cost / account / server | **2.0**: a paid feature for Open Collective backers and sponsors, or self-hosted by running the sync server (docs). OG: its docs describe Logseq Sync, a paid beta for the same contributors | **Free, no account, no server.** Two devices pair and sync directly | Better |
| Peer identity | Account-based | ed25519 endpoint id, TOFU-bound into `peer_refs.endpoint_id`; the key is `sync-endpoint.key`, one hex line readable by its owner only (`src-tauri/agaric-sync/src/transport/identity.rs`), **not in an OS keychain** | Done |
| Discovery | Server | **mDNS** (`_agaricv1._udp.local.`, plus an Android `MulticastLock`); a paired device that mDNS has not surfaced can be given a manual `host:port` on the same subnet (`set_peer_address` in `src-tauri/src/commands/sync_cmds.rs`), and Settings shows this device's own address (#6703). Devices on different networks cannot find each other | Done (one network) |
| Pairing | Account login | 4-word passphrase or QR, proven inside the first `HeadExchange`; a time-limited window (`PAIRING_TIMEOUT`); a peer that has not answered yet is redialled (#6451, #6458) | Done |
| Pairing fallback | N/A | The QR carries the responder's dial address and device id, so a first pair needs no multicast; passphrase-only pairing still does | Done |
| Remote / internet sync | 2.0 RTC syncs over the internet; the README still calls RTC **alpha** | LAN by default. An **opt-in internet fallback** (Settings → Sync & devices, #4549; `internet_relay_url` in `src-tauri/agaric-sync/src/transport/endpoint.rs`), on both devices, from the next launch: sync goes through a relay run by iroh's maintainers when the direct path fails, and a paired device the LAN no longer sees is also dialled through it at each periodic sync. It does not discover: a first pair needs one network, and a sync across two networks is untried (#6519) | Design choice |
| Conflict resolution | OG: file-level (fragile). 2.0 RTC: alpha per the README; 2.0.2 keeps property-value replacements together | **Loro CRDT** per space: `LoroTree`, `LoroText`, `LoroMap`; SQL tree columns are derived. Move/replay ordering fixed (#5711, #5720); purges wait until every space lands (#5712) | Better |
| **What does not converge** | — | Attachments (#5608, #5728), property definitions (#5841), saved views (pages, #6544), bookmarks with their order (a page property, #6640) and tag colours (#6633) converge. Still true: the **op log is audit-only across peers**, and collapse state and the mirror setting are per device. Two devices on different engine formats do not sync until both update (`ENGINE_FORMAT_VERSION` in `src-tauri/agaric-engine/src/loro/engine/mod.rs`). A quarantined delta is listed in Settings › Sync & devices and can be retried at the next start (#6057) | Partial |
| Sync direction | Bidirectional | **A session is a pull** (responder → initiator, `docs/architecture/sync-protocol-spec.md`); two-way needs two sessions. A local edit asks the scheduler for a round after `LOCAL_EDIT_DEBOUNCE` (`src-tauri/agaric-sync/src/sync_scheduler.rs`), and a responder that served a peer holding changes it lacks asks for a round back when the session ends (#6676) | Partial |
| **Multi-device, verified** | Widely used (and widely complained about) | **CI-verified two-way**: `e2e-tauri/sync-two-device.e2e.ts` against a headless peer (`e2e-tauri/sync-peer.ts`) pairs, edits each way, sets a property, moves, makes concurrent edits to one block, sends an image each way, cancels and unpairs; required on `main` via `e2e-tauri-gate` (#5996). The lane also syncs property definitions, a large vault, a contested page name and a mirrored file (`e2e-tauri/property-defs-sync.e2e.ts`, `e2e-tauri/sync-large-vault.e2e.ts`, `e2e-tauri/page-name-tie-sync.e2e.ts`, `e2e-tauri/mirror-sync.e2e.ts`). **In daily use between Android and Linux, both directions** (maintainer report). Unproven: devices on different networks, a restrictive network; there is no iOS | Done (one network) |
| Sync controls | — | **Cancel** at dial or mid-session (#5739); per-peer **progress** in messages, files and bytes (#5842); a paired device that is away reads *Waiting for …, last synced …* and not as a failure, and *Last synced* survives a restart (#6657, #6710); a press on Sync clears that device's backoff and dials (#6676); a version mismatch names the device to update (#5728, #6657); a space held back from sending is named in a warning (#6687) | Done |
| Op log / history | Timestamps only | Append-only blake3 hash chain, SQL-trigger-enforced, per-device sequences, paginated history; the legacy CBOR path that wiped it is deleted (#4693) | Better |
| Snapshots / compaction | 2.0: **automated backups** on desktop and in the browser only, the newest ones kept (docs) | The whole-vault zstd-CBOR blob is gone (#4699); catch-up is a per-space Loro merge with bounded payloads (#5838); compaction saves the engines, then purges ops past the retention window (`save_engines_then_compact` in `src-tauri/src/commands/compaction.rs`, `DEFAULT_RETENTION_DAYS`). Residual: the disaster-path op-log replay buffers the whole log; peak RAM unmeasured | Done |
| **Backup / restore** | 2.0: automated on desktop and in the browser, and a CLI `graph backup` command that restores one (docs); none on mobile | A daily snapshot of the database beside it, the newest few kept (`MAX_KEPT_DAILY_SNAPSHOTS` in `src-tauri/src/db/daily_snapshot.rs`), plus a copy before each migration (`MAX_KEPT_BACKUPS` in `src-tauri/src/db/pool.rs`); **nothing in the app reads a snapshot back** (#6744). Restore is an export imported again: a folder pick of an unzipped *Export all spaces* ZIP restores every space (#6554) with typed properties, attachments, block refs, embeds, templates and done dates, but without history, block ids, trash or device state. On desktop the Markdown mirror is a standing plain-file copy | Partial |
| Crash recovery | Filesystem journaling | Boot recovery (`recover_at_boot`: replay unmaterialized ops, reconcile drafts) plus a disaster path that ends engine-first (`reproject_blocks_from_engine`); an integrity check in Settings › App health (#5360, #5361); engine vs SQL audits (#5671); derived tables carry a version checked at boot, and the report says which tables are stale caches and which rows disagree with the engine (#6488, #6497). A full, read-only or corrupt disk is named in one banner (`src/components/common/StorageFailureBanner.tsx`, #6696), and on desktop the boot-failure dialog links the recovery steps and opens the data folder (#6681) | Better |
| Encryption at rest | OG's Logseq Sync: age end-to-end. 2.0: encryption password (Settings › Encryption); E2EE key wrapping merged (#13671), deployment unconfirmed | **None.** Database, attachments and the ed25519 key sit behind filesystem permissions | Gap |
| Supply-chain assurance | Standard CI | SLSA provenance, Scorecard, CodeQL, blocking `cargo-deny`/`cargo-audit`, threat model; a release publishes only after the real-backend lane passes (`.github/workflows/release.yml`). **No desktop code signing** | Better |

## 14. Templates

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Template creation | Block/page with `template:: name` | `template=true` pages, "Save as template", a Templates view. Template pages and their blocks stay out of queries, saved views and tag pages unless a filter names `template` (#6643) | Better |
| Template insertion | `/Template` picker | `/template` picker: one `createBlocksBatch` call lands the whole template in one transaction, so a failed insert lands nothing and one `Ctrl+Z` takes it back (`insertTemplateBlocks` in `src/lib/template-utils.ts`, #6530). Absent in page mode | Done |
| Dynamic variables | `<% today %>`, `<% time %>`, `<% current page %>` | Two grammars: legacy (`today`, `time`, `date±N`, `weekday`, … with `:FORMAT` in date-fns tokens or their Moment spellings, so an Obsidian `{{date:dddd, MMMM Do}}` works, #6300) and `{{date}}`, `{{time}}`, `{{title}}`, `{{cursor}}`; `<% recording %>` marks where `/meeting` puts its recording block, and `/template` and a new day leave it out (#6432, #6482); journal weekday/month names English-only (`src-tauri/src/commands/journal.rs`) | Better |
| Default journal template | `:default-templates` | `journal-template=true` pages, applied in the caller's transaction (#5395) | Better |
| Template including parent | `template-including-parent:: true` | **Absent** | Gap |
| **Block properties in templates** | Carried through; 2.0.2 tag-template fixes | **Both carry them:** journal templates (`copy_page_blocks_in_tx` in `src-tauri/src/commands/pages/markdown_paste.rs`, #5395) and `/template` (`copiedProperties` in `src/lib/template-utils.ts`): task state, priority, dates and custom properties, typed ones included | Done |

## 15. Import / Export

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Import formats | OG: Roam JSON, OPML, Markdown (**unverified**: the docs' Import page is a stub). 2.0: SQLite, File-to-DB, EDN (docs) | Markdown, text and Org files, a folder, an Obsidian vault (`![[…]]` embeds, `[[Note#Heading]]` and `^id` anchors resolved across the folder, Tasks fields, image sizes), a Logseq graph folder, a Notion export folder, `.enex`, `.jex`, BibTeX / CSL-JSON (`src/components/settings/ImportSection.tsx`, `docs/features/import-export.md`; #6033) | Better |
| Import from Logseq | N/A; 2.0.2 improves File-to-DB fidelity | A folder holding `logseq/config.edn`, or both `pages/` and `journals/`, is read as a graph (#6033): `___` and legacy `.` namespaces, `title::`, journals as journal days by the config's file-name format, links to them by Logseq's journal title, page properties, `id::` anchors that `((uuid))` and `{{embed ((uuid))}}` resolve to **across the folder's files**, task keywords, `[#A]`, SCHEDULED/DEADLINE with repeaters, admonitions, `^^highlight^^` and image sizes. Read from the docs and tests; no run against a real graph was made for this revision | Done |
| **What Logseq import drops** | — | Logseq `{{query}}` macros and whiteboards are not translated; `:LOGBOOK:` clocks are dropped with a warning (#6745); a `((uuid))` to a block outside the import is stripped and counted; custom task keywords fold into the four fixed states; blocks nested past `MAX_IMPORT_DEPTH` are flattened to it (`src-tauri/agaric-engine/src/import.rs`); `collapsed::` applies on the importing device only | Partial |
| Import merge | N/A | A Markdown file, a folder's note, an Evernote or Joplin note, or a Logseq or Org file whose title names a page with content **updates that page in place** after listing the pages and asking, as one undo; importing it again changes nothing (#6277). A second file of the same import with that title becomes `Title (2)`. Two synced devices that each import one corpus still end with doubled pages, the newer of each pair renamed `Name (2)` (#6278) | Partial |
| Import from Roam | Native JSON | **Absent** | Gap |
| Markdown export | Full graph | **"Export this space"** and **"Export all spaces"** ZIPs with `assets/`, `.agaric/space.json` (property definitions, and titles a file name cannot spell) and `.agaric/export-report.txt` (`src/lib/export-graph.ts`); a folder import of the unzipped export restores it (#6277, #6554). Both rows are disabled on Android (#6546). Per-page `Ctrl+Shift+E` copies to the clipboard, and *Save as Markdown file* saves `<title>.md`, not on Android (`src/components/pages/PageHeader.tsx`). *Print…* in the page menu prints the page alone on the light palette (#6721). On desktop the Markdown mirror (§2) keeps every page as a file | Better |
| **What export drops** | Files are the format | History, trash, saved views, the keyboard map, sync state and other device-local state; a tag is written only as its `#name` reference, so its own properties, its colour included, are dropped; built client-side with JSZip, so a large vault sits in memory | Partial |
| JSON / EDN / OPML export | OG: EDN, JSON, OPML, Roam JSON, HTML, Markdown. 2.0: SQLite, SQLite+assets zip, **Build EDN** (block, page or full schema) | **None.** `.agaric/space.json` carries property definitions and titles only | Gap |
| HTML publishing | OG: read-only SPA. **2.0: Logseq Publish** (paid, password-protectable, self-hostable); 2.0.2 excludes private pages (#13691) | **Absent** | Gap |

## 16. Mobile & Platforms

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Desktop | Linux, Windows, macOS | Linux x86-64 (deb/rpm/AppImage), Windows x64 (`-setup.exe` or MSI), macOS (x86_64 and aarch64 dmg). It updates itself from GitHub Releases and is in no store or package repository; a winget manifest is written, not submitted (`README.md`, #6713) | Done |
| Android | F-Droid serves the **file version**. For 2.0, **testing of a native app with backers has been announced** (Open Collective update); whether it began, and whether a public store listing exists, is **unverified** | Signed APK, **arm64-v8a, API 30+, sideload-only** (#79). The vault, device id and sync key are kept out of Android backup and device transfer, so a new phone is set up by pairing and an uninstall deletes the phone's notes (#6587). A release-profile APK is installed and launched on an emulator before a release publishes, and nightly (`.github/workflows/android-launch-smoke.yml`, #6050); the same emulator checks the system-bar insets and that a typed block survives a force-stop (#6553); the real-phone checks are an open list (#6513) | Tie |
| iOS | The App Store serves the **file version**. 2.0: a native app in **testing with backers** (Open Collective update; docs: "invite only for now") | **Absent**: no target, none planned (#6739) | Gap |
| Mobile sync | RTC (the README calls it alpha); the iOS test app's announcement claims background sync | LAN sync, **foreground only** (`docs/architecture/sync-and-network.md`, #6740); in daily Android ↔ Linux use (maintainer report) | Partial |
| Phone UI | 2.0.2 popup and safe-area fixes | Phone layout overhaul with 44 px targets (#5941, #5948, #5955, #5957, #5958, #5969); page mode and its toolbar work on touch (#5691); read aloud through Android's `TextToSpeech` (#6484). The Markdown mirror is desktop only. Whether the folder pickers that the vault, graph and restore imports need work in the Android WebView is **unverified** | Done |
| Mobile plugins | **None on mobile, in either version** | N/A | Tie |

## 17. Out of Scope for Agaric

| Feature | Logseq | Notes |
| --- | --- | --- |
| Plugin / extension system | **A marketplace of plugins and themes**, desktop only per the file version's docs; only some declare DB support (`supportsDB` in the marketplace manifest), and a plugin with `effect: true` runs **un-sandboxed in the host origin**. Custom CSS and JS | **No plugin API, no user scripts.** A custom stylesheet restyles the app (Settings › Appearance › *Custom CSS*, `src/hooks/useCustomCss.ts`; the token list in `docs/features/appearance.md` is the compatibility promise). Built-in themes plus an OS-following auto, font sizes, motion controls, full keyboard rebinding. The seams are MCP (§12, with `agaric-mcp call` for scripts), `agaric://` links (desktop only) and, on desktop, the Markdown mirror's files |
| Flashcards / SRS | OG: SM-5. **2.0: FSRS, does not import SM-5 data**; 2.0.2 "practice again" (#13410) | Not priority per user |
| Whiteboard | OG: tldraw fork. **2.0: REMOVED**, with slides and Excalidraw | Not priority per user |
| PDF highlight-to-block | OG: highlights become blocks on an `hls__` page. 2.0: `#PDF Annotation` tag; 2.0.2 imports annotations | pdf.js reader with highlight + comment; saving bakes annotations into a new attachment, moves the owning block's `attachment:<id>` links to it and deletes the original (#6629); a link copied into another block still names the original. Each new highlight or pinned comment becomes a child block of the PDF's owner on Save, with a source chip that reopens the reader on its page (#6629); no existing annotation is imported |
| Zotero | OG: built-in. **2.0: REMOVED**, community plugin | BibTeX/CSL-JSON importer to typed reference pages |
| Org-mode | OG only; 2.0 dropped it | Design choice: `.org` files import as an outline (`docs/features/import-export.md`); no `.org` export, and Org is not an editing format |

## Scorecard

Two readings of the tables above.

### By row

Each line counts the rows of one section by the status Agaric earned there: **Ahead** is any Better, qualified or not; **Level** is Done or Tie; **Behind** is Partial or Gap; **Not ranked** is Design choice. A status with a qualifier ("Better vs OG; tie vs 2.0") counts by its first word. `node scripts/comparison-scorecard.mjs --write` recounts the table from the rows above.

<!-- scorecard:start -->
| Section | Ahead | Level | Behind | Not ranked |
| --- | :---: | :---: | :---: | :---: |
| 1. Block Model | 2 | 5 | 6 | 0 |
| 2. Page Model | 2 | 7 | 1 | 0 |
| 3. Editor & Formatting | 7 | 11 | 3 | 1 |
| 4. Linking System | 2 | 3 | 8 | 0 |
| 5. Properties | 0 | 4 | 5 | 0 |
| 6. Tags | 1 | 2 | 2 | 1 |
| 7. Query System | 1 | 5 | 6 | 0 |
| 8. Task Management | 4 | 4 | 4 | 0 |
| 9. Daily Journal | 4 | 1 | 3 | 0 |
| 10. Search | 6 | 1 | 1 | 0 |
| 11. Spaces (Workspaces) | 6 | 0 | 1 | 0 |
| 12. AI / Agent Integration | 1 | 2 | 3 | 0 |
| 13. Sync & Storage | 5 | 8 | 4 | 1 |
| 14. Templates | 3 | 2 | 1 | 0 |
| 15. Import / Export | 2 | 1 | 6 | 0 |
| 16. Mobile & Platforms | 0 | 4 | 2 | 0 |
| **Total (165 rows)** | **46** | **60** | **56** | **3** |
<!-- scorecard:end -->

### By category, in points

A judgment, not a count: each product is scored 1 to 10 per category on what it ships. Logseq is scored on its latest release and Agaric on `main`, so a Logseq release that carries its master's work would move its columns. Unweighted sums treat "Extensibility" and "Data integrity" as equally important, which they are not for one person's notes.

| Category | Logseq OG | Logseq 2.0 (beta) | Agaric | What holds Agaric's score where it is |
| --- | :---: | :---: | :---: | --- |
| Block CRUD | 9 | 9 | 9 | |
| Page management | 9 | 9 | 9 | Names made on two devices settle after a sync |
| Editor formatting | 8 | 8 | 9 | Page mode is opt-in and capped |
| Linking system | 10 | 9 | 7 | No inline reference content, no count on the referenced block, a pages-only link picker |
| Properties | 6 | 10 | 8 | One value per property, no defaults or display control |
| Tags | 8 | 10 | 7 | Labels, not classes |
| Query system | 9 | 9 | 8 | A board, picked columns, text queries and synced views; no Datalog, AND-only text |
| Task management | 7 | 8 | 8 | Fixed states, no time tracking |
| Daily journal | 8 | 7 | 9 | |
| Search | 5 | 7 | 9 | Terms under three characters are dropped |
| Templates | 7 | 8 | 8 | `/template` is one transaction and carries properties; not offered in page mode |
| Spaces | 2 | 3 | 9 | |
| AI / agent access | 2 | 8 | 9 | |
| Sync / storage | 4 | 5 | 7 | One network, foreground-only on Android, a snapshot nothing restores |
| Data integrity | 3 | 4 | 8 | |
| Performance | 3 | 7 | 7 | Page mode's per-key cost grows with the page; `loro` is held back (#3161) |
| Import / export | 9 | 8 | 8 | No structured export, no Roam import |
| Mobile | 5 | 4 | 5 | Sideloaded Android, no iOS |
| Extensibility / ecosystem | 9 | 6 | 3 | A stylesheet, MCP, links and the mirror's files; no plugin API |
| Project risk | 4 | 5 | 3 | One maintainer |
| **Total** | **127** | **144** | **150** | |

How to read it:

- **Agaric's lead over Logseq 2.0 in points is inside this instrument's noise.** One 2.0 release carrying its REST API, its import preview and a store listing for either native app closes it.
- **Weighted for one person's journal, tasks and project notes with no cloud, Agaric is ahead**: journal, search, spaces, sync, data integrity and agent access. Its losses are linking, properties, tags, queries and ecosystem.
- **Sync is the differentiator, within one network.** Elsewhere Agaric's devices cannot find each other.
