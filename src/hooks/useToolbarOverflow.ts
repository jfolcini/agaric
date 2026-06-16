/**
 * useToolbarOverflow — priority-based overflow hook for the per-block
 * `FormattingToolbar` (PEND-33 Layer B).
 *
 * Inputs:
 *  - `containerRef`: ref to the toolbar's visible container. The hook
 *    observes its `clientWidth` via `ResizeObserver` and uses that as
 *    the available budget.
 *  - `sentinelRef`: ref to an off-screen container that mirrors every
 *    item in the toolbar (rendered with
 *    `visibility: hidden; position: absolute; pointer-events: none`).
 *    Each child must carry a `data-toolbar-item-key="<item.key>"`
 *    attribute so the hook can read its natural width via
 *    `getBoundingClientRect`.
 *  - `items`: the flat ordered list of `ToolbarItem`s (buttons +
 *    separators).
 *
 * Outputs:
 *  - `visible`: items that fit inline. Separators are auto-included
 *    only when both adjacent groups still have at least one visible
 *    button.
 *  - `overflowed`: buttons that didn't fit, in their original order.
 *    Separators never overflow (they collapse instead).
 *
 * Algorithm: greedy drop. Start with all items visible; if the total
 * width exceeds the container budget (minus a reserve for the overflow
 * trigger button), drop the lowest-priority button. Tie-break: drop
 * the later-positioned button first so trailing items collapse before
 * leading ones. Repeat until everything fits.
 *
 * The callback only `setState`s — no DOM mutation — so the
 * `ResizeObserver loop completed with undelivered notifications`
 * warning is not a concern. React 19 batches by default.
 */

import type { RefObject } from 'react'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'

/** Approximate width of the overflow trigger (`MoreHorizontal`) button. */
export const OVERFLOW_TRIGGER_WIDTH_PX = 28

/**
 * Reserve added to popover-trigger items (heading, code block) to absorb
 * width drift caused by the variable inner badge (level number /
 * language label). Plan PEND-33 line 429-436.
 */
export const POPOVER_TRIGGER_VARIABLE_RESERVE_PX = 24

export type ToolbarItemBase = {
  /** Stable identifier — used as React key + sentinel data attribute. */
  key: string
  /** 0 = drops first, 100 = always visible. */
  priority: number
  /** Group id used by separator-collapse logic. */
  group: number
}

export type ToolbarItem =
  | (ToolbarItemBase & { kind: 'button'; isPopoverTrigger?: boolean })
  | (ToolbarItemBase & { kind: 'separator' })

export interface UseToolbarOverflowResult<T extends ToolbarItem> {
  visible: T[]
  overflowed: T[]
}

/** Reads each sentinel child's width and returns a key→width map. */
function readSentinelWidths(sentinel: HTMLElement): Map<string, number> {
  const widths = new Map<string, number>()
  const els = sentinel.querySelectorAll<HTMLElement>('[data-toolbar-item-key]')
  for (const el of els) {
    const key = el.getAttribute('data-toolbar-item-key')
    if (!key) continue
    widths.set(key, el.getBoundingClientRect().width)
  }
  return widths
}

/**
 * Compute which items fit inside `containerWidth` after dropping the
 * lowest-priority items first. Separators are kept only when both
 * surrounding groups still have a visible button.
 */
export function computeOverflow<T extends ToolbarItem>(
  items: readonly T[],
  containerWidth: number,
  itemWidths: Map<string, number>,
  overflowTriggerWidth: number,
): UseToolbarOverflowResult<T> {
  if (containerWidth <= 0) {
    // Container hasn't been measured yet — show everything, defer split.
    return { visible: items.slice(), overflowed: [] }
  }

  // ── Helpers ───────────────────────────────────────────────────────
  const widthOf = (item: T): number => {
    const base = itemWidths.get(item.key) ?? 0
    if (item.kind === 'button' && item.isPopoverTrigger) {
      return base + POPOVER_TRIGGER_VARIABLE_RESERVE_PX
    }
    return base
  }

  /** Total width of items, treating separators as kept iff both adjacent
   * groups have a kept button. */
  const totalKeptWidth = (droppedKeys: Set<string>): number => {
    let total = 0
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item) continue
      if (item.kind === 'button') {
        if (!droppedKeys.has(item.key)) total += widthOf(item)
      } else {
        // separator — include only if both sides have at least one kept
        // button.
        const hasBefore = items
          .slice(0, i)
          .some((b) => b.kind === 'button' && !droppedKeys.has(b.key))
        const hasAfter = items
          .slice(i + 1)
          .some((b) => b.kind === 'button' && !droppedKeys.has(b.key))
        if (hasBefore && hasAfter) total += widthOf(item)
      }
    }
    return total
  }

  // First pass: do all items fit without an overflow trigger?
  const noDrops = new Set<string>()
  if (totalKeptWidth(noDrops) <= containerWidth) {
    return { visible: items.slice(), overflowed: [] }
  }

  // Need overflow. Budget excludes the trigger button.
  const budget = Math.max(0, containerWidth - overflowTriggerWidth)

  // Sort buttons by drop-order: ascending priority first; later-positioned
  // first within ties (so trailing items collapse before leading ones).
  const buttons = items
    .map((item, idx) => ({ item, idx }))
    .filter((b): b is { item: T & { kind: 'button' }; idx: number } => b.item.kind === 'button')

  const dropOrder = buttons.slice().sort((a, b) => {
    if (a.item.priority !== b.item.priority) return a.item.priority - b.item.priority
    return b.idx - a.idx
  })

  const droppedKeys = new Set<string>()
  for (const candidate of dropOrder) {
    if (totalKeptWidth(droppedKeys) <= budget) break
    droppedKeys.add(candidate.item.key)
  }

  const visible: T[] = []
  const overflowed: T[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item) continue
    if (item.kind === 'button') {
      if (droppedKeys.has(item.key)) overflowed.push(item)
      else visible.push(item)
    } else {
      const hasBefore = items
        .slice(0, i)
        .some((b) => b.kind === 'button' && !droppedKeys.has(b.key))
      const hasAfter = items
        .slice(i + 1)
        .some((b) => b.kind === 'button' && !droppedKeys.has(b.key))
      if (hasBefore && hasAfter) visible.push(item)
      // separators never go to overflowed
    }
  }

  return { visible, overflowed }
}

export function useToolbarOverflow<T extends ToolbarItem>(
  containerRef: RefObject<HTMLElement | null>,
  sentinelRef: RefObject<HTMLElement | null>,
  items: readonly T[],
  overflowTriggerWidth: number = OVERFLOW_TRIGGER_WIDTH_PX,
): UseToolbarOverflowResult<T> {
  const [containerWidth, setContainerWidth] = useState(0)
  const [itemWidths, setItemWidths] = useState<Map<string, number>>(() => new Map())

  // Observe container width. Callback-only-setState keeps us out of the
  // ResizeObserver-loop hazard.
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return

    // Seed with the current width so the first render has a budget.
    setContainerWidth(el.clientWidth)

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      // contentRect.width is the inline-size; matches clientWidth for
      // box-sizing: content-box and is close enough for border-box.
      setContainerWidth(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [containerRef])

  // Measure sentinel children whenever items change. Layout effect so
  // the measurement happens before paint. The function body doesn't
  // close over `items` directly — it reads widths from the DOM — but
  // we DO want to re-measure when the items array reference changes
  // (caller's useMemo deps drive identity). oxlint flags `items` as
  // unnecessary here; that's the rare case where the React-hooks-style
  // "use as a re-run trigger" pattern is intentional.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- items is the re-run trigger; the function body reads from sentinelRef.current
  useLayoutEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const next = readSentinelWidths(el)
    setItemWidths((prev) => {
      // Skip re-render when widths are stable.
      if (prev.size === next.size) {
        let same = true
        for (const [k, v] of next) {
          if (prev.get(k) !== v) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return next
    })
  }, [items, sentinelRef])

  return useMemo(
    () => computeOverflow(items, containerWidth, itemWidths, overflowTriggerWidth),
    [items, containerWidth, itemWidths, overflowTriggerWidth],
  )
}
