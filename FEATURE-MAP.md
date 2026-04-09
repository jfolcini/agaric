# Agaric — Feature Map

What you can do with Agaric. For technical architecture and implementation details, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Views

10 sidebar views plus a page editor. Sidebar footer has: New Page button, Sync button with "last synced" relative time display (UX-76), theme toggle cycling auto/dark/light (UX-43), keyboard shortcuts button. Conflict and Trash views show numeric count badges via `SidebarMenuBadge` (UX-60).

### Journal

The default view — one page per day, created automatically.

| Mode | Description |
|------|-------------|
| **Daily** | Single day with prev/next navigation and "today" button |
| **Weekly** | Mon–Sun grid, each day as a collapsible section with per-source colored pills |
| **Monthly** | Calendar grid with per-source colored pills; click a day to switch to daily |
| **Agenda** | Tasks grouped by date (Overdue / Today / Tomorrow / future) with configurable sort and group controls |

- Floating calendar picker for jumping to any date, with per-source colored dots (blue=page, orange=due, green=scheduled, purple=property)
- **Configurable week start** (UX-82): useWeekStart hook (localStorage). Applied to BlockDatePicker, JournalCalendarDropdown, date-utils. `useWeekStart.ts`, `date-utils.ts`.
- **Color dot legend**: inline legend below calendar showing Page/Due/Scheduled/Property color dots with flex-wrap for narrow viewports (UX-57)
- **Global date controls**: Today button and date picker available in all views (non-journal views navigate to journal first)
- Days with content are highlighted
- **Today highlight**: 8% accent background + 2px left accent border on today's section (UX-55)
- Template support: auto-populates structure on new journal pages
- Keyboard: Alt+Left/Right (prev/next period), Alt+T (go to today)
- **Day transition animation**: fade-in on day change via key-based remount with 150ms duration (UX-54)

### Search

- Full-text search across all content (case-insensitive)
- Debounced input with instant results
- Paginated results with click-through to source page
- Visible result count (live-updated)
- Query term highlighting in result cards (via HighlightMatch)
- CJK support (3+ character minimum)

### Pages

- Browse all pages with inline text filter
- **Sort dropdown** (UX-59): Sort by Recent (last visited via recent-pages store), Alphabetical (localeCompare, default), or Created (ULID descending). Persisted to localStorage (`page-browser-sort`).
- Namespaced pages (e.g., `work/meetings/standup`) render as collapsible tree hierarchy; hybrid nodes (pages that are also namespaces) show both navigation and expand/collapse
- Create pages under a namespace with the `+` button on folders
- Breadcrumb navigation for namespaced titles
- Create new page (Ctrl+N), delete with confirmation
- Rename page via Dialog-based RenameDialog with proper form semantics (UX-30)

### Tags

- Browse and create tags
- Usage counts displayed next to each tag name (UX-69)
- Boolean tag queries (AND / OR / NOT) via filter panel with 3-way mode toggle (UX-70)
- **Tag filter breadcrumbs** (UX-71): Results show parent page title via batchResolve + PageLink. `TagFilterPanel.tsx`.
- Click to navigate to tag page

### Properties

- Browse, create, and manage property definitions
- 5 value types: text, number, date, select, ref (block reference with page picker)
- Search/filter property keys
- Edit select-type options inline

### Trash

- Soft-deleted blocks with deletion timestamps
- Restore (un-delete) or permanently purge
- Purge requires confirmation (non-reversible)
- **Multi-select** (UX-78): Checkboxes on each item, Shift+Click range select, Ctrl+A select all. Selection toolbar with batch restore/purge (ConfirmDialog for destructive purge).
- **Original location breadcrumbs** (UX-78): Each deleted block shows "from: Page Name" via batchResolve. Shows "(deleted page)" for missing parents.

### Status

- Queue health indicators (color-coded green/amber/red)
- Sync state indicator in sidebar (green = idle, amber = syncing, red = error, gray = no peers)
- Paired peers list with sync stats (ops received/sent, last synced)
- Pair/unpair device actions

### Conflicts

- Review sync merge conflicts with type-specific diff rendering:
  - **Text conflicts**: side-by-side Current / Incoming content
  - **Property conflicts**: field-by-field diffs (blue styling)
  - **Move conflicts**: parent/position changes (purple styling)
- Keep (use conflict content) or Discard (delete conflict copy) — both with undo toast
- Batch resolution: select multiple conflicts, Keep all / Discard all
- Red dot indicator when unresolved conflicts exist

### History

- Global operation log browser
- Filter by 12 operation types (edit, create, delete, move, add/remove tag, set/delete property, add/delete attachment, restore, purge)
- **Op type icons** (UX-75): Each op type badge has a lucide-react icon (Plus, Pencil, Trash2, ArrowRight, RotateCcw, Tag, Settings, Paperclip) alongside color coding
- Word-level diff display for edit operations
- Multi-select for batch revert (Ctrl+Click, Shift+Click, Ctrl+A)
- Vim-style navigation (j/k, Space to toggle, Enter to revert)

### Templates

- Browse all pages marked as templates
- Search/filter by template name
- Journal template indicator badge with tooltip explaining auto-application (UX-72)
- Click to navigate to template page
- Remove template status with confirmation dialog (UX-73) and toast
- **Template toggle button**: LayoutTemplate icon button in PageHeaderMenu to toggle template status with tooltip (UX-74)

### Page Editor

Opens when navigating to any page:

- Editable page title with alias support
- Block tree with full outliner editing
- Empty blocks show helpful placeholder: "Type / for commands..." (UX-64)
- Auto-creates first empty block on new/empty pages for immediate typing
- Page properties table
- Linked references (grouped by source page)
- Unlinked references (mentions not yet linked, with "Link it" button)
- Zoom-in: focus on a block and its descendants with breadcrumb trail
- Back navigation via page stack
- **Page metadata bar** (UX-61): Collapsible footer showing word count, block count, and created date (from ULID). `PageMetadataBar.tsx`, `countWords()` utility.
- **Image lightbox** (UX-84): Click inline images to open fullscreen Radix Dialog viewer (90vw/90vh). Close via Escape, click outside, or close button. "Open externally" fallback button. `ImageLightbox.tsx`.
- **View transitions**: opacity fade (150ms) on view switch with per-view scroll position restoration

---

## 2. Editor

### Formatting

Markdown-based WYSIWYG editing:

- **Bold** (`**`), *italic* (`*`), `inline code` (`` ` ``), ~~strikethrough~~ (`~~`), ==highlight== (`==`)
- Headings (levels 1–6)
- Fenced code blocks with syntax highlighting
- **Code block language selector** (UX-62): Popover in FormattingToolbar with 17 language choices. Short labels on active button. `FormattingToolbar.tsx`, tested in `FormattingToolbar.test.tsx`.
- Tables (pipe-delimited)
- Blockquotes (`>`)
- External links (Ctrl+K, autolink, paste detection)

### Block Operations

- **Enter**: save current block, create new sibling below
- **Shift+Enter**: hard break within block
- **Backspace on empty**: delete block, focus previous
- **Backspace at start**: merge with previous block
- **Escape**: cancel editing, discard changes
- **Ctrl+Shift+Right / Ctrl+Shift+Left**: indent / dedent (reparent in tree)
- **Ctrl+Shift+Up/Down**: move block up/down among siblings
- **Ctrl+.**: collapse/expand children
- Drag-and-drop reordering with depth projection for indent/reparent
- **Auto-scroll on drag** (B-31): When dragging blocks near viewport edges (50px zone), auto-scrolls at speed proportional to proximity. RAF-based 60fps. `useAutoScrollOnDrag` hook.
- Auto-split: multiple paragraphs split into separate blocks on blur
- Multi-selection (Ctrl+Click, Shift+Click, Ctrl+A) with batch delete and batch todo state
- **Draft autosave**: content auto-saved every 2s while editing; orphaned drafts recovered on boot
- **Swipe-to-delete** (mobile): swipe left 80px to reveal delete button, 200px to auto-delete
- **Sticky headers** in 6 views: SearchPanel, PageBrowser, PageHeader, HistoryView, ConflictList, AgendaView

### Inline References

- Type `@` to open tag picker with fuzzy search (create-new option auto-selected on Enter when no exact match)
- Type `#[tagname]` to auto-resolve an existing tag or create a new one (input rule, no popup)
- Type `[[` to open page/block link picker with fuzzy search (create-new option, multi-word support)
- Type `[[text]]` (with closing brackets) to auto-resolve: exact-match page links directly, alias matches link to the aliased page, no match creates a new page
- Type `((` to open block reference picker with FTS search (reference existing blocks)
- **Picker icons and breadcrumbs** (UX-65): Tag picker shows Tag icon, page picker shows FileText icon, block ref picker shows Hash icon. Namespaced pages show parent path as breadcrumb (e.g., `work/meetings/standup` → label "standup", breadcrumb "work / meetings"). Block refs show parent page title as breadcrumb.
- **Fuzzy matching** (UX-68): All pickers use `match-sorter` for fuzzy matching (e.g., "qn" finds "Quick Notes"). FTS5 preserved for longer page queries (>2 chars).
- Tags and links render as clickable chips with resolved names
- **Backspace after a chip** re-expands it into trigger text (`[[title` or `@name`) so the suggestion picker reopens for editing
- All suggestion pickers and context menus use `@floating-ui/dom` for viewport-aware positioning; popup has `role="region"` and `aria-label` for screen readers
- **Picker popup animation**: CSS fade + translateY animation (100ms ease-out) on appearance via @keyframes suggestion-appear (UX-66)
- **"Create new" prominence**: Plus icon + bg-accent/5 tint on "Create new" option in pickers for better discoverability (UX-67)
- Block references render as violet chips showing first line of content, with hover tooltip for full preview
- Click a block reference to navigate to the referenced block's page
- Renaming a tag or page propagates everywhere automatically
- **Broken link chips** (deleted targets) show "Broken link — click to remove" tooltip; clicking removes the chip (recoverable via undo)
- `((ULID))` tokens are tracked in the `block_links` table alongside `[[ULID]]` links

### Task Management

- **Ctrl+Enter**: cycle task state (TODO → DOING → DONE → none)
- **Task state animation**: smooth opacity + text-decoration-color transition (200ms) on DONE strikethrough (UX-51)
- **Ctrl+Shift+1/2/3**: set priority level (color-coded badges)
- Due date and scheduled date (via slash commands or property panel)
- Repeating tasks: daily, weekly, monthly, yearly
  - From-completion mode (`.+`): shift from completion date
  - Catch-up mode (`++`): shift by smallest increment to reach future
- End conditions: repeat until a date, or limit to N occurrences
- Custom task keywords beyond TODO/DOING/DONE

### Inline Queries

Insert `{{query ...}}` blocks to show live query results inline:

- Tag queries: `{{query type:tag expr:project}}`
- Property queries: `{{query type:property key:priority value:1}}`
- Backlink queries: `{{query type:backlinks expr:<ULID>}}`

Results display as collapsible panels with todo badges and click-to-navigate.

---

## 3. Slash Commands

Type `/` in the editor to access the command palette. Commands are grouped by category with lucide-react icons for quick scanning (UX-50). 55 commands across 8 categories:

| Category | Commands |
|----------|----------|
| **Tasks** | TODO, DOING, DONE, PRIORITY 1/2/3 |
| **Dates** | DATE, DUE, SCHEDULED |
| **References** | LINK, TAG |
| **Structure** | Heading 1–6, CODE, QUOTE, TABLE |
| **Properties** | EFFORT, ASSIGNEE (Me/Custom), LOCATION (Office/Home/Remote/Custom) |
| **Templates** | TEMPLATE (pick and insert a template's block subtree) |
| **Queries** | QUERY (insert inline query block) |
| **Repeat** | daily/weekly/monthly/yearly, from-completion (.+), catch-up (++), /repeat-until, /repeat-limit |

---

## 4. Keyboard Shortcuts

| Category | Shortcut | Action |
|----------|----------|--------|
| **Formatting** | Ctrl+B/I/E | Bold / Italic / Code |
| | Ctrl+Shift+C | Toggle code block |
| | Ctrl+K | Insert/edit external link |
| **Block nav** | Arrow Up/Left at start | Focus previous block |
| | Arrow Down/Right at end | Focus next block |
| **Block editing** | Enter | Save + create sibling |
| | Shift+Enter | Hard break within block |
| | Escape | Cancel, discard changes |
| | Backspace (empty) | Delete block |
| | Backspace (at start) | Merge with previous |
| **Organization** | Ctrl+Shift+Right/Left | Indent / dedent |
| | Ctrl+Shift+Up/Down | Move block up/down |
| **Task** | Ctrl+Enter | Cycle TODO/DOING/DONE/none |
| | Ctrl+Shift+1/2/3 | Priority 1/2/3 |
| | Ctrl+Shift+P | Show block properties drawer |
| **Collapse** | Ctrl+. | Toggle collapse/expand |
| **Pickers** | @ | Tag picker |
| | #[name] | Tag input rule (auto-resolve) |
| | [[ | Block link picker |
| | / | Slash command menu |
| **Journal** | Alt+Left/Right | Previous/next period |
| | Alt+T | Go to today |
| **Global** | Ctrl+Z / Ctrl+Y | Undo / redo (page-level) |
| | Ctrl+F | Focus search |
| | Ctrl+N | Create new page |
| | ? | Show keyboard shortcuts help |
| **History view** | Space | Toggle selection |
| | Shift+Click | Range select |
| | Ctrl+A | Select all |
| | Enter | Revert selected |
| | j/k | Vim-style navigation |

---

## 5. Properties

### Value Types

Text, number, date, select, and reference (link to another block).

### Built-in Properties

9 pre-defined: todo state, priority, due date, scheduled date, created at, completed at, effort, assignee, location.

### Inline Display

- Property chips on blocks (max 3 visible, "+N" overflow indicator)
- Built-in properties show lucide-react icons (due date, scheduled, created at, completed at, effort, assignee, location, repeat)
- Property names are title-cased with spaces (e.g. "Created At" not "created_at") via `formatPropertyName()` utility
- Due/scheduled date chips are clickable to open date picker
- Reference values show resolved page titles
- Click-to-edit with type-aware inputs (text field, dropdown, page picker)
- Block property drawer renders all built-in properties with icons and formatted names (consistent styling)
- **NL date input** (UX-88): PropertyRow and PropertyRowEditor accept natural language dates ("today", "+3d", "Apr 15") via `parseDate()`. Live preview. `BlockPropertyDrawer.tsx`, `PropertyRowEditor.tsx`.

### Repeat Properties

5 dedicated properties for recurrence:

- `repeat` — rule (daily, weekly, monthly, etc.)
- `repeat-until` — end date
- `repeat-count` — max occurrences
- `repeat-seq` — current sequence number
- `repeat-origin` — link to original block in recurrence chain

When a repeating task is marked DONE, a new sibling is automatically created with shifted dates.

---

## 6. Agenda

### Default View

Shows tasks with due or scheduled dates for today, grouped by date (Overdue / Today / Tomorrow / future dates).

### Filtering

8 dimensions + clear-all button (UX-53):

- Status (custom keywords configurable)
- Priority (1/2/3)
- Due date — 7 presets: Today, This week, This month, Overdue, Next 7/14/30 days
- Scheduled date — 7 presets (same)
- Completed date — 5 presets: Today, This week, This month, Last 7/30 days
- Created date — 5 presets (same)
- Tag

### Sort & Group

Configurable controls persisted in browser storage:

- **Group by**: date, priority, state, or none
- **Sort by**: date, priority, or state

### Projected Agenda

Repeating tasks show virtual future occurrences within the viewed date range (displayed with dashed border and "Projected" label).

### Done Panel

Shows tasks completed on the current day, grouped by source page.

### Due Panel

Shows tasks with due/scheduled dates for the current day. Filter bar with 4 buttons: All, Due, Scheduled, Properties. Per-source breakdown in header when multiple source types exist (e.g., "2 Due · 1 Scheduled · 1 Properties"). Overdue items show "(Xd overdue)" label next to due date (UX-56).

---

## 7. Tags & Links

### Tags

- First-class entities that can themselves be tagged
- Hierarchy via naming convention (`work/meeting`) — prefix search finds all descendants
- Boolean queries: AND, OR, NOT composition
- Tag inheritance: blocks inherit tags from ancestors — materialized `block_tag_inherited` cache for O(1) lookups (maintained incrementally by materializer + command handlers)

### Block Links

- Link to any page or block — rendered as clickable chip with resolved title
- ULID-based: renaming a page updates all links automatically (no content migration)

### Backlinks

- Linked references: blocks containing an explicit link, grouped by source page
- Unlinked references: blocks mentioning a page title as plain text, with "Link it" button
- 17 filter types for advanced backlink queries:

| Filter | Description |
|--------|-------------|
| Property (text/num/date) | Filter by property value comparison |
| Property exists/empty | Filter by property presence |
| Has tag / tag prefix | Filter by tag or tag hierarchy |
| Contains | Full-text search within backlinks |
| Created in range | Filter by creation date |
| Block type | Filter by content/tag/page |
| Todo state / Priority | Filter by task metadata |
| Due date / Scheduled date | Filter by date fields |
| Source page | Filter by linking page |
| And / Or / Not | Boolean composition |

Sorting: by creation date, property text/number/date (ascending or descending).

---

## 8. Sync

Local WiFi peer-to-peer sync — no cloud, no accounts.

- **Discovery**: automatic via mDNS on the local network
- **Pairing**: scan a QR code or enter a 4-word passphrase
- **Auto-sync**: background daemon with change-triggered (3s debounce) and periodic sync (60s), exponential backoff on failure
- **Manual sync feedback**: sidebar sync button shows toast when no peers are paired ("No paired devices — use Device Management to pair.") and resets sync state to idle
- **Manual address**: set a peer's IP:port when mDNS is unavailable (e.g., across subnets)
- **Peer address popover** (UX-77): Replaced prompt() with Radix Popover for manual address entry. `PeerListItem.tsx`.
- **Conflict handling**: non-overlapping edits merge automatically; overlapping edits create conflict copies for manual resolution
- **Certificate pinning**: devices are identified by their TLS certificate hash

---

## 9. Import & Export

- **Import**: Logseq/Markdown files as pages + blocks
- **Export page**: Markdown with resolved tag names and page titles, YAML frontmatter for properties
- **Export all**: ZIP of all pages as Markdown files

## 10. Shared Components & Utilities

### Shared UI Components
- **EmptyState** (`src/components/EmptyState.tsx`): Consistent empty state display with icon, title, and optional description. Used by 16 components including DaySection, DuePanel, DonePanel, LinkedReferences, UnlinkedReferences, BlockTree, SearchPanel, and others.
- **ConfirmDialog** (`src/components/ConfirmDialog.tsx`): Wraps AlertDialog primitives with title/description/cancel/action props, optional `children` slot, `actionVariant` (default/destructive), `loading` spinner, `autoFocus` on action button for keyboard confirmation (UX-19). Used by 8 components.
- **LoadMoreButton** (`src/components/LoadMoreButton.tsx`): Cursor-paginated load-more button with `loading`/`hasMore`/`onLoadMore` props and Spinner. Used by 6 components.
- **LoadingSkeleton** (`src/components/LoadingSkeleton.tsx`): Skeleton loading placeholder with `count`/`height` props. Used by 7 components.
- **Spinner** (`src/components/ui/spinner.tsx`): Animated loading indicator wrapping Loader2 with CVA size variants (`sm`=h-3.5, `md`=h-4, `lg`=h-5, `xl`=h-6). Default `md`. Used by 14 components.
- **CloseButton** (`src/components/ui/close-button.tsx`): Shared `closeButtonClassName` constant + `CloseButtonIcon` component for overlay close buttons. Used by Dialog, Sheet.
- **ChevronToggle** (`src/components/ui/chevron-toggle.tsx`): Reusable expand/collapse chevron with rotation transition. Props: `isExpanded`, `loading` (shows spinner), `size` (sm/md). Replaces duplicated ChevronRight rotation pattern across 7 consumers (UX-36). Used by CollapsiblePanelHeader, BlockInlineControls, PageTreeItem, QueryResult, CollapsibleGroupList, HistoryPanel, HistoryListItem.
- **CardButton** (`src/components/ui/card-button.tsx`): Full-width card-style button with border, bg-card, hover:bg-accent/50, focus-visible ring. Used by ResultCard, SearchPanel.
- **Label** (`src/components/ui/label.tsx`): Form label with CVA variants: `size` (sm/xs), `muted` (true/false). Used by HistoryView, AgendaFilterBuilder, PagePropertyTable, LinkEditPopover.
- **ListItem** (`src/components/ui/list-item.tsx`): Interactive list item with group flex layout, gap-3, rounded-lg, hover:bg-accent/50. Used by TagList, PropertiesView.
- **CollapsibleGroupList** (`src/components/CollapsibleGroupList.tsx`): Generic collapsible grouped list with expand/collapse state management. Accepts `expandedGroups` record, `defaultExpanded` prop, `onToggle` callback, and custom `renderBlock` slot. Supports split-header mode via `onPageTitleClick` prop (separate chevron toggle + PageLink title + passive count). Used by LinkedReferences, UnlinkedReferences.
- **BacklinkGroupRenderer** (`src/components/BacklinkGroupRenderer.tsx`): Collapsible backlink group with block items. Renders a grouped backlink section with expand/collapse toggle, page title link, block count badge, and block list. Extracted from LinkedReferences (R-15). Used by LinkedReferences.
- **PeerListItem** (`src/components/PeerListItem.tsx`): Peer card component with sync/rename/unpair actions. Shows device name, peer ID, connection status, last sync time, and ops sent/received. Extracted from DeviceManagement (R-16). Used by DeviceManagement.
- **TaskStatesSection** (`src/components/TaskStatesSection.tsx`): Task state cycle editor. Manages custom task keywords with add/remove/reorder controls, persisted to localStorage. Extracted from PropertiesView (R-17). Used by PropertiesView.
- **DeadlineWarningSection** (`src/components/DeadlineWarningSection.tsx`): Deadline warning days setting. Input for configuring days-before-due warning threshold, persisted to localStorage. Extracted from PropertiesView (R-17). Used by PropertiesView.
- **PropertyDefinitionsList** (`src/components/PropertyDefinitionsList.tsx`): Property definitions CRUD with search, filter, inline editing, and delete confirmation. Extracted from PropertiesView (R-17). Used by PropertiesView.
- **ResultCard** (`src/components/ResultCard.tsx`): Block result card button with content display, Badge for page/tag types, optional spinner, optional children slot, optional `highlightText` prop for HighlightMatch integration. Used by SearchPanel, TagFilterPanel.
- **PageLink** (`src/components/PageLink.tsx`): Inline clickable page name (`<span role="link">`) that navigates via `navigateToPage`. Handles click/Enter/Space with stopPropagation. Uses `<span>` to allow nesting inside `<button>` containers. Used by CollapsibleGroupList, DonePanel, AgendaResults, DuePanel, SearchPanel, QueryResult.
- **PropertyRow** (`src/components/BlockPropertyDrawer.tsx`): Extracted sub-component for property rows with badge+input+remove layout. Supports optional icon, date/text input types.
- **ConflictBatchToolbar** (`src/components/ConflictBatchToolbar.tsx`): Batch action toolbar for conflict resolution. Shows selection count, select/deselect all, keep all, discard all buttons. Extracted from ConflictList (R-3). Used by ConflictList.
- **ConflictListItem** (`src/components/ConflictListItem.tsx`): Individual conflict item card. Renders type-specific content (via ConflictTypeRenderer), keep/discard actions, expand/collapse toggle, metadata, selection checkbox. Extracted from ConflictList (R-3). Used by ConflictList.
- **ConflictTypeRenderer** (`src/components/ConflictTypeRenderer.tsx`): Type-specific conflict content renderer. Text conflicts show Current/Incoming, property conflicts show field diffs, move conflicts show parent/position changes. Extracted from ConflictList (R-3). Used by ConflictListItem.
- **HistoryFilterBar** (`src/components/HistoryFilterBar.tsx`): Operation type filter dropdown for history view. Extracted from HistoryView (R-8). Used by HistoryView.
- **HistoryListItem** (`src/components/HistoryListItem.tsx`): Individual history entry with op type badge, word-level diff, timestamp, selection checkbox. Extracted from HistoryView (R-8). Used by HistoryView.
- **HistorySelectionToolbar** (`src/components/HistorySelectionToolbar.tsx`): Batch selection toolbar for history view with selection count, select/deselect all, revert button. Extracted from HistoryView (R-8). Used by HistoryView.
- **PairingQrDisplay** (`src/components/PairingQrDisplay.tsx`): QR code and passphrase display for pairing dialog with countdown timer and expired-session retry. Extracted from PairingDialog (R-9). Used by PairingDialog.
- **AddBlockButton** (`src/components/AddBlockButton.tsx`): Reusable ghost button with Plus icon for block creation. Takes `onClick`, optional `label` and `className`. Extracted from PageEditor and DaySection (UX-20). Used by PageEditor, DaySection.
- **FilterPillRow** (`src/components/FilterPillRow.tsx`): Renders active backlink filter pills with remove buttons, showing filter dimension, operator, and value. Includes `filterSummary()` utility. Extracted from BacklinkFilterBuilder (R-4). Used by BacklinkFilterBuilder.
- **FilterSortControls** (`src/components/FilterSortControls.tsx`): Sort field selector dropdown and ascending/descending toggle for backlink queries. Extracted from BacklinkFilterBuilder (R-4). Used by BacklinkFilterBuilder.
- **OverdueSection** (`src/components/OverdueSection.tsx`): Renders overdue blocks (due before today, not DONE) with count badge and priority/status indicators. Clickable items navigate to parent page. Extracted from DuePanel (R-6). Used by DuePanel.
- **UpcomingSection** (`src/components/UpcomingSection.tsx`): Renders upcoming blocks within the warning-days window. Clickable items navigate to parent page. Extracted from DuePanel (R-6). Used by DuePanel.
- **DuePanelFilters** (`src/components/DuePanelFilters.tsx`): Filter bar for DuePanel with source type pills (All/Due/Scheduled/Properties) and hide-before-scheduled toggle. Extracted from DuePanel (R-6). Used by DuePanel.
- **PairingEntryForm** (`src/components/PairingEntryForm.tsx`): Passphrase entry form for manual pairing. Extracted from PairingDialog (R-9). Used by PairingDialog.
- **PairingPeersList** (`src/components/PairingPeersList.tsx`): Paired peers list with unpair action and reset count display. Extracted from PairingDialog (R-9). Used by PairingDialog.
- **PageTreeItem** (`src/components/PageTreeItem.tsx`): Recursive tree node for page browser with namespace expand/collapse, highlight matching, create-under-namespace button. Extracted from PageBrowser (R-12). Used by PageBrowser.
- **HighlightMatch** (`src/components/HighlightMatch.tsx`): Text highlighting component that wraps matching substrings in `<mark>`. Memoized with regex-safe escaping. Extracted from PageBrowser (R-12). Reusable.
- **QueryResultList** (`src/components/QueryResultList.tsx`): List-mode renderer for inline query results with status badges, page links, content truncation. Extracted from QueryResult (R-14). Used by QueryResult.
- **QueryResultTable** (`src/components/QueryResultTable.tsx`): Table-mode renderer for inline query results with dynamic columns. Extracted from QueryResult (R-14). Used by QueryResult.
- **Select** (`src/components/ui/select.tsx`): Radix UI Select wrapper with 10 exported parts and `size` prop on SelectTrigger (`'default'` | `'sm'`). Replaces all native `<select>` elements across 5 component files. Uses `__none__`/`__all__` sentinels for empty values (Radix doesn't support `value=""`).
- **StatusBadge** (`src/components/ui/status-badge.tsx`): CVA-based status badge with 5 state variants (DONE, DOING, TODO, overdue, default). Used by AlertSection, QueryResultList.
- **PriorityBadge** (`src/components/ui/priority-badge.tsx`): CVA-based "P{n}" badge with priority variant for dynamic color based on priority level (UX-26). Used by AlertSection, DuePanel.
- **AlertListItem** (`src/components/ui/alert-list-item.tsx`): CVA-based `<li>` for alerts with `destructive` and `pending` variants. Used by AlertSection.
- **SectionTitle** (`src/components/ui/section-title.tsx`): Section heading `<h4>` with label, count badge, and customizable color class. Used by AlertSection.
- **PopoverMenuItem** (`src/components/ui/popover-menu-item.tsx`): CVA-based full-width button for popover menus with active/disabled variants (UX-26). Used by AgendaFilterBuilder, AgendaSortGroupControls.
- **AlertSection** (`src/components/AlertSection.tsx`): Parameterized list component for overdue/upcoming alert blocks with status badges and optional priority badges. Eliminates duplication between OverdueSection and UpcomingSection (M-11). Used by OverdueSection, UpcomingSection.
- **BlockHistorySheet** (`src/components/BlockHistorySheet.tsx`): Thin wrapper for block-level history side-drawer. Passes blockId, open state, and onOpenChange callback (M-1.1). Used by BlockTree.
- **BlockPropertyDrawerSheet** (`src/components/BlockPropertyDrawerSheet.tsx`): Thin wrapper for block-level property drawer side-sheet (M-1.2). Used by BlockTree.
- **BlockListRenderer** (`src/components/BlockListRenderer.tsx`): Presentational sorted block list with SortableContext, viewport-aware virtualization with placeholder elements, and drop indicators during drag (M-1.5). Used by BlockTree.
- **BlockZoomBar** (`src/components/BlockZoomBar.tsx`): Breadcrumb navigation bar for zoomed block view with Home and clickable ancestor buttons (M-1.4). Used by BlockTree.
- **TagValuePicker** (`src/components/TagValuePicker.tsx`): Searchable tag autocomplete combobox for filter builders. Calls `listTagsByPrefix()` on keystroke, displays tags with usage counts, keyboard navigation. Used by AgendaFilterBuilder.
- **FeatureErrorBoundary** (`src/components/FeatureErrorBoundary.tsx`): Feature-level error boundary with inline error card, retry button, and `logger.error` with component stack. Takes `name` prop. Wraps 12 sections in App.tsx (M-2). Separate from app-level ErrorBoundary.
- **ListViewState** (`src/components/ListViewState.tsx`): Generic loading/empty/loaded branching component. Eliminates repetitive three-way conditionals. Used by 11 components: LinkedReferences, UnlinkedReferences, DonePanel, DuePanel, HistoryPanel, AttachmentList, DeviceManagement, TagList, PropertyDefinitionsList, TemplatesView, TrashView.
- **BlockListItem** (`src/components/BlockListItem.tsx`): Shared block item for list views with consistent [metadata] → [content] → [breadcrumb] layout. Used by DonePanel, DuePanel, AgendaResults.
- **PropertyRowEditor** (`src/components/PropertyRowEditor.tsx`): Property row with typed input supporting text, number, date, select, and ref value types. Ref properties render a page picker popover with search (R-11). Used by BlockPropertyDrawer, PagePropertyTable.

### Shared Hooks
- **useBlockNavigation** (`src/hooks/useBlockNavigation.ts`): Returns `{ handleBlockClick, handleBlockKeyDown }` for block click + keyboard (Enter/Space) navigation. Accepts `NavigateToPageFn` type. Used by AgendaResults, DonePanel, DuePanel, LinkedReferences, UnlinkedReferences.
- **useListKeyboardNavigation** (`src/hooks/useListKeyboardNavigation.ts`): Arrow key / vim key (j/k) navigation for lists. Supports `wrap` vs `clamp` modes, `Home`/`End` keys, `onSelect` callback. Used by SuggestionList, BlockContextMenu, HistoryView.
- **usePaginatedQuery** (`src/hooks/usePaginatedQuery.ts`): Cursor-based pagination hook with `items`, `hasMore`, `loading`, `loadMore`, `reset` state. Supports `enabled` option for conditional fetching (preserves items when disabled, refetches on re-enable). Used by LinkedReferences, UnlinkedReferences, SearchPanel, TagFilterPanel, and others.
- **useBatchCounts** (`src/hooks/useBatchCounts.ts`): Fetches agenda + backlink counts for date ranges. Returns both total counts and per-source breakdown (due/scheduled/properties). Used by WeeklyView, MonthlyView.
- **useBacklinkResolution** (`src/hooks/useBacklinkResolution.ts`): TTL-cached ULID/tag resolution hook. Batch resolves page IDs and tag IDs to display names with configurable TTL (default 30s). Deduplicates concurrent requests. Extracted from LinkedReferences (R-15). Used by LinkedReferences.
- **useSyncWithTimeout** (`src/hooks/useSyncWithTimeout.ts`): Sync operation executor with Promise.race timeout pattern (default 60s). Supports cancellation via cancelSync. Returns `{ executeSyncWithTimeout, cancelSync }`. Extracted from DeviceManagement (R-16). Used by DeviceManagement.
- **usePageDelete** (`src/hooks/usePageDelete.ts`): Page deletion hook with confirmation state management. Returns `{ pendingDeleteId, requestDelete, confirmDelete, cancelDelete }`. Extracted from PageBrowser (R-12). Used by PageBrowser.
- **useDuePanelData** (`src/hooks/useDuePanelData.ts`): Data fetching hook for DuePanel encapsulating block/overdue/upcoming/projected queries and page title resolution. Returns fetched data, loading states, pageTitles map, and loadMore. Extracted from DuePanel (R-6). Used by DuePanel.
- **useAgendaPreferences** (`src/hooks/useAgendaPreferences.ts`): LocalStorage-persisted agenda sort/group preferences hook. Returns `{ groupBy, sortBy, setGroupBy, setSortBy }`. Extracted from AgendaView (R-13). Used by AgendaView.
- **useBlockCollapse** (`src/hooks/useBlockCollapse.ts`): Manages collapsed block state with localStorage persistence. Returns `{ collapsedIds, toggleCollapse, visibleBlocks, hasChildrenSet }`. Extracted from BlockTree (M-1.3). Used by BlockTree.
- **useBlockZoom** (`src/hooks/useBlockZoom.ts`): Manages zoom state, breadcrumb trail, and zoomed-view filtering with depth-adjusted visible blocks. Returns `{ zoomedBlockId, zoomIn, zoomOut, zoomToRoot, breadcrumbs, zoomedVisible }`. Extracted from BlockTree (M-1.4). Used by BlockTree, BlockZoomBar.
- **useBlockSwipeActions** (`src/hooks/useBlockSwipeActions.ts`): Swipe-left-to-delete gesture for mobile (touch-only, coarse-pointer devices). 80px reveal threshold, 200px auto-delete. Returns `{ translateX, isRevealed, handlers, reset }`. Used by SortableBlock.
- **useDraftAutosave** (`src/hooks/useDraftAutosave.ts`): Autosaves block draft content with 2s debounce. Calls `saveDraft()`/`deleteDraft()` via Tauri. Returns `{ discardDraft }`. Used by EditableBlock.
- **useScrollRestore** (`src/hooks/useScrollRestore.ts`): Saves and restores scroll position per view key on a scrollable container with requestAnimationFrame timing. Used by App.
- **useTheme** (`src/hooks/useTheme.ts`): Theme preference hook with auto/dark/light cycle. Reads from localStorage (`theme-preference`), respects `prefers-color-scheme` for auto mode via `useSyncExternalStore`, applies `.dark` class on `document.documentElement`. Returns `{ theme, isDark, toggleTheme }`. Used by App (UX-43).
- **useItemCount** (`src/hooks/useItemCount.ts`): Reusable polling count hook. Wraps `usePollingQuery` to poll a paginated command and return item count. Used by App for conflict/trash badge counts (UX-60).

### Per-Page Block Store (R-18)
- **PageBlockStore** (`src/stores/page-blocks.ts`): Per-page Zustand store instances via React context. Factory `createPageBlockStore(pageId)`, context provider `PageBlockStoreProvider`, hooks `usePageBlockStore(selector)` / `usePageBlockStoreApi()`, module-level `pageBlockRegistry` for global access. Each BlockTree gets its own store. Replaces the block/loading/mutation portion of the old global useBlockStore.
- **useBlockStore** (`src/stores/blocks.ts`): Slimmed global singleton — focus/selection only. `focusedBlockId`, `selectedBlockIds`, `setFocused`, `toggleSelected`, `rangeSelect(id, visibleIds)`, `selectAll(visibleIds)`, `clearSelected`, `setSelected`.

### Shared Utilities
- **block-events** (`src/lib/block-events.ts`): `BLOCK_EVENTS` constant object (10 event names), `dispatchBlockEvent()`/`onBlockEvent()` helpers for custom DOM event communication between FormattingToolbar and BlockTree. Exports `NavigateToPageFn` type alias for standardized navigation callbacks.
- **date-property-colors** (`src/lib/date-property-colors.ts`): `getSourceColor(source)` returns light/dark mode Tailwind classes for agenda sources (due=orange, scheduled=blue, properties=purple). `getSourceLabel(source)` returns display labels. Used by DaySection colored pills.
- **date-utils** (`src/lib/date-utils.ts`): Consolidated date formatting utilities. `formatDate(d)` (yyyy-MM-dd), `formatDateDisplay(d)` (human-readable), `formatGroupDate(s)` (group headers), `formatCompactDate(s)` (compact display), `getTodayString()`, `getDateRangeForFilter(preset, today)` (7 presets: today/this-week/this-month/overdue/next-7/14/30-days). Single source of truth — eliminates duplicates from parse-date.ts, DuePanel, AgendaResults, AgendaView. Used by DuePanel, DonePanel, AgendaResults, AgendaView, parse-date.
- **page-tree** (`src/lib/page-tree.ts`): Pure utility for building hierarchical page tree from flat page list. `buildPageTree()` creates namespace-aware tree nodes with hybrid page/folder support. Extracted from PageBrowser (R-12). Used by PageBrowser.
- **agenda-filters** (`src/lib/agenda-filters.ts`): Pure function `executeAgendaFilters()` for agenda view filter logic. Handles 7+ filter dimensions, date range calculations, page title resolution. Tag filters resolve names to IDs via `listTagsByPrefix()`. Extracted from AgendaView (R-13). Used by AgendaView.
- **query-utils** (`src/lib/query-utils.ts`): Query expression parsing and filter building utilities. `parseQueryExpression()`, `buildFilters()`, column detection. Extracted from QueryResult (R-14). Used by QueryResult.
- **property-save-utils** (`src/lib/property-save-utils.ts`): Shared property management helpers. `NON_DELETABLE_PROPERTIES` (11 system-managed keys), `buildInitParams(blockId, def)` returns type-appropriate init params (number→0, date→today, text/select→'', ref→null), `handleSaveProperty()`, `handleDeleteProperty()`. Used by PagePropertyTable, BlockPropertyDrawer.
- **logger** (`src/lib/logger.ts`): Structured frontend logging with dual-write (console + Tauri IPC bridge), stack capture at call site, cause chain extraction (3-level deep), and rate limiting (5 per 60s per module:message). Methods: `debug`, `info`, `warn`, `error`. Global error/unhandledrejection handlers in `main.tsx`. Used by 24+ production files.
- **format-relative-time** (`src/lib/format-relative-time.ts`): `formatRelativeTime(isoString, t)` returns human-readable relative time ("just now", "Xm ago", "Xh ago", "Xd ago"). Uses i18n `t()` for all strings. Used by App sidebar sync status (UX-76).

### CSS Utilities
- **`.touch-target`** (`src/index.css`): Tailwind `@utility` for `@media(pointer:coarse)` min-height 44px touch targets. Used across 19+ components.
- **`.block-children-enter`** (`src/index.css`): CSS keyframe animation (150ms ease-out opacity+translateY) applied to block children on expand. Respects `prefers-reduced-motion`. Used by BlockListRenderer (UX-79).
- **Animation/transition tokens** (UX-81): 8 CSS custom properties (`--duration-fast` 100ms through `--duration-slower` 500ms, `--ease-out`, `--ease-in-out`, `--ease-spring`) with matching Tailwind `@utility` classes (`duration-fast`, `duration-normal`, `duration-moderate`, `duration-slow`, `duration-slower`, `ease-smooth`, `ease-smooth-in-out`, `ease-spring`). Keyframe animations reference tokens. `prefers-reduced-motion` sets all durations to 0ms.
- **Typography scale tokens** (UX-80): 13 CSS custom properties — 7 font-size (`--text-xs` 0.75rem through `--text-3xl` 1.875rem), 3 line-height (`--leading-tight` 1.25, `--leading-normal` 1.5, `--leading-relaxed` 1.625), 3 letter-spacing (`--tracking-tight`, `--tracking-normal`, `--tracking-wide`). 7 `@utility` classes (`text-scale-xs` through `text-scale-3xl`) pairing font-size + line-height. Responsive mobile overrides reduce `--text-2xl`/`--text-3xl` at `max-width: 640px`.

### Shared Components (session 275)
- **DateChipEditor** (`src/components/DateChipEditor.tsx`): Inline date editor for agenda date chips. Text input with natural language parsing (parseDate), quick option buttons (Today/Tomorrow/Next Week/Clear), calls `setDueDate`/`setScheduledDate`. Designed for use inside Popover. 11 tests.
- **RenameDialog** (`src/components/RenameDialog.tsx`): Generic modal for renaming entities. Optional `title`, `description`, `placeholder`, `ariaLabel` props (defaults to device rename). Reused by TagList (tag rename) and PageHeader (page rename).

### Lib Modules (session 275)
- **starred-pages** (`src/lib/starred-pages.ts`): localStorage-backed starred page helpers — `getStarredPages()`, `isStarred()`, `toggleStarred()`. Used by PageBrowser for favorites. 13 tests.

### Feature Integrations (session 275)
- **Inline date editing in agenda** (F-22): Due date chips in AgendaResults wrapped in Popover → DateChipEditor. `DueDateChip` helper manages Popover state. AgendaView refreshes via `refreshKey` counter after edits.
- **Tag rename** (F-29): Pencil button on each tag in TagList opens RenameDialog. `editBlock()` → materializer → `tags_cache` rebuild → resolve store auto-update. Duplicate name validation.
- **Favorites/starred pages** (UX-58): Star toggle on each page in PageBrowser. Starred filter toggle in header with badge count. localStorage persistence via `starred-pages.ts`. Memoized via `starredRevision` counter.

### Shared Components (session 277)
- **PageOutline** (`src/components/PageOutline.tsx`): TOC/outline panel in Sheet slide-out. `extractHeadings()` scans block content for `# `/`## ` prefixes, returns `{ blockId, level, text }[]`. Click-to-scroll via `scrollIntoView`. Integrated in PageHeader via List icon button. 11 tests.
- **ImageResizeToolbar** (`src/components/StaticBlock.tsx`): Floating toolbar on image hover with 4 width presets (Small 25%, Medium 50%, Large 75%, Full 100%). Width persisted via `setProperty('image_width')`. Keyboard/touch accessible (Enter/Space toggle). 5 tests.
- **UnfinishedTasks** (`src/components/journal/UnfinishedTasks.tsx`): Collapsible section in DailyView showing overdue TODO/DOING tasks grouped by age (Yesterday, This Week, Older). Client-side query via `queryByProperty` + filter. localStorage collapse persistence. Only shown for today's date. 21 tests.

### Lib Modules (session 277)
- **tag-colors** (`src/lib/tag-colors.ts`): localStorage-backed tag color helpers — `TAG_COLOR_PRESETS` (8 colors), `getTagColors()`, `getTagColor()`, `setTagColor()`, `clearTagColor()`. Dual storage: localStorage for fast rendering + `setProperty`/`deleteProperty` for sync.

### Feature Integrations (session 277)
- **Tag colors** (UX-87): Color picker popover on each tag in TagList. 8 preset colors as button swatches with `aria-pressed`. Tag reference inline nodes (tag-ref.ts) show color tint. Fieldset-based accessible palette.
- **Trash search** (UX-78): Frontend text filter on loaded TrashView items. Debounced input (300ms via `useDebouncedCallback`), filtered count, clear button, case-insensitive match. Multi-select integration preserved.

### Components (session 278)
- **WelcomeModal** (`src/components/WelcomeModal.tsx`): First-run onboarding dialog. 3 feature highlights (blocks+pages, keyboard shortcuts, tags+properties). "Get Started" dismiss + optional sample page creation. localStorage-based show-once. 10 tests.

### Editor Features (session 278)
- **Callout/admonition blocks** (F-34): Obsidian-compatible `> [!TYPE]` syntax in markdown serializer. 5 types: info (blue), warning (amber), tip (green), error (red), note (gray). Colored border + icon + label in StaticBlock. `/callout` slash command with 5 sub-commands. CALLOUT_CONFIG map in StaticBlock. 32 tests (23 serializer + 9 component).

### Accessibility (session 278)
- **Semantic block tree** (UX-48): BlockListRenderer uses `<ul>`/`<li>` instead of `<div>`. ARIA attributes: `aria-level` (1-based depth), `aria-setsize`/`aria-posinset` (sibling grouping), `aria-expanded` (collapse state). Flat ARIA tree pattern preserves dnd-kit + viewport observer compatibility. 8 tests.

### Performance (session 278)
- **rovingEditor ref stabilization** (B-24): Ref-based callback pattern across 5 consumer files (BlockTree, EditableBlock, useBlockKeyboardHandlers, useBlockDatePicker, useBlockDnD). Removes `rovingEditor` from 16 dependency arrays, preventing cascade re-renders of all EditableBlock instances.

### Editor Features (session 279)
- **Numbered lists** (F-28): TipTap `OrderedList`, `BulletList`, `ListItem` extensions. Markdown serializer parse (`1. item`) / serialize. StaticBlock renders `<ol class="list-decimal list-inside">` with `<li>`. `/numbered-list` slash command. 22 parse/serialize tests + 4 component tests.
- **Divider blocks** (F-28): TipTap `HorizontalRule` extension. Markdown serializer parse (`---`) / serialize. StaticBlock renders `<hr>`. `/divider` slash command. `HorizontalRuleNode` type with `content?: undefined` for union compatibility. 10 parse/serialize tests + 4 component tests.

### Views (session 279)
- **SettingsView** (`src/components/SettingsView.tsx`): Tabbed settings replacing `properties` sidebar item. 4 tabs: General (TaskStatesSection, DeadlineWarningSection), Properties (PropertyDefinitionsList), Appearance (theme toggle light/dark/system + font size small/medium/large), Sync & Devices (DeviceManagement). Custom ARIA tab implementation. `'settings'` added to navigation ViewName union. 9 tests.

### Query Improvements (session 279)
- **Query pagination** (F-25): Cursor-based load-more in QueryResult replacing hardcoded `limit: 50`. `PAGE_SIZE` constant + `LoadMoreButton`. Accumulates results across pages, merges page titles.
- **Query expression pills** (F-25): `QueryExpressionPills` component parses query expression into Badge-rendered pills (type badge + param/filter badges). Raw expression preserved as `title` tooltip. 9 tests.

### Task Dependencies (session 280)
- **DependencyIndicator** (`src/components/DependencyIndicator.tsx`): Shows Link2 icon + tooltip when a block has a `blocked_by` ref property. Lazy-loads properties with shared `useRef<Map>` cache. Resolves blocking task title via `batchResolve`. Integrated in AgendaResults metadata slot. 8 tests.
- **DONE warning** (F-37): When setting a task to DONE (via slash command or checkbox), checks for `blocked_by` property and shows `toast.warning` if dependencies exist.
