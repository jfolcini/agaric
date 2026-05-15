<!-- markdownlint-disable MD060 -->
# Agaric UX Baseline

Rules and conventions for building UI in this project. Agent-targeted: every section answers "what do I need to know at point of edit?". Self-contained. Companion to `docs/UI-MAP.md` (vocabulary + surface tree) and `AGENTS.md § Frontend Development Guidelines` (architectural invariants).

## Quickstart

Three rules dominate everything below:

1. **Tokens, not literals.** Colours go through OKLCH semantic tokens in `src/index.css`. Durations and easings go through `--duration-*` / `--ease-*`. No `text-gray-500`, no `200ms`.
2. **i18n everything.** Every user-visible string passes through `t()` — including toast text, `aria-label`, empty states, and `announce()` calls. Keys live in `src/lib/i18n/{namespace}.ts`.
3. **44 px touch floor.** Every interactive element honours `[@media(pointer:coarse)]:min-h-11` (or equivalent). Enforced in `Button` variants. The `max-sm:` divergence on inline indicators is documented in `docs/UI-MAP.md` § Mobile/a11y.

Source layout:

| Where                          | What lives there                                                                                                |
| --- | --- |
| `src/components/ui/`           | shadcn-style primitives. Check here first before building anything new.                                         |
| `src/components/`              | Domain components.                                                                                              |
| `src/components/<Feature>/`    | Per-feature sub-component directories (e.g. `FormattingToolbar/`, `PropertyRowEditor/`, `SpaceManageDialog/`).  |
| `src/editor/`                  | TipTap extensions, nodes, marks, plugins.                                                                       |
| `src/hooks/`                   | Reusable hooks. Slash-command logic lives under `src/hooks/useBlockSlashCommands/`.                             |
| `src/stores/`                  | Zustand stores, one per concern. Per-page stores use the factory + context pattern.                             |
| `src/lib/i18n/`                | One file per namespace; export `t` via `src/lib/i18n/index.ts`.                                                 |
| `src/lib/keyboard-config/`     | Shortcut catalog (`catalog.ts`), matcher (`match.ts`), storage (`storage.ts`), TipTap binding (`tiptap.ts`).    |
| `src/lib/announcer.ts`         | `aria-live` singleton.                                                                                          |
| `src/lib/notify.ts`            | Toast wrapper around sonner.                                                                                    |

## Design tokens

Reference the token, don't reinvent the value. The tokens themselves are defined in `src/index.css`; the rules below say which token to use where.

- **Colour.** Always semantic: `bg-background / bg-card / bg-popover / bg-muted / bg-accent`, `text-foreground / text-muted-foreground`, `border-border / border-input`. Status colours via `<Badge tone="status">` and `<Badge tone="priority">`. Callouts via `--alert-{tip,note,info,warning,error}` token families.
- **Typography.** Use the `text-scale-*` utilities for responsive headings (h1-h3 shrink one step on small viewports). Body text relies on `font-sans`; code on `font-mono`. The `text-base → md:text-sm` pattern on inputs prevents iOS zoom on focus.
- **Radius.** `rounded-sm / rounded / rounded-md / rounded-lg` — match the surrounding context, don't introduce new radii.
- **Animation.** `var(--duration-fast | --duration-normal | --duration-slow)` for durations; `var(--ease-out | --ease-in-out)` for easings. Reduced-motion overrides apply globally.
- **Indent width.** `var(--indent-width)` — has a narrow-viewport override (last-declared-wins). JS DnD calculations multiply by this CSS variable, not a literal.

## Touch & responsive

- **`useIsMobile`** initialises synchronously (reads `window.innerWidth` on first render) to prevent a frame of desktop layout before the switch.
- **`100dvh`, not `100vh`.** Mobile chrome makes `100vh` taller than the visible area.
- **Safe-area insets** matter on mobile (`env(safe-area-inset-bottom)` etc.) — use them for any bottom-pinned element.
- **DnD sensors split by pointer type.** Desktop = distance threshold (start drag immediately on a few pixels of movement). Touch = delay threshold (250 ms hold) — otherwise every scroll gesture would start a drag.
- **Long-press** for mobile context menus is owned by `useBlockTouchLongPress`. The delay + move-tolerance constants are there.
- **`onPointerDown`, never `onMouse*`.** Mouse events don't fire on touch. Toolbar/popover handlers must also `e.preventDefault()` so focus stays in the editor.
- **Mobile sidebar** = persistent 48 px icon rail + Sheet overlay. Distinct from desktop's `SidebarRail` (resize handle). Sheet auto-closes on nav-item tap.

## Accessibility

- **ARIA roles in active use:** `toolbar`, `dialog`, `alertdialog`, `menuitem`, `menuitemradio`, `option`, `listbox`, `status`, `region`, `tooltip`, `group`. Tables intentionally lack `role="grid"`. Every custom interactive element needs a `role` + `aria-label`.
- **Announcer.** `announce()` (in `src/lib/announcer.ts`) writes to a singleton `role="status" aria-live="polite"` region. Identical strings within 500 ms are coalesced. Pass i18n keys, not English. Use the double-RAF pattern when announcing post-state-change.
- **Focus management.** Radix dialogs / sheets / popovers trap focus automatically. Lists with multiple items use roving tabindex via `useListKeyboardNavigation`. Focus must be restored after a modal closes. Auto-focus the first input on dialog open.
- **Editor blur boundary contract.** Any overlay anchored from inside the editor (popover, picker, calendar, drawer, context menu) must set `data-editor-portal=""` on its outermost portal node. `useEditorBlur` reads this attribute to know whether the focus shift should trigger an editor unmount. If you create a new overlay and it closes the editor on click, you forgot this attribute.
- **Reduced motion.** A global CSS rule zeros every `transition`/`animation` and sets `scroll-behavior: auto` under `prefers-reduced-motion: reduce`. Hooks that orchestrate motion via JS (`useScrollToFocus`, `useAutoScrollOnDrag`, d3-force loops, `requestAnimationFrame` patterns) **must** check `window.matchMedia('(prefers-reduced-motion: reduce)')` themselves — the CSS rule does not cover them.
- **`data-slot` for styling, `data-testid` for tests.** Never both on the same element.

## Keyboard model

All shortcuts live in `src/lib/keyboard-config/catalog.ts` and are user-customisable in Settings → Keyboard. Persistence is localStorage with cross-tab `storage`-event sync. Picker-trigger characters (`/`, `@`, `[[`, `((`, `::`) are not rebindable.

Scopes (look in the catalog for the full set):

- **Editor** — block split / merge, indent / dedent (use `Ctrl+Shift+Arrow`, never `Tab` — Tab is browser focus navigation), collapse, mark toggles, link insertion, slash menu.
- **Formatting** — bold / italic / strike / code / highlight + heading levels + code block.
- **Global** — `Ctrl+F` (focus search), `?` (shortcuts panel), `Escape` (close all overlays), `Ctrl+Z` / `Ctrl+Y` (page-level undo/redo when not in editor), `Ctrl+1`-`Ctrl+9` (switch space).
- **Journal** — `Alt+←` / `Alt+→` (prev / next), `Alt+T` (today).
- **List navigation** — `Home` / `End` / `PageUp` / `PageDown` + optional wrap-around via `useKeyboardNavigableList`.

To add a shortcut: append a `ShortcutBinding` entry to `catalog.ts` (`id`, `keys`, `category`, `description`, optional `condition`), wire the handler at the call site, add i18n labels under `shortcuts.*`, and add `aria-keyshortcuts` if the trigger is on a visible button.

## State, undo, optimism, multi-select

- **Zustand stores under `src/stores/`** — one store per concern, plus per-page stores via the factory + React context pattern (each `PageEditor` instance gets its own block / undo state — see how `BlockTree` consumes them). Always select individual slices (`useStore(s => s.slice)`); destructuring re-renders on every change.
- **`useStore.getState()` inside async callbacks is intentional.** It reads fresh state instead of the closure snapshot. Don't "fix" it to a hook-call.
- **Two-tier undo/redo.** In-editor (ProseMirror history, scoped to one edit session). Page-level (`UndoStore` over the op log, reversed by `reverse.rs`). The page-level undo coalesces ops within `UNDO_GROUP_WINDOW_MS`; the redo stack is capped at `MAX_REDO_STACK`. Both constants live in `src/stores/undo.ts`.
- **Optimistic updates pattern.** Capture `previousContent`, apply optimistic write, await IPC, on rejection restore previous + `toast.error()`. Never leave the UI in a state that diverges from the backend.
- **Multi-select.** `Ctrl/Cmd+click` toggles, `Shift+click` extends, `Ctrl+A` selects all visible. Batch operations must filter out descendants of already-selected ancestors to avoid double-deletes. Guard against concurrent batch invocations with a `batchInProgress` ref.

## Editor architecture

- **Single roving editor.** Exactly one block hosts `<EditorContent>` at a time. All others render via `StaticBlock` → `RichContentRenderer`. Focus changes unmount the editor from the previous block (after persisting markdown) and mount it in the new one.
- **Position capture before async.** Picker plugins that await IPC must save `insertPos` first and check `insertPos <= editor.state.doc.content.size` before inserting on the await side. The doc may have shrunk during the await.
- **`flushSync` on blur-to-save.** When `handleBlur` calls `edit()` or `splitBlock()`, the store update must complete before the editor unmounts. Wrap in `flushSync()`.
- **Re-entrancy refs.** `handleDeleteBlock`, `handleEnterSave`, and other async block handlers can be triggered twice (double-click, rapid `Enter`). Use a `useRef(false)` set inside `try`, cleared in `finally`.
- **Suggestion-popup keyboard passthrough.** When a picker popup is visible, the block-keyboard capture-phase listener must defer `Enter` / `Tab` / `Escape` / `Backspace` to the suggestion plugin. Check `isSuggestionPopupVisible()` first.
- **Capture-phase listener attaches on `editor.view.dom.parentElement`.** Not the editor itself — ProseMirror needs the events first for split / merge / indent behaviour.

## UI primitives & shared components

Before you create a new component, look in `src/components/ui/` (shadcn-style primitives) and `src/components/` (domain primitives + feature components). Check before building anything new — duplication is the most-flagged class of REVIEW-LATER item.

The cross-feature primitives most worth knowing (not exhaustive — see `src/components/ui/` for the full set):

- **Badge** — `tone="priority" | "status" | "default"`. The single source for status / priority colouring.
- **IconButton** (`src/components/ui/`) — mandates `tooltip` + `ariaLabel`. Use instead of `<Button size="icon">` + bare Lucide icon.
- **SearchInput** (`src/components/ui/`) — input with built-in clear button.
- **SearchablePopover** (`src/components/`) — keyboard-navigable picker; backs page / tag pickers.
- **MenuPopoverContent** (`src/components/ui/`) — canonical popover content for menu-style popovers. Prefer this over plain `PopoverContent` for menu surfaces.
- **FilterPill** (`src/components/ui/`) — removable chip used in filter rows.
- **AlertSection** / **AlertListRow** (`src/components/`) — overdue / upcoming sections + their list rows.
- **ListViewState** (`src/components/`) — wraps list + empty + loading + error states.
- **FeatureErrorBoundary** (`src/components/`) — wrap each view inside the dispatcher so a crashed view doesn't take down the shell.
- **FeaturePageHeader** (`src/components/`) — title bar for non-editor views.
- **ChevronToggle** (`src/components/ui/`) — animated chevron; for expand/collapse triggers.

## Conventional patterns

- **Button hierarchy.** `outline` for the primary action. `ghost` for secondary / icon-only. `destructive` reserved for irreversible deletes (purge from trash, etc.) — restricted because misuse trains the user to ignore the colour.
- **Icons.** Lucide only. One icon per action across the app (e.g., `Trash2` is delete everywhere — never `X` or `MinusCircle`).
- **Toasts.** Use `notify()` (wraps sonner) — never call sonner directly. Standard durations are defined in `src/lib/notify.ts` (short for ops feedback, longer for Undo / warnings). Partial-failure operations show a `Retry` action: `notify.error(msg, { action: { label: t('common.retry'), onClick: ... } })`.
- **Confirmation dialogs.** Always Radix `AlertDialog` (via `ConfirmDialog`). Never a custom `<div>` — focus trap + Escape handling must work. Destructive variants focus Cancel by default.
- **Mobile dialog swap.** `useDialogOrSheet` renders dialogs as bottom Sheets on phones, same `open` / `onOpenChange` API. AlertDialog auto-closes on action; Sheet needs explicit `onOpenChange(false)`.
- **Empty / loading / error.** Empty states need a meaningful CTA. Loading shows a skeleton or spinner, never a blank screen, with `aria-busy="true"` on the container. Error states must include a way to retry or recover.
- **Filter UI.** Removable pills, dropdown sort, `Clear all` action.
- **Inline tokens.** Tag chips, block-link chips, external-link chips share styling conventions and a `deleted` variant.
- **Scroll areas.** Use the `ScrollArea` primitive for any scroller that needs styled scrollbars on touch (coarse pointers get a thicker thumb).
- **`@floating-ui/dom`** for popover placement (`computePosition` + `offset() + flip() + shift()`). Never hand-roll coordinate math.

## App-specific features

- **Spaces.** Each space has its own slice of nav state (`currentView`, recent pages, tabs, journal mode). Switching spaces flips them. `Ctrl+1`-`Ctrl+9` switch by index. The sidebar header collapses **SpaceSwitcher** to **SpaceAccentBadge** in icon-rail mode. Cross-space links to a foreign-space target render via the existing broken-link variant; the actual block is never resolved across spaces.
- **Journal.** Daily / Weekly / Monthly / Agenda modes sharing a date cursor. **DuePanel** / **DonePanel** are children of journal modes, not standalone views — clicking a Due / Done badge scrolls them into view, doesn't navigate.
- **Block zoom-in.** Title is a text link in a breadcrumb (`Page › Section › Block`), not a pill — the breadcrumb implies "you're inside this".
- **Inline query blocks.** `{{query: …}}` blocks render a filtered list inline. Edit-on-click; the body is the query, not the results.
- **Conflict resolution.** UI offers Keep / Discard per conflict, or batch operations. Devices are shown by name (not ULID) for the user to disambiguate.
- **Agenda projection.** The agenda view dedupes overdue tasks against the projected (cached) view. `DeadlineWarningSection` surfaces near-future tasks that may slip.
- **Templates.** Template-tagged pages (`template = true` property). The template picker (slash command + button) inserts the template's child blocks under the current block; dynamic variables substitute on insertion.
- **Property drawer.** Sheet slide-in (or popover on desktop) with one `PropertyRowEditor` per property + the built-in date fields at the top. Blur-to-save semantics; add via `AddPropertyPopover`.
- **Kebab menu.** `PageHeaderMenu` is the canonical placement for page-level actions (Undo, Redo, Move to space, Add alias, Add tag, Export, Trash, Template). Don't sprinkle these actions elsewhere.
- **GraphView.** d3-force in a Web Worker (fallback to main thread). Keyboard nav + reduced-motion checks both honoured.
- **Google Calendar.** Per-space push. See `src-tauri/src/gcal_push/` for implementation; UI in `GoogleCalendarSettingsTab`.
- **MCP.** Read-only + read-write tool modules under `src-tauri/src/mcp/{tools_ro,tools_rw}/`. Agent activity UI in `src/components/agent-access/` (`ActivityFeed`, `McpStatusSection`, `SessionRevertControls`).

## i18n

- **Every user-visible string** uses `t()`. Includes toasts, `aria-label`, empty / error states, `announce()` calls, validation messages.
- **Keys live in `src/lib/i18n/{namespace}.ts`** (agenda / block / common / editor / errors / history / pages / properties / references / settings / shortcuts / sync / toolbar). Choose the namespace by feature.
- **Component code** imports `t` via `useTranslation()`. Non-React code (class components, plain modules) imports `i18n` from `@/lib/i18n` and calls `i18n.t('key')`.
- **Tests** assert through `t('key')`, or via `role` / `aria-label`. Never assert on hardcoded English.

## Quality checklist

Before shipping any UI change:

1. **Touch** — all interactive elements ≥ 44 px on coarse pointers.
2. **Keyboard** — every action reachable, focus visible, Escape closes overlays.
3. **ARIA** — roles + labels + states on every custom interactive component.
4. **Screen reader** — `announce()` on state changes not visible to AT.
5. **Focus restore** — auto-focus on overlay open, restore on close.
6. **Hover + active** — both states on every enabled element.
7. **Pointer events** — `onPointerDown`, never `onMouse*`.
8. **Reduced motion** — JS-driven animations check `prefers-reduced-motion` manually.
9. **High contrast** — respect `prefers-contrast: more`.
10. **Dark mode** — every colour uses a semantic token.
11. **Responsive** — test mobile breakpoint + safe-area + virtual keyboard.
12. **Error feedback** — no silent catches, specific toast messages, inline validation.
13. **Empty state** — meaningful CTA, context-aware.
14. **Loading state** — skeleton or spinner, `aria-busy`.
15. **Semantic HTML** — `<button>`, `<ul>/<li>`, `<label>` for forms.
16. **Tokens only** — no `text-gray-500`, no `200ms`.
17. **`data-editor-portal`** — every new overlay anchored from inside the editor sets it.
18. **i18n** — every visible string passes through `t()`.
19. **`axe(container)` audit** — new component tests include the axe call.

## Pitfalls

The non-obvious ones — duplicates of rules stated above are intentionally omitted.

- **`outline-hidden`, not `outline-none`.** The latter conflicts with `focus-visible:outline-1`.
- **Hover-only affordances** don't work on touch. Use always-visible or long-press / context menu.
- **Hover-reveal buttons block clicks underneath** when `opacity-0` — toggle `pointer-events-{none,auto}` on every visibility trigger.
- **DnD mobile sensor.** The long-press delay is deliberate. Don't switch mobile to the distance sensor — every scroll would become a drag.
- **Map merge order.** `new Map([...stale, ...fresh])` — fresh must spread last so it wins on conflict.
- **Property type initialisation must be type-aware.** Use `buildInitParams()` in `property-save-utils.ts`. Sending `valueText: ''` for a number / date / ref / select property silently fails.
- **Filters use names, not ULIDs.** Resolve via `TagValuePicker` / `queryTag()`.
- **SVG interactive elements need explicit keyboard support.** `tabindex="0"`, `role="button"`, `keydown` handlers for Enter / Space. For touch, add an invisible larger hit area.
- **Dynamic `aria-label` on toggle buttons.** Expand/collapse icons change meaning; the label must reflect the current state.
- **Stale `selectedBlockIds`.** `remove()` clears the deleted block, `load()` clears all selections on page nav. Filter descendants before batch delete.
- **`setState` after unmount in React 18+ is silent**, not a defect. Don't add `isMountedRef` guards just to suppress something that doesn't happen. Only flag if the dropped update would leave incorrect *visible* state.

**Closing principle:** consistency over cleverness, mobile-first, accessible by default, never silently fail, tokens not literals, guard concurrency across every async gap.
