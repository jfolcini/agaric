/**
 * QuickAccessBar — desktop-only recents strip (PEND-68 Part B; #83 recents-only).
 *
 * A single `<nav>` holding the MRU **recents scroller**: the existing PEND-32
 * recents list — `<ScrollArea orientation="horizontal">`, wheel-to-horizontal
 * handler, overflow mask, MRU exclusion of the currently-open page. Click →
 * `navigateToPage`, Ctrl/Cmd/middle → `openInNewTab`. Recents are per-space
 * (FEAT-3 Phase 3). Chips stay text-only (history).
 *
 * The former "destinations cluster" (a hard-coded Pages/Tags/Graph/Search
 * allowlist) was removed (#83): those four entries duplicated the left sidebar
 * (which already has Pages, Search, Tags, Graph) and crowded the recents.
 *
 * Keyboard model — a single roving tabindex spans the recents list, consumed
 * by `useListKeyboardNavigation.onSelect` which dispatches `navigateToPage`.
 * Left/Right traverse the recents with wrap; Up/Down are no-ops (horizontal).
 *
 * Render gate:
 *   - Mobile → null (the mobile bottom-nav covers navigation).
 *   - Desktop with no recents → null (recents-only: the empty path is the real
 *     one now that the always-present destinations zone is gone).
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { RecentPageChip } from '@/components/ui/recent-page-chip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { getPageDisplayName } from '@/lib/page-display'
import { type PageRef, selectRecentPagesForSpace, useRecentPagesStore } from '@/stores/recent-pages'
import { useSpaceStore } from '@/stores/space'
import { selectActiveTabIndexForSpace, selectTabsForSpace, useTabsStore } from '@/stores/tabs'

export function QuickAccessBar(): React.ReactElement | null {
  const { t } = useTranslation()
  const isMobile = useIsMobile()

  // FEAT-3 Phase 3 — recents are per-space.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const recentPages = useRecentPagesStore((s) => selectRecentPagesForSpace(s, currentSpaceId))

  // Currently-open pageId so we can exclude it from the recents zone.
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

  // Roving tabindex over the recents. Hook is called unconditionally (rules of
  // hooks) before the mobile / empty-state returns below.
  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: visible.length,
    horizontal: true,
    wrap: true,
    onSelect: (index) => {
      const item = visible[index]
      if (item == null) return
      navigateToPage(item.pageId, item.title)
    },
  })

  // Imperative focus management — only move DOM focus when focus already
  // lives inside the bar (avoid stealing focus on mount). Also scroll the
  // focused chip into view so recents off the right edge get revealed.
  const buttonRefs = useRef(new Map<number, HTMLButtonElement | null>())

  useEffect(() => {
    const activeEl = document.activeElement
    const isInsideBar = Array.from(buttonRefs.current.values()).some((btn) => btn === activeEl)
    if (!isInsideBar) return
    const target = buttonRefs.current.get(focusedIndex)
    if (target == null) return
    target.focus()
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    })
  }, [focusedIndex])

  const handleRecentClick = useCallback(
    (ref: PageRef, e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey || e.button === 1) {
        e.preventDefault()
        openInNewTab(ref.pageId, ref.title)
        return
      }
      navigateToPage(ref.pageId, ref.title)
    },
    [navigateToPage, openInNewTab],
  )

  // PEND-32: vertical wheel deltas → horizontal scroll (recents zone only).
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.currentTarget.scrollLeft += e.deltaY
      e.preventDefault()
    }
  }, [])

  // MAINT-211: right-edge fade when the recents zone overflows.
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
  // Recents-only: nothing to show when there are no recents.
  if (visible.length === 0) return null

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- roving-tabindex keyboard navigation: the <nav> intercepts arrow keys delegated up from its focused recent chips to move focus between them. The chips are the interactive controls; the <nav> only routes keys.
    <nav
      aria-label={t('recent.ariaLabel')}
      className="border-b border-border/40 bg-background"
      data-testid="quick-access-bar"
      onKeyDown={(e) => {
        if (handleKeyDown(e)) e.preventDefault()
      }}
    >
      <div className="flex w-full items-stretch">
        {/* Recents scroller — keeps PEND-32 behaviour verbatim. */}
        <ScrollArea
          orientation="horizontal"
          className="min-w-0 flex-1"
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
              // PEND-83 Bug 1: recent chips are space-constrained
              // (`max-w-[160px]`) and full namespaced paths overflow fast.
              // Render the LEAF only and surface the full path via `title=""`
              // for hover. The empty-title fallback to "Untitled" stays —
              // `getPageDisplayName` treats it as non-namespaced and returns
              // the same label, so the fallback test keeps passing.
              const fullTitle = ref.title || t('recent.untitled')
              const displayTitle = getPageDisplayName(fullTitle, 'leaf').label
              return (
                <RecentPageChip
                  key={ref.pageId}
                  ref={(el) => {
                    if (el != null) buttonRefs.current.set(idx, el)
                    else buttonRefs.current.delete(idx)
                  }}
                  tabIndex={idx === focusedIndex ? 0 : -1}
                  className="truncate justify-start"
                  title={fullTitle}
                  onClick={(e) => handleRecentClick(ref, e)}
                  onAuxClick={(e) => {
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
      </div>
    </nav>
  )
}
