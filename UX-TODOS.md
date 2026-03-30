# UX Review Findings

> Generated: 2026-03-29 from manual visual review of every view/page via Chrome MCP browser
> Reviewed: 2026-03-30 — code review confirmed 9/13 already fixed, 4 remaining

## Critical Issues

### 1. Tag deletion has no confirmation dialog
- **Status:** RESOLVED (already fixed)
- **Review:** AlertDialog confirmation fully implemented in TagList.tsx. Trash icon sets `deleteTarget` state, then `handleConfirmDelete` runs only after user confirms.

### 2. No way to delete a page from PageBrowser
- **Status:** RESOLVED (already fixed)
- **Review:** Delete button (trash icon on hover) + AlertDialog confirmation fully implemented in PageBrowser.tsx.

### 3. Block deletion is keyboard-only (Backspace), not discoverable
- **Status:** RESOLVED (already fixed)
- **Review:** Visible trash icon on hover in SortableBlock.tsx. Keyboard shortcut documented in KeyboardShortcuts.tsx (accessible via `?` key and sidebar button).

## Layout / Visual Issues

### 4. Empty blocks are invisible
- **Status:** RESOLVED (already fixed)
- **Review:** StaticBlock.tsx shows "Empty block" placeholder. EditableBlock.tsx has `min-h-[2rem]`. TipTap Placeholder extension shows "Type something..." when focused.

### 5. Detail panel pushes content when expanded
- **Status:** CONFIRMED — needs fix
- **Where:** PageEditor.tsx
- **Issue:** Detail panel is inline below BlockTree, starts expanded (`panelCollapsed = false`). Pushes "Add block" button down.
- **Fix:** Start collapsed by default (only open on explicit tab click).

### 6. Page title duplicated in header bar and editing area
- **Status:** RESOLVED (already fixed)
- **Review:** `useHeaderLabel()` in App.tsx returns empty string for page-editor view, preventing duplication. Intentional design with code comment.

## Missing Functionality

### 7. Tag names are not clickable in TagList
- **Status:** RESOLVED (already fixed)
- **Review:** Tag names wrapped in `<button>` with `onTagClick` handler wired to `navigateToPage` in App.tsx.

### 8. No error feedback on failed operations
- **Status:** RESOLVED (already fixed)
- **Review:** Sonner toast infrastructure fully implemented. `toast.error()` on failures in TagList.tsx and PageBrowser.tsx. Silent catches in secondary operations are intentional.

### 9. No keyboard shortcut documentation
- **Status:** RESOLVED (already fixed)
- **Review:** KeyboardShortcuts.tsx component exists with 9 shortcuts. Accessible via `?` key and sidebar button.

## Minor / Polish

### 10. "Add Tag" button disabled state is not obvious
- **Status:** CONFIRMED — needs fix
- **Where:** TagList.tsx / button.tsx
- **Issue:** Only `disabled:opacity-50` styling. No cursor change or color shift.
- **Fix:** Add `disabled:cursor-not-allowed` to button component for better affordance.

### 11. Tag filter search has no results feedback
- **Status:** CONFIRMED — minor enhancement needed
- **Where:** TagFilterPanel.tsx
- **Issue:** Shows usage counts and result totals, but doesn't highlight matching prefix in tag names.
- **Fix:** Bold/highlight the matching portion of tag names in the filter list.

### 12. Sidebar active state could be more prominent
- **Status:** CONFIRMED — needs fix
- **Where:** sidebar.tsx
- **Issue:** Active state has bg-sidebar-accent + font-medium + text color, but is subtle. No high-contrast indicator.
- **Fix:** Add left border indicator (`data-[active=true]:border-l-2 border-l-primary`).

### 13. No loading states visible
- **Status:** RESOLVED (already fixed)
- **Review:** Skeleton loaders in PageBrowser, TagList, SearchPanel, JournalPage. Loading text in BlockTree, TagFilterPanel.

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
