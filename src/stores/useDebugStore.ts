/**
 * Debug-mode store (#1987).
 *
 * A single, app-wide "show me the technical details" toggle, persisted to
 * `localStorage` and **off by default**. When on, user-facing error
 * surfaces (toasts and inline banners) additionally show the raw error
 * `kind`/message via {@link formatErrorForDisplay} in `@/lib/app-error`.
 * Off or on, sanitized backend errors still carry their `(err: <id>)`
 * correlation code so a user can read it back and an operator can grep
 * the full cause from the daily log.
 *
 * Why a store (not just a setting row): the formatter in `app-error.ts`
 * and the `notify` chokepoint in `notify.ts` are plain modules, not React
 * components, so they need a non-hook getter. {@link getDebugMode} reads
 * the live value synchronously for those call sites; React components use
 * the {@link useDebugStore} hook for reactive reads.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface DebugState {
  /** When true, error surfaces append the raw error code/kind. Default false. */
  debugMode: boolean
  setDebugMode: (enabled: boolean) => void
  toggleDebugMode: () => void
}

export const useDebugStore = create<DebugState>()(
  persist(
    (set) => ({
      debugMode: false,
      setDebugMode: (enabled) => set({ debugMode: enabled }),
      toggleDebugMode: () => set((state) => ({ debugMode: !state.debugMode })),
    }),
    {
      name: 'agaric:debug',
      version: 1,
      // Only the flag is persisted; the action closures are recreated on
      // each load and must never be written to storage.
      partialize: (state) => ({ debugMode: state.debugMode }),
    },
  ),
)

/**
 * Synchronous, non-reactive read of the current debug-mode flag, for use
 * from plain modules (the `notify` chokepoint, the error formatter) that
 * can't call the React hook. Components should prefer the
 * `useDebugStore((s) => s.debugMode)` selector so they re-render on change.
 */
export function getDebugMode(): boolean {
  return useDebugStore.getState().debugMode
}
