/**
 * Space store: the active space. A space is a top-level page tagged
 * `is_space = true` that partitions content (`Personal`, `Work`, ...) and
 * scopes pickers, search and lists.
 *
 * Only `currentSpaceId` persists; `availableSpaces` is re-fetched every boot,
 * and `isReady` flips once the first refresh resolves. A launch opens the
 * device's default space when one is set (`PREFERENCES.defaultSpace`), else
 * the persisted one.
 */

import { create } from 'zustand'
import { persist, subscribeWithSelector } from 'zustand/middleware'

import { unwrap } from '@/lib/app-error'
import type { SpaceRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { PREFERENCES, readPreference, removePreference } from '@/lib/preferences'
import { safePersistStorage } from '@/lib/safe-persist-storage'

const LOG_MODULE = 'stores/space'

/** Accent token when no space is active or it has no `accent_color`; matches the Work seed. */
export const DEFAULT_ACCENT_TOKEN = 'accent-blue'

/**
 * Key of the no-space slot in per-space maps (`tabsBySpace`, ...), used while
 * `currentSpaceId` is `null`: before bootstrap, or data from before spaces.
 */
export const LEGACY_SPACE_KEY = '__legacy__'

/**
 * Outcome of the last `refreshAvailableSpaces()`, which never rejects
 * (#2921). A hard failure (no prior snapshot to keep using) is recorded here
 * for `boot()` to show BootGate's retry screen; a soft one, with a snapshot,
 * reports `ok` and only toasts.
 */
export type SpaceRefreshOutcome = { kind: 'ok' } | { kind: 'hard-error'; error: unknown }

interface SpaceState {
  /** ULID of the active space, or `null` until the first refresh completes. */
  currentSpaceId: string | null
  /** Snapshot of every space the backend knows about, alphabetical by name. */
  availableSpaces: SpaceRow[]
  /** `false` until the first `refreshAvailableSpaces()` resolves (success or error). */
  isReady: boolean
  /** See {@link SpaceRefreshOutcome}. Defaults to `{ kind: 'ok' }`. */
  lastRefreshOutcome: SpaceRefreshOutcome

  /** Set the active space. Caller is responsible for ensuring `id` is valid. */
  setCurrentSpace: (id: string) => void
  /** Fetch every space and reconcile `currentSpaceId` against the result. */
  refreshAvailableSpaces: () => Promise<void>
  /**
   * The active space's `accent_color` token, or `DEFAULT_ACCENT_TOKEN`. Reads
   * `availableSpaces`, so it follows every refresh. Pure.
   */
  getCurrentAccent: () => string
}

/**
 * The space to make current after a fetch: on the first reconcile of a launch,
 * the device's default space if it exists; else the current one if it still
 * exists; else the default, then the first alphabetically. `null` with no spaces.
 */
function reconcileCurrentSpaceId(
  current: string | null,
  available: SpaceRow[],
  defaultSpace: string | null,
  launching: boolean,
): string | null {
  const exists = (id: string | null): id is string =>
    id !== null && available.some((s) => s.id === id)
  if (launching && exists(defaultSpace)) return defaultSpace
  if (exists(current)) return current
  if (exists(defaultSpace)) return defaultSpace
  return available[0]?.id ?? null
}

function sameSpaces(a: SpaceRow[], b: SpaceRow[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (s, i) => s.id === b[i]?.id && s.name === b[i]?.name && s.accent_color === b[i]?.accent_color,
    )
  )
}

export const useSpaceStore = create<SpaceState>()(
  // Lets `createSpaceSubscriber` listen on `currentSpaceId` alone instead of
  // waking on every write.
  subscribeWithSelector(
    persist(
      (set, get) => ({
        currentSpaceId: null,
        availableSpaces: [],
        isReady: false,
        lastRefreshOutcome: { kind: 'ok' },

        setCurrentSpace: (id: string) => {
          set({ currentSpaceId: id })
        },

        getCurrentAccent: () => {
          const { currentSpaceId, availableSpaces } = get()
          if (currentSpaceId === null) return DEFAULT_ACCENT_TOKEN
          const active = availableSpaces.find((s) => s.id === currentSpaceId)
          // Unset, empty, or the row is gone: the default, so the chip never blanks.
          const token = active?.accent_color
          if (token == null || token === '') return DEFAULT_ACCENT_TOKEN
          return token
        },

        refreshAvailableSpaces: async () => {
          try {
            const raw = unwrap(await commands.listSpaces())
            // A non-array response reads as no spaces, so a shape mismatch cannot crash the UI.
            if (!Array.isArray(raw)) {
              logger.warn(
                LOG_MODULE,
                'list_spaces returned a non-array response; treating as empty',
              )
              set({
                availableSpaces: [],
                currentSpaceId: null,
                isReady: true,
                lastRefreshOutcome: { kind: 'ok' },
              })
              return
            }
            // Every sync tick refreshes (#5283); an unchanged list keeps its
            // identity so subscribers don't re-render for nothing.
            const prev = get().availableSpaces
            const spaces = sameSpaces(prev, raw) ? prev : raw
            const prevCurrent = get().currentSpaceId
            const defaultSpace = readPreference(PREFERENCES.defaultSpace)
            const nextCurrent = reconcileCurrentSpaceId(
              prevCurrent,
              spaces,
              defaultSpace,
              !get().isReady,
            )
            // The default space was deleted, here or on another device: back to Last used.
            if (defaultSpace !== null && !spaces.some((s) => s.id === defaultSpace)) {
              removePreference(PREFERENCES.defaultSpace)
            }
            set({
              availableSpaces: spaces,
              currentSpaceId: nextCurrent,
              isReady: true,
              lastRefreshOutcome: { kind: 'ok' },
            })
            // The active space vanished (deleted on another device): say why
            // it changed, once. Not on first boot, nor when a launch opens the
            // default space, nor with no space to fall back to.
            if (
              prevCurrent !== null &&
              nextCurrent !== null &&
              !spaces.some((s) => s.id === prevCurrent)
            ) {
              const newSpace = spaces.find((s) => s.id === nextCurrent)
              if (newSpace) {
                notify.warning(i18n.t('space.activeDeletedNotification', { space: newSpace.name }))
              }
            }
          } catch (err) {
            // `isReady` flips either way so gated views do not hang. A hard
            // failure (no snapshot to keep using) is recorded for `boot()`, so
            // it shows the retry screen instead of an empty app (#2921).
            logger.warn(LOG_MODULE, 'failed to load spaces', undefined, err)
            const { availableSpaces, currentSpaceId } = get()
            const hasUsableSnapshot = availableSpaces.length > 0 || currentSpaceId !== null
            if (hasUsableSnapshot) {
              // Soft: a deduped toast, so a repeating background failure does not stack.
              notify.error(i18n.t('error.spacesLoadFailed'), { id: 'spaces-load-failed' })
            }
            set({
              isReady: true,
              lastRefreshOutcome: hasUsableSnapshot
                ? { kind: 'ok' }
                : { kind: 'hard-error', error: err },
            })
          }
        },
      }),
      {
        name: 'agaric:space',
        storage: safePersistStorage,
        // `availableSpaces` is re-fetched, so a space deleted elsewhere does not linger.
        partialize: (state) => ({ currentSpaceId: state.currentSpaceId }),
      },
    ),
  ),
)
