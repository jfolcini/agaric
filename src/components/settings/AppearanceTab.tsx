/**
 * AppearanceTab — theme + font size + week-start preference selectors.
 *
 * Owns the local state for font size (UX-defined small/medium/large CSS
 * variable) and delegates theme + week-start persistence to the
 * `useTheme` (UX-203) and `useWeekStart` (UX-9) hooks. All three
 * preferences are localStorage-backed and re-read across windows via
 * synthetic `storage` events fired by the hooks.
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
import { type ThemePreference, useTheme } from '@/hooks/useTheme'
import { useWeekStart } from '@/hooks/useWeekStart'

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

export function AppearanceTab(): React.ReactElement {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const [fontSize, setFontSize] = useState<FontSize>(readFontSize)
  // UX-9 — surface the previously hidden week-start preference. The hook
  // returns `0 | 1` (Sunday | Monday); the Select primitive only deals
  // in strings so we coerce on read/write.
  const { weekStartsOn, setWeekStart } = useWeekStart()

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

  // UX-9 — week-start coercion. Select values are strings; the hook
  // and underlying localStorage key are typed `0 | 1`. We accept only
  // `'0'` and `'1'` and ignore anything else (defensive — the Select
  // can only emit values from the items we render).
  const handleWeekStartChange = useCallback(
    (value: string) => {
      if (value === '0') setWeekStart(0)
      else if (value === '1') setWeekStart(1)
    },
    [setWeekStart],
  )

  return (
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
            <SelectItem value="solarized-light">{t('settings.themeSolarizedLight')}</SelectItem>
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

      {/* Week-start preference (UX-9). Previously a half-shipped feature
          exposed only via the `week-start-preference` localStorage key.
          Surfacing it in Appearance lets users pick Monday / Sunday-
          first weeks without devtools. */}
      <div className="space-y-2">
        <label htmlFor="week-start-select" className="text-sm font-medium">
          {t('settings.weekStartLabel')}
        </label>
        <Select value={String(weekStartsOn)} onValueChange={handleWeekStartChange}>
          <SelectTrigger id="week-start-select" aria-label={t('settings.weekStartLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">{t('settings.weekStartMonday')}</SelectItem>
            <SelectItem value="0">{t('settings.weekStartSunday')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
