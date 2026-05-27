/**
 * RecentPagesStrip — desktop-only chip row labelled via `t('recent.ariaLabel')` (FEAT-9).
 *
 * Mounted at the app-shell level between the hoisted `<TabBar />` (FEAT-7)
 * and the `<ViewHeaderOutletSlot />` (UX-198). Reads the MRU list from
 * `useRecentPagesStore` and renders one `<RecentPageChip>` per entry,
 * excluding the currently-open page so the strip shows places the user
 * might want to jump *back* to.
 *
 * Single-line horizontal scroll layout (PEND-32): chips stay on one row
 * inside a `<ScrollArea orientation="horizontal">`. Chip text truncates
 * with a `title` tooltip for hover context. Strip vertical chrome is
 * bounded to ~36 px regardless of recent-page count or viewport width —
 * the wrap-to-second-row behaviour of the previous CSS-grid layout is
 * gone.
 *
 * Click semantics mirror the rest of the app:
 * - Plain click → `navigateToPage`.
 * - Ctrl/Cmd+click or middle-click → `openInNewTab` (matches block/page-link
 *   convention).
 *
 * Keyboard semantics (UX-256):
 * - Roving tabindex across the chip row — Tab lands on the focused chip,
 *   ArrowLeft/ArrowRight traverse (wrapping), Enter/Space activates via
 *   `navigateToPage` (same as plain click; modifier-click is the only path
 *   to `openInNewTab`).
 * - Powered by the shared `useListKeyboardNavigation` hook; DOM focus is
 *   moved imperatively in a `useEffect` so screen readers announce each
 *   chip as the user traverses. Focus only moves when the strip already
 *   owns focus — avoids stealing focus on mount / re-render.
 * - The same effect calls `scrollIntoView({ inline: 'nearest' })` on the
 *   newly-focused chip so off-screen chips are revealed automatically
 *   during arrow-key traversal (PEND-32). Honours `prefers-reduced-motion`
 *   by falling back to `behavior: 'auto'`.
 *
 * Mouse wheel (PEND-32): vertical wheel deltas over the strip translate
 * to horizontal scroll. Trackpad two-finger horizontal swipes (which set
 * `deltaX` natively) fall through untouched via the `|deltaY| > |deltaX|`
 * dominance guard.
 *
 * Auto-hidden when:
 * - `useIsMobile()` is true (desktop-only affordance).
 * - The visible list is empty (no visits yet, or the only visit *is* the
 *   currently-open page).
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RecentPageChip } from '@/components/ui/recent-page-chip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useIsMobile } from '../hooks/useIsMobile'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { getPageDisplayName } from '../lib/page-display'
import {
  type PageRef,
  selectRecentPagesForSpace,
  useRecentPagesStore,
} from '../stores/recent-pages'
import { useSpaceStore } from '../stores/space'
import { selectActiveTabIndexForSpace, selectTabsForSpace, useTabsStore } from '../stores/tabs'

export function RecentPagesStrip(): React.ReactElement | null {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  // FEAT-3 Phase 3 — both the MRU list and the active-page exclusion are
  // per-space so a recent visit in space-A doesn't surface in space-B.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const recentPages = useRecentPagesStore((s) => selectRecentPagesForSpace(s, currentSpaceId))

  // Derive the currently-open pageId from the active tab's stack top so we
  // can exclude it from the strip. `undefined` when no tab or no stack —
  // in that case we render every recent page (nothing to exclude).
  const activePageId = useTabsStore((s) => {
    const tabs = selectTabsForSpace(s, currentSpaceId)
    const idx = selectActiveTabIndexForSpace(s, currentSpaceId)
    const active = tabs[idx]
    return active && active.pageStack.length > 0
      ? active.pageStack[active.pageStack.length - 1]?.pageId
      : undefined
  })

  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const openInNewTab = useTabsStore((s) => s.openInNewTab)

  const visible = recentPages.filter((p) => p.pageId !== activePageId)

  // UX-256: arrow-key traversal across the chip row using the shared hook.
  // The hook must be called unconditionally (rules of hooks) and BEFORE the
  // mobile / empty-state early returns below. When `visible.length === 0`
  // the hook's own `handleKeyDown` early-returns (itemCount === 0 guard),
  // so the wiring is safe even when the strip doesn't render.
  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: visible.length,
    horizontal: true,
    wrap: true,
    onSelect: (index) => {
      const ref = visible[index]
      if (ref != null) {
        navigateToPage(ref.pageId, ref.title)
      }
    },
  })

  // Imperative focus management so screen readers announce the newly-focused
  // chip after arrow-key traversal. Only move DOM focus when focus is already
  // inside the strip — avoids stealing focus on mount and on itemCount-driven
  // resets of `focusedIndex` to 0 (e.g., when a visit is recorded elsewhere).
  // Also scroll the focused chip into view so off-screen chips get revealed
  // when the user traverses past the visible window (PEND-32).
  const buttonRefs = useRef(new Map<number, HTMLButtonElement | null>())

  useEffect(() => {
    const activeEl = document.activeElement
    const isInsideStrip = Array.from(buttonRefs.current.values()).some((btn) => btn === activeEl)
    if (!isInsideStrip) return
    const target = buttonRefs.current.get(focusedIndex)
    if (target == null) return
    target.focus()
    // PEND-32: only one inline read in the codebase today; per AGENTS.md
    // "Simplicity First" we don't lift this into a dedicated hook until a
    // second consumer appears. The global CSS rule in `index.css` already
    // forces `scroll-behavior: auto` under reduced motion, but
    // `scrollIntoView({ behavior: 'smooth' })` overrides that — the JS
    // option needs to be passed explicitly.
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    })
  }, [focusedIndex])

  const handleClick = useCallback(
    (ref: PageRef, e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey || e.button === 1) {
        e.preventDefault()
        // Guarded: openInNewTab is a no-op on mobile per FEAT-7 policy,
        // but the strip is mobile-hidden anyway — defensive.
        openInNewTab(ref.pageId, ref.title)
        return
      }
      navigateToPage(ref.pageId, ref.title)
    },
    [navigateToPage, openInNewTab],
  )

  // PEND-32: translate vertical wheel deltas to horizontal scroll when the
  // cursor is over the strip. Trackpad two-finger horizontal swipes already
  // populate `deltaX` natively, so let those through (the `|deltaY| >
  // |deltaX|` dominance guard skips the handler in that case). Shift+wheel
  // is also covered: the browser maps Shift+wheel to horizontal natively;
  // our handler runs first, prevents the default, and applies the same
  // delta — net behaviour is identical.
  //
  // Invariant: the strip MUST NOT be nested inside a scrollable parent.
  // The `preventDefault()` here intercepts the wheel event before it can
  // bubble, so a scrollable ancestor would silently lose vertical scroll
  // when the cursor crosses the strip. The strip is mounted at the app-
  // shell level (`<App>` → between `<TabBar>` and `<ViewHeaderOutletSlot>`),
  // which is not scrollable. If that ever changes, revisit this handler
  // (drop `preventDefault`, or guard on a parent-scroll check).
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.currentTarget.scrollLeft += e.deltaY
      e.preventDefault()
    }
  }, [])

  // MAINT-211: right-edge fade when content overflows the viewport.
  const viewportRef = useRef<HTMLDivElement>(null)
  const [hasOverflow, setHasOverflow] = useState(false)

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const check = () => setHasOverflow(el.scrollWidth > el.clientWidth)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (isMobile) return null
  if (visible.length === 0) return null

  return (
    <nav
      aria-label={t('recent.ariaLabel')}
      className="border-b border-border/40 bg-background"
      data-testid="recent-pages-strip"
      onKeyDown={(e) => {
        // The hook returns true when the key was consumed (arrow keys,
        // Enter, Space). `preventDefault` stops the browser from scrolling
        // on Arrow keys and from triggering a surrounding form's default
        // on Enter. ArrowUp/ArrowDown fall through untouched because the
        // hook is in `horizontal` mode — they only bind Left/Right.
        if (handleKeyDown(e)) e.preventDefault()
      }}
    >
      {/*
        PEND-32: no `pb-2` on viewport / no reserved scrollbar space.
        Radix's horizontal scrollbar is auto-hide and adds ~10 px of
        bottom inset only while visible. The induced shift is vertical,
        not horizontal, so the chip row's alignment is unaffected. If
        real-world feedback ever flags the jitter, add
        `viewportClassName="pb-2"` to reserve the inset.
      */}
      <ScrollArea
        orientation="horizontal"
        className="w-full"
        viewportRef={viewportRef}
        viewportClassName="overscroll-x-contain"
        viewportProps={{
          onWheel: handleWheel,
          style: hasOverflow
            ? { maskImage: 'linear-gradient(to right, black 90%, transparent)' }
            : undefined,
        }}
      >
        <div className="flex items-center gap-1.5 px-4 md:px-6 py-1">
          {visible.map((ref, idx) => {
            // PEND-83 Bug 1: chips are space-constrained (`max-w-[160px]`)
            // and full namespaced paths overflow fast. Render the LEAF only
            // and surface the full path via `title=""` for hover. The
            // empty-title fallback to "Untitled" is preserved verbatim so
            // the existing fallback test keeps passing — `getPageDisplayName`
            // treats it as non-namespaced and returns the same label.
            const fullTitle = ref.title || t('recent.untitled')
            const displayTitle = getPageDisplayName(fullTitle, 'leaf').label
            return (
              <RecentPageChip
                key={ref.pageId}
                ref={(el) => {
                  // Track the live DOM node per index so the focus-management
                  // effect can `.focus()` and `.scrollIntoView()` the focused
                  // chip. The map is rebuilt each render (inline ref callback);
                  // stale indices are cleared on unmount via the null-branch.
                  if (el != null) buttonRefs.current.set(idx, el)
                  else buttonRefs.current.delete(idx)
                }}
                tabIndex={idx === focusedIndex ? 0 : -1}
                className="truncate justify-start"
                title={fullTitle}
                onClick={(e) => handleClick(ref, e)}
                onAuxClick={(e) => {
                  // Middle-click (button === 1) does not fire `onClick` in
                  // every browser but always fires `onAuxClick`. Mirror the
                  // Ctrl/Cmd branch of handleClick.
                  if (e.button === 1) {
                    e.preventDefault()
                    openInNewTab(ref.pageId, ref.title)
                  }
                }}
              >
                <span className="truncate">{displayTitle}</span>
              </RecentPageChip>
            )
          })}
        </div>
      </ScrollArea>
    </nav>
  )
}
