/**
 * AppSidebar — sidebar shell extracted from App.tsx.
 *
 * Owns the sticky top space-switcher branding, the primary navigation
 * menu, and the bottom action strip (new page, sync, theme toggle,
 * shortcuts, collapse). `CollapseButton` and `syncDotClass` are
 * sidebar-internal helpers and live alongside the JSX they support.
 *
 * Subscription split (design-system perf review tier-3 #19):
 * pure shell-only zustand slices — `syncStore.{state,peers,lastSyncedAt}`,
 * `spaceStore.{availableSpaces,currentSpaceId}`, and the polling
 * `useTrashCount` badge — live INSIDE this component, not on App.tsx.
 * App's prop surface shrinks to the routing/action slices it actually
 * uses (current view, theme cycle, sync trigger, dialog openers); the
 * sidebar becomes the leaf subscriber for everything else, which keeps
 * the `React.memo` shallow-compare gate (Session 717) tight on the
 * remaining props.
 */

import { ChevronsLeft, Keyboard, Moon, Plus, RefreshCw, Sun, WifiOff } from 'lucide-react'
import { memo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { FeatureErrorBoundary } from '@/components/common/FeatureErrorBoundary'
import { NAV_GROUPS, type NavItem, SETTINGS_NAV_ITEM } from '@/components/common/nav-items'
import { SpaceAccentBadge } from '@/components/common/SpaceAccentBadge'
import { SpaceSwitcher } from '@/components/layout/SpaceSwitcher'
import { useTrashCount } from '@/components/pages/ViewDispatcher'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { THEME_NAME_KEY, type ThemePreference } from '@/hooks/useTheme'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { getShortcutKeys } from '@/lib/keyboard-config'
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

function CollapseButton() {
  const { t } = useTranslation()
  const { toggleSidebar } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip={t('sidebar.toggleSidebar')} onClick={toggleSidebar}>
          <ChevronsLeft className="transition-transform group-data-[state=collapsed]:rotate-180" />
          <span>{t('sidebar.collapse')}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export interface AppSidebarProps {
  currentView: View
  onSelectView: (view: Exclude<View, 'page-editor'>) => void
  syncing: boolean
  isOnline: boolean
  isDark: boolean
  currentTheme: ThemePreference
  onToggleTheme: () => void
  onNewPage: () => void
  onSyncClick: () => void
  onShowShortcuts: () => void
}

function AppSidebarInner({
  currentView,
  onSelectView,
  syncing,
  isOnline,
  isDark,
  currentTheme,
  onToggleTheme,
  onNewPage,
  onSyncClick,
  onShowShortcuts,
}: AppSidebarProps): ReactElement {
  const { t } = useTranslation()
  // (tier-3): pushed-down zustand selectors. App.tsx no longer
  // forwards these as props — the sidebar is the sole consumer of
  // sync-store status, the space-store roster, and the trash badge
  // count, so it owns the subscription. App's prop surface drops by 6
  // (trashCount, syncState, syncPeers, lastSyncedAt, availableSpaces,
  // currentSpaceId), tightening the `React.memo` shallow-compare gate
  // (Session 717) and keeping unrelated App-shell rerenders (e.g. a
  // `currentView` flip) from washing through the sidebar.
  const syncState = useSyncStore((s) => s.state)
  const syncPeers = useSyncStore((s) => s.peers)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const trashCount = useTrashCount()

  /**
   * Render a single nav destination. Shared between the grouped main-nav
   * sections and the footer Settings item (#1741) so the active-state,
   * tooltip, trash badge, and status dot behaviour stay identical
   * wherever an item appears.
   */
  const renderNavItem = (item: NavItem): ReactElement => {
    const label = t(item.labelKey)
    return (
      <SidebarMenuItem key={item.id}>
        <SidebarMenuButton
          isActive={currentView === item.id}
          aria-current={currentView === item.id ? 'page' : undefined}
          tooltip={label}
          onClick={() => onSelectView(item.id)}
        >
          <item.icon />
          <span>{label}</span>
          {item.id === 'trash' && trashCount > 0 && (
            <SidebarMenuBadge aria-label={t('sidebar.trashCount', { count: trashCount })}>
              {trashCount}
            </SidebarMenuBadge>
          )}
          {item.id === 'status' && (
            <span
              className={cn(
                'ml-auto h-2.5 w-2.5 rounded-full',
                syncDotClass(syncState, syncPeers.length > 0),
              )}
              aria-hidden="true"
            />
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    /*
     * "icon" collapses the sidebar to a 48px icon-only rail rather than
     * fully off-canvas. Chosen over "offcanvas" so that on desktop the
     * primary nav stays one click away (vs. requiring a swipe/click to
     * re-open). See docs/UX.md § Mobile Sidebar.
     */
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4 pb-2">
        {/* Agaric branding — restored at the top of the sidebar above the
            SpaceSwitcher (BUG session 679). Originally removed in
            Phase 1 (c1548cfb) when the SpaceSwitcher replaced it; the
            user wants both visible: branding at the top for app identity,
            space selector below for navigation context. */}
        <div className="flex h-7 items-center gap-2 group-data-[collapsible=icon]:justify-center">
          <img src="/agaric.svg" alt="Agaric" className="h-6 w-6 shrink-0" />
          <span className="text-base font-semibold leading-none tracking-tight group-data-[collapsible=icon]:hidden">
            Agaric
          </span>
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
      </SidebarHeader>
      <SidebarContent>
        <FeatureErrorBoundary name="Sidebar">
          {/*
           * #1741 — the nav is split into labeled groups (Workspace /
           * System) instead of one flat list. Each `SidebarGroup` carries
           * a `SidebarGroupLabel` wired to its menu via `aria-labelledby`,
           * so assistive tech announces the section. Group labels collapse
           * to zero height in icon mode (handled by `SidebarGroupLabel`),
           * keeping the compact rail intact.
           */}
          {NAV_GROUPS.map((group) => {
            const labelId = `sidebar-group-${group.id}`
            return (
              <SidebarGroup key={group.id}>
                <SidebarGroupLabel id={labelId}>{t(group.labelKey)}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu aria-labelledby={labelId}>
                    {group.items.map(renderNavItem)}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )
          })}
        </FeatureErrorBoundary>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {/* #1741 — Settings moved out of the mid-list main nav into the
              footer with the other utility actions. */}
          {renderNavItem(SETTINGS_NAV_ITEM)}
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={t('sidebar.newPageTooltip')} onClick={onNewPage}>
              <Plus />
              <span>{t('sidebar.newPage')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              // The visible "last synced" line below is hidden in
              // icon-collapsed mode, so fold the same text into the tooltip
              // (which is only rendered when collapsed). Users get the
              // timestamp in both modes without duplication on screen.
              tooltip={{
                children: (
                  <div className="flex flex-col gap-0.5">
                    <span>
                      {!isOnline
                        ? t('sidebar.offline')
                        : syncing
                          ? t('sidebar.syncing')
                          : t('sidebar.syncTooltip')}
                    </span>
                    <span className="opacity-80">
                      {lastSyncedAt
                        ? t('sidebar.lastSynced', {
                            time: formatRelativeTime(lastSyncedAt, t),
                          })
                        : t('sidebar.lastSyncedNever')}
                    </span>
                  </div>
                ),
              }}
              onClick={onSyncClick}
              disabled={syncing || !isOnline}
            >
              {!isOnline ? (
                <WifiOff className="h-4 w-4 text-muted-foreground" />
              ) : (
                <RefreshCw className={syncing ? 'animate-spin' : ''} />
              )}
              <span>{isOnline ? t('sidebar.sync') : t('sidebar.offline')}</span>
              <span
                className={cn(
                  'sync-button-status-dot ml-auto h-2.5 w-2.5 rounded-full',
                  syncDotClass(syncState, syncPeers.length > 0),
                )}
                data-testid="sync-button-status-dot"
                data-sync-state={syncState}
                aria-hidden="true"
              />
            </SidebarMenuButton>
            <span
              className="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"
              data-testid="last-synced"
            >
              {lastSyncedAt
                ? t('sidebar.lastSynced', { time: formatRelativeTime(lastSyncedAt, t) })
                : t('sidebar.lastSyncedNever')}
            </span>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/*
             * Surface the current theme in the tooltip so the
             * 3-state cycle (auto / dark / light) is no longer silent.
             * The visible label still reads `t('sidebar.toggleTheme')` so the
             * expanded sidebar stays terse; only the tooltip carries
             * the disambiguating state.
             */}
            <SidebarMenuButton
              tooltip={t('sidebar.toggleThemeWithCurrent', {
                current: t(THEME_NAME_KEY[currentTheme]),
              })}
              onClick={onToggleTheme}
              data-testid="theme-toggle"
            >
              {isDark ? <Sun /> : <Moon />}
              <span>{t('sidebar.toggleTheme')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {(() => {
              // Surface the current keyboard binding in the
              // tooltip so users discover the shortcut without having
              // to open the cheatsheet first. Falls back to the bare
              // label when the binding is unset to avoid a stray "()".
              const shortcutKeys = getShortcutKeys('showShortcuts')
              const tooltip = shortcutKeys
                ? `${t('sidebar.shortcuts')} (${shortcutKeys})`
                : t('sidebar.shortcuts')
              return (
                <SidebarMenuButton tooltip={tooltip} onClick={onShowShortcuts}>
                  <Keyboard />
                  <span>{t('sidebar.shortcuts')}</span>
                </SidebarMenuButton>
              )
            })()}
          </SidebarMenuItem>
        </SidebarMenu>
        <CollapseButton />
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
 * (sync dot colour, theme cycle) re-renders on its own subscriptions
 * through `SpaceSwitcher` and `useSidebar()`. Mirrors the
 * `BlockListItem` Inner/memo pattern used elsewhere in the tree.
 */
export const AppSidebar = memo(AppSidebarInner)
AppSidebar.displayName = 'AppSidebar'
