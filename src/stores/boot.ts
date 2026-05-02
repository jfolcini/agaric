/**
 * Boot store — manages application startup state machine.
 *
 * Transitions: booting → ready | error. The backend runs crash recovery
 * in setup(), so by the time `boot()` succeeds the app is fully initialized.
 */

import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'

type BootState = 'booting' | 'recovering' | 'ready' | 'error'

interface BootStore {
  state: BootState
  error: string | null
  boot: () => Promise<void>
}

export const useBootStore = create<BootStore>((set) => ({
  state: 'booting',
  error: null,
  boot: async () => {
    try {
      set({ state: 'recovering', error: null })
      // Call list_blocks to verify the backend is live and DB is ready.
      // The backend runs crash recovery in setup(), so by the time this
      // succeeds the app is fully initialized.
      // FEAT-3 Phase 4: `space_id` is required. Boot runs before
      // `useSpaceStore` is hydrated, so pass `''` per the pre-bootstrap
      // convention documented in `src/lib/tauri.ts::listBlocks` — the
      // backend treats it as a no-match (empty page) instead of crashing.
      await invoke('list_blocks', { spaceId: '' })
      set({ state: 'ready', error: null })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      set({ state: 'error', error: message })
    }
  },
}))
