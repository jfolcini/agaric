/**
 * SettingsView -- tabbed settings panel (F-30).
 *
 * Tabs:
 *  - General   -- TaskStatesSection + DeadlineWarningSection
 *  - Properties -- PropertyDefinitionsList
 *  - Appearance -- theme toggle (light/dark/system) + font size selector
 *  - Sync & Devices -- DeviceManagement
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { type ThemePreference, useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import { DeadlineWarningSection } from './DeadlineWarningSection'
import { DeviceManagement } from './DeviceManagement'
import { KeyboardSettingsTab } from './KeyboardSettingsTab'
import { PropertyDefinitionsList } from './PropertyDefinitionsList'
import { TaskStatesSection } from './TaskStatesSection'

type SettingsTab = 'general' | 'properties' | 'appearance' | 'keyboard' | 'sync'

const TAB_IDS: SettingsTab[] = ['general', 'properties', 'appearance', 'keyboard', 'sync']

const TAB_LABEL_KEYS: Record<SettingsTab, string> = {
  general: 'settings.tabGeneral',
  properties: 'settings.tabProperties',
  appearance: 'settings.tabAppearance',
  keyboard: 'settings.tabKeyboard',
  sync: 'settings.tabSync',
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
function themeToSelect(theme: ThemePreference): string {
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
  const { theme, toggleTheme } = useTheme()
  const [fontSize, setFontSize] = useState<FontSize>(readFontSize)

  // Apply font size on mount and changes
  useEffect(() => {
    applyFontSize(fontSize)
  }, [fontSize])

  const handleThemeChange = useCallback(
    (value: string) => {
      const target = selectToTheme(value)
      // Cycle until we reach the target
      // The existing hook cycles: auto -> dark -> light -> auto
      // We need to set a specific value, so we'll use localStorage directly
      // and call toggleTheme the right number of times
      // Actually, let's just set localStorage and reload the preference
      // by cycling the toggle until the theme matches
      let current = theme
      const cycle: ThemePreference[] = ['auto', 'dark', 'light']
      let safety = 0
      while (current !== target && safety < 3) {
        toggleTheme()
        const idx = cycle.indexOf(current)
        current = cycle[(idx + 1) % cycle.length] as ThemePreference
        safety++
      }
    },
    [theme, toggleTheme],
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
            <TaskStatesSection />
            <Separator />
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

        {activeTab === 'sync' && <DeviceManagement />}
      </div>
    </div>
  )
}
