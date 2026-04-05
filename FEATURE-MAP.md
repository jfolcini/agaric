# Agaric — Feature Map

What you can do with Agaric. For technical architecture and implementation details, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Views

10 sidebar views plus a page editor.

### Journal

The default view — one page per day, created automatically.

| Mode | Description |
|------|-------------|
| **Daily** | Single day with prev/next navigation and "today" button |
| **Weekly** | Mon–Sun grid, each day as a collapsible section with per-source colored pills |
| **Monthly** | Calendar grid with per-source colored pills; click a day to switch to daily |
| **Agenda** | Tasks grouped by date (Overdue / Today / Tomorrow / future) with configurable sort and group controls |

- Floating calendar picker for jumping to any date, with per-source colored dots (blue=page, orange=due, green=scheduled, purple=property)
- **Global date controls**: Today button and date picker available in all views (non-journal views navigate to journal first)
- Days with content are highlighted
- Template support: auto-populates structure on new journal pages
- Keyboard: Alt+Left/Right (prev/next period), Alt+T (go to today)

### Search

- Full-text search across all content (case-insensitive)
- Debounced input with instant results
- Paginated results with click-through to source page
- CJK support (3+ character minimum)

### Pages

- Browse all pages with inline text filter
- Namespaced pages (e.g., `work/meetings/standup`) render as collapsible tree hierarchy; hybrid nodes (pages that are also namespaces) show both navigation and expand/collapse
- Create pages under a namespace with the `+` button on folders
- Breadcrumb navigation for namespaced titles
- Create new page (Ctrl+N), delete with confirmation

### Tags

- Browse and create tags
- Boolean tag queries (AND / OR / NOT) via filter panel
- Click to navigate to tag page

### Properties

- Browse, create, and manage property definitions
- 5 value types: text, number, date, select, ref (block reference)
- Search/filter property keys
- Edit select-type options inline

### Trash

- Soft-deleted blocks with deletion timestamps
- Restore (un-delete) or permanently purge
- Purge requires confirmation (non-reversible)

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
- Filter by operation type (edit, create, delete, move, tag, property, attachment, restore, purge)
- Word-level diff display for edit operations
- Multi-select for batch revert (Ctrl+Click, Shift+Click, Ctrl+A)
- Vim-style navigation (j/k, Space to toggle, Enter to revert)

### Templates

- Browse all pages marked as templates
- Search/filter by template name
- Journal template indicator badge
- Click to navigate to template page
- Remove template status with confirmation toast

### Page Editor

Opens when navigating to any page:

- Editable page title with alias support
- Block tree with full outliner editing
- Auto-creates first empty block on new/empty pages for immediate typing
- Page properties table
- Linked references (grouped by source page)
- Unlinked references (mentions not yet linked, with "Link it" button)
- Zoom-in: focus on a block and its descendants with breadcrumb trail
- Back navigation via page stack

---

## 2. Editor

### Formatting

Markdown-based WYSIWYG editing:

- **Bold** (`**`), *italic* (`*`), `inline code` (`` ` ``), ~~strikethrough~~ (`~~`), ==highlight== (`==`)
- Headings (levels 1–6)
- Fenced code blocks with syntax highlighting
- Tables (pipe-delimited)
- Blockquotes (`>`)
- External links (Ctrl+K, autolink, paste detection)

### Block Operations

- **Enter**: save current block, create new sibling below
- **Shift+Enter**: hard break within block
- **Backspace on empty**: delete block, focus previous
- **Backspace at start**: merge with previous block
- **Escape**: cancel editing, discard changes
- **Tab / Shift+Tab**: indent / dedent (reparent in tree)
- **Ctrl+Shift+Up/Down**: move block up/down among siblings
- **Ctrl+.**: collapse/expand children
- Drag-and-drop reordering with depth projection for indent/reparent
- Auto-split: multiple paragraphs split into separate blocks on blur
- Multi-selection (Ctrl+Click, Shift+Click, Ctrl+A) with batch delete and batch todo state

### Inline References

- Type `@` to open tag picker with fuzzy search (create-new option auto-selected on Enter when no exact match)
- Type `[[` to open page/block link picker with fuzzy search (create-new option)
- Type `[[text]]` (with closing brackets) to auto-resolve: exact-match page links directly, no match creates a new page
- Type `((` to open block reference picker with FTS search (reference existing blocks)
- Tags and links render as clickable chips with resolved names
- **Backspace after a chip** re-expands it into trigger text (`[[title` or `@name`) so the suggestion picker reopens for editing
- All suggestion pickers and context menus use `@floating-ui/dom` for viewport-aware positioning
- Block references render as violet chips showing first line of content, with hover tooltip for full preview
- Click a block reference to navigate to the referenced block's page
- Renaming a tag or page propagates everywhere automatically
- `((ULID))` tokens are tracked in the `block_links` table alongside `[[ULID]]` links

### Task Management

- **Ctrl+Enter**: cycle task state (TODO → DOING → DONE → none)
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

Type `/` in the editor to access the command palette:

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
| **Organization** | Tab / Shift+Tab | Indent / dedent |
| | Ctrl+Shift+Up/Down | Move block up/down |
| **Task** | Ctrl+Enter | Cycle TODO/DOING/DONE/none |
| | Ctrl+Shift+1/2/3 | Priority 1/2/3 |
| | Ctrl+Shift+P | Show block properties drawer |
| **Collapse** | Ctrl+. | Toggle collapse/expand |
| **Pickers** | @ | Tag picker |
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

8 dimensions:

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

Shows tasks with due/scheduled dates for the current day. Filter bar with 4 buttons: All, Due, Scheduled, Properties. Per-source breakdown in header when multiple source types exist (e.g., "2 Due · 1 Scheduled · 1 Properties").

---

## 7. Tags & Links

### Tags

- First-class entities that can themselves be tagged
- Hierarchy via naming convention (`work/meeting`) — prefix search finds all descendants
- Boolean queries: AND, OR, NOT composition

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
- **ConfirmDialog** (`src/components/ConfirmDialog.tsx`): Wraps AlertDialog primitives with title/description/cancel/action props, optional `children` slot, `actionVariant` (default/destructive), `loading` spinner. Used by 8 components.
- **LoadMoreButton** (`src/components/LoadMoreButton.tsx`): Cursor-paginated load-more button with `loading`/`hasMore`/`onLoadMore` props and Spinner. Used by 6 components.
- **LoadingSkeleton** (`src/components/LoadingSkeleton.tsx`): Skeleton loading placeholder with `count`/`height` props. Used by 7 components.
- **Spinner** (`src/components/ui/spinner.tsx`): Animated loading indicator wrapping Loader2 with CVA size variants (`sm`=h-3.5, `md`=h-4, `lg`=h-5, `xl`=h-6). Default `md`. Used by 14 components.
- **CloseButton** (`src/components/ui/close-button.tsx`): Shared `closeButtonClassName` constant + `CloseButtonIcon` component for overlay close buttons. Used by Dialog, Sheet.
- **CardButton** (`src/components/ui/card-button.tsx`): Full-width card-style button with border, bg-card, hover:bg-accent/50, focus-visible ring. Used by ResultCard, SearchPanel.
- **Label** (`src/components/ui/label.tsx`): Form label with CVA variants: `size` (sm/xs), `muted` (true/false). Used by HistoryView, AgendaFilterBuilder, PagePropertyTable, LinkEditPopover.
- **ListItem** (`src/components/ui/list-item.tsx`): Interactive list item with group flex layout, gap-3, rounded-lg, hover:bg-accent/50. Used by TagList, PropertiesView.
- **CollapsibleGroupList** (`src/components/CollapsibleGroupList.tsx`): Generic collapsible grouped list with expand/collapse state management. Accepts `expandedGroups` record, `defaultExpanded` prop, `onToggle` callback, and custom `renderBlock` slot. Supports split-header mode via `onPageTitleClick` prop (separate chevron toggle + PageLink title + passive count). Used by LinkedReferences, UnlinkedReferences.
- **BacklinkGroupRenderer** (`src/components/BacklinkGroupRenderer.tsx`): Collapsible backlink group with block items. Renders a grouped backlink section with expand/collapse toggle, page title link, block count badge, and block list. Extracted from LinkedReferences (R-15). Used by LinkedReferences.
- **PeerListItem** (`src/components/PeerListItem.tsx`): Peer card component with sync/rename/unpair actions. Shows device name, peer ID, connection status, last sync time, and ops sent/received. Extracted from DeviceManagement (R-16). Used by DeviceManagement.
- **TaskStatesSection** (`src/components/TaskStatesSection.tsx`): Task state cycle editor. Manages custom task keywords with add/remove/reorder controls, persisted to localStorage. Extracted from PropertiesView (R-17). Used by PropertiesView.
- **DeadlineWarningSection** (`src/components/DeadlineWarningSection.tsx`): Deadline warning days setting. Input for configuring days-before-due warning threshold, persisted to localStorage. Extracted from PropertiesView (R-17). Used by PropertiesView.
- **PropertyDefinitionsList** (`src/components/PropertyDefinitionsList.tsx`): Property definitions CRUD with search, filter, inline editing, and delete confirmation. Extracted from PropertiesView (R-17). Used by PropertiesView.
- **ResultCard** (`src/components/ResultCard.tsx`): Block result card button with content display, Badge for page/tag types, optional spinner, optional children slot. Used by SearchPanel, TagFilterPanel.
- **PageLink** (`src/components/PageLink.tsx`): Inline clickable page name (`<span role="link">`) that navigates via `navigateToPage`. Handles click/Enter/Space with stopPropagation. Uses `<span>` to allow nesting inside `<button>` containers. Used by CollapsibleGroupList, DonePanel, AgendaResults, DuePanel, SearchPanel, QueryResult.
- **PropertyRow** (`src/components/BlockPropertyDrawer.tsx`): Extracted sub-component for property rows with badge+input+remove layout. Supports optional icon, date/text input types.
- **Select** (`src/components/ui/select.tsx`): Radix UI Select wrapper with 10 exported parts and `size` prop on SelectTrigger (`'default'` | `'sm'`). Replaces all native `<select>` elements across 5 component files. Uses `__none__`/`__all__` sentinels for empty values (Radix doesn't support `value=""`).

### Shared Hooks
- **useBlockNavigation** (`src/hooks/useBlockNavigation.ts`): Returns `{ handleBlockClick, handleBlockKeyDown }` for block click + keyboard (Enter/Space) navigation. Accepts `NavigateToPageFn` type. Used by AgendaResults, DonePanel, DuePanel, LinkedReferences, UnlinkedReferences.
- **useListKeyboardNavigation** (`src/hooks/useListKeyboardNavigation.ts`): Arrow key / vim key (j/k) navigation for lists. Supports `wrap` vs `clamp` modes, `Home`/`End` keys, `onSelect` callback. Used by SuggestionList, BlockContextMenu, HistoryView.
- **usePaginatedQuery** (`src/hooks/usePaginatedQuery.ts`): Cursor-based pagination hook with `items`, `hasMore`, `loading`, `loadMore`, `reset` state. Supports `enabled` option for conditional fetching (preserves items when disabled, refetches on re-enable). Used by LinkedReferences, UnlinkedReferences, SearchPanel, TagFilterPanel, and others.
- **useBatchCounts** (`src/hooks/useBatchCounts.ts`): Fetches agenda + backlink counts for date ranges. Returns both total counts and per-source breakdown (due/scheduled/properties). Used by WeeklyView, MonthlyView.
- **useBacklinkResolution** (`src/hooks/useBacklinkResolution.ts`): TTL-cached ULID/tag resolution hook. Batch resolves page IDs and tag IDs to display names with configurable TTL (default 30s). Deduplicates concurrent requests. Extracted from LinkedReferences (R-15). Used by LinkedReferences.
- **useSyncWithTimeout** (`src/hooks/useSyncWithTimeout.ts`): Sync operation executor with Promise.race timeout pattern (default 60s). Supports cancellation via cancelSync. Returns `{ executeSyncWithTimeout, cancelSync }`. Extracted from DeviceManagement (R-16). Used by DeviceManagement.

### Shared Utilities
- **block-events** (`src/lib/block-events.ts`): `BLOCK_EVENTS` constant object (10 event names), `dispatchBlockEvent()`/`onBlockEvent()` helpers for custom DOM event communication between FormattingToolbar and BlockTree. Exports `NavigateToPageFn` type alias for standardized navigation callbacks.
- **date-property-colors** (`src/lib/date-property-colors.ts`): `getSourceColor(source)` returns light/dark mode Tailwind classes for agenda sources (due=orange, scheduled=blue, properties=purple). `getSourceLabel(source)` returns display labels. Used by DaySection colored pills.
- **date-utils** (`src/lib/date-utils.ts`): Consolidated date formatting utilities. `formatDate(d)` (yyyy-MM-dd), `formatDateDisplay(d)` (human-readable), `formatGroupDate(s)` (group headers), `formatCompactDate(s)` (compact display), `getTodayString()`, `getDateRangeForFilter(preset, today)` (7 presets: today/this-week/this-month/overdue/next-7/14/30-days). Single source of truth — eliminates duplicates from parse-date.ts, DuePanel, AgendaResults, AgendaView. Used by DuePanel, DonePanel, AgendaResults, AgendaView, parse-date.

### CSS Utilities
- **`.touch-target-44`** (`src/index.css`): Utility class for `@media(pointer:coarse)` min-height 44px touch targets. Used across 19+ components.
