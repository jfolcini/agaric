/**
 * Boot state machine: `booting → ready | error`. `boot()` awaits the space
 * store's first `refreshAvailableSpaces()`, so space-scoped views see a
 * non-null `currentSpaceId` on first mount instead of fetching empty and
 * refetching. That refresh never rejects; a hard failure (no snapshot to keep
 * using) is read from `lastRefreshOutcome` and shows BootGate's retry screen
 * instead of an app whose every page load no-ops (#2921).
 */

import { create } from 'zustand'

import { fetchPageMap } from '@/lib/calendar-page-dates-cache'
import { formatDate, getCalendarMonthRange } from '@/lib/date-utils'
import { formatErrorForDisplay } from '@/lib/error-display'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { getLogBackendSink } from '@/lib/logger-transport'
import { prefetchPageSubtree } from '@/lib/prefetch-page-subtree'
import { useJournalStore } from '@/stores/journal'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'

type BootState = 'booting' | 'ready' | 'error'

/**
 * Start the first journal view's fetches alongside `list_spaces` instead of a
 * render later (#5438): the month's page map, then today's subtree. The
 * persisted space id is only a hint; if the app lands elsewhere the prefetch
 * goes unread. `useCalendarPageDates` and `load()` consume it.
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

/**
 * The boot milestone `scripts/measure-boot.mjs` reads from the Rust log
 * (#5419). Production drops `logger.info`, so it goes to the backend sink.
 */
function logBootResolved(outcome: 'ready' | 'error'): void {
  const sink = getLogBackendSink()
  if (!sink) return
  sink('info', 'stores/boot', 'boot resolved', null, null, JSON.stringify({ outcome })).catch(
    (err: unknown) => {
      logger.warn('stores/boot', 'boot resolved milestone did not reach the log', undefined, err)
    },
  )
}

/**
 * On Android the web view runs while the backend's setup is still registering
 * its state, so on a slow start (a fresh install running every migration) the
 * first command is refused with this message. Setup finishes on its own.
 */
const BACKEND_STARTING = /state not managed/
const BACKEND_START_RETRIES = 50
const BACKEND_START_RETRY_MS = 100

interface BootStore {
  state: BootState
  error: string | null
  /**
   * Hydrate the space store and move to `ready`, or to `error` with a
   * display-ready message on a hard failure. Awaitable, so BootGate's retry
   * can disable itself meanwhile; a retry that succeeds clears `error`.
   */
  boot: () => Promise<void>
}

export const useBootStore = create<BootStore>((set) => ({
  state: 'booting',
  error: null,
  boot: async () => {
    // `refreshAvailableSpaces` never rejects; it records a hard failure instead.
    prefetchBootJournal()
    await useSpaceStore.getState().refreshAvailableSpaces()
    let outcome = useSpaceStore.getState().lastRefreshOutcome
    for (
      let retry = 0;
      retry < BACKEND_START_RETRIES &&
      outcome.kind === 'hard-error' &&
      BACKEND_STARTING.test(String(outcome.error));
      retry++
    ) {
      await new Promise((resolve) => setTimeout(resolve, BACKEND_START_RETRY_MS))
      await useSpaceStore.getState().refreshAvailableSpaces()
      outcome = useSpaceStore.getState().lastRefreshOutcome
    }
    if (outcome.kind === 'hard-error') {
      set({
        state: 'error',
        error: formatErrorForDisplay(outcome.error, { fallback: i18n.t('boot.spacesLoadFailed') }),
      })
      logBootResolved('error')
      return
    }
    set({ state: 'ready', error: null })
    logBootResolved('ready')
  },
}))
