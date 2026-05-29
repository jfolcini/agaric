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
 * The `error` state is preserved as an externally-triggerable surface
 * for future fatal-IPC paths (no production driver today). If
 * `refreshAvailableSpaces()` fails internally, the space store still
 * flips `isReady=true` and logs via the shared logger — boot then
 * transitions to `ready` so the user can still reach Settings to fix
 * a broken state.
 */

import { create } from 'zustand'

import { useSpaceStore } from './space'

type BootState = 'booting' | 'ready' | 'error'

interface BootStore {
  state: BootState
  error: string | null
  /**
   * Kicks off space-store hydration and flips to `ready` on completion.
   * Returns a Promise so the BootGate retry button can `await` the
   * transition and gate its disabled-during-refresh UI on it.
   */
  boot: () => Promise<void>
}

export const useBootStore = create<BootStore>((set) => ({
  state: 'booting',
  error: null,
  boot: async () => {
    // `refreshAvailableSpaces` never rejects per its contract — it
    // logs internal errors and flips `isReady=true` so the UI does
    // not freeze. We still `await` it because we want the ready
    // transition to wait for `currentSpaceId` to be populated (or
    // confirmed null after a clean error), not race the network.
    await useSpaceStore.getState().refreshAvailableSpaces()
    set({ state: 'ready', error: null })
  },
}))
