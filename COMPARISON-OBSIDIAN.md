# Agaric vs Obsidian: Feature Comparison

> **Revision 2026-11-11.** Every Agaric row was checked against `origin/main` at `db1628007`
> (v0.23.0) by reading the code and the feature docs; no Agaric runtime behaviour was exercised.
> Every Obsidian row was checked on the same day against Obsidian's own pages: the help source
> (`obsidianmd/obsidian-help`), the changelog, the roadmap, the pricing, Sync, download, licence,
> security and about pages, and the `obsidianmd/obsidian-releases` registries. Obsidian was not
> installed or run. Claims that could not be verified are labelled **unverified**; Obsidian knowledge
> that comes from memory, not from a page fetched today, is labelled **memory** with its approximate
> date. A second pass the same day re-fetched the weight-bearing Obsidian claims and re-read the
> Agaric code behind every **Better**; what it changed is in the
> [Appendix](#appendix-method-and-sources).
>
> **Deliberately unflattering to both sides.** The sibling document, [Agaric vs Logseq](COMPARISON.md),
> had to be corrected twice for overclaiming on Agaric's behalf. This one starts from the opposite
> prior: Obsidian is the incumbent with stores, a plugin ecosystem and a paid sync that works anywhere,
> and Agaric has to earn each "Better".
>
> Goal: say plainly what an Obsidian user gains and loses by moving to Agaric, and what Agaric would
> have to build to be a credible alternative. The short migration table lives in
> [COMPARISON.md Part 11](COMPARISON.md#part-11-coming-from-logseq-or-obsidian) and is not repeated
> here.

**Status key** (the status describes Agaric against the Obsidian capability in the same row):

| Label | Meaning |
| ------- | --------- |
| **Done** | Fully implemented and shipped |
| **Partial** | Implemented but incomplete |
| **Gap** | Not implemented |
| **Dead** | Code exists but no user can reach it |
| **Design choice** | Intentionally different from Obsidian |
| **Better** | Agaric implementation exceeds Obsidian's core, verified on both sides |
| **Tie** | Both have it to the same degree, or neither has it |
| **Unverified** | One side could not be checked, so no verdict |

A qualifier after a label ("Better vs core", "Better on cost") narrows it and is part of the claim.

"Obsidian core" means the app with its core plugins and nothing from the community directory. Where a
community plugin is the usual answer, the row names it and its download count.

---

## Part 0: Read This First

### 1. The atom is different

- **Obsidian's atom is a file.** A vault is a folder of Markdown files; "Obsidian automatically
  refreshes your vault to keep up with any external changes" (help, *How Obsidian stores data*).
  Properties, links, tasks and embeds are all text in those files. A block exists only when a line
  carries a `^id`.
- **Agaric's atom is a block.** Every paragraph is a row with a ULID in one SQLite database, written
  through an append-only op log and a Loro CRDT. A page is a block that contains blocks. Links,
  tags and block references store ids, not names.

Most rows below follow from that one difference. Obsidian wins everything that depends on files being
the truth: any editor, any sync tool, any backup tool, git, and an AI agent that can simply read the
folder. Agaric wins everything that depends on blocks being addressable and edits being operations:
per-block properties and tasks, references that survive renames, per-block history (90 days of it),
and sync that merges without conflict files.

Agaric has narrowed the gap. A **Markdown mirror** (#5363) keeps every page as a `.md` file in a
chosen folder and reads outside edits back in. It is desktop only, off by default and per device,
so it is an escape hatch, not the storage model.

### 2. The licence and the business are different

- **Obsidian is proprietary and free of charge.** "Obsidian is free for all purposes, including
  personal, commercial, and non-profit use" (licence page, last updated 2025-02-20). The source is
  closed. Revenue is Sync, Publish, and optional Catalyst and Commercial licences. The about page
  lists seven people and says "we are 100% supported by our users, not investors".
- **Agaric is free software** (GPL-3.0-or-later, `LICENSE`), with one maintainer
  (`GOVERNANCE.md`), no revenue and no public user base.

Obsidian's durability argument is the file format, not the app: if the company stops, the vault is
still Markdown. Agaric's durability argument is the source code and the export. Neither argument is
weak, and they are not the same argument.

### 3. Obsidian is two products: core, and core plus plugins

`community-plugins.json` held **10,253 plugins** and `community-css-themes.json` **1,011 themes** on
2026-11-11. Tasks, Dataview, Templater, Calendar, Kanban and Excalidraw are plugins, not the app. A
fair comparison says which one it means; the status column means core, and the rows name the
plugin that closes a gap. Plugins are also Obsidian's largest risk surface: its
own help says it "cannot reliably restrict plugins to specific permissions or access levels".

Agaric has no plugin API, no custom CSS and no scripting. What it ships is built in, tested together,
and all there is.

### 4. What this document does not claim

Performance at vault scale and accessibility are **not scored**: neither side publishes numbers that
could be compared, and nothing was measured here.

---

## Part 1: Context

**Obsidian 1.15** (public 2026-11-02; `desktop-releases.json` lists 1.15.0; 1.15.1 is in early
access) is an Electron app with CodeMirror 6, pdf.js, MathJax, Prism and Mermaid (help, *Credits*).
It ships for Windows, macOS, Linux (AppImage x86-64 and ARM64, deb, Snap, community Flatpak), iOS (App
Store) and Android (Google Play or a direct APK). Recent releases added Bases with table, cards,
list and kanban layouts (1.9 to 1.14; a map layout needs the separate Maps plugin), a CLI (1.12),
mobile widgets (roadmap: January 2026), iOS Quick Capture (October 2026) and PDF export on mobile
(1.15). The roadmap lists "Background Sync on mobile", "Obsidian for Work"
and "iOS native interface" as active, and "Multiplayer", "PDF annotation", "Calendar view for Bases"
and Bases and Canvas support for Publish as planned.

**Agaric 0.23.0** is Rust and React on Tauri 2 with SQLite and Loro. It ships for Linux (deb, rpm,
AppImage), Windows (MSI), macOS and Android (arm64, API 30+, a sideloaded APK). There is no iOS
target (`src-tauri/gen/` holds `android` only). Desktop bundles are not code-signed (`README.md`).

| | Obsidian | Agaric |
| --- | --- | --- |
| First release | 0.0.1, March 2020 (roadmap) | pre-1.0; v0.23.0 |
| Source | Closed; some satellites open (Importer, help, JSON Canvas spec) | GPL-3.0-or-later |
| Price | App free; Sync $4 to $10 per month; Publish $8 to $10 per site per month (4 GB per site) | Free |
| Team | 7 people on the about page | 1 maintainer (`GOVERNANCE.md`) |
| Funding | User-supported, no investors (about page) | None |
| Security review | Cure53 (2023-12, 2024-10, 2024-12), Trail of Bits (2025-12) (security page) | SLSA provenance, Scorecard, CodeQL; no third-party audit |
| Ecosystem | 10,253 plugins, 1,011 themes | None |
| Stores | App Store, Google Play, Flathub (community maintained) | None; a Flathub manifest is "scaffold only" (`packaging/flathub/README.md`) |
| User base | Not published by Obsidian; top plugin has 9.0M downloads | No public user base |

---

## Part 2: Feature-by-Feature

Agaric evidence is a PR number or a repo-rooted `path:symbol`. Obsidian evidence is the help page or
site page named in the row or in the Appendix.

### 1. Notes, Files and Data Ownership

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Storage | Plain Markdown files in a folder you choose; `.obsidian/` holds settings | One SQLite database plus Loro state under the app data directory; no at-rest encryption (`README.md`) | Design choice |
| Edit with other tools | Any editor; external changes are picked up automatically | Only through the Markdown mirror (below) or an export | Partial |
| Plain-file projection | The vault is the files | **Markdown mirror** (Settings → Data, #5363): one `.md` per page, one folder per space; an outside edit, a new file, a rename or a move is read back as one undoable save (`src-tauri/src/mirror/`, #6474, #6483, #6504). **Desktop only, off by default, per device**; the folder must be empty or the mirror's own, so it cannot adopt an existing vault in place | Partial |
| Folders | Real folders, a file explorer, drag between folders | No folders. Namespaced titles (`a/b/c`) shown as a tree; spaces partition the vault | Design choice |
| Unit of addressing | The file; a block only once it carries `^id` | Every block has a ULID; nesting is capped at 20 levels (`MAX_BLOCK_DEPTH` in `src-tauri/agaric-store/src/block_descendants.rs`) | Better |
| Rename safety | Links are names; Obsidian rewrites them on a rename made inside the app (a setting, on by default) | Links are ids; a rename touches no other block | Better |
| Multiple vaults | Any number of folders, each its own window and settings | Spaces inside one database, each with its own journal, tabs, recents and property definitions (`docs/features/spaces.md`) | Design choice |
| Exit | Nothing to export | Per-page copy as Markdown, **Export this space** / **Export all spaces** ZIPs with `assets/` and `.agaric/space.json` for property definitions (`docs/features/import-export.md`, #6277). History, trash, saved queries and device-local state are not exported | Partial |
| Non-note file types | `.base`, `.canvas`, images, audio, video, PDF open in the app | Attachments on blocks; images, audio and PDF render; no canvas or base file | Partial |

### 2. Editor

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Live Preview | Default editing mode: the whole note is one document, syntax shown near the cursor | **Markdown reveal** on by default in every block (`src/editor/extensions/markdown-reveal.ts`); the whole-page document is **page mode**, which is opt-in (`EDIT_MODE_PREFERENCE` defaults to `'blocks'` in `src/lib/preferences.ts`) and refuses pages over 1000 blocks (`PAGE_MODE_BLOCK_CAP` in `src/editor/page-mode/page-mode-fit.ts`) | Partial |
| Source mode | A per-note toggle; the file is the source | **Edit as Markdown**: a whole-page plain-text buffer with Preview, a Changes diff, and Merge / Reload / Overwrite on a stale save (`docs/features/editor.md`). A separate mode, not a toggle of the same editor | Done |
| Reading view | A separate rendered view | None as a mode; every block but the focused one renders static | Design choice |
| Long-form writing | The default experience | Page mode, with its cap and opt-in. Blocks remain the storage unit, so a paragraph is a block | Partial |
| Outlining | List indent, fold, move line; the Outliner plugin (1.50M) adds outliner behaviour | Native: indent, drag with depth projection, zoom, collapse, multi-select, a keyboard selection cursor | Better |
| Markdown dialect | CommonMark, GFM and LaTeX (help, *Obsidian Flavored Markdown*) | A CommonMark subset shared by import, source and paste; no setext headings, reference links or inline HTML beyond `<u>` (COMPARISON.md §3, not re-audited today) | Partial |
| Tables | Pipe tables; in Live Preview a right-click adds, deletes, sorts and moves rows and columns | Pipe tables, a size grid, and handles on the table that add, delete, move (drag or `Alt+Shift+arrows`) and sort rows and columns, as the toolbar's table menu does (`src/components/editor-toolbar/TableHandles.tsx`, #6607) | Done |
| Math | MathJax, inline and block | KaTeX, inline and block (`src/editor/extensions/math.ts`) | Done |
| Code blocks | Prism highlighting | lowlight highlighting, language popover (`src/editor/extensions/code-highlight.ts`) | Done |
| Mermaid | Built in; re-engineered in 1.15 (changelog) | Built in, with a full-screen viewer and SVG download (`src/editor/extensions/MermaidCodeBlockView.tsx`) | Done |
| Callouts | `> [!type]`, custom titles, foldable with `+` / `-`, custom types through CSS | Five styles; Obsidian's and GitHub's type names map to the nearest of the five; the fold marker is kept (`src/editor/extensions/callout-blockquote.ts`) | Partial |
| Footnotes | `[^id]`, plus a Footnotes view core plugin | `[^label]` references numbered by first use and `[^label]:` definition blocks (`src/editor/extensions/footnote.ts`). No footnotes panel | Done |
| Comments | `%%hidden%%` | **None.** No handling of `%%` was found under `src/editor/`; an imported comment presumably stays visible text (**unverified**) | Gap |
| Highlight colours | Six colours (help, *Basic formatting syntax*; roadmap: October 2026) | One highlight (`==`) | Gap |
| Folding | Headings and lists fold | Blocks collapse; the state is per device, not synced | Partial |
| Find in note | Find and replace | `Ctrl+F` with case, whole-word and regex; `Ctrl+H` replaces one or all matches in the open page, `$1` groups in regex mode (`docs/SEARCH.md`). No replace across pages | Done |
| Multiple cursors | Yes (help, *Multiple cursors*) | Not found | Gap |
| Slides | Core plugin | None | Gap |
| Spellcheck | Built in (roadmap: June 2020) | The webview's (`spellcheck: 'true'` in `src/editor/use-roving-editor.ts`) | Done |
| Audio recording | Audio recorder core plugin; iOS Quick Capture records and transcribes voice notes (1.15) | `/voice` records into an audio attachment where the webview can; `/meeting` makes a meeting page (#5364). A recording shows a transcript and a summary only if those files are supplied, by hand or by an agent (#5410): **Agaric does not transcribe** | Done |
| Read aloud | Not in core (**memory**, 2025) | OS voice on macOS, Windows and Android; hidden on Linux (#5745) | Unverified |

### 3. Linking and Transclusion

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Wikilinks | `[[Note]]`, or Markdown links as a setting; readable in the raw file | `[[` picker and typed `[[text]]`; stored as `[[ULID]]`, readable only through the app, an export or the mirror | Done |
| Aliases | `aliases` property; `[[Note\|label]]` | Page aliases as synced ops; `[[Page\|label]]` (`docs/features/tags-and-links.md`) | Done |
| Heading links | `[[Note#Heading]]`, `[[#Heading]]`, nested headings | `[[Page#Heading]]` and `[[#Heading]]` store a reference to the heading's block | Done |
| Block references | `[[Note#^id]]`; the id is added to the target line; `[[^^` searches blocks vault-wide | `((ULID))` for any block, no id line to add; shown as a chip with a peek (`src/components/BlockRefPeek.tsx`). The chip does not render the block's content inline | Partial |
| Embeds | `![[Note]]`, `![[Note#Heading]]`, `![[Note#^id]]`, images with `\|WxH`, audio, video, PDF, and embedded search queries | `{{embed}}` blocks (typed as `![[`) for pages, headings and blocks, live, editable behind an unlock; rows show content only, depth 3 and 32 rows (`src/lib/embed-token.ts`). Images keep Obsidian's `\|300` width (#4712) | Partial |
| Backlinks | Linked mentions per note, in a pane or in the document, with a search filter, sort order and context toggle (help, *Backlinks*) | Linked references grouped by page, paginated, with a filter tree and a link-kind toggle (`src/components/backlinks/LinkedReferences.tsx`) | Done |
| Unlinked mentions | Incoming, in Backlinks; outgoing, in Outgoing links | Incoming only, on pages, with "Link it" (`docs/features/tags-and-links.md`) | Partial |
| Outgoing links pane | Core plugin | **None.** The local graph shows neighbours; there is no list of a page's outgoing links | Gap |
| Hover preview | Page preview core plugin | Block-ref peek; `Ctrl`/`Cmd`+hover preview of a page link (`docs/FEATURE-MAP.md`) | Done |
| Link to a file that is not a note | Any file in the vault | Attachment links only | Partial |
| Merge and extract notes | Note composer core plugin | Not found | Gap |

### 4. Properties and Bases

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Where properties live | YAML front matter: **per file only** | On any block or page (`block_properties`), with `key:: value` typing and a drawer | Better |
| Types | Text, List, Number, Checkbox, Date, Date & time (help, *Properties*) | Text, Number, Date, Boolean, Select, Ref, URL (`docs/features/properties.md`). **No list and no date-time** | Partial |
| Multi-value | List is a first-class type | **Absent.** `PRIMARY KEY (block_id, key)`; on import a YAML list other than `tags` / `aliases` is dropped with a warning (`docs/features/import-export.md` § Pitfalls) | Gap |
| Typed references | No reference type; a link is text in a Text or List property | `ref` type, rename-safe, with a chip that opens the target | Better |
| Enumerations | No select type among the six the help lists; values autocomplete from use (**memory**, 2025, for the autocomplete) | `select` with options on the definition, option rename across the space | Better |
| Schema | A property name has one type vault-wide; rename and retype from the Properties view | Definitions per space, synced; rename, merge, retype with a preview of values that will not fit, usage counts (Settings › Properties, `docs/features/properties.md`) | Done |
| Nested properties | Not supported in the UI (help says so) | Not supported | Tie |
| **Database views** | **Bases** (core): table, cards, list and kanban layouts (map with the Maps plugin); filters, formulas, summaries, grouping; inline editing of properties; `.base` files or embedded code blocks; a Bases API for plugin layouts. Rows are **files** | **Advanced Query**: nested AND / OR / NOT, sort, seven group keys, count/sum/avg/min/max. Rows are **blocks**. The result table derives its columns, has no column picker and no inline editing; saved views are per device and do not sync (`docs/features/views.md`) | Partial |
| Board view | Kanban layout in Bases (1.14); Kanban plugin (2.83M) | None; the weekly journal has drag-to-reschedule only | Gap |
| Cards / gallery | Cards layout with images | None | Gap |
| Calendar view of records | Planned (roadmap) | None over a query; the monthly journal shows content dots per day | Tie |

### 5. Tags

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Inline tags | `#tag` in text or the `tags` property | `#[ULID]` chips; typed `#name` converts; same boundary rule as Obsidian on import | Done |
| Nested tags | `#a/b` is a real hierarchy: `tag:a` matches `#a/b`, the Tags view nests them (help, *Tags*) | A naming convention: `projects/` is a prefix query that does **not** match the bare parent tag (`docs/features/tags-and-links.md`) | Partial |
| Tag rename | Not in the *Tags* or *Tags view* help pages; Tag Wrangler plugin (1.15M) | Built in; chips hold the id, so one rename updates everything | Better vs core |
| Boolean tag queries | Search operators | `TagExpr` with And / Or / Not / Prefix | Done |
| Inherited tags | A file's tags apply to the file | A tag on a block can apply to its descendants, opt-in in the Tags view and `under:` in search; not in the inline query vocabulary | Partial |

### 6. Search

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Engine | In-app search over notes and canvases; relevance sort and accent-insensitive matching are in 1.15.1 early access | SQLite FTS5 trigram with bm25 relevance and keyset pagination; **a query shorter than three characters does not run** (`docs/SEARCH.md`) | Partial |
| Operators | `file:`, `path:`, `content:`, `match-case:`, `ignore-case:`, `tag:`, `line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:`, `[property:value]`, `OR`, `-`, parentheses | 12 prefixes: `tag:`, `under:`, `path:`, `not-path:`, `state:`, `not-state:`, `priority:`, `not-priority:`, `due:`, `scheduled:`, `prop:`, `not-prop:` (`src/lib/search-query/register.ts`); FTS5 `AND` / `OR` / `NOT` on text terms. Filter tokens combine by fixed rules, not by parentheses | Partial |
| Scope of a match | File, or `line:` / `block:` / `section:` when asked | Always the block | Design choice |
| Regex | `/pattern/`, JavaScript flavour, combinable with operators | A regex toggle in find-across-pages and in `Ctrl+F` | Done |
| Property comparison | `[duration:<5]` | `prop:key=value` equality in search; ten operators in the query builder | Partial |
| Embedded search | A `query` code block renders results in a note | `{{query}}` blocks (§7) | Done |
| Attachment text | "Obsidian only searches the contents of notes and canvases" | Attachment text is not indexed (`docs/SEARCH.md`) | Tie |
| Quick switcher / palette | `Ctrl+O`, `Ctrl+P` | `Ctrl+O`, `Ctrl+P`, `Ctrl+K` | Done |

### 7. Queries

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Core query surface | Embedded search queries; Bases filters and formulas with a function library (help, *Functions*) | `{{query}}` blocks with a structured payload over 23 filter primitives (`FilterPrimitive` in `src-tauri/agaric-store/src/filters/primitive.rs`), live results, a visual builder | Done |
| A query language you can read | Bases YAML; Dataview's DQL (5.30M downloads; **memory**, 2025, for its syntax) | **No full one.** The builder writes `v2:<base64url(JSON)>`; a hand-typed block takes only a flat AND-only form; the search syntax is readable but a query block does not accept it (COMPARISON.md §7, #6628) | Gap |
| Computed columns | Bases formulas | Five fixed aggregates; no formulas | Gap |
| Scripting | DataviewJS, Templater (**memory**, 2025) | None | Gap |
| Granularity | Bases: files. Dataview: files, list items, tasks | Blocks, with page and tag context | Better vs core |
| Graph predicates | Search `file:` / link operators; Dataview `inlinks` / `outlinks` (**memory**) | `LinksTo`, `LinkedFrom`, `HasParentMatching`, `Orphan`, `Stub`, `HasNoInboundLinks`; one hop, no joins | Partial |

### 8. Tasks and Agenda

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Task model | A checkbox line, `- [ ]` / `- [x]`; `task:` search operators | A block with a state: `TODO → DOING → DONE → CANCELLED`, a fixed set (`src/lib/task-states.ts`) | Better |
| Dates, priority, recurrence | Not in core. **Tasks** plugin (4.60M) and **TaskNotes** (2.67M) add them | Built in: due and scheduled dates, priority 1 to 3 (`src/lib/priority-levels.ts`), three repeat modes with end conditions, projected occurrences | Better vs core |
| Agenda | Not in core; Tasks queries, or a Base over one-task-per-file notes | Journal Agenda mode with eight filter dimensions, Due and Done panels (`docs/features/journal-and-agenda.md`) | Better vs core |
| Interop with the Tasks plugin | N/A | Tasks' emoji date, priority, recurrence and done fields are read on import, paste and MCP writes, and written on export (`docs/FEATURE-MAP.md`) | Done |
| Custom statuses | Tasks plugin: custom checkbox statuses (**memory**, 2025) | Fixed four; no WAITING | Partial |
| Reminders | Not in core | Desktop only, while the app runs, on `due_date` (`src-tauri/src/reminders.rs`, #4806). Nothing on Android | Partial |
| Time tracking | Plugins | None | Gap |

### 9. Daily Notes and Journal

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Daily note | Core plugin: opens or creates today's note from a template, in a folder and date format you choose | Created on launch with the journal template | Done |
| Views | One note at a time; the Calendar plugin (3.26M) adds a month sidebar | Five modes: Daily, Weekly, Monthly, Stream, Agenda (`JournalMode` in `src/stores/journal.ts`) | Better |
| Date format and location | Configurable Moment format; subfolders from the format | A fixed ISO identity with a display-format allowlist | Partial |
| Periodic notes (week, month) | Plugins | Views over days, not notes of their own | Design choice |
| Quick capture to today | Mobile Quick Capture (iOS 1.14; Android listed as active), CLI, URI | Global hotkey on desktop, MCP `capture` (`docs/features/agent-access.md`). No Android widget or share target was found | Partial |

### 10. Templates

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Core templates | A template folder; `{{title}}`, `{{date}}`, `{{time}}` with Moment formats | Template pages, a Templates view, two variable grammars including `{{cursor}}` | Done |
| Scripting | **Templater** (6.16M): JavaScript, prompts, file operations (**memory**, 2025) | None | Gap |
| Known defect | N/A | `/template` copies task states, priorities, dates and properties, and one undo takes the insert back, but it writes one transaction per nesting level (`insertTemplateBlocks` in `src/lib/template-utils.ts`), so a level that fails leaves the ones above it; journal templates copy in one | Partial |
| Unique note creator | Core plugin (timestamp-named notes) | None; ids are intrinsic | Design choice |

### 11. Graph and Canvas

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Global graph | Yes, with search filters, colour groups, forces, orphans toggle, time-lapse animation | Force-directed graph with a filter bar; the edge set is capped (`src/components/graph/GraphView.tsx`, `docs/features/views.md`) | Partial |
| Local graph | Yes, with depth | 1 or 2 hops, select-and-walk | Done |
| Colour groups by query | Yes | None found under `src/components/graph/` | Gap |
| **Canvas** | Core: an infinite board of text cards, notes, media and web pages, with connections and groups, saved as open JSON Canvas | **None** | Gap |
| Drawing | Excalidraw plugin (9.00M, the most downloaded) | None | Gap |

### 12. Workspace, Windows and Navigation

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Tabs | Yes: drag, pin, stack, link | Per-space tabs with drag reorder, middle-click close, background tabs, a switcher, reopen closed (`docs/features/views.md`) | Done |
| Split panes | Tab groups split horizontally and vertically | **None found.** One page at a time | Gap |
| Pop-out windows | Desktop | None | Gap |
| Saved layouts | Workspaces core plugin | None; spaces restore their own tabs | Partial |
| Sidebars | Two, holding rearrangeable tabs (help, *Sidebar*) | One sidebar with fixed entries and bookmarks | Partial |
| Back / forward | Yes (**memory**, 2025) | Yes, per space, with mouse buttons and Android back (`src/stores/navigation-history.ts`) | Done |
| Outline | Core plugin | Page outline (`src/components/pages/PageOutline.tsx`) | Done |
| Bookmarks | Notes, headings, blocks, searches, graphs | Pages only | Partial |
| Web viewer | Core plugin (desktop) | None | Gap |
| Contexts | One vault per window, each with its own settings and plugins | Spaces with `Alt+1..9`, accent colour, separate journals; one settings set for all (the same trade as *Multiple vaults*, §1) | Design choice |

### 13. Commands, Hotkeys and Vim

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Command palette | `Ctrl+P`, every command, plugin commands included | `Ctrl+P` | Done |
| Hotkeys | Every command rebindable | Rebindable with conflict detection; a set of structural keys is fixed (`docs/features/keyboard.md`). Global chords follow Obsidian's (#6022) | Partial |
| Slash commands | Core plugin, off by default (**memory** for the default); runs any command | Built in, with sub-options and a recents band | Done |
| Vim mode | A setting ("Vim key bindings", help, *Settings*) | **None.** Only `j` / `k` in the History list | Gap |
| CLI | Obsidian CLI (1.12): "Anything you can do in Obsidian can be done from the command line"; the app must be running | None; MCP is the programmatic surface (§19) | Gap |
| URI scheme | `obsidian://open`, `new`, `search`, and more | `agaric://page/<id>`, `agaric://block/<id>` (`docs/features/agent-access.md`) | Partial |

### 14. Themes and CSS

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Themes | 1,011 community themes; light and dark base | Six fixed themes plus follow-system (`ThemeSelectValue` in `src/components/settings/AppearanceTab.tsx`) | Partial |
| CSS snippets | Any `.css` in the vault's config folder | **None.** No user stylesheet | Gap |
| Per-note styling | `cssclasses` property | None | Gap |
| Fonts, sizes | Custom fonts, sizes, readable line length | Note text size and interface zoom (`docs/FEATURE-MAP.md`) | Partial |

### 15. Plugins and API

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Plugin API | A plugin API; 10,253 community plugins; works on mobile | **None** | Gap |
| What plugins add | Tasks, Dataview, Templater, Kanban, Excalidraw, Git, calendars, AI assistants, alternative sync | Whatever is built in | Gap |
| Sandboxing | **None.** Restricted mode is all-or-nothing; "plugins will inherit Obsidian's access levels" | Not applicable: no third-party code runs | Design choice |
| Review | Automated scans per version, a public scorecard, manual review for popular and flagged plugins (help, *Plugin security*) | Not applicable | Design choice |
| Stability cost | A workflow built on five plugins depends on five maintainers (**inference**) | One codebase, one maintainer | Design choice |

### 16. Mobile

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| iOS | App Store; Siri and Shortcuts (roadmap: January 2026), Share Sheet (July 2026), Quick Capture (October 2026), voice capture (1.15) | **None** | Gap |
| Android | Google Play or direct APK; a "View note" widget in 1.15.1 early access; Android Quick Capture is active on the roadmap | Signed APK, arm64 only, API 30+, **sideload only** (`README.md`) | Partial |
| Plugins on mobile | Yes (mobile page) | Not applicable | Gap |
| Phone UI | Tabs, palette, a customisable toolbar | Bottom sheets, 44 px targets, a toolbar pinned above the keyboard (`docs/FEATURE-MAP.md`). No Android device runs in CI | Done |
| Background sync | Not yet: "Background Sync on mobile" is active on the roadmap | Not yet: foreground only (`docs/architecture/sync-and-network.md`) | Tie |
| Quality | Not assessed here; **unverified** | Not assessed here; 0.15.0 aborted on every Android launch (COMPARISON.md Part 0) | Unverified |

### 17. Sync

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| First-party sync | **Obsidian Sync**: Standard $4/month billed annually or $5 monthly (1 vault, 1 GB, 5 MB per file, 1 month of history); Plus $8 or $10 (10 vaults, 10 GB up to 100 GB, 200 MB per file, 12 months). Unlimited devices. 40% off for education and non-profits | **Free.** No account, no server | Better on cost |
| Reach | Any network, through Obsidian's servers (DigitalOcean, selectable region) | **One local network.** Discovery is mDNS only; the opt-in internet fallback (#4549) carries traffic only between devices that already found each other (`docs/features/sync.md`) | Partial |
| Encryption | End-to-end by default: AES-256, scrypt key derivation; a managed-key "standard encryption" option. Audited by Cure53 and Trail of Bits | QUIC with TLS 1.3 between the two devices; nothing is stored on a server, so there is nothing to encrypt at rest remotely | Design choice |
| Conflict handling | Markdown is merged with diff-match-patch, which "may sometimes create duplicate text or formatting problems", or written to a conflict file if you choose; every other file type, canvases included, is last-modified-wins; settings JSON is key-merged (help, *Troubleshoot Obsidian Sync*) | Loro CRDT per space: text, tree moves, properties, tags and attachments converge with no conflict file | Better |
| Version history | 1 or 12 months for notes; two weeks for attachments; deleted files restorable | The op log on each device (§21); not a remote copy | Design choice |
| Selective sync | By file type and folder, per device | **None.** A session syncs every space | Gap |
| Shared vaults | Yes, for other Sync subscribers; no fine-grained permissions | Out of scope: single user | Design choice |
| Headless client | `obsidian-headless` (open beta) for servers, CI and agents | A headless peer exists only as a test fixture (`e2e-tauri/sync-peer.ts`) | Gap |
| Third-party sync | Officially documented: iCloud, OneDrive, Google Drive, Syncthing, Git, Working Copy; each with caveats (iCloud on Windows "may lead to file duplication or corruption") | Not possible for the database. The Markdown mirror folder can be synced by such tools, on desktop, at the user's risk (**untested**) | Gap |
| Verified | A paid service in production since 2020 | A two-device suite required in CI (`e2e-tauri/sync-two-device.e2e.ts`) and daily Android and Linux use by the maintainer; guest networks, client isolation and two subnets are untested (`docs/features/sync.md`) | Partial |

### 18. Publish, Sharing and Collaboration

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Publish to the web | **Obsidian Publish**: $8 per site per month billed annually, $10 monthly; 4 GB per site, passwords, custom domain, graph, full-text search, invited collaborators | **None** | Gap |
| Share one note | Publish, or send the file | Copy as Markdown | Partial |
| Export to PDF | Desktop (roadmap: November 2020); mobile since 1.15 | Not found | Gap |
| Real-time collaboration | Not yet: "Multiplayer" is planned | Out of scope by the threat model (`AGENTS.md` § Threat Model) | Design choice |

### 19. Capture and Web Clipper

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Web clipper | Official, free, open-source extension for Chrome and Chromium browsers, Firefox (desktop and mobile), Safari and Edge; highlights, templates with logic | **None.** Pasted HTML converts to blocks (`src/editor/html-to-blocks.ts`) | Gap |
| Mobile share target | iOS Share Sheet (roadmap: July 2026) | None found in `src-tauri/gen/android/` | Gap |
| Widgets | Mobile widgets (roadmap: January 2026); an Android "View note" widget in 1.15.1 early access | None | Gap |
| Global hotkey capture | Through the CLI or URI | Quick Capture hotkey on desktop | Done |

### 20. Import and Export

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Importers | **Importer** (official plugin, 1.90M): Airtable, Apple Journal, Apple Notes, Bear, CSV, Evernote, Google Keep, HTML, OneNote, Notion, Roam, Logseq, Markdown, Textbundle, Tomboy | Markdown files and folders, **Obsidian vault**, Logseq graph, Org, Notion export, Evernote `.enex`, Joplin `.jex`, BibTeX / CSL-JSON (`docs/features/import-export.md`) | Partial |
| Obsidian vault fidelity | N/A | Wikilinks, aliases, heading and block anchors, `![[…]]` embeds, image sizes, Tasks-plugin fields, callout types and attachments are mapped. **Lost or flattened:** list properties, `.canvas` and `.base` files, Dataview and Templater code, `%%comments%%`, plugin data, folder structure (it becomes title namespaces) | Partial |
| Re-import | N/A | A single file or attachment-free note updates its page in place after a confirmation (#6277); folder imports do not merge | Partial |
| Export | The vault is the export; PDF per note | Markdown ZIP per space or for all spaces, restoring templates, done dates, attachments and property definitions on a folder import (#6277 G3); no PDF, HTML or structured JSON | Partial |

### 21. Attachments, PDF, History and Recovery

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Attachment formats | Images, audio, video, PDF listed in *Accepted file formats* | Images with resize and lightbox, audio players, PDF, other files as links | Partial |
| PDF viewing | Built-in viewer (roadmap: May 2023); deep links into PDFs (June 2023) | pdf.js viewer in a dialog (`src/components/dialogs/PdfViewerDialog.tsx`) | Done |
| PDF annotation | **Planned**, not shipped (roadmap) | Text highlights and pinned text comments, no ink; Save writes a new copy of the file and deletes the original (`src/components/dialogs/PdfViewerDialog.tsx`). A 2026-08-30 finding that this leaves old inline references dangling was not re-audited | Better |
| Local history | File recovery: whole-file snapshots of `.md` and `.canvas`, by default at least 5 minutes apart and kept 7 days (both configurable), per device, outside the vault | Every edit is an op: per-block and per-page history, word-level diff, "Restore to here", batch revert (`docs/features/views.md`). **Ops older than 90 days are pruned** (`op_log_compact` in `src-tauri/src/maintenance.rs`) | Better |
| Trash | System trash or a `.trash` folder (**memory**, 2025) | In-app Trash with restore; purged after 90 days (`TOMBSTONE_RETENTION_DAYS` in `src-tauri/src/maintenance.rs`) | Done |
| Backup | Any file backup tool works; help says "Syncing is not a backup" | **None for the database.** The exits are the ZIP export and the mirror, both of which drop history | Gap |
| Integrity check | None documented, and less to check: the files are the truth | Settings › App health rebuilds derived tables and compares them with the base tables and the CRDT (#6488); it guards a failure mode Obsidian does not have | Design choice |

### 22. Encryption and Privacy

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Local encryption | None: "Obsidian doesn't encrypt your local vault" | None; rely on full-disk encryption (`README.md`) | Tie |
| Sync encryption | End-to-end by default (§17) | Transport only; no third party holds data unless the relay fallback is on, and the relay forwards ciphertext | Design choice |
| Telemetry | "no telemetry data is collected" (security page) | None (`README.md`) | Tie |
| Account | None for the app; one for Sync and Publish | None | Tie |

### 23. AI and Agents

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Agent access without any API | **Yes, by construction.** An agent that can read a folder can read and edit the vault | No. The database is opaque; the mirror gives file access on desktop when enabled | Partial |
| First-party MCP | None found on Obsidian's site or roadmap (**unverified**, absence); community MCP plugins and servers exist | A bundled MCP sidecar: 39 tools in `src-tauri/src/mcp/registry.rs` (19 read-only, 20 read-write), each client an agent with a token, a mode and a space allow-list (`docs/features/agent-access.md`) | Better |
| First-party automation | CLI (1.12), URI scheme, headless Sync | MCP and `agaric://` links | Partial |
| In-app AI | Not in core. Copilot (3.43M), Claudian (2.68M), Smart Connections (1.27M) | None | Gap |
| Audit of agent edits | Whatever the file history or git shows | Ops stamped `agent:<name>`; an in-memory activity feed; the History view does not show the origin | Partial |
| Semantic search | Plugins | None | Gap |

### 24. Performance, Accessibility and Localisation

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Vault scale | No published benchmark found. The 1.15.1 notes say search results "appear much faster when a search matches thousands of notes". Community reports of vaults with tens of thousands of notes are **unverified** | A weekly 100K-block latency gate on backend commands (`src-tauri/benches/interactive_slo.rs`); page mode stops at 1000 blocks; no Android number, no memory number | Unverified |
| Accessibility | No accessibility statement found in the help source (**unverified**) | Keyboard reach for every action, `axe` assertions in several hundred test files under `src/`, reduced-motion and contrast handling (`docs/FEATURE-MAP.md`). No screen-reader audit on record | Unverified |
| Interface languages | 73 listed in `obsidianmd/obsidian-translations`, 51 marked complete for the app | English, plus Spanish for error messages and a few settings strings (`src/lib/i18n/es/`) | Gap |
| Right-to-left | Since 1.6 | No setting found (**unverified**) | Gap |

### 25. Platforms, Packaging and Updates

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Desktop | Windows, macOS (universal), Linux x86-64 and ARM64 | Linux, Windows, macOS x86-64 and aarch64 | Done |
| Packages | exe, dmg, AppImage, deb, Snap, Flatpak (community) | deb, rpm, AppImage, MSI, dmg | Done |
| Code signing | Signed installers (**memory**, 2025; not checked today) | **Unsigned** desktop bundles: Gatekeeper and SmartScreen warn (`README.md`) | Gap |
| Auto-update | Desktop in-app, with periodic installer updates; mobile through stores | Desktop in-app, minisign-verified (`tauri-plugin-updater` in `src-tauri/Cargo.toml`); Android by manual APK | Partial |
| Runtime | Electron | Tauri with the system webview; the README cites a ~9 MB Linux bundle (**unverified**) | Design choice |

### 26. Licence, Governance and Longevity

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Licence | Proprietary, closed source, free of charge for every use; optional Commercial licence at $50 per user per year | GPL-3.0-or-later; forkable | Better |
| If the project stops | The app keeps working offline; the files stay Markdown; Sync and Publish stop | The app keeps working; the source stays; the data is SQLite plus an export | Tie |
| Bus factor | Seven named people, six years, paying customers | **One** | Partial |
| Roadmap transparency | Public roadmap and changelog | Public issues | Tie |

---

## Part 3: Where Agaric Genuinely Wins

Trimmed to claims that survived both passes on 2026-11-11. Tasks, agenda and tag rename lead Obsidian
core only; a plugin closes each.

| Area | Agaric advantage | Against |
| --- | --- | --- |
| **Blocks as first-class objects** | Every block has an id, properties, tags, history and a reference syntax. Nothing has to be promoted to a file to be addressed | A block exists once a `^id` is appended; properties belong to files only |
| **Tasks without plugins** | States, dates, priority, recurrence with end conditions, projection, an agenda with eight filter dimensions | Core has checkboxes and `task:` search; the rest is the Tasks or TaskNotes plugin |
| **Journal** | Five modes, a content-dot calendar, drag-to-reschedule, templates applied wherever a day is created | A daily note; the calendar is a plugin |
| **Free sync with real merging** | No subscription, no account, CRDT convergence with no conflict files, attachments included | Obsidian Sync is $4 to $10 a month and merges text with diff-match-patch. **Only on one network** (Part 4) |
| **Rename safety** | Links, tags and refs are ids | Name-based links, rewritten on rename |
| **Typed schema** | `select` and `ref` types on any block | Six types, no select, no reference type |
| **History** | Op-level history for every block for 90 days, restore-to-point, batch revert | Whole-file snapshots, seven days by default; longer history is part of paid Sync |
| **Agent access with scoping** | 39 MCP tools, per-agent tokens, read-only mode, space allow-lists | No first-party MCP found (**unverified** absence); a CLI, plugins and raw file access, none of them scoped |
| **PDF annotation** | Text highlights and comments today, saved as a new copy | Planned |
| **Free software** | GPL, forkable, auditable | Closed source |
| **No third-party code** | Nothing un-sandboxed runs in the app. This is the other face of having no plugins (Part 4) | A plugin has the app's full access |

---

## Part 4: Where Obsidian Genuinely Wins

| Area | Obsidian advantage | Agaric limitation |
| --- | --- | --- |
| **Plain files** | The vault is Markdown on disk; every tool works on it | A database; the mirror is desktop only, off by default, and cannot adopt an existing vault |
| **Sync anywhere** | Any network, end-to-end encrypted, audited, with history | One local network; foreground only on Android; no selective sync |
| **Free sync alternatives** | iCloud, Syncthing, Git and others are documented | None for the database |
| **iOS and stores** | App Store, Google Play, widgets, share sheet | No iOS; Android sideload |
| **Ecosystem** | 10,253 plugins, 1,011 themes, CSS snippets, a CLI | None of it |
| **Bases** | Table, cards, list and kanban views with formulas and inline editing | A result table with derived columns; saved views do not sync |
| **Canvas and drawing** | Canvas in core; Excalidraw as a plugin | None |
| **Window management** | Splits, stacked tabs, pop-out windows, saved workspaces | Tabs, one page shown at a time: no split panes, pop-out windows or saved workspaces |
| **Long-form writing** | The default mode, with no block cap | Page mode is opt-in and capped at 1000 blocks |
| **List properties** | First-class | Absent; dropped on import |
| **Capture** | Web Clipper on four browser families, iOS Quick Capture and Share Sheet | A desktop hotkey |
| **Publishing** | Publish, PDF export | None |
| **Importers** | 15 sources, including Apple Notes, OneNote, Google Keep, Bear, Roam | 8 sources |
| **Languages** | 51 complete app translations, RTL | English and a little Spanish |
| **Vim mode, multiple cursors, comments, slides** | In core | Absent |
| **Team and track record** | Seven people, six years, audits, paying users | One maintainer, pre-1.0 |
| **Signed installers** | Yes (memory) | Unsigned on desktop |

---

## Part 5: Scorecard

**Method.** No points are awarded. Each line counts the rows of one Part 2 section by the status
Agaric earned there against Obsidian core: **Ahead** is any Better (qualified or not), **Level** is
Done or Tie, **Behind** is Partial or Gap, and **Not ranked** is Design choice or Unverified. Every
number can be recounted from the tables above. A count is not a weight: "Plugin API" and "Highlight
colours" are one row each, and the choice of rows is this document's. Performance and accessibility
are not ranked (§24).

| Section | Ahead | Level | Behind | Not ranked |
| --- | :---: | :---: | :---: | :---: |
| 1. Notes, Files and Data Ownership | 2 | 0 | 4 | 3 |
| 2. Editor | 1 | 8 | 10 | 2 |
| 3. Linking and Transclusion | 0 | 5 | 6 | 0 |
| 4. Properties and Bases | 3 | 3 | 5 | 0 |
| 5. Tags | 1 | 2 | 2 | 0 |
| 6. Search | 0 | 4 | 3 | 1 |
| 7. Queries | 1 | 1 | 4 | 0 |
| 8. Tasks and Agenda | 3 | 1 | 3 | 0 |
| 9. Daily Notes and Journal | 1 | 1 | 2 | 1 |
| 10. Templates | 0 | 1 | 2 | 1 |
| 11. Graph and Canvas | 0 | 1 | 4 | 0 |
| 12. Workspace, Windows and Navigation | 0 | 3 | 6 | 1 |
| 13. Commands, Hotkeys and Vim | 0 | 2 | 4 | 0 |
| 14. Themes and CSS | 0 | 0 | 4 | 0 |
| 15. Plugins and API | 0 | 0 | 2 | 3 |
| 16. Mobile | 0 | 2 | 3 | 1 |
| 17. Sync | 2 | 0 | 5 | 3 |
| 18. Publish, Sharing and Collaboration | 0 | 0 | 3 | 1 |
| 19. Capture and Web Clipper | 0 | 1 | 3 | 0 |
| 20. Import and Export | 0 | 0 | 4 | 0 |
| 21. Attachments, PDF, History and Recovery | 2 | 2 | 2 | 1 |
| 22. Encryption and Privacy | 0 | 3 | 0 | 1 |
| 23. AI and Agents | 1 | 0 | 5 | 0 |
| 24. Performance, Accessibility and Localisation | 0 | 0 | 2 | 2 |
| 25. Platforms, Packaging and Updates | 0 | 2 | 2 | 1 |
| 26. Licence, Governance and Longevity | 1 | 2 | 1 | 0 |
| **Total (175 rows)** | **18** | **44** | **91** | **22** |

How to read it:

- **On breadth Obsidian core wins clearly.** Agaric is behind in 91 of the 153 ranked rows and ahead
  in 18. Plugins widen that: four of the 18 (tag rename, query granularity, task dates and
  recurrence, the agenda) lead core only, and a popular plugin answers each.
- **In no section is Agaric ahead more often than behind.** It breaks even in three: tasks and
  agenda, attachments and history, licence and governance. It is behind in every row of themes and
  of import and export, and in every ranked row of plugins and publishing.
- **Agaric's leads are structural** (addressable blocks, per-block properties, a CRDT, an op log, the
  licence). **Obsidian's are reach and surface** (platforms, stores, views, plugins, sync on any
  network). A structural lead does not close a reach gap by itself.

---

## Part 6: Who Should Use Which

| Persona | Better fit | Why |
| --- | --- | --- |
| **"I want my notes as files"** | Obsidian | That is the product. Agaric's mirror is a desktop convenience |
| **iPhone or iPad** | Obsidian | Agaric has no iOS app |
| **Phone and laptop on different networks** | Obsidian | Sync at $4 a month, or iCloud / Syncthing. Agaric's devices must meet on one LAN |
| **Phone and laptop on the same Wi-Fi, no subscription** | Agaric, with caveats | Free CRDT sync; Android arm64 sideload, foreground only |
| **Long-form writer** | Obsidian | Live Preview as the default, PDF export, splits |
| **Outliner / Logseq-style thinker** | Agaric | Blocks, zoom, refs, per-block properties. In Obsidian this is the Outliner plugin over files |
| **Tasks / GTD** | Agaric, or Obsidian + Tasks | Agaric's are built in with an agenda; the Tasks plugin is mature and more configurable |
| **Journaling** | Agaric | Five modes against one daily note (a plugin adds a calendar) |
| **Database of notes (books, projects, CRM)** | Obsidian | Bases; list properties; kanban and cards |
| **Visual thinker** | Obsidian | Canvas, Excalidraw |
| **Researcher clipping the web** | Obsidian | Web Clipper, Web viewer, PDF deep links |
| **Tinkerer** | Obsidian | Plugins, CSS, CLI |
| **Vim user** | Obsidian | |
| **Agent-heavy workflow** | Split | Obsidian: an agent edits files directly, unscoped. Agaric: scoped, attributed, undoable tool calls |
| **Free-software requirement** | Agaric | Obsidian is closed |
| **Non-English interface** | Obsidian | |
| **Publishing a site** | Obsidian | |
| **Team** | Obsidian (shared vaults), with limits | Agaric is single-user by design |

**The honest summary.** For most Obsidian users, today, the answer is "stay". The users for whom
Agaric is already the better tool are outliner-first, task-and-journal-heavy, on Linux or Windows with
an Android phone on the same network, and who value free software or scoped agent access.

---

## Part 7: What Would Actually Make Agaric a Credible Obsidian Alternative

Ranked by how many Obsidian users each one stops from ruling Agaric out. Impact, cost and risk are
low / medium / high; cost low is hours to days, medium is weeks, high is a month or more.

| # | Item | Why it ranks here | Impact | Cost | Risk |
| --- | --- | --- | --- | --- | --- |
| 1 | **Sync beyond one network** | The casual user's test is "phone on mobile data, laptop at home". Discovery is mDNS only and the relay does not discover (`docs/features/sync.md`). Smallest version: pair once on the LAN, then let already-paired peers find each other through the relay | high | high | medium: the `endpoint::lan_only` guards and the "no cloud" promise both move |
| 2 | **Store distribution and signing** | Sideloading and Gatekeeper warnings end most trials. Google Play or F-Droid, Flathub (the manifest is a scaffold), signed macOS and Windows bundles | high | medium | low |
| 3 | **Database backup and restore** | A single opaque file with no backup is the first objection from a files-first user. A scheduled local snapshot with a restore command | high | low to medium | low |
| 4 | **The Markdown mirror as a first-class mode** | It answers "my notes are not files". Today it is off, desktop only, and refuses a non-empty folder. Next steps: adopt an existing Obsidian vault in place, an onboarding choice, then Android | high | medium (desktop), high (Android) | medium: two-way ingest is a data-loss surface; the fuzz and convergence tests (#6507, #6509) are the right start |
| 5 | **iOS** | No iPhone app rules out a large share of note-takers | high | high | medium: store review, local-network permission, background limits |
| 6 | **Android background sync** | Obsidian has not shipped it either; doing so would be a lead, not a catch-up | medium | medium | medium |
| 7 | **List (multi-value) properties** | Obsidian vaults use YAML lists everywhere; importing drops them. Blocked by `PRIMARY KEY (block_id, key)` and the engine format | medium to high | high | high: schema, CRDT format version and sync compatibility |
| 8 | **A table view worth the name** | Column picker, inline cell editing, saved views that sync, then a board grouped by a select property. This is the smallest answer to Bases | high | medium | low to medium |
| 9 | **Side-by-side pages** | Reference on the left, writing on the right is a daily Obsidian habit. A second pane, not a window manager | medium | medium | medium: focus is global and the editor roves (`AGENTS.md` invariant 4) |
| 10 | **Android share target and a web clipper** | Capture is where notes start. A share intent into Quick Capture is small; a browser extension is a second project | medium | low (share), medium (extension) | low |
| 11 | **A readable query language** | Dataview users expect to paste a query. The engine and a readable search syntax exist; a query block does not take that syntax (#6628) | medium | medium | low |
| 12 | **One user stylesheet** | A single custom CSS file covers most of what snippets are used for, on the token layer that already exists | medium | low | low to medium: support burden when the DOM changes |
| 13 | **Translations** | Finish Spanish; open a contribution path. Every string already passes through `t()` | medium | medium | low |
| 14 | **Editor parity items** | `%%comments%%`, outgoing-links list, `/template` in one transaction, searches shorter than three characters | medium | low each | low |
| 15 | **PDF and static HTML export** | Sharing a page with someone who does not use the app | low to medium | medium | low |
| 16 | **Fix the README** | It still describes a WebSocket transport, four journal modes, five property types and inline block-ref content | low | low | low |

### What should stay out of scope

- **A plugin API that runs arbitrary code.** Obsidian's own documentation says it cannot sandbox
  plugins. A one-maintainer project cannot review a marketplace, and the absence of third-party code
  is one of the few things Agaric can promise that Obsidian cannot. MCP, a user stylesheet and the
  mirror are the cheaper seams.
- **Canvas and drawing.** A second editor with its own data model, sync semantics and mobile UI.
- **Hosted Publish, shared vaults, multiplayer.** They need servers and accounts, which the threat
  model excludes.
- **A theme marketplace.** Six themes and a stylesheet are enough.
- **Built-in AI.** Agents come through MCP; a model in the app is a dependency and a privacy
  decision the project does not need to own.
- **Vim mode.** Real demand, but a large surface over a roving block editor; revisit only if page
  mode becomes the default.
- **Local database encryption.** Obsidian does not encrypt local vaults either; full-disk encryption
  is the right layer.

---

## Appendix: Method and Sources

**Agaric claims** were verified on 2026-11-11 against the working tree at `db1628007` (v0.23.0 in
`package.json`) by reading `docs/FEATURE-MAP.md`, `docs/features/*.md`, `docs/SEARCH.md`,
`docs/architecture/sync-and-network.md`, `README.md`, `GOVERNANCE.md`, and the symbols cited in each
row. The checkout is shallow (50 commits), so PR numbers come from commit subjects in that window and
from the docs. Nothing was run: no build, no test suite, no device. "Not found" means a source search
found nothing, which is weaker than a runtime check. Rows that cite COMPARISON.md were not re-audited
today.

**Obsidian claims** were verified on 2026-11-11 against:

- <https://obsidian.md/pricing>, <https://obsidian.md/sync>, <https://obsidian.md/download>,
  <https://obsidian.md/license>, <https://obsidian.md/about>, <https://obsidian.md/security>,
  <https://obsidian.md/mobile>
- <https://obsidian.md/changelog/> (1.14.2 to 1.15.1) and <https://obsidian.md/roadmap/>
- The help site's source, `obsidianmd/obsidian-help` on GitHub (`en/`), read as raw Markdown: *Plans
  and storage limits*, *Version history*, *Security and privacy*, *Collaborate on a shared vault*,
  *Headless Sync*, *Troubleshoot Obsidian Sync*, *Sync settings and selective syncing*, *Sync your
  notes across devices*, *Back up your Obsidian files*, *Introduction to Bases*, *Views*, *Bases
  syntax*, *Functions*, *Properties*, *Obsidian Flavored Markdown*, *Views and editing mode*,
  *Callouts*, *Tags*, *Basic* and *Advanced formatting syntax*, *Multiple cursors*, *Find and
  replace*, *Internal links*, *Embed files*, *Aliases*, *Search*, *File recovery*, *Backlinks*,
  *Outgoing links*, *Canvas*, *Templates*, *Daily notes*, *Graph view*, *Web viewer*, *Workspaces*,
  *Slides*, *Note composer*, *Page preview*, *Slash commands*, *Core plugins*, *Plugin security*,
  *Community plugins*, *Community directory*, *CSS snippets*, *Obsidian URI*, *Obsidian CLI*, *Tabs*,
  *Pop-out windows*, *Settings*, *Accepted file formats*, *How Obsidian stores data*, *Introduction to
  Obsidian Publish* and its *Security and privacy* and *Collaborate* pages, *Catalyst license*,
  *Education and non-profit discount*, *Importer*, *Introduction to Obsidian Web Clipper*, *Download
  and install Obsidian*, *Update Obsidian*, *Credits*
- <https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json>
  (10,253 entries), `community-css-themes.json` (1,011), `community-plugin-stats.json` (download
  counts) and `desktop-releases.json` (1.15.0) in the same repository
- The READMEs of `obsidianmd/obsidian-importer` (15 formats) and `obsidianmd/obsidian-translations`
  (73 language rows, 51 marked complete for the app)

**Sources that could not be reached.** The GitHub API returned 403 for `obsidianmd/*` from this
environment, so the help repository's file list could not be enumerated; pages were fetched by
guessed path, and these returned 404 and were not read: *Commercial license*, *Vim mode*,
*Accessibility*, *Supported languages*, *Export to PDF*, *Kanban view*, *Map view*, *Obsidian
Headless*, *Obsidian Reader*, *Obsidian for Work*. The App Store and Google Play listings, the forum
and Discord were not consulted. One web search (for a first-party MCP server) returned only
third-party directories.

**From memory, not from a page fetched today** (approximate date in brackets): Dataview's DQL and
DataviewJS, Templater's scripting, the Tasks plugin's custom statuses and query blocks (2025);
property values autocompleting from use (2025); the `.trash` folder option (2025); slash commands
being off by default (2025); signed desktop installers (2025); no read-aloud in core (2025); back /
forward navigation (2025).

**Explicitly unverified** and not asserted above:

- **Obsidian:** performance at any vault size; accessibility and screen-reader support; mobile app
  quality; minimum OS versions; the number of users; whether any first-party AI or MCP feature
  exists beyond the CLI and headless Sync (the roadmap lists none, and a web search found only
  third-party servers and a forum request); what *Obsidian Reader* and *Obsidian for Work* contain;
  whether the Maps plugin that the Bases map layout requires is first-party; the release numbers of
  features this document dates by roadmap month; which Sync features differ between Standard and
  Plus beyond the limits table.
- **Agaric:** every runtime behaviour, including page mode on a phone, the mirror under a
  third-party sync tool, how an imported `%%comment%%` renders, and sync on guest networks or across
  subnets; the ~9 MB bundle and ~24 MB APK sizes in the README; right-to-left text; the PDF
  dangling-reference finding from 2026-08-30.

**Second pass, 2026-11-11.** A different reviewer re-fetched the pricing, Sync, Publish, licence,
about, security, download, mobile and Web Clipper pages, the roadmap, the changelog, the registries
and twenty help pages, and re-read the Agaric code behind each **Better**. Corrections:

- *Agaric overclaimed.* History is not unbounded: ops older than 90 days are pruned, as is the
  Trash. Audio recording, backlinks, slash commands and property schema went from Better to Done
  (Obsidian's iOS capture transcribes and Agaric does not; Obsidian's backlinks pane filters and
  sorts). Spaces and the integrity check went from Better to Design choice, the search engine and
  hotkeys from Done to Partial, read aloud from Better to Unverified, and "can you fork it" was
  folded into the licence row it duplicated.
- *Obsidian was misdescribed.* The Bases map layout needs the Maps plugin. Sync's default merge
  can duplicate text, a conflict file is a setting, and non-Markdown files are last-modified-wins.
  The 1.15.1 notes claim faster search results, not faster startup. A quotation that could not be
  found on the cited page was replaced by paraphrase. Release numbers that could not be
  confirmed were replaced by the roadmap's month.
- *The scorecard* was 33 hand-assigned 1-10 scores summed to 252 / 279 / 199. The sums were right
  and the scores could not be traced to rows, so Part 5 is now a count of the rows.

**Where Agaric's own docs disagree with its code** (found while checking, not fixed here):
`README.md` § Sync describes a "TLS WebSocket with self-signed ECDSA certificates" transport that
`docs/features/sync.md` and the code replaced with iroh QUIC; it lists four journal modes where
`JournalMode` has five, five property types where there are seven, "nest infinitely" where the cap is
20, "custom task keywords" where the set is fixed, and block references as "inline embed of another
block's content" where they render as chips. `docs/features/agent-access.md` lists 19 read-write
tools in its summary sentence while the registry has 20 (`add_meeting` is documented further down).
