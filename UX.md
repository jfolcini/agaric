# UX Baseline — Agaric App

Consolidated best practices implemented across the app. New components, features, and visual changes should follow these patterns. This document is the UX equivalent of the test `AGENTS.md` files — a reference for anyone building UI in this project.

## Overview

| Concern | Approach |
|---------|----------|
| Component library | shadcn/ui (copy-paste, no lock-in) |
| Styling | Tailwind CSS v4 + OKLCH custom properties |
| Icons | Lucide (consistent 24px stroke set) |
| Editor | TipTap (ProseMirror) — single roving instance |
| Drag & drop | @dnd-kit with tree-aware depth projection |
| State management | Zustand (6 stores) |
| Toasts | Sonner (`src/components/ui/sonner.tsx`) |
| Code style | 2-space indent, single quotes, no semicolons, 100-char width (Biome) |

## Design Tokens

### Color System (OKLCH)

File: `src/index.css`

All colors are defined as CSS custom properties using OKLCH color space. Light and dark themes share the same semantic names — never hard-code hex/rgb values.

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--background` | white | dark blue-gray | Page background |
| `--foreground` | dark blue-gray | off-white | Body text |
| `--primary` | warm orange | same | Links, active states, primary actions |
| `--secondary` | light gray | medium dark gray | Secondary surfaces |
| `--accent` | light warm tint | — | Hover highlights, tag chips |
| `--destructive` | red | — | Delete, purge, error states |
| `--muted` | light gray | medium dark gray | Disabled text, placeholders |
| `--border` | very light gray | medium dark gray | Borders, separators |
| `--sidebar` | off-white | — | Sidebar background |

**Rule:** Reference tokens via `var(--primary)`, `bg-primary`, `text-destructive`, etc. Never introduce one-off color literals unless they are semantic (e.g., priority badges with explicit color-coding for colorblind support).

### Priority Badge Colors

File: `src/components/SortableBlock.tsx`

| Priority | Light | Dark | Extra |
|----------|-------|------|-------|
| A (High) | `bg-red-100 text-red-700` | `bg-red-900/30 text-red-400` | `ring-2 ring-red-400` |
| B (Medium) | `bg-yellow-100 text-yellow-700` | `bg-yellow-900/30 text-yellow-400` | — |
| C (Low) | `bg-blue-100 text-blue-700` | `bg-blue-900/30 text-blue-400` | `border-dashed border-blue-400` |

A gets a ring, C gets a dashed border — both distinguishable without color (colorblind-safe).

### Task Checkbox Colors

File: `src/components/SortableBlock.tsx`

| State | Visual |
|-------|--------|
| TODO | Empty square — `border-2 border-muted-foreground` |
| DOING | Blue dot — `border-blue-500 bg-blue-500/20` |
| DONE | Green checkmark — `border-green-600 bg-green-600` + white check, block gets `line-through opacity-50` |

### Border Radius

| Token | Value | Tailwind |
|-------|-------|----------|
| `--radius` (base) | `0.625rem` (10px) | — |
| `--radius-sm` | 6px | `rounded-sm` |
| `--radius-md` | 8px | `rounded-md` |
| `--radius-lg` | 10px | `rounded-lg` |
| `--radius-xl` | 14px | `rounded-xl` |

### Typography

- **Font sans:** System font stack — `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ...`
- **Font mono:** `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, ...`
- **Editor text:** Mobile-first `text-base` (16px) with `md:text-sm` (14px) breakpoint — prevents iOS auto-zoom on input focus
- **Inline code:** `0.85em` relative size

## Spacing & Layout

### Indentation

File: `src/index.css` (custom properties), `src/components/SortableBlock.tsx` (constants)

- **Desktop:** `--indent-width: 24px`
- **Touch:** `--indent-width: 16px` (via `@media (pointer: coarse)`)
- **Block indent:** `padding-left: calc(var(--indent-width) * depth)`
- **Indent guide:** Vertical line at `calc(var(--indent-width) * (depth - 1) + var(--indent-width) / 2)`
- **Gutter width:** Fixed `44px` (holds drag handle + delete button)

### Block Spacing

File: `src/components/BlockTree.tsx`

- **Desktop:** `space-y-0.5` (2px between blocks)
- **Touch:** `space-y-1.5` (6px between blocks — bigger tap separation)

### Component Padding

| Area | Padding |
|------|---------|
| ProseMirror content | `px-3 py-1.5` (12px H, 6px V) |
| Code blocks | `px-3 py-2` (12px H, 8px V) |
| Inline code | `px-1 py-0.5` (4px H, 2px V) |
| Toolbar | `px-2 py-px` (8px H, 1px V), `gap-0.5` between buttons, `Separator` at `border-border/40` |
| Context menu | `p-1`, items `px-2 py-1.5` |
| Suggestion list | `p-1`, items `px-2 py-1.5` |
| Chips (desktop) | `px-1.5 py-0.5` |
| Chips (touch) | `px-2.5 py-1` |

### Sidebar

File: `src/components/ui/sidebar.tsx`

| Property | Value |
|----------|-------|
| Default width | `150px` (`SIDEBAR_WIDTH_DEFAULT`) |
| Minimum width | `120px` (`SIDEBAR_WIDTH_MIN`) |
| Mobile width | `min(18rem, 85vw)` — caps at 85% viewport |
| Icon-only width | `3rem` (48px) |
| Resize handle | `16px` total width (`w-4`), `2px` visible line (`after:w-[2px]`) |
| Double-click handle | Resets to default width and opens sidebar |
| Resize cursor | `col-resize` (applied to `documentElement` during drag) |
| Persistence | Cookie `sidebar_state` (7-day expiry), localStorage `sidebar_width` |

## Touch & Mobile

### Touch Target Sizing

File: `src/components/ui/button.tsx` (button variants), `src/components/SortableBlock.tsx` (inline controls)

**Minimum:** 44px on touch devices (WCAG 2.5.8 / Apple HIG / Material 3). Enforced via `@media(pointer: coarse)` overrides, never by viewport width.

| Component | Desktop | Touch (coarse pointer) |
|-----------|---------|------------------------|
| Button (default) | `h-9` (36px) | `h-11` (44px) |
| Button (xs) | `h-6` (24px) | `h-10` (40px) |
| Button (sm) | `h-8` (32px) | `h-10` (40px) |
| Button (icon) | `size-9` (36px) | `size-11` (44px) |
| Button (icon-xs) | `size-6` (24px) | `size-10` (40px) |
| Button (icon-sm) | `size-8` (32px) | `size-10` (40px) |
| SidebarTrigger | `size-7` (28px) | `size-11` (44px) |
| StaticBlock | auto | `min-h-[2.75rem]` |
| Chips (tag/link) | small | `px-2.5 py-1 text-sm` |
| Calendar cells | `size-8` | `size-11` |
| Calendar nav | default | `size-10` |
| Scrollbar | `w-2.5` / `h-2.5` | `w-4` / `h-4` |
| Context menu items | `py-1.5` | `min-h-[44px]` |
| Suggestion items | `py-1.5` | `py-3 min-h-[44px]` |
| Drag handle / Delete | auto | `min-h-[44px] min-w-[44px]` |
| Collapse toggle | auto | `min-h-[44px] min-w-[44px]` |
| Task checkbox | auto | `min-h-[44px] min-w-[44px]` |
| Priority badge | auto | `min-h-[44px] min-w-[44px]` |
| Sidebar group actions | default | `after:-inset-2` (8px hit area expansion) |

### Responsive Viewport

- **Dynamic viewport height:** `100dvh` (not `100vh`) — handles mobile browser chrome correctly
- **Safe area insets:** `viewport-fit=cover` in meta tag + `padding: env(safe-area-inset-*)` on body — handles notches and rounded corners
- **Virtual keyboard awareness:** `visualViewport?.height` with `innerHeight` fallback — prevents content from being hidden behind soft keyboard
- **Mobile breakpoint:** `768px` (Tailwind `md`), detected via `window.innerWidth < 768` in `useIsMobile` hook (`src/hooks/use-mobile.ts`)
- **Mobile detection:** Synchronous initializer in `useIsMobile` to prevent layout flash

### Pointer Events

- **Use `onPointerDown` / `onPointerEnter`** — never `onMouseDown` / `onMouseEnter`. Pointer events work on mouse, touch, and stylus.
- **FormattingToolbar:** All 14 handlers use `onPointerDown` with `e.preventDefault()` to prevent editor focus loss.
- **Hover-reveal controls:** `opacity-0 → opacity-100` on group hover (desktop). Always visible on touch devices.

### Drag & Drop Sensors

File: `src/hooks/useBlockDnD.ts`

| Context | Sensor | Configuration |
|---------|--------|---------------|
| Desktop | PointerSensor | `distance: 8` (8px before activation) |
| Mobile | PointerSensor | `delay: 250, tolerance: 5` (250ms hold, 5px wiggle room) |
| Keyboard | KeyboardSensor | `sortableKeyboardCoordinates` |

### Long-Press Context Menu

File: `src/components/SortableBlock.tsx`

- **Delay:** 400ms (`LONG_PRESS_DELAY`)
- **Movement threshold:** 10px (`LONG_PRESS_MOVE_THRESHOLD`) — exceeding cancels long-press
- **Drag cancellation:** `isDraggingRef` cancels long-press if DnD activates first

### Mobile Sidebar

File: `src/components/ui/sidebar.tsx`

- **Swipe-to-open:** Left-edge swipe gesture (20px edge zone, 50px minimum distance) — Android navigation drawer pattern
- **Component:** `<Sheet>` offcanvas component (not sidebar collapse)
- **Rail:** Hidden on mobile (`sm:flex`)

### Mobile-Specific Layout

| Pattern | Implementation |
|---------|---------------|
| Date picker | Desktop: centered at 1/3 height. Mobile (`max-[479px]`): full-width with padding, 70vh max height, scrollable |
| Calendar popup | `max-[479px]` responsive breakpoint with scroll |
| Sidebar width | `min(18rem, 85vw)` clamping |

## Keyboard Navigation

### Block Editing Shortcuts

File: `src/editor/use-block-keyboard.ts`

| Shortcut | Action | Condition |
|----------|--------|-----------|
| Arrow Up / Left | Focus previous block | Cursor at position 0 |
| Arrow Down / Right | Focus next block | Cursor at end |
| Enter | Save and close editor | — |
| Shift+Enter | Hard break (newline within block) | — |
| Escape | Cancel editing, discard changes | — |
| Backspace | Delete empty block | Block is empty |
| Backspace | Merge with previous block | Cursor at start, block non-empty |
| Tab | Indent block (reparent) | — |
| Shift+Tab | Dedent block | — |
| Ctrl+Shift+Up | Move block up among siblings | — |
| Ctrl+Shift+Down | Move block down among siblings | — |
| Ctrl+Enter | Cycle task state (TODO → DOING → DONE → none) | — |
| Ctrl+. | Toggle collapse/expand children | Block has children |

### Formatting Shortcuts

File: `src/editor/use-roving-editor.ts` (priority shortcuts), TipTap built-ins (text formatting)

| Shortcut | Action |
|----------|--------|
| Ctrl+B | Bold |
| Ctrl+I | Italic |
| Ctrl+E | Inline code |
| Ctrl+K | Insert/edit external link |
| Ctrl+Shift+C | Toggle code block |
| Ctrl+Shift+1 | Set priority A (high) |
| Ctrl+Shift+2 | Set priority B (medium) |
| Ctrl+Shift+3 | Set priority C (low) |

### Picker Triggers

| Trigger | Opens |
|---------|-------|
| `@` | Tag picker (fuzzy search tags) |
| `[[` | Block link picker (fuzzy search pages) |
| `/` | Slash command menu (`/TODO`, `/DOING`, `/DONE`, `/date`) |

### Global Shortcuts

File: `src/App.tsx` (global keydown handler), `src/components/ui/sidebar.tsx` (Ctrl+B)

| Shortcut | Action |
|----------|--------|
| Ctrl+F | Focus search |
| Ctrl+N | Create new page |
| Ctrl+B | Toggle sidebar |
| ? | Show keyboard shortcuts panel |
| Alt+Left | Previous day/week/month (journal) |
| Alt+Right | Next day/week/month (journal) |
| Alt+T | Go to today (journal) |
| Ctrl+Z | Undo (page-level, outside editor) |
| Ctrl+Y | Redo (page-level, outside editor) |
| Escape | Close dialog / cancel editing |

### History View Shortcuts

File: `src/components/KeyboardShortcuts.tsx`

| Shortcut | Action |
|----------|--------|
| Space | Toggle selection |
| Shift+Click | Range select |
| Ctrl+A | Select all |
| Enter | Revert selected |
| Escape | Clear selection |
| Arrow Up / Down | Navigate items |
| j / k | Navigate items (vim-style) |

### Suggestion List Navigation

File: `src/editor/SuggestionList.tsx`

| Key | Action |
|-----|--------|
| Arrow Down | Next item (wraps to start) |
| Arrow Up | Previous item (wraps to end) |
| Enter | Select current item |
| Escape | Close list |

Selected items auto-scroll into view via `scrollIntoView({ block: 'nearest' })`.

### Context Menu Navigation

File: `src/components/BlockContextMenu.tsx`

| Key | Action |
|-----|--------|
| Arrow Down | Next item (circular) |
| Arrow Up | Previous item (circular) |
| Home | First item |
| End | Last item |
| Escape | Close menu, restore focus to trigger |

### Keyboard Shortcuts Panel

File: `src/components/KeyboardShortcuts.tsx`

Triggered by pressing `?` globally (when not editing a block). Uses `<Sheet>` slide-in panel with grouped shortcut categories. The `?` listener skips activation when the target is an `<input>`, `<textarea>`, or `contentEditable` element.

Key rendering: `+` separates modifiers (rendered as separate `<kbd>` elements), `/` shows alternatives.

### Date Picker Focus Trap

File: `src/components/BlockTree.tsx`

Tab cycles within the dialog. Shift+Tab at the first element wraps to the last. Auto-focuses first button on mount. Escape closes.

## Accessibility

### ARIA Patterns

Every custom interactive component (buttons, inputs, menus, dialogs) must have proper ARIA attributes. Here are the established patterns:

**Editor** (`src/editor/use-roving-editor.ts`):
```jsx
role="textbox" aria-multiline="true" aria-label="Block editor"
```

**Toolbar** (`src/components/FormattingToolbar.tsx`):
```jsx
role="toolbar" aria-label="Formatting" aria-controls={`editor-${blockId}`}
```
Toggle buttons use `aria-pressed={isActive}` with `bg-accent` styling when active.

**Collapse toggle** (`src/components/SortableBlock.tsx`):
```jsx
aria-label={isCollapsed ? 'Expand children' : 'Collapse children'}
aria-expanded={!isCollapsed}
```

**Task checkbox** (`src/components/SortableBlock.tsx`):
```jsx
aria-label={todoState ? `Task: ${todoState}. Click to cycle.` : 'Set as TODO'}
```

**Context menu** (`src/components/BlockContextMenu.tsx`):
```jsx
<div role="menu" aria-label="Block actions">
  <button role="menuitem" tabIndex={idx === focusedIndex ? 0 : -1}>
```

**Suggestion list** (`src/editor/SuggestionList.tsx`):
```jsx
<div role="listbox" aria-label={label ?? 'Suggestions'}>
  <button role="option" aria-selected={index === selectedIndex}>
```

**Dialogs/modals** (`src/components/BlockTree.tsx`):
```jsx
role="dialog" aria-modal="true" aria-label="Date picker"
```

**Loading states** (`src/components/BlockTree.tsx`):
```jsx
role="status" aria-label="Loading blocks" aria-busy="true"
```

**Inline validation** (`src/components/LinkEditPopover.tsx`):
```jsx
<p className="text-xs text-destructive" role="alert">{error}</p>
```

**Form groups:**
```jsx
<fieldset> with onKeyDown handlers + keyboard hint text
<label htmlFor="..."> for every input
aria-describedby for supplementary instructions
```

### Screen Reader Announcements

File: `src/lib/announcer.ts`

Singleton `aria-live` announcer:
- `aria-live="polite"`, `aria-atomic="true"`, `role="status"`
- Visually hidden (off-screen clip)
- Double-RAF pattern: clear text, then set new text via `requestAnimationFrame`

```ts
import { announce } from '@/lib/announcer'

announce('Block deleted')
announce('Task marked as DONE')
```

**Announce on:**
- Block deletion ("Block deleted")
- Focus navigation (prev/next block)
- Task state toggle ("Task marked as DONE")
- Keyboard shortcuts (Alt+Arrow, Ctrl+F/N)
- Filter add/remove count
- Async operation results

### Focus Management

| Scenario | Behavior |
|----------|----------|
| Block focus | `scrollIntoView({ block: 'nearest' })` via `requestAnimationFrame` |
| Editor blur | Check if focus moved to suggestion popup, toolbar, or Radix popovers — if so, keep editor mounted |
| Modal close | Restore focus to trigger element (`triggerRef.current.focus()`) |
| Context menu open | Auto-focus first item |
| Context menu close | Restore focus to trigger |
| Filter add | Move focus to new filter |
| Popover open | Auto-focus input field |

### Editor Blur Boundaries

File: `src/components/EditableBlock.tsx`

When the editor loses focus, the blur handler checks if focus moved to a transient UI element. If so, the editor stays mounted:

```ts
// relatedTarget-based detection
related.closest('.suggestion-popup')
related.closest('.suggestion-list')
related.closest('.formatting-toolbar')
related.closest('[data-radix-popper-content-wrapper]')
related.closest('.rdp')

// DOM fallback (when relatedTarget is null)
document.querySelector('.suggestion-popup')
document.querySelector('.date-picker-popup')
document.querySelector('[data-radix-popper-content-wrapper]')
```

If focus moves outside all blur boundaries, the editor unmounts: serialize → compare → flush if dirty.

### Semantic HTML

- Buttons are `<button type="button">` (not `<div onClick>`)
- Search forms use `<form role="search">`
- Labels use `<label htmlFor="...">`
- Lists use `<ul>/<ol>/<li>` (not styled divs)
- Headings maintain proper hierarchy

### Contrast & Media Queries

File: `src/index.css`

| Media query | Effect |
|-------------|--------|
| `prefers-color-scheme: dark` | Dark theme via `.dark` class |
| `prefers-reduced-motion: reduce` | `animation-duration: 0.01ms`, `transition-duration: 0.01ms`, `scroll-behavior: auto` |
| `prefers-contrast: more` | `border-color: oklch(0.7 0 0)`, `outline: 3px solid currentColor` with `2px` offset |

Amber/colored badges must meet WCAG AA contrast ratio (4.5:1) for large text.

### Data Attributes

File: All components in `src/components/ui/`

shadcn/ui components use `data-slot` attributes for reliable styling and testing hooks:

```jsx
data-slot="alert-dialog"          // AlertDialog root
data-slot="alert-dialog-content"  // AlertDialog content wrapper
data-slot="sheet"                 // Sheet root
data-slot="sidebar"               // Sidebar container
data-slot="skeleton"              // Skeleton loading placeholder
```

**Convention:**
- `data-slot="component-name"` — for shadcn/ui wrapper components (used for both styling and test queries)
- `data-testid="descriptive-name"` — for test-only queries (not styling)
- Never style using `data-testid`. Use `data-slot` for styling hooks.

## Animations & Transitions

### Global Reduced Motion

File: `src/index.css`

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

All CSS animations are automatically disabled. Custom JS-driven animations (e.g., `requestAnimationFrame` loops) must check `prefers-reduced-motion` manually.

### Standard Animation Patterns

| Component | Enter | Exit | Duration |
|-----------|-------|------|----------|
| AlertDialog overlay | `fade-in-0` | `fade-out-0` | 200ms |
| AlertDialog content | `fade-in-0 zoom-in-95` | `fade-out-0 zoom-out-95` | 200ms |
| Sheet overlay | `fade-in-0` | `fade-out-0` | 300ms close / 500ms open |
| Sheet content | `slide-in-from-{side}` | `slide-out-to-{side}` | 300ms close / 500ms open |
| Popover | `fade-in-0 zoom-in-95` | `fade-out-0 zoom-out-95` | — |
| Tooltip | `fade-in-0 zoom-in-95` | `fade-out-0 zoom-out-95` | — |
| Context menu | `fade-in-0 zoom-in-95` | — | — |

### Micro-Interactions

| Element | Interaction | Effect |
|---------|-------------|--------|
| Buttons | Click/tap | `active:scale-95` (slight press-in) |
| Chevron | Expand/collapse | `transition-transform` with `rotate-90` |
| Sidebar collapse | Toggle | `transition-transform` with `rotate-180` |
| Sidebar width | Resize | `transition-[width] duration-200 ease-linear` (disabled during active resize via `!transition-none`) |
| Loading spinner | Async ops | `animate-spin` on `Loader2` icon |
| Color transitions | Hover/focus | `transition-colors` |
| Opacity transitions | Show/hide | `transition-opacity` |

### Active/Hover States

Enabled interactive elements should have both `:hover` and `:active` counterparts:
- Tag chips: `hover:bg-accent/80` + `:active` equivalent
- Block link chips: `hover:bg-primary/20` + `:active` equivalent
- External links: `hover:decoration-primary` + `:active` equivalent
- Buttons: hover background shift + `active:scale-95`

## Component Patterns

### Button Hierarchy

Three levels of visual importance, consistently applied:

| Level | Variant | Usage |
|-------|---------|-------|
| Primary action | `variant="outline" size="sm"` | Create, Save, Apply |
| Utility | `variant="ghost" size="xs"` | Secondary controls, toggles |
| Hover-reveal | `variant="ghost" size="icon-xs"` | Delete, close, inline actions |

Destructive buttons use `variant="destructive"` — reserved for purge, permanent delete, discard.

### Formatting Toolbar

File: `src/components/FormattingToolbar.tsx`

Floating toolbar above the active editor with formatting buttons grouped by `<Separator>`:
1. **Text formatting:** Bold, Italic, Code
2. **Links & references:** External link, Page link, Tag, Code block
3. **Metadata:** Priority 1/2/3, Date
4. **History:** Undo, Redo

All buttons use `onPointerDown` with `e.preventDefault()` — this prevents the TipTap editor from losing focus when clicking a toolbar button. Without `preventDefault()`, the editor blur fires and unmounts before the command runs.

Active state: `aria-pressed="true"` + `bg-accent text-accent-foreground`. Disabled state: `disabled` attribute + `opacity-50`.

### Toast Patterns

File: `src/components/ui/sonner.tsx`

Sonner toasts are themed via CSS custom properties that map to the design token system:

```tsx
<Sonner style={{
  '--normal-bg': 'var(--popover)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--border)',
}} />
```

Usage:
```ts
import { toast } from 'sonner'
toast.error('Failed to load pages')  // Error — red styling
toast.success('Block restored')       // Success — green styling
toast('Block created')                // Neutral info
```

### Empty States

- Dashed border container with centered text and optional inline CTA
- Differentiated messages: "No results" vs "No filters applied" vs "Nothing here yet"
- When filters active, show a "Clear all" button in the empty state

### Loading States

- **Skeleton placeholders:** `<Skeleton>` (`data-slot="skeleton"`) preserves layout dimensions while loading
- **Spinner:** `<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />`
- **Loading container:** `<div role="status" aria-label="Loading blocks" aria-busy="true">`
- **Stale-while-revalidate:** Show previous data with loading indicator, not blank screen

### Error Feedback

- **Toast errors:** `toast.error('Specific message')` on every catch block — no silent failures
- **Toast success:** `toast.success()` after restore, purge, keep, discard, revert
- **Inline validation:** `<p className="text-xs text-destructive" role="alert">`
- **Specific messages:** "Failed to load pages" not "Operation failed"
- **Console errors:** `console.error()` alongside toast for debugging

### Confirmation Dialogs

File: `src/components/ui/alert-dialog.tsx`

All destructive actions use Radix `<AlertDialog>`:

```tsx
<AlertDialog>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete block?</AlertDialogTitle>
      <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction className={buttonVariants({ variant: 'destructive' })}>
        Delete
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

- Overlay: `bg-black/50` (light) / `bg-black/60` (dark)
- Centered modal with semantic `data-slot` attributes on every sub-element
- Cancel (outline variant) + Confirm (destructive variant)

### Context Menu

File: `src/components/BlockContextMenu.tsx`

- **Trigger:** Right-click (desktop) / long-press 400ms (mobile)
- **Positioning:** `position: fixed`, viewport-clamped with 8px padding from edges (`PAD` constant)
- **Focus:** Auto-focus first item, circular keyboard navigation, Escape closes and restores focus
- **Styling:** `min-w-[160px]`, `animate-in fade-in-0 zoom-in-95`

### Tooltip Patterns

- Required on icon-only buttons — no text label means tooltip is mandatory
- Keyboard-accessible via Radix `TooltipTrigger`
- Positioned with `slide-in-from-{side}` based on placement

### Filter UI

- **Pill-based display:** Removable `<Badge>` pills with X button
- **Sort control:** Dropdown with explicit default label ("Sort by creation date (default)")
- **Count badge:** Shows active filter count
- **Duplicate prevention:** Prevent adding the same filter twice
- **Empty validation:** Guard against empty date/text values
- **Focus after add:** Focus moves to newly added filter
- **Keyboard:** Enter to apply, Escape to cancel
- **Clear all:** Button to remove all filters at once

### Inline Tokens

| Token | Storage | Render | Interaction |
|-------|---------|--------|-------------|
| Tag ref | `#[ULID]` | Chip with resolved tag name, `bg-accent` | Click navigates to tag |
| Block link | `[[ULID]]` | Chip with resolved page title, `bg-primary/10` | Click navigates to page |
| External link | Markdown `[text](url)` | Underlined `text-primary`, `↗` icon (decorative, `aria-hidden`), SR text "(opens in new tab)" | Click opens URL |
| Deleted tag | `#[ULID]` | Chip with `opacity-0.6 line-through` | — |
| Broken link | `[[ULID]]` | Chip with `opacity-0.6 line-through` | — |

### Scroll Areas

- Use `<ScrollArea>` (Radix) for custom scrollbars
- Scrollbar width: `w-2.5` desktop, `w-4` touch
- Scrollable panels: `max-h-96` (was `max-h-60`, increased for usability)

## Editor UX

### Roving Editor Pattern

File: `src/editor/use-roving-editor.ts`

One TipTap instance at all times. Non-focused blocks render as static divs via `StaticBlock` (`src/components/StaticBlock.tsx`).

| Phase | What happens |
|-------|-------------|
| Mount (focus) | Parse markdown → `replaceDocSilently()` (with `addToHistory: false`) → clear undo history via `state.reconfigure()` → focus |
| Edit | ProseMirror handles input, formatting, keyboard shortcuts |
| Blur | Serialize → compare via `computeContentDelta()` → flush if dirty → clear doc silently → unmount |

**Undo boundary:** ProseMirror history is cleared on mount via `state.reconfigure({ plugins: state.plugins })`. Ctrl+Z inside the editor only undoes within the current editing session. Page-level undo (Ctrl+Z outside editor) uses the op log reverse system via `useUndoStore` (`src/stores/undo.ts`).

### Static Block Rendering

File: `src/components/StaticBlock.tsx`

Non-focused blocks render as plain divs using `renderRichContent()`:
- `tag_ref` nodes → `<span className="tag-ref-chip">` (or `tag-ref-deleted` if deleted)
- `block_link` nodes → `<span className="block-link-chip">` (clickable, navigates on click)
- Text with marks → `<strong>`, `<em>`, `<code>` wrappers
- External links → `<span className="external-link">` with `↗` icon and SR-only text
- Code blocks → `<pre><code className="hljs language-{lang}">` with lowlight syntax highlighting
- Click anywhere on a static block → mount editor (focus)
- Click on a chip or link → navigate/open (event propagation stopped)

### Block Splitting

When content contains `\n` after serialization:
1. First line → `edit_block` (updates original)
2. Subsequent lines → `create_block` (new blocks below)

### Block Merging

Backspace at the start of a non-empty block appends its content to the previous block.

### Drag & Drop Visual Feedback

- **Dragging block:** `opacity: 0.7`
- **Drop indicator:** Shows target position and depth level
- **Tree-aware:** Horizontal offset determines indent depth during drag

### Link Editing

File: `src/components/LinkEditPopover.tsx`

- **Trigger:** Ctrl+K or click existing link (dispatches `open-link-popover` custom event)
- **Popover:** Auto-focus URL input, Enter to apply, Escape to cancel
- **Validation:** Blocks `javascript:` and `data:` URLs, auto-prepends `https://` to schemeless URLs, recognizes `mailto:` and `tel:` schemes

### Code Highlighting

File: `src/index.css` (dark mode syntax colors)

Syntax highlighting via lowlight with OKLCH-based colors:

| Element | Color |
|---------|-------|
| Keywords | Red `#f47067` |
| Functions | Purple `#dcbdfb` |
| Numbers/Attributes | Blue `#6cb6ff` |
| Strings | Cyan `#96d0ff` |
| Built-ins | Orange `#f69d50` |
| Comments | Gray `#768390` |
| Names | Green `#8ddb8c` |

## Navigation Patterns

### Sidebar Navigation

- Journal / Pages / Tags / Trash / Status / Conflicts / Sync
- Active item: `border-l-2 border-l-primary` (light) / `border-l-4` (dark, for contrast)
- Mobile: `<Sheet>` offcanvas with left-edge swipe gesture
- Collapsed labels: `opacity-0` with negative margin (`-mt-8`) to maintain layout

### Breadcrumb Page Stack

File: `src/stores/navigation.ts`

Managed by `useNavigationStore` (Zustand). Tracks current view and page stack.

**View types:** `journal`, `search`, `pages`, `tags`, `trash`, `status`, `conflicts`, `history`, `page-editor`

| Method | Behavior |
|--------|----------|
| `setView(view)` | Switch sidebar view, clear stack when leaving `page-editor` |
| `navigateToPage(pageId, title, blockId?)` | Push page onto stack, switch to `page-editor` |
| `goBack()` | Pop stack, switch to `pages` if empty |
| `replacePage(pageId, title)` | Update top of stack (e.g., after title edit) |

### Journal Navigation

- 7 stacked days with "Load older days" pagination
- Previous/Next via Alt+Arrow, Today via Alt+T
- Date picker calendar (react-day-picker + Radix Popover)
- Monthly/Weekly/Daily mode switcher

### State Indicators

| Indicator | Visual |
|-----------|--------|
| Sync status | Colored dot (gray/green/yellow/red) in sidebar |
| Conflict count | Badge on sidebar item |
| Filter count | Badge on filter button |
| Loading | Skeleton placeholders + spinner |

## Quality Checklist

Before shipping any UI change, verify:

1. **Touch targets** — All interactive elements are 44px+ on `pointer: coarse` devices
2. **Keyboard navigation** — Every action reachable via keyboard, focus visible, Escape closes overlays
3. **ARIA attributes** — Roles, labels, states on all custom interactive components
4. **Screen reader** — `announce()` on state changes not visible to AT (deletions, toggles, navigation)
5. **Focus management** — Focus restored after modal/popover close, auto-focused on open
6. **Hover + active states** — Every enabled hoverable element has both `:hover` and `:active`
7. **Pointer events** — `onPointerDown` / `onPointerEnter`, never `onMouse*`
8. **Reduced motion** — CSS animations handled globally; JS animations checked manually
9. **High contrast** — Respect `prefers-contrast: more`
10. **Dark mode** — All custom colors have dark variants, overlays use `dark:bg-black/60`
11. **Responsive layout** — Test at mobile breakpoint, safe area insets, virtual keyboard
12. **Error feedback** — No silent catch blocks, specific toast messages, inline validation
13. **Empty states** — Meaningful message + CTA, differentiated by context
14. **Loading states** — Skeleton or spinner, never blank screen, `aria-busy` on containers
15. **Semantic HTML** — Buttons are `<button>`, lists are `<ul>/<li>`, forms use `<label>`
16. **Spacing consistency** — Use Tailwind utilities, design tokens, no magic numbers
17. **Blur boundaries** — New floating UI (popovers, pickers) must be added to the blur boundary check in `EditableBlock.tsx`

## Common Pitfalls

1. **`onMouseDown` instead of `onPointerDown`** — Mouse events don't fire on touch. Always use Pointer Events API. The FormattingToolbar migration (14 handlers) was a painful lesson.

2. **Missing touch target overrides** — Desktop-sized buttons (24-36px) are unusable on mobile. Every button variant has `@media(pointer: coarse)` overrides in `button.tsx`. New variants must follow the same pattern. Individual elements in `SortableBlock` (drag handle, delete, collapse, checkbox, priority) each have their own `44px` touch override.

3. **`100vh` on mobile** — Mobile browsers have dynamic chrome that makes `100vh` taller than the visible area. Use `100dvh` (dynamic viewport height).

4. **Forgetting `aria-label` on icon buttons** — Icon-only buttons have no visible text. Without `aria-label`, screen readers announce "button" with no context. Every icon button needs a label.

5. **Editor focus loss on toolbar click** — Toolbar buttons must use `onPointerDown` with `e.preventDefault()` to prevent the editor from losing focus. Without this, the toolbar becomes unusable.

6. **Hard-coded colors instead of tokens** — One-off `text-gray-500` or `bg-slate-100` values drift from the theme. Use semantic tokens (`text-muted-foreground`, `bg-secondary`) so dark mode works automatically.

7. **Hover-only interactions** — Hover doesn't exist on touch. Hover-reveal controls (delete buttons, drag handles) must have touch alternatives — either always-visible or triggered by long-press/context menu.

8. **Missing `prefers-reduced-motion` check** — The global CSS rule handles most cases, but custom `requestAnimationFrame` loops or JS-driven animations need manual checks.

9. **Layout flash on mobile** — `useIsMobile` must initialize synchronously (not via `useEffect`) to prevent a frame of desktop layout before switching to mobile.

10. **DnD activation too sensitive on mobile** — Without the 250ms delay, every scroll gesture triggers a drag. The split sensor config (distance for desktop, delay for mobile) is deliberate.

11. **Silent catch blocks** — Every `catch` must either `toast.error()` with a specific message or `console.error()` at minimum. Silent error swallowing was found in 17 handlers during the Session 18 audit.

12. **Inline confirmation instead of AlertDialog** — Custom confirmation `<div>` elements don't trap focus or handle Escape. Always use Radix `<AlertDialog>` for destructive actions.

13. **Fixed pixel widths on mobile** — Elements with `w-24` (96px) or `w-36` (144px) are too narrow for mobile inputs. Use responsive widths or min-width constraints.

14. **Scrollbar too thin on touch** — Default 10px scrollbars are hard to grab on touch. The `w-4`/`h-4` override on coarse pointer makes them usable.

15. **New floating UI breaks editor** — Any new popover, picker, or floating element must be added to the blur boundary selectors in `EditableBlock.tsx`. Without this, clicking the new UI unmounts the editor.
