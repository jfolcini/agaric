/**
 * GeneralTab — language, week start, journal date format, the space's
 * journal template, the way into the Templates view, and the desktop-only
 * launch-on-login row.
 *
 * Each preference goes through its shared localStorage-backed hook; the
 * AutostartRow owns its own state + IPC.
 */

import { LayoutTemplate } from 'lucide-react'
import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { AutostartRow } from '@/components/settings/AutostartRow'
import { JournalTemplateRow } from '@/components/settings/JournalTemplateRow'
import { Button } from '@/components/ui/button'
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
import {
  type LanguagePreference,
  LOCALES,
  PSEUDO_LOCALE,
  SUPPORTED_LOCALES,
} from '@/lib/i18n/locales'
import { PREFERENCES, usePreference } from '@/lib/preferences'
import { useNavigationStore } from '@/stores/navigation'

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
  const setView = useNavigationStore((s) => s.setView)
  // #4555 — the UI language. `system` follows the device; the other values
  // pin a locale.
  const { language, setLanguage } = useLanguage()
  // The stored pseudo-locale stays listed, so the select still shows it once
  // debug mode is off.
  const [debugMode] = usePreference(PREFERENCES.debugMode)
  const locales = SUPPORTED_LOCALES.filter(
    (tag) => tag !== PSEUDO_LOCALE || debugMode || language === PSEUDO_LOCALE,
  )
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

  const handleWeekStartChange = useCallback(
    (value: string) => {
      if (value === '0') setWeekStart(0)
      else if (value === '1') setWeekStart(1)
    },
    [setWeekStart],
  )

  const handleJournalDateFormatChange = useCallback(
    (value: string) => {
      setJournalDateFormat(value as JournalDateFormat)
    },
    [setJournalDateFormat],
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
              {locales.map((tag) => (
                // `lang` so a screen reader voices "Español" as Spanish.
                <SelectItem key={tag} value={tag} lang={tag}>
                  {LOCALES[tag].nativeName}
                </SelectItem>
              ))}
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

        <JournalTemplateRow />

        {/* #7155 R21 — the Templates view left the sidebar; this row is its way in. */}
        <SettingRow label={t('settings.templatesLabel')}>
          <Button variant="outline" onClick={() => setView('templates')}>
            <LayoutTemplate />
            {t('settings.templatesOpen')}
          </Button>
        </SettingRow>

        <AutostartRow />
      </CardContent>
    </Card>
  )
}
