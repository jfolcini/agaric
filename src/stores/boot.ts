/**
 * Boot store — manages application startup state machine.
 *
 * Transitions: `booting → ready | error`. After session 731's Phase 2
 * (the artificial `invoke('list_blocks')` handshake was dropped), the
 * BootGate transitions to `ready` as soon as the space store has
 * hydrated. The space store's `refreshAvailableSpaces()` call is the
 * single source of truth for "the app has enough state to render
 * space-scoped views without racing." Pulling that call into
 * `boot()` itself means downstream consumers (JournalPage,
 * useCalendarPageDates, useDuePanelData, …) see a non-null
 * `currentSpaceId` on their first mount, avoiding the empty-fetch /
 * hide-component / refetch flicker that the IPC handshake used to
 * mask incidentally.
 *
 * #2921 — the `error` state now has a real production driver. The space
 * store's `refreshAvailableSpaces()` never rejects (non-boot callers —
 * `SpaceSwitcher`'s fire-and-forget mount refresh, `SpacesTab`'s
 * awaited-but-uncaught refresh — rely on that contract) but records a
 * `lastRefreshOutcome` of `{ kind: 'hard-error', error }` when it hit a
 * HARD failure (`listSpaces()` rejected AND there is no usable prior
 * snapshot — no persisted `currentSpaceId`, no in-memory
 * `availableSpaces`). `boot()` reads that field right after its own
 * `await` returns and flips to `error` so BootGate's retry/diagnostics
 * screen renders instead of the app silently landing on `ready` with an
 * empty space list, where every page load no-ops and leaves the initial
 * `loading: true` skeleton spinning forever. A SOFT failure (a usable
 * snapshot exists) reports `{ kind: 'ok' }` — same as success — since the
 * space store already keeps the app usable on the prior snapshot in that
 * case (plus its own deduped toast).
 */

import { create } from 'zustand'

import { fetchPageMap } from '@/lib/calendar-page-dates-cache'
import { formatDate, getCalendarMonthRange } from '@/lib/date-utils'
import { formatErrorForDisplay } from '@/lib/error-display'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { prefetchPageSubtree } from '@/lib/prefetch-page-subtree'
import { useJournalStore } from '@/stores/journal'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'

type BootState = 'booting' | 'ready' | 'error'

/**
 * #5438 — start the first journal view's fetches alongside `list_spaces`
 * instead of one render after it: the month's page map, then today's
 * subtree. The persisted space id is only a hint; the space the app lands in
 * comes from `refreshAvailableSpaces`, and when the two differ the prefetch
 * is never read (one caught IPC). `useCalendarPageDates` seeds from the
 * settled page map; `page-blocks.ts` `load()` consumes the subtree once.
 */
function prefetchBootJournal(): void {
  const spaceId = useSpaceStore.getState().currentSpaceId
  if (spaceId == null) return
  if (useNavigationStore.getState().currentView !== 'journal') return
  const { mode, currentDate } = useJournalStore.getState()
  if (mode !== 'daily') return
  const { startDate, endDate } = getCalendarMonthRange(currentDate)
  fetchPageMap(spaceId, startDate, endDate)
    .then((map) => {
      const pageId = map.get(formatDate(currentDate))
      if (pageId) prefetchPageSubtree(spaceId, pageId)
    })
    .catch((err: unknown) => {
      logger.warn(
        'stores/boot',
        'journal prefetch failed; the view fetches fresh',
        { spaceId },
        err,
      )
    })
}

interface BootStore {
  state: BootState
  error: string | null
  /**
   * Kicks off space-store hydration and flips to `ready` on completion,
   * or to `error` (with a display-ready message) on a hard space-load
   * failure. Returns a Promise so the BootGate retry button can `await`
   * the transition and gate its disabled-during-refresh UI on it.
   * Re-invoking `boot()` (the retry path) simply re-runs the same
   * hydration — a subsequent success clears `error` and moves to
   * `ready`.
   */
  boot: () => Promise<void>
}

export const useBootStore = create<BootStore>((set) => ({
  state: 'booting',
  error: null,
  boot: async () => {
    // `refreshAvailableSpaces` never rejects (see module doc) — it
    // resolves for the happy path AND the soft-failure path, and records
    // its outcome for the hard-failure path instead of throwing. Read
    // that outcome after the await settles rather than try/catch.
    prefetchBootJournal()
    await useSpaceStore.getState().refreshAvailableSpaces()
    const outcome = useSpaceStore.getState().lastRefreshOutcome
    if (outcome.kind === 'hard-error') {
      set({
        state: 'error',
        error: formatErrorForDisplay(outcome.error, { fallback: i18n.t('boot.spacesLoadFailed') }),
      })
      return
    }
    set({ state: 'ready', error: null })
  },
}))
