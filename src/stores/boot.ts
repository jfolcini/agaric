/**
 * Boot store — manages application startup state machine.
 *
 * startup-latency-backend Phase 2: the artificial `invoke('list_blocks')`
 * handshake was dropped. Tauri guarantees backend readiness by the time
 * any IPC can return; if `setup()` fails the process exits before the
 * frontend mounts, so a handshake adds no information. The store now
 * transitions `booting → ready` synchronously on first boot. The
 * `error` state is preserved as an externally-triggerable surface for
 * future use (e.g., a fatal IPC outage that wants a full-screen
 * recovery prompt instead of an inline error), but no production
 * code path drives it today.
 */

import { create } from 'zustand'

type BootState = 'booting' | 'ready' | 'error'

interface BootStore {
  state: BootState
  error: string | null
  /**
   * Kept as `() => Promise<void>` for API compatibility — the BootGate
   * retry button and downstream callers `await` the result. The body is
   * synchronous post-Phase-2; the async signature keeps the retry-button
   * loading state visible for the duration of the React commit cycle.
   */
  boot: () => Promise<void>
}

export const useBootStore = create<BootStore>((set) => ({
  state: 'booting',
  error: null,
  boot: () => {
    set({ state: 'ready', error: null })
    return Promise.resolve()
  },
}))
