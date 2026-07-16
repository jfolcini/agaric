/**
 * useJournalDateFormat — localStorage-backed preference for the *display*
 * format of journal page titles (#1448).
 *
 * DISPLAY-ONLY. The canonical stored journal page content stays ISO
 * `yyyy-MM-dd` (it is the journal page's structural identity: exact-match
 * lookup, lexical range/sort, the partial index `____-__-__`, `validate_date_format`,
 * the TS ISO parsers, and "today" detection all operate on that key and are
 * NOT affected by this preference). This hook only governs how the title is
 * rendered to the user; switching it never rewrites storage, so it can never
 * orphan a journal.
 *
 * Backed by the preferences registry (`PREFERENCES.journalDateFormat`,
 * key 'journal-date-format'); the allowlist and default live there. The
 * shared `usePreference` primitive provides the cross-instance /
 * cross-window sync (#2666) — this hook previously hand-rolled the same
 * synthetic-StorageEvent broadcast (mirroring `useWeekStart`). A non-hook
 * getter (`getJournalDateFormat`) remains for pure functions like
 * `formatJournalTitle` in `date-utils.ts`.
 */

import { useCallback } from 'react'

import {
  type JournalDateFormat,
  PREFERENCES,
  readPreference,
  usePreference,
} from '@/lib/preferences'

export {
  DEFAULT_JOURNAL_DATE_FORMAT,
  JOURNAL_DATE_FORMATS,
  type JournalDateFormat,
} from '@/lib/preferences'

export function useJournalDateFormat(): {
  journalDateFormat: JournalDateFormat
  setJournalDateFormat: (fmt: JournalDateFormat) => void
} {
  const [journalDateFormat, setValue] = usePreference(PREFERENCES.journalDateFormat)

  const setJournalDateFormat = useCallback((fmt: JournalDateFormat) => setValue(fmt), [setValue])

  return { journalDateFormat, setJournalDateFormat }
}

/**
 * Non-hook getter for use in pure functions (date-utils.ts
 * `formatJournalTitle`). Runs during title render, so it must never throw —
 * `readPreference` degrades to the localized default on any storage failure.
 */
export function getJournalDateFormat(): JournalDateFormat {
  return readPreference(PREFERENCES.journalDateFormat)
}
