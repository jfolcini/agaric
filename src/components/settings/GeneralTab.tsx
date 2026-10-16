/**
 * GeneralTab — language, week start, journal date format, and the
 * desktop-only launch-on-login row.
 *
 * Each preference goes through its shared localStorage-backed hook; the
 * AutostartRow owns its own state + IPC.
 */

import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { AutostartRow } from '@/components/settings/AutostartRow'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow, settingDescriptionId } from '@/components/ui/setting-row'
import {
  JOURNAL_DATE_FORMATS,
  type JournalDateFormat,
  useJournalDateFormat,
} from '@/hooks/useJournalDateFormat'
import { useLanguage } from '@/hooks/useLanguage'
import { useWeekStart } from '@/hooks/useWeekStart'
import { formatJournalTitle } from '@/lib/date-utils'
import { type LanguagePreference } from '@/lib/i18n/locales'
import { notify } from '@/lib/notify'

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

export function GeneralTab(): React.ReactElement {
  const { t } = useTranslation()
  // #4555 — the UI language. `system` follows the device; the other values
  // pin a locale. Anything not yet translated falls back to English.
  const { language, setLanguage } = useLanguage()
  // The hook returns `0 | 1` (Sunday | Monday); the Select primitive only
  // deals in strings so we coerce on read/write.
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

  // The toast names the new day because the only other cue is calendar grids
  // silently re-laying out.
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

  return (
    <Card>
      <CardContent className="space-y-6">
        {/* Language (#4555) comes first because it changes every other label. */}
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

        <AutostartRow />
      </CardContent>
    </Card>
  )
}
