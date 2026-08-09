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
 *   - `ctx.isLast` says whether the row is the last of the WHOLE group, so a
 *     caller can draw the "no divider under the final row" rule without the
 *     `last:` CSS variant, which under windowing matches the last MOUNTED row.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'

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
  /**
   * Whether this row is the last of the WHOLE group (`index === blocks.length -
   * 1`), not merely the last one currently mounted.
   *
   * #3732/#3733 note 4: the panels' rows carry `border-b last:border-b-0`, and
   * under windowing the CSS `:last-child` matches the last row of the *window*.
   * The divider therefore disappears from a row in the middle of the list and
   * the gap migrates as the user scrolls. Callers on the windowed path must
   * branch on this flag instead of the `last:` variant; the unvirtualized path
   * (no context at all) keeps `last:border-b-0`, where `:last-child` and "last
   * row" coincide.
   */
  isLast: boolean
}

/** One row this render commits: a windowed row, or the off-window focus anchor. */
interface WindowedRow<B> {
  block: B
  index: number
  start: number
  /** Anchor rows are transient and off-screen — see `NOOP_MEASURE_REF`. */
  measured: boolean
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

  // #3732 note 3 — `BacklinkRow` is `memo`'d precisely so the panel
  // re-rendering on every arrow-key / focus change does not rebuild every
  // mounted row's element tree (#2193). A fresh `style` object literal per
  // render makes that memo compare unequal every single time, so the
  // optimization was silently lost for exactly the rows that are mounted.
  // The style is a pure function of the row's `start` offset, so caching by
  // offset hands back a stable reference for as long as a row does not move.
  // Bounded by the number of distinct offsets in the list (<= `blocks.length`,
  // itself capped at `MAX_BLOCKS_PER_GROUP`); re-measuring can churn it past
  // that, so the cache evicts.
  //
  // #3738 note 3 — the eviction is LRU by ACCESS, not a wholesale `clear()`.
  // `clear()` dropped entries for rows that had ALREADY been served earlier in
  // the same render pass, so the very next render handed every one of them a
  // fresh object and `BacklinkRow`'s `memo` missed for the whole window — not
  // just for the rows whose offsets were actually churning. Insertion order is
  // no good either: `Map.set` on an existing key does not reorder, so the
  // oldest-inserted key is typically a row still on screen (offset 0 is
  // inserted first and is almost always live) while the churned, dead offsets
  // sit at the end. Re-inserting on a hit makes the map's iteration order a
  // true recency order, so eviction takes the offsets nothing has asked for.
  const styleCacheRef = useRef(new Map<number, React.CSSProperties>())
  const rowCount = blocks.length
  const styleForOffset = useCallback(
    (start: number): React.CSSProperties => {
      const cache = styleCacheRef.current
      const hit = cache.get(start)
      if (hit) {
        // Move to the most-recently-used end (delete + set; `set` alone on an
        // existing key leaves iteration order untouched).
        cache.delete(start)
        cache.set(start, hit)
        return hit
      }
      // At least one entry, so a single-row list can still cache. Two per row
      // leaves headroom for a re-measure moving every mounted row exactly once
      // before anything is evicted.
      const capacity = Math.max(rowCount * 2, 1)
      while (cache.size >= capacity) {
        const oldest = cache.keys().next()
        if (oldest.done) break
        cache.delete(oldest.value)
      }
      const style: React.CSSProperties = {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${start}px)`,
      }
      cache.set(start, style)
      return style
    },
    [rowCount],
  )

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

  // The anchor is spliced into the SAME keyed array as the windowed rows, in
  // index order — it is deliberately not a second child slot of the `<ul>`.
  //
  // #3733 note 3: React scopes reconciliation keys to the child slot they were
  // produced in (`.0:$B29` inside the mapped array vs `.$B29` for a standalone
  // second child). With the anchor in its own slot, the moment `scrollToIndex`
  // lands and the window catches up to it, the row's key moves slots: React
  // unmounts the anchor `<li>` and mounts a fresh one. `useFocusedRowEffect`
  // applies `LinkedReferences`' focus ring imperatively (`classList.add`) to
  // the node it looked up, and its deps are keyed on `focusedRowId`, which has
  // not changed — so the effect does not re-run and the ring is left on a
  // detached node. Keeping one array keeps the key stable, so React MOVES the
  // existing DOM node instead of replacing it and the imperative classes ride
  // along. `measureRef`/`style`/`data-index` are then just prop updates on the
  // surviving element.
  const rows: WindowedRow<B>[] = []
  for (const vi of virtualItems) {
    const block = blocks[vi.index]
    if (block) rows.push({ block, index: vi.index, start: vi.start, measured: true })
  }
  if (anchorBlock) {
    const anchorRow: WindowedRow<B> = {
      block: anchorBlock,
      index: activeIndex,
      start: activeIndex * ESTIMATED_ROW_HEIGHT,
      measured: false,
    }
    const at = rows.findIndex((r) => r.index > activeIndex)
    if (at === -1) rows.push(anchorRow)
    else rows.splice(at, 0, anchorRow)
  }

  const lastIndex = blocks.length - 1

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
      {rows.map((row) =>
        renderBlock(row.block, {
          style: styleForOffset(row.start),
          // The anchor gets no real `measureRef`: nothing in this component
          // asks the virtualizer to size a row it is not currently tracking.
          // The real measurement is taken when the row enters the window — at
          // which point this prop flips to `measureElement` on the same,
          // surviving DOM node.
          //
          // #3738 note 4 — this is NOT a guarantee that an anchored row goes
          // unmeasured, and the comment used to imply it was. That held while
          // a row leaving the window unmounted; since the anchor shares the
          // rows array (see the key-stability comment above) the same `<li>`
          // now survives the window→anchor direction, and the ref swap calls
          // `measureElement(null)`, which in virtual-core 3.17.x prunes only
          // DISCONNECTED nodes from `elementsCache` — this one is still in the
          // document, so its ResizeObserver registration outlives the swap and
          // a resize while anchored still reaches `resizeItem`. Harmless: the
          // row keeps its real `data-index`, which is what `indexFromElement`
          // reads, so any height it reports lands on its own item and is the
          // height that item really has.
          measureRef: row.measured ? virtualizer.measureElement : NOOP_MEASURE_REF,
          index: row.index,
          isLast: row.index === lastIndex,
        }),
      )}
    </ul>
  )
}
