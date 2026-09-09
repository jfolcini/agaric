/**
 * BookmarksSection — the sidebar's collapsible Bookmarks list (#4713).
 *
 * There is ONE bookmark list, the `starred-pages` preference, and this is the
 * sidebar view over it. The page header, the Pages browser rows and its batch
 * toolbar write the same list, so a page bookmarked anywhere appears here.
 * (It used to be a second list — a `pinned` flag on recent pages, writable
 * only from the command palette — which meant the star and this section were
 * different features with the same name.)
 *
 * Titles come from the app-wide resolve cache rather than from the bookmark
 * entry, so a rename is reflected without rewriting storage. That cache is
 * keyed by `(space, id)`, which is also the space filter: a bookmark from
 * another space does not resolve under the active one and is left out.
 *
 * Bookmarks are device-local (`localStorage`), so they do not sync. Moving
 * them into the DB is the follow-up #4713 defers.
 *
 * The disclosure state is a per-client view preference, so it lives in the
 * preferences registry (`PREFERENCES.bookmarksCollapsed`) rather than with
 * the bookmarks themselves.
 */

import { Bookmark, BookmarkX } from 'lucide-react'
import { type ReactElement, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import { EmptyState } from '@/components/common/EmptyState'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { useStarredPages } from '@/hooks/useStarredPages'
import { getPageDisplayName } from '@/lib/page-display'
import { PREFERENCES, usePreference } from '@/lib/preferences'
import { useResolveStore } from '@/stores/resolve'
import { useTabsStore } from '@/stores/tabs'

export function BookmarksSection(): ReactElement {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = usePreference(PREFERENCES.bookmarksCollapsed)

  const { starredIds, toggle } = useStarredPages()
  // Re-resolve when the cache lands new titles, a rename edits one, or a
  // space switch flushes the previous space's entries.
  const resolveVersion = useResolveStore((s) => s.version)
  // Titles arrive with the resolve cache's first full scan. Until it lands
  // every bookmark looks unresolved, so an empty state here would tell the
  // user they have no bookmarks on every cold boot. Render nothing instead.
  const preloaded = useResolveStore((s) => s._preloaded)
  const bookmarks = useMemo(() => {
    const resolve = useResolveStore.getState()
    return [...starredIds]
      .filter((id) => resolve.isResolved(id))
      .map((id) => ({ pageId: id, title: resolve.resolveTitle(id) }))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `resolveVersion` IS the dependency; the store is read imperatively so the memo does not re-run per unrelated cache write
  }, [starredIds, resolveVersion])

  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const { isMobile, setOpenMobile } = useSidebar()

  return (
    <SidebarGroup data-testid="sidebar-bookmarks">
      {/*
       * The sidebar's own nav groups use a static `SidebarGroupLabel`; this
       * one has to disclose, so it borrows the app's disclosure header and
       * takes the group-label metrics (h-8 / px-2 / text-xs) so the two read
       * as one column. Hidden in the icon rail for the same reason
       * `SidebarGroupLabel` is: there is no room for a text header there.
       */}
      <CollapsiblePanelHeader
        isCollapsed={collapsed}
        onToggle={() => setCollapsed((prev) => !prev)}
        testId="sidebar-bookmarks-toggle"
        className="h-8 px-2 py-0 text-xs font-medium group-data-[collapsible=icon]:hidden"
      >
        {t('bookmarks.title')}
      </CollapsiblePanelHeader>

      {!collapsed && (
        <SidebarGroupContent>
          {bookmarks.length === 0 ? (
            // Before the resolve cache's first scan every bookmark looks
            // unresolved, so an empty state would claim there are none.
            // The dashed empty box has no icon-rail layout, and the rail
            // already hides the header that explains it.
            preloaded ? (
              <div className="group-data-[collapsible=icon]:hidden">
                <EmptyState
                  compact
                  headingLevel="p"
                  icon={Bookmark}
                  message={t('bookmarks.empty')}
                  description={t('bookmarks.emptyHint')}
                />
              </div>
            ) : null
          ) : (
            <SidebarMenu aria-label={t('bookmarks.title')}>
              {bookmarks.map((page) => {
                const fullTitle = page.title || t('recent.untitled')
                const label = getPageDisplayName(fullTitle, 'leaf').label
                return (
                  <SidebarMenuItem key={page.pageId}>
                    <SidebarMenuButton
                      tooltip={fullTitle}
                      title={fullTitle}
                      onClick={() => {
                        navigateToPage(page.pageId, page.title)
                        if (isMobile) setOpenMobile(false)
                      }}
                    >
                      <Bookmark />
                      <span className="truncate">{label}</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      aria-label={t('bookmarks.remove', { title: fullTitle })}
                      // `SidebarMenuAction` already grows its hit area by
                      // `after:-inset-2` (36px) on the mobile breakpoint; -inset-3
                      // around the 20px button is the 44px touch target.
                      className="[@media(pointer:coarse)]:after:-inset-3"
                      onClick={() => toggle(page.pageId)}
                    >
                      <BookmarkX />
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          )}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  )
}
