/**
 * QuickAccessBar — the recents strip (Part B; #83 recents-only).
 *
 * A single `<nav>` holding the MRU **recents scroller**: the existing
 * recents list — `<ScrollArea orientation="horizontal">`, wheel-to-horizontal
 * handler, overflow mask, MRU exclusion of the currently-open page. Click →
 * `navigateToPage`, Ctrl/Cmd/middle → a background tab. Recents are per-space
 * (Phase 3). Chips stay text-only (history).
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
 *   - Not on a touch phone, and not while the tab bar is up (more than one
 *     tab): the chips would repeat the open tabs, and the bars would eat the
 *     screen (#7040). Recent pages stay in the command palette (and the
 *     search sheet's all-pages segment on a phone).
 *   - No recents → null (recents-only: the empty path is the real one now that
 *     the always-present destinations zone is gone).
 *   - Settings → null: opening a page from inside Settings is not wanted
 *     (#5993); the tab bar stays as the way back.
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { NewTabTarget } from '@/components/common/NewTabTarget'
import { RecentPageChip } from '@/components/ui/recent-page-chip'
import { SCROLL_ONLY_WHEN_WIDER, ScrollArea } from '@/components/ui/scroll-area'
import { TruncatedText } from '@/components/ui/truncated-text'
import { useIsTouch } from '@/hooks/useIsTouch'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { useOpenInBackgroundTab } from '@/hooks/useOpenInBackgroundTab'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'
import { getPageDisplayName } from '@/lib/page-display'
import { shouldReduceMotion } from '@/lib/preferences'
import { useNavigationStore } from '@/stores/navigation'
import { type PageRef, selectRecentPagesForSpace, useRecentPagesStore } from '@/stores/recent-pages'
import { useSpaceStore } from '@/stores/space'
import { selectActiveTabIndexForSpace, selectTabsForSpace, useTabsStore } from '@/stores/tabs'

export function QuickAccessBar(): React.ReactElement | null {
  const { t } = useTranslation()

  // Phase 3 — recents are per-space.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const recentPages = useRecentPagesStore((s) => selectRecentPagesForSpace(s, currentSpaceId))

  // Currently-open pageId so we can exclude it from the recents zone.
  const activePageId = useTabsStore((s) => {
    const tabs = selectTabsForSpace(s, currentSpaceId)
    const idx = selectActiveTabIndexForSpace(s, currentSpaceId)
    const active = tabs[idx]
    return active && active.pageStack.length > 0 ? active.pageStack.at(-1)?.pageId : undefined
  })

  // The tab bar's own autohide rule (`TabBar`): it shows from the second tab.
  const tabBarShown = useTabsStore((s) => selectTabsForSpace(s, currentSpaceId).length > 1)
  // A touch phone, portrait or landscape: the phone header has no room for it.
  const isTouch = useIsTouch()
  const phoneLayout = usePhoneLayout()

  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const isSettings = useNavigationStore((s) => s.currentView === 'settings')
  const openInBackgroundTab = useOpenInBackgroundTab()

  const visible = recentPages.filter((p) => p.pageId !== activePageId)

  // Roving tabindex over the recents. Hook is called unconditionally (rules of
  // hooks) before the hidden / empty-state returns below.
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
    target.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: shouldReduceMotion() ? 'auto' : 'smooth',
    })
  }, [focusedIndex])

  const handleRecentClick = useCallback(
    (ref: PageRef, e: React.MouseEvent) => {
      if ((e.ctrlKey || e.metaKey) && openInBackgroundTab) {
        e.preventDefault()
        openInBackgroundTab(ref.pageId, ref.title)
        return
      }
      navigateToPage(ref.pageId, ref.title)
    },
    [navigateToPage, openInBackgroundTab],
  )

  // Vertical wheel deltas → horizontal scroll (recents zone only).
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.currentTarget.scrollLeft += e.deltaY
      e.preventDefault()
    }
  }, [])

  // Right-edge fade when the recents zone overflows.
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

  if (visible.length === 0 || isSettings || tabBarShown || (isTouch && phoneLayout)) return null

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
        {/* Recents scroller — keeps  behaviour verbatim. */}
        <ScrollArea
          orientation="horizontal"
          className="min-w-0 flex-1"
          viewportRef={viewportRef}
          viewportClassName="overscroll-x-contain"
          viewportProps={{
            onWheel: handleWheel,
            style: hasOverflow
              ? {
                  ...SCROLL_ONLY_WHEN_WIDER.style,
                  maskImage: 'linear-gradient(to right, black 90%, transparent)',
                }
              : SCROLL_ONLY_WHEN_WIDER.style,
          }}
        >
          <div className="flex items-center gap-1.5 px-4 md:px-6 py-1">
            {visible.map((ref, idx) => {
              // Bug 1: recent chips are space-constrained
              // (`max-w-[160px]`) and full namespaced paths overflow fast, so
              // a chip shows the LEAF only; the command palette's recent pages
              // list shows the full path.
              const fullTitle = ref.title || t('recent.untitled')
              const displayTitle = getPageDisplayName(fullTitle, 'leaf').label
              return (
                <NewTabTarget key={ref.pageId} pageId={ref.pageId} title={ref.title} dragsPage>
                  <RecentPageChip
                    ref={(el) => {
                      if (el != null) buttonRefs.current.set(idx, el)
                      else buttonRefs.current.delete(idx)
                    }}
                    tabIndex={idx === focusedIndex ? 0 : -1}
                    className="justify-start"
                    onClick={(e) => handleRecentClick(ref, e)}
                  >
                    <TruncatedText text={fullTitle}>{displayTitle}</TruncatedText>
                  </RecentPageChip>
                </NewTabTarget>
              )
            })}
          </div>
        </ScrollArea>
      </div>
    </nav>
  )
}
