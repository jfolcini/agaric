/**
 * VirtualizedResultListbox — one page-group's `role="listbox"`, windowed
 * With `@tanstack/react-virtual`.
 *
 * Why per-group virtualization? The search a11y model renders
 * ONE `<ul role="listbox">` per expanded page-group, each with its own
 * `aria-activedescendant`. We keep that model exactly — this component is
 * a drop-in replacement for the single group `<ul>` formerly produced by
 * `CollapsibleGroupList`'s default path, so the listbox count, roles,
 * `data-testid`s, and the roving `focusedIndex → aria-activedescendant`
 * contract are all preserved. We just stop mounting every row of a group
 * eagerly: a group with hundreds/thousands of blocks (up to the 5000-item
 * cap across all groups) now mounts only its visible window plus overscan.
 *
 * A11y under virtualization — the load-bearing detail:
 *   `aria-activedescendant` must point at an element that EXISTS in the
 *   DOM. When the keyboard roving focus lands on a row in THIS group, the
 *   virtualizer is told to scroll that row into view (`scrollToIndex`),
 *   which mounts it, so the active descendant id always resolves. The
 *   parent (`SearchResultGroups`) only passes a non-null `activeRowId`
 *   to the group that owns the focused row, so only that group scrolls /
 *   announces.
 *
 * Each row is rendered by `renderRow(block, style, measureRef)`:
 *   - `style` absolutely positions the row at its virtual offset.
 *   - `measureRef` is the virtualizer's `measureElement`, attached to the
 *     row so its real height corrects the estimate after first paint
 *     (rows are `line-clamp-2`, so heights vary by 1–2 lines).
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import type React from 'react'
import { useEffect, useRef } from 'react'

import type { SearchBlockRow } from '@/lib/bindings'

export interface VirtualizedResultListboxProps {
  blocks: SearchBlockRow[]
  /** DOM id of the row that should drive `aria-activedescendant`, or
   *  `undefined` when the focused row is not in this group. */
  activeRowId: string | undefined
  /** Index (within `blocks`) of the active row, or `-1`. Drives
   *  `scrollToIndex` so the active row is mounted + visible. */
  activeRowIndex: number
  ariaLabel: string | undefined
  tabIndex: number | undefined
  dataTestId: string | undefined
  onKeyDown: (e: React.KeyboardEvent<HTMLUListElement>) => void
  /** Render a single row, positioned via `style`, measured via `ref`.
   *  `index` is the row's index within `blocks` (== the virtual index),
   *  used for the `data-index` the virtualizer's `measureElement` reads. */
  renderRow: (
    block: SearchBlockRow,
    style: React.CSSProperties,
    measureRef: (el: HTMLElement | null) => void,
    index: number,
  ) => React.ReactNode
}

export function VirtualizedResultListbox({
  blocks,
  activeRowId,
  activeRowIndex,
  ariaLabel,
  tabIndex,
  dataTestId,
  onKeyDown,
  renderRow,
}: VirtualizedResultListboxProps): React.ReactElement {
  const scrollRef = useRef<HTMLUListElement>(null)

  // oxlint-disable-next-line react/incompatible-library -- The Compiler skips memoizing a component that calls this API, so nothing virtualizer-derived is cached inside this component; the residual hazard the diagnostic names is such a value reaching a MEMOIZED consumer. The row rendered through `renderRow` is `SearchResultBlockRow`, which IS `memo`: what crosses is `measureElement` (constructor-bound, identity never changes) and a `style` object literal rebuilt from `vi.start` on every render, so the shallow compare misses unconditionally and the row always paints at the current offset. react-virtual 3.14.10 builds the Virtualizer once (`useState(() => new Virtualizer(...))`) and virtual-core 3.17.8 assigns `measureElement` in the constructor, so the function identities the rule names never change; what does change per render is `getVirtualItems()`/`getTotalSize()`. (#4409)
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    // Rows are `px-3 py-1.5 text-sm` with `line-clamp-2`; one line is
    // ~36px, two lines ~52px. Estimate the common 1-line case; the
    // `measureElement` ref corrects to the real height after first paint.
    estimateSize: () => 36,
    overscan: 8,
    getItemKey: (index) => blocks[index]?.id ?? index,
  })

  // a11y contract: when the roving focus lands on a row in THIS group,
  // mount + scroll it into view so `aria-activedescendant` resolves to a
  // real element. Other groups receive `activeRowIndex === -1` and skip.
  //
  // FE-A5: `scrollToIndex` only scrolls WITHIN this group's own
  // `overflow-y-auto` container — it cannot bring the active row into view
  // when the row is below the page fold (e.g. a later group's row reached by
  // cross-group roving). After the virtualizer has mounted the row, do a
  // second, page-level `scrollIntoView({ block: 'nearest' })` on the active
  // row element so the outer/page scroller follows the active descendant
  // too. `block: 'nearest'` is a no-op when the row is already visible, so
  // this never hijacks scroll position unnecessarily.
  //
  // CR-A11Y (#151): each page-group is its own `role="listbox"` and only the
  // group owning the focused row carries `aria-activedescendant`. DOM focus,
  // however, stays put when roving arrows cross a group boundary — so after a
  // boundary crossing the focused `<ul>` is the OLD group, which no longer
  // exposes `aria-activedescendant`, and the screen reader loses the active
  // descendant. Fix: when THIS group becomes the active one (gains a non-null
  // `activeRowId`), move DOM focus onto its `<ul>` so the focused element is
  // always the listbox that points at the active option. We focus AFTER
  // `scrollToIndex` has mounted the active row, so the freshly-focused
  // listbox's `aria-activedescendant` already resolves to a real descendant.
  useEffect(() => {
    if (activeRowIndex < 0) return
    virtualizer.scrollToIndex(activeRowIndex, { align: 'auto' })
    if (!activeRowId) return
    // The row may have only just been mounted by `scrollToIndex`; resolve it
    // by its `aria-activedescendant` id and bubble the scroll up the page.
    const el = scrollRef.current?.ownerDocument.getElementById(activeRowId)
    el?.scrollIntoView?.({ block: 'nearest' })
    // Move DOM focus to this (now-active) listbox ONLY when the user is
    // already roving the results — i.e. DOM focus currently sits on a DIFFERENT
    // results listbox (a sibling page-group). That is exactly the group-
    // boundary crossing this fixes: arrows took the active row into the next
    // group, but DOM focus stayed on the previous group's `<ul>`, which no
    // longer carries `aria-activedescendant`. We deliberately do NOT focus
    // when the active element is the search input or anything outside the
    // results region, so initial render / typing never steals focus from the
    // input. The active option is mounted by the `scrollToIndex` above, so the
    // freshly-focused listbox's `aria-activedescendant` resolves immediately.
    const ul = scrollRef.current
    const active = ul?.ownerDocument.activeElement
    const focusIsOnAnotherResultListbox =
      active instanceof HTMLElement &&
      active !== ul &&
      active.classList.contains('search-result-listbox')
    if (ul && focusIsOnAnotherResultListbox) {
      ul.focus({ preventScroll: true })
    }
  }, [activeRowIndex, activeRowId, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <ul
      ref={scrollRef}
      // `max(…, 12rem)` floors the viewport-derived cap. It does NOT guard
      // against the Android soft keyboard: per #4313 (see the cap comment on
      // `PopoverContent` in `src/components/ui/popover.tsx`), Android
      // (edge-to-edge / targetSdk 36) shrinks only the VISUAL viewport when
      // the IME opens — `100dvh`, `100vh` and `innerHeight` keep reporting
      // the full screen, which is the same fact `computeKeyboardInset`
      // (`lib/keyboard-inset.ts`) is built on. So `100dvh - 320px` is
      // unaffected by the keyboard either way. What the floor actually
      // protects against is a genuinely SHORT viewport — a landscape phone,
      // a small desktop window, an embedded webview — where `100dvh` itself
      // is small enough that subtracting a fixed 320px leaves little or
      // nothing. The floor keeps ~5 rows visible in that case; small groups
      // are unaffected (their intrinsic height is below the cap either way).
      //
      // #737 — in-flow `::before` spacer instead of `height: totalSize` on
      // the `<ul>` itself. The `<ul>` is the SCROLL CONTAINER (max-h cap +
      // overflow-y-auto): an element cannot overflow itself with its own
      // height declaration, so once totalSize exceeded the cap, scrollHeight
      // was determined solely by the mounted window+overscan rows — the
      // scrollbar thumb misrepresented the list and a far `scrollToIndex`
      // (End/PageDown) clamped to the current scrollHeight, leaving the
      // active row unmounted and `aria-activedescendant` dangling. The
      // pseudo-element reserves the full `totalSize` IN FLOW (the
      // absolutely-positioned rows are out of flow), so
      // `scrollHeight == totalSize` while only the window mounts. A pseudo-
      // element is used (not an inner spacer `<div>`) so the listbox's only
      // DOM children remain `<li role="option">` rows — an element spacer
      // trips axe's `aria-required-children` rule (the reason the previous
      // inner spacer was removed).
      className="search-result-listbox ml-4 mt-1 list-none p-0 relative max-h-[max(calc(100dvh-320px),12rem)] overflow-y-auto before:content-[''] before:block before:w-px before:h-[var(--vrl-total-size)]"
      aria-label={ariaLabel}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role, jsx-a11y/prefer-tag-over-role -- `<ul role="listbox">` is the canonical WAI-ARIA listbox container; the search a11y model requires per-group listboxes. Keyboard activation flows through `aria-activedescendant`, so the `<ul>` itself is the right host. A virtualized custom listbox can't be a <datalist>/<select> (those can't host the absolutely-positioned virtual rows).
      role="listbox"
      aria-activedescendant={activeRowId}
      tabIndex={tabIndex}
      data-testid={dataTestId}
      onKeyDown={onKeyDown}
      // Custom property feeds the `before:` spacer height above; custom
      // properties inherit into pseudo-elements, and this is the only way
      // to give a pseudo-element a per-render dynamic height without
      // injecting a stylesheet.
      style={{ '--vrl-total-size': `${totalSize}px` } as React.CSSProperties}
    >
      {virtualItems.map((vi) => {
        const block = blocks[vi.index]
        if (!block) return null
        const style: React.CSSProperties = {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: `translateY(${vi.start}px)`,
        }
        return renderRow(block, style, virtualizer.measureElement, vi.index)
      })}
    </ul>
  )
}
