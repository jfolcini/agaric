/**
 * useViewChangeAnnouncer — single screen-reader announcement for every
 * `currentView` switch (#2944).
 *
 * Before this hook, only the `focusSearch` keyboard-shortcut route
 * (`useAppKeyboardShortcuts.ts`'s `tryFocusSearch`) announced its
 * destination (`announce(t('announce.searchOpened'))`); the palette's
 * `go-<view>` commands (`palette-commands.ts`) and the sidebar
 * (`AppSidebar`'s `onSelectView` → `setView`) were silent. All three
 * routes funnel through `useNavigationStore`'s `setView`, so a single
 * subscriber on `currentView` here covers all of them without any call
 * site announcing itself — `tryFocusSearch`'s inline announce call was
 * removed in favor of this hook so the transition isn't announced twice.
 *
 * Localized view names are the same `NAV_ITEMS` manifest the sidebar
 * renders its labels from (`src/components/common/nav-items.ts`), so the
 * announcement text always agrees with what's on screen.
 *
 * Skipped intentionally:
 * - The initial render (mounting into a view isn't a user-initiated
 *   "switch").
 * - Same-value `setView` calls (e.g. `GlobalDateControls`' handlers,
 *   which call `setView('journal')` while already on the journal view
 *   and have their own more specific announcements —
 *   `announce.jumpedToToday`, `announce.navigatedToNext`, etc.). These
 *   never change `currentView`, so the effect's dependency doesn't
 *   re-fire for them.
 * - `page-editor` — it isn't a `NAV_ITEMS` destination (opening a page
 *   is a distinct, much more frequent action than switching sidebar
 *   views, and has no single localized name to announce).
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { NAV_ITEMS } from '@/components/common/nav-items'
import { announce } from '@/lib/announcer'
import { useNavigationStore } from '@/stores/navigation'

export function useViewChangeAnnouncer(): void {
  const { t } = useTranslation()
  const currentView = useNavigationStore((s) => s.currentView)
  const isFirstRender = useRef(true)
  // Read `t` fresh inside the effect without making language changes
  // re-trigger an announcement (the effect's only real dependency is the
  // view itself).
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    const navItem = NAV_ITEMS.find((item) => item.id === currentView)
    if (!navItem) return
    announce(tRef.current('announce.navigatedTo', { view: tRef.current(navItem.labelKey) }))
  }, [currentView])
}
