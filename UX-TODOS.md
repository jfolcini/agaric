# UX Review Findings

> Generated: 2026-03-29 from manual visual review of every view/page via Chrome MCP browser

## Critical Issues

### 1. Tag deletion has no confirmation dialog
- **Where:** TagList.tsx, lines 58-65, 106-113
- **Issue:** Clicking the trash icon immediately deletes the tag with no undo or confirmation
- **Impact:** Accidental data loss -- tags removed from all blocks permanently
- **Fix:** Add a confirmation dialog (or at minimum, toast with undo)

### 2. No way to delete a page from PageBrowser
- **Where:** PageBrowser.tsx
- **Issue:** Pages can only be created, not deleted. No trash icon, no context menu, no swipe-to-delete
- **Impact:** Users have no discoverable way to remove pages they no longer need
- **Fix:** Add delete button (with confirmation) per page item, or context menu

### 3. Block deletion is keyboard-only (Backspace), not discoverable
- **Where:** BlockTree.tsx lines 198-215, use-block-keyboard.ts lines 84-89
- **Issue:** The only way to delete a block is: focus it, select all text, press Backspace to empty it, then press Backspace again. No visible delete button.
- **Impact:** New users will not discover how to delete blocks
- **Fix:** Add a visible delete button on the block toolbar (next to drag handle), or in right-click context menu

## Layout / Visual Issues

### 4. Empty blocks are invisible
- **Where:** EditableBlock.tsx, when a new block is created with no text
- **Issue:** An empty block has no visible border, no min-height, and no placeholder text when not focused. Users can't see where to click to start typing.
- **Impact:** After clicking "+ Add block", the block appears to not have been created
- **Fix:** Add min-height and a visible placeholder (e.g., "Type something...") to empty blocks

### 5. Detail panel pushes content when expanded
- **Where:** BlockTree.tsx detail panel (Backlinks/History/Tags tabs)
- **Issue:** When the detail panel is expanded, it appears inline below the selected block, pushing the rest of the content and "+ Add block" button down. For a new empty page with one empty block, the block content area is nearly invisible.
- **Impact:** The detail panel takes up more visual weight than the actual editing area
- **Fix:** Consider making the detail panel collapsible by default (only open on explicit click), or move it to a side rail instead of inline

### 6. Page title duplicated in header bar and editing area
- **Where:** Page editor view (any page)
- **Issue:** The page title appears both in the top header bar ("Getting Started") and as an editable textbox in the editing area. This is visually redundant.
- **Impact:** Minor visual clutter
- **Fix:** Either make the header bar title a breadcrumb (Pages > Getting Started) or remove the in-body title

## Missing Functionality

### 7. Tag names are not clickable in TagList
- **Where:** TagList.tsx
- **Issue:** Clicking on a tag name does nothing. There's no navigation to a tag detail view showing all blocks with that tag.
- **Impact:** The TagPanel component exists but is unreachable from the tag list
- **Fix:** Make tag names clickable to navigate to tag detail view (show blocks with that tag)

### 8. No error feedback on failed operations
- **Where:** TagList.tsx handleDeleteTag (catch block is empty), and similar patterns elsewhere
- **Issue:** Operations that fail are silently swallowed. No toast, no error indicator.
- **Impact:** Users don't know if their action succeeded or failed
- **Fix:** Add toast notifications for errors (and optionally for success)

### 9. No keyboard shortcut documentation
- **Where:** Global
- **Issue:** Keyboard shortcuts exist (Backspace to delete, Tab/Shift+Tab to indent, arrow keys to navigate between blocks) but are not documented anywhere in the UI
- **Impact:** Keyboard shortcuts are undiscoverable
- **Fix:** Add a keyboard shortcut help panel (? key or menu item), or at minimum, tooltip hints on block hover

## Minor / Polish

### 10. "Add Tag" button disabled state is not obvious
- **Where:** TagList.tsx
- **Issue:** The "Add Tag" button is disabled when the input is empty, but the visual difference between disabled and enabled states is subtle
- **Fix:** Improve disabled state styling or use placeholder text to hint at required input

### 11. Tag filter search has no results feedback
- **Where:** TagList.tsx Tag Filter section
- **Issue:** Typing in the tag filter prefix search box has no immediate visual feedback about matched tags below
- **Fix:** Show matched count or highlight matching tags in the list above

### 12. Sidebar active state could be more prominent
- **Where:** App.tsx sidebar
- **Issue:** The current active nav item has a subtle highlight that could be more prominent for quick scanning
- **Fix:** Increase contrast or add a left border indicator for the active nav item

### 13. No loading states visible
- **Where:** All data-loading views (Pages, Tags, Search, Journal)
- **Issue:** When data is loading (IPC calls to backend), there's no spinner or skeleton state
- **Impact:** With real data and slower operations, users won't see any loading feedback
- **Fix:** Add skeleton loaders or simple spinners for all async data fetches

## Working Well

- Sidebar collapse/expand works smoothly
- Logo placement (SVG + text) is clean in both states
- Journal date navigation (Prev/Next) is intuitive
- "Open in editor" from journal navigates correctly
- Search debouncing works well
- Block drag handles appear on hover (standard pattern)
- TipTap inline editor activates on block click
- Side panel tab switching (Backlinks/History/Tags) works
- "Go back" button navigates correctly
- "New Page" creates page and appears in list immediately
- Tag creation with input + button flow works
- Collapsed sidebar shows icons cleanly
