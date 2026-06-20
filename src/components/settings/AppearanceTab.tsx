/**
 * AppearanceTab — theme + font size + week-start preference selectors.
 *
 * Owns the local state for font size (UX-defined small/medium/large CSS
 * variable) and delegates theme + week-start persistence to the
 * `useTheme` and `useWeekStart` hooks. All three
 * preferences are localStorage-backed and re-read across windows via
 * synthetic `storage` events fired by the hooks.
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FormField } from '@/components/ui/form-field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  JOURNAL_DATE_FORMATS,
  type JournalDateFormat,
  useJournalDateFormat,
} from '@/hooks/useJournalDateFormat'
import { type ThemePreference, useTheme } from '@/hooks/useTheme'
import { useWeekStart } from '@/hooks/useWeekStart'
import { formatJournalTitle } from '@/lib/date-utils'
import { notify } from '@/lib/notify'

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

// #1448 — each journal date-format preset maps to an i18n label key.
const JOURNAL_DATE_FORMAT_LABELS: Record<JournalDateFormat, string> = {
  locale: 'settings.journalDateFormatLocale',
  'yyyy-MM-dd': 'settings.journalDateFormatIso',
  'MMMM d, yyyy': 'settings.journalDateFormatLong',
  'dd/MM/yyyy': 'settings.journalDateFormatSlash',
  'EEE, MMM d': 'settings.journalDateFormatWeekday',
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

export function AppearanceTab(): React.ReactElement {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const [fontSize, setFontSize] = useState<FontSize>(readFontSize)
  // Surface the previously hidden week-start preference. The hook
  // returns `0 | 1` (Sunday | Monday); the Select primitive only deals
  // in strings so we coerce on read/write.
  const { weekStartsOn, setWeekStart } = useWeekStart()
  // #1448 — DISPLAY-ONLY journal date format. The stored journal page content
  // stays ISO `yyyy-MM-dd`; this only changes how titles are rendered.
  const { journalDateFormat, setJournalDateFormat } = useJournalDateFormat()

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

  // Week-start coercion. Select values are strings; the hook
  // and underlying localStorage key are typed `0 | 1`. We accept only
  // `'0'` and `'1'` and ignore anything else (defensive — the Select
  // can only emit values from the items we render).
  // Surface a toast so the change is not silent; the only
  // other visible cue today is calendar grids re-laying out.
  // #1448 — DISPLAY-ONLY journal date format picker. Persists the chosen
  // date-fns token string; the stored journal page content is never touched.
  const handleJournalDateFormatChange = useCallback(
    (value: string) => {
      const fmt = value as JournalDateFormat
      setJournalDateFormat(fmt)
      // Show a concrete worked example so the abstract token string is legible.
      notify.success(
        t('settings.journalDateFormatUpdated', {
          example: formatJournalTitle('2026-06-17', fmt),
        }),
      )
    },
    [setJournalDateFormat, t],
  )

  const handleWeekStartChange = useCallback(
    (value: string) => {
      if (value === '0') {
        setWeekStart(0)
        notify.success(t('settings.weekStartUpdated', { day: t('settings.weekStartSunday') }))
      } else if (value === '1') {
        setWeekStart(1)
        notify.success(t('settings.weekStartUpdated', { day: t('settings.weekStartMonday') }))
      }
    },
    [setWeekStart, t],
  )

  return (
    <div className="space-y-6">
      {/* Theme selector */}
      <FormField label={t('settings.themeLabel')} htmlFor="theme-select">
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
      </FormField>

      {/* Font size selector */}
      <FormField label={t('settings.fontSizeLabel')} htmlFor="font-size-select">
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
      </FormField>

      {/* Week-start preference. Previously a half-shipped feature
          exposed only via the `week-start-preference` localStorage key.
          Surfacing it in Appearance lets users pick Monday / Sunday-
          first weeks without devtools. */}
      <FormField label={t('settings.weekStartLabel')} htmlFor="week-start-select">
        <Select value={String(weekStartsOn)} onValueChange={handleWeekStartChange}>
          <SelectTrigger id="week-start-select" aria-label={t('settings.weekStartLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">{t('settings.weekStartMonday')}</SelectItem>
            <SelectItem value="0">{t('settings.weekStartSunday')}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      {/* Journal date format (#1448). DISPLAY-ONLY: the stored journal page
          content stays ISO `yyyy-MM-dd`; this only governs how titles render,
          so switching it can never orphan an existing journal. */}
      <FormField
        label={t('settings.journalDateFormatLabel')}
        htmlFor="journal-date-format-select"
        description={t('settings.journalDateFormatHelp')}
      >
        <Select value={journalDateFormat} onValueChange={handleJournalDateFormatChange}>
          <SelectTrigger
            id="journal-date-format-select"
            aria-label={t('settings.journalDateFormatLabel')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {JOURNAL_DATE_FORMATS.map((fmt) => (
              <SelectItem key={fmt} value={fmt}>
                {t(JOURNAL_DATE_FORMAT_LABELS[fmt])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    </div>
  )
}
