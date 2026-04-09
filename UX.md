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
| State management | Zustand (8 stores) |
| Internationalization | i18next + react-i18next (`src/i18n.ts`) |
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

### Alert / Callout Tokens

File: `src/index.css`

Semantic tokens for callout blocks (tip, error, note) — replaces hardcoded Tailwind colors in `StaticBlock.tsx` CALLOUT_CONFIG. Both light and dark themes use OKLCH values.

| Token | Usage |
|-------|-------|
| `--alert-tip` / `--alert-tip-foreground` / `--alert-tip-border` | Tip callout (green) |
| `--alert-error` / `--alert-error-foreground` / `--alert-error-border` | Error callout (red) |
| `--alert-note` / `--alert-note-foreground` / `--alert-note-border` | Note callout (blue) |
| `--alert-info` / `--alert-info-foreground` / `--alert-info-border` | Info callout (blue) |

### Typography Scale

File: `src/index.css`

System-level typography tokens with paired `@utility` classes for font-size + line-height:

| Token | Size | Line-height | Utility |
|-------|------|-------------|---------|
| `--text-xs` | 0.75rem | 1.5 (`--leading-normal`) | `text-scale-xs` |
| `--text-sm` | 0.875rem | 1.5 (`--leading-normal`) | `text-scale-sm` |
| `--text-base` | 1rem | 1.5 (`--leading-normal`) | `text-scale-base` |
| `--text-lg` | 1.125rem | 1.25 (`--leading-tight`) | `text-scale-lg` |
| `--text-xl` | 1.25rem | 1.25 (`--leading-tight`) | `text-scale-xl` |
| `--text-2xl` | 1.5rem | 1.25 (`--leading-tight`) | `text-scale-2xl` |
| `--text-3xl` | 1.875rem | 1.25 (`--leading-tight`) | `text-scale-3xl` |

Responsive heading overrides at the `md` breakpoint reduce `--text-2xl` (1.5→1.25rem) and `--text-3xl` (1.875→1.5rem) on mobile.

### Animation & Transition Tokens

File: `src/index.css`

Standardized duration and easing tokens with `@utility` classes and `prefers-reduced-motion` override:

| Token | Value | Utility |
|-------|-------|---------|
| `--duration-fast` | 100ms | `duration-fast` |
| `--duration-normal` | 150ms | `duration-normal` |
| `--duration-moderate` | 200ms | `duration-moderate` |
| `--duration-slow` | 300ms | `duration-slow` |
| `--duration-slower` | 500ms | `duration-slower` |
| `--ease-out` | cubic-bezier(0.16, 1, 0.3, 1) | `ease-smooth` |
| `--ease-in-out` | cubic-bezier(0.65, 0, 0.35, 1) | `ease-smooth-in-out` |
| `--ease-spring` | cubic-bezier(0.34, 1.56, 0.64, 1) | `ease-spring` |

All durations are set to `0ms` when `prefers-reduced-motion: reduce` is active.

**Rule:** Reference these tokens in new animations. Never hardcode `200ms ease-in-out` inline when a token exists.

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

**Agent guidance:** Every new interactive element needs a `@media(pointer: coarse)` size override. Check `button.tsx` variants for the pattern. If adding inline controls (like the gutter icons in `SortableBlock`), add explicit `min-h-[44px] min-w-[44px]` on coarse pointer.

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
| Ctrl+Shift+Right | Indent block (reparent) | — |
| Ctrl+Shift+Left | Dedent block | — |
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
| `/` | Slash command menu (see full list below) |

### Slash Commands

File: `src/components/BlockTree.tsx` (`handleSlashCommand`)

| Command | Effect |
|---------|--------|
| `/TODO` / `/DOING` / `/DONE` | Set task state |
| `/date` / `/schedule` | Set scheduled date via picker |
| `/due` | Set due date via picker |
| `/priority-high` / `-medium` / `-low` | Set priority (A/B/C) |
| `/link` | Insert block link `[[` |
| `/tag` | Insert tag reference `@` |
| `/code` | Toggle code block |
| `/quote` | Toggle blockquote |
| `/table` | Insert 3x3 table with header row |
| `/query` | Insert query block `{{query ...}}` |
| `/template` | Open template picker |
| `/repeat-*` | Set repeat pattern (daily, weekly, monthly, etc.) |
| `/effort-*` | Set effort property (1-5) |
| `/assignee` | Set assignee property |
| `/location` | Set location property |
| `/h1`–`/h6` | Set heading level |
| `/strikethrough` | Toggle strikethrough |
| `/highlight` | Toggle highlight |

**Agent guidance:** Slash commands are the primary way to expose new block-level actions. To add a new one: add an entry to the commands array in `BlockTree.tsx`, handle it in `handleSlashCommand`, add i18n keys under `slash.*`, and update the command count in `BlockTree.test.tsx`.

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
| Ctrl+Shift+P | Open block properties drawer |
| Escape | Close dialog / cancel editing |

### History View Shortcuts (inside HistorySheet)

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

**Agent guidance:** When adding new floating UI (popovers, pickers, date pickers), add the CSS selector to the blur boundary checks in `EditableBlock.tsx`. Without this, clicking the new UI unmounts the editor mid-interaction.

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

Toolbar button groups are defined as config arrays in `src/lib/toolbar-config.ts` (factory functions). Use this pattern when a toolbar has many similar items — config array instead of inline JSX.

### Shared Component Inventory

Key reusable components extracted across sessions 237-299. Check these before building something new:

| Component | File | Purpose |
|-----------|------|---------|
| `FilterPill` | `ui/filter-pill.tsx` | Badge with X remove button, 44px touch targets. Used by FilterPillRow, TagFilterPanel |
| `SearchablePopover<T>` | `SearchablePopover.tsx` | Generic popover with search, loading, empty state. Replaces duplicate picker patterns |
| `StatusIcon` | `ui/status-icon.tsx` | Task state icon (DONE/DOING/TODO) with optional showDone. Used by AgendaResults, UnfinishedTasks |
| `BlockGutterControls` | `BlockGutterControls.tsx` | Gutter buttons (drag, history, delete) with Tooltip wrapping. Extracted from SortableBlock |
| `FeatureErrorBoundary` | `FeatureErrorBoundary.tsx` | Per-section error boundary with retry, `role="alert"`, i18n. Wraps each section in App.tsx |
| `ChevronToggle` | `ui/chevron-toggle.tsx` | Expand/collapse chevron with isExpanded/loading/size props. 7 consumers |
| `StatusBadge` | `ui/status-badge.tsx` | CVA badge with 5 state variants (DONE/DOING/TODO/default/overdue) |
| `PriorityBadge` | `ui/priority-badge.tsx` | CVA badge wrapping priorityColor() utility |
| `AlertListItem` | `ui/alert-list-item.tsx` | CVA li with destructive/pending variants |
| `SectionTitle` | `ui/section-title.tsx` | h4 with color/label/count props for section headers |
| `PopoverMenuItem` | `ui/popover-menu-item.tsx` | CVA button with active/disabled styling for menu items |
| `CollapsiblePanelHeader` | `CollapsiblePanelHeader.tsx` | Chevron + title + count for collapsible sections |
| `ListViewState` | (pattern) | Reusable loading/empty/loaded branching. Used by 6+ components |
| `AlertSection` | `AlertSection.tsx` | Shared overdue/upcoming section parameterized by variant |
| `RichContentRenderer` | `RichContentRenderer.tsx` | renderRichContent + CALLOUT_CONFIG, extracted from StaticBlock (846→237 lines) |
| `ImageLightbox` | `ImageLightbox.tsx` | Fullscreen Radix Dialog image viewer (90vw/90vh), Escape to close |

**Agent guidance:** Always check this table and `src/components/ui/` before building something new. If a similar pattern exists, extend the existing component rather than creating a new one.

### GraphView Patterns

File: `src/components/GraphView.tsx`

Force-directed page relationship graph using d3-force. Key UX patterns:

- **Keyboard navigation:** SVG nodes have `tabindex="0"`, `role="button"`, Enter/Space handler, focus ring via d3 stroke
- **Touch targets:** Invisible hit-area circle (`r=22`, transparent, `pointer-events: all`) behind visible node circle for 44px minimum
- **Reduced motion:** Respects `prefers-reduced-motion` — when enabled, uses `alphaDecay(1)`, `tick(300)`, renders once, stops immediately
- **Hover/active feedback:** Node radius 6→8 on hover, 5 on press, 8 on release
- **Error handling:** `console.error('[GraphView] ...')` in catch, toast.error for user feedback

### Keyboard Shortcut Customization

File: `src/lib/keyboard-config.ts`, `src/components/KeyboardSettingsTab.tsx`

All 40 shortcuts are configurable via Settings → Keyboard tab:
- `DEFAULT_SHORTCUTS` defines all shortcuts with category/key metadata
- `localStorage` persistence via `getCustomOverrides()`/`setCustomShortcut()`
- Conflict detection: `findConflicts()` shows which shortcuts share a key combo
- Per-shortcut reset + "Reset All to Defaults" with ConfirmDialog
- `KeyboardShortcuts.tsx` help panel reads from `getCurrentShortcuts()` via `useMemo([open])` for live updates

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

## Internationalization (i18n)

File: `src/i18n.ts`

Every user-visible string must go through `i18next`. ~253+ translation keys across all components.

```ts
import { useTranslation } from 'react-i18next'

const { t } = useTranslation()
t('pageBrowser.deleteSuccess')  // "Page deleted"
t('agenda.overdue')              // "Overdue"
```

**Rules:**
- Never hard-code user-visible strings. Use `t('namespace.key')`.
- Keys are namespaced by component/feature: `pageBrowser.*`, `agenda.*`, `conflict.*`, `property.*`, `search.*`, `sidebar.*`, `editor.*`, `toolbar.*`, `slash.*`, `block.*`, etc.
- Toast messages, ARIA labels, empty state text, button labels, placeholders — all go through i18n.
- When adding a new feature, add keys to `src/i18n.ts` in the English resources object. Group with existing namespaces.

**Agent guidance:** This is a non-negotiable requirement. Every user-visible string — including toast messages, ARIA labels, button text, placeholders, empty state copy, and error messages — must use `t('key')`. Hard-coded strings will be caught in review.

## Two-Tier Undo/Redo Model

The app has two independent undo systems operating at different scopes:

| Tier | Scope | Mechanism | Trigger | Boundary |
|------|-------|-----------|---------|----------|
| **In-editor** | Current block, current edit session | TipTap/ProseMirror history plugin | Ctrl+Z / Ctrl+Y inside editor | Cleared on mount via `state.reconfigure()`. Only covers typing/formatting since last focus. |
| **Page-level** | All ops on current page | Op log reverse system (`reverse.rs` computes inverse ops) | Ctrl+Z / Ctrl+Y outside editor, or undo/redo buttons in PageHeader (touch) | Per-page stack in `useUndoStore`. Cleared on page navigation. |

**How they interact:**
- When the editor is focused, Ctrl+Z triggers ProseMirror undo (in-editor tier).
- When the editor is blurred, Ctrl+Z triggers `useUndoStore.undo()` (page-level tier).
- `useUndoShortcuts.ts` also handles Ctrl+Shift+Z as alternative redo.
- Page-level undo calls `reverse.rs` which computes inverse ops from the op log, then replays them.
- Non-reversible operations: `purge_block`, `delete_attachment` — these are truly destructive.
- Touch devices: Undo2/Redo2 icon buttons in `PageHeader.tsx` provide page-level undo/redo without keyboard.

**Agent guidance:** When building features that modify blocks, ensure the operation goes through the op log (so page-level undo works automatically). If adding a new op type, verify `reverse.rs` can compute its inverse.

## Multi-Selection & Batch Operations

File: `src/stores/blocks.ts` (selection state), `src/components/BlockTree.tsx` (batch toolbar)

### Selection Mechanics

| Action | Effect |
|--------|--------|
| Ctrl+Click | Toggle individual block selection |
| Shift+Click | Range select from last-selected to clicked block |
| Ctrl+A | Select all visible blocks |
| Escape | Clear selection |

Selection state lives in `useBlockStore.selectedBlockIds` (Set). Selection is orthogonal to the roving editor — does not break the single-focus invariant.

### Batch Toolbar

Sticky floating toolbar appears when `selectedBlockIds.size > 0`:

```
┌─────────────────────────────────────────────────────┐
│ {N} selected  │ TODO │ DOING │ DONE │ Delete │  ✕  │
└─────────────────────────────────────────────────────┘
```

- `batchInProgress` state guard prevents concurrent batch operations (buttons disabled during operation).
- `handleBatchSetTodo` iterates selected blocks, calls `setTodoStateCmd`, optimistic store update.
- `handleBatchDelete` filters descendant blocks (avoid double-delete), uses AlertDialog confirmation.
- Partial failure: `toast.error()` with count of failures.
- `remove()` clears deleted block from `selectedBlockIds`. `load()` clears selection on page navigation.

**Agent guidance:** New batch actions follow the same pattern — iterate `selectedBlockIds`, guard with `batchInProgress`, show partial failure toasts.

## Optimistic Updates

File: `src/stores/blocks.ts`, `src/hooks/useBlockProperties.ts`

The store is updated immediately before the IPC call. On failure, the store reverts to the previous value and shows an error toast.

```ts
// Pattern: optimistic update with revert
const prev = get().blocks.get(id)
set(/* updated state */)
try {
  await invoke('command', args)
} catch {
  set(/* revert to prev */)
  toast.error(t('specific.error'))
}
```

Applied to: `edit()`, `remove()`, `setTodoState()`, `setPriority()`, and batch operations.

**Agent guidance:** New write operations should follow this pattern. The user should never see a loading spinner for local writes — the UI updates instantly.

## Sheet/Drawer Pattern

Several features use Radix `<Sheet>` as a slide-in panel:

| Sheet | File | Side | Trigger |
|-------|------|------|---------|
| History | `HistorySheet.tsx` | Right | Gutter clock icon / context menu "History" |
| Block properties | `BlockPropertyDrawer.tsx` | Right | Toolbar button / context menu "Properties" |
| Keyboard shortcuts | `KeyboardShortcuts.tsx` | Right | Press `?` globally |
| Mobile sidebar | `sidebar.tsx` | Left | Swipe from left edge / hamburger button |

**Conventions:**
- Sheets render content only when the trigger state is truthy (e.g., `blockId` for History).
- Close restores focus to the trigger element.
- Sheet content supports keyboard navigation and has proper ARIA labeling.
- History sheet: displays op log entries with revert-to-point capability, multi-select with Shift+Click.
- Property drawer: inline editing via Input, blur-to-save, delete per property, add from definitions popover.

## Conflict Resolution UX

File: `src/components/ConflictList.tsx`

Sync conflicts are displayed in the Conflicts sidebar view with rich, type-specific rendering:

| Conflict Type | Rendering |
|---------------|-----------|
| Text | Side-by-side "Current:" / "Incoming:" with `renderRichContent()` |
| Property | Field-by-field diffs with blue badges |
| Move | Parent/position changes with purple badges |

**Interactions:**
- **Keep** (accept current): success toast with "Undo" action (6s duration) — restores via `restoreBlock` + `editBlock`.
- **Discard** (accept incoming): success toast with "Undo" action (6s duration) — restores via `restoreBlock`.
- **Batch actions:** Checkbox per item, sticky toolbar with "Select all" / "Keep all" / "Discard all". Batch confirmation via AlertDialog.
- **Partial failure:** Toast with retry action (5s duration).
- **Device info:** Shows "From: DeviceName" (via peer ref lookup) or "This device" for local conflicts.
- **Rich content:** Uses `renderRichContent()` from `StaticBlock` with `interactive: false`.

## Inline Query Blocks

File: `src/components/QueryResult.tsx`

Blocks can contain query expressions that render live results:

```
{{query: #tag1 AND #tag2}}
{{query: property:key=value}}
```

`parseQueryExpression()` parses the expression. `QueryResult` component fetches via `queryByTags`/`queryByProperty`/`listBlocks`. Renders a collapsible panel with:
- Todo state badges, priority badges, page breadcrumbs
- Click-to-navigate to source block
- Loading / error / empty states
- Input validation: `params.target` for backlinks, `params.key` for property queries, empty expression guard.

## Block Zoom-In

File: `src/components/BlockTree.tsx`

Context menu "Zoom in" focuses the view on a single block and its descendants:
- Block tree filters to descendants only.
- Breadcrumb trail shows: `Home > Page Title > Parent Block > Current Block`.
- "Home" resets zoom to full page.
- Breadcrumb segments are clickable for intermediate navigation.

## Kebab / Overflow Menu

File: `src/components/PageHeader.tsx`

Page-level actions that don't warrant dedicated buttons go in a Popover-based kebab menu (MoreVertical icon):

| Action | Behavior |
|--------|----------|
| Save as template / Remove template | Toggles page-is-template property |
| Set journal template / Remove | Toggles journal-template property |
| Export Markdown | Copies page content to clipboard, success toast |
| Delete page | AlertDialog confirmation, then navigate back |

**Pattern:** Fetch properties on mount to determine toggle labels ("Save as template" vs "Remove template"). Actions use the standard toast feedback pattern.

## Agenda Views

### DuePanel

File: `src/components/DuePanel.tsx`

Shows blocks with due dates for a given date:
- **Overdue section** (red, `destructive/5`): blocks with `due_date < today` and not DONE. Only shown when viewing today.
- **Upcoming section** (amber): blocks due within N days (configurable via `DeadlineWarningSection`, 0-90, localStorage). Default 0 (disabled).
- **Hide-before-scheduled toggle**: localStorage-persisted toggle hides blocks with `scheduled_date > today`. Default OFF.
- **Deduplication**: Projected repeating task entries are filtered against real agenda blocks by block ID.
- Groups by todo state (DOING > TODO > DONE > Other), sorted by priority within groups.

### AgendaFilterBuilder

File: `src/components/AgendaFilterBuilder.tsx`

Dimension-based filter system with 8 dimensions: `todoState`, `priority`, `tag`, `dueDate`, `scheduledDate`, `completedDate`, `createdDate`, `property`.

- **Pill-based display**: Removable `<Badge>` chips.
- **Date presets**: "Today", "This week", "This month" for each date dimension.
- **Property dimension**: Two-step picker (key dropdown + value input). Multiple property filters allowed.
- **Group modes**: By page, by priority, by todo state, or flat.
- **Sort controls**: Dropdown with explicit default label.

## Template System UX

### Template Picker

File: `src/components/BlockTree.tsx` (slash command), `src/lib/template-utils.ts`

- `/template` slash command opens a picker with all template pages.
- `loadTemplatePagesWithPreview()` fetches first child preview per template (60-char truncation).
- Responsive positioning + `max-h-[60vh]` overflow scroll.
- "No templates" state shows step-by-step guidance.

### Dynamic Variables

File: `src/lib/template-utils.ts`

`expandTemplateVariables()` replaces placeholders on template insertion:

| Variable | Expansion |
|----------|-----------|
| `<% today %>` | Current date (YYYY-MM-DD) |
| `<% time %>` | Current time (HH:MM) |
| `<% datetime %>` | Date + time |
| `<% page title %>` | Title of the target page |

### Journal Templates

- Journal template is a page marked via property.
- `loadJournalTemplate()` returns `{ template, duplicateWarning }` — caller shows `toast.warning()` when multiple journal templates exist.

## Property Drawer

File: `src/components/BlockPropertyDrawer.tsx`

Sheet component for editing block properties:
- Loads properties + definitions on open.
- Inline editing: `<Input>` with blur-to-save (no explicit Save button).
- Delete per property with confirmation.
- `AddPropertySection`: definitions popover with search, type badges.
- Ref-type properties use a page picker (`PageResponse.items`).

## Import UX

File: `src/components/StatusPanel.tsx` (UI), `src-tauri/src/import.rs` (parser)

- File picker with multi-file support.
- Result display: blocks imported, properties found, warnings count.
- Handles Logseq-flavored Markdown (indented list items, properties, block ref stripping, tab normalization, YAML frontmatter stripping).

## Toast Action Patterns

Extended toast patterns beyond basic success/error:

| Pattern | Example | Duration |
|---------|---------|----------|
| **Undo action** | `toast.success('Resolved', { action: { label: 'Undo', onClick: revert } })` | 6s |
| **Retry action** | `toast.error('Partial failure', { action: { label: 'Retry', onClick: retry } })` | 5s |
| **Warning** | `toast.warning('Multiple journal templates found')` | default |
| **Partial failure** | `toast.error('3 of 5 blocks failed')` with retry | 5s |

**Agent guidance:** Destructive or state-changing actions that can be reversed should include an "Undo" toast action. Batch operations that may partially fail should show the failure count and a "Retry" option.

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

- Journal / Search / Pages / Tags / Settings / Trash / Status / Conflicts / History / Templates / Graph
- Active item: `border-l-2 border-l-primary` (light) / `border-l-4` (dark, for contrast)
- Mobile: `<Sheet>` offcanvas with left-edge swipe gesture
- Collapsed labels: `opacity-0` with negative margin (`-mt-8`) to maintain layout

### Breadcrumb Page Stack

File: `src/stores/navigation.ts`

Managed by `useNavigationStore` (Zustand). Tracks current view and page stack.

**View types:** `journal`, `search`, `pages`, `tags`, `settings`, `trash`, `status`, `conflicts`, `history`, `templates`, `graph`, `page-editor`

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
| Sync status | Colored dot in Status view: idle=green (`emerald-500`), syncing/discovering/pairing=amber (`amber-500`), error=red (`destructive`), offline=gray (`slate-400`) |
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
18. **i18n** — All user-visible strings use `t()` from i18next, including toasts, ARIA labels, empty states, and error messages
19. **Animation tokens** — Use `--duration-*` and `--ease-*` tokens for new animations, never hardcode durations inline

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

16. **Hard-coded user-visible strings** — All text must go through `i18next`. Add keys to `src/i18n.ts` with appropriate namespace. See the i18n section above.

17. **Missing toast feedback on destructive/state-changing actions** — Every Keep, Discard, Delete, or batch action should show a success toast. Reversible destructive actions should include an "Undo" toast action with 6s duration. Batch operations that may partially fail should show failure count with a "Retry" action.

18. **Stale selection state** — `selectedBlockIds` must be cleaned up: `remove()` clears the deleted block, `load()` clears all selections on page navigation. Batch delete must filter descendant blocks to avoid double-deleting.

19. **`flushSync` needed on editor blur** — When `handleBlur` calls `edit()` or `splitBlock()`, the store update must complete before the editor unmounts. Wrap in `flushSync()` to ensure React renders the store change synchronously. Without this, the editor disappears before the save completes. (Session 237, B-5/B-6)

20. **Position capture before async gap** — When handling input rules with async operations (e.g., `[[text]]` link resolution), capture the insertion position *before* any `await`. After the async gap, the cursor may have moved. Use `insertContentAt(savedPos, ...)` instead of relative cursor operations. (Session 229, B-6)

21. **Suggestion popup steals keyboard events** — When a suggestion popup (slash commands, tag picker, page picker) is visible, Enter/Tab/Escape/Backspace must pass through to the Suggestion plugin instead of being intercepted by the block keyboard handler's capture-phase listener. Check `isSuggestionPopupVisible()` before handling these keys. (Session 228)

22. **Re-entrancy in async handlers** — `handleDeleteBlock`, `handleEnterSave`, and similar async handlers can be invoked multiple times concurrently (double-click, rapid keyboard). Use a ref-based guard (`deleteInProgress`, `enterSaveInProgress`) with `.finally()` reset. (Sessions 228-229)

23. **`outline-none` vs `outline-hidden`** — `outline-none` conflicts with `focus-visible:outline-1`. Use `outline-hidden` instead, which properly hides the outline without conflicting with focus-visible styles. (Session 264, UX-27)

24. **Race condition in save/discard** — When `saveDraft()` and `discardDraft()` can race (e.g., interval timer fires during unmount cleanup), use a version counter. The `useDraftAutosave` hook increments a version ref on discard; the save callback checks it hasn't changed before writing. (Session 242, B-13)

25. **Map spread order in cache updates** — `new Map([...state.cache, ...fetchedData])` puts fetched data last (wins on conflict). `new Map([...fetchedData, ...state.cache])` puts cache last (stale data wins). After sync, force-refresh must put fetched data last. (Session 230, B-7)

26. **Tab key stealing browser focus navigation** — Don't bind Tab/Shift+Tab for app shortcuts (like indent/dedent). It breaks standard browser focus navigation and makes the app inaccessible to keyboard-only users. Use Ctrl+Shift+Arrow instead. (Session 234)

27. **SVG elements need explicit keyboard handling** — SVG `<circle>` and `<rect>` elements don't get keyboard events by default. Add `tabindex="0"`, `role="button"`, and explicit `keydown` handlers for Enter/Space. For touch targets, add an invisible larger circle behind the visible element. (Session 293/296)

28. **JS-driven animations ignore global reduced-motion CSS** — The global `prefers-reduced-motion` CSS rule only handles CSS animations. d3-force simulations, requestAnimationFrame loops, and other JS-driven animations must check `window.matchMedia('(prefers-reduced-motion: reduce)')` and skip or instantly complete. (Session 296, UX-104)

29. **Gutter buttons need pointer-events management** — Hover-reveal gutter buttons (`opacity-0`) still receive pointer events and block clicks on elements behind them. Add `pointer-events-none` when hidden, `pointer-events-auto` on all visibility triggers (group-hover, coarse pointer, focus-within, focus-visible). (Session 216, H-12)

30. **@floating-ui/dom for popup positioning** — Never write manual coordinate math for popup placement. Use `computePosition()` with `offset()`, `flip()`, `shift()` middleware. Replaced ~65 lines of buggy clamp/flip code in suggestion-renderer.ts. (Session 208, H-9)

31. **Missing cleanup on unmount** — Event listeners added in `useEffect` must be cleaned up on unmount. Leaked listeners cause memory leaks and stale closure bugs. (Session 207)

32. **Exhaustive useEffect dependencies** — Missing dependencies cause stale closures and subtle bugs. Fix all exhaustive-deps warnings. (Sessions 195, 200)

33. **Inline styles instead of Tailwind** — Inline `style={}` doesn't benefit from Tailwind's responsive utilities, dark mode, or design tokens. Always use Tailwind classes. (Session 202)

34. **Missing axe audits in component tests** — Every new component test should include `axe(container)` to catch accessibility regressions automatically. (Sessions 177, 195)

35. **Missing Escape handler in popovers** — All popovers and modals must close on Escape key. Radix components handle this, but custom popovers need explicit `keydown` handlers. (Session 207)

36. **Property type initialization not type-aware** — `buildInitParams()` in `property-save-utils.ts` must be used for property creation. It returns type-appropriate defaults (number→0, date→today, text/select→'', ref→null). Sending `valueText: ''` for non-text types causes silent failures. (Session 232)

37. **Tag filters using ULIDs instead of names** — User-facing filters should accept human-readable values, not internal IDs. `TagValuePicker` provides searchable autocomplete; `queryTag()` resolves names to IDs. (Session 235)

38. **Hardcoded English in test assertions** — Tests that assert on hardcoded English strings break when those strings are replaced with `t()` i18n calls. Use `t('key')` in assertions, or query by role/aria-label. (Sessions 293, 297)

## Lessons Learned

Patterns, antipatterns, and best practices discovered during 300+ sessions of development. Each lesson is grounded in specific implementation experiences with session references for traceability.

### Component Design Patterns

**1.1 Extract shared UI components immediately** (Sessions 203, 204, 210) — When multiple components need the same UI pattern, extract to a shared component immediately. Duplication leads to divergent styling, behavior, and accessibility. **Rule:** If you're copy-pasting a component pattern, extract it first.

**1.2 Collapsible sections need consistent headers** (Sessions 204, 205) — Use `CollapsiblePanelHeader` for all collapsible sections. **Rule:** Use `CollapsiblePanelHeader` for all collapsible sections.

**1.3 Config-driven components scale better than conditional branches** (Session 201) — When a component has 5+ similar items, use a config array instead of inline JSX. **Rule:** If you have 5+ similar items, use a config array.

**1.4 Touch targets must be 44px minimum on coarse pointers** (Sessions 195, 197, 202, 203) — Use `[@media(pointer:coarse)]:min-h-[44px]` on all interactive elements. **Rule:** Every button/link needs 44px touch targets.

**1.5 Responsive text sizing prevents readability issues** (Sessions 202, 223) — Don't use `text-[10px]` or `text-xs` for content on mobile. **Rule:** Never use text smaller than 12px on mobile.

**1.6 Empty states should be helpful, not silent** (Sessions 186, 198) — When a list/panel is empty, show a message explaining why. **Rule:** Every list component must have an `EmptyState` message.

**1.7 Loading states need visual feedback** (Sessions 203, 204) — Use `LoadingSkeleton` component for all async data loading. **Rule:** Use `LoadingSkeleton` for all async data loading.

**1.8 Overflow handling requires explicit CSS** (Sessions 197, 199, 202) — Long text will break layouts. Use `truncate`, `line-clamp-N`, or `flex-wrap`. **Rule:** Every text container must have explicit overflow handling.

**1.9 Choose Dialog vs Sheet vs AlertDialog vs inline panel deliberately** (Session 213) — Quick confirm = AlertDialog, complex form = Dialog, scrollable side content = Sheet, in-page content = inline panel.

**1.10 Extract hooks before components grow past 500 lines** (Sessions 237, 295, 298, 299) — Large components (BlockTree 1085→808, StaticBlock 846→237, QueryResult 452→238) were made manageable by extracting hooks. **Rule:** If a component exceeds 500 lines, audit for extractable hooks.

**1.11 Generic components replace duplicate picker patterns** (Sessions 298, 235) — `SearchablePopover<T>` replaced duplicate picker blocks. **Rule:** If you're building a searchable picker, use `SearchablePopover<T>` or extend it.

**1.12 Config-driven toolbar with factory functions** (Sessions 201, 298) — Toolbar config arrays extracted to `lib/toolbar-config.ts` factory functions. **Rule:** Toolbar-style components with 5+ similar items should use config arrays in a separate `lib/*-config.ts` file.

**1.13 Shared component inventory must be checked before building** (Sessions 237-299) — Over 16 shared UI components were extracted. Duplication was the #1 source of REVIEW-LATER maintenance items. **Rule:** Check the Shared Component Inventory table above before building any new component.

**1.14 ListViewState pattern for consistent loading/empty/loaded branching** (Session 244) — Six components had near-identical conditional rendering. **Rule:** Use the ListViewState pattern for any component that fetches and displays a list.

### Interaction Design

**2.1 Blur-to-save requires special handling with popovers** (Sessions 65, 186, 195) — Use `checkVisibility()` API to detect visibility before blur-save. **Rule:** Use `checkVisibility()` to detect visibility before blur-save.

**2.2 Delete buttons should use onPointerDown, not onClick** (Session 195) — Delete buttons in lists need to fire before focus changes. **Rule:** Delete buttons use `onPointerDown` + `onClick` fallback.

**2.3 Keyboard listeners need capture phase + stopPropagation** (Sessions 195, 207) — Priority keyboard listeners use `capture:true` + `stopPropagation`.

**2.4 Outside-click dismissal needs cleanup** (Session 207) — Outside-click listeners must have cleanup on unmount.

**2.5 Enter creates new sibling, not newline** (Session 95) — Enter = new sibling, Shift+Enter = newline.

**2.6 Empty block cleanup prevents clutter** (Session 95) — Auto-delete empty blocks created by Enter key.

**2.7 Cycling buttons should show current state** (Session 195) — Cycling buttons display current state.

**2.8 Undo actions should have toast feedback** (Session 128) — Undo actions show toast feedback with 6s duration.

**2.9 Partial failure should show retry** (Sessions 128, 131) — Partial failure toasts include retry action with 5s duration.

**2.10 Breadcrumbs should be clickable** (Sessions 205, 209) — All page breadcrumbs are clickable via `PageLink`.

**2.11 Group headers should show counts** (Sessions 209, 210) — Group headers include item counts.

**2.12 Colored pills communicate status at a glance** (Sessions 209, 210, 123) — Use consistent semantic colors from `date-property-colors.ts`.

**2.13 Popovers need max-width and responsive positioning** (Sessions 197, 198, 202) — Popovers use `max-w-[calc(100vw-2rem)]` on mobile.

**2.14 Hover states need active states on touch** (Sessions 202, 217) — All `hover:` styles get `active:` equivalents.

**2.15 Silent errors are never acceptable** (Sessions 166, 186, 198) — Never silently swallow errors.

**2.16 Suggestion popup keyboard passthrough** (Session 228) — Keyboard handlers must check for visible suggestion popups before intercepting Enter/Tab/Escape/Backspace.

**2.17 Re-entrancy guards on async handlers** (Sessions 228, 229) — All async handlers that mutate state need a ref-based re-entrancy guard with `.finally()` reset.

**2.18 Capture DOM positions before async gaps** (Session 229) — Capture insertion positions before any async operation in editor input rules.

**2.19 flushSync for editor blur saves** (Session 237) — Use `flushSync()` when blur handlers must persist state before unmount.

**2.20 @floating-ui/dom for all popup positioning** (Session 208) — Never write manual popup positioning math. Use `@floating-ui/dom`.

**2.21 Gutter buttons need pointer-events management** (Session 216) — Hidden interactive elements must have `pointer-events-none`.

### Accessibility

**3.1 Focus rings on all interactive elements** (Sessions 195, 203, 204) — All interactive elements have `focus-visible:ring-2`.

**3.2 Aria-labels required for icon-only buttons** (Sessions 195, 205, 208) — Icon-only buttons always have `aria-label`.

**3.3 Aria-pressed for toggle buttons** (Sessions 153, 223) — Toggle buttons have `aria-pressed`.

**3.4 Aria-describedby links warnings to inputs** (Session 196) — Warnings linked to inputs via `aria-describedby`.

**3.5 Announce state changes to screen readers** (Sessions 166, 195) — State changes are announced via `announce()`.

**3.6 Keyboard shortcuts should be documented** (Sessions 195, 203) — All keyboard shortcuts documented in help panel + tooltips.

**3.7 Expand/collapse buttons need dynamic aria-label** (Session 114) — Expand/collapse buttons have dynamic aria-labels.

**3.8 useListKeyboardNavigation for all navigable lists** (Sessions 215, 265) — Arrow-key navigation, Home/End, Enter selection via shared hook across 6+ components. **Rule:** All keyboard-navigable lists use `useListKeyboardNavigation` hook.

**3.9 ARIA grid pattern for calendar-like components** (Session 288) — MonthlyDayCell uses `gridcell`/`grid`/`row`/`columnheader` roles. **Rule:** Calendar/grid UIs use ARIA grid pattern.

**3.10 Skip-to-main link for keyboard navigation** (Session 265) — Sr-only anchor visible on focus, targets `#main-content`. **Rule:** App must have a skip-to-main link.

**3.11 SVG elements need explicit keyboard/touch support** (Sessions 293, 296) — SVG interactive elements need `tabindex`, `role`, keydown handlers, and invisible hit areas for touch.

**3.12 JS animations must check prefers-reduced-motion** (Session 296) — d3-force simulations must check `window.matchMedia('(prefers-reduced-motion: reduce)')`.

**3.13 outline-hidden instead of outline-none** (Session 264) — `outline-none` conflicts with `focus-visible:outline-1`. Use `outline-hidden` instead.

### Visual Design & Consistency

**4.1 Property names formatted consistently** (Session 198) — Use `formatPropertyName()` for all property name display.

**4.2 Built-in properties should have icons** (Sessions 198, 206) — Built-in properties display icons via `BUILTIN_PROPERTY_ICONS`.

**4.3 Spacing should be consistent across panels** (Sessions 206, 192) — Panels use consistent spacing.

**4.4 Use design system colors, never arbitrary** (Session 192) — Always use design system colors, never arbitrary colors.

**4.5 Date chips should have consistent styling** (Sessions 57, 93, 200) — Use `DateChip` component for all date displays.

**4.6 Semantic alert tokens for callout blocks** (Session 293) — Use `--alert-*` semantic tokens for callout/alert styling. Never hardcode Tailwind colors for stateful UI.

**4.7 Animation and transition tokens prevent inconsistency** (Session 272) — Use `--duration-*` and `--ease-*` tokens for all animations.

**4.8 Typography scale tokens ensure readable hierarchy** (Session 275) — Use typography scale tokens and responsive overrides for headings.

**4.9 Semantic color migration pattern** (Sessions 237, 243) — New colors are always semantic tokens. Hardcoded Tailwind colors are migration debt.

### Touch / Mobile

**5.1 Pointer events are better than mouse events** (Sessions 166, 195) — Use pointer events instead of mouse events.

**5.2 Coarse pointer media query for touch-specific styles** (Sessions 166, 195, 202, 203) — Touch-specific styles use `[@media(pointer:coarse)]`.

**5.3 Gutter buttons visible on touch** (Session 195) — Gutter buttons use `[@media(pointer:coarse)]:opacity-100`.

**5.4 Dialog close buttons need touch sizing** (Session 195) — Dialog close buttons have 44px touch targets.

**5.5 Form inputs should stack on mobile** (Sessions 199, 202) — Forms use `flex-col sm:flex-row` for responsive stacking.

### Performance UX

**6.1 Debounce search input** (Session 201) — Search inputs use `useDebouncedCallback` with 300ms delay.

**6.2 Lazy load heavy components** (Sessions 112, 186) — Heavy components are lazy-loaded.

**6.3 Batch queries instead of N+1** (Sessions 62, 130, 209) — Use batch queries to avoid N+1 problems.

**6.4 Skeleton loaders improve perceived performance** (Session 203) — Use `LoadingSkeleton` for all async data loading.

**6.5 Optimistic updates improve responsiveness** (Session 136) — Implement optimistic updates for mutations.

**6.6 useShallow prevents unnecessary Zustand re-renders** (Session 243) — Wrap multi-value Zustand selectors with `useShallow`.

**6.7 Ref-based callbacks prevent dependency cascade** (Session 278) — Callbacks passed to many consumers should be ref-stabilized.

**6.8 N+1 queries solved with LEFT JOIN batching** (Session 273) — Batch per-item queries into the parent query with LEFT JOINs when possible.

**6.9 Split read/write paths in background tasks** (Session 256) — Background tasks should read from read pool, only write-lock for the final mutation.

**6.10 Frontend caching for expensive views** (Session 302) — Views that fetch expensive data should cache results and show stale data while refreshing.

### State Management UX

**7.1 Selection state orthogonal to focus** (Session 133) — Selection and focus are separate store slices.

**7.2 Standard multi-select patterns** (Session 133) — Multi-select uses Ctrl+Click (toggle) and Shift+Click (range).

**7.3 Escape clears selection** (Sessions 133, 138) — Escape clears selection when not editing.

**7.4 Selection clears on page navigation** (Session 138) — Selection clears on page navigation.

**7.5 Collapse state persists in localStorage** (Session 105) — Collapse state persists in localStorage.

**7.6 Cache eviction prevents memory leaks** (Session 80) — Caches have max size with oldest-first eviction.

**7.7 Undo history clears on page navigation** (Session 80) — Undo history clears on page navigation.

**7.8 Per-page store pattern for multi-instance components** (Session 223) — When a component can render multiple instances with independent state, use per-instance stores via React context.

**7.9 Version counter prevents save/discard race conditions** (Session 242) — When save and discard can race, use a version counter to detect stale saves.

**7.10 Map spread order matters for cache updates** (Session 230) — When merging caches, ensure the freshest data is spread last.

**7.11 FeatureErrorBoundary per section** (Session 237) — Wrap each major section with FeatureErrorBoundary.

### Sync & Offline UX

**8.1 Sync state should be visible** (Sessions 146, 147) — Sync status is always visible in header.

**8.2 Offline state should be graceful** (Session 146) — App continues to work offline with local-only changes.

**8.3 Online event triggers immediate sync** (Session 146) — Online event triggers immediate sync.

**8.4 Sync timeouts should be generous** (Session 146) — Sync timeouts are 60s+ to avoid false failures.

### Error Handling UX

**9.1 Validation errors should be inline** (Sessions 104, 196) — Validation errors appear inline with `aria-describedby`.

**9.2 Backend errors should surface to user** (Session 104) — Backend errors surface to user.

**9.3 Error recovery should be automatic when possible** (Session 249) — Implement automatic error recovery when possible.

### Key Principles

1. **Consistency** — Use shared components, design system colors, and consistent spacing everywhere. Check the Shared Component Inventory before building.
2. **Mobile-first** — Always consider touch users. Use `[@media(pointer:coarse)]` for touch-specific styles. 44px minimum touch targets.
3. **Accessibility** — Add aria-labels, focus rings, and semantic HTML. Test with axe. Use `useListKeyboardNavigation` for navigable lists. Check `prefers-reduced-motion` for JS animations.
4. **Feedback** — Show loading states, error messages, and confirmation dialogs. Never silently fail. Toast with undo for reversible destructive actions.
5. **Performance** — Debounce search, lazy-load, batch queries, use `useShallow`, ref-stabilize callbacks. Cache expensive views.
6. **User control** — Let users undo, clear selections, and navigate easily. Keyboard shortcut customization.
7. **Graceful degradation** — App works offline, handles errors gracefully via FeatureErrorBoundary, provides fallbacks.
8. **Extract early** — If a component exceeds 500 lines, extract hooks. If a pattern repeats twice, extract a shared component. Config arrays for toolbars.
9. **Token-first** — Colors, durations, easings, typography all go through CSS custom properties. Never hardcode values that have tokens.
10. **Guard concurrent operations** — Re-entrancy guards on async handlers, version counters for race conditions, position capture before async gaps.
