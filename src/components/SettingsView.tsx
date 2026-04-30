/**
 * SettingsView -- tabbed settings panel (F-30).
 *
 * Tabs:
 *  - General   -- DeadlineWarningSection + AutostartRow + QuickCaptureRow
 *  - Properties -- PropertyDefinitionsList
 *  - Appearance -- theme selector (7 themes, UX-203) + font size selector
 *  - Keyboard -- KeyboardSettingsTab
 *  - Data -- DataSettingsTab (lazy)
 *  - Sync & Devices -- DeviceManagement
 *  - Agent access -- AgentAccessSettingsTab (FEAT-4e)
 *  - Google Calendar -- GoogleCalendarSettingsTab (FEAT-5f, experimental)
 *  - Help -- Report a bug (FEAT-5); future home of About / updates
 *
 * MAINT-128 (in progress): the General / Appearance / Help tabs and the
 * AutostartRow / QuickCaptureRow blocks have been lifted to siblings
 * under `./settings/`. The remaining tabs are still rendered inline via
 * their pre-existing top-level sibling components. The
 * `useSettingsTab()` hook for localStorage + URL persistence is the
 * one piece of MAINT-128's SettingsView row still pending — it stays
 * inlined here for now.
 */

import type React from 'react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getSettingsTabFromUrl, setSettingsTabInUrl } from '@/lib/url-state'
import { cn } from '@/lib/utils'
import { AgentAccessSettingsTab } from './AgentAccessSettingsTab'
import { BugReportDialog } from './BugReportDialog'
import { DeviceManagement } from './DeviceManagement'
import { GoogleCalendarSettingsTab } from './GoogleCalendarSettingsTab'
import { KeyboardSettingsTab } from './KeyboardSettingsTab'
import { LoadingSkeleton } from './LoadingSkeleton'
import { PropertyDefinitionsList } from './PropertyDefinitionsList'
import { AppearanceTab } from './settings/AppearanceTab'
import { GeneralTab } from './settings/GeneralTab'
import { HelpTab } from './settings/HelpTab'

// DataSettingsTab drags in `jszip` (~135 kB) for "Export as ZIP". The tab
// is rarely opened, so defer the import until the user clicks it (PERF-24).
const DataSettingsTab = lazy(() =>
  import('./DataSettingsTab').then((m) => ({ default: m.DataSettingsTab })),
)

type SettingsTab =
  | 'general'
  | 'properties'
  | 'appearance'
  | 'keyboard'
  | 'data'
  | 'sync'
  | 'agent'
  | 'google-calendar'
  | 'help'

const TAB_IDS: SettingsTab[] = [
  'general',
  'properties',
  'appearance',
  'keyboard',
  'data',
  'sync',
  'agent',
  'google-calendar',
  'help',
]

const ACTIVE_TAB_KEY = 'agaric-settings-active-tab'

/**
 * Load the active tab. Resolution order (UX-276):
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
  try {
    const stored = localStorage.getItem(ACTIVE_TAB_KEY)
    if (stored !== null && (TAB_IDS as readonly string[]).includes(stored)) {
      return stored as SettingsTab
    }
  } catch {
    // localStorage unavailable
  }
  return 'general'
}

const TAB_LABEL_KEYS: Record<SettingsTab, string> = {
  general: 'settings.tabGeneral',
  properties: 'settings.tabProperties',
  appearance: 'settings.tabAppearance',
  keyboard: 'settings.tabKeyboard',
  data: 'settings.tabData',
  sync: 'settings.tabSync',
  agent: 'settings.tabAgentAccess',
  'google-calendar': 'settings.tabGoogleCalendar',
  help: 'settings.tabHelp',
}

export function SettingsView(): React.ReactElement {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<SettingsTab>(readActiveTab)
  const [bugReportOpen, setBugReportOpen] = useState<boolean>(false)

  // Persist active tab so navigating away and back restores the user's place
  // (UX-276). Validation happens on read in `readActiveTab` — stored values
  // that no longer match a known tab fall back to `'general'`.
  //
  // We also mirror the active tab into the URL query string (`?settings=…`)
  // via `replaceState` so support / users can share deep links to a
  // specific tab. localStorage covers cross-window restoration; the URL
  // covers per-window deep links.
  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_TAB_KEY, activeTab)
    } catch {
      // localStorage unavailable
    }
    setSettingsTabInUrl(activeTab)
  }, [activeTab])

  // When SettingsView unmounts (user navigates away from Settings) clear
  // the `?settings=…` query param so the URL no longer claims the user is
  // on a specific Settings tab. Without this, the param would linger and
  // a refresh would yank the user back into Settings unexpectedly.
  useEffect(() => {
    return () => {
      setSettingsTabInUrl(null)
    }
  }, [])

  return (
    <div className="settings-view space-y-6">
      {/* Tab bar */}
      <div role="tablist" aria-label={t('sidebar.settings')} className="flex gap-1 border-b">
        {TAB_IDS.map((tab) => (
          <button
            type="button"
            key={tab}
            role="tab"
            id={`settings-tab-${tab}`}
            aria-selected={activeTab === tab}
            aria-controls={`settings-panel-${tab}`}
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
              activeTab === tab
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/50',
            )}
            onClick={() => setActiveTab(tab)}
          >
            {t(TAB_LABEL_KEYS[tab])}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      <div
        role="tabpanel"
        id={`settings-panel-${activeTab}`}
        aria-labelledby={`settings-tab-${activeTab}`}
        data-testid={`settings-panel-${activeTab}`}
      >
        {activeTab === 'general' && <GeneralTab />}

        {activeTab === 'properties' && <PropertyDefinitionsList />}

        {activeTab === 'appearance' && <AppearanceTab />}

        {activeTab === 'keyboard' && <KeyboardSettingsTab />}

        {activeTab === 'data' && (
          <Suspense fallback={<LoadingSkeleton count={4} height="h-6" />}>
            <DataSettingsTab />
          </Suspense>
        )}

        {activeTab === 'sync' && <DeviceManagement />}

        {activeTab === 'agent' && <AgentAccessSettingsTab />}

        {activeTab === 'google-calendar' && <GoogleCalendarSettingsTab />}

        {activeTab === 'help' && <HelpTab onReportBugClick={() => setBugReportOpen(true)} />}
      </div>

      <BugReportDialog open={bugReportOpen} onOpenChange={setBugReportOpen} />
    </div>
  )
}
