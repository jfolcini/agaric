/**
 * Space store — Zustand state for the active space (FEAT-3 Phase 1).
 *
 * A "space" is a top-level page block tagged `is_space = true` that
 * partitions user content into independent contexts (`Personal`, `Work`,
 * and any user-created spaces). The active space scopes pickers, search,
 * and list queries in later phases; Phase 1 only ships the data model
 * and the sidebar `SpaceSwitcher` UI surface.
 *
 * Persisted slice: `{ currentSpaceId }`. `availableSpaces` is rehydrated
 * on each boot via `refreshAvailableSpaces()` so it always reflects the
 * latest server truth. `isReady` is derived, not persisted — every boot
 * starts at `false` and flips to `true` once the first refresh resolves.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { logger } from '../lib/logger'
import type { SpaceRow } from '../lib/tauri'
import { listSpaces } from '../lib/tauri'

const LOG_MODULE = 'stores/space'

interface SpaceState {
  /** ULID of the active space, or `null` until the first refresh completes. */
  currentSpaceId: string | null
  /** Snapshot of every space the backend knows about, alphabetical by name. */
  availableSpaces: SpaceRow[]
  /** `false` until the first `refreshAvailableSpaces()` resolves (success or error). */
  isReady: boolean

  /** Set the active space. Caller is responsible for ensuring `id` is valid. */
  setCurrentSpace: (id: string) => void
  /** Fetch every space and reconcile `currentSpaceId` against the result. */
  refreshAvailableSpaces: () => Promise<void>
}

/**
 * Reconcile a persisted `currentSpaceId` against a freshly-fetched list of
 * spaces. When the persisted id no longer exists (e.g. the space was
 * deleted on another device), fall back to the first space in the
 * alphabetical list. Returns the id to store, or `null` when no spaces
 * exist yet.
 */
function reconcileCurrentSpaceId(current: string | null, available: SpaceRow[]): string | null {
  if (available.length === 0) return null
  if (current !== null && available.some((s) => s.id === current)) {
    return current
  }
  const first = available[0]
  return first ? first.id : null
}

export const useSpaceStore = create<SpaceState>()(
  persist(
    (set, get) => ({
      currentSpaceId: null,
      availableSpaces: [],
      isReady: false,

      setCurrentSpace: (id: string) => {
        set({ currentSpaceId: id })
      },

      refreshAvailableSpaces: async () => {
        try {
          const raw = await listSpaces()
          // Defensive — IPC boundary hardening (AGENTS pitfall #25).
          // Any non-array response is treated as "no spaces" so the
          // UI never crashes on a shape mismatch.
          if (!Array.isArray(raw)) {
            logger.warn(LOG_MODULE, 'list_spaces returned a non-array response; treating as empty')
            set({ availableSpaces: [], currentSpaceId: null, isReady: true })
            return
          }
          const spaces = raw
          const nextCurrent = reconcileCurrentSpaceId(get().currentSpaceId, spaces)
          set({
            availableSpaces: spaces,
            currentSpaceId: nextCurrent,
            isReady: true,
          })
        } catch (err) {
          // Never freeze the UI on backend error — mark ready and leave
          // `availableSpaces` untouched so a previously-loaded snapshot
          // (if any) remains usable. Log via the shared logger so the
          // failure surfaces in the daily log file, not a silent catch.
          logger.warn(LOG_MODULE, 'failed to load spaces', undefined, err)
          set({ isReady: true })
        }
      },
    }),
    {
      name: 'agaric:space',
      // Persist only the id — `availableSpaces` is server truth and must
      // be re-fetched every boot so a space deleted on another device
      // doesn't linger in the switcher.
      partialize: (state) => ({ currentSpaceId: state.currentSpaceId }),
    },
  ),
)
