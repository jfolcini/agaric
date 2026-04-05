# UX Lessons Learned

Patterns, antipatterns, and best practices discovered during 200+ sessions of development. Each lesson is grounded in specific implementation experiences with session references for traceability.

---

## 1. Component Design Patterns

### 1.1 Extract shared UI components immediately
**Sessions:** 203, 204, 210
When multiple components need the same UI pattern (select dropdowns, panels, buttons), extract to a shared component immediately. Duplication leads to divergent styling, behavior, and accessibility. Session 210 replaced 16 native `<select>` across 5 components with a unified Radix Select in one pass.
**Rule:** If you're copy-pasting a component pattern, extract it first.

### 1.2 Collapsible sections need consistent headers
**Sessions:** 204, 205
Collapsible panel headers should use a shared component (chevron + title + count) to ensure consistent spacing, alignment, and keyboard behavior. Session 204 extracted `CollapsiblePanelHeader` used by DonePanel and DuePanel.
**Rule:** Use `CollapsiblePanelHeader` for all collapsible sections.

### 1.3 Config-driven components scale better than conditional branches
**Sessions:** 201
When a component has many similar buttons/items with different labels/icons/handlers, use a config array instead of inline JSX. Session 201 refactored FormattingToolbar from inline JSX to config arrays, reducing ~517 lines to ~330.
**Rule:** If you have 5+ similar items, use a config array.

### 1.4 Touch targets must be 44px minimum on coarse pointers
**Sessions:** 195, 197, 202, 203
Use `[@media(pointer:coarse)]:min-h-[44px]` on all interactive elements. This is a WCAG guideline, not optional.
**Rule:** Every button/link needs `[@media(pointer:coarse)]:min-h-[44px]` or the `.touch-target-44` utility class.

### 1.5 Responsive text sizing prevents readability issues
**Sessions:** 202, 223
Don't use `text-[10px]` or `text-xs` (12px) for content on mobile. Use `text-sm` (14px) minimum with `[@media(pointer:coarse)]:text-sm` overrides.
**Rule:** Never use text smaller than 12px on mobile.

### 1.6 Empty states should be helpful, not silent
**Sessions:** 186, 198
When a list/panel is empty, show a message explaining why and what to do next. Don't just render nothing.
**Rule:** Every list component must have an `EmptyState` message.

### 1.7 Loading states need visual feedback
**Sessions:** 203, 204
When fetching data, show a skeleton loader or spinner. Use `LoadingSkeleton` component with `count` and `height` props.
**Rule:** Use `LoadingSkeleton` for all async data loading.

### 1.8 Overflow handling requires explicit CSS
**Sessions:** 197, 199, 202
Long text/content will break layouts. Use `truncate`, `line-clamp-N`, or `flex-wrap` explicitly.
**Rule:** Every text container must have explicit overflow handling.

### 1.9 Choose Dialog vs Sheet vs AlertDialog vs inline panel deliberately
**Sessions:** 213
Different overlay types serve different purposes. Using the wrong one creates UX confusion.

| Pattern | When to use | Examples |
|---------|-------------|---------|
| **AlertDialog** | Quick confirmation/destructive action (1-2 buttons, no form fields) | Delete page, purge block, clear selection |
| **Dialog** | Complex form or multi-field input (needs focus trap, explicit submit) | PairingDialog, create-new-property |
| **Sheet** | Scrollable side content, secondary panel, or multi-step flow that benefits from seeing the page behind it | Block property drawer, history panel |
| **Inline panel** | Content that belongs within the page flow, not overlaid | Linked references, filter builders |
| **Toast** | Ephemeral feedback with optional undo/retry action | "Block restored", "Sync failed — Retry" |

**Rule:** Quick confirm = AlertDialog, complex form = Dialog, scrollable side content = Sheet, in-page content = inline panel.

---

## 2. Interaction Design

### 2.1 Blur-to-save requires special handling with popovers
**Sessions:** 65, 186, 195
When a block editor has popovers (date picker, link picker), the blur event fires when clicking the popover. Check if the popover is still in the DOM before saving. Use `checkVisibility()` API.
**Rule:** Use `checkVisibility()` to detect visibility before blur-save.

### 2.2 Delete buttons should use onPointerDown, not onClick
**Sessions:** 195
Delete buttons in lists need to fire before focus changes. Use `onPointerDown` to capture the event before the focus-re-render cycle, with `onClick` fallback for keyboard a11y.
**Rule:** Delete buttons use `onPointerDown` + `onClick` fallback.

### 2.3 Keyboard listeners need capture phase + stopPropagation
**Sessions:** 195, 207
When a keyboard shortcut must fire before other handlers (e.g., before ProseMirror), use capture phase with `stopPropagation`. Otherwise the editor consumes the event.
**Rule:** Priority keyboard listeners use `capture:true` + `stopPropagation`.

### 2.4 Outside-click dismissal needs cleanup
**Sessions:** 207
When adding outside-click listeners to close popovers, add cleanup to prevent memory leaks. Use `pointerdown` in capture phase, clean up on unmount.
**Rule:** Outside-click listeners must have cleanup on unmount.

### 2.5 Enter creates new sibling, not newline
**Sessions:** 95
In outliner-style editors, Enter creates a new sibling block. Shift+Enter creates a hard break within the block.
**Rule:** Enter = new sibling, Shift+Enter = newline.

### 2.6 Empty block cleanup prevents clutter
**Sessions:** 95
When users create a new block with Enter but move focus away without typing, silently delete the empty block. Track new block IDs and clean up on focus change.
**Rule:** Auto-delete empty blocks created by Enter key.

### 2.7 Cycling buttons should show current state
**Sessions:** 195
When a button cycles through states (priority 1/2/3/none), show the current state. Don't make users guess.
**Rule:** Cycling buttons display current state.

### 2.8 Undo actions should have toast feedback
**Sessions:** 128
When an undo action is available, show a toast with the action button. Duration should be 6s.
**Rule:** Undo actions show toast feedback with 6s duration.

### 2.9 Partial failure should show retry
**Sessions:** 128, 131
When a batch operation partially fails, show a toast with a "Retry" button. Duration 5s.
**Rule:** Partial failure toasts include retry action with 5s duration.

### 2.10 Breadcrumbs should be clickable for navigation
**Sessions:** 205, 209
Page breadcrumbs in results should be clickable via `PageLink` component.
**Rule:** All page breadcrumbs are clickable via `PageLink`.

### 2.11 Group headers should show counts
**Sessions:** 209, 210
When grouping results (e.g., "Due (3)"), show the count in the header.
**Rule:** Group headers include item counts.

### 2.12 Colored pills communicate status at a glance
**Sessions:** 209, 210, 123
Use consistent colors for status across the app: orange=due, blue=scheduled, green=done, purple=property.
**Rule:** Use consistent semantic colors from `date-property-colors.ts`.

### 2.13 Popovers need max-width and responsive positioning
**Sessions:** 197, 198, 202
Popovers should not exceed viewport width. Use `max-w-[calc(100vw-2rem)]` on mobile.
**Rule:** Popovers use `max-w-[calc(100vw-2rem)]` on mobile.

### 2.14 Hover states need active states on touch
**Sessions:** 202, 217
Elements with `hover:` styles also need `active:` styles for touch feedback. Touch devices don't have hover.
**Rule:** All `hover:` styles get `active:` equivalents.

### 2.15 Silent errors are never acceptable
**Sessions:** 166, 186, 198
Never silently swallow errors with `.catch(() => {})`. Always show feedback to user via `toast.error()`.
**Rule:** Never silently swallow errors.

---

## 3. Accessibility

### 3.1 Focus rings on all interactive elements
**Sessions:** 195, 203, 204
Use `focus-visible:ring-2 focus-visible:outline-ring` on all interactive elements.
**Rule:** All interactive elements have `focus-visible:ring-2`.

### 3.2 Aria-labels required for icon-only buttons
**Sessions:** 195, 205, 208
Icon-only buttons need `aria-label` so screen readers know what they do.
**Rule:** Icon-only buttons always have `aria-label`.

### 3.3 Aria-pressed for toggle buttons
**Sessions:** 153, 223
Toggle buttons should have `aria-pressed="true"` or `"false"`.
**Rule:** Toggle buttons have `aria-pressed`.

### 3.4 Aria-describedby links warnings to inputs
**Sessions:** 196
When an input has a warning message, link them with `aria-describedby`.
**Rule:** Warnings linked to inputs via `aria-describedby`.

### 3.5 Announce state changes to screen readers
**Sessions:** 166, 195
When state changes (priority set, filter applied), announce via `announce()` function.
**Rule:** State changes are announced via `announce()`.

### 3.6 Keyboard shortcuts should be documented
**Sessions:** 195, 203
Add keyboard shortcuts to the help panel and button tooltips.
**Rule:** All keyboard shortcuts documented in help panel + tooltips.

### 3.7 Expand/collapse buttons need dynamic aria-label
**Sessions:** 114
Expand/collapse buttons should have `aria-label` that changes with state.
**Rule:** Expand/collapse buttons have dynamic aria-labels.

---

## 4. Visual Design & Consistency

### 4.1 Property names formatted consistently
**Sessions:** 198
Property names with underscores/hyphens should be title-cased. Use `formatPropertyName()` utility.
**Rule:** Use `formatPropertyName()` for all property name display.

### 4.2 Built-in properties should have icons
**Sessions:** 198, 206
Built-in properties (due_date, scheduled_date, etc.) should have lucide-react icons from `BUILTIN_PROPERTY_ICONS`.
**Rule:** Built-in properties display icons via `BUILTIN_PROPERTY_ICONS`.

### 4.3 Spacing should be consistent across panels
**Sessions:** 206, 192
All panels should use `space-y-2` for list items, `py-1.5 px-2` for padding.
**Rule:** Panels use consistent spacing.

### 4.4 Use design system colors, never arbitrary
**Sessions:** 192
Don't use `text-gray-500` or `bg-slate-400`. Use `text-muted-foreground` and other semantic tokens.
**Rule:** Always use design system colors, never arbitrary colors.

### 4.5 Date chips should have consistent styling
**Sessions:** 57, 93, 200
Use `DateChip` component with consistent color, size, and alignment.
**Rule:** Use `DateChip` component for all date displays.

---

## 5. Touch / Mobile

### 5.1 Pointer events are better than mouse events
**Sessions:** 166, 195
Use `onPointerDown`/`onPointerUp` instead of `onMouseDown`/`onMouseUp`. Pointer events work for both mouse and touch.
**Rule:** Use pointer events instead of mouse events.

### 5.2 Coarse pointer media query for touch-specific styles
**Sessions:** 166, 195, 202, 203
Use `[@media(pointer:coarse)]` for touch-specific styles. More reliable than screen size breakpoints.
**Rule:** Touch-specific styles use `[@media(pointer:coarse)]`.

### 5.3 Gutter buttons visible on touch
**Sessions:** 195
Gutter buttons (drag, history, delete) hidden on hover should be always visible on touch via `[@media(pointer:coarse)]:opacity-100`.
**Rule:** Gutter buttons use `[@media(pointer:coarse)]:opacity-100`.

### 5.4 Dialog close buttons need touch sizing
**Sessions:** 195
Dialog/sheet close buttons need 44px touch targets.
**Rule:** Dialog close buttons have `[@media(pointer:coarse)]:min-h-[44px]`.

### 5.5 Form inputs should stack on mobile
**Sessions:** 199, 202
On mobile, form controls should stack vertically. Use `flex-col sm:flex-row`.
**Rule:** Forms use `flex-col sm:flex-row` for responsive stacking.

---

## 6. Performance UX

### 6.1 Debounce search input
**Sessions:** 201
Search inputs should debounce with 300ms delay via `useDebouncedCallback`.
**Rule:** Search inputs use `useDebouncedCallback` with 300ms delay.

### 6.2 Lazy load heavy components
**Sessions:** 112, 186
Heavy components (e.g., QrScanner) should be lazy-loaded.
**Rule:** Heavy components are lazy-loaded.

### 6.3 Batch queries instead of N+1
**Sessions:** 62, 130, 209
Don't query for each item. Batch queries together (e.g., `countAgendaBatch`).
**Rule:** Use batch queries to avoid N+1 problems.

### 6.4 Skeleton loaders improve perceived performance
**Sessions:** 203
Show skeleton loaders while data is loading. Makes the app feel faster.
**Rule:** Use `LoadingSkeleton` for all async data loading.

### 6.5 Optimistic updates improve responsiveness
**Sessions:** 136
Update the UI optimistically before the server responds. Revert on failure.
**Rule:** Implement optimistic updates for mutations.

---

## 7. State Management UX

### 7.1 Selection state orthogonal to focus
**Sessions:** 133
Block selection (multi-select) must not interfere with focus (single editor). Keep them separate in the store.
**Rule:** Selection and focus are separate store slices.

### 7.2 Standard multi-select patterns
**Sessions:** 133
Ctrl+Click toggles, Shift+Click selects range, plain click edits.
**Rule:** Multi-select uses Ctrl+Click (toggle) and Shift+Click (range).

### 7.3 Escape clears selection
**Sessions:** 133, 138
Pressing Escape clears the selection (unless editing).
**Rule:** Escape clears selection when not editing.

### 7.4 Selection clears on page navigation
**Sessions:** 138
When navigating to a different page, clear the selection.
**Rule:** Selection clears on page navigation.

### 7.5 Collapse state persists in localStorage
**Sessions:** 105
Collapse state (which sections are expanded) should persist across sessions.
**Rule:** Collapse state persists in localStorage.

### 7.6 Cache eviction prevents memory leaks
**Sessions:** 80
Caches should have a max size and evict oldest entries (MAX_CACHE_SIZE=10K).
**Rule:** Caches have max size with oldest-first eviction.

### 7.7 Undo history clears on page navigation
**Sessions:** 80
When navigating to a different page, clear the undo history.
**Rule:** Undo history clears on page navigation.

---

## 8. Sync & Offline UX

### 8.1 Sync state should be visible
**Sessions:** 146, 147
Users need to see if sync is working. Show sync status in header with dot indicator.
**Rule:** Sync status is always visible in header.

### 8.2 Offline state should be graceful
**Sessions:** 146
When offline, the app should continue to work locally. Don't block editing.
**Rule:** App continues to work offline with local-only changes.

### 8.3 Online event triggers immediate sync
**Sessions:** 146
When the device comes back online, sync immediately.
**Rule:** Online event triggers immediate sync.

### 8.4 Sync timeouts should be generous
**Sessions:** 146
Network timeouts should be generous (60s+ for WebSocket operations) to avoid false failures.
**Rule:** Sync timeouts are 60s+ to avoid false failures.

---

## 9. Error Handling UX

### 9.1 Validation errors should be inline
**Sessions:** 104, 196
Form validation errors appear inline next to the field with `aria-describedby`.
**Rule:** Validation errors appear inline with `aria-describedby`.

### 9.2 Backend errors should surface to user
**Sessions:** 104
When the backend returns an error, show it via toast or inline message.
**Rule:** Backend errors surface to user.

### 9.3 Error recovery should be automatic when possible
**Sessions:** 249
Try to recover automatically. Only show error if recovery fails.
**Rule:** Implement automatic error recovery when possible.

---

## 10. Common Footguns

### 10.1 Always use i18n for user-visible strings
**Sessions:** 182
Hardcoded strings make translation impossible. Session 182 extracted ~250 hardcoded strings.
**Rule:** All user-visible strings use `t()` from i18n.

### 10.2 Don't forget cleanup on unmount
**Sessions:** 207
Event listeners in useEffect must be cleaned up on unmount.
**Rule:** All event listeners have cleanup functions.

### 10.3 useEffect dependencies must be exhaustive
**Sessions:** 195, 200
Missing dependencies cause stale closures and bugs.
**Rule:** Fix all exhaustive-deps warnings.

### 10.4 Don't use inline styles
**Sessions:** 202
Inline styles don't benefit from Tailwind's responsive utilities.
**Rule:** Always use Tailwind classes, never inline styles.

### 10.5 Test a11y with axe
**Sessions:** 177, 195
Use axe accessibility audits in tests.
**Rule:** All new components have `axe(container)` a11y audits in tests.

### 10.6 Handle focus trap in modals
**Sessions:** 166
Modal dialogs should trap focus so keyboard users can't tab outside. Use Radix Dialog.
**Rule:** Modals use focus trap via Radix Dialog.

### 10.7 Handle escape key in all popovers
**Sessions:** 207
All popovers/modals must close on Escape.
**Rule:** All popovers/modals close on Escape.

---

## Summary of Key Principles

1. **Consistency** -- Use shared components, design system colors, and consistent spacing everywhere.
2. **Mobile-first** -- Always consider touch users. Use `[@media(pointer:coarse)]` for touch-specific styles.
3. **Accessibility** -- Add aria-labels, focus rings, and semantic HTML. Test with axe.
4. **Feedback** -- Show loading states, error messages, and confirmation dialogs. Never silently fail.
5. **Performance** -- Debounce search, lazy-load, batch queries, use memoization.
6. **User control** -- Let users undo, clear selections, and navigate easily.
7. **Graceful degradation** -- App works offline, handles errors gracefully, provides fallbacks.
