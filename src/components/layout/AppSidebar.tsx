/**
 * AppSidebar — sidebar shell extracted from App.tsx.
 *
 * #5269 — holds only the daily surfaces: a header (branding + collapse
 * toggle, space switcher, New page), one nav list (`SIDEBAR_NAV_ITEMS`)
 * above Bookmarks, and a footer row with the Sync and Settings icons. The other
 * views open from the Pages header or Settings. `CollapseButton` and
 * `syncDotClass` are sidebar-internal helpers and live alongside the JSX
 * they support.
 *
 * Subscription split (design-system perf review tier-3 #19):
 * pure shell-only zustand slices — `syncStore.{state,peers,lastSyncedAt}`
 * and `spaceStore.{availableSpaces,currentSpaceId}` — live INSIDE this
 * component, not on App.tsx. App's prop surface shrinks to the
 * routing/action slices it actually uses (current view, sync trigger, new
 * page); the sidebar becomes the leaf subscriber for everything else, which
 * keeps the `React.memo` shallow-compare gate (Session 717) tight on the
 * remaining props.
 */

import { ChevronsLeft, Plus, RefreshCw, WifiOff } from 'lucide-react'
import { memo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { FeatureErrorBoundary } from '@/components/common/FeatureErrorBoundary'
import { SpaceAccentBadge } from '@/components/common/SpaceAccentBadge'
import { BookmarksSection } from '@/components/layout/BookmarksSection'
import { SpaceSwitcher } from '@/components/layout/SpaceSwitcher'
import { IconButton } from '@/components/ui/icon-button'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { type NavItem, SETTINGS_NAV_ITEM, SIDEBAR_NAV_ITEMS } from '@/lib/nav-items'
import { cn } from '@/lib/utils'
import type { View } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { type SyncState, useSyncStore } from '@/stores/sync'

/**
 * Compute the CSS class for the sync status dot colour.
 *
 * Distinguish "offline" (network problem, nothing the user can do)
 * from "no peers" (pairing problem, the user needs to add a device). Offline
 * wins over no-peers because peer state is meaningless without a network.
 */
function syncDotClass(syncState: SyncState, hasPeers: boolean): string {
  if (syncState === 'offline') return 'bg-muted-foreground'
  if (!hasPeers) return 'bg-status-pending'
  switch (syncState) {
    case 'idle': {
      return 'bg-sync-idle'
    }
    case 'syncing': {
      return 'bg-sync-active'
    }
    case 'error': {
      return 'bg-destructive'
    }
    default: {
      return 'bg-muted-foreground'
    }
  }
}

const LAST_SYNCED_ID = 'sidebar-last-synced'

function CollapseButton() {
  const { t } = useTranslation()
  const { isMobile, state, toggleSidebar } = useSidebar()
  // On mobile the button closes the Sheet, whatever the desktop state is.
  const label =
    state === 'collapsed' && !isMobile ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')
  return (
    <IconButton
      variant="ghost"
      size="icon-sm"
      tooltip={label}
      ariaLabel={label}
      onClick={toggleSidebar}
      className="ml-auto group-data-[collapsible=icon]:ml-0"
    >
      <ChevronsLeft className="transition-transform group-data-[state=collapsed]:rotate-180" />
    </IconButton>
  )
}

export interface AppSidebarProps {
  currentView: View
  onSelectView: (view: Exclude<View, 'page-editor'>) => void
  syncing: boolean
  isOnline: boolean
  onNewPage: () => void
  onSyncClick: () => void
}

function AppSidebarInner({
  currentView,
  onSelectView,
  syncing,
  isOnline,
  onNewPage,
  onSyncClick,
}: AppSidebarProps): ReactElement {
  const { t } = useTranslation()
  // (tier-3): pushed-down zustand selectors. The sidebar is the sole
  // consumer of sync-store status and the space-store roster, so it owns
  // the subscription, keeping unrelated App-shell rerenders (e.g. a
  // `currentView` flip) from washing through the sidebar.
  const syncState = useSyncStore((s) => s.state)
  const syncPeers = useSyncStore((s) => s.peers)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const { isMobile, setOpenMobile } = useSidebar()
  const lastSyncedLabel = lastSyncedAt
    ? t('sidebar.lastSynced', { time: formatRelativeTime(lastSyncedAt, t) })
    : t('sidebar.lastSyncedNever')
  const syncUnavailable = syncing || !isOnline

  /**
   * On mobile the sidebar is a Sheet that overlays the content, so acting on
   * an item has to dismiss it — otherwise the user arrives at the new view
   * with the drawer still covering it. Desktop keeps the sidebar pinned
   * beside the content, where dismissing would be wrong, so this is a no-op
   * there.
   *
   * Applied to navigation and to New page, which take the user elsewhere.
   * Deliberately NOT applied to sync, an in-place action whose result is
   * visible in the sidebar itself.
   */
  const dismissOnMobile = (): void => {
    if (isMobile) setOpenMobile(false)
  }

  const renderNavItem = (item: NavItem): ReactElement => {
    const label = t(item.labelKey)
    return (
      <SidebarMenuItem key={item.id}>
        <SidebarMenuButton
          isActive={currentView === item.id}
          aria-current={currentView === item.id ? 'page' : undefined}
          tooltip={label}
          onClick={() => {
            onSelectView(item.id)
            dismissOnMobile()
          }}
        >
          <item.icon />
          <span>{label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    /*
     * "icon" is a DESKTOP-only choice: it collapses the sidebar to a 48px
     * icon-only rail rather than fully off-canvas, so the primary nav stays
     * one click away instead of needing a swipe/click to re-open. Below the
     * 768px mobile breakpoint the `collapsible` prop has no effect — the
     * sidebar is always a Sheet, opened from the header hamburger, and 48px
     * of a phone's width goes to content. See docs/UX.md § Mobile Sidebar.
     */
    <Sidebar collapsible="icon">
      {/* The rail is 48px wide, so its header padding drops to fit the 32px
          controls (badge, collapse toggle, New page). */}
      <SidebarHeader className="p-4 pb-2 group-data-[collapsible=icon]:px-2">
        {/* Agaric branding — restored at the top of the sidebar above the
            SpaceSwitcher (BUG session 679). Originally removed in
            Phase 1 (c1548cfb) when the SpaceSwitcher replaced it; the
            user wants both visible: branding at the top for app identity,
            space selector below for navigation context. #5269 — the
            collapse toggle sits at its end, stacked under the logo in the
            rail. */}
        <div className="flex min-h-7 items-center gap-2 group-data-[collapsible=icon]:flex-col">
          <img src="/agaric.svg" alt="Agaric" className="h-6 w-6 shrink-0" />
          <span className="text-base font-semibold leading-none tracking-tight group-data-[collapsible=icon]:hidden">
            Agaric
          </span>
          <CollapseButton />
        </div>
        {/*
         * Phase 1: the SpaceSwitcher sits below the branding.
         * It is hidden when the sidebar collapses to icon mode to
         * preserve the compact rail layout (the switcher
         * re-appears on expand).
         *
         * When the sidebar collapses, the SpaceSwitcher
         * dropdown disappears and the user loses the only visual
         * cue of which space is active. The SpaceAccentBadge takes
         * its place in the icon rail — a 32px circle with the
         * first letter of the space name on top of the accent
         * color. Click cycles to the next space.
         */}
        <div className="mt-2 hidden justify-center group-data-[collapsible=icon]:flex">
          {(() => {
            const active = availableSpaces.find((s) => s.id === currentSpaceId) ?? null
            return active != null ? <SpaceAccentBadge space={active} /> : null
          })()}
        </div>
        <div className="mt-2 group-data-[collapsible=icon]:hidden">
          <SpaceSwitcher />
        </div>
        <SidebarMenu className="mt-2">
          <SidebarMenuItem>
            <SidebarMenuButton
              variant="outline"
              tooltip={t('sidebar.newPageTooltip')}
              onClick={() => {
                onNewPage()
                dismissOnMobile()
              }}
            >
              <Plus />
              <span>{t('sidebar.newPage')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <FeatureErrorBoundary name="Sidebar">
          {/* #5269 — four items need no group label. */}
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>{SIDEBAR_NAV_ITEMS.map(renderNavItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {/* #4713 — the pinned recent pages, as a collapsible section. Below
              the fixed nav because its length varies with the user's pins. */}
          <BookmarksSection />
        </FeatureErrorBoundary>
      </SidebarContent>
      <SidebarFooter>
        {/* One row of icons; it stacks in the 48px rail. The sync state is
            the icon (spinner, offline) plus the dot, and the "last synced"
            line lives in the tooltip and the button's description. Hover
            paints the nav rows' lighter fill, so it never matches the active
            Settings pill. */}
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
          <IconButton
            variant="ghost"
            size="icon-sm"
            className="hover:bg-sidebar-accent/50 aria-disabled:opacity-50"
            ariaLabel={isOnline ? t('sidebar.sync') : t('sidebar.offline')}
            aria-describedby={LAST_SYNCED_ID}
            tooltip={
              <div className="flex flex-col gap-0.5">
                <span>
                  {!isOnline
                    ? t('sidebar.offline')
                    : syncing
                      ? t('sidebar.syncing')
                      : t('sidebar.syncTooltip')}
                </span>
                <span className="opacity-90">{lastSyncedLabel}</span>
              </div>
            }
            // `aria-disabled`, not `disabled`: a disabled button takes no hover
            // or focus, so the offline / syncing tooltip could never show.
            aria-disabled={syncUnavailable}
            onClick={syncUnavailable ? undefined : onSyncClick}
          >
            <span className="relative inline-flex">
              {!isOnline ? (
                <WifiOff className="text-muted-foreground" />
              ) : (
                <RefreshCw className={syncing ? 'animate-spin' : ''} />
              )}
              <span
                className={cn(
                  'sync-button-status-dot absolute -top-1 -right-1 h-2 w-2 rounded-full',
                  syncDotClass(syncState, syncPeers.length > 0),
                )}
                data-testid="sync-button-status-dot"
                data-sync-state={syncState}
                aria-hidden="true"
              />
            </span>
          </IconButton>
          <span id={LAST_SYNCED_ID} className="sr-only" data-testid="last-synced">
            {lastSyncedLabel}
          </span>
          <IconButton
            variant="ghost"
            size="icon-sm"
            className={cn(
              'hover:bg-sidebar-accent/50',
              currentView === SETTINGS_NAV_ITEM.id &&
                'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent',
            )}
            ariaLabel={t(SETTINGS_NAV_ITEM.labelKey)}
            tooltip={t(SETTINGS_NAV_ITEM.labelKey)}
            aria-current={currentView === SETTINGS_NAV_ITEM.id ? 'page' : undefined}
            onClick={() => {
              onSelectView(SETTINGS_NAV_ITEM.id)
              dismissOnMobile()
            }}
          >
            <SETTINGS_NAV_ITEM.icon />
          </IconButton>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

/**
 * Memoized export — App.tsx forwards ~16 store-derived props on every
 * top-level render (see design-system-perf-review-2026-05-09.md item 10).
 * Wrapping with `React.memo` collapses parent-driven rerenders to the
 * subset where a prop identity actually changed; intra-sidebar state
 * (sync dot colour) re-renders on its own subscriptions
 * through `SpaceSwitcher` and `useSidebar()`. Mirrors the
 * `BlockListItem` Inner/memo pattern used elsewhere in the tree.
 */
export const AppSidebar = memo(AppSidebarInner)
AppSidebar.displayName = 'AppSidebar'
