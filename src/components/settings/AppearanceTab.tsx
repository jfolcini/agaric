/**
 * AppearanceTab — language + theme + font size + week-start preference selectors.
 *
 * Delegates each preference to its shared hook. The hooks are
 * localStorage-backed and re-read across windows via synthetic `storage`
 * events; App also mounts the hooks that apply app-wide DOM state at boot.
 */

import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow, settingDescriptionId } from '@/components/ui/setting-row'
import { type FontSize, useFontSize } from '@/hooks/useFontSize'
import {
  JOURNAL_DATE_FORMATS,
  type JournalDateFormat,
  useJournalDateFormat,
} from '@/hooks/useJournalDateFormat'
import { useLanguage } from '@/hooks/useLanguage'
import { type MotionPreference, useMotionPreference } from '@/hooks/useMotionPreference'
import { type ThemePreference, useTheme } from '@/hooks/useTheme'
import { type TooltipDelay, useTooltipDelay } from '@/hooks/useTooltipDelay'
import { useWeekStart } from '@/hooks/useWeekStart'
import { formatJournalTitle } from '@/lib/date-utils'
import { type LanguagePreference } from '@/lib/i18n/locales'
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

// The trigger fills a phone row; from `sm` up it sits beside the label at a
// fixed width instead of stretching across the panel. The journal date format
// is wider because its option labels carry a worked example.
const SELECT_TRIGGER_WIDTH = 'sm:w-48'

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
  // #4555 — the UI language. `system` follows the device; the other values
  // pin a locale. Anything not yet translated falls back to English.
  const { language, setLanguage } = useLanguage()
  const { theme, setTheme } = useTheme()
  const { motion, setMotion } = useMotionPreference()
  const { tooltipDelay, setTooltipDelay } = useTooltipDelay()
  const { fontSize, setFontSize } = useFontSize()
  // Surface the previously hidden week-start preference. The hook
  // returns `0 | 1` (Sunday | Monday); the Select primitive only deals
  // in strings so we coerce on read/write.
  const { weekStartsOn, setWeekStart } = useWeekStart()
  // #1448 — DISPLAY-ONLY journal date format. The stored journal page content
  // stays ISO `yyyy-MM-dd`; this only changes how titles are rendered.
  const { journalDateFormat, setJournalDateFormat } = useJournalDateFormat()

  const handleLanguageChange = useCallback(
    (value: string) => {
      setLanguage(value as LanguagePreference)
    },
    [setLanguage],
  )

  const handleThemeChange = useCallback(
    (value: string) => {
      setTheme(selectToTheme(value))
    },
    [setTheme],
  )

  const handleFontSizeChange = useCallback(
    (value: string) => {
      setFontSize(value as FontSize)
    },
    [setFontSize],
  )

  const handleMotionChange = useCallback(
    (value: string) => {
      setMotion(value as MotionPreference)
    },
    [setMotion],
  )

  const handleTooltipDelayChange = useCallback(
    (value: string) => {
      setTooltipDelay(value as TooltipDelay)
    },
    [setTooltipDelay],
  )

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
    <Card>
      <CardContent className="space-y-6">
        {/* Language (#4555). Above Theme because it changes every other label
            on this screen. */}
        <SettingRow
          label={t('settings.languageLabel')}
          controlId="language-select"
          description={t('settings.languageHelp')}
        >
          <Select value={language} onValueChange={handleLanguageChange}>
            <SelectTrigger
              id="language-select"
              className={SELECT_TRIGGER_WIDTH}
              aria-describedby={settingDescriptionId('language-select')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('settings.languageSystem')}</SelectItem>
              <SelectItem value="en">{t('settings.languageEnglish')}</SelectItem>
              <SelectItem value="es">{t('settings.languageSpanish')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {/* Theme selector */}
        <SettingRow label={t('settings.themeLabel')} controlId="theme-select">
          <Select value={themeToSelect(theme)} onValueChange={handleThemeChange}>
            <SelectTrigger id="theme-select" className={SELECT_TRIGGER_WIDTH}>
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
        </SettingRow>

        {/* Font size selector */}
        <SettingRow label={t('settings.fontSizeLabel')} controlId="font-size-select">
          <Select value={fontSize} onValueChange={handleFontSizeChange}>
            <SelectTrigger id="font-size-select" className={SELECT_TRIGGER_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">{t('settings.fontSizeSmall')}</SelectItem>
              <SelectItem value="medium">{t('settings.fontSizeMedium')}</SelectItem>
              <SelectItem value="large">{t('settings.fontSizeLarge')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {/* Animation speed. A single knob over the design-system `--motion-scale`
            token (see `useMotionPreference`): System follows the OS reduced-motion
            setting, Fast halves every duration, Off disables animations. */}
        <SettingRow
          label={t('settings.motionLabel')}
          controlId="motion-select"
          description={t('settings.motionHelp')}
        >
          <Select value={motion} onValueChange={handleMotionChange}>
            <SelectTrigger
              id="motion-select"
              className={SELECT_TRIGGER_WIDTH}
              aria-describedby={settingDescriptionId('motion-select')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('settings.motionSystem')}</SelectItem>
              <SelectItem value="full">{t('settings.motionFull')}</SelectItem>
              <SelectItem value="fast">{t('settings.motionFast')}</SelectItem>
              <SelectItem value="off">{t('settings.motionOff')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {/* Tooltip delay (#2851). A separate axis from animation speed: how
            long to hover before a tooltip opens. Only affects the app-level
            baseline that most tooltips inherit — the deliberate per-surface
            deviations (sidebar, toolbars, gutter) are unaffected. */}
        <SettingRow
          label={t('settings.tooltipDelayLabel')}
          controlId="tooltip-delay-select"
          description={t('settings.tooltipDelayHelp')}
        >
          <Select value={tooltipDelay} onValueChange={handleTooltipDelayChange}>
            <SelectTrigger
              id="tooltip-delay-select"
              className={SELECT_TRIGGER_WIDTH}
              aria-describedby={settingDescriptionId('tooltip-delay-select')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="instant">{t('settings.tooltipDelayInstant')}</SelectItem>
              <SelectItem value="fast">{t('settings.tooltipDelayFast')}</SelectItem>
              <SelectItem value="default">{t('settings.tooltipDelayDefault')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {/* Week-start preference. Previously a half-shipped feature
            exposed only via the `week-start-preference` localStorage key.
            Surfacing it in Appearance lets users pick Monday / Sunday-
            first weeks without devtools. */}
        <SettingRow label={t('settings.weekStartLabel')} controlId="week-start-select">
          <Select value={String(weekStartsOn)} onValueChange={handleWeekStartChange}>
            <SelectTrigger id="week-start-select" className={SELECT_TRIGGER_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">{t('settings.weekStartMonday')}</SelectItem>
              <SelectItem value="0">{t('settings.weekStartSunday')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {/* Journal date format (#1448). DISPLAY-ONLY: the stored journal page
            content stays ISO `yyyy-MM-dd`; this only governs how titles render,
            so switching it can never orphan an existing journal. */}
        <SettingRow
          label={t('settings.journalDateFormatLabel')}
          controlId="journal-date-format-select"
          description={t('settings.journalDateFormatHelp')}
        >
          <Select value={journalDateFormat} onValueChange={handleJournalDateFormatChange}>
            <SelectTrigger
              id="journal-date-format-select"
              className="sm:w-72"
              aria-describedby={settingDescriptionId('journal-date-format-select')}
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
        </SettingRow>
      </CardContent>
    </Card>
  )
}
