<!-- markdownlint-disable MD060 -->
# Views

Agaric has a sidebar with a fixed set of nav items (the "views"), plus a **Page Editor** view that's reached by navigation rather than the sidebar. Every view is space-scoped — switching the active space refreshes what each shows. See [spaces.md](spaces.md) for the partition model.

The **Journal** view (default landing) and the **Agenda** mode inside it have their own file: [journal-and-agenda.md](journal-and-agenda.md).

This file covers the other sidebar views and the page editor.

## Search

Reachable via the sidebar Search icon or `Ctrl+F` from anywhere.

- **Full-text search** across every block in the active space.
- **Debounced** as you type; results re-fetch after a short pause.
- **Press Enter** to commit immediately without waiting for the debounce.
- **Filter chips**: scope by *page* (multi-select) and by *tag* (multi-select).
- **Alias resolution**: typing a page alias surfaces that page's title in results.
- **CJK note**: full-text search does not currently tokenise CJK languages with word-boundary intelligence — substring matches still work.
- **Cursor pagination**: *Load more* fetches the next page.
- **Click a result** to navigate; the block scrolls into view and focuses.

## Pages

Browse every page in the active space.

- **Tree view** (default): pages organised by `/`-delimited namespace, e.g. `Projects/Website/Backlog`. Folders show a count badge and a `+` button to create a child page inline.
- **Flat view**: every page, no hierarchy.
- **Sort dropdown**: Recent / Alphabetical / Created.
- **Virtualised list**: scrolls smoothly even with thousands of pages.
- **Multi-select** pages with `Ctrl/Shift+Click`; **batch delete** with confirmation.
- **Inline rename**: right-click → Rename, or click the page in the **PageEditor** and rename inline in the title.
- **Starred pages**: starred pages appear in a separate flat list above the tree.

To create a new page: sidebar footer → *New Page* button. The new page opens in the active tab.

## Tags

Browse every tag and the blocks that carry them.

- **Tag list**: all tags in the active space, with usage counts and colour swatches.
- **Per-tag page**: clicking a tag opens its dedicated page — the title is the tag, and every block referencing it is listed.
- **Boolean tag queries** in the filter panel — see [tags-and-links.md](tags-and-links.md).
- **Rename / recolour** a tag from its tag page header.

## Trash

Soft-deleted pages and blocks. Deletes don't purge immediately — they land here.

- **Roots-only listing**: a deleted page and its blocks appear as a single entry with a child count. Restoring the root brings the whole tree back together.
- **Search** the trash with a debounced text input.
- **Restore** a single item, or multi-select and batch-restore.
- **Purge** a single item permanently (with confirmation), or batch-purge.
- **Restore All / Empty Trash** in the header for the nuclear options.
- The sidebar **Trash** entry shows a count badge; large purges may trigger a "non-reversible" warning dialog before confirming.

## History

Global operation log — every edit Agaric has applied, in reverse chronological order.

- **Op type icons** distinguish creates, edits, deletes, restores, properties, tags.
- **Filter bar**: filter by op type, by user vs agent, by date range.
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
- **Per-space journal template**: separate from the templates view — set in [spaces.md](spaces.md) → *Manage Spaces…*.

## Graph

A force-directed graph of pages and the links between them.

- **Nodes** are pages; **edges** are `[[link]]` references.
- **Filter bar** in the header: scope by tag, by property, by date range, by content match.
- **Zoom / pan** with mouse / trackpad / touch.
- **Click a node** to navigate to its page.
- **Web Worker**: the simulation runs in a worker so the main thread stays responsive on large graphs. Falls back to the main thread if Web Workers are unavailable.
- **Reduced motion**: the simulation honours `prefers-reduced-motion` and skips the layout animation.

## Status

Materializer + sync metrics. Useful for diagnosing slowness.

- **Materializer queue depth**: how far behind the read-side projection is.
- **Op counts**: total ops; ops dispatched.
- **Sync state**: per-peer last successful sync, last error.
- Polls the backend periodically.

## Settings

Tabbed configuration view. Tabs include:

- **General** — theme, task state cycle, deadline warning days.
- **Properties** — list of property definitions; rename, change type, edit select options.
- **Appearance** — theme (auto / light / dark / Solarized / One Dark Pro), sidebar width, density.
- **Keyboard** — full shortcut customisation (see [keyboard.md](keyboard.md)).
- **Data** — import / export (see [import-export.md](import-export.md)).
- **Sync & Devices** — pair / unpair / rename peers; manual addresses (see [sync.md](sync.md)).
- **Agent access** — MCP enable / disable + ActivityFeed + SessionRevertControls (see [agent-access.md](agent-access.md)).
- **Google Calendar** — connect / disconnect, window-days, privacy modes.
- **Help** — keyboard shortcut reference, *Report a Bug* button, app version.

Tabs are deep-linkable via `?settings=<tab>` (parsed inside the Settings view itself, no router involved).

## Page Editor

The view that opens when you navigate to a single page. Not a sidebar entry — reached by clicking a page chip, the title in a list, a deep link, or by creating a new page.

- **Editable title** in the page header — rich rendering of inline `[[links]]` survives.
- **Breadcrumb** for namespaced titles (e.g. `Projects › Website › Backlog`).
- **Alias section** below the title (managed via the **PageHeader**).
- **Tag row**: inline tag editor for page-level tags.
- **Property table**: page-level properties shown in a row.
- **Block tree**: the editor proper. See [editor.md](editor.md).
- **Outline** (TOC): sheet slide-out from the **PageHeader** showing the page's heading hierarchy.
- **Linked / Unlinked references** below the block tree: see [tags-and-links.md](tags-and-links.md).
- **Page kebab menu (PageHeaderMenu)**: Undo, Redo, Move to space, Add alias, Add tag, Export as Markdown, Send to Trash, Toggle template.
- **Zoom into a block** to focus on a sub-tree: breadcrumb at the top, click parts to zoom out.
- **Image lightbox / PDF viewer**: opens for inline attachments.

## Tabs

A **TabBar** above the active view holds open pages (desktop only; hidden on mobile and when a single tab is open). Each tab persists per space — switching spaces restores that space's tabs.

## Recent pages strip

Below the TabBar on desktop, a horizontal strip of the recently-opened pages in the active space. Click to re-open; right-click to remove from the strip.
