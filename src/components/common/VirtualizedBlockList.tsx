/**
 * VirtualizedBlockList — one expanded group's block `<ul>`, windowed with
 * `@tanstack/react-virtual` (#3316 item 3).
 *
 * Why this exists: `CollapsibleGroupList`'s default path mapped over EVERY
 * block of EVERY expanded group with no virtualizer and no cap, and both
 * reference panels use that path. A page referenced by 20 source pages with
 * `MAX_BLOCKS_PER_GROUP` (200) matching blocks each commits ~4,000 `<li>`
 * elements plus their PageLink/badge subtrees in one synchronous render —
 * directly above the page editor the user is typing in — and each "Load more"
 * appends up to 4,000 more, all retained. UnlinkedReferences default-expands
 * every group, so it pays the whole bill at once.
 *
 * This is the same per-group windowing `VirtualizedResultListbox` already does
 * for search results, minus the listbox/`aria-activedescendant` machinery: the
 * reference panels put `aria-activedescendant` on the OUTER `role="group"`
 * container (rows carry interactive controls, so the listbox/option model is
 * out — see the #2263 comments in the panels), and the roving focus ring is
 * applied by `useFocusedRowEffect` via a DOM query on `data-backlink-item`.
 *
 * The load-bearing consequence of windowing is therefore: **the focused row
 * must be mounted**, or both `aria-activedescendant` and the focus ring dangle.
 * `activeBlockId` is scrolled into view via `scrollToIndex` whenever it belongs
 * to THIS group, which mounts it; groups that don't own the focused row skip
 * the effect entirely.
 *
 * Rows are rendered by the caller through `renderBlock(block, ctx)`:
 *   - `ctx.style` absolutely positions the row at its virtual offset.
 *   - `ctx.measureRef` is the virtualizer's `measureElement`; attach it to the
 *     row so its real height corrects the estimate after first paint.
 *   - `ctx.index` is the row's index within `blocks`, for the `data-index`
 *     attribute `measureElement` reads.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import type React from 'react'
import { useEffect, useRef } from 'react'

import { cn } from '@/lib/utils'

/**
 * Estimated row height in px. Reference rows carry the same class stack as the
 * search result rows (`px-2/px-3 py-1.5 text-sm` + a 1px divider) whose
 * estimate is 36 in `VirtualizedResultListbox.tsx`; this reuses that value
 * rather than inventing a second one. It is only a first-paint estimate —
 * `measureElement` replaces it with each row's real height, so a wrong guess
 * costs a re-measure, not a layout bug.
 */
const ESTIMATED_ROW_HEIGHT = 36

/**
 * Rows mounted outside the visible window. Same value as
 * `VirtualizedResultListbox`.
 */
const OVERSCAN = 8

/**
 * Height cap for one group's scroll viewport. Reuses the search listbox's
 * expression verbatim (`VirtualizedResultListbox.tsx`): `max(…, 12rem)` floors
 * the viewport-derived cap so that with the Android soft keyboard up — where
 * `100dvh` shrinks far enough that `100dvh - 320px` collapses to a sliver —
 * roughly five rows stay visible. Groups shorter than the cap are unaffected:
 * their intrinsic height is below it either way, so no scrollbar appears.
 */
const GROUP_VIEWPORT_CLASS = 'max-h-[max(calc(100dvh-320px),12rem)] overflow-y-auto'

/**
 * Matches a Tailwind vertical-spacing utility, including variant prefixes
 * (`sm:`, `dark:`, …) and arbitrary values (`space-y-[3px]`).
 */
const SPACE_Y_UTILITY = /(?:^|:)space-y-/

/** Ref for the off-window focus anchor — see the anchor comment in the body. */
const NOOP_MEASURE_REF = (): void => {}

/**
 * Strip `space-y-*` from a caller-supplied `<ul>` class list.
 *
 * `space-y-1` compiles to `& > :not([hidden]) ~ :not([hidden]) { margin-top }`,
 * and `margin-top` DOES displace an absolutely-positioned box: with `top: 0`,
 * CSS places the box's MARGIN edge at the offset, so the border box lands
 * `margin-top` px lower than the `transform: translateY(start)` the virtualizer
 * computed. Every mounted row but the first would sit 4px below its virtual
 * offset — and because the window slides as the user scrolls, *which* row is
 * "first" changes, so the gap visibly jumps.
 *
 * Both reference panels pass `space-y-1` through `listClassName` (it is correct
 * for the unvirtualized `<ul>`, where rows are in flow). Rather than making
 * every caller remember which layout mode it is in, the windowed list — which
 * owns row positioning outright — drops the utility itself.
 */
export function stripSpaceY(className: string | undefined): string | undefined {
  if (!className) return className
  const kept = className.split(/\s+/).filter((token) => token && !SPACE_Y_UTILITY.test(token))
  return kept.join(' ')
}

/** Per-row virtualization context handed to `renderBlock`. */
export interface VirtualRowContext {
  /** Absolute positioning at the row's virtual offset. Spread onto the `<li>`. */
  style: React.CSSProperties
  /** The virtualizer's `measureElement`. Attach as the `<li>`'s ref. */
  measureRef: (el: HTMLElement | null) => void
  /** Index within `blocks` — set as `data-index` for `measureElement`. */
  index: number
}

export interface VirtualizedBlockListProps<B extends { id: string }> {
  blocks: readonly B[]
  /** Caller's `<ul>` classes; the windowing classes are appended. */
  className?: string | undefined
  ariaLabel?: string | undefined
  /**
   * The block currently holding roving keyboard focus, or `null`. When it lives
   * in this group it is scrolled into view so it is mounted and the outer
   * container's `aria-activedescendant` resolves to a real element.
   */
  activeBlockId?: string | null | undefined
  /** Render one row. MUST return an `<li>` carrying `ctx.style`/`ctx.measureRef`. */
  renderBlock: (block: B, ctx: VirtualRowContext) => React.ReactNode
}

export function VirtualizedBlockList<B extends { id: string }>({
  blocks,
  className,
  ariaLabel,
  activeBlockId,
  renderBlock,
}: VirtualizedBlockListProps<B>): React.ReactElement {
  const scrollRef = useRef<HTMLUListElement>(null)

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => blocks[index]?.id ?? index,
  })

  // Bring the roving-focus row into view when it belongs to this group.
  const activeIndex = activeBlockId ? blocks.findIndex((b) => b.id === activeBlockId) : -1
  useEffect(() => {
    if (activeIndex < 0) return
    virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
  }, [activeIndex, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  // `scrollToIndex` alone is NOT enough to keep the roving focus valid.
  // `useListKeyboardNavigation` defaults to `wrap: true`, so ArrowUp at index 0
  // jumps to the LAST row of the LAST group — far outside `overscan`. The
  // virtualizer remounts the window only after the scroll it schedules lands,
  // but the panel's `useFocusedRowEffect` runs in the SAME commit as the focus
  // change and never re-runs (its deps are keyed on the focused row id, which
  // does not change again). So the ring is never painted, and — worse — the
  // container's `aria-activedescendant` names an element that is not in the
  // document. A dangling `aria-activedescendant` is a real a11y regression
  // against the unvirtualized list it replaces.
  //
  // Fix: always mount the active row, even when it falls outside the window, so
  // it exists in the same commit that focus moves to it. It is off-screen by
  // definition until `scrollToIndex` lands, at which point the window contains
  // it and the anchor is dropped — so it is never rendered twice and its
  // estimate-based offset is never the offset the user actually sees.
  const activeIsWindowed = virtualItems.some((vi) => vi.index === activeIndex)
  const anchorBlock = activeIndex >= 0 && !activeIsWindowed ? blocks[activeIndex] : undefined

  return (
    <ul
      ref={scrollRef}
      // #737 (same fix as the search listbox): the `<ul>` IS the scroll
      // container, and an element cannot overflow itself with its own `height`
      // declaration — so an in-flow `::before` spacer reserves the full
      // `totalSize` while only the window mounts, keeping `scrollHeight ==
      // totalSize` so the scrollbar is honest and a far `scrollToIndex` cannot
      // clamp short. A pseudo-element (not a spacer `<div>`) keeps the list's
      // only DOM children `<li>`s.
      className={cn(
        stripSpaceY(className),
        'relative list-none',
        GROUP_VIEWPORT_CLASS,
        "before:content-[''] before:block before:w-px before:h-[var(--vbl-total-size)]",
      )}
      aria-label={ariaLabel}
      // Custom properties inherit into pseudo-elements; this is the only way to
      // give the spacer a per-render dynamic height without injecting CSS.
      style={{ '--vbl-total-size': `${totalSize}px` } as React.CSSProperties}
    >
      {virtualItems.map((vi) => {
        const block = blocks[vi.index]
        if (!block) return null
        return renderBlock(block, {
          style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${vi.start}px)`,
          },
          measureRef: virtualizer.measureElement,
          index: vi.index,
        })
      })}
      {anchorBlock
        ? renderBlock(anchorBlock, {
            style: {
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${activeIndex * ESTIMATED_ROW_HEIGHT}px)`,
            },
            // No `measureRef`: this row is transient and off-screen, and
            // reporting a measurement for it would perturb the virtualizer's
            // size cache from outside the window it is currently tracking. The
            // real measurement is taken when the row enters the window.
            measureRef: NOOP_MEASURE_REF,
            index: activeIndex,
          })
        : null}
    </ul>
  )
}
