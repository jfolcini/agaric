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
      await invoke('list_blocks', {})
      set({ state: 'ready', error: null })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      set({ state: 'error', error: message })
    }
  },
}))
