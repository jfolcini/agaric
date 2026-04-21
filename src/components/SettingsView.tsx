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
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { type ThemePreference, useTheme } from '@/hooks/useTheme'
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

export function SettingsView(): React.ReactElement {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const { theme, setTheme } = useTheme()
  const [fontSize, setFontSize] = useState<FontSize>(readFontSize)
  const [bugReportOpen, setBugReportOpen] = useState<boolean>(false)

  // Apply font size on mount and changes
  useEffect(() => {
    applyFontSize(fontSize)
  }, [fontSize])

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
          <div className="space-y-4">
            <DeadlineWarningSection />
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
