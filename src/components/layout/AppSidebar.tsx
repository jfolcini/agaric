/**
 * AppSidebar — sidebar shell extracted from App.tsx.
 *
 * #5269 — a header (branding + collapse toggle, space switcher, New page),
 * the daily surfaces (`SIDEBAR_NAV_ITEMS`), a lower group of Graph, Templates
 * and Trash (`SIDEBAR_LOWER_NAV_ITEMS`, #7040 D2) above Bookmarks, and a footer
 * with the Sync and Settings rows (#7040 P11). The other views open from the Pages
 * header or Settings. `CollapseButton` is a
 * sidebar-internal helper and lives alongside the JSX it supports;
 * `syncDotClass` colours the dot on the phone header's drawer button (App.tsx).
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

import type { TFunction } from 'i18next'
import { AlertCircle, CheckSquare, ChevronsLeft, Plus, RefreshCw, WifiOff } from 'lucide-react'
import { type ElementType, memo, type ReactElement } from 'react'
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { useMinuteClock } from '@/hooks/useMinuteClock'
import { useTrashCount } from '@/hooks/useTrashCount'
import { formatRelativeTime } from '@/lib/format-relative-time'
import {
  type NavItem,
  SETTINGS_NAV_ITEM,
  SIDEBAR_LOWER_NAV_ITEMS,
  SIDEBAR_NAV_ITEMS,
} from '@/lib/nav-items'
import { waitingForPeerLabel } from '@/lib/sync-waiting-label'
import { cn } from '@/lib/utils'
import { useJournalStore } from '@/stores/journal'
import type { View } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { type PeerInfo, type SyncState, useSyncStore } from '@/stores/sync'

/** The colour of the sync dot on the phone header's drawer button, shown once a device is paired. */
export function syncDotClass(syncState: SyncState): string {
  if (syncState === 'offline') return 'bg-muted-foreground'
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
    case 'waiting': {
      return 'bg-muted-foreground'
    }
  }
}

/**
 * The sync button's "last synced" line. #6523 — while waiting for an away
 * device, it names that device and its own last sync instead.
 */
function lastSyncedLine(
  t: TFunction,
  now: number,
  lastSyncedAt: string | null,
  peers: readonly PeerInfo[],
  waitingFor: string | null,
): string {
  if (waitingFor !== null) return waitingForPeerLabel(peers, waitingFor, t, now)
  return lastSyncedAt
    ? t('sidebar.lastSynced', { time: formatRelativeTime(lastSyncedAt, t, now) })
    : t('sidebar.lastSyncedNever')
}

/**
 * The Sync row's state in words (#7040 P11): offline, then a running sync, then no peers,
 * then a failure; otherwise when it last synced, or whom it waits for.
 */
function syncStateWords(
  t: TFunction,
  state: {
    isOnline: boolean
    syncing: boolean
    hasPeers: boolean
    failed: boolean
    lastSynced: string
  },
): string {
  if (!state.isOnline) return t('sidebar.offline')
  if (state.syncing) return t('sidebar.syncing')
  if (!state.hasPeers) return t('sync.noPeersTitle')
  if (state.failed) return t('sidebar.syncStateFailed')
  return state.lastSynced
}

const LAST_SYNCED_ID = 'sidebar-last-synced'
const SYNC_STATUS_ID = 'sidebar-sync-status'

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
  onSyncClick: () => void | Promise<void>
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
  const syncError = useSyncStore((s) => s.error)
  const waitingFor = useSyncStore((s) => s.waitingFor)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const { isMobile, setOpenMobile } = useSidebar()
  const journalMode = useJournalStore((s) => s.mode)
  const setJournalMode = useJournalStore((s) => s.setMode)
  const onAgenda = currentView === 'journal' && journalMode === 'agenda'
  const now = useMinuteClock()
  const trashCount = useTrashCount(currentView)
  const syncUnavailable = syncing || !isOnline
  // Offline wins, then no peers; a running sync replaces the old error.
  const hasPeers = syncPeers.length > 0
  const syncSettled = isOnline && !syncing
  const syncFailed = syncSettled && hasPeers && syncState === 'error'
  const lastSyncedLabel = lastSyncedLine(t, now, lastSyncedAt, syncPeers, waitingFor)
  const syncStatusLabel = syncFailed
    ? t('sync.failed', { message: syncError ?? '' })
    : syncSettled && !hasPeers
      ? t('sync.noPeersTitle')
      : null
  const syncStateWord = syncStateWords(t, {
    isOnline,
    syncing: syncing || syncState === 'syncing',
    hasPeers,
    failed: syncFailed,
    lastSynced: lastSyncedLabel,
  })

  /**
   * On mobile the sidebar is a Sheet that overlays the content, so acting on
   * an item has to dismiss it — otherwise the user arrives at the new view
   * with the drawer still covering it. Desktop keeps the sidebar pinned
   * beside the content, where dismissing would be wrong, so this is a no-op
   * there.
   *
   * Applied to navigation, to New page and to the SpaceSwitcher's Settings ›
   * Spaces items, which take the user elsewhere.
   * Deliberately NOT applied to sync, an in-place action whose result is
   * visible in the sidebar itself.
   */
  const dismissOnMobile = (): void => {
    if (isMobile) setOpenMobile(false)
  }

  const renderMenuButton = (
    key: string,
    Icon: ElementType,
    label: string,
    active: boolean,
    select: () => void,
    badge?: { count: number; name: string },
  ): ReactElement => (
    <SidebarMenuItem key={key}>
      <SidebarMenuButton
        isActive={active}
        aria-current={active ? 'page' : undefined}
        // The badge is outside the button, so its count goes in the name.
        aria-label={badge?.name}
        tooltip={badge?.name ?? label}
        onClick={() => {
          select()
          dismissOnMobile()
        }}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
      {badge && (
        // A coarse pointer's row is taller; the badge stays centred in it.
        <SidebarMenuBadge className="coarse:peer-data-[size=default]/menu-button:top-3">
          {badge.count}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )

  const renderLowerNavItem = (item: NavItem): ReactElement => {
    const label = t(item.labelKey)
    const badge =
      item.id === 'trash' && trashCount > 0
        ? { count: trashCount, name: t('sidebar.trashWithCount', { count: trashCount }) }
        : undefined
    return renderMenuButton(
      item.id,
      item.icon,
      label,
      currentView === item.id,
      () => onSelectView(item.id),
      badge,
    )
  }

  const renderNavItem = (item: NavItem): ReactElement[] => {
    if (item.id !== 'journal') {
      return [
        renderMenuButton(item.id, item.icon, t(item.labelKey), currentView === item.id, () =>
          onSelectView(item.id),
        ),
      ]
    }
    // #6532 — the Agenda gets its own row under Journal, one tap from
    // anywhere. Journal then always opens a dated mode.
    return [
      renderMenuButton(
        item.id,
        item.icon,
        t(item.labelKey),
        currentView === 'journal' && !onAgenda,
        () => {
          if (journalMode === 'agenda') setJournalMode('daily')
          onSelectView('journal')
        },
      ),
      renderMenuButton('agenda', CheckSquare, t('journal.agendaTab'), onAgenda, () => {
        setJournalMode('agenda')
        onSelectView('journal')
      }),
    ]
  }

  return (
    /*
     * "icon" is a DESKTOP-only choice: it collapses the sidebar to a 48px
     * icon-only rail rather than fully off-canvas, so the primary nav stays
     * one click away instead of needing a swipe/click to re-open. Where the
     * sidebar is a Sheet (a phone, upright or on its side) the `collapsible`
     * prop has no effect — it opens from the header hamburger, and 48px of a
     * phone's width goes to content. See docs/UX.md § Mobile Sidebar.
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
          <SpaceSwitcher onNavigate={dismissOnMobile} />
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
          {/* #5269 — the few daily items need no group label. */}
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>{SIDEBAR_NAV_ITEMS.flatMap(renderNavItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {/* #7040 D2 — the views a day needs less often. Above Bookmarks, so
              their place does not move with the bookmark count. */}
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>{SIDEBAR_LOWER_NAV_ITEMS.map(renderLowerNavItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {/* #4713 — the bookmarked pages, as a collapsible section. Below
              the fixed nav because its length varies with the bookmarks. */}
          <BookmarksSection />
        </FeatureErrorBoundary>
      </SidebarContent>
      <SidebarFooter>
        {/* #7040 P11 — Sync and Settings are rows like the nav rows above, and the sync row
            names its state in words. In the 48px rail they fold to icons. The tooltip and the
            button's description carry the error or "no devices paired" line and the "last
            synced" line. */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              // `aria-disabled`, not `disabled`, and still hoverable: a disabled button takes
              // no hover or focus, so the offline / syncing tooltip could never show.
              className="aria-disabled:pointer-events-auto aria-disabled:cursor-default"
              // Offline, the name is the row's words: it holds what it shows (WCAG 2.5.3).
              aria-label={
                isOnline ? t('sidebar.sync') : `${t('sidebar.sync')} ${t('sidebar.offline')}`
              }
              aria-describedby={
                syncStatusLabel === null ? LAST_SYNCED_ID : `${SYNC_STATUS_ID} ${LAST_SYNCED_ID}`
              }
              tooltip={{
                // Shown beside the expanded rows too, where it adds the "last synced" line.
                hidden: isMobile,
                children: (
                  <div className="flex flex-col gap-0.5">
                    <span>
                      {!isOnline
                        ? t('sidebar.offline')
                        : syncing
                          ? t('sidebar.syncing')
                          : (syncStatusLabel ?? t('sidebar.syncTooltip'))}
                    </span>
                    <span className="opacity-90">{lastSyncedLabel}</span>
                  </div>
                ),
              }}
              aria-disabled={syncUnavailable}
              onClick={syncUnavailable ? undefined : () => void onSyncClick()}
            >
              {!isOnline ? (
                <WifiOff className="text-muted-foreground" />
              ) : syncFailed ? (
                <AlertCircle className="text-destructive" />
              ) : (
                <RefreshCw className={syncing ? 'animate-spin' : ''} />
              )}
              <span>{t('sidebar.sync')}</span>
              <span
                className={cn(
                  'ml-auto text-xs',
                  syncFailed ? 'text-destructive' : 'text-muted-foreground',
                )}
                data-testid="sync-state"
                data-sync-state={syncState}
              >
                {syncStateWord}
              </span>
            </SidebarMenuButton>
            {syncStatusLabel !== null && (
              <span id={SYNC_STATUS_ID} className="sr-only">
                {syncStatusLabel}
              </span>
            )}
            <span id={LAST_SYNCED_ID} className="sr-only" data-testid="last-synced">
              {lastSyncedLabel}
            </span>
          </SidebarMenuItem>
          {renderMenuButton(
            SETTINGS_NAV_ITEM.id,
            SETTINGS_NAV_ITEM.icon,
            t(SETTINGS_NAV_ITEM.labelKey),
            currentView === SETTINGS_NAV_ITEM.id,
            () => onSelectView(SETTINGS_NAV_ITEM.id),
          )}
        </SidebarMenu>
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
 * (the sync row's state) re-renders on its own subscriptions
 * through `SpaceSwitcher` and `useSidebar()`. Mirrors the
 * `BlockListItem` Inner/memo pattern used elsewhere in the tree.
 */
export const AppSidebar = memo(AppSidebarInner)
AppSidebar.displayName = 'AppSidebar'
