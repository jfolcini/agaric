/**
 * SettingsView -- tabbed settings panel (F-30).
 *
 * Tabs:
 *  - General   -- DeadlineWarningSection + AutostartRow + QuickCaptureRow
 *  - Spaces -- SpacesTab: open-on-launch space, create / rename / delete (#5362)
 *  - Properties -- PropertyDefinitionsList
 * Appearance -- theme selector (7 themes) + font size selector
 *  - Keyboard -- KeyboardTab
 *  - Data -- DataTab (lazy)
 *  - Edit history -- a row into the History view (#5361)
 *  - Sync & Devices -- DeviceManagement
 *  - App health (id `status`) -- StatusPanel (#5269: formerly its own view)
 *    + IntegrityCheckSection (#5360)
 * Agent access -- AgentAccessTab
 * Help -- Report a bug; updates
 *
 * (in progress): the General / Appearance / Help tabs and the
 * AutostartRow / QuickCaptureRow blocks have been lifted to siblings
 * under `./settings/`. The remaining tabs are still rendered inline via
 * their pre-existing top-level sibling components. The
 * `useSettingsTab()` hook for localStorage + URL persistence is the
 * One piece of SettingsView row still pending — it stays
 * inlined here for now.
 *
 * #1108: the tabs are presented as a grouped vertical rail (see
 * `TAB_GROUPS`) — Workspace / Integrations / Data & Sync / Help — rather
 * than one flat horizontal strip. Grouping lowers the altitude of the
 * experimental/niche tabs and removed the old horizontal-overflow
 * `onWheel` (deltaY→scrollLeft) workaround.
 */

import { History } from 'lucide-react'
import type React from 'react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StatusPanel } from '@/components/agenda/StatusPanel'
import { DeviceManagement } from '@/components/peers/DeviceManagement'
import { PropertyDefinitionsList } from '@/components/properties/PropertyDefinitionsList'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { AgentAccessTab } from '@/components/settings/AgentAccessTab'
import { AppearanceTab } from '@/components/settings/AppearanceTab'
import { EditorTab } from '@/components/settings/EditorTab'
import { GeneralTab } from '@/components/settings/GeneralTab'
import { HelpTab } from '@/components/settings/HelpTab'
import { IntegrityCheckSection } from '@/components/settings/IntegrityCheckSection'
import { KeyboardTab } from '@/components/settings/KeyboardTab'
import { NotificationsTab } from '@/components/settings/NotificationsTab'
import { SpacesTab } from '@/components/settings/SpacesTab'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow } from '@/components/ui/setting-row'
import { useReconciliationReport } from '@/hooks/useReconciliationReport'
import { dispatchBugReport } from '@/lib/bug-report-events'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'
import { getSettingsTabFromUrl, setSettingsTabInUrl } from '@/lib/url-state'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation'

// DataTab drags in `jszip` (~135 kB) for "Export as ZIP". The tab
// Is rarely opened, so defer the import until the user clicks it.
const DataTab = lazy(() =>
  import('@/components/settings/DataTab').then((m) => ({ default: m.DataTab })),
)

type SettingsTab =
  | 'general'
  | 'spaces'
  | 'properties'
  | 'appearance'
  | 'editor'
  | 'keyboard'
  | 'data'
  | 'history'
  | 'sync'
  | 'status'
  | 'agent'
  | 'notifications'
  | 'help'

const TAB_IDS: SettingsTab[] = [
  'general',
  'spaces',
  'properties',
  'appearance',
  'editor',
  'keyboard',
  'data',
  'history',
  'sync',
  'status',
  'agent',
  'notifications',
  'help',
]

/**
 * Load the active tab. Resolution order:
 *   1. `?settings=<tab>` query param — enables shareable deep links.
 *   2. localStorage (`agaric-settings-active-tab`) — restores the user's
 *      last-visited tab across navigations within the app.
 *   3. `'general'` fallback.
 *
 * All three layers validate against the `SettingsTab` union so a
 * removed/renamed tab or a hand-crafted URL can't leave the panel in an
 * inconsistent state.
 */
function readActiveTab(): SettingsTab {
  const fromUrl = getSettingsTabFromUrl(TAB_IDS as readonly string[])
  if (fromUrl !== null) return fromUrl as SettingsTab
  const stored = readPreference(PREFERENCES.settingsActiveTab)
  if (stored !== '' && (TAB_IDS as readonly string[]).includes(stored)) {
    return stored as SettingsTab
  }
  return 'general'
}

const TAB_LABEL_KEYS: Record<SettingsTab, string> = {
  general: 'settings.tabGeneral',
  spaces: 'settings.tabSpaces',
  properties: 'settings.tabProperties',
  appearance: 'settings.tabAppearance',
  editor: 'settings.tabEditor',
  keyboard: 'settings.tabKeyboard',
  data: 'settings.tabData',
  history: 'settings.tabHistory',
  sync: 'settings.tabSync',
  status: 'settings.tabStatus',
  agent: 'settings.tabAgentAccess',
  notifications: 'settings.tabNotifications',
  help: 'settings.tabHelp',
}

// #1108 — shallow grouping for the tab rail. Instead of 11 flat peers in a
// single horizontal, wheel-scrollable strip (where experimental/niche tabs
// like Google Calendar / Agent access sat at the same altitude as core
// ones), the tabs are bucketed into labeled sections rendered as a vertical
// settings rail. Grouping lowers the visual weight of the niche tabs and
// removes the horizontal overflow that the old `onWheel` workaround papered
// over. The `TAB_IDS` union, `TAB_LABEL_KEYS`, and persistence
// (`readActiveTab` / `?settings=` / localStorage) are unchanged — only the
// presentation is grouped.
//
// INVARIANT: every `SettingsTab` appears in exactly one group, and the
// flattened group order matches `TAB_IDS`. A vitest assertion guards this so
// a newly-added tab can't silently fall out of the rail.
interface TabGroup {
  /** i18n key for the section header. */
  readonly labelKey: string
  /** Stable id used for the section header element + aria wiring. */
  readonly id: string
  readonly tabs: readonly SettingsTab[]
}

const TAB_GROUPS: readonly TabGroup[] = [
  {
    id: 'workspace',
    labelKey: 'settings.groupWorkspace',
    tabs: ['general', 'spaces', 'appearance', 'editor', 'keyboard', 'properties'],
  },
  {
    id: 'integrations',
    labelKey: 'settings.groupIntegrations',
    tabs: ['notifications', 'agent'],
  },
  {
    id: 'data',
    labelKey: 'settings.groupData',
    tabs: ['data', 'history', 'sync'],
  },
  {
    id: 'help',
    labelKey: 'settings.groupHelp',
    tabs: ['help', 'status'],
  },
]

export function SettingsView(): React.ReactElement {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<SettingsTab>(readActiveTab)
  const setView = useNavigationStore((s) => s.setView)
  // Held here, not in the App health tab that runs it, so Help's Report a bug
  // can carry the latest result (#5360).
  const integrity = useReconciliationReport('SettingsView')

  // #734 — consume the pending-tab handoff slot. The deep-link router and
  // the NoPeersDialog CTA write it before flipping the view to
  // `'settings'`; subscribing (rather than reading once in the useState
  // initializer like localStorage / the URL param) means an
  // `agaric://settings/<tab>` link still lands while Settings is ALREADY
  // the current view. Unknown tab names are dropped; the slot is cleared
  // either way so a stale request can't re-fire on the next mount.
  const pendingSettingsTab = useNavigationStore((s) => s.pendingSettingsTab)
  useEffect(() => {
    if (pendingSettingsTab === null) return
    if ((TAB_IDS as readonly string[]).includes(pendingSettingsTab)) {
      // oxlint-disable-next-line react/set-state-in-effect -- consumes the navigation store's one-shot deep-link handoff slot; the tab is also user-driven, so it cannot be derived from `pendingSettingsTab`; see #4407
      setActiveTab(pendingSettingsTab as SettingsTab)
    }
    // Clear only if the slot still holds the value this effect consumed —
    // passive effects flush asynchronously after commit, so a SECOND deep
    // link can write the slot in between; an unconditional null here would
    // swallow it before its own effect run ever sees it.
    const store = useNavigationStore.getState()
    if (store.pendingSettingsTab === pendingSettingsTab) {
      store.setPendingSettingsTab(null)
    }
  }, [pendingSettingsTab])

  // Persist active tab so navigating away and back restores the user's place
  // Validation happens on read in `readActiveTab` — stored values
  // that no longer match a known tab fall back to `'general'`.
  //
  // We also mirror the active tab into the URL query string (`?settings=…`)
  // via `replaceState` so support / users can share deep links to a
  // specific tab. localStorage covers cross-window restoration; the URL
  // covers per-window deep links.
  useEffect(() => {
    writePreference(PREFERENCES.settingsActiveTab, activeTab)
    setSettingsTabInUrl(activeTab)
  }, [activeTab])

  // When SettingsView unmounts (user navigates away from Settings) clear
  // the `?settings=…` query param so the URL no longer claims the user is
  // on a specific Settings tab. Without this, the param would linger and
  // a refresh would yank the user back into Settings unexpectedly.
  useEffect(
    () => () => {
      setSettingsTabInUrl(null)
    },
    [],
  )

  return (
    <div className="settings-view space-y-6">
      {/* #1108 — grouped settings layout. A vertical rail on the left holds
          the tabs bucketed into labeled sections (Workspace / Integrations /
          Data & Sync / Help); the active tab's panel renders to the right. */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        {/* Below `sm` the stacked rail is ~500px tall and pushes the panel
            below the fold, so a tab tap looks like it did nothing. Phones
            pick the tab from this Select instead; the rail is hidden. */}
        <Select value={activeTab} onValueChange={(tab) => setActiveTab(tab as SettingsTab)}>
          <SelectTrigger aria-label={t('sidebar.settings')} className="sm:hidden">
            <SelectValue />
          </SelectTrigger>
          {/* All thirteen tabs fit on a phone; the shared 24rem cap would hide the last ones. */}
          <SelectContent className="max-h-(--radix-select-content-available-height)">
            {TAB_GROUPS.map((group) => (
              <SelectGroup key={group.id}>
                <SelectLabel>{t(group.labelKey)}</SelectLabel>
                {group.tabs.map((tab) => (
                  <SelectItem key={tab} value={tab}>
                    {t(TAB_LABEL_KEYS[tab])}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        {/* The whole rail is one tablist; each section is a labeled group of
            tabs so screen-reader users hear the grouping without the tabs
            losing their flat `role="tab"` membership. */}
        <div
          role="tablist"
          aria-label={t('sidebar.settings')}
          aria-orientation="vertical"
          className="hidden flex-col gap-4 sm:flex sm:w-48 sm:shrink-0"
          data-testid="settings-tab-rail"
        >
          {TAB_GROUPS.map((group) => (
            // role="presentation" makes the group wrapper transparent to the
            // accessibility tree so the `tab` buttons remain DIRECT children
            // of the `tablist` (WAI-ARIA requires tablist→tab parentage —
            // a real role="group" between them is a violation). The visible
            // section header still groups the tabs for sighted users; it
            // also carries role="presentation" so it isn't announced as a
            // heading sitting illegally inside the tablist. The grouping is
            // surfaced to assistive tech instead via each tab's
            // `aria-describedby` pointing at the (hidden) header text.
            <div key={group.id} role="presentation" className="flex flex-col gap-0.5">
              <span
                id={`settings-group-${group.id}`}
                role="presentation"
                className="px-3 pb-1 text-xs font-medium text-muted-foreground"
              >
                {t(group.labelKey)}
              </span>
              {group.tabs.map((tab) => (
                <button
                  type="button"
                  key={tab}
                  role="tab"
                  id={`settings-tab-${tab}`}
                  aria-selected={activeTab === tab}
                  aria-controls={`settings-panel-${tab}`}
                  aria-describedby={`settings-group-${group.id}`}
                  className={cn(
                    // Same neutral `sidebar-accent` pill as the app sidebar's
                    // active item (#5332).
                    'w-full rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors [@media(pointer:coarse)]:min-h-11',
                    activeTab === tab
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                  onClick={() => setActiveTab(tab)}
                >
                  {t(TAB_LABEL_KEYS[tab])}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Tab panels.

            #1731 — the tabpanel host owns the one width decision (`max-w-2xl`)
            so every tab shares the same content cap. Previously each pane root
            set its own (max-w-md / max-w-xl / none) plus a divergent
            vertical-rhythm token (space-y-4 vs space-y-6), so switching tabs
            visibly re-widthed and re-spaced the content. The width cap is unified
            here; panes that stack several Cards (Data, Help) space them with `space-y-6`. */}
        <div
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
          data-testid={`settings-panel-${activeTab}`}
          className="min-w-0 flex-1 max-w-2xl"
        >
          {activeTab === 'general' && <GeneralTab />}

          {activeTab === 'spaces' && <SpacesTab />}

          {activeTab === 'properties' && (
            <Card>
              <CardContent>
                <PropertyDefinitionsList />
              </CardContent>
            </Card>
          )}

          {activeTab === 'appearance' && <AppearanceTab />}

          {activeTab === 'editor' && <EditorTab />}

          {activeTab === 'keyboard' && <KeyboardTab />}

          {activeTab === 'data' && (
            <Suspense fallback={<LoadingSkeleton count={4} height="h-6" />}>
              <DataTab />
            </Suspense>
          )}

          {/* HistoryView is a full-page view: it portals its filter bar into the
              shell header and takes Space / Enter / arrows on `document`, so the
              tab opens it rather than hosting it. */}
          {activeTab === 'history' && (
            <Card>
              <CardContent>
                <SettingRow
                  label={t('settings.history.label')}
                  description={t('settings.history.description')}
                >
                  <Button variant="outline" size="sm" onClick={() => setView('history')}>
                    <History />
                    {t('settings.history.openButton')}
                  </Button>
                </SettingRow>
              </CardContent>
            </Card>
          )}

          {activeTab === 'sync' && <DeviceManagement />}

          {activeTab === 'status' && (
            <div className="space-y-4">
              <StatusPanel />
              <IntegrityCheckSection {...integrity} />
            </div>
          )}

          {activeTab === 'agent' && <AgentAccessTab />}

          {activeTab === 'notifications' && <NotificationsTab />}

          {activeTab === 'help' && (
            <HelpTab
              onReportBugClick={() =>
                dispatchBugReport({ message: '', integrityReport: integrity.report ?? undefined })
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}
