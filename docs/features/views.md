<!-- markdownlint-disable MD060 -->
# Views

Agaric has a fixed set of views, plus a **Page Editor** view that's reached by navigation. The sidebar lists the daily ones — Journal, Pages, Search, Tags — with Settings in its footer. A row of buttons in the Pages header opens Tags, Graph, Query, Templates and Trash; History opens from the *Open edit history* row in Settings › Data, and Status lives in the Settings › App health tab. Every view is space-scoped — switching the active space refreshes what each shows. See [spaces.md](spaces.md) for the partition model.

The **Journal** view (default landing) and the **Agenda** mode inside it have their own file: [journal-and-agenda.md](journal-and-agenda.md).

This file covers the other views and the page editor.

## Search

Reachable via the sidebar Search icon or `Ctrl+Shift+F` (this is the find-across-pages view; `Ctrl+F` is the separate in-page find). **[../SEARCH.md](../SEARCH.md) is the source of truth** for the full filter DSL, toggles, regex, and mobile behaviour — this is the view-level overview.

- **Full-text search** across every block in the active space, **debounced** as you type. **Press Enter** to commit immediately without waiting for the debounce.
- **Inline filter DSL**: type structural filters straight into the input — `tag:#urgent`, `path:Journal/*`, `state:TODO`, `priority:1`, `due:this-week`, `scheduled:today`, `prop:key=value`, plus the `AND`/`OR`/`NOT` boolean operators. A query made only of filters still searches (returns matching blocks, most-recent first). **Filter-prefix autocomplete** suggests values as you type a recognised prefix.
- **Add filter builder**: a guided popover above the chip row adds the same filters without memorising the syntax. Every chip is a projection of the parsed query, so the query string stays canonical — copy-pasting a query reproduces every filter exactly.
- **Toggles** (right of the input): case-sensitive (`Aa`), whole-word (`Ab|`), and regex (`.*`). Preferences persist across windows in `localStorage`.
- **Filter chips**: *Page path (include)* and *Page path (exclude)* scope by page-title glob (`path:` / `not-path:`), several `path:` chips OR-combining; *Tag* chips AND-combine. Adding a chip, removing one, *Clear all* and the zero-results *Clear filters* re-run the search at once. **Alias resolution** surfaces a page's title from a typed alias.
- **Per-space history**: with the input empty, `↑` / `↓` recall the last 20 submitted queries (most-recent first), partitioned per space.
- **In-app help**: the `?` button in the toolbar opens a reference dialog (filter syntax, toggles, regex, boolean operators, tips).
- **CJK note**: full-text search does not currently tokenise CJK languages with word-boundary intelligence — substring matches still work, but the whole-word toggle does not match CJK.
- **Cursor pagination**: *Load more* fetches the next page. **Click a result** to navigate; the block scrolls into view and focuses.
- **Mobile**: touch devices reach search through a single Sheet (magnifying-glass, top-right) with *In this page* / *Across all pages* segments; the across-pages segment can escalate into this full find-across-pages view.

## Pages

Browse every page in the active space. The first row is search, then sort, saved views and a **New page** button. Search takes focus when you open the view with a mouse or trackpad, never on a touch screen, so a phone's keyboard does not cover the list. While the search text names no page, the results start with a **Create page "…"** row that opens the New page dialog with that title.

- **Namespace tree**: pages are organised by `/`-delimited namespace, e.g. `Projects/Website/Backlog`. Folders show a count badge and a `+` button that creates a child page through the New page dialog.
- **Sort dropdown**: Alphabetical, Last opened, Created, Last edited, Most linked, Most content. Every sort orders all the pages in the space, not just the loaded ones. Alphabetical ignores accents and case (`Émile` sorts with E); Last edited counts an edit to any block on the page; Last opened is this device's own history, never synced.
- **Filter chips** narrow the list ([../PAGES.md](../PAGES.md)). A space starts with *Exclude journal pages*, which hides the `YYYY-MM-DD` pages until you remove it.
- **Virtualised list**: scrolls smoothly even with thousands of pages.
- **Multi-select** pages with `Ctrl/Shift+Click`; **batch delete** with confirmation.
- **Inline rename**: right-click → Rename, or click the page in the **PageEditor** and rename inline in the title. A title is unique within its space: renaming onto an existing title is refused, and creating one (including via `[[name]]`) opens the existing page.
- **Starred pages**: starred pages appear in a separate flat list above the tree.

To create a new page: the *New Page* button in the sidebar or in the Pages header, `Ctrl+N`, or the palette's *Create new page*. Each opens the **New page** dialog. As you type a title it lists up to five pages with a similar name (the same matching as the `[[` link picker, aliases included), each with an *Open* button. When a page already has that title or alias, ignoring case, the dialog says so, *Open it* replaces *Create*, and Create is disabled. Enter creates the page, which opens in the active tab; a blank title makes the first free `Untitled N`. A namespace folder's `+` opens the dialog with the namespace filled in and shows the parent path.

## Tags

Browse every tag and the blocks that carry them.

- **Tag list**: all tags in the active space, with usage counts and colour swatches.
- **Per-tag page**: clicking a tag opens its dedicated page — the title is the tag, and every block referencing it is listed.
- **Boolean tag queries** in the filter panel — see [tags-and-links.md](tags-and-links.md).
- **Rename / recolour** a tag from its tag page header.

## Query (advanced query)

A dedicated builder for queries too complex for the search box.

- **Nested boolean tree**: arbitrary AND / OR / NOT groups over filter leaves, composed visually.
- **Controls bar**: full-text term, sort, group-by (tag, page, state, block type, priority, a property key, or a date bucket — due / scheduled / created / last edited, by day, week, or month), aggregates.
- **Results pane**: flat with a global aggregate bar, or grouped with per-group headers, counts, and aggregate chips.
- **Saved views** keep a query to load, rename or delete later. They are kept per space on this device and do not sync.

## Trash

Soft-deleted pages and blocks. Deletes don't purge immediately — they land here.

- **Roots-only listing**: a deleted page and its blocks appear as a single entry with a child count. Restoring the root brings the whole tree back together.
- **Search** the trash with a debounced text input.
- **Restore** a single item, or multi-select and batch-restore.
- **Purge** a single item permanently (with confirmation), or batch-purge.
- **Restore All / Empty Trash** in the header for the nuclear options.
- The Pages header's **Trash** button shows a count badge; large purges may trigger a "non-reversible" warning dialog before confirming.

## History

Global operation log — every edit Agaric has applied, in reverse chronological order. Opened from Settings › Data › *Open edit history*.

- **Op type icons** distinguish creates, edits, deletes, restores, properties, tags.
- **Filter bar**: filter by op type. There is no user-vs-agent or date-range filter; ops that arrived from another device are marked, but agent-authored ops are not distinguished from your own.
- **Multi-select** + **batch revert** — selecting a set of ops and pressing Enter reverts them all, newest first.
- **Diff toggle**: word-level diff for edits.
- **Restore to here**: every entry has a *"Restore to here"* button that reverts every op after that point. Use with care — it's a snapshot rollback.
- **Vim keys**: `j` / `k` for next / previous; `Home` / `End` for first / last; `PageDown` / `PageUp` to page.
- **Per-block history sheet**: from a block's toolbar → History — opens a sheet with only that block's edits.
- **Compaction**: a card at the top shows op-log stats and how many ops are eligible for compaction; *Compact* runs the cleanup.

## Templates

Pages tagged as templates.

- **Browse**: each template is a page; the row shows a preview of its first child block.
- **Insert a template**: in any block, type `/template` → **TemplatePicker** → pick. The template's children land under the current block.
- **Toggle template status**: open the page → **PageHeaderMenu** kebab → *Toggle template*.
- **Journal template**: the template page new daily pages in the space copy, nesting included; it carries a *Journal template* badge. Set it from the page kebab (*Set as journal template*) or the journal's *Configure journal template* button — see [spaces.md](spaces.md).

## Graph

A force-directed graph of pages and the links between them.

- **Nodes** are pages; **edges** are `[[link]]` references.
- **Node size** grows with the page's links on screen, in and out; the selected node, else the page open in the active tab, is marked in the accent colour. Edges are faint hairlines that stay one pixel wide at every zoom.
- **Layout**: a well-linked page pushes its neighbours further out than an unlinked one, and separate clusters stay close together instead of drifting apart.
- **Filter bar** in the header: filter by tag, task status, priority, presence of a due date, presence of a scheduled date, presence of backlinks, exclude templates, and exclude journal pages (pages titled `YYYY-MM-DD`). Filters stack as removable pills; there is no date-range or content-match filter. A space with no saved graph filters starts with *Exclude journal pages*; removing it is remembered per space.
- **Local graph**: *Focus on this page* narrows the graph to the open page's 1- or 2-hop neighbourhood. Selecting a node re-centres the neighbourhood on it, so you can walk the graph hop by hop; nodes that stay keep their place, and *Back to "…"* returns to the page you started from. *Show in graph* in the page kebab (palette: *Show this page in graph*, `Ctrl+Shift+G`) opens it from the page; mode and depth are remembered per space, and a page the filters hide says so. Coming back to the graph shows the layout and zoom as they were left, for the session.
- **Zoom / pan** with mouse / trackpad / touch. A fresh layout is fitted to the view once it settles; *Fit to view* (`0`) frames every node again.
- **Labels** stay the same size on screen at every zoom, with a halo in the background colour so they read over edges. The open page, the hovered, focused and selected nodes, and their neighbours are always labelled; other nodes are labelled once they are big enough on screen, so hubs come first and more appear as you zoom in, and a label that would overlap one already shown is hidden. Labels are chosen again when the layout settles or a zoom ends.
- **Select, then open**: a click or tap selects a node, which takes the accent, keeps its neighbourhood highlighted and shows its full title. A second click on the selected node opens it in place; Ctrl/Cmd-click or middle-click opens it in a background tab (on mobile, in place).
- **Keyboard**: Tab enters the graph; the arrow keys move to the nearest node in that direction on screen, and typing moves to the next node whose name starts with what was typed; the node moved to pans into view. Space selects, Enter opens, and Escape clears the selection. The nodes are the options of a listbox, and a selection is announced.
- **Web Worker**: the simulation runs in a worker so the main thread stays responsive on large graphs. Falls back to the main thread if Web Workers are unavailable.
- **Reduced motion**: the simulation honours `prefers-reduced-motion` and skips the layout animation.

## Status

Materializer metrics, in Settings › App health. Useful for diagnosing slowness.

- **Materializer queue depth**: how far behind the read-side projection is (foreground and background queues).
- **Op counts**: total ops; ops dispatched.
- Polls the backend periodically.

Once a device is paired, the aggregated sync state (overall state, last successful sync, peer count) is the first card of Settings › Sync & devices. It shows status only; to retry, use *Sync all* or a device's *Sync now* in the list below it.

## Settings

Tabbed configuration view. On desktop the tabs sit in a vertical rail, bucketed into four groups; on a phone a grouped picker at the top replaces the rail. Each tab is named once, by the rail: panels carry no title of their own. Settings are rows, with the label and description on the left and the control on the right (stacked on a phone).

- **Workspace**
  - **General** — language, week start, journal date format, launch-at-login (desktop).
  - **Appearance** — theme (the palette's *Toggle theme* cycles auto / dark / light), font size, animations, tooltip delay. Font size scales note text and its row controls (checkboxes, gutter icons, chip and inline icons), not the app chrome: the sidebar, headers, toolbars and settings stay fixed.
  - **Editor** — *Edit pages as* blocks or one page (desktop; see [editor.md](editor.md#page-mode)), the `:` emoji picker, *Tab indents blocks*, external images (the setting governs blocks as they render; while a block is being edited, the editor loads its external images whatever the setting), link previews on hover.
  - **Keyboard** — the system-wide Quick Capture hotkey (desktop), then full shortcut customisation (see [keyboard.md](keyboard.md)).
  - **Tasks & reminders** (id `notifications`) — the deadline warning days for the Agenda's Upcoming list, due-task reminders, the reminder time, the OS permission and a test notification.
  - **Spaces** — the space this device opens in (*Open on launch*: last used or one space), and create, rename, recolour or delete spaces (see [spaces.md](spaces.md)). The SpaceSwitcher's *Manage spaces…* opens it.
  - **Properties** — list of property definitions with their type; create a definition, delete an unused one, and edit a select key's options. A built-in definition shows a lock and can't be edited or deleted. The internal `is_space` definition is not listed.
- **Integrations**
  - **Agent access** — read-only and read-write switches; each shows its socket path and connections only while it is on. The activity feed with SessionRevertControls is a separate card, shown whether or not access is on (see [agent-access.md](agent-access.md)).
- **Data & sync**
  - **Sync & devices** — the sync state once a device is paired, then pair / unpair / rename peers, *Sync all* and per-device *Sync now* (the way to retry), manual addresses, the internet fallback, and this device's ID (see [sync.md](sync.md)).
  - **Data** — import / export (see [import-export.md](import-export.md)), and *Open edit history*, which opens the History view.
- **Help**
  - **Help** — *Report a bug*, debug mode, show the welcome tour again, update check.
  - **App health** — the integrity check: *Run check* rebuilds every derived table from your notes, compares your notes with the sync engine's copy, and lists the rows that disagree. A bug report filed from Help afterwards carries the result, until you leave Settings. Materializer metrics follow it (see Status above). The tab's id is still `status`.

Tabs are deep-linkable via `?settings=<tab>` (parsed inside the Settings view itself, no router involved) and via `agaric://settings/<tab>`. The retired `history` id opens Data. The last-used tab persists in `localStorage`.

## Page Editor

The view that opens when you navigate to a single page. Not a sidebar entry — reached by clicking a page chip, the title in a list, a deep link, or by creating a new page.

- **Editable title** in the page header — rich rendering of inline `[[links]]` survives.
- **Breadcrumb** for namespaced titles (e.g. `Projects › Website › Backlog`).
- **Alias section** below the title (managed via the **PageHeader**).
- **Tag row**: inline tag editor for page-level tags.
- **Property table**: page-level properties shown in a row.
- **Block tree**: the editor proper. See [editor.md](editor.md).
- **Outline** (TOC): sheet slide-out, opened from the page kebab menu, showing the page's heading hierarchy, each heading with its links, tags and block refs by title and its formatting rendered.
- **Linked / Unlinked references** below the block tree: see [tags-and-links.md](tags-and-links.md).
- **Page kebab menu (PageHeaderMenu)**: Undo, Redo, Open outline, Show in graph, Insert emoji, Move to space, Add alias, Add tag, Export as Markdown, Edit as Markdown (the page as one markdown buffer, in place of its blocks; see [editor.md](editor.md#edit-as-markdown)), Send to Trash, Toggle template.
- **Zoom into a block** to focus on a sub-tree: breadcrumb at the top, click parts to zoom out.
- **Image lightbox / PDF viewer**: opens for inline attachments.

## Tabs

A **TabBar** above the active view holds open pages (desktop only; hidden on mobile and when a single tab is open). Each tab persists per space — switching spaces restores that space's tabs. A click on a tab opens it. The caret left of the tabs opens a switcher listing every open tab under a filter field: typing narrows the list to the tabs whose title or full path contains the text, ignoring case; the arrow keys move through the matches, Enter opens one, Escape closes, and each row's × closes its tab.

A middle click on anything that opens a page opens it in a **background tab**, as a browser does, leaving the current view on screen: a `[[link]]` or `((ref))` in a block, a Pages row or tree entry, a bookmark, a recent page, a search result, a reference, an agenda or task row, a page link in a list, a graph node. Right-click (long-press on touch) offers *Open in new tab* for the same; on a block's link it is the first row of the block menu. Mobile shows no tabs, so there neither applies.

## Recent pages strip

Below the TabBar on desktop, a horizontal strip of the recently-opened pages in the active space. Click to re-open; Ctrl/Cmd-click or middle-click opens it in a background tab. Settings does not show it.
