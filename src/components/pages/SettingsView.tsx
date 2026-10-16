/**
 * SettingsView -- tabbed settings panel (F-30).
 *
 * The rail is `TAB_GROUPS` (#1108): four labelled groups in a vertical tablist
 * from `sm` up, and a grouped Select on phones (#5344). Each tab's body lives
 * in its own component; this view owns the active tab (`?settings=<id>`, the
 * deep-link handoff slot, localStorage) and the integrity result that Help's
 * Report a bug carries (#5360).
 */

import type React from 'react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StatusPanel, SyncStatusCard } from '@/components/agenda/StatusPanel'
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
  | 'appearance'
  | 'editor'
  | 'keyboard'
  | 'notifications'
  | 'spaces'
  | 'properties'
  | 'agent'
  | 'sync'
  | 'data'
  | 'help'
  | 'status'

interface TabGroup {
  /** i18n key for the section header. */
  readonly labelKey: string
  /** Stable id used for the section header element + aria wiring. */
  readonly id: string
  readonly tabs: readonly SettingsTab[]
}

// The rail, top to bottom. Tab ids are deep-link targets, so a tab keeps its
// id when it moves or is relabelled (`notifications` is Tasks & reminders).
const TAB_GROUPS: readonly TabGroup[] = [
  {
    id: 'workspace',
    labelKey: 'settings.groupWorkspace',
    tabs: ['general', 'appearance', 'editor', 'keyboard', 'notifications', 'spaces', 'properties'],
  },
  {
    id: 'integrations',
    labelKey: 'settings.groupIntegrations',
    tabs: ['agent'],
  },
  {
    id: 'data',
    labelKey: 'settings.groupData',
    tabs: ['sync', 'data'],
  },
  {
    id: 'help',
    labelKey: 'settings.groupHelp',
    tabs: ['help', 'status'],
  },
]

const TAB_IDS: readonly string[] = TAB_GROUPS.flatMap((group) => group.tabs)

/** The Edit history tab became a row in Data (#5629), so its old links land there. */
const RETIRED_HISTORY_TAB = 'history'

/** A tab id from a URL, localStorage or a deep link, or `null` if no tab has it. */
function resolveTab(id: string): SettingsTab | null {
  if (id === RETIRED_HISTORY_TAB) return 'data'
  return TAB_IDS.includes(id) ? (id as SettingsTab) : null
}

/**
 * Load the active tab. Resolution order:
 *   1. `?settings=<tab>` query param — enables shareable deep links.
 *   2. localStorage (`agaric-settings-active-tab`) — restores the user's
 *      last-visited tab across navigations within the app.
 *   3. `'general'` fallback.
 *
 * Every layer goes through `resolveTab`, so a removed tab or a hand-crafted
 * URL can't leave the panel in an inconsistent state.
 */
function readActiveTab(): SettingsTab {
  const fromUrl = getSettingsTabFromUrl([...TAB_IDS, RETIRED_HISTORY_TAB])
  return resolveTab(fromUrl ?? readPreference(PREFERENCES.settingsActiveTab)) ?? 'general'
}

const TAB_LABEL_KEYS: Record<SettingsTab, string> = {
  general: 'settings.tabGeneral',
  appearance: 'settings.tabAppearance',
  editor: 'settings.tabEditor',
  keyboard: 'settings.tabKeyboard',
  notifications: 'settings.tabNotifications',
  spaces: 'settings.tabSpaces',
  properties: 'settings.tabProperties',
  agent: 'settings.tabAgentAccess',
  sync: 'settings.tabSync',
  data: 'settings.tabData',
  help: 'settings.tabHelp',
  status: 'settings.tabStatus',
}

export function SettingsView(): React.ReactElement {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<SettingsTab>(readActiveTab)
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
    const requested = resolveTab(pendingSettingsTab)
    if (requested !== null) {
      // oxlint-disable-next-line react/set-state-in-effect -- consumes the navigation store's one-shot deep-link handoff slot; the tab is also user-driven, so it cannot be derived from `pendingSettingsTab`; see #4407
      setActiveTab(requested)
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
          {/* Every tab fits on a phone; the shared 24rem cap would hide the last ones. */}
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

          {activeTab === 'appearance' && <AppearanceTab />}

          {activeTab === 'editor' && <EditorTab />}

          {activeTab === 'keyboard' && <KeyboardTab />}

          {activeTab === 'notifications' && <NotificationsTab />}

          {activeTab === 'spaces' && <SpacesTab />}

          {activeTab === 'properties' && (
            <Card>
              <CardContent>
                <PropertyDefinitionsList />
              </CardContent>
            </Card>
          )}

          {activeTab === 'agent' && <AgentAccessTab />}

          {activeTab === 'sync' && (
            <div className="space-y-6">
              <SyncStatusCard />
              <DeviceManagement />
            </div>
          )}

          {activeTab === 'data' && (
            <Suspense fallback={<LoadingSkeleton count={4} height="h-6" />}>
              <DataTab />
            </Suspense>
          )}

          {activeTab === 'help' && (
            <HelpTab
              onReportBugClick={() =>
                dispatchBugReport({ message: '', integrityReport: integrity.report ?? undefined })
              }
            />
          )}

          {activeTab === 'status' && (
            <div className="space-y-6">
              <IntegrityCheckSection {...integrity} />
              <StatusPanel />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
