/**
 * RecentPagesStrip — desktop-only "Recently visited" chip row (FEAT-9).
 *
 * Mounted at the app-shell level between the hoisted `<TabBar />` (FEAT-7)
 * and the `<ViewHeaderOutletSlot />` (UX-198). Reads the MRU list from
 * `useRecentPagesStore` and renders one ghost-button "chip" per entry,
 * excluding the currently-open page so the strip shows places the user
 * might want to jump *back* to.
 *
 * Responsive grid (`repeat(auto-fit, minmax(120px, 180px))`) so the chip
 * count grows/shrinks with viewport width — no fixed N. Chip text truncates
 * with a `title` tooltip for hover context.
 *
 * Click semantics mirror the rest of the app:
 * - Plain click → `navigateToPage`.
 * - Ctrl/Cmd+click or middle-click → `openInNewTab` (matches block/page-link
 *   convention).
 *
 * Auto-hidden when:
 * - `useIsMobile()` is true (desktop-only affordance).
 * - The visible list is empty (no visits yet, or the only visit *is* the
 *   currently-open page).
 */

import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useIsMobile } from '../hooks/use-mobile'
import { useNavigationStore } from '../stores/navigation'
import { type PageRef, useRecentPagesStore } from '../stores/recent-pages'

export function RecentPagesStrip(): React.ReactElement | null {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const recentPages = useRecentPagesStore((s) => s.recentPages)

  // Derive the currently-open pageId from the active tab's stack top so we
  // can exclude it from the strip. `undefined` when no tab or no stack —
  // in that case we render every recent page (nothing to exclude).
  const activePageId = useNavigationStore((s) => {
    const active = s.tabs[s.activeTabIndex]
    return active && active.pageStack.length > 0
      ? active.pageStack[active.pageStack.length - 1]?.pageId
      : undefined
  })

  const navigateToPage = useNavigationStore((s) => s.navigateToPage)
  const openInNewTab = useNavigationStore((s) => s.openInNewTab)

  const visible = recentPages.filter((p) => p.pageId !== activePageId)

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

  if (isMobile) return null
  if (visible.length === 0) return null

  return (
    <nav
      aria-label={t('recent.ariaLabel')}
      className="border-b border-border/40 bg-background px-4 md:px-6 py-1.5"
      data-testid="recent-pages-strip"
    >
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 180px))' }}
      >
        {visible.map((ref) => {
          const displayTitle = ref.title || t('recent.untitled')
          return (
            <Button
              key={ref.pageId}
              variant="ghost"
              size="sm"
              className={cn(
                'truncate justify-start text-xs text-muted-foreground hover:text-foreground',
              )}
              title={displayTitle}
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
            </Button>
          )
        })}
      </div>
    </nav>
  )
}
