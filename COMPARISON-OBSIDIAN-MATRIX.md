# Agaric and Obsidian: the feature matrix

> **As of November 2026.** The row-by-row detail behind [Agaric and Obsidian](COMPARISON-OBSIDIAN.md), which is the page to read first. Agaric cells describe `main` and cite the code or the feature docs. Obsidian cells come from its help, site, changelog and roadmap; "core" means Obsidian with its core plugins and nothing from the community directory, and a claim that could not be confirmed there says **unverified**. Obsidian was not installed or run.

**Status** is Agaric against Obsidian core in the same row:

| Label | Meaning |
| --- | --- |
| **Done** | Implemented |
| **Partial** | Implemented but incomplete |
| **Gap** | Not implemented |
| **Design choice** | Intentionally different |
| **Better** | Agaric's implementation goes further than core; a qualifier ("vs core", "on cost") is part of the claim |
| **Tie** | Both have it to the same degree, or neither does |
| **Unverified** | One side could not be checked, so no verdict |

## 1. Notes, Files and Data Ownership

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

## 2. Editor

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Live Preview | Default editing mode: the whole note is one document, syntax shown near the cursor | **Markdown reveal** on by default in every block (`src/editor/extensions/markdown-reveal.ts`); the whole-page document is **page mode**, which is opt-in (`EDIT_MODE_PREFERENCE` defaults to `'blocks'` in `src/lib/preferences.ts`) and refuses pages over 1000 blocks (`PAGE_MODE_BLOCK_CAP` in `src/editor/page-mode/page-mode-fit.ts`) | Partial |
| Source mode | A per-note toggle; the file is the source | **Edit as Markdown**: a whole-page plain-text buffer with Preview, a Changes diff, and Merge / Reload / Overwrite on a stale save (`docs/features/editor.md`). A separate mode, not a toggle of the same editor | Done |
| Reading view | A separate rendered view | None as a mode; every block but the focused one renders static | Design choice |
| Long-form writing | The default experience | Page mode, with its cap and opt-in. Blocks remain the storage unit, so a paragraph is a block | Partial |
| Outlining | List indent, fold, move line; the community Outliner plugin adds outliner behaviour | Native: indent, drag with depth projection, zoom, collapse, multi-select, a keyboard selection cursor | Better |
| Markdown dialect | CommonMark, GFM and LaTeX (help, *Obsidian Flavored Markdown*) | A CommonMark subset shared by import, source and paste; no setext headings, reference links or inline HTML beyond `<u>` (COMPARISON.md §3, not re-audited today) | Partial |
| Tables | Pipe tables; in Live Preview a right-click adds, deletes, sorts and moves rows and columns | Pipe tables, a size grid, and handles on the table that add, delete, move (drag or `Alt+Shift+arrows`) and sort rows and columns, as the toolbar's table menu does (`src/components/editor-toolbar/TableHandles.tsx`, #6607) | Done |
| Math | MathJax, inline and block | KaTeX, inline and block (`src/editor/extensions/math.ts`) | Done |
| Code blocks | Prism highlighting | lowlight highlighting, language popover (`src/editor/extensions/code-highlight.ts`) | Done |
| Mermaid | Built in; rendered by Obsidian's own library since 1.15 (changelog) | Built in, with a full-screen viewer and SVG download (`src/editor/extensions/MermaidCodeBlockView.tsx`) | Done |
| Callouts | `> [!type]`, custom titles, foldable with `+` / `-`, custom types through CSS | Five styles; Obsidian's and GitHub's type names map to the nearest of the five; the fold marker is kept (`src/editor/extensions/callout-blockquote.ts`) | Partial |
| Footnotes | `[^id]`, plus a Footnotes view core plugin | `[^label]` references numbered by first use and `[^label]:` definition blocks (`src/editor/extensions/footnote.ts`). No footnotes panel | Done |
| Comments | `%%hidden%%` | **None.** No handling of `%%` was found under `src/editor/`; an imported comment presumably stays visible text (**unverified**) | Gap |
| Highlight colours | Six colours (help, *Basic formatting syntax*; roadmap: October 2026) | One highlight (`==`) | Gap |
| Folding | Headings and lists fold | Blocks collapse; the state is per device, not synced | Partial |
| Find in note | Find and replace | `Ctrl+F` with case, whole-word and regex; `Ctrl+H` replaces one or all matches in the open page, `$1` groups in regex mode; the Search view replaces literal text across pages, with a preview and an Undo (`docs/SEARCH.md`) | Done |
| Multiple cursors | Yes (help, *Multiple cursors*) | Not found | Gap |
| Slides | Core plugin | None | Gap |
| Spellcheck | Built in (roadmap: June 2020) | The webview's (`spellcheck: 'true'` in `src/editor/use-roving-editor.ts`) | Done |
| Audio recording | Audio recorder core plugin; iOS Quick Capture records and transcribes voice notes (1.15) | `/voice` records into an audio attachment where the webview can; `/meeting` makes a meeting page (#5364). A recording shows a transcript and a summary only if those files are supplied, by hand or by an agent (#5410): **Agaric does not transcribe** | Done |
| Read aloud | No read-aloud page in the help (**unverified** absence) | OS voice on macOS, Windows and Android; hidden on Linux (#5745) | Unverified |

## 3. Linking and Transclusion

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

## 4. Properties and Bases

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Where properties live | YAML front matter: **per file only** | On any block or page (`block_properties`), with `key:: value` typing and a drawer | Better |
| Types | Text, List, Number, Checkbox, Date, Date & time, and Tags for the `tags` property (help, *Properties*) | Text, Number, Date, Boolean, Select, Ref, URL (`docs/features/properties.md`). **No list and no date-time** | Partial |
| Multi-value | List is a first-class type | **Absent.** `PRIMARY KEY (block_id, key)`; on import a YAML list other than `tags` / `aliases` is dropped with a warning (`docs/features/import-export.md` § Pitfalls) | Gap |
| Typed references | No reference type; a link is text in a Text or List property | `ref` type, rename-safe, with a chip that opens the target | Better |
| Enumerations | No select type among the types the help lists; that values autocomplete from use is **unverified** | `select` with options on the definition, option rename across the space | Better |
| Schema | A property name has one type vault-wide; rename and retype from the Properties view | Definitions per space, synced; rename, merge, retype with a preview of values that will not fit, usage counts (Settings › Properties, `docs/features/properties.md`) | Done |
| Nested properties | Not supported in the UI (help says so) | Not supported | Tie |
| **Database views** | **Bases** (core): table, cards, list and kanban layouts (map with the Maps plugin); filters, formulas, summaries, grouping; properties edited from the view; `.base` files or embedded code blocks; a Bases API for plugin layouts. Rows are **files** | **Advanced Query**: nested AND / OR / NOT, sort, seven group keys, count/sum/avg/min/max. Rows are **blocks**. The result table derives its columns, has no column picker and no inline editing; saved views are per device and do not sync (`docs/features/views.md`) | Partial |
| Board view | Kanban layout in Bases (1.14): dragging a card to another column updates the grouped property; the community Kanban plugin | None; the weekly journal has drag-to-reschedule only | Gap |
| Cards / gallery | Cards layout with images | None | Gap |
| Calendar view of records | Planned (roadmap) | None over a query; the monthly journal shows content dots per day | Tie |

## 5. Tags

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Inline tags | `#tag` in text or the `tags` property | `#[ULID]` chips; typed `#name` converts; same boundary rule as Obsidian on import | Done |
| Nested tags | `#a/b` is a real hierarchy: `tag:a` matches `#a/b`, the Tags view nests them (help, *Tags*) | A naming convention: `projects/` is a prefix query that does **not** match the bare parent tag (`docs/features/tags-and-links.md`) | Partial |
| Tag rename | Not in the *Tags* or *Tags view* help pages; the community Tag Wrangler plugin | Built in; chips hold the id, so one rename updates everything | Better vs core |
| Boolean tag queries | Search operators | `TagExpr` with And / Or / Not / Prefix | Done |
| Inherited tags | A file's tags apply to the file | A tag on a block can apply to its descendants, opt-in in the Tags view and `under:` in search; not in the inline query vocabulary | Partial |

## 6. Search

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Engine | In-app search over notes and canvases; relevance sort and accent-insensitive matching since 1.15.1 | SQLite FTS5 trigram with bm25 relevance and keyset pagination; **a query shorter than three characters does not run** (`docs/SEARCH.md`) | Partial |
| Operators | `file:`, `path:`, `content:`, `match-case:`, `ignore-case:`, `tag:`, `line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:`, `[property:value]`, `OR`, `-`, parentheses | 12 prefixes: `tag:`, `under:`, `path:`, `not-path:`, `state:`, `not-state:`, `priority:`, `not-priority:`, `due:`, `scheduled:`, `prop:`, `not-prop:` (`src/lib/search-query/register.ts`); FTS5 `AND` / `OR` / `NOT` on text terms. Filter tokens combine by fixed rules, not by parentheses | Partial |
| Scope of a match | File, or `line:` / `block:` / `section:` when asked | Always the block | Design choice |
| Regex | `/pattern/`, JavaScript flavour, combinable with operators | A regex toggle in find-across-pages and in `Ctrl+F` | Done |
| Property comparison | `[duration:<5]` | `prop:key=value` equality in search; ten operators in the query builder | Partial |
| Embedded search | A `query` code block renders results in a note | `{{query}}` blocks (§7) | Done |
| Attachment text | "Obsidian only searches the contents of notes and canvases" | Attachment text is not indexed (`docs/SEARCH.md`) | Tie |
| Quick switcher / palette | `Ctrl+O`, `Ctrl+P` | `Ctrl+O`, `Ctrl+P`, `Ctrl+K` | Done |

## 7. Queries

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Core query surface | Embedded search queries; Bases filters and formulas with a function library (help, *Functions*) | `{{query}}` blocks with a structured payload over 23 filter primitives (`FilterPrimitive` in `src-tauri/agaric-store/src/filters/primitive.rs`), live results, a visual builder | Done |
| A query language you can read | Bases YAML; the community Dataview plugin's query language (**unverified**) | **No full one.** The builder writes `v2:<base64url(JSON)>`; a hand-typed block takes only a flat AND-only form; the search syntax is readable but a query block does not accept it (COMPARISON.md §7, #6628) | Gap |
| Computed columns | Bases formulas | Five fixed aggregates; no formulas | Gap |
| Scripting | Community plugins such as Dataview and Templater (**unverified**) | None | Gap |
| Granularity | Bases: files. Dataview: files, list items, tasks | Blocks, with page and tag context | Better vs core |
| Graph predicates | Search `file:` / link operators; Dataview's link fields (**unverified**) | `LinksTo`, `LinkedFrom`, `HasParentMatching`, `Orphan`, `Stub`, `HasNoInboundLinks`; one hop, no joins | Partial |

## 8. Tasks and Agenda

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Task model | A checkbox line, `- [ ]` / `- [x]`; `task:` search operators | A block with a state: `TODO → DOING → DONE → CANCELLED`, a fixed set (`src/lib/task-states.ts`) | Better |
| Dates, priority, recurrence | Not in core. The help documents none for tasks; the community **Tasks** and **TaskNotes** plugins add them | Built in: due and scheduled dates, priority 1 to 3 (`src/lib/priority-levels.ts`), three repeat modes with end conditions, projected occurrences | Better vs core |
| Agenda | Not in core; Tasks queries, or a Base over one-task-per-file notes | Journal Agenda mode with eight filter dimensions, Due and Done panels (`docs/features/journal-and-agenda.md`) | Better vs core |
| Interop with the Tasks plugin | N/A | Tasks' emoji date, priority, recurrence and done fields are read on import, paste and MCP writes, and written on export (`docs/FEATURE-MAP.md`) | Done |
| Custom statuses | The community Tasks plugin's custom statuses (**unverified**) | Fixed four; no WAITING | Partial |
| Reminders | Not in core | Desktop only, while the app runs, on `due_date` (`src-tauri/src/reminders.rs`, #4806). Nothing on Android | Partial |
| Time tracking | Plugins | None | Gap |

## 9. Daily Notes and Journal

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Daily note | Core plugin: opens or creates today's note from a template, in a folder and date format you choose | Created on launch with the journal template | Done |
| Views | One note at a time; the community Calendar plugin adds a month sidebar | Five modes: Daily, Weekly, Monthly, Stream, Agenda (`JournalMode` in `src/stores/journal.ts`) | Better |
| Date format and location | Configurable Moment format; subfolders from the format | A fixed ISO identity with a display-format allowlist | Partial |
| Periodic notes (week, month) | Plugins | Views over days, not notes of their own | Design choice |
| Quick capture to today | Mobile Quick Capture (iOS 1.14; Android listed as active), CLI, URI | Global hotkey on desktop, MCP `capture` (`docs/features/agent-access.md`). No Android widget or share target was found | Partial |

## 10. Templates

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Core templates | A template folder; `{{title}}`, `{{date}}`, `{{time}}` with Moment formats | Template pages, a Templates view, two variable grammars including `{{cursor}}` | Done |
| Scripting | The community **Templater** plugin (**unverified** in detail) | None | Gap |
| Known defect | N/A | `/template` copies task states, priorities, dates and properties, and one undo takes the insert back, but it writes one transaction per nesting level (`insertTemplateBlocks` in `src/lib/template-utils.ts`), so a level that fails leaves the ones above it; journal templates copy in one | Partial |
| Unique note creator | Core plugin (timestamp-named notes) | None; ids are intrinsic | Design choice |

## 11. Graph and Canvas

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Global graph | Yes, with search filters, colour groups, forces, orphans toggle, time-lapse animation | Force-directed graph with a filter bar; the edge set is capped (`src/components/graph/GraphView.tsx`, `docs/features/views.md`) | Partial |
| Local graph | Yes, with depth | 1 or 2 hops, select-and-walk | Done |
| Colour groups by query | Yes | None found under `src/components/graph/` | Gap |
| **Canvas** | Core: an infinite board of text cards, notes, media and web pages, with connections and groups, saved as open JSON Canvas | **None** | Gap |
| Drawing | The community Excalidraw plugin | None | Gap |

## 12. Workspace, Windows and Navigation

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Tabs | Yes: drag, pin, stack, link | Per-space tabs with drag reorder, middle-click close, background tabs, a switcher, reopen closed (`docs/features/views.md`) | Done |
| Split panes | Tab groups split horizontally and vertically | **None found.** One page at a time | Gap |
| Pop-out windows | Desktop | None | Gap |
| Saved layouts | Workspaces core plugin | None; spaces restore their own tabs | Partial |
| Sidebars | Two, holding rearrangeable tabs (help, *Sidebar*) | One sidebar with fixed entries and bookmarks | Partial |
| Back / forward | Not checked in the help (**unverified**) | Yes, per space, with mouse buttons and Android back (`src/stores/navigation-history.ts`) | Done |
| Outline | Core plugin | Page outline (`src/components/pages/PageOutline.tsx`) | Done |
| Bookmarks | Notes, headings, blocks, searches, graphs | Pages only | Partial |
| Web viewer | Core plugin (desktop) | None | Gap |
| Contexts | One vault per window, each with its own settings and plugins | Spaces with `Alt+1..9`, accent colour, separate journals; one settings set for all (the same trade as *Multiple vaults*, §1) | Design choice |

## 13. Commands, Hotkeys and Vim

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Command palette | `Ctrl+P`, every command, plugin commands included | `Ctrl+P` | Done |
| Hotkeys | Every command rebindable | Rebindable with conflict detection; a set of structural keys is fixed (`docs/features/keyboard.md`). Global chords follow Obsidian's (#6022) | Partial |
| Slash commands | Core plugin; runs any command | Built in, with sub-options and a recents band | Done |
| Vim mode | A setting ("Vim key bindings", help, *Settings*) | **None.** Only `j` / `k` in the History list | Gap |
| CLI | Obsidian CLI (1.12): "Anything you can do in Obsidian can be done from the command line"; the app must be running | None; MCP is the programmatic surface (§19) | Gap |
| URI scheme | `obsidian://open`, `new`, `search`, and more | `agaric://page/<id>`, `agaric://block/<id>` (`docs/features/agent-access.md`) | Partial |

## 14. Themes and CSS

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Themes | A community theme directory; light and dark base | Six fixed themes plus follow-system (`ThemeSelectValue` in `src/components/settings/AppearanceTab.tsx`) | Partial |
| CSS snippets | Any `.css` in the vault's config folder | **None.** No user stylesheet | Gap |
| Per-note styling | `cssclasses` property | None | Gap |
| Fonts, sizes | Custom fonts, sizes, readable line length | Note text size and interface zoom (`docs/FEATURE-MAP.md`) | Partial |

## 15. Plugins and API

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Plugin API | A plugin API and a community directory; whether plugins run on mobile is **unverified** in the help | **None** | Gap |
| What plugins add | Tasks, Dataview, Templater, Kanban, Excalidraw, Git, calendars, AI assistants, alternative sync | Whatever is built in | Gap |
| Sandboxing | **None.** Restricted mode is all-or-nothing; "plugins will inherit Obsidian's access levels" | Not applicable: no third-party code runs | Design choice |
| Review | Automated scans per version, a public scorecard, manual review for popular and flagged plugins (help, *Plugin security*) | Not applicable | Design choice |
| Stability cost | A workflow built on five plugins depends on five maintainers (**inference**) | One codebase, one maintainer | Design choice |

## 16. Mobile

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| iOS | App Store; widgets, Siri and Shortcuts, a Share Sheet, Quick Capture and voice capture (help, roadmap) | **None** | Gap |
| Android | Google Play or direct APK; widgets (open note, new note, search, daily note) and a Quick Settings tile; Android Quick Capture is active on the roadmap | Signed APK, arm64 only, API 30+, **sideload only** (`README.md`) | Partial |
| Plugins on mobile | Yes (mobile page) | Not applicable | Gap |
| Phone UI | Tabs, palette, a customisable toolbar | Bottom sheets, 44 px targets, a toolbar pinned above the keyboard (`docs/FEATURE-MAP.md`). No Android device runs in CI | Done |
| Background sync | Not yet: "Background Sync on mobile" is active on the roadmap | Not yet: foreground only (`docs/architecture/sync-and-network.md`) | Tie |
| Quality | Not assessed here; **unverified** | Not assessed here; 0.15.0 aborted on every Android launch (COMPARISON.md Part 0) | Unverified |

## 17. Sync

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| First-party sync | **Obsidian Sync**: a paid subscription in two plans, Standard and Plus, that differ in vaults, storage, file size and history length. Unlimited devices | **Free.** No account, no server | Better on cost |
| Reach | Any network, through Obsidian's servers (DigitalOcean, selectable region) | **One local network.** Discovery is mDNS only; the opt-in internet fallback (#4549) carries traffic only between devices that already found each other (`docs/features/sync.md`) | Partial |
| Encryption | End-to-end by default: AES-256, scrypt key derivation; a managed-key "standard encryption" option. Audited by Cure53 and Trail of Bits | QUIC with TLS 1.3 between the two devices; nothing is stored on a server, so there is nothing to encrypt at rest remotely | Design choice |
| Conflict handling | Markdown is merged with diff-match-patch, which "may sometimes create duplicate text or formatting problems", or written to a conflict file if you choose; every other file type, canvases included, is last-modified-wins; settings JSON is key-merged (help, *Troubleshoot Obsidian Sync*) | Loro CRDT per space: text, tree moves, properties, tags and attachments converge with no conflict file | Better |
| Version history | Kept for a period that depends on the plan; deleted files restorable | The op log on each device (§21); not a remote copy | Design choice |
| Selective sync | By file type and folder, per device | **None.** A session syncs every space | Gap |
| Shared vaults | Yes, for other Sync subscribers; no fine-grained permissions | Out of scope: single user | Design choice |
| Headless client | `obsidian-headless` (open beta) for servers, CI and agents | A headless peer exists only as a test fixture (`e2e-tauri/sync-peer.ts`) | Gap |
| Third-party sync | Officially documented: iCloud, OneDrive, Google Drive, Syncthing, Git, Working Copy; each with caveats (iCloud on Windows "may lead to file duplication or corruption") | Not possible for the database. The Markdown mirror folder can be synced by such tools, on desktop, at the user's risk (**untested**) | Gap |
| Verified | A paid service in production since 2020 | A two-device suite required in CI (`e2e-tauri/sync-two-device.e2e.ts`) and daily Android and Linux use by the maintainer; guest networks, client isolation and two subnets are untested (`docs/features/sync.md`) | Partial |

## 18. Publish, Sharing and Collaboration

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Publish to the web | **Obsidian Publish**: a paid subscription per site, with a site password, custom domain, graph, full-text search and invited collaborators | **None** | Gap |
| Share one note | Publish, or send the file | Copy as Markdown | Partial |
| Export to PDF | Desktop, and mobile since 1.15 | Not found | Gap |
| Real-time collaboration | Not yet: "Multiplayer" is planned | Out of scope by the threat model (`AGENTS.md` § Threat Model) | Design choice |

## 19. Capture and Web Clipper

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Web clipper | Official, free, open-source extension for Chrome and Chromium browsers, Firefox (desktop and mobile), Safari and Edge; highlights, templates with logic | **None.** Pasted HTML converts to blocks (`src/editor/html-to-blocks.ts`) | Gap |
| Mobile share target | iOS Share Sheet (roadmap: July 2026) | None found in `src-tauri/gen/android/` | Gap |
| Widgets | Widgets on iOS and Android (help) | None | Gap |
| Global hotkey capture | Through the CLI or URI | Quick Capture hotkey on desktop | Done |

## 20. Import and Export

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Importers | **Importer** (official plugin): Notion, Airtable, OneNote, Evernote, Apple Notes, Apple Journal, Google Keep, Bear, Craft, Roam, Logseq, Samsung Notes, Tomboy, and HTML, CSV, Markdown and Textbundle files | Markdown files and folders, **Obsidian vault**, Logseq graph, Org, Notion export, Evernote `.enex`, Joplin `.jex`, BibTeX / CSL-JSON (`docs/features/import-export.md`) | Partial |
| Obsidian vault fidelity | N/A | Wikilinks, aliases, heading and block anchors, `![[…]]` embeds, image sizes, Tasks-plugin fields, callout types and attachments are mapped. **Lost or flattened:** list properties, `.canvas` and `.base` files, Dataview and Templater code, `%%comments%%`, plugin data, folder structure (it becomes title namespaces) | Partial |
| Re-import | N/A | A single file or attachment-free note updates its page in place after a confirmation (#6277); folder imports do not merge | Partial |
| Export | The vault is the export; PDF per note | Markdown ZIP per space or for all spaces, restoring templates, done dates, attachments and property definitions on a folder import (#6277 G3); no PDF, HTML or structured JSON | Partial |

## 21. Attachments, PDF, History and Recovery

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Attachment formats | Images, audio, video, PDF listed in *Accepted file formats* | Images with resize and lightbox, audio players, PDF, other files as links | Partial |
| PDF viewing | Built-in viewer (roadmap: May 2023); deep links into PDFs (June 2023) | pdf.js viewer in a dialog (`src/components/dialogs/PdfViewerDialog.tsx`) | Done |
| PDF annotation | **Planned**, not shipped (roadmap) | Text highlights and pinned text comments, no ink; Save writes a new copy of the file, moves the owning block's links to it and deletes the original (`src/components/dialogs/PdfViewerDialog.tsx`, #6629); a link copied into another block still names the original | Better |
| Local history | File recovery: whole-file snapshots of `.md` and `.canvas`, at an interval and for a retention period that are both configurable, per device, outside the vault | Every edit is an op: per-block and per-page history, word-level diff, "Restore to here", batch revert (`docs/features/views.md`). **Ops older than 90 days are pruned** (`op_log_compact` in `src-tauri/src/maintenance.rs`) | Better |
| Trash | Not checked in the help (**unverified**) | In-app Trash with restore; purged after 90 days (`TOMBSTONE_RETENTION_DAYS` in `src-tauri/src/maintenance.rs`) | Done |
| Backup | Any file backup tool works; help says "Syncing is not a backup" | **None for the database.** The exits are the ZIP export and the mirror, both of which drop history | Gap |
| Integrity check | None documented, and less to check: the files are the truth | Settings › App health rebuilds derived tables and compares them with the base tables and the CRDT (#6488); it guards a failure mode Obsidian does not have | Design choice |

## 22. Encryption and Privacy

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Local encryption | None: "Obsidian doesn't encrypt your local vault" | None; rely on full-disk encryption (`README.md`) | Tie |
| Sync encryption | End-to-end by default (§17) | Transport only; no third party holds data unless the relay fallback is on, and the relay forwards ciphertext | Design choice |
| Telemetry | "no telemetry data is collected" (security page) | None (`README.md`) | Tie |
| Account | None for the app; one for Sync and Publish | None | Tie |

## 23. AI and Agents

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Agent access without any API | **Yes, by construction.** An agent that can read a folder can read and edit the vault | No. The database is opaque; the mirror gives file access on desktop when enabled | Partial |
| First-party MCP | None found in the roadmap, the changelog or the help (**unverified** absence) | A bundled MCP sidecar: 39 tools in `src-tauri/src/mcp/registry.rs` (19 read-only, 20 read-write), each client an agent with a token, a mode and a space allow-list (`docs/features/agent-access.md`) | Better |
| First-party automation | CLI (1.12), URI scheme, headless Sync | MCP and `agaric://` links | Partial |
| In-app AI | Not in the app; the Web Clipper has a language-model "Interpreter"; community plugins | None | Gap |
| Audit of agent edits | Whatever the file history or git shows | Ops stamped `agent:<name>`; an in-memory activity feed; the History view does not show the origin | Partial |
| Semantic search | Plugins | None | Gap |

## 24. Performance, Accessibility and Localisation

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Vault scale | No published benchmark found. The 1.15.1 notes say search results "appear much faster when a search matches thousands of notes". Community reports of vaults with tens of thousands of notes are **unverified** | A weekly 100K-block latency gate on backend commands (`src-tauri/benches/interactive_slo.rs`); page mode stops at 1000 blocks; no Android number, no memory number | Unverified |
| Accessibility | No accessibility statement found in the help source (**unverified**) | Keyboard reach for every action, `axe` assertions in several hundred test files under `src/`, reduced-motion and contrast handling (`docs/FEATURE-MAP.md`). No screen-reader audit on record | Unverified |
| Interface languages | Many, by volunteer translators (help) | English, plus Spanish for error messages and a few settings strings (`src/lib/i18n/es/`) | Gap |
| Right-to-left | A right-to-left setting; 1.14 added a layout flip | No setting found (**unverified**) | Gap |

## 25. Platforms, Packaging and Updates

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Desktop | Windows, macOS (universal), Linux x86-64 and ARM64 | Linux, Windows, macOS x86-64 and aarch64 | Done |
| Packages | exe, dmg, AppImage, deb, Snap, Flatpak (community) | deb, rpm, AppImage, MSI, dmg | Done |
| Code signing | Not checked (**unverified**) | **Unsigned** desktop bundles: Gatekeeper and SmartScreen warn (`README.md`) | Gap |
| Auto-update | Desktop in-app, with periodic installer updates; mobile through stores | Desktop in-app, minisign-verified (`tauri-plugin-updater` in `src-tauri/Cargo.toml`); Android by manual APK | Partial |
| Runtime | Electron | Tauri with the system webview; the README cites a ~9 MB Linux bundle (**unverified**) | Design choice |

## 26. Licence, Governance and Longevity

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Licence | Proprietary, closed source, free of charge for every use; optional Commercial and Catalyst licences | GPL-3.0-or-later; forkable | Better |
| If the project stops | The app keeps working offline; the files stay Markdown; Sync and Publish stop | The app keeps working; the source stays; the data is SQLite plus an export | Tie |
| Bus factor | A company with a named team and paying customers | **One** | Partial |
| Roadmap transparency | Public roadmap and changelog | Public issues | Tie |
