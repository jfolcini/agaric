/**
 * AppSidebar — sidebar shell extracted from App.tsx (MAINT-124 step 2).
 *
 * Owns the sticky top space-switcher branding, the primary navigation
 * menu, and the bottom action strip (new page, sync, theme toggle,
 * shortcuts, collapse). All cross-cutting state (current view, sync
 * status, theme, dialogs) remains in the parent (App.tsx) and is
 * passed in as props for now — this batch is a pure JSX move, not a
 * state migration. `CollapseButton` and `syncDotClass` are
 * sidebar-internal helpers and live alongside the JSX they support.
 *
 * Subsequent MAINT-124 batches will extract `useAppDialogs()` and
 * `<ViewDispatcher>` from the remaining App.tsx body.
 */

import { ChevronsLeft, Keyboard, Moon, Plus, RefreshCw, Sun, WifiOff } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { THEME_NAME_KEY, type ThemePreference } from '../hooks/useTheme'
import { formatRelativeTime } from '../lib/format-relative-time'
import { getShortcutKeys } from '../lib/keyboard-config'
import type { SpaceRow } from '../lib/tauri'
import { cn } from '../lib/utils'
import type { View } from '../stores/navigation'
import type { PeerInfo, SyncState } from '../stores/sync'
import { FeatureErrorBoundary } from './FeatureErrorBoundary'
import { NAV_ITEMS } from './nav-items'
import { SpaceAccentBadge } from './SpaceAccentBadge'
import { SpaceStatusChip } from './SpaceStatusChip'
import { SpaceSwitcher } from './SpaceSwitcher'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from './ui/sidebar'

/**
 * Compute the CSS class for the sync status dot colour.
 *
 * UX-380: distinguish "offline" (network problem, nothing the user can do)
 * from "no peers" (pairing problem, the user needs to add a device). Offline
 * wins over no-peers because peer state is meaningless without a network.
 */
function syncDotClass(syncState: SyncState, hasPeers: boolean): string {
  if (syncState === 'offline') return 'bg-muted-foreground'
  if (!hasPeers) return 'bg-status-pending'
  switch (syncState) {
    case 'idle':
      return 'bg-sync-idle'
    case 'syncing':
    case 'discovering':
    case 'pairing':
      return 'bg-sync-active'
    case 'error':
      return 'bg-destructive'
    default:
      return 'bg-muted-foreground'
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
  conflictCount: number
  trashCount: number
  syncState: SyncState
  syncPeers: PeerInfo[]
  syncing: boolean
  isOnline: boolean
  lastSyncedAt: string | null
  isDark: boolean
  currentTheme: ThemePreference
  onToggleTheme: () => void
  onNewPage: () => void
  onSyncClick: () => void
  onShowShortcuts: () => void
  availableSpaces: SpaceRow[]
  currentSpaceId: string | null
}

export function AppSidebar({
  currentView,
  onSelectView,
  conflictCount,
  trashCount,
  syncState,
  syncPeers,
  syncing,
  isOnline,
  lastSyncedAt,
  isDark,
  currentTheme,
  onToggleTheme,
  onNewPage,
  onSyncClick,
  onShowShortcuts,
  availableSpaces,
  currentSpaceId,
}: AppSidebarProps): ReactElement {
  const { t } = useTranslation()
  return (
    /*
     * "icon" collapses the sidebar to a 48px icon-only rail rather than
     * fully off-canvas. Chosen over "offcanvas" so that on desktop the
     * primary nav stays one click away (vs. requiring a swipe/click to
     * re-open). See UX.md § Mobile Sidebar.
     */
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4 pb-2">
        {/*
         * FEAT-3 Phase 1: replace static branding with the
         * SpaceSwitcher. The switcher occupies the same vertical
         * footprint so downstream sidebar height math stays valid.
         * It is hidden when the sidebar collapses to icon mode to
         * preserve the compact rail layout (the switcher
         * re-appears on expand).
         *
         * FEAT-3p10: when the sidebar collapses, the SpaceSwitcher
         * dropdown disappears and the user loses the only visual
         * cue of which space is active. The SpaceAccentBadge takes
         * its place in the icon rail — a 32px circle with the
         * first letter of the space name on top of the accent
         * color. Click cycles to the next space.
         */}
        <div className="hidden justify-center group-data-[collapsible=icon]:flex">
          {(() => {
            const active = availableSpaces.find((s) => s.id === currentSpaceId) ?? null
            return active != null ? <SpaceAccentBadge space={active} /> : null
          })()}
        </div>
        <div className="group-data-[collapsible=icon]:hidden">
          <SpaceSwitcher />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <FeatureErrorBoundary name="Sidebar">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV_ITEMS.map((item) => {
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
                        {item.id === 'conflicts' && conflictCount > 0 && (
                          <SidebarMenuBadge
                            aria-label={t('sidebar.conflictCount', { count: conflictCount })}
                          >
                            {conflictCount}
                          </SidebarMenuBadge>
                        )}
                        {item.id === 'trash' && trashCount > 0 && (
                          <SidebarMenuBadge
                            aria-label={t('sidebar.trashCount', { count: trashCount })}
                          >
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
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </FeatureErrorBoundary>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={t('sidebar.newPageTooltip')} onClick={onNewPage}>
              <Plus />
              <span>{t('sidebar.newPage')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              // UX-379 — the visible "last synced" line below is hidden in
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
            {/*
             * FEAT-3p10 — visual identity status chip. Sits next to
             * the sync chip so the sidebar footer carries one
             * cohesive "what is active" surface. Click forwards
             * focus to the SpaceSwitcher trigger so the user can
             * pick a different space without hunting for the
             * dropdown. Auto-hides when no space is active (boot
             * pre-bootstrap edge case).
             */}
            <div className="px-2 pt-1 group-data-[collapsible=icon]:hidden">
              <SpaceStatusChip />
            </div>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/*
             * UX-387 — surface the current theme in the tooltip so the
             * 3-state cycle (auto / dark / light) is no longer silent.
             * The visible label still reads "Toggle theme" so the
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
              // UX-396 — surface the current keyboard binding in the
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
