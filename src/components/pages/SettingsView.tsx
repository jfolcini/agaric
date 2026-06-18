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
 *  - Help -- Report a bug (FEAT-5); future home of About / updates
 *
 * MAINT-128 (in progress): the General / Appearance / Help tabs and the
 * AutostartRow / QuickCaptureRow blocks have been lifted to siblings
 * under `./settings/`. The remaining tabs are still rendered inline via
 * their pre-existing top-level sibling components. The
 * `useSettingsTab()` hook for localStorage + URL persistence is the
 * one piece of MAINT-128's SettingsView row still pending — it stays
 * inlined here for now.
 *
 * #1108: the tabs are presented as a grouped vertical rail (see
 * `TAB_GROUPS`) — Workspace / Integrations / Data & Sync / Help — rather
 * than one flat horizontal strip. Grouping lowers the altitude of the
 * experimental/niche tabs and removed the old horizontal-overflow
 * `onWheel` (deltaY→scrollLeft) workaround.
 */

import { ChevronRight } from 'lucide-react'
import type React from 'react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AgentAccessSettingsTab } from '@/components/AgentAccessSettingsTab'
import { KeyboardSettingsTab } from '@/components/KeyboardSettingsTab'
import { DeviceManagement } from '@/components/peers/DeviceManagement'
import { PropertyDefinitionsList } from '@/components/properties/PropertyDefinitionsList'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { AppearanceTab } from '@/components/settings/AppearanceTab'
import { EditorTab } from '@/components/settings/EditorTab'
import { GeneralTab } from '@/components/settings/GeneralTab'
import { HelpTab } from '@/components/settings/HelpTab'
import { NotificationsTab } from '@/components/settings/NotificationsTab'
import { FeaturePageHeader } from '@/components/ui/feature-page-header'
import { dispatchBugReport } from '@/lib/bug-report-events'
import {
  getSettingsTabFromUrl,
  SETTINGS_ACTIVE_TAB_KEY,
  setSettingsTabInUrl,
} from '@/lib/url-state'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation'

// DataSettingsTab drags in `jszip` (~135 kB) for "Export as ZIP". The tab
// is rarely opened, so defer the import until the user clicks it (PERF-24).
const DataSettingsTab = lazy(() =>
  import('@/components/DataSettingsTab').then((m) => ({ default: m.DataSettingsTab })),
)

type SettingsTab =
  | 'general'
  | 'properties'
  | 'appearance'
  | 'editor'
  | 'keyboard'
  | 'data'
  | 'sync'
  | 'agent'
  | 'notifications'
  | 'help'

const TAB_IDS: SettingsTab[] = [
  'general',
  'properties',
  'appearance',
  'editor',
  'keyboard',
  'data',
  'sync',
  'agent',
  'notifications',
  'help',
]

// #754 — canonical key constant lives in `@/lib/url-state`; aliased to
// keep the existing read/write sites readable.
const ACTIVE_TAB_KEY = SETTINGS_ACTIVE_TAB_KEY

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
  editor: 'settings.tabEditor',
  keyboard: 'settings.tabKeyboard',
  data: 'settings.tabData',
  sync: 'settings.tabSync',
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
    tabs: ['general', 'appearance', 'editor', 'keyboard', 'properties'],
  },
  {
    id: 'integrations',
    labelKey: 'settings.groupIntegrations',
    tabs: ['notifications', 'agent'],
  },
  {
    id: 'data',
    labelKey: 'settings.groupData',
    tabs: ['data', 'sync'],
  },
  {
    id: 'help',
    labelKey: 'settings.groupHelp',
    tabs: ['help'],
  },
]

export function SettingsView(): React.ReactElement {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<SettingsTab>(readActiveTab)

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
      {/* PEND-UX item 5 — `FeaturePageHeader` carries the `<h1>` landmark
          + the UX-381 breadcrumb. The `<nav>` keeps its aria-label so
          existing role="navigation" assertions in SettingsView.test.tsx
          continue to resolve unchanged. */}
      <FeaturePageHeader
        title={t('sidebar.settings')}
        className="settings-view-header"
        breadcrumb={
          <nav
            aria-label={t('sidebar.settings')}
            className="flex items-center gap-1 text-sm text-muted-foreground"
          >
            <span>{t('sidebar.settings')}</span>
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="text-foreground font-medium">{t(TAB_LABEL_KEYS[activeTab])}</span>
          </nav>
        }
      />

      {/* #1108 — grouped settings layout. A vertical rail on the left holds
          the tabs bucketed into labeled sections (Workspace / Integrations /
          Data & Sync / Help); the active tab's panel renders to the right.
          The rail wraps under the panel on narrow screens (sm:flex-row), so
          there is no horizontal overflow and the old `onWheel`
          deltaY→scrollLeft workaround is gone. */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        {/* The whole rail is one tablist; each section is a labeled group of
            tabs so screen-reader users hear the grouping without the tabs
            losing their flat `role="tab"` membership. */}
        <div
          role="tablist"
          aria-label={t('sidebar.settings')}
          aria-orientation="vertical"
          className="flex flex-col gap-4 sm:w-48 sm:shrink-0"
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
                className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
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
                    // Mirrors the app sidebar's active-item treatment: a
                    // left accent bar (border-l-[3px] / dark:border-l-4) plus
                    // a subtle background on the selected row.
                    'w-full rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors border-l-[3px] dark:border-l-4',
                    activeTab === tab
                      ? // Unified active-indicator (#1232): square left corner so the
                        // accent bar sits flush (no rounded curve), warm-grey
                        // `sidebar-accent` tint + `primary` accent bar — identical to
                        // the app sidebar's active item and the active-block highlight.
                        'rounded-l-none border-primary bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground',
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
            here; the panes' own roots now all use the same `space-y-6` rhythm. */}
        <div
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
          data-testid={`settings-panel-${activeTab}`}
          className="min-w-0 flex-1 max-w-2xl"
        >
          {activeTab === 'general' && <GeneralTab />}

          {activeTab === 'properties' && <PropertyDefinitionsList />}

          {activeTab === 'appearance' && <AppearanceTab />}

          {activeTab === 'editor' && <EditorTab />}

          {activeTab === 'keyboard' && <KeyboardSettingsTab />}

          {activeTab === 'data' && (
            <Suspense fallback={<LoadingSkeleton count={4} height="h-6" />}>
              <DataSettingsTab />
            </Suspense>
          )}

          {activeTab === 'sync' && <DeviceManagement />}

          {activeTab === 'agent' && <AgentAccessSettingsTab />}

          {activeTab === 'notifications' && <NotificationsTab />}

          {activeTab === 'help' && (
            <HelpTab onReportBugClick={() => dispatchBugReport({ message: '' })} />
          )}
        </div>
      </div>
    </div>
  )
}
