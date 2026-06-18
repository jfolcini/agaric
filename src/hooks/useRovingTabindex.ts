/**
 * useRovingTabindex — implements the WAI-ARIA `toolbar` roving-tabindex model
 * for a container of focusable controls.
 *
 * The WAI-ARIA toolbar pattern requires a single tab stop: Tab moves focus to
 * the toolbar (landing on exactly one button), and ArrowLeft/ArrowRight (plus
 * Home/End) move focus *between* the buttons without leaving the toolbar. Tab
 * again leaves the toolbar entirely. This contrasts with the default behaviour
 * where every button is its own tab stop.
 *
 * This hook is intentionally DOM-driven rather than index-driven: it queries
 * the actual focusable `<button>` descendants of the container element on each
 * keystroke / focus event. That keeps it agnostic to how each toolbar renders
 * its buttons — directly, wrapped in tooltip spans, or produced dynamically by
 * an overflow measurement (FormattingToolbar) — so all three `role="toolbar"`
 * surfaces can share one implementation with zero changes to their button
 * markup.
 *
 * Usage:
 *
 *   const { containerRef, onKeyDown, onFocus } = useRovingTabindex()
 *   <div role="toolbar" ref={containerRef} onKeyDown={onKeyDown} onFocus={onFocus}>
 *     ...buttons...
 *   </div>
 *
 * Behaviour:
 *  - Exactly one enabled button carries `tabindex="0"`; the rest carry `-1`.
 *  - ArrowRight / ArrowLeft move to the next / previous *enabled* button,
 *    wrapping around the ends (per the toolbar pattern's default).
 *  - Home / End jump to the first / last enabled button.
 *  - Moving focus updates the roving tabindex so the last-focused button stays
 *    the single tab stop after the user tabs away and back.
 *  - Disabled buttons are skipped for both navigation and the tab stop.
 *  - Existing click / pointer handlers on the buttons are untouched.
 */

import { useCallback, useEffect, useRef } from 'react'

/** Selector for the controls a toolbar manages. Buttons only, today. */
const FOCUSABLE_SELECTOR = 'button'

function isEnabled(el: HTMLElement): boolean {
  if (el instanceof HTMLButtonElement && el.disabled) return false
  if (el.getAttribute('aria-disabled') === 'true') return false
  return true
}

/**
 * True if `el` sits inside an `aria-hidden="true"` or `inert` subtree (still
 * within `container`). Such buttons are not part of the visible toolbar — e.g.
 * FormattingToolbar's off-screen measurement sentinel — so they must be
 * excluded from the roving set and never own the tab stop.
 */
function isInHiddenSubtree(el: HTMLElement, container: HTMLElement): boolean {
  let node: HTMLElement | null = el
  while (node && node !== container) {
    if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert')) return true
    node = node.parentElement
  }
  return false
}

/** All enabled, visible focusable controls inside the container, in DOM order. */
function getItems(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => isEnabled(el) && !isInHiddenSubtree(el, container),
  )
}

/**
 * Apply the roving tabindex: the item at `activeIndex` (or the first enabled
 * item when that index is out of range) gets `tabindex="0"`, all others `-1`.
 */
function applyRovingTabindex(items: HTMLElement[], activeIndex: number): void {
  if (items.length === 0) return
  const active = activeIndex >= 0 && activeIndex < items.length ? activeIndex : 0
  items.forEach((item, i) => {
    item.tabIndex = i === active ? 0 : -1
  })
}

export interface UseRovingTabindexReturn {
  /** Attach to the `role="toolbar"` container element. */
  containerRef: React.RefCallback<HTMLElement>
  /** Attach to the container's `onKeyDown`. */
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
  /**
   * Attach to the container's `onFocus`. Keeps the roving tab stop in sync with
   * whichever button the user (or a click) actually focused.
   */
  onFocus: (e: React.FocusEvent<HTMLElement>) => void
}

export function useRovingTabindex(): UseRovingTabindexReturn {
  const containerEl = useRef<HTMLElement | null>(null)
  // Index of the button that currently owns the single tab stop.
  const activeIndex = useRef(0)

  // Keep the tab stop in sync as the toolbar's buttons change (overflow
  // collapse, contextual buttons appearing/disappearing). A MutationObserver
  // re-applies the roving tabindex whenever the subtree changes so we never
  // end up with zero (or multiple) tab stops.
  const sync = useCallback(() => {
    const items = getItems(containerEl.current)
    if (items.length === 0) return
    if (activeIndex.current >= items.length) activeIndex.current = items.length - 1
    if (activeIndex.current < 0) activeIndex.current = 0
    applyRovingTabindex(items, activeIndex.current)
  }, [])

  const observerRef = useRef<MutationObserver | null>(null)

  const containerRef = useCallback<React.RefCallback<HTMLElement>>(
    (node) => {
      observerRef.current?.disconnect()
      observerRef.current = null
      containerEl.current = node
      if (!node) return
      sync()
      const observer = new MutationObserver(() => sync())
      observer.observe(node, { childList: true, subtree: true })
      observerRef.current = observer
    },
    [sync],
  )

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [])

  /** Move focus + the tab stop to `nextIndex` (already validated). */
  const focusIndex = useCallback((items: HTMLElement[], nextIndex: number) => {
    activeIndex.current = nextIndex
    applyRovingTabindex(items, nextIndex)
    items[nextIndex]?.focus()
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const items = getItems(containerEl.current)
      if (items.length === 0) return

      // Where is focus now? Fall back to the tracked active index.
      const current = items.findIndex((item) => item === document.activeElement)
      const from = current >= 0 ? current : activeIndex.current

      let next: number | null = null
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          next = (from + 1) % items.length
          break
        case 'ArrowLeft':
        case 'ArrowUp':
          next = (from - 1 + items.length) % items.length
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = items.length - 1
          break
        default:
          return
      }

      e.preventDefault()
      focusIndex(items, next)
    },
    [focusIndex],
  )

  const onFocus = useCallback((e: React.FocusEvent<HTMLElement>) => {
    const items = getItems(containerEl.current)
    const idx = items.findIndex((item) => item === e.target)
    if (idx < 0) return
    activeIndex.current = idx
    applyRovingTabindex(items, idx)
  }, [])

  return { containerRef, onKeyDown, onFocus }
}
