/**
 * useFilterSyntaxIntroToast — show the one-time "filter syntax is live"
 * intro toast on first mount of the search panel.
 *
 * PEND-58f FE-9 — extracted from the SearchPanel god-component.
 *
 * PEND-73 Phase 3.U10 — guard against re-firing in browsers where
 * localStorage is unavailable (private mode, embedded webviews with
 * storage disabled). The in-memory session sentinel is checked first;
 * the localStorage write is best-effort and only matters for
 * cross-session persistence.
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { notify } from '@/lib/notify'

const FILTER_SYNTAX_INTRO_TOAST_FLAG = 'agaric:searchFilterSyntaxToast:v1'
let filterSyntaxToastShownThisSession = false

export function useFilterSyntaxIntroToast(): void {
  const { t } = useTranslation()
  useEffect(() => {
    if (filterSyntaxToastShownThisSession) return
    filterSyntaxToastShownThisSession = true
    try {
      if (localStorage.getItem(FILTER_SYNTAX_INTRO_TOAST_FLAG)) return
      notify(t('search.filterSyntaxIntro'))
      localStorage.setItem(FILTER_SYNTAX_INTRO_TOAST_FLAG, '1')
    } catch {
      // localStorage unavailable; the session-scoped flag above is what
      // actually gates re-fires within this session, and the toast was
      // shown once on the first mount where this branch ran — that's the
      // best we can do without storage.
      notify(t('search.filterSyntaxIntro'))
    }
  }, [t])
}
