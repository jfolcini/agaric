/**
 * QuickAccessBar — desktop-only navigation strip (PEND-68 Part B).
 *
 * Two zones inside a single `<nav>`:
 *
 *   1. **Destinations cluster** (left, sticky) — a fixed allowlist of
 *      high-frequency views (Pages, Tags, Graph, Search). Each chip is
 *      icon + label, carries an active state, and dispatches
 *      `useNavigationStore.setView(view)` on click. The current view is
 *      flagged with `aria-current="page"` so screen readers announce it.
 *   2. **Recents scroller** (right) — the existing MRU recents list,
 *      unchanged from PEND-32: `<ScrollArea orientation="horizontal">`,
 *      wheel-to-horizontal handler, overflow mask, MRU exclusion of the
 *      currently-open page. Click → `navigateToPage`, Ctrl/Cmd/middle →
 *      `openInNewTab`.
 *
 * A thin `border-l border-border/40` divider separates the two zones.
 * Recents stay text-only (history) so the two visual languages are
 * differentiated.
 *
 * Keyboard model — a single roving tabindex spans `[...destinations,
 * ...recents]` as one ordered list. The `items` array is a tagged union
 * (`{kind: 'destination'|'recent', ...}`) consumed by
 * `useListKeyboardNavigation.onSelect`, which dispatches `setView` or
 * `navigateToPage` by `kind`. Left/Right traverse both zones with wrap;
 * Up/Down are no-ops (horizontal mode).
 *
 * Render gate (PEND-68 change-of-behaviour):
 *   - Mobile → null (the mobile bottom-nav already covers destinations).
 *   - Desktop, both zones empty → null (defensive; destinations is a
 *     hard-coded 4-entry constant so the recents-only empty path is
 *     effectively the only one that can hit here).
 *
 * Otherwise the bar renders. On desktop this is "always present" because
 * the destinations zone is non-empty by construction.
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QuickNavChip } from '@/components/ui/quick-nav-chip'
import { RecentPageChip } from '@/components/ui/recent-page-chip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useIsMobile } from '../hooks/useIsMobile'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { getPageDisplayName } from '../lib/page-display'
import { useNavigationStore } from '../stores/navigation'
import {
  type PageRef,
  selectRecentPagesForSpace,
  useRecentPagesStore,
} from '../stores/recent-pages'
import { useSpaceStore } from '../stores/space'
import { selectActiveTabIndexForSpace, selectTabsForSpace, useTabsStore } from '../stores/tabs'
import { NAV_ITEMS, type NavItem } from './nav-items'

/**
 * Destination allowlist. Kept inline (rather than exported as a stand-alone
 * module) — the QuickAccessBar is the only consumer and the set is tightly
 * coupled to this bar's UX. Subset of `NAV_ITEMS` so icons and `sidebar.*`
 * labels stay aligned with the sidebar.
 *
 * Maintainer decision (issue #83): Pages, Tags, Graph, Search — no Journal in
 * v1, no Settings/Status/History/Templates/Trash (those stay in the sidebar).
 */
const QUICK_NAV_DESTINATION_IDS = ['pages', 'tags', 'graph', 'search'] as const
type DestinationId = (typeof QUICK_NAV_DESTINATION_IDS)[number]

const QUICK_NAV_DESTINATIONS: NavItem[] = QUICK_NAV_DESTINATION_IDS.map((id) => {
  const item = NAV_ITEMS.find((nav) => nav.id === id)
  if (!item) {
    // Build-time invariant — fail loud if the allowlist references an id
    // that's been removed from NAV_ITEMS. Throws at module load.
    throw new Error(`QUICK_NAV_DESTINATIONS: missing nav item for id "${id}"`)
  }
  return item
})

/** Tagged union of items in the unified keyboard list. */
type QuickAccessItem =
  | { kind: 'destination'; view: DestinationId; icon: NavItem['icon']; labelKey: string }
  | { kind: 'recent'; pageId: string; title: string }

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
  const currentView = useNavigationStore((s) => s.currentView)
  const setView = useNavigationStore((s) => s.setView)

  const visible = recentPages.filter((p) => p.pageId !== activePageId)

  // Unified keyboard list — destinations first, then recents. The
  // `useListKeyboardNavigation` hook sees a flat ordered list and dispatches
  // `setView` or `navigateToPage` based on each item's `kind`.
  const items: QuickAccessItem[] = [
    ...QUICK_NAV_DESTINATIONS.map<QuickAccessItem>((d) => ({
      kind: 'destination',
      view: d.id as DestinationId,
      icon: d.icon,
      labelKey: d.labelKey,
    })),
    ...visible.map<QuickAccessItem>((p) => ({
      kind: 'recent',
      pageId: p.pageId,
      title: p.title,
    })),
  ]

  // Roving tabindex spanning both zones. Hook is called unconditionally
  // (rules of hooks) before the mobile / empty-state returns below.
  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: items.length,
    horizontal: true,
    wrap: true,
    onSelect: (index) => {
      const item = items[index]
      if (item == null) return
      if (item.kind === 'destination') {
        setView(item.view)
      } else {
        navigateToPage(item.pageId, item.title)
      }
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
  // Render whenever EITHER zone is non-empty. Destinations is a 4-entry
  // constant so on desktop the bar is effectively always present; the
  // guard is defensive against a future empty-allowlist refactor.
  if (QUICK_NAV_DESTINATIONS.length === 0 && visible.length === 0) return null

  const destCount = QUICK_NAV_DESTINATIONS.length

  return (
    <nav
      aria-label={t('recent.ariaLabel')}
      className="border-b border-border/40 bg-background"
      data-testid="quick-access-bar"
      onKeyDown={(e) => {
        if (handleKeyDown(e)) e.preventDefault()
      }}
    >
      <div className="flex w-full items-stretch">
        {/* Destinations cluster — sticky to the left, never scrolls. */}
        <div
          className="flex shrink-0 items-center gap-1.5 px-4 md:px-6 py-1"
          data-testid="quick-access-destinations"
        >
          {QUICK_NAV_DESTINATIONS.map((d, idx) => {
            const Icon = d.icon
            const label = t(d.labelKey)
            const isActive = currentView === d.id
            return (
              <QuickNavChip
                key={d.id}
                ref={(el) => {
                  if (el != null) buttonRefs.current.set(idx, el)
                  else buttonRefs.current.delete(idx)
                }}
                active={isActive}
                aria-current={isActive ? 'page' : undefined}
                aria-label={label}
                tabIndex={idx === focusedIndex ? 0 : -1}
                onClick={() => setView(d.id as DestinationId)}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{label}</span>
              </QuickNavChip>
            )
          })}
        </div>

        {/* Recents scroller — keeps PEND-32 behaviour verbatim. */}
        <ScrollArea
          orientation="horizontal"
          className="min-w-0 flex-1 border-l border-border/40"
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
            {visible.map((ref, recentIdx) => {
              const idx = destCount + recentIdx
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

/** Exported for tests — the destination allowlist consumed by the bar. */
export { QUICK_NAV_DESTINATIONS }
