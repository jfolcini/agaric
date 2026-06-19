/**
 * BlockContextMenu — menu-row rendering primitives.
 *
 * Extracted from `BlockContextMenu.tsx` (#1109 machinery). Presentational only:
 * the parent owns all state (roving focus index, item refs, the per-render
 * `itemIndex` counter); these helpers render one row given that context. Leaf
 * module — depends on the shared `MenuItem` type, never back on the menu.
 */

import { Check, ChevronDown, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

import type { MenuItem } from './types'

/**
 * #999/#1002/#1003 — the trailing slot of an interactive row holds a keyboard
 * shortcut hint (suppressed on coarse pointers, which have no keyboard) and/or
 * a disclosure chevron (the "Turn into" toggle). #976 (item 14) — a disclosure
 * toggle that ALSO has a binding (Turn into → Ctrl+Shift+T) shows the hint
 * before the chevron, so the keyboard shortcut stays discoverable.
 */
export function renderTrailing(item: MenuItem): React.ReactNode {
  const hint = item.shortcut ? (
    // #1002 — no magic `ml-4`; the label's `flex-1` + button `gap-2`
    // right-align the hint. `tabular-nums` keeps glyph widths even.
    <span className="text-xs text-muted-foreground tabular-nums [@media(pointer:coarse)]:hidden">
      {item.shortcut}
    </span>
  ) : null
  if (item.expanded !== undefined) {
    const Chevron = item.expanded ? ChevronDown : ChevronRight
    return (
      <>
        {hint}
        <Chevron aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
      </>
    )
  }
  return hint
}

/** Context the parent threads into {@link renderItem} for roving focus. */
export interface MenuRowContext {
  focusedIndex: number
  itemRefs: React.RefObject<(HTMLButtonElement | null)[]>
  /** Mutable per-render counter; advanced for each interactive (actionable) row. */
  nextIndex: () => number
}

/**
 * Render a single menu row. #999 — `indented` rows get `pl-7` (28px) applied
 * once at the row level (not via per-icon `ml-3`) so the checked and
 * unchecked variants of a child option indent identically; ~28px aligns the
 * child icon under the parent label (icon 14px + `gap-2` 8px + `px-2` 8px).
 */
export function renderItem(item: MenuItem, ctx: MenuRowContext): React.ReactElement {
  // #264 — the active "Turn into" type renders as a non-interactive
  // indicator: no action, no `itemIndex`, skipped by roving focus. It stays
  // ring-less (#1000) — only interactive rows carry the focus ring.
  if (item.action === undefined && item.active) {
    return (
      <div
        key={item.label}
        role="menuitem"
        aria-disabled="true"
        aria-current="true"
        className={cn(
          // #1232 — `text-left`: a <button>/<div role> defaults to
          // text-align:center, which the flex-1 label span inherits and
          // centers the label text. Force left so labels align under the icons.
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-accent-foreground bg-accent/60',
          item.indented && 'pl-7',
        )}
      >
        {item.icon}
        <span className="flex-1">{item.label}</span>
        {/* #1001 — lucide Check (not a bare ✓), `aria-hidden` since the
            container's `aria-current` carries the semantic. #1002 — unlike a
            shortcut hint, the state indicator is NOT suppressed on touch. */}
        <Check aria-hidden="true" className="h-3.5 w-3.5 text-accent-foreground" />
      </div>
    )
  }
  const idx = ctx.nextIndex()
  return (
    <button
      key={item.label}
      ref={(el) => {
        ctx.itemRefs.current[idx] = el
      }}
      type="button"
      role="menuitem"
      tabIndex={idx === ctx.focusedIndex ? 0 : -1}
      // #1003/#1109 — a disclosure toggle announces its expand state and the
      // inline-expanded options group it controls (its own `disclosureId`, so
      // "Turn into" and "Move & arrange" each link to the right subgroup).
      {...(item.expanded !== undefined
        ? { 'aria-expanded': item.expanded, 'aria-controls': item.disclosureId }
        : {})}
      className={cn(
        // #1000 — `focus-ring-visible` is the app-wide keyboard-focus signal
        // (ring, not just bg). `ring-inset` keeps the 3px ring from clipping
        // against the popover edge / `hr` separators. Hover stays bg-only so
        // focus and hover are visually distinct (WCAG 2.4.7).
        // #1232 — `text-left`: <button> defaults to text-align:center, which
        // the flex-1 label span inherits; force left so labels align left.
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground focus-ring-visible [&:focus-visible]:ring-inset transition-colors touch-target',
        item.indented && 'pl-7',
        item.className,
      )}
      onClick={item.action}
    >
      {item.icon}
      <span className="flex-1">{item.label}</span>
      {renderTrailing(item)}
    </button>
  )
}
