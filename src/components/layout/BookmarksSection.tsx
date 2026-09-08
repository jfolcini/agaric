/**
 * BookmarksSection — the sidebar's collapsible Bookmarks list (#4713).
 *
 * A bookmark IS a pinned recent page: `recent-pages` already owns the whole
 * model — `togglePinRecentPage`, pin-first ordering, and the exemption that
 * keeps pinned entries out of the `MAX_RETAINED` eviction. This section is the
 * sidebar view over that state; it adds no store and no second list.
 *
 * The command palette's inline Pin button is the only place a page can be
 * pinned; SearchPanel renders the same recents read-only, and the PageBrowser
 * never reads the flag. So `bookmarks.emptyHint` names the palette alone.
 *
 * Consequences the section inherits, deliberately: bookmarks are per-space
 * (the store partitions by space id) and device-local (the store persists to
 * `localStorage`, so they do not sync). Moving bookmarks into the DB is the
 * follow-up #4713 defers.
 *
 * The disclosure state is a per-client view preference, so it lives in the
 * preferences registry (`PREFERENCES.bookmarksCollapsed`) rather than with
 * the bookmarks themselves.
 */

import { Bookmark, BookmarkX } from 'lucide-react'
import type { ReactElement } from 'react'
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
import { getPageDisplayName } from '@/lib/page-display'
import { PREFERENCES, usePreference } from '@/lib/preferences'
import { selectRecentPagesForSpace, useRecentPagesStore } from '@/stores/recent-pages'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

export function BookmarksSection(): ReactElement {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = usePreference(PREFERENCES.bookmarksCollapsed)

  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spacePages = useRecentPagesStore((s) => selectRecentPagesForSpace(s, currentSpaceId))
  const bookmarks = spacePages.filter((p) => p.pinned === true)

  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const togglePinRecentPage = useRecentPagesStore((s) => s.togglePinRecentPage)
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
            // The dashed empty box has no icon-rail layout, and the rail
            // already hides the header that explains it.
            <div className="group-data-[collapsible=icon]:hidden">
              <EmptyState
                compact
                headingLevel="p"
                icon={Bookmark}
                message={t('bookmarks.empty')}
                description={t('bookmarks.emptyHint')}
              />
            </div>
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
                      onClick={() => togglePinRecentPage(page.pageId)}
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
