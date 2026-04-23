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
 * Keyboard semantics (UX-256):
 * - Roving tabindex across the chip row — Tab lands on the focused chip,
 *   ArrowLeft/ArrowRight traverse (wrapping), Enter/Space activates via
 *   `navigateToPage` (same as plain click; modifier-click is the only path
 *   to `openInNewTab`).
 * - Powered by the shared `useListKeyboardNavigation` hook; DOM focus is
 *   moved imperatively in a `useEffect` so screen readers announce each
 *   chip as the user traverses. Focus only moves when the strip already
 *   owns focus — avoids stealing focus on mount / re-render.
 *
 * Auto-hidden when:
 * - `useIsMobile()` is true (desktop-only affordance).
 * - The visible list is empty (no visits yet, or the only visit *is* the
 *   currently-open page).
 */

import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useIsMobile } from '../hooks/use-mobile'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
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
  const buttonRefs = useRef(new Map<number, HTMLButtonElement | null>())

  useEffect(() => {
    const activeEl = document.activeElement
    const isInsideStrip = Array.from(buttonRefs.current.values()).some((btn) => btn === activeEl)
    if (!isInsideStrip) return
    const target = buttonRefs.current.get(focusedIndex)
    if (target != null) target.focus()
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

  if (isMobile) return null
  if (visible.length === 0) return null

  return (
    <nav
      aria-label={t('recent.ariaLabel')}
      className="border-b border-border/40 bg-background px-4 md:px-6 py-1.5"
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
       * Responsive grid: `auto-fit` packs chips at their natural min/max
       * width. Rough chip counts at common desktop widths (with 32 px
       * horizontal padding, 8 px gap):
       *   - 1440 px viewport → ~7 chips per row
       *   - 1280 px viewport → ~6 chips
       *   - 1024 px viewport → ~5 chips
       *   -  800 px viewport → ~4 chips
       *   -  768 px viewport (desktop min) → ~3 chips
       * Below 768 px the strip doesn't render at all (mobile gate above).
       */}
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 180px))' }}
      >
        {visible.map((ref, idx) => {
          const displayTitle = ref.title || t('recent.untitled')
          return (
            <Button
              key={ref.pageId}
              ref={(el) => {
                // Track the live DOM node per index so the focus-management
                // effect can `.focus()` the currently-focused chip. The map
                // is rebuilt each render (inline ref callback); stale indices
                // are cleared on unmount via the null-branch.
                if (el != null) buttonRefs.current.set(idx, el)
                else buttonRefs.current.delete(idx)
              }}
              tabIndex={idx === focusedIndex ? 0 : -1}
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
