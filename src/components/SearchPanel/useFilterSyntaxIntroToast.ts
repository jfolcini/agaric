/**
 * useFilterSyntaxIntroToast — show the one-time "filter syntax is live"
 * intro toast on first mount of the search panel.
 *
 * Extracted from the SearchPanel god-component.
 *
 * Phase 3.U10 — guard against re-firing in browsers where
 * localStorage is unavailable (private mode, embedded webviews with
 * storage disabled). The in-memory session sentinel is checked first;
 * the localStorage write is best-effort and only matters for
 * cross-session persistence.
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { notify } from '@/lib/notify'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'

let filterSyntaxToastShownThisSession = false

export function useFilterSyntaxIntroToast(): void {
  const { t } = useTranslation()
  useEffect(() => {
    if (filterSyntaxToastShownThisSession) return
    filterSyntaxToastShownThisSession = true
    // A read/write failure (localStorage unavailable) is logged and
    // swallowed by readPreference/writePreference; the session-scoped flag
    // above is what actually gates re-fires within this session either way,
    // so the toast still shows exactly once per session even without storage.
    if (readPreference(PREFERENCES.filterSyntaxIntroToastShown)) return
    notify(t('search.filterSyntaxIntro'))
    writePreference(PREFERENCES.filterSyntaxIntroToastShown, true)
  }, [t])
}
