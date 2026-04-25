# UX Baseline — Agaric App

Reference for building UI in this project. Pair with `AGENTS.md` (§ Frontend Development Guidelines) which defines the component hierarchy and mandatory patterns.

## Overview

| Concern | Approach |
| ------- | -------- |
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

All colors are defined as CSS custom properties in OKLCH. Light and dark themes share the same semantic names — never hard-code hex/rgb values.

**Base tokens:**

| Token | Light | Dark | Usage |
| ------- | ------- | ------ | ------- |
| `--background` | white | dark blue-gray | Page background |
| `--foreground` | dark blue-gray | off-white | Body text |
| `--primary` | warm orange | same | Links, active states, primary actions |
| `--secondary` | light gray | medium dark gray | Secondary surfaces |
| `--accent` | light warm tint | — | Hover highlights, tag chips |
| `--destructive` | red | — | Delete, purge, error states |
| `--muted` | light gray | medium dark gray | Disabled text, placeholders |
| `--border` | very light gray | medium dark gray | Borders, separators |
| `--sidebar` | off-white | — | Sidebar background |

**Semantic tokens** (prefer these over raw colors — full list in `src/index.css`):

| Category | Tokens (each usually with `-foreground` pair) | Usage |
| ---------- | ----------------------------------------------- | ------- |
| Status | `--status-active`, `--status-done`, `--status-pending` | List items / row state |
| Task | `--task-doing`, `--task-done`, `--task-custom` | TODO-state checkbox fills |
| Priority | `--priority-urgent`, `--priority-high`, `--priority-normal`, `--priority-foreground` | Priority badges (see below) |
| Conflict | `--conflict-text`, `--conflict-move` (+ foreground) | Conflict copies, three-way merge UI |
| Operation type | `--op-create`, `--op-edit`, `--op-move`, `--op-tag` | History/timeline entries |
| Date source | `--date-due`, `--date-scheduled`, `--date-property` | Agenda item date badges |
| Alert | `--alert-tip`, `--alert-error`, `--alert-note`, `--alert-info`, `--alert-warning` (+ `-foreground`, `-border`) | Callout blocks |
| Indicator | `--indicator-repeat`, `--indicator-scheduled` | Inline icons/markers |
| Misc | `--block-ref-foreground` | Inline block-ref tokens |

**Rule:** Reference tokens via `var(--primary)`, `bg-primary`, `text-destructive`, etc. Never hardcode Tailwind color classes (`bg-red-100`, `text-amber-600`) when a semantic token exists.

### Priority Badge Colors

Files: `src/lib/priority-color.ts`, `src/components/ui/priority-badge.tsx`. Semantic tokens defined in `src/index.css`.

Priority badges use semantic tokens (NOT hardcoded Tailwind colors). Use `priorityColor(p)` or the `PriorityBadge` CVA variant — never inline `bg-red-100` etc.

**Levels are user-configurable** (UX-201b): the `priority` property definition's `options` JSON drives the active cycle. The defaults below are what ships in the seed database; users can reconfigure via Properties → `priority`. The `priorityColor()` utility and `PriorityBadge` variants key off `priorityRank()` (active levels first in order, unknown last), so custom levels inherit a sensible colour without code changes.

| Priority | Token class | Semantic token | Colorblind-safe cue |
| ---------- | ------------- | ----------------- | --------------------- |
| 1 (Urgent / A) | `bg-priority-urgent text-priority-foreground` | `--priority-urgent` | (add ring in contexts where higher emphasis needed) |
| 2 (High / B) | `bg-priority-high text-priority-foreground` | `--priority-high` | — |
| 3 (Normal / C) | `bg-priority-normal text-priority-foreground` | `--priority-normal` | (add dashed border in contexts where lower emphasis needed) |

### Task Checkbox Colors

File: `src/components/BlockInlineControls.tsx` (`TASK_CHECKBOX_STYLES`)

Task checkboxes use semantic tokens (`task-todo`, `task-doing`, `task-cancelled`, `task-done`) — never hardcoded Tailwind colors. The cycle is locked to `none → TODO → DOING → DONE → CANCELLED → none` (UX-201a, reordered by UX-234).

| State | Visual |
| ------- | -------- |
| TODO | Empty square — `border-2 border-muted-foreground` |
| DOING | Blue dot — `border-task-doing bg-task-doing/20` + inner dot in `bg-task-doing` |
| CANCELLED | Muted X — `border-task-cancelled bg-task-cancelled/20` + `X` glyph in `text-task-cancelled` (block gets `line-through opacity-50`) |
| DONE | Green check — `border-task-done bg-task-done` + white check glyph (block gets `line-through opacity-50`) |

### Alert / Callout Tokens

File: `src/index.css`

Semantic tokens for callout blocks (tip, error, note) — replaces hardcoded Tailwind colors in `StaticBlock.tsx` CALLOUT_CONFIG. Both light and dark themes use OKLCH values.

| Token | Usage |
| ------- | ------- |
| `--alert-tip` / `--alert-tip-foreground` / `--alert-tip-border` | Tip callout (green) |
| `--alert-error` / `--alert-error-foreground` / `--alert-error-border` | Error callout (red) |
| `--alert-note` / `--alert-note-foreground` / `--alert-note-border` | Note callout (blue) |
| `--alert-info` / `--alert-info-foreground` / `--alert-info-border` | Info callout (blue) |

### Typography Scale

File: `src/index.css`

System-level typography tokens with paired `@utility` classes for font-size + line-height:

| Token | Size | Line-height | Utility |
| ------- | ------ | ------------- | --------- |
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
| ------- | ------- | --------- |
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
| ------- | ------- | ---------- |
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
| ------ | --------- |
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
| ---------- | ------- |
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
| ----------- | --------- | ------------------------ |
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
- **Hover-reveal controls:** `opacity-0 → opacity-100` on group hover (desktop). Always visible on touch devices — **except** block gutter controls (drag handle, history, delete), which remain hover/focus-reveal on touch to preserve screen real estate. Mobile users access these actions via long-press context menu or block-active state instead.

### Drag & Drop Sensors

File: `src/hooks/useBlockDnD.ts`

| Context | Sensor | Configuration |
| --------- | -------- | --------------- |
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

- **Persistent icon rail:** 48 px wide, icons only, always visible at widths `< 768 px` when `<Sidebar collapsible="icon">` is used. Tapping a nav item navigates; tapping the hamburger `SidebarTrigger` (or swiping from the left edge, or pressing `Ctrl+B`) opens the full expanded sidebar as a Sheet overlaid on the content.
- **Touch targets:** 44 px via `[@media(pointer:coarse)]:group-data-[collapsible=icon]:size-11!` on `SidebarMenuButton`. The rail strips `SidebarGroup`'s horizontal padding (`group-data-[mobile-rail=true]:px-0`) so the full 48-px rail width is available, and the 44-px button fits without any overflow / paint-vs-hit-area trade-off.
- **ARIA:** the rail wrapper is a semantic `<nav>` element (implicit `role="navigation"`) carrying `aria-label={t('sidebar.label')}` so assistive tech announces the landmark.
- **Swipe-to-open:** Left-edge swipe gesture (20 px edge zone, 50 px minimum distance) — Android navigation drawer pattern.
- **Component:** `<Sheet>` offcanvas for the expanded state; the persistent icon rail is a separate fixed-position container rendered alongside the Sheet. `<Sidebar collapsible="offcanvas">` (the shadcn default) keeps the original Sheet-only behaviour — no rail — so other consumers of the primitive are unaffected.
- **Rail vs. `SidebarRail`:** the narrow always-on rail on mobile is not the same primitive as `SidebarRail` (the desktop resize handle, `sm:flex` — desktop-only). They solve different problems and coexist; do not conflate them.

### Mobile-Specific Layout

| Pattern | Implementation |
| --------- | --------------- |
| Date picker | Desktop: centered at 1/3 height. Mobile (`max-[479px]`): full-width with padding, 70vh max height, scrollable |
| Calendar popup | `max-[479px]` responsive breakpoint with scroll |
| Sidebar width | `min(18rem, 85vw)` clamping |

## Keyboard Navigation

### Block Editing Shortcuts

File: `src/editor/use-block-keyboard.ts`

| Shortcut | Action | Condition |
| ---------- | -------- | ----------- |
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
| Ctrl+Enter | Cycle task state (TODO → DOING → DONE → CANCELLED → none) | — |
| Ctrl+. | Toggle collapse/expand children | Block has children |

### Formatting Shortcuts

Files: `src/editor/use-roving-editor.ts` (priority + heading shortcuts), TipTap built-ins (text formatting).

These shortcuts fire when a block editor has focus. The text-formatting ones (Ctrl+B/I/E/K and Ctrl+Shift+C/X/H) are TipTap defaults; the priority, heading, and date shortcuts are wired via `src/lib/keyboard-config.ts`.

| Shortcut | Action |
| ---------- | -------- |
| Ctrl+B | Bold (in editor) — **note:** global `Ctrl+B` toggles the sidebar when no editor is focused |
| Ctrl+I | Italic |
| Ctrl+E | Inline code |
| Ctrl+K | Insert/edit external link |
| Ctrl+Shift+C | Toggle code block |
| Ctrl+Shift+X | Toggle strikethrough |
| Ctrl+Shift+H | Toggle highlight |
| Ctrl+1 … Ctrl+6 | Set heading level 1 … 6 |
| Ctrl+Shift+1 | Set priority 1 (high) — default levels; user-configurable via `priority` property definition (UX-201b) |
| Ctrl+Shift+2 | Set priority 2 (medium) |
| Ctrl+Shift+3 | Set priority 3 (low) |
| Ctrl+Shift+D | Open date picker for the focused block |

### Picker Triggers

| Trigger | Opens |
| --------- | ------- |
| `@` | Tag picker (fuzzy search tags) |
| `[[` | Block link picker (fuzzy search pages) |
| `/` | Slash command menu (see full list below) |

### Slash Commands

File: `src/components/BlockTree.tsx` (`handleSlashCommand`)

| Command | Effect |
| --------- | -------- |
| `/TODO` / `/DOING` / `/CANCELLED` / `/DONE` | Set task state (locked cycle — UX-201a, reordered by UX-234) |
| `/date` / `/schedule` | Set scheduled date via picker |
| `/due` | Set due date via picker |
| `/priority-high` / `-medium` / `-low` | Set priority (default levels 1/2/3, user-configurable via property definitions — UX-201b) |
| `/link` | Insert block link `[[` |
| `/tag` | Insert tag reference `@` |
| `/code` | Toggle code block |
| `/quote` | Toggle blockquote |
| `/callout` | Insert callout block — submenu picks variant (`info` / `warning` / `tip` / `error` / `note`) |
| `/table` | Insert 3×3 table with header row (or `/table NxM` for specific dimensions) |
| `/numbered-list` | Insert ordered list |
| `/divider` | Insert horizontal rule |
| `/query` | Insert query block `{{query …}}` |
| `/template` | Open template picker |
| `/repeat-*` | Set repeat pattern (daily, weekly, monthly, yearly, `.+` from completion, `++` catch-up, `repeat-remove`, `repeat-until`, `repeat-limit-N`) |
| `/effort-*` | Set effort property (`15m` / `30m` / `1h` / `2h` / `4h` / `1d`) |
| `/assignee` | Set assignee property (`me` or custom…) |
| `/location` | Set location property (`office` / `home` / `remote` / custom…) |
| `/attach` | Attach file to block |
| `/h1`–`/h6` | Set heading level |

**Agent guidance:** Slash commands are the primary way to expose new block-level actions. To add a new one: add an entry to the commands array in `BlockTree.tsx`, handle it in `handleSlashCommand`, add i18n keys under `slash.*`, and update the command count in `BlockTree.test.tsx`.

### Global Shortcuts

File: `src/App.tsx` (global keydown handler), `src/components/ui/sidebar.tsx` (Ctrl+B)

| Shortcut | Action |
| ---------- | -------- |
| Ctrl+F | Focus search |
| Ctrl+N | Create new page |
| Ctrl+B | Toggle sidebar (when no editor is focused — inside a focused editor, `Ctrl+B` is Bold) |
| ? | Show keyboard shortcuts panel |
| Alt+Left | Previous day/week/month (journal) |
| Alt+Right | Next day/week/month (journal) |
| Alt+T | Go to today (journal) |
| Ctrl+Z | Undo (page-level, outside editor) |
| Ctrl+Y | Redo (page-level, outside editor) |
| Ctrl+Shift+D | Open date picker for the focused block |
| Ctrl+Shift+P | Open block properties drawer |
| Escape | Close all overlays (UX-228 — dispatches `CLOSE_ALL_OVERLAYS_EVENT`, closes `KeyboardShortcuts`, `WelcomeModal`, and Radix dialogs/popovers) when pressed outside contentEditable / `INPUT` / `TEXTAREA`; inside the editor, cancels editing / clears selection / zooms out depending on context |

### History View Shortcuts (inside HistorySheet)

File: `src/components/KeyboardShortcuts.tsx`

| Shortcut | Action |
| ---------- | -------- |
| Space | Toggle selection |
| Shift+Click | Range select (UX-140 — `useListMultiSelect.ts:76-102` walks `items` from `lastClickedId` to clicked id, applying `targetState` to every selectable item in range) |
| Ctrl+A | Select all |
| Enter | Revert selected |
| Escape | Clear selection |
| Arrow Up / Down | Navigate items |
| Page Up / Page Down | Jump by page (`useListKeyboardNavigation` `pageUpDown: true`, default jump = 10 items, clamped at list boundaries — never wraps) |
| j / k | Navigate items (vim-style) |

**Cursor-based pagination contract** (`HistoryView.tsx:70-88`): the list is paged via `listPageHistory({ pageId: '__all__', cursor, limit: 50 })`. The hook (`usePaginatedQuery`) returns `{ items, loading, hasMore, error, loadMore, reload, setItems }` — every call after the first passes the `next_cursor` returned by the previous response. Never replace this with offset pagination (root AGENTS.md Invariant #3).

### Suggestion List Navigation

File: `src/editor/SuggestionList.tsx`

| Key | Action |
| ----- | -------- |
| Arrow Down | Next item (wraps to start) |
| Arrow Up | Previous item (wraps to end) |
| Enter | Select current item |
| Escape | Close list |

Selected items auto-scroll into view via `scrollIntoView({ block: 'nearest' })`.

### Context Menu Navigation

File: `src/components/BlockContextMenu.tsx`

| Key | Action |
| ----- | -------- |
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
| ---------- | ---------- |
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
| ------------- | -------- |
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
| ----------- | ------- | ------ | ---------- |
| AlertDialog overlay | `fade-in-0` | `fade-out-0` | 200ms |
| AlertDialog content | `fade-in-0 zoom-in-95` | `fade-out-0 zoom-out-95` | 200ms |
| Sheet overlay | `fade-in-0` | `fade-out-0` | 300ms close / 500ms open |
| Sheet content | `slide-in-from-{side}` | `slide-out-to-{side}` | 300ms close / 500ms open |
| Popover | `fade-in-0 zoom-in-95` | `fade-out-0 zoom-out-95` | — |
| Tooltip | `fade-in-0 zoom-in-95` | `fade-out-0 zoom-out-95` | — |
| Context menu | `fade-in-0 zoom-in-95` | — | — |

### Micro-Interactions

| Element | Interaction | Effect |
| --------- | ------------- | -------- |
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
| ------- | --------- | ------- |
| Primary action | `variant="outline" size="sm"` | Create, Save, Apply |
| Utility | `variant="ghost" size="xs"` | Secondary controls, toggles |
| Hover-reveal | `variant="ghost" size="icon-xs"` | Delete, close, inline actions |

Destructive buttons use `variant="destructive"` — reserved for purge, permanent delete, discard.

### Icon System

**Library:** Lucide React (`lucide-react`). Single icon library — never import from other packages.

#### Semantic icon mapping

Each user action has exactly one icon. Do not deviate.

| Action | Icon | Notes |
| -------- | ------ | ------- |
| Delete / trash | `Trash2` | Permanent-feeling removal (blocks, pages, tags, attachments, properties definitions) |
| Remove / close / dismiss / clear | `X` | Lightweight removal: close tabs, dismiss errors, remove chips/filters/aliases/tags, clear search, discard conflicts |
| Add / create / new | `Plus` | New page, new block, add tag, add filter, add property, add option |
| Edit / rename | `Pencil` | Edit shortcuts, rename tags/peers, edit query, edit options |
| Search | `Search` | Search inputs across all views |
| Filter trigger | `Filter` | Open/toggle filter panel (AgendaFilter, BacklinkFilter, SourcePageFilter) |
| Filter adjust | `SlidersHorizontal` | Toggle advanced filter options (LinkedReferences) |
| Configure | `Settings2` | Property definition options, block properties drawer |
| Undo | `Undo2` | Page-level undo (edit history navigation) |
| Redo | `Redo2` | Page-level redo |
| Restore / revert | `RotateCcw` | Point-in-time restoration: trash restore, history revert |
| Sync / refresh | `RefreshCw` | Device sync, conflict refresh (often with `animate-spin`) |
| Expand / collapse | `ChevronToggle` | Use the shared component, not raw `ChevronDown`/`ChevronRight` |
| Sort | `ArrowUpDown` | Sort controls in filter/agenda toolbars |
| Favorite | `Star` | Page star toggle (`fill="currentColor"` when active) |
| External link | `ExternalLink` | "View original", "open in new tab" style actions |
| Drag handle | `GripVertical` | Block reordering drag handle |
| History | `Clock` | Block/page history views and gutter button |
| Task DONE status | `CheckCircle2` | Status indicator display |
| Task DOING status | `Clock` | Status indicator display (with `text-task-doing` color) |
| TODO cycle | `CheckSquare` | Context menu action to cycle TODO state |
| Confirm / keep | `Check` | Checkbox done state, confirm edits, keep conflict |

#### Icon sizing by context

Icons inherit their size from the button's `[&_svg]:size-[1.2em]` rule when inside a `<Button>`. Only set explicit size classes when the icon is outside a Button or needs to override the default.

When explicit sizing is needed, use these conventions:

| Context | Size class | When |
| --------- | ------------ | ------ |
| Inline/compact (property editor, filter pills, breadcrumbs) | `h-3 w-3` | Icons inside `size="xs"` or `size="icon-xs"` buttons, or inline text |
| Toolbar / action buttons | `h-3.5 w-3.5` | Icons inside `size="sm"` or `size="icon-sm"` buttons, context menu items |
| Headers / standalone | `h-4 w-4` | Search input prefixes, page header icons, gutter controls, status icons, card title icons |

Pick the size that matches the button context. The same icon (e.g., `Plus`) will be different sizes in different contexts — that is correct. What matters is consistency within a context: all icons in the same toolbar should be the same size.

#### When to use icons on buttons

Not every button needs an icon. Follow these rules:

- **Icon-only buttons** (e.g., gutter controls, header actions): Always. Must have `aria-label` and a `<Tooltip>`.
- **Context menus / dropdown menus**: Always. Every menu item gets an icon for scannability.
- **Sidebar navigation**: Always. Icon + text label.
- **Toolbar buttons**: Always. Icon-only with tooltip, or icon + short label.
- **Batch action buttons with semantic meaning** (Keep, Discard, Restore, Purge, Delete): Always. Icon + text.
- **"Clear all" / "Clear selection" buttons**: Always use `X` icon + text for consistency.
- **Dialog footer buttons** (Cancel / Save / Confirm): Text-only. Standard dialog convention — the label is self-evident.
- **Date quick-picks** (Today, Tomorrow, Next week): Text-only. Short labels in compact popovers.
- **Heading level selectors** (H1-H6): Text-only. The text IS the visual representation.
- **Image resize presets** (25%, 50%, 75%): Text-only. Numeric values are clearer than icons.
- **Error recovery buttons** (Retry, Reload): Icon (`RefreshCw`) + text. Consistent across all error boundaries.

#### Anti-patterns

- Importing icons from libraries other than `lucide-react`.
- Using `Trash2` and `X` interchangeably — `Trash2` is for permanent deletion, `X` is for lightweight removal/dismissal.
- Using raw `ChevronDown` with manual rotation instead of the shared `ChevronToggle` component.
- Using different sizes for the same icon within the same component (e.g., two `Pencil` icons at `h-3` and `h-3.5` in the same file).
- Adding icons to dialog footer buttons (Cancel/Save) or date quick-pick buttons.
- Icon-only buttons without `aria-label` and `<Tooltip>`.

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

Key reusable components. Check these before building something new:

| Component | File | Purpose |
| ----------- | ------ | --------- |
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
| ------- | --------- | -------- | ------------- |
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
- **`announce()` calls must use i18n.** Screen reader announcements via `announce()` are user-facing text and must use `t()` keys, not hardcoded English strings.
- **Class components use `i18n.t()` directly.** Error boundaries are class components and cannot use `useTranslation()`. Import `i18n` from `@/lib/i18n` and call `i18n.t('key')`. FeatureErrorBoundary demonstrates this pattern.

**Agent guidance:** This is a non-negotiable requirement. Every user-visible string — including toast messages, ARIA labels, button text, placeholders, empty state copy, error messages, and `announce()` calls — must use `t('key')`. Hard-coded strings will be caught in review.

## Two-Tier Undo/Redo Model

The app has two independent undo systems operating at different scopes:

| Tier | Scope | Mechanism | Trigger | Boundary |
| ------ | ------- | ----------- | --------- | ---------- |
| **In-editor** | Current block, current edit session | TipTap/ProseMirror history plugin | Ctrl+Z / Ctrl+Y inside editor | Cleared on mount via `state.reconfigure()`. Only covers typing/formatting since last focus. |
| **Page-level** | All ops on current page | Op log reverse system (`reverse.rs` computes inverse ops) | Ctrl+Z / Ctrl+Y outside editor, or undo/redo buttons in PageHeader (touch) | Per-page stack in `useUndoStore`. Cleared on page navigation. |

**How they interact:**

- When the editor is focused, Ctrl+Z triggers ProseMirror undo (in-editor tier).
- When the editor is blurred, Ctrl+Z triggers `useUndoStore.undo()` (page-level tier).
- `useUndoShortcuts.ts` also handles Ctrl+Shift+Z as alternative redo.
- Page-level undo calls `reverse.rs` which computes inverse ops from the op log, then replays them.
- Non-reversible operations: `purge_block`, `delete_attachment` — these are truly destructive.
- Touch devices: Undo2/Redo2 icon buttons in `PageHeader.tsx` provide page-level undo/redo without keyboard.

**Page-level undo store constants** (`src/stores/undo.ts`):

- `UNDO_GROUP_WINDOW_MS = 500` (`undo.ts`) — consecutive ops within 500 ms by the same device are grouped, so a single Ctrl+Z undoes the entire batch (e.g., recurrence ops triggered by `set_todo_state`). Same window is used by the backend `revert_ops` ordering. Bumped from 200 ms in MAINT-105 to give recurrence-op bursts headroom under load (slow disk, network) without breaking everyday typing-pace grouping.
- `MAX_REDO_STACK = 100` (`undo.ts`) — per-page redo stack is capped at 100 entries; older entries are dropped on push (`redoStack.slice(0, MAX_REDO_STACK)`).

**Agent guidance:** When building features that modify blocks, ensure the operation goes through the op log (so page-level undo works automatically). If adding a new op type, verify `reverse.rs` can compute its inverse. If you need to change the grouping window or redo stack depth, update these named constants — never hardcode `500` / `100` at call sites.

## Multi-Selection & Batch Operations

File: `src/stores/blocks.ts` (selection state), `src/components/BlockTree.tsx` (batch toolbar)

### Selection Mechanics

| Action | Effect |
| -------- | -------- |
| Ctrl+Click | Toggle individual block selection |
| Shift+Click | Range select from last-selected to clicked block |
| Ctrl+A | Select all visible blocks |
| Escape | Clear selection |

Selection state lives in `useBlockStore.selectedBlockIds` (Set). Selection is orthogonal to the roving editor — does not break the single-focus invariant.

### Batch Toolbar

Sticky floating toolbar appears when `selectedBlockIds.size > 0`:

```text
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
| ------- | ------ | ------ | --------- |
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
| --------------- | ----------- |
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

```text
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
| -------- | ---------- |
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
| ---------- | ----------- |
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
- `AddPropertyPopover` (`src/components/AddPropertyPopover.tsx`): definitions popover with search, type badges.
- Ref-type properties use a page picker (`PageResponse.items`).

**Focus management:**

- Focus is trapped inside the drawer while open (Radix `Sheet` primitive).
- Tab / Shift+Tab cycle through focusable elements within the drawer; focus does not escape to the underlying page.
- Esc closes the drawer (Radix dismiss behaviour).
- On close, focus is restored to the element that opened the drawer (typically the gutter "properties" / kebab-menu trigger).

## Import UX

File: `src/components/StatusPanel.tsx` (UI), `src-tauri/src/import.rs` (parser)

- File picker with multi-file support.
- Result display: blocks imported, properties found, warnings count.
- Handles Logseq-flavored Markdown (indented list items, properties, block ref stripping, tab normalization, YAML frontmatter stripping).

## Toast Action Patterns

Extended toast patterns beyond basic success/error:

| Pattern | Example | Duration |
| --------- | --------- | ---------- |
| **Operation feedback (no action)** | `toast(t('undo.undoneMessage'), { duration: 1500 })` | 1500 ms |
| **Undo action** | `toast.success('Resolved', { action: { label: 'Undo', onClick: revert } })` | 6 s |
| **Retry action** | `toast.error('Partial failure', { action: { label: 'Retry', onClick: retry } })` | 5 s |
| **Warning** | `toast.warning('Multiple journal templates found')` | default |
| **Partial failure** | `toast.error('3 of 5 blocks failed')` with retry | 5 s |

**Two distinct duration patterns:**

- **1500 ms — operation feedback toasts.** No action button. Used to confirm a completed action the user already initiated (e.g., the "Undone" / "Redone" toasts emitted by `useUndoShortcuts.ts:71,93` after Ctrl+Z / Ctrl+Y). Short enough to acknowledge without lingering.
- **6 s — toasts that carry an Undo button.** The longer duration is required because the user must have time to read the message and decide whether to click Undo. Never apply a 1500 ms duration to a toast with an action — the button vanishes before it can be used.

**Agent guidance:** Destructive or state-changing actions that can be reversed should include an "Undo" toast action with the 6 s duration. Batch operations that may partially fail should show the failure count and a "Retry" option. Operation feedback (e.g., "Undone", "Saved") with no action button uses the 1500 ms duration.

## Editor UX

### Roving Editor Pattern

File: `src/editor/use-roving-editor.ts`

One TipTap instance at all times. Non-focused blocks render as static divs via `StaticBlock` (`src/components/StaticBlock.tsx`).

| Phase | What happens |
| ------- | ------------- |
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
| --------- | ------- |
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
| -------- | ---------- |
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
| ----------- | -------- |
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

7. **Hover-only interactions** — Hover doesn't exist on touch. Hover-reveal controls (delete buttons, drag handles) must have touch alternatives — either always-visible or triggered by long-press/context menu. **Exception:** Block gutter controls (`BlockGutterControls`) intentionally omit `[@media(pointer:coarse)]:opacity-100` — screen real estate on mobile is too valuable for always-visible gutter buttons. These are accessible via long-press context menu, block-active state, and focus-within.

8. **Missing `prefers-reduced-motion` check** — The global CSS rule handles most cases, but custom `requestAnimationFrame` loops or JS-driven animations need manual checks.

9. **Layout flash on mobile** — `useIsMobile` must initialize synchronously (not via `useEffect`) to prevent a frame of desktop layout before switching to mobile.

10. **DnD activation too sensitive on mobile** — Without the 250ms delay, every scroll gesture triggers a drag. The split sensor config (distance for desktop, delay for mobile) is deliberate.

11. **Silent catch blocks** — Every `catch` must either `toast.error()` with a specific message or `console.error()` at minimum. Silent error swallowing was found in 17 handlers.

12. **Inline confirmation instead of AlertDialog** — Custom confirmation `<div>` elements don't trap focus or handle Escape. Always use Radix `<AlertDialog>` for destructive actions.

13. **Fixed pixel widths on mobile** — Elements with `w-24` (96px) or `w-36` (144px) are too narrow for mobile inputs. Use responsive widths or min-width constraints.

14. **Scrollbar too thin on touch** — Default 10px scrollbars are hard to grab on touch. The `w-4`/`h-4` override on coarse pointer makes them usable.

15. **New floating UI breaks editor** — Any new popover, picker, or floating element must be added to the blur boundary selectors in `EditableBlock.tsx`. Without this, clicking the new UI unmounts the editor.

16. **Hard-coded user-visible strings** — All text must go through `i18next`. Add keys to `src/i18n.ts` with appropriate namespace. See the i18n section above.

17. **Missing toast feedback on destructive/state-changing actions** — Every Keep, Discard, Delete, or batch action should show a success toast. Reversible destructive actions should include an "Undo" toast action with 6s duration. Batch operations that may partially fail should show failure count with a "Retry" action.

18. **Stale selection state** — `selectedBlockIds` must be cleaned up: `remove()` clears the deleted block, `load()` clears all selections on page navigation. Batch delete must filter descendant blocks to avoid double-deleting.

19. **`flushSync` needed on editor blur** — When `handleBlur` calls `edit()` or `splitBlock()`, the store update must complete before the editor unmounts. Wrap in `flushSync()` to ensure React renders the store change synchronously. Without this, the editor disappears before the save completes.

20. **Position capture before async gap** — When handling input rules with async operations (e.g., `[[text]]` link resolution), capture the insertion position *before* any `await`. After the async gap, the cursor may have moved. Use `insertContentAt(savedPos, ...)` instead of relative cursor operations.

21. **Suggestion popup steals keyboard events** — When a suggestion popup (slash commands, tag picker, page picker) is visible, Enter/Tab/Escape/Backspace must pass through to the Suggestion plugin instead of being intercepted by the block keyboard handler's capture-phase listener. Check `isSuggestionPopupVisible()` before handling these keys.

22. **Re-entrancy in async handlers** — `handleDeleteBlock`, `handleEnterSave`, and similar async handlers can be invoked multiple times concurrently (double-click, rapid keyboard). Use a ref-based guard (`deleteInProgress`, `enterSaveInProgress`) with `.finally()` reset.

23. **`outline-none` vs `outline-hidden`** — `outline-none` conflicts with `focus-visible:outline-1`. Use `outline-hidden` instead, which properly hides the outline without conflicting with focus-visible styles.

24. **Race condition in save/discard** — When `saveDraft()` and `discardDraft()` can race (e.g., interval timer fires during unmount cleanup), use a version counter. The `useDraftAutosave` hook increments a version ref on discard; the save callback checks it hasn't changed before writing.

25. **Map spread order in cache updates** — `new Map([...state.cache, ...fetchedData])` puts fetched data last (wins on conflict). `new Map([...fetchedData, ...state.cache])` puts cache last (stale data wins). After sync, force-refresh must put fetched data last.

26. **Tab key stealing browser focus navigation** — Don't bind Tab/Shift+Tab for app shortcuts (like indent/dedent). It breaks standard browser focus navigation and makes the app inaccessible to keyboard-only users. Use Ctrl+Shift+Arrow instead.

27. **SVG elements need explicit keyboard handling** — SVG `<circle>` and `<rect>` elements don't get keyboard events by default. Add `tabindex="0"`, `role="button"`, and explicit `keydown` handlers for Enter/Space. For touch targets, add an invisible larger circle behind the visible element.

28. **JS-driven animations ignore global reduced-motion CSS** — The global `prefers-reduced-motion` CSS rule only handles CSS animations. d3-force simulations, requestAnimationFrame loops, and other JS-driven animations must check `window.matchMedia('(prefers-reduced-motion: reduce)')` and skip or instantly complete.

29. **Gutter buttons need pointer-events management** — Hover-reveal gutter buttons (`opacity-0`) still receive pointer events and block clicks on elements behind them. Add `pointer-events-none` when hidden, `pointer-events-auto` on all visibility triggers (group-hover, coarse pointer, focus-within, focus-visible).

30. **@floating-ui/dom for popup positioning** — Never write manual coordinate math for popup placement. Use `computePosition()` with `offset()`, `flip()`, `shift()` middleware. Replaced ~65 lines of buggy clamp/flip code in suggestion-renderer.ts.

31. **Missing cleanup on unmount** — Event listeners added in `useEffect` must be cleaned up on unmount. Leaked listeners cause memory leaks and stale closure bugs.

32. **Exhaustive useEffect dependencies** — Missing dependencies cause stale closures and subtle bugs. Fix all exhaustive-deps warnings.

33. **Inline styles instead of Tailwind** — Inline `style={}` doesn't benefit from Tailwind's responsive utilities, dark mode, or design tokens. Always use Tailwind classes.

34. **Missing axe audits in component tests** — Every new component test should include `axe(container)` to catch accessibility regressions automatically.

35. **Missing Escape handler in popovers** — All popovers and modals must close on Escape key. Radix components handle this, but custom popovers need explicit `keydown` handlers.

36. **Property type initialization not type-aware** — `buildInitParams()` in `property-save-utils.ts` must be used for property creation. It returns type-appropriate defaults (number→0, date→today, text/select→'', ref→null). Sending `valueText: ''` for non-text types causes silent failures.

37. **Tag filters using ULIDs instead of names** — User-facing filters should accept human-readable values, not internal IDs. `TagValuePicker` provides searchable autocomplete; `queryTag()` resolves names to IDs.

38. **Hardcoded English in test assertions** — Tests that assert on hardcoded English strings break when those strings are replaced with `t()` i18n calls. Use `t('key')` in assertions, or query by role/aria-label.

## Lessons Learned

Non-obvious patterns discovered across many sessions. Items already covered by earlier sections of this doc are omitted — this section is only for the subtle gotchas.

### Interaction & Timing

- **Blur-to-save needs `checkVisibility()` guard.** Popovers/pickers must not trigger save on blur. Check visibility before persisting.
- **`onPointerDown` before `onClick` for buttons that disappear on focus change** (delete buttons in a hover-reveal gutter, for example). `onClick` fires after focus moves and the re-render hides the button.
- **Capture-phase keydown + `stopPropagation()`** when the handler must fire before ProseMirror (e.g., Enter to split blocks). Attach on `parentElement`, not the editor element.
- **Suggestion popup keyboard passthrough.** When a suggestion popup (slash/tag/page picker) is visible, `Enter`/`Tab`/`Escape`/`Backspace` must pass through to the popup. Block keyboard handlers check `isSuggestionPopupVisible()` first.
- **Re-entrancy guards on async handlers** (rapid double-click/double-Enter). Use a `useRef(false)` declared at hook/component top level, set true in `try`, reset in `finally`.
- **Capture DOM/editor state before any `await`.** After an async gap, cursor/selection/focus may have moved. Save `pos = editor.state.selection.from` and `blockId = store.getState().focusedBlockId` first, then use the saved values.
- **`flushSync()` in editor blur.** When `handleBlur` calls `edit()` + `splitBlock()`, wrap in `flushSync()` so the store update renders before the editor unmounts.
- **Version-counter pattern for save/discard races.** Draft autosave uses a ref counter: save captures the version before `await`; if the version incremented (discard fired), the save is dropped.
- **Map merge order for cache updates.** `new Map([...staleCache, ...freshData])` — fresh data must be spread LAST so it wins on conflict. Reversed order silently keeps stale data.
- **Optimistic edits need rollback.** Capture `previousContent` before the optimistic update, restore it (and toast an error) on IPC rejection.

### Accessibility

- **`outline-hidden`, not `outline-none`.** `outline-none` conflicts with `focus-visible:outline-1`.
- **SVG interactive elements need explicit keyboard support.** Add `tabindex="0"`, `role="button"`, and `keydown` handlers for Enter/Space. For touch, add an invisible larger hit area behind the visible element.
- **Dynamic `aria-label` on toggle buttons.** Expand/collapse icons change meaning — label must reflect current state.
- **Skip-to-main link.** `sr-only` anchor visible on focus that targets `#main-content`.
- **Announce state changes** via `announce()` (singleton in `src/lib/announcer.ts`). Use the double-RAF pattern; pass i18n keys, not English.
- **Tab/Shift-Tab are browser focus navigation** — don't bind them for app shortcuts (indent/dedent etc.). Use `Ctrl+Shift+Arrow` instead.

### Motion & Animation

- **JS-driven animations must check `prefers-reduced-motion` manually.** The global CSS rule only covers CSS animations. d3-force, `requestAnimationFrame` loops, etc. must check `window.matchMedia('(prefers-reduced-motion: reduce)')` and skip or instant-complete.

### Positioning & Layout

- **`@floating-ui/dom` only** for popup placement. Use `computePosition()` with `offset() + flip() + shift()` middleware — never hand-roll coordinate math.
- **Gutter/hover-reveal buttons need `pointer-events: none` when hidden.** Invisible (`opacity-0`) elements still receive pointer events and block clicks on things behind them. Toggle `pointer-events-auto` on all visibility triggers (group-hover, coarse pointer, focus-within, focus-visible).
- **Popovers on mobile:** `max-w-[calc(100vw-2rem)]` and responsive positioning — otherwise they clip off-screen.

### Data & State

- **Store initial state `loading: true`** when the store fetches on mount. `loading: false` causes a flash of empty state before data arrives.
- **Per-page stores via context.** When a component can render multiple independent instances (per-page block stores, per-page undo state), use per-instance stores created via a factory + React context, not global singletons.
- **Individual Zustand selectors** over destructuring — `useBlockStore(s => s.focusedBlockId)` re-renders only on that slice. `const { focusedBlockId } = useBlockStore()` re-renders on every state change (bad for per-block components).
- **Property type initialization must be type-aware.** Use `buildInitParams()` in `property-save-utils.ts` to get type-appropriate defaults (number→0, date→today, text/select→'', ref→null). Sending `valueText: ''` for non-text types silently fails.
- **User-facing filters use names, not ULIDs.** Resolve to IDs via `TagValuePicker` / `queryTag()`.

### Code Quality

- **No silent catch blocks.** Every `catch` calls `logger.warn` / `logger.error` (or surfaces via `toast.error`), never `.catch(() => {})`.
- **Cleanup event listeners on unmount.** Any `useEffect` that adds a listener needs a cleanup return — otherwise memory leaks and stale closures.
- **No inline `style={{...}}`** for values that have Tailwind utilities or tokens. Inline styles bypass responsive utilities, dark mode, and tokens.
- **Extract when components pass ~500 lines.** Extract hooks first, presentational sub-components next. Keep re-exports for backward compatibility.
- **Check the Shared Component Inventory before building** a new component. Duplication is consistently the #1 source of REVIEW-LATER debt.

### Key Principles

1. **Consistency** — use shared components, tokens, and established patterns.
2. **Mobile-first** — touch-friendly (44px min), coarse-pointer handling, responsive stacking.
3. **Accessibility** — `aria-label`, focus rings, semantic HTML, keyboard navigation, `prefers-reduced-motion`.
4. **Feedback** — loading states, error toasts, confirmations. Never silently fail.
5. **Performance** — debounce search, lazy-load heavy views, batch queries, cache expensive views.
6. **Graceful degradation** — offline-first, `FeatureErrorBoundary` per section, sensible fallbacks.
7. **Token-first** — colors, durations, typography all via CSS custom properties.
8. **Guard concurrent operations** — re-entrancy refs, version counters, position capture across async gaps.
