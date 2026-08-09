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

  // Mount the roving-focus row when it belongs to this group, so the panel's
  // `aria-activedescendant` target exists and `useFocusedRowEffect` can find it
  // by `data-backlink-item` to paint the focus ring.
  const activeIndex = activeBlockId ? blocks.findIndex((b) => b.id === activeBlockId) : -1
  useEffect(() => {
    if (activeIndex < 0) return
    virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
  }, [activeIndex, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

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
        className,
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
    </ul>
  )
}
