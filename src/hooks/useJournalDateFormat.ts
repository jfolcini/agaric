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
 * Mirrors `useWeekStart` (UX-9): a `useSyncExternalStore` snapshot over a
 * single localStorage key plus a non-hook getter (`getJournalDateFormat`) for
 * pure functions like `formatJournalTitle` in `date-utils.ts`.
 */

import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'journal-date-format'

/**
 * Allowed display formats.
 *
 * - `'locale'` is a sentinel for the app's pre-existing localized rendering
 *   (`formatDateDisplay`, e.g. "Mon, Jun 17 2026"). It is the DEFAULT, so the
 *   journal title looks exactly as it did before this feature — nothing changes
 *   for existing users.
 * - The remaining entries are date-fns format token strings (the same dialect
 *   already used across `date-utils.ts`). `'yyyy-MM-dd'` reproduces the canonical
 *   stored ISO shape, so formatting under it is an identity transform.
 */
export const JOURNAL_DATE_FORMATS = [
  'locale',
  'yyyy-MM-dd',
  'MMMM d, yyyy',
  'dd/MM/yyyy',
  'EEE, MMM d',
] as const

export type JournalDateFormat = (typeof JOURNAL_DATE_FORMATS)[number]

/** Default: the existing localized rendering, so nothing changes for existing users. */
export const DEFAULT_JOURNAL_DATE_FORMAT: JournalDateFormat = 'locale'

function isJournalDateFormat(v: string | null): v is JournalDateFormat {
  return v !== null && (JOURNAL_DATE_FORMATS as readonly string[]).includes(v)
}

function getSnapshot(): JournalDateFormat {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isJournalDateFormat(stored)) return stored
  } catch {
    // Storage unavailable (private mode / locked-down webview). This backs
    // getJournalDateFormat() during title render, so a throw here must not
    // break the view — fall through to the ISO default.
  }
  return DEFAULT_JOURNAL_DATE_FORMAT
}

function getServerSnapshot(): JournalDateFormat {
  return DEFAULT_JOURNAL_DATE_FORMAT
}

function subscribe(callback: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback()
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

export function useJournalDateFormat(): {
  journalDateFormat: JournalDateFormat
  setJournalDateFormat: (fmt: JournalDateFormat) => void
} {
  const journalDateFormat = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const setJournalDateFormat = useCallback((fmt: JournalDateFormat) => {
    let oldValue: string | null = null
    try {
      oldValue = localStorage.getItem(STORAGE_KEY)
      localStorage.setItem(STORAGE_KEY, fmt)
    } catch {
      // Storage unavailable — degrade to no-persist and skip the sync event.
      return
    }
    // Dispatch storage event for same-tab listeners (other windows get the
    // native event; same-window listeners need this synthetic one).
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: STORAGE_KEY,
        oldValue,
        newValue: fmt,
        url: window.location.href,
        storageArea: window.localStorage,
      }),
    )
  }, [])

  return { journalDateFormat, setJournalDateFormat }
}

/** Non-hook getter for use in pure functions (date-utils.ts `formatJournalTitle`). */
export function getJournalDateFormat(): JournalDateFormat {
  return getSnapshot()
}
