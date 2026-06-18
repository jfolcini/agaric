/**
 * PaletteActionMenu (PEND-67 Phase 5).
 *
 * Per-row action sheet for the palette. Anchored to the row that had
 * focus when Tab was pressed (or to the `…` button on mouse hover);
 * exposes a small list of buttons with arrow-key navigation, Escape
 * to close, and click-outside dismissal.
 *
 * Implementation notes:
 *  - This is intentionally a small hand-rolled menu rather than a
 *    Radix DropdownMenu. Radix's controlled open requires a single
 *    trigger element while we want any cmdk-row to act as the anchor;
 *    a controlled-anchor pattern with Radix is more lines of glue
 *    than the menu itself. The keyboard nav is short (Arrow + Enter
 *    + Escape) and well-trodden — no shortcut to a higher-level
 *    primitive is justified.
 *  - Positioning uses the row's `getBoundingClientRect()` captured at
 *    the moment Tab fired. Scrolling the list while the menu is open
 *    would desync this, but the menu closes on Escape / click /
 *    action — so the desync window is bounded.
 *  - 44 px touch floor: each `<button>` gets `[@media(pointer:coarse)]:
 *    min-h-[44px]` via the row class, matching `docs/UX.md`.
 */

import type React from 'react'
import { useLayoutEffect, useEffect, useRef, useState } from 'react'

import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

/** Gap between the anchor row and the menu edge, in px. */
const GAP = 4
/** Minimum breathing room kept between the menu and the viewport edge, in px. */
const VIEWPORT_MARGIN = 16
/** Floor for a clamped (scrolling) menu so it never collapses to a sliver. */
const MIN_MAX_HEIGHT = 88

export interface PaletteAction {
  /** Stable id passed back to `onAction`. */
  id: string
  /** Human label rendered as the menu item content. */
  label: string
  /** Optional right-aligned shortcut hint chip (e.g. `↵`, `⌘↵`). */
  hint?: string
}

export interface PaletteActionMenuProps {
  /** Position anchor — the row's bounding rect at the moment the menu opened. */
  anchor: DOMRect
  /** Ordered list of actions to render. Empty list = menu does not render. */
  actions: ReadonlyArray<PaletteAction>
  /** Called with the action id when the user selects an action. */
  onAction: (id: string) => void
  /** Called when the menu should close without an action (Escape / outside click). */
  onClose: () => void
}

export function PaletteActionMenu({
  anchor,
  actions,
  onAction,
  onClose,
}: PaletteActionMenuProps): React.ReactElement | null {
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<HTMLButtonElement[]>([])

  // Vertical placement. Default is "below the anchor" (`anchor.bottom + 4`);
  // after mount we measure the rendered menu and flip above the anchor when
  // it would overflow the viewport bottom. `maxHeight` caps a menu that is
  // taller than the available space in either direction (then it scrolls).
  const [placement, setPlacement] = useState<{
    top: number
    maxHeight: number | undefined
  }>(() => ({ top: anchor.bottom + GAP, maxHeight: undefined }))

  // Focus the first action on mount so keyboard users can press
  // Enter immediately.
  useEffect(() => {
    buttonRefs.current[0]?.focus()
  }, [])

  // Collision handling (mirrors Radix Popper): measure the menu's rendered
  // height, then choose below / above / clamp so the body stays on-screen.
  // Runs before paint (useLayoutEffect) to avoid a visible jump.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (el == null) return
    const viewportH = window.innerHeight
    const height = el.offsetHeight
    const spaceBelow = viewportH - anchor.bottom - GAP - VIEWPORT_MARGIN
    const spaceAbove = anchor.top - GAP - VIEWPORT_MARGIN

    if (height <= spaceBelow) {
      // Fits below as-is.
      setPlacement({ top: anchor.bottom + GAP, maxHeight: undefined })
    } else if (height <= spaceAbove) {
      // Flip above the anchor.
      setPlacement({ top: anchor.top - GAP - height, maxHeight: undefined })
    } else if (spaceBelow >= spaceAbove) {
      // Doesn't fully fit either way → use the larger side and scroll.
      setPlacement({
        top: anchor.bottom + GAP,
        maxHeight: Math.max(spaceBelow, MIN_MAX_HEIGHT),
      })
    } else {
      setPlacement({
        top: VIEWPORT_MARGIN,
        maxHeight: Math.max(spaceAbove, MIN_MAX_HEIGHT),
      })
    }
  }, [anchor.bottom, anchor.top])

  // Click-outside closes the menu. Uses pointerdown rather than click
  // so the close fires before any focus-shift the click would cause.
  useEffect(() => {
    function handlePointer(e: PointerEvent) {
      if (menuRef.current == null) return
      if (menuRef.current.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('pointerdown', handlePointer)
    return () => document.removeEventListener('pointerdown', handlePointer)
  }, [onClose])

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      // Also stop the native event so Radix Dialog's Escape handler
      // (attached via a portal at the document root rather than via
      // React bubbling) does not also fire and close the palette
      // along with the menu.
      e.nativeEvent.stopImmediatePropagation()
      onClose()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const buttons = buttonRefs.current.filter((b) => b != null)
    if (buttons.length === 0) return
    const active = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'ArrowDown'
        ? (active + 1) % buttons.length
        : (active - 1 + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  if (actions.length === 0) return null

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      data-testid="palette-action-menu"
      // `fixed` so the menu floats above the palette dialog without
      // requiring a portal. The palette's z-index baseline is 50;
      // we sit on top at 60.
      style={{
        position: 'fixed',
        top: placement.top,
        left: Math.min(anchor.left, window.innerWidth - 220),
        minWidth: 200,
        maxHeight: placement.maxHeight,
        overflowY: placement.maxHeight != null ? 'auto' : undefined,
        zIndex: 60,
      }}
      className="rounded-md border border-border bg-popover p-1 shadow-md"
    >
      {actions.map((a, i) => (
        <button
          key={a.id}
          ref={(el) => {
            if (el != null) buttonRefs.current[i] = el
          }}
          type="button"
          role="menuitem"
          onClick={() => onAction(a.id)}
          data-testid={`palette-action-${a.id}`}
          className={cn(
            'flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/40',
            'focus:bg-accent/40 focus-ring-visible',
            '[@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:py-2.5',
          )}
        >
          <span className="flex-1 text-left">{a.label}</span>
          {a.hint != null && (
            // #1005 — canonical chip; legible on the menu item's focus/hover
            // accent fill. Decorative within an interactive row → aria-hidden.
            <Kbd aria-hidden="true">{a.hint}</Kbd>
          )}
        </button>
      ))}
    </div>
  )
}
