/**
 * Space store — Zustand state for the active space (Phase 1).
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
import { persist, subscribeWithSelector } from 'zustand/middleware'

import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { safePersistStorage } from '@/lib/safe-persist-storage'
import type { SpaceRow } from '@/lib/tauri'
import { listSpaces } from '@/lib/tauri'

const LOG_MODULE = 'stores/space'

/**
 * Fallback accent token used when no space is active yet
 * (boot pre-bootstrap edge case) or when the active space carries no
 * `accent_color` property. `accent-blue` matches the Work seed default
 * and lines up with the brand `--primary` so the UI feels coherent
 * when nothing has been picked.
 */
export const DEFAULT_ACCENT_TOKEN = 'accent-blue'

/**
 * Reserved key for the no-active-space slot in per-space partition maps
 * (`tabsBySpace`, `recentPagesBySpace`, `currentDateBySpace`, …). Used
 * by `createSpaceSubscriber` and the per-space stores when
 * `currentSpaceId` is `null` (pre-bootstrap, or migrated v0 data that
 * predates spaces).
 */
export const LEGACY_SPACE_KEY = '__legacy__'

/**
 * #2921 — outcome of the most recent `refreshAvailableSpaces()` call.
 * `refreshAvailableSpaces()` itself never rejects (non-boot callers —
 * `SpaceSwitcher`'s fire-and-forget mount refresh, `SpaceManageDialog`'s
 * awaited-but-uncaught refresh — rely on that contract), so a caller that
 * needs to react to a HARD failure (no usable prior snapshot: empty
 * `availableSpaces` AND `currentSpaceId === null`) reads this field
 * instead. The boot store's `boot()` is the one production reader: it
 * awaits `refreshAvailableSpaces()` then checks this to decide between
 * transitioning to `'ready'` or surfacing BootGate's error/retry screen.
 * A SOFT failure (a usable snapshot exists) reports `{ kind: 'ok' }` —
 * same as success — because the app stays usable on the prior snapshot;
 * only the deduped toast in `refreshAvailableSpaces` marks that case.
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
   * Derived selector returning the active space's
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
  // `subscribeWithSelector` lets `createSpaceSubscriber` (and any future
  // narrow subscriber) listen on a single selector — currentSpaceId —
  // instead of waking on every space-store write (`availableSpaces`
  // refresh, `isReady` flip). See design-system-perf-review-2026-05-09
  // item 13.
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
            const spaces = raw
            const prevCurrent = get().currentSpaceId
            const nextCurrent = reconcileCurrentSpaceId(prevCurrent, spaces)
            set({
              availableSpaces: spaces,
              currentSpaceId: nextCurrent,
              isReady: true,
              lastRefreshOutcome: { kind: 'ok' },
            })
            // When the previously-active space disappeared from the
            // server-truth list (e.g. deleted on another device and synced
            // down) we silently fall back to the first available space. Tell
            // the user once via a one-shot toast so they understand why the
            // active space changed without their action. Skip on first boot
            // (`prevCurrent === null`) and when the fallback finds no space
            // to switch to (`nextCurrent === null`).
            if (prevCurrent !== null && nextCurrent !== null && prevCurrent !== nextCurrent) {
              const newSpace = spaces.find((s) => s.id === nextCurrent)
              if (newSpace) {
                notify.warning(i18n.t('space.activeDeletedNotification', { space: newSpace.name }))
              }
            }
          } catch (err) {
            // #2921 — distinguish a HARD failure (no usable prior snapshot
            // to fall back on) from a SOFT one (a snapshot exists — either
            // rehydrated from persisted `currentSpaceId` or from an earlier
            // successful refresh this session). Never freeze the UI in
            // EITHER case — `isReady` still flips so components gated on it
            // (SearchPanel, PageBrowser, CommandPalette, …) don't hang —
            // but a HARD failure additionally records `lastRefreshOutcome`
            // so the boot store can read it right after its own `await`
            // returns and surface BootGate's error/retry screen instead of
            // silently landing on `ready` with an empty space list (the
            // every-page-load-no-ops / perpetual-skeleton bug).
            logger.warn(LOG_MODULE, 'failed to load spaces', undefined, err)
            const { availableSpaces, currentSpaceId } = get()
            const hasUsableSnapshot = availableSpaces.length > 0 || currentSpaceId !== null
            if (hasUsableSnapshot) {
              // SOFT — tell the user via a deduped toast (stable `id`) so a
              // repeating background refresh failure (e.g. sync polling)
              // doesn't stack toasts.
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
        // Persist only the id — `availableSpaces` is server truth and must
        // be re-fetched every boot so a space deleted on another device
        // doesn't linger in the switcher.
        partialize: (state) => ({ currentSpaceId: state.currentSpaceId }),
      },
    ),
  ),
)
