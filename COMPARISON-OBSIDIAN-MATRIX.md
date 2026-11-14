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
| Plain-file projection | The vault is the files | **Markdown mirror** (Settings → Data, #5363): one `.md` per page, one folder per space. An outside edit, a new file, a rename or a move is read back as one undoable save, and a deleted file sends its page to the Trash (`src-tauri/src/mirror/`, `docs/features/import-export.md`). *Read changes back*, the per-space switches and *Copy attachments into the folder* are options. **Desktop only, off by default, per device**; the folder must be empty or the mirror's own, so it cannot adopt an existing vault in place (#6540) | Partial |
| Folders | Real folders, a file explorer, drag between folders | No folders. Namespaced titles (`a/b/c`) shown as a tree; spaces partition the vault | Design choice |
| Unit of addressing | The file; a block only once it carries `^id` | Every block has a ULID; nesting is capped (`MAX_BLOCK_DEPTH` in `src-tauri/agaric-store/src/block_descendants.rs`) | Better |
| Rename safety | Links are names; Obsidian rewrites them on a rename made inside the app (a setting, on by default) | Links are ids; a rename touches no other block | Better |
| Multiple vaults | Any number of folders, each its own window and settings | Spaces inside one database, each with its own journal, tabs, recents and property definitions (`docs/features/spaces.md`); a page moves between spaces after a list of the property values the target defines differently, with one undo (#6081) | Design choice |
| Exit | Nothing to export | Per-page copy or save as Markdown, **Export this space** / **Export all spaces** ZIPs with `assets/` and `.agaric/space.json` for property definitions (`docs/features/import-export.md`, #6277). On Android both ZIP rows and *Save as Markdown file* are off, because the WebView cannot save a file (#6538). History, trash, saved queries and device-local state are not exported | Partial |
| Non-note file types | `.base`, `.canvas`, images, audio, video, PDF open in the app | Attachments on blocks; images, audio and PDF render; no canvas or base file | Partial |

## 2. Editor

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Live Preview | Default editing mode: the whole note is one document, syntax shown near the cursor | **Markdown reveal** on by default in every block (`src/editor/extensions/markdown-reveal.ts`); the whole-page document is **page mode**, which is opt-in (`EDIT_MODE_PREFERENCE` defaults to `'blocks'` in `src/lib/preferences.ts`) and refuses pages over `PAGE_MODE_BLOCK_CAP` blocks (`src/editor/page-mode/page-mode-fit.ts`; #6536, #6224) | Partial |
| Source mode | A per-note toggle; the file is the source | **Edit as Markdown**: a whole-page plain-text buffer with Preview, a Changes diff, and Merge / Reload / Overwrite on a stale save (`docs/features/editor.md`). A separate mode, not a toggle of the same editor | Done |
| Reading view | A separate rendered view | None as a mode; every block but the focused one renders static | Design choice |
| Long-form writing | The default experience | Page mode, with its cap and opt-in. Blocks remain the storage unit, so a paragraph is a block | Partial |
| Outlining | List indent, fold, move line; the community Outliner plugin adds outliner behaviour | Native: indent, drag with depth projection, zoom, collapse, multi-select, a keyboard selection cursor | Better |
| Markdown dialect | CommonMark, GFM and LaTeX (help, *Obsidian Flavored Markdown*) | A CommonMark subset shared by import, source and paste (`docs/architecture/editor-and-content.md`); setext headings are text, and reference links and inline HTML beyond `<u>` are not read (no reader in `src/editor/markdown-parse/`) | Partial |
| Tables | Pipe tables; in Live Preview a right-click adds, deletes, sorts and moves rows and columns | Pipe tables, a size grid, and handles on the table that add, delete, move (drag or `Alt+Shift+arrows`) and sort rows and columns, as the toolbar's table menu does (`src/components/editor-toolbar/TableHandles.tsx`, #6607) | Done |
| Math | MathJax, inline and block | KaTeX, inline and block (`src/editor/extensions/math.ts`) | Done |
| Code blocks | Prism highlighting | lowlight highlighting, language popover (`src/editor/extensions/code-highlight.ts`) | Done |
| Mermaid | Built in; rendered by Obsidian's own library since 1.15 (changelog) | Built in, with a full-screen viewer and SVG download (`src/components/rendering/MermaidDiagram.tsx`; node view `src/editor/extensions/MermaidCodeBlockView.tsx`) | Done |
| Callouts | `> [!type]`, custom titles, foldable with `+` / `-`, custom types through CSS | The built-in styles (`CALLOUT_TYPES` in `src/components/RichContentRenderer/context.ts`); Obsidian's and GitHub's type names map to the nearest of them. A `-` or `+` after the type folds or opens the callout with a toggle; the fold is not saved (`src/editor/extensions/callout-blockquote.ts`) | Partial |
| Footnotes | `[^id]`, plus a Footnotes view core plugin | `[^label]` references numbered by first use and `[^label]:` definition blocks (`src/editor/extensions/footnote.ts`). No footnotes panel | Done |
| Comments | `%%hidden%%` | **None** (#6751). No handling of `%%` was found under `src/editor/`; an imported comment presumably stays visible text (**unverified**) | Gap |
| Highlight colours | Six colours (help, *Basic formatting syntax*; roadmap: October 2026) | One highlight (`==`) (#6759) | Gap |
| Folding | Headings and lists fold | Blocks collapse; the state is per device, not synced | Partial |
| Find in note | Find and replace | `Ctrl+F` with case, whole-word and regex; `Ctrl+H` replaces one or all matches in the open page, `$1` groups in regex mode; the Search view replaces literal text across pages, with a preview and an Undo (`docs/SEARCH.md`) | Done |
| Multiple cursors | Yes (help, *Multiple cursors*) | None | Gap |
| Slides | Core plugin | None | Gap |
| Spellcheck | Built in (roadmap: June 2020) | The webview's (`spellcheck: 'true'` in `src/editor/use-roving-editor.ts`) | Done |
| Audio recording | Audio recorder core plugin; iOS Quick Capture records and transcribes voice notes (1.15) | `/voice` records into an audio attachment where the webview can; `/meeting` makes a meeting page (#5364). A recording shows a transcript and a summary only if those files are supplied, by hand or by an agent (#5410): **Agaric does not transcribe**. A transcript's `[mm:ss]` paragraph stamps seek the player (#6290) | Done |
| Read aloud | No read-aloud page in the help (**unverified** absence) | OS voice on macOS, Windows and Android; hidden on Linux (#5745) | Unverified |

## 3. Linking and Transclusion

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Wikilinks | `[[Note]]`, or Markdown links as a setting; readable in the raw file | `[[` picker and typed `[[text]]`; `Alt+Enter` follows the link at the cursor, and a bookmark or recent page dragged into the editor becomes a link (#6061, #6065); stored as `[[ULID]]`, readable only through the app, an export or the mirror | Done |
| Aliases | `aliases` property; `[[Note\|label]]` | Page aliases as synced ops; `[[Page\|label]]` (`docs/features/tags-and-links.md`). A title and an alias share one name per space, ignoring case and Unicode form: a clash is refused, and a twin made on two devices is renamed `Title (2)` once they sync (#6318, #6345, #6356) | Done |
| Heading links | `[[Note#Heading]]`, `[[#Heading]]`, nested headings | `[[Page#Heading]]` and `[[#Heading]]` store a reference to the heading's block | Done |
| Block references | `[[Note#^id]]`; the id is added to the target line; `[[^^` searches blocks vault-wide | `((ULID))` for any block, no id line to add; shown as a chip with a peek (`src/components/BlockRefPeek.tsx`). The chip does not render the block's content inline, and the referenced block shows no count (#6746) | Partial |
| Embeds | `![[Note]]`, `![[Note#Heading]]`, `![[Note#^id]]`, images with `\|WxH`, audio, video, PDF, and embedded search queries | `{{embed}}` blocks (typed as `![[`) for pages, headings and blocks, live, editable behind an unlock; rows show content only (#6747), with depth and row caps (`MAX_EMBED_DEPTH`, `EMBED_MOUNT_LIMIT` in `src/lib/embed-token.ts`). Images keep Obsidian's `\|300` width (#4712) | Partial |
| Backlinks | Linked mentions per note, in a pane or in the document, with a search filter, sort order and context toggle (help, *Backlinks*) | Linked references grouped by page, paginated, with a filter tree and a link-kind toggle (`src/components/backlinks/LinkedReferences.tsx`) | Done |
| Unlinked mentions | Incoming, in Backlinks; outgoing, in Outgoing links | Incoming only, on pages, with "Link it" (`docs/features/tags-and-links.md`) | Partial |
| Outgoing links pane | Core plugin | **None** (#6749). The local graph shows neighbours; there is no list of a page's outgoing links | Gap |
| Hover preview | Page preview core plugin | Block-ref peek; `Ctrl`/`Cmd`+hover preview of a page link (`docs/FEATURE-MAP.md`) | Done |
| Link to a file that is not a note | Any file in the vault | Attachment links only | Partial |
| Merge and extract notes | Note composer core plugin | None; a block can be merged with the one before it, and a page moved to another space | Gap |

## 4. Properties and Bases

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Where properties live | YAML front matter: **per file only** | On any block or page (`block_properties`), with `key:: value` typing and a drawer | Better |
| Types | Text, List, Number, Checkbox, Date, Date & time, and Tags for the `tags` property (help, *Properties*) | Text, Number, Date, Boolean, Select, Ref, URL (`docs/features/properties.md`). **No list (#6741) and no date-time (#6758)** | Partial |
| Multi-value | List is a first-class type | **Absent** as a type (#6741). `PRIMARY KEY (block_id, key)`; on import a YAML list other than `tags` / `aliases` is joined into one comma-separated value (`docs/features/import-export.md` § Pitfalls) | Gap |
| Typed references | No reference type; a link is text in a Text or List property | `ref` type, rename-safe, with a chip that opens the target | Better |
| Enumerations | No select type among the types the help lists; that values autocomplete from use is **unverified** | `select` with options on the definition, option rename across the space | Better |
| Schema | A property name has one type vault-wide; rename and retype from the Properties view | Definitions per space, synced; built-ins fixed and locked. Rename, merge and retype with a preview; a value the new type cannot hold is kept as text, marked wherever it shows, and can be removed, added to a select's options, converted or moved to another key; usage counts; *Copy to space…* (Settings › Properties, `docs/features/properties.md`, #6206) | Done |
| Nested properties | Not supported in the UI (help says so) | Not supported | Tie |
| **Database views** | **Bases** (core): table, cards, list and kanban layouts (map with the Maps plugin); filters, formulas, summaries, grouping; properties edited from the view; `.base` files or embedded code blocks; a Bases API for plugin layouts. Rows are **files** | **Advanced Query**: nested AND / OR / NOT, sort, grouping by any `GroupKey`, count/sum/avg/min/max, as a list or a board. Rows are **blocks**. An inline `{{query}}` table derives its columns until you pick and order them (`src/components/query/QueryColumnPicker.tsx`); no editing in a table cell (#6743) and no computed columns. Saved views are pages of their space and sync (`docs/features/views.md`) | Partial |
| Board view | Kanban layout in Bases (1.14): dragging a card to another column updates the grouped property; the community Kanban plugin | An Advanced Query board: results grouped by task state or a select property become columns, and a card's *Move to…* menu sets the state or property, with Undo; no drag between columns (`src/components/AdvancedQuery/QueryBoard.tsx`, #6542) | Partial |
| Cards / gallery | Cards layout with images | None | Gap |
| Calendar view of records | Planned (roadmap) | None over a query; the monthly journal shows content dots per day | Tie |

## 5. Tags

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Inline tags | `#tag` in text or the `tags` property | `#[ULID]` chips; typed `#name` converts; `#[[multi word]]` reads as the existing tag of that name, else `multi-word`, and a new tag name holds no whitespace (#6334); same boundary rule as Obsidian on import | Done |
| Nested tags | `#a/b` is a real hierarchy: `tag:a` matches `#a/b`, the Tags view nests them (help, *Tags*) | `/` nests by name: `tag:#a` matches `#a/b` in search, query blocks and the query builder, and the Tags view nests them (`docs/features/tags-and-links.md`); no filter for the one tag without its nested tags | Done |
| Tag rename | Not in the *Tags* or *Tags view* help pages; the community Tag Wrangler plugin | Built in; chips hold the id, so one rename updates everything | Better vs core |
| Boolean tag queries | Search operators | `TagExpr` with And / Or / Not / Prefix | Done |
| Inherited tags | A file's tags apply to the file | A tag on a block can apply to its descendants, opt-in in the Tags view and `under:` in search; not in the inline query vocabulary | Partial |

## 6. Search

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Engine | In-app search over notes and canvases; relevance sort and accent-insensitive matching since 1.15.1 | SQLite FTS5 trigram with bm25 relevance and keyset pagination, over text as the editor shows it (escapes decoded, code raw, a `((ref))` as its target's first line, #6330); **a term shorter than `TRIGRAM_MIN_LEN` (`src-tauri/agaric-store/src/fts/search/sanitizer.rs`) is not searched**, except inside a longer quoted phrase or in regex mode (`docs/SEARCH.md`, #6752) | Partial |
| Operators | `file:`, `path:`, `content:`, `match-case:`, `ignore-case:`, `tag:`, `line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:`, `[property:value]`, `OR`, `-`, parentheses | `tag:`, `under:`, `path:`, `not-path:`, `state:`, `not-state:`, `priority:`, `not-priority:`, `due:`, `scheduled:`, `prop:`, `not-prop:` (`src/lib/search-query/register.ts`); FTS5 `AND` / `OR` / `NOT` on text terms. Filter tokens combine by fixed rules, not by parentheses | Partial |
| Scope of a match | File, or `line:` / `block:` / `section:` when asked | Always the block | Design choice |
| Regex | `/pattern/`, JavaScript flavour, combinable with operators | A regex toggle in find-across-pages and in `Ctrl+F` | Done |
| Property comparison | `[duration:<5]` | `prop:key=value` equality in search; comparison, range and existence operators in the query builder (`ALL_PROPERTY_OPS` in `src/components/PageBrowser/add-filter/vocab.ts`) | Partial |
| Embedded search | A `query` code block renders results in a note | `{{query}}` blocks (§7) | Done |
| Attachment text | "Obsidian only searches the contents of notes and canvases" | Attachment text is not indexed (`docs/SEARCH.md`) | Tie |
| Quick switcher / palette | `Ctrl+O`, `Ctrl+P` | `Ctrl+O`, `Ctrl+P`, `Ctrl+K` | Done |

## 7. Queries

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Core query surface | Embedded search queries; Bases filters and formulas with a function library (help, *Functions*) | `{{query}}` blocks with a structured payload over the `FilterPrimitive` set (`src-tauri/agaric-store/src/filters/primitive.rs`), live results, a visual builder. Template pages and their blocks are left out unless a filter names the `template` property (#6643) | Done |
| A query language you can read | Bases YAML; the community Dataview plugin's query language (**unverified**) | **No full one.** A query block takes the search box's filter syntax as text (`{{query tag:#work state:TODO}}`, AND only; `src/lib/query-text.ts`, #6628); `under:`, `path:`, relative dates and free text do not run there yet (#6742). The builder writes that text for a plain AND list, else `v2:<base64url(JSON)>` (`src/lib/inline-query-spec.ts`) | Partial |
| Computed columns | Bases formulas | Fixed aggregates (count, sum, average, minimum, maximum); no computed columns (#6757) | Gap |
| Scripting | Community plugins such as Dataview and Templater (**unverified**) | None | Gap |
| Granularity | Bases: files. Dataview: files, list items, tasks | Blocks, with page and tag context | Better vs core |
| Graph predicates | Search `file:` / link operators; Dataview's link fields (**unverified**) | `LinksTo`, `LinkedFrom`, `HasParentMatching`, `Orphan`, `Stub`, `HasNoInboundLinks`; one hop, no joins | Partial |

## 8. Tasks and Agenda

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Task model | A checkbox line, `- [ ]` / `- [x]`; `task:` search operators | A block with a state: `TODO → DOING → DONE → CANCELLED`, a fixed set (`src/lib/task-states.ts`) | Better |
| Dates, priority, recurrence | Not in core. The help documents none for tasks; the community **Tasks** and **TaskNotes** plugins add them | Built in: due and scheduled dates, priority 1 to 3 (`src/lib/priority-levels.ts`), repeat rules (`+`, `.+`, `++`) with end conditions, projected occurrences | Better vs core |
| Agenda | Not in core; Tasks queries, or a Base over one-task-per-file notes | Journal Agenda mode with stackable filter dimensions, Due and Done panels (`docs/features/journal-and-agenda.md`) | Better vs core |
| Interop with the Tasks plugin | N/A | Tasks' emoji date, priority, recurrence and done fields are read on import, paste, an *Edit as Markdown* save and MCP writes, and written on export, page copy, *Edit as Markdown*, the mirror and MCP page reads (`docs/FEATURE-MAP.md`, #6344) | Done |
| Custom statuses | The community Tasks plugin's custom statuses (**unverified**) | A fixed set (`TASK_STATES` in `src/lib/task-states.ts`); no WAITING | Partial |
| Reminders | Not in core | Desktop only, while the app runs, on `due_date` (`src-tauri/src/reminders.rs`, #4806). Nothing on Android | Partial |
| Time tracking | Plugins | None (#6745) | Gap |

## 9. Daily Notes and Journal

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Daily note | Core plugin: opens or creates today's note from a template, in a folder and date format you choose | Created on launch with the journal template | Done |
| Views | One note at a time; the community Calendar plugin adds a month sidebar | Daily, Weekly, Monthly, Stream, Agenda (`JournalMode` in `src/stores/journal.ts`); the Daily day opens as a page does, in blocks or page mode, while Weekly and Stream edit in blocks (#6077) | Better |
| Date format and location | Configurable Moment format; subfolders from the format | A fixed ISO identity (`YYYY-MM-DD`: stored, matched, sorted) with a display-format allowlist (`JOURNAL_DATE_FORMATS` in `src/lib/preferences.ts`) that names the day in the journal, pickers, Agenda, search and references (#6592). No folder to choose: a day is a row, not a file | Partial |
| Periodic notes (week, month) | Plugins | Views over days, not notes of their own | Design choice |
| Quick capture to today | Mobile Quick Capture (iOS 1.14; Android listed as active), CLI, URI | A global hotkey (`Ctrl+Alt+N`) and an `agaric://capture?text=` link on desktop, and MCP `capture` (`docs/features/agent-access.md`). No Android deep link, widget or share target on `main` (#6555) | Partial |

## 10. Templates

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Core templates | A template folder; `{{title}}`, `{{date}}`, `{{time}}` with Moment formats | Template pages, a Templates view, two variable grammars (`{{date}}`, `{{time}}`, `{{title}}`, and `<% today %>` and kin) including `{{cursor}}`. A date or time takes a `:FORMAT` suffix in date-fns tokens or their Moment spellings, so an Obsidian `{{date:dddd, MMMM Do}}` works (`docs/features/spaces.md`, #6300) | Done |
| Scripting | The community **Templater** plugin (**unverified** in detail) | None | Gap |
| Insert atomicity | N/A | `/template` copies task state, priority, dates and properties in one `create_blocks_batch` transaction, so a failed insert lands nothing and one undo takes the insert back (`insertTemplateBlocks` in `src/lib/template-utils.ts`, #6530); the journal template also copies in one | Done |
| Unique note creator | Core plugin (timestamp-named notes) | None; ids are intrinsic | Design choice |

## 11. Graph and Canvas

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Global graph | Yes, with search filters, colour groups, forces, orphans toggle, time-lapse animation | Force-directed graph with a filter bar; the edge set is capped at `PAGE_LINKS_EDGE_CAP` (`src-tauri/src/commands/pages/links.rs`), and the view says when it is (`src/components/graph/GraphView.tsx`) | Partial |
| Local graph | Yes, with depth | 1 or 2 hops, select-and-walk | Done |
| Colour groups by query | Yes | None | Gap |
| **Canvas** | Core: an infinite board of text cards, notes, media and web pages, with connections and groups, saved as open JSON Canvas | **None** | Gap |
| Drawing | The community Excalidraw plugin | None | Gap |

## 12. Workspace, Windows and Navigation

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Tabs | Yes: drag, pin, stack, link | Per-space tabs with drag reorder, middle-click close, background tabs, a switcher, reopen closed (`docs/features/views.md`) | Done |
| Split panes | Tab groups split horizontally and vertically | **None** (#6550). One page at a time | Gap |
| Pop-out windows | Desktop | None | Gap |
| Saved layouts | Workspaces core plugin | None; spaces restore their own tabs | Partial |
| Sidebars | Two, holding rearrangeable tabs (help, *Sidebar*) | One sidebar with fixed entries and bookmarks | Partial |
| Back / forward | Not checked in the help (**unverified**) | Yes, per space, with mouse buttons and Android back (`src/stores/navigation-history.ts`) | Done |
| Outline | Core plugin | Page outline (`src/components/pages/PageOutline.tsx`) | Done |
| Bookmarks | Notes, headings, blocks, searches, graphs | Pages only. A bookmark is a property of its page, so bookmarks and their sidebar order sync between devices; reorder by drag (#6640) | Partial |
| Web viewer | Core plugin (desktop) | None | Gap |
| Contexts | One vault per window, each with its own settings and plugins | Spaces with `Alt+1..9`, accent colour, separate journals; one settings set for all (the same trade as *Multiple vaults*, §1) | Design choice |

## 13. Commands, Hotkeys and Vim

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Command palette | `Ctrl+P`, every command, plugin commands included | `Ctrl+P` | Done |
| Hotkeys | Every command rebindable | Rebindable with conflict detection; a set of structural keys is fixed (`docs/features/keyboard.md`). Global chords follow Obsidian's (#6022) | Partial |
| Slash commands | Core plugin; runs any command | Built in, with sub-options and a recents band | Done |
| Vim mode | A setting ("Vim key bindings", help, *Settings*) | **None.** Only `j` / `k` in the History list | Gap |
| CLI | Obsidian CLI (1.12): "Anything you can do in Obsidian can be done from the command line"; the app must be running | `agaric-mcp call <tool> <json>` runs one MCP tool and exits, with an agent's token (`docs/features/agent-access.md`, `src-tauri/src/bin/agaric-mcp.rs`); the app must be running; desktop only; nothing beyond the MCP tools (§23) | Partial |
| URI scheme | `obsidian://open`, `new`, `search`, and more | `agaric://page/<id>`, `agaric://block/<id>`, `agaric://settings/<tab>`, `agaric://settings/safe-mode` and `agaric://capture?text=`, which opens Quick Capture and saves nothing until *Capture*; the page menu's *Copy app link* copies a page's link (#6645); desktop only, Android registers no handler (#6555) (`docs/features/agent-access.md`, `src-tauri/src/deeplink/mod.rs`) | Partial |

## 14. Themes and CSS

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Themes | A community theme directory; light and dark base | Built-in themes plus follow-system (`ThemeSelectValue` in `src/components/settings/AppearanceTab.tsx`) | Partial |
| CSS snippets | Any `.css` in the vault's config folder | One user stylesheet, Settings › Appearance › *Custom CSS*, applied after the app's, with an off switch and `agaric://settings/safe-mode` as the way back; a versioned token list is the compatibility promise, selectors are not; one sheet, no snippet folder, no file watching (`docs/features/appearance.md`, `src/hooks/useCustomCss.ts`) | Partial |
| Per-note styling | `cssclasses` property | None | Gap |
| Fonts, sizes | Custom fonts, sizes, readable line length | Note text size (`src/hooks/useFontSize.ts`) and, on desktop, interface zoom (`src/hooks/useInterfaceZoom.ts`); fonts only through custom CSS (`--font-sans`, `--font-mono`), no font picker (`docs/features/appearance.md`) | Partial |

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
| iOS | App Store; widgets, Siri and Shortcuts, a Share Sheet, Quick Capture and voice capture (help, roadmap) | **None**, and none planned (#6739) | Gap |
| Android | Google Play or direct APK; widgets (open note, new note, search, daily note) and a Quick Settings tile; Android Quick Capture is active on the roadmap | Signed APK, arm64 only, API 30+, **sideload only**; kept out of Android backup and device transfer, so a new phone is set up by pairing and an uninstall deletes the phone's notes (`README.md`) | Partial |
| Plugins on mobile | Yes (mobile page) | Not applicable | Gap |
| Phone UI | Tabs, palette, a customisable toolbar | Bottom sheets and 44 px targets (`docs/FEATURE-MAP.md`), a toolbar above the keyboard on touch (`docs/features/editor.md`). An emulator launches a release APK at each release and nightly, not per PR (`.github/workflows/android-launch-smoke.yml`); no physical device in CI | Done |
| Background sync | Not yet: "Background Sync on mobile" is active on the roadmap | Not yet: foreground only (`docs/architecture/sync-and-network.md`, #6740) | Tie |
| Quality | Not assessed here; **unverified** | Not assessed here; an earlier release aborted on every Android launch with CI green, and an emulator launch check now gates each release (`.github/workflows/android-launch-smoke.yml`, #6050) | Unverified |

## 17. Sync

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| First-party sync | **Obsidian Sync**: a paid subscription in two plans, Standard and Plus, that differ in vaults, storage, file size and history length. Unlimited devices | **Free.** No account and no server of the project's; the off-by-default internet fallback uses a relay run by iroh's maintainers (`docs/features/sync.md`) | Better on cost |
| Reach | Any network, through Obsidian's servers (DigitalOcean, selectable region) | **One local network.** Discovery is mDNS only; the opt-in internet fallback (#4549) carries traffic only between devices that already found each other (`docs/features/sync.md`); whether a paired device is reached across two networks through it is untried (#6519) | Partial |
| Encryption | End-to-end by default: AES-256, scrypt key derivation; a managed-key "standard encryption" option. Audited by Cure53 and Trail of Bits | QUIC with TLS 1.3 between the two devices; nothing is stored on a server, so there is nothing to encrypt at rest remotely | Design choice |
| Conflict handling | Markdown is merged with diff-match-patch, which "may sometimes create duplicate text or formatting problems", or written to a conflict file if you choose; every other file type, canvases included, is last-modified-wins; settings JSON is key-merged (help, *Troubleshoot Obsidian Sync*) | Loro CRDT per space: text, tree moves, properties, property definitions, tags, attachments, bookmarks and saved views converge with no conflict file. Two pages made with one name while apart are both kept: the device that made the newer one renames it `Name (2)` and says so; two such tags merge into the older. A property definition changed on both devices keeps the later change (`docs/features/sync.md`) | Better |
| Version history | Kept for a period that depends on the plan; deleted files restorable | The op log on each device (§21); not a remote copy | Design choice |
| Selective sync | By file type and folder, per device | **None.** A session syncs every space | Gap |
| Shared vaults | Yes, for other Sync subscribers; no fine-grained permissions | Out of scope: single user | Design choice |
| Headless client | `obsidian-headless` (open beta) for servers, CI and agents | A headless peer exists only as a test fixture (`e2e-tauri/sync-peer.ts`) | Gap |
| Third-party sync | Officially documented: iCloud, OneDrive, Google Drive, Syncthing, Git, Working Copy; each with caveats (iCloud on Windows "may lead to file duplication or corruption") | Not possible for the database. The Markdown mirror folder can be synced by such tools, on desktop, at the user's risk (**untested**); only one Agaric device can mirror into a given folder (`docs/features/import-export.md`) | Gap |
| Verified | A paid service in production since 2020 | A two-device suite required in CI (`e2e-tauri/sync-two-device.e2e.ts`) and daily Android and Linux use by the maintainer; guest networks, client isolation and two subnets are untested (`docs/features/sync.md`) | Partial |

## 18. Publish, Sharing and Collaboration

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Publish to the web | **Obsidian Publish**: a paid subscription per site, with a site password, custom domain, graph, full-text search and invited collaborators | **None** | Gap |
| Share one note | Publish, or send the file | Page menu: *Export as Markdown* (copy), *Save as Markdown file* (`<title>.md`, not on Android), *Print…* (not on Android); *Copy app link* copies an `agaric://page/<id>` link, which works only on a device with Agaric | Partial |
| Export to PDF | Desktop, and mobile since 1.15 | *Print…* in the page menu (not on Android) prints the page alone on the light palette through the system dialog; whether that dialog offers PDF is unchecked on macOS and Windows (`docs/features/appearance.md`, #6514, #6515) | Partial |
| Real-time collaboration | Not yet: "Multiplayer" is planned | Out of scope by the threat model (`AGENTS.md` § Threat Model) | Design choice |

## 19. Capture and Web Clipper

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Web clipper | Official, free, open-source extension for Chrome and Chromium browsers, Firefox (desktop and mobile), Safari and Edge; highlights, templates with logic | **No extension** (#6753). A bookmarklet sends a page's title and address to Quick Capture through `agaric://capture?text=` on desktop (`docs/features/agent-access.md`). Pasted HTML converts to blocks (`src/editor/html-to-blocks.ts`) | Gap |
| Mobile share target | iOS Share Sheet (roadmap: July 2026) | None on `main`; text shared into Quick Capture on Android is built in an open pull request (#6555) | Gap |
| Widgets | Widgets on iOS and Android (help) | None | Gap |
| Global hotkey capture | Through the CLI or URI | Quick Capture hotkey on desktop | Done |

## 20. Import and Export

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Importers | **Importer** (official plugin): Notion, Airtable, OneNote, Evernote, Apple Notes, Apple Journal, Google Keep, Bear, Craft, Roam, Logseq, Samsung Notes, Tomboy, and HTML, CSV, Markdown and Textbundle files | Markdown files and folders, **Obsidian vault**, Logseq graph, Org, Notion export, Evernote `.enex`, Joplin `.jex`, BibTeX / CSL-JSON (`docs/features/import-export.md`) | Partial |
| Obsidian vault fidelity | N/A | Wikilinks, aliases, heading and block anchors, `![[…]]` embeds, image sizes, Tasks-plugin fields, callout types and attachments are mapped. **Lost or flattened:** list properties, `.canvas` and `.base` files, Dataview and Templater code, `%%comments%%`, plugin data, folder structure (it becomes title namespaces) | Partial |
| Re-import | N/A | A file, a folder's note, an Evernote or Joplin note, or a Logseq or Org file whose title names a page with content updates that page in place after a listed confirmation; Undo on the page reverts it (#6277, `docs/features/import-export.md`) | Done |
| Export | The vault is the export; PDF per note | Per page: copy, or save `<title>.md`. A Markdown ZIP per space or for all spaces (not on Android, #6546), restoring templates, done dates, attachments and property definitions on a folder import (#6277), and every space from an unzipped all-spaces ZIP (#6554); on desktop the Markdown mirror (§1) keeps a live `.md` file per page; *Print…* for paper; no HTML or structured JSON | Partial |

## 21. Attachments, PDF, History and Recovery

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Attachment formats | Images, audio, video, PDF listed in *Accepted file formats* | Images with resize and lightbox, audio players, PDF, other files as links | Partial |
| PDF viewing | Built-in viewer (roadmap: May 2023); deep links into PDFs (June 2023) | pdf.js viewer in a dialog (`src/components/dialogs/PdfViewerDialog.tsx`); an annotation block's source chip opens it on that page (`src/components/editor/PdfSourceChip.tsx`) | Done |
| PDF annotation | **Planned**, not shipped (roadmap) | Text highlights and pinned text comments, no ink. *Save* writes a new copy of the file, moves the owning block's links and its annotation blocks to it and deletes the original (`src/components/dialogs/PdfViewerDialog.tsx`, #6629). Each new highlight or comment also becomes a child block of the PDF's block, searchable and linkable, with a source chip back to its page (`docs/architecture/pdf-annotations.md`, #6682); a link copied into another block still names the original | Better |
| Local history | File recovery: whole-file snapshots of `.md` and `.canvas`, at an interval and for a retention period that are both configurable, per device, outside the vault | Every edit is an op: per-block and per-page history, word-level diff, "Restore to here", batch revert (`docs/features/views.md`). **Ops older than the retention window are pruned** (`DEFAULT_RETENTION_DAYS`; `op_log_compact` in `src-tauri/src/maintenance.rs`) | Better |
| Trash | Not checked in the help (**unverified**) | In-app Trash with restore; purged after `TOMBSTONE_RETENTION_DAYS` (`src-tauri/src/maintenance.rs`) | Done |
| Backup | Any file backup tool works; help says "Syncing is not a backup" | A daily snapshot of the database beside it, the newest few kept (`MAX_KEPT_DAILY_SNAPSHOTS` in `src-tauri/src/db/daily_snapshot.rs`), and a copy before each schema-changing update; nothing in the app reads one back (#6744) and none leaves the disk. The exits are the ZIP export and the mirror, both of which drop history | Partial |
| Integrity check | None documented, and less to check: the files are the truth | Settings › App health rebuilds derived tables and compares them with the base tables and the CRDT (#6488); it guards a failure mode Obsidian does not have | Design choice |

## 22. Encryption and Privacy

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Local encryption | None: "Obsidian doesn't encrypt your local vault" | None; rely on full-disk encryption (`README.md`) | Tie |
| Sync encryption | End-to-end by default (§17) | Transport only; no third party holds data unless the relay fallback is on, and the relay forwards ciphertext | Design choice |
| Telemetry | "no telemetry data is collected" (security page) | No telemetry or analytics. The desktop app asks GitHub at most once a day for a newer release, and a web link is fetched from its own site for a preview, which a setting turns off for hover (`README.md`) | Tie |
| Account | None for the app; one for Sync and Publish | None | Tie |

## 23. AI and Agents

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Agent access without any API | **Yes, by construction.** An agent that can read a folder can read and edit the vault | No. The database is opaque. The desktop mirror (off by default) gives an agent a folder of `.md` files, and with *Read changes back* on, an outside edit, new file, rename or delete is read into the vault as one undoable save (§1) | Partial |
| First-party MCP | None found in the roadmap, the changelog or the help (**unverified** absence) | A bundled MCP bridge with a read-only tool set and a read-write one (`src-tauri/src/mcp/tools_ro.rs`, `src-tauri/src/mcp/tools_rw.rs`), each client an agent with a token, a mode and a space allow-list (`docs/features/agent-access.md`); desktop only | Better |
| First-party automation | CLI (1.12), URI scheme, headless Sync | MCP, `agaric-mcp call <tool> <json>` for scripts, and `agaric://` links (page, block, settings, capture) (`docs/features/agent-access.md`) | Partial |
| In-app AI | Not in the app; the Web Clipper has a language-model "Interpreter"; community plugins | None | Gap |
| Audit of agent edits | Whatever the file history or git shows | Ops stamped `agent:<name>` and badged with the name in the History view; an in-memory activity feed (`ACTIVITY_RING_CAPACITY`) with one-click session revert (`docs/features/agent-access.md`) | Partial |
| Semantic search | Plugins | None | Gap |

## 24. Performance, Accessibility and Localisation

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Vault scale | No published benchmark found. The 1.15.1 notes say search results "appear much faster when a search matches thousands of notes". Community reports of vaults with tens of thousands of notes are **unverified** | A weekly latency gate on backend commands at `FIXTURE_SIZE` blocks (`src-tauri/benches/interactive_slo.rs`); page mode stops at `PAGE_MODE_BLOCK_CAP`; no Android number, no memory number | Unverified |
| Accessibility | No accessibility statement found in the help source (**unverified**) | Keyboard reach for every action; `axe` assertions in the component tests under `src/` and a rendered axe sweep of every top-level view in the light and dark themes (`e2e/views-axe.spec.ts`); text and surface colour pairs held to WCAG AA across the themes (`src/lib/__tests__/theme-contrast.test.ts`); reduced-motion handling (`docs/FEATURE-MAP.md`) and an *Animations* setting that follows the system, speeds motion up or turns it off. No screen-reader audit on record | Unverified |
| Interface languages | Many, by volunteer translators (help) | English, plus Spanish for error messages and a few settings strings (`src/lib/i18n/es/`, #6750) | Gap |
| Right-to-left | A right-to-left setting; 1.14 added a layout flip | Automatic per paragraph, by its first strong letter (`docs/features/appearance.md`); the interface stays left to right, and there is no direction setting | Partial |

## 25. Platforms, Packaging and Updates

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Desktop | Windows, macOS (universal), Linux x86-64 and ARM64 | Linux x86-64, Windows x64, macOS x86-64 and aarch64 (`README.md`); no Linux ARM64 | Partial |
| Packages | exe, dmg, AppImage, deb, Snap, Flatpak (community) | deb, rpm, AppImage, NSIS `-setup.exe`, MSI, dmg; a winget manifest and a Flathub draft are in the repository, neither submitted (#6660) | Done |
| Code signing | Not checked (**unverified**) | **Unsigned** desktop bundles: Gatekeeper and SmartScreen warn (`README.md`) | Gap |
| Auto-update | Desktop in-app, with periodic installer updates; mobile through stores | Desktop in-app, minisign-verified (`tauri-plugin-updater` in `src-tauri/Cargo.toml`); Android by manual APK | Partial |
| Runtime | Electron | Tauri 2 with the system webview (WebKitGTK, WKWebView, WebView2) | Design choice |

## 26. Licence, Governance and Longevity

| Capability | Obsidian | Agaric | Status |
| --- | --- | --- | --- |
| Licence | Proprietary, closed source, free of charge for every use; optional Commercial and Catalyst licences | GPL-3.0-or-later; forkable | Better |
| If the project stops | The app keeps working offline; the files stay Markdown; Sync and Publish stop | The app keeps working; the source stays; the data is SQLite plus an export | Tie |
| Bus factor | A company with a named team and paying customers | **One** | Partial |
| Roadmap transparency | Public roadmap and changelog | Public issues | Tie |

## Scorecard

No points are awarded. Each line counts the rows of one section by the status Agaric earned there against Obsidian core: **Ahead** is any Better, qualified or not; **Level** is Done or Tie; **Behind** is Partial or Gap; **Not ranked** is Design choice or Unverified. A count is not a weight: "Plugin API" and "Highlight colours" are one row each, and the choice of rows is this document's. `node scripts/comparison-scorecard.mjs --write` recounts the table from the rows above.

<!-- scorecard:start -->
| Section | Ahead | Level | Behind | Not ranked |
| --- | :---: | :---: | :---: | :---: |
| 1. Notes, Files and Data Ownership | 2 | 0 | 4 | 3 |
| 2. Editor | 1 | 9 | 9 | 2 |
| 3. Linking and Transclusion | 0 | 5 | 6 | 0 |
| 4. Properties and Bases | 3 | 3 | 5 | 0 |
| 5. Tags | 1 | 3 | 1 | 0 |
| 6. Search | 0 | 4 | 3 | 1 |
| 7. Queries | 1 | 1 | 4 | 0 |
| 8. Tasks and Agenda | 3 | 1 | 3 | 0 |
| 9. Daily Notes and Journal | 1 | 1 | 2 | 1 |
| 10. Templates | 0 | 2 | 1 | 1 |
| 11. Graph and Canvas | 0 | 1 | 4 | 0 |
| 12. Workspace, Windows and Navigation | 0 | 3 | 6 | 1 |
| 13. Commands, Hotkeys and Vim | 0 | 2 | 4 | 0 |
| 14. Themes and CSS | 0 | 0 | 4 | 0 |
| 15. Plugins and API | 0 | 0 | 2 | 3 |
| 16. Mobile | 0 | 2 | 3 | 1 |
| 17. Sync | 2 | 0 | 5 | 3 |
| 18. Publish, Sharing and Collaboration | 0 | 0 | 3 | 1 |
| 19. Capture and Web Clipper | 0 | 1 | 3 | 0 |
| 20. Import and Export | 0 | 1 | 3 | 0 |
| 21. Attachments, PDF, History and Recovery | 2 | 2 | 2 | 1 |
| 22. Encryption and Privacy | 0 | 3 | 0 | 1 |
| 23. AI and Agents | 1 | 0 | 5 | 0 |
| 24. Performance, Accessibility and Localisation | 0 | 0 | 2 | 2 |
| 25. Platforms, Packaging and Updates | 0 | 1 | 3 | 1 |
| 26. Licence, Governance and Longevity | 1 | 2 | 1 | 0 |
| **Total (175 rows)** | **18** | **47** | **88** | **22** |
<!-- scorecard:end -->

How to read it:

- **On breadth Obsidian core is well ahead.** Agaric is behind in most ranked rows, and several of its leads (tag rename, query granularity, task dates and recurrence, the agenda) are over core only: a popular community plugin answers each.
- **Agaric's leads are structural**: addressable blocks, properties on any block, a CRDT, an op log, the licence. **Obsidian's are reach and surface**: platforms, stores, views, plugins, sync on any network. A structural lead does not close a reach gap by itself.
