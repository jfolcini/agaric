/**
 * SettingsView -- tabbed settings panel (F-30).
 *
 * Tabs:
 *  - General   -- DeadlineWarningSection
 *  - Properties -- PropertyDefinitionsList
 *  - Appearance -- theme selector (7 themes, UX-203) + font size selector
 *  - Keyboard -- KeyboardSettingsTab
 *  - Data -- DataSettingsTab (lazy)
 *  - Sync & Devices -- DeviceManagement
 *  - Agent access -- AgentAccessSettingsTab (FEAT-4e)
 *  - Google Calendar -- GoogleCalendarSettingsTab (FEAT-5f, experimental)
 *  - Help -- Report a bug (FEAT-5); future home of About / updates
 */

import type React from 'react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useIsMobile } from '@/hooks/use-mobile'
import { type ThemePreference, useTheme } from '@/hooks/useTheme'
import { logger } from '@/lib/logger'
import {
  defaultQuickCaptureShortcut,
  loadQuickCaptureShortcut,
  QUICK_CAPTURE_SHORTCUT_STORAGE_KEY,
  saveQuickCaptureShortcut,
} from '@/lib/quick-capture-shortcut'
import {
  disableAutostart,
  enableAutostart,
  isAutostartEnabled,
  registerGlobalShortcut,
  unregisterGlobalShortcut,
} from '@/lib/tauri'
import { getSettingsTabFromUrl, setSettingsTabInUrl } from '@/lib/url-state'
import { cn } from '@/lib/utils'
import { AgentAccessSettingsTab } from './AgentAccessSettingsTab'
import { BugReportDialog } from './BugReportDialog'
import { DeadlineWarningSection } from './DeadlineWarningSection'
import { DeviceManagement } from './DeviceManagement'
import { GoogleCalendarSettingsTab } from './GoogleCalendarSettingsTab'
import { KeyboardSettingsTab } from './KeyboardSettingsTab'
import { LoadingSkeleton } from './LoadingSkeleton'
import { PropertyDefinitionsList } from './PropertyDefinitionsList'

// DataSettingsTab drags in `jszip` (~135 kB) for "Export as ZIP". The tab
// is rarely opened, so defer the import until the user clicks it (PERF-24).
const DataSettingsTab = lazy(() =>
  import('./DataSettingsTab').then((m) => ({ default: m.DataSettingsTab })),
)

/**
 * Theme select uses 'system' as the user-facing alias for the internal 'auto'
 * preference. All other values map 1:1 to ThemePreference.
 */
type ThemeSelectValue =
  | 'light'
  | 'dark'
  | 'system'
  | 'solarized-light'
  | 'solarized-dark'
  | 'dracula'
  | 'one-dark-pro'

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

const FONT_SIZE_KEY = 'agaric-font-size'
type FontSize = 'small' | 'medium' | 'large'

const FONT_SIZE_CSS: Record<FontSize, string> = {
  small: '14px',
  medium: '16px',
  large: '18px',
}

function readFontSize(): FontSize {
  try {
    const stored = localStorage.getItem(FONT_SIZE_KEY)
    if (stored === 'small' || stored === 'medium' || stored === 'large') return stored
  } catch {
    // localStorage unavailable
  }
  return 'medium'
}

function applyFontSize(size: FontSize) {
  document.documentElement.style.setProperty('--agaric-font-size', FONT_SIZE_CSS[size])
}

/** Map the existing useTheme preference names to user-facing select values. */
function themeToSelect(theme: ThemePreference): ThemeSelectValue {
  if (theme === 'auto') return 'system'
  return theme
}

function selectToTheme(value: string): ThemePreference {
  if (value === 'system') return 'auto'
  return value as ThemePreference
}

/**
 * FEAT-13 — "Launch on login" row inside the General tab.
 *
 * Three-state: `null` (loading or unavailable → row hidden), `true`
 * (toggle on), `false` (toggle off).  The unavailable case folds into
 * `null` because the only signal we have for "plugin not available"
 * is the rejection of `isAutostartEnabled()` (mobile build, browser
 * dev fallback, IPC denied).  Hiding the row in those cases matches
 * the spec — Android / iOS handle start-at-boot via the OS task
 * model, not this toggle.
 *
 * Toggle handler is optimistic-update + revert-on-failure, with a
 * single `toast.error(t('settings.autostart.toggleFailed'))` as the
 * user-visible failure surface.  `logger.error` carries the cause
 * chain for the daily-rolling backend log.
 */
function AutostartRow(): React.ReactElement | null {
  const { t } = useTranslation()
  // `null` = either still resolving the initial state, or the plugin
  // is unavailable on this platform (mobile / browser-dev). Either
  // way the row is hidden — the user can't toggle something we can't
  // talk to.
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)

  // Resolve the initial state on mount. Any rejection (mobile, IPC
  // denied, plugin missing) collapses into the "unavailable" branch
  // so the row stays hidden.
  useEffect(() => {
    let cancelled = false
    isAutostartEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value)
      })
      .catch((err) => {
        if (cancelled) return
        // Not an error from the user's perspective — this is the
        // mobile / browser-dev path where the plugin is unregistered
        // and `isEnabled()` rejects. Log at warn level (with cause)
        // so a real desktop IPC failure still lands in the daily log,
        // and hide the row either way.
        logger.warn(
          'SettingsView',
          'autostart plugin unavailable; hiding launch-on-login row',
          undefined,
          err,
        )
        setEnabled(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggle = useCallback(
    async (next: boolean) => {
      // Optimistic update — the Switch flips immediately. If the IPC
      // round-trip rejects we revert and toast the failure so the
      // visible state never lies about the underlying setting.
      const previous = enabled
      setEnabled(next)
      setPending(true)
      try {
        if (next) {
          await enableAutostart()
        } else {
          await disableAutostart()
        }
      } catch (err) {
        logger.error('SettingsView', 'failed to update autostart setting', { requested: next }, err)
        setEnabled(previous)
        toast.error(t('settings.autostart.toggleFailed'))
      } finally {
        setPending(false)
      }
    },
    [enabled, t],
  )

  // Hide entirely on mobile / browser-dev where the plugin is
  // unavailable — matches the FEAT-13 "Desktop only" requirement
  // without needing a separate platform-detection helper.
  if (enabled === null) return null

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 space-y-1">
        <Label htmlFor="autostart-toggle" muted={false}>
          {t('settings.autostart.label')}
        </Label>
        <p className="text-xs text-muted-foreground">{t('settings.autostart.description')}</p>
      </div>
      <Switch
        id="autostart-toggle"
        checked={enabled}
        onCheckedChange={handleToggle}
        disabled={pending}
        aria-label={t('settings.autostart.label')}
      />
    </div>
  )
}

/**
 * FEAT-12 — "Quick capture shortcut" row inside the General tab.
 *
 * Surfaces the user-configured global hotkey and an "Edit" button.
 * Clicking edit opens an inline editor (Input + Save / Cancel) where
 * the user types the new chord. Save flow:
 *
 *   1. `unregisterGlobalShortcut(previous)` — release the OS binding
 *      so it doesn't double-fire while the new chord installs.
 *   2. `registerGlobalShortcut(next, …)` — try the new chord; if the
 *      OS rejects (chord conflict / IPC failure), revert to `previous`
 *      and surface `toast.error(t('settings.quickCapture.saveFailed'))`.
 *   3. On success: persist via `saveQuickCaptureShortcut` so subsequent
 *      App.tsx mounts re-bind the chosen chord.
 *
 * The handler is a no-op stub — the dialog is opened by App.tsx's own
 * registration; this row only owns the editing surface so the binding
 * lives in one place. We still re-register here so a save attempt
 * actually surfaces "this chord conflicts" feedback in real time.
 *
 * Hidden entirely on mobile (`useIsMobile`) — matches FEAT-12's
 * desktop-only requirement without depending on `tauri-apps/plugin-os`
 * or another IPC round-trip.
 */
function QuickCaptureRow(): React.ReactElement | null {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [shortcut, setShortcut] = useState<string>(() => loadQuickCaptureShortcut())
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)

  const handleEdit = useCallback(() => {
    setDraft(shortcut)
    setEditing(true)
  }, [shortcut])

  const handleCancel = useCallback(() => {
    setDraft('')
    setEditing(false)
  }, [])

  const handleSave = useCallback(async () => {
    const next = draft.trim()
    if (next.length === 0 || next === shortcut) {
      setEditing(false)
      return
    }
    setPending(true)
    const previous = shortcut
    try {
      // Probe the new chord with a temporary register/unregister pair
      // so the user gets immediate failure feedback if the chord is
      // already claimed by another app. The live binding is owned by
      // App.tsx and re-applied via the `storage` event below; the
      // probe must NOT leak across the boundary, so we always
      // unregister it before saving.
      await registerGlobalShortcut(next, () => {})
      await unregisterGlobalShortcut(next).catch((err: unknown) => {
        logger.warn('SettingsView', 'failed to release probe quick-capture shortcut', { next }, err)
      })
      saveQuickCaptureShortcut(next)
      // Synthesize a `storage` event so App.tsx's chord-state listener
      // re-reads localStorage and the registration effect re-runs with
      // the live `setQuickCaptureOpen` handler. The spec only fires
      // storage events to *other* tabs, so we synthesize for ourselves.
      try {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: QUICK_CAPTURE_SHORTCUT_STORAGE_KEY,
            oldValue: previous,
            newValue: next,
            storageArea: window.localStorage,
          }),
        )
      } catch {
        // StorageEvent constructor support is universal in modern
        // browsers; the swallow is for ancient JSDOM only.
      }
      setShortcut(next)
      setEditing(false)
    } catch (err) {
      logger.error(
        'SettingsView',
        'failed to register new quick-capture shortcut',
        { previous, next },
        err,
      )
      toast.error(t('settings.quickCapture.saveFailed'))
      // No restore needed — the previous chord stays bound by App.tsx
      // because we never touched its registration; we only probed
      // `next` (which we've already unregistered above on failure
      // paths via the catch unwinding).
    } finally {
      setPending(false)
    }
  }, [draft, shortcut, t])

  if (isMobile) return null

  return (
    <div
      className="flex items-start justify-between gap-4"
      data-testid="quick-capture-settings-row"
    >
      <div className="flex-1 space-y-1">
        <Label htmlFor="quick-capture-shortcut" muted={false}>
          {t('settings.quickCapture.label')}
        </Label>
        <p className="text-xs text-muted-foreground">{t('settings.quickCapture.description')}</p>
        {editing ? (
          <div className="flex items-center gap-2 pt-2">
            <input
              id="quick-capture-shortcut"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={defaultQuickCaptureShortcut()}
              aria-label={t('settings.quickCapture.label')}
              disabled={pending}
              className="flex-1 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden"
              data-testid="quick-capture-shortcut-input"
            />
            <Button
              size="sm"
              onClick={() => {
                void handleSave()
              }}
              disabled={pending}
              data-testid="quick-capture-shortcut-save"
            >
              {t('keyboard.settings.saveButton')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCancel}
              disabled={pending}
              data-testid="quick-capture-shortcut-cancel"
            >
              {t('keyboard.settings.cancelButton')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3 pt-1">
            <code
              className="rounded-md border border-border bg-muted/30 px-2 py-0.5 font-mono text-xs"
              data-testid="quick-capture-shortcut-binding"
            >
              {shortcut}
            </code>
          </div>
        )}
      </div>
      {!editing && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleEdit}
          aria-label={t('settings.quickCapture.editButton')}
          data-testid="quick-capture-shortcut-edit"
        >
          {t('settings.quickCapture.editButton')}
        </Button>
      )}
    </div>
  )
}

export function SettingsView(): React.ReactElement {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<SettingsTab>(readActiveTab)
  const { theme, setTheme } = useTheme()
  const [fontSize, setFontSize] = useState<FontSize>(readFontSize)
  const [bugReportOpen, setBugReportOpen] = useState<boolean>(false)

  // Apply font size on mount and changes
  useEffect(() => {
    applyFontSize(fontSize)
  }, [fontSize])

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

  const handleThemeChange = useCallback(
    (value: string) => {
      setTheme(selectToTheme(value))
    },
    [setTheme],
  )

  const handleFontSizeChange = useCallback((value: string) => {
    const size = value as FontSize
    setFontSize(size)
    try {
      localStorage.setItem(FONT_SIZE_KEY, size)
    } catch {
      // localStorage unavailable
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
        {activeTab === 'general' && (
          <div className="space-y-6">
            <DeadlineWarningSection />
            <AutostartRow />
            <QuickCaptureRow />
          </div>
        )}

        {activeTab === 'properties' && <PropertyDefinitionsList />}

        {activeTab === 'appearance' && (
          <div className="space-y-6 max-w-md">
            {/* Theme selector */}
            <div className="space-y-2">
              <label htmlFor="theme-select" className="text-sm font-medium">
                {t('settings.themeLabel')}
              </label>
              <Select value={themeToSelect(theme)} onValueChange={handleThemeChange}>
                <SelectTrigger id="theme-select" aria-label={t('settings.themeLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">{t('settings.themeLight')}</SelectItem>
                  <SelectItem value="dark">{t('settings.themeDark')}</SelectItem>
                  <SelectItem value="system">{t('settings.themeSystem')}</SelectItem>
                  <SelectItem value="solarized-light">
                    {t('settings.themeSolarizedLight')}
                  </SelectItem>
                  <SelectItem value="solarized-dark">{t('settings.themeSolarizedDark')}</SelectItem>
                  <SelectItem value="dracula">{t('settings.themeDracula')}</SelectItem>
                  <SelectItem value="one-dark-pro">{t('settings.themeOneDarkPro')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Font size selector */}
            <div className="space-y-2">
              <label htmlFor="font-size-select" className="text-sm font-medium">
                {t('settings.fontSizeLabel')}
              </label>
              <Select value={fontSize} onValueChange={handleFontSizeChange}>
                <SelectTrigger id="font-size-select" aria-label={t('settings.fontSizeLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="small">{t('settings.fontSizeSmall')}</SelectItem>
                  <SelectItem value="medium">{t('settings.fontSizeMedium')}</SelectItem>
                  <SelectItem value="large">{t('settings.fontSizeLarge')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {activeTab === 'keyboard' && <KeyboardSettingsTab />}

        {activeTab === 'data' && (
          <Suspense fallback={<LoadingSkeleton count={4} height="h-6" />}>
            <DataSettingsTab />
          </Suspense>
        )}

        {activeTab === 'sync' && <DeviceManagement />}

        {activeTab === 'agent' && <AgentAccessSettingsTab />}

        {activeTab === 'google-calendar' && <GoogleCalendarSettingsTab />}

        {activeTab === 'help' && (
          <div className="space-y-4 max-w-xl">
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{t('help.reportBugTitle')}</h3>
              <p className="text-sm text-muted-foreground">{t('help.reportBugDescription')}</p>
              <Button
                variant="outline"
                onClick={() => setBugReportOpen(true)}
                aria-label={t('help.reportBugButton')}
              >
                {t('help.reportBugButton')}
              </Button>
            </div>
          </div>
        )}
      </div>

      <BugReportDialog open={bugReportOpen} onOpenChange={setBugReportOpen} />
    </div>
  )
}
