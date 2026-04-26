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

import { toast } from 'sonner'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { i18n } from '../lib/i18n'
import { logger } from '../lib/logger'
import type { SpaceRow } from '../lib/tauri'
import { listSpaces } from '../lib/tauri'

const LOG_MODULE = 'stores/space'

/**
 * FEAT-3p10 — fallback accent token used when no space is active yet
 * (boot pre-bootstrap edge case) or when the active space carries no
 * `accent_color` property. `accent-blue` matches the Work seed default
 * and lines up with the brand `--primary` so the UI feels coherent
 * when nothing has been picked.
 */
export const DEFAULT_ACCENT_TOKEN = 'accent-blue'

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
  /**
   * FEAT-3p10 — derived selector returning the active space's
   * `accent_color` token (e.g. `accent-emerald`, `accent-blue`), or
   * [`DEFAULT_ACCENT_TOKEN`] when no space is active or the active
   * space has no explicit accent. Reads `availableSpaces` so the
   * value refreshes for free whenever `refreshAvailableSpaces()` is
   * called (e.g. after the user recolours a space via the manage
   * dialog). Pure selector — no side effects, no IPC.
   */
  getCurrentAccent: () => string
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

      getCurrentAccent: () => {
        const { currentSpaceId, availableSpaces } = get()
        if (currentSpaceId === null) return DEFAULT_ACCENT_TOKEN
        const active = availableSpaces.find((s) => s.id === currentSpaceId)
        // `accent_color` is `string | null` on the wire — fall back to
        // the default when unset (or when the row was filtered out
        // between the IPC and the selector call). Empty string is also
        // treated as "unset" so a malformed payload doesn't blank the
        // chip.
        const token = active?.accent_color
        if (token == null || token === '') return DEFAULT_ACCENT_TOKEN
        return token
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
          const prevCurrent = get().currentSpaceId
          const nextCurrent = reconcileCurrentSpaceId(prevCurrent, spaces)
          set({
            availableSpaces: spaces,
            currentSpaceId: nextCurrent,
            isReady: true,
          })
          // UX-266 — when the previously-active space disappeared from the
          // server-truth list (e.g. deleted on another device and synced
          // down) we silently fall back to the first available space. Tell
          // the user once via a one-shot toast so they understand why the
          // active space changed without their action. Skip on first boot
          // (`prevCurrent === null`) and when the fallback finds no space
          // to switch to (`nextCurrent === null`).
          if (prevCurrent !== null && nextCurrent !== null && prevCurrent !== nextCurrent) {
            const newSpace = spaces.find((s) => s.id === nextCurrent)
            if (newSpace) {
              toast.warning(i18n.t('space.activeDeletedNotification', { space: newSpace.name }))
            }
          }
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
