/**
 * BlockContextMenu — menu-row rendering primitives.
 *
 * Extracted from `BlockContextMenu.tsx` (#1109 machinery). Presentational only:
 * the parent owns all state (roving focus index, item refs, the per-render
 * `itemIndex` counter); these helpers render one row given that context. Leaf
 * module — depends on the shared `MenuItem` type, never back on the menu.
 */

import { Check } from 'lucide-react'

import type { MenuItem } from '@/components/editor/block-context-menu/types'
import { Kbd } from '@/components/ui/kbd'
import { MenuRowChevron, menuRowVariants } from '@/components/ui/menu-row'
import { cn } from '@/lib/utils'

/**
 * #999/#1002/#1003 — the trailing slot of an interactive row holds a keyboard
 * shortcut hint (only where there is a keyboard, `useKeyboardHints`) and/or a
 * disclosure chevron (the "Turn into" toggle). #976 (item 14) — a disclosure
 * toggle that ALSO has a binding (Turn into → Ctrl+Shift+L) shows the hint
 * before the chevron, so the keyboard shortcut stays discoverable.
 */
export function renderTrailing(item: MenuItem, keyboardHints: boolean): React.ReactNode {
  const hint =
    item.shortcut && keyboardHints ? (
      // #1002 — no magic `ml-4`; the label's `flex-1` + button `gap-2`
      // right-align the hint.
      <span className="text-xs text-muted-foreground">
        <Kbd keys={item.shortcut} tone="muted" />
        {item.shortcutNote && ` ${item.shortcutNote}`}
      </span>
    ) : null
  if (item.expanded !== undefined) {
    return (
      <>
        {hint}
        {item.active && <Check aria-hidden="true" className="text-accent-foreground" />}
        <MenuRowChevron expanded={item.expanded} />
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
  /** Whether rows show their shortcut hints (`useKeyboardHints`). */
  keyboardHints: boolean
}

/** A row's indent: a disclosure's options one level, a nested disclosure's two. */
function indentOf(item: MenuItem): 0 | 1 | 2 {
  if (!item.indented) return 0
  return item.nested ? 2 : 1
}

/**
 * Render a single menu row. #999 — `indented` rows indent once at the row
 * level (not via per-icon `ml-3`) so the checked and unchecked variants of a
 * child option indent identically.
 */
export function renderItem(item: MenuItem, ctx: MenuRowContext): React.ReactElement {
  const { action } = item
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
          menuRowVariants({ indent: indentOf(item) }),
          'pointer-events-none bg-accent/60 font-medium text-accent-foreground',
        )}
      >
        {item.icon}
        <span className="flex-1">{item.label}</span>
        {/* #1001 — lucide Check (not a bare ✓), `aria-hidden` since the
            container's `aria-current` carries the semantic. #1002 — unlike a
            shortcut hint, the state indicator is NOT suppressed on touch. */}
        <Check aria-hidden="true" className="text-accent-foreground" />
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
      aria-current={item.active ? 'true' : undefined}
      className={cn(menuRowVariants({ indent: indentOf(item) }), item.className)}
      onClick={action === undefined ? undefined : () => void action()}
    >
      {item.icon}
      <span className="flex-1">{item.label}</span>
      {renderTrailing(item, ctx.keyboardHints)}
    </button>
  )
}
