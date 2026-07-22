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
 * `SpaceSwitcher`'s fire-and-forget mount refresh, `SpaceManageDialog`'s
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

import { formatErrorForDisplay } from '@/lib/error-display'
import { i18n } from '@/lib/i18n'
import { useSpaceStore } from '@/stores/space'

type BootState = 'booting' | 'ready' | 'error'

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
