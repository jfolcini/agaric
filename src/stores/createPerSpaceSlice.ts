/**
 * The per-space "map + derived active mirror + reconcile" primitive. Stores
 * partitioned by space keep a per-space map (the truth) and a flat field
 * mirroring the active space; hand-rolling that per store let an action
 * persist a stale mirror into the wrong space, and a rehydrate leave the
 * mirror holding another space's value.
 *
 * `applyActive` writes the active slice and derives the mirror in one update,
 * so they cannot drift. `attach` wires the space-change reconcile: a real
 * switch flushes the outgoing mirror into its slice and pulls the incoming
 * slice (or a fallback); the first fire seeds an absent slice from the
 * rehydrated mirror, or else pulls the slice into the mirror.
 */

import type { StoreApi } from 'zustand'

import { activeSpaceKey } from '@/stores/active-space'
import { createSpaceSubscriber } from '@/stores/createSpaceSubscriber'

/** Context handed to {@link PerSpaceSliceOptions.fallback} on a real switch. */
export interface PerSpaceSwitchContext<T> {
  /** The space being switched TO. */
  newKey: string
  /** The space being switched FROM. */
  prevKey: string
  /** The mirror at switch time: the outgoing space's value. */
  current: T
}

export interface PerSpaceSliceOptions<State, T> {
  /** The mirror value, assembled from every flat field it spans. */
  readMirror: (state: State) => T
  /** The state patch writing `value` into the flat mirror; the inverse of {@link readMirror}. */
  writeMirror: (value: T) => Partial<State>
  /** Read the per-space slice for `key`, or `undefined` when the space has none yet. */
  getSlice: (state: State, key: string) => T | undefined
  /** State patch that writes `value` into the per-space slice for `key`. */
  setSlice: (state: State, key: string, value: T) => Partial<State>
  /**
   * The mirror's value for a space with no slice yet. Gets the switch context
   * so a store can vary it by direction (navigation keeps the view on the
   * first `__legacy__` → real hydration).
   */
  fallback: (ctx: PerSpaceSwitchContext<T>) => T
  /** Cross-store side effect after a real switch (tabs clears `selectedBlockId`). */
  onSwitch?: (prevKey: string, newKey: string) => void
  /**
   * Whether the first fire may seed an absent slice from the mirror; default
   * yes. `recent-pages` allows only `__legacy__`: its mirror can hold another
   * space's list after a rehydrate. Declined, the mirror resets to the fallback
   * and the slice stays absent.
   */
  seedOnFirstFire?: (newKey: string) => boolean
  /**
   * Equality that skips a redundant first-fire pull; default `Object.is`. A
   * composite mirror built fresh per read just always pulls, once at import.
   */
  equals?: (a: T, b: T) => boolean
  /**
   * Whether a real switch also seeds the incoming slice with the value pulled
   * into the mirror; default no, so switching in and straight out writes no
   * empty seed that masks later data. `journal` opts in: its fallback (today,
   * daily) is a real value (#3322).
   */
  seedOnSwitch?: boolean
}

export interface PerSpaceSlice<State, T> {
  /** The patch writing `value` into the active space's slice and the mirror, in one update. */
  applyActive: (state: State, value: T) => Partial<State>
  /** The active space's slice, or `undefined` when it has none yet. */
  readActiveSlice: (state: State) => T | undefined
  /**
   * Wire the reconcile through {@link createSpaceSubscriber} and return it, so
   * a store can export it for tests of the first-fire path. Call once at
   * module scope, after the store is created.
   */
  attach: (store: StoreApi<State>) => (prevKey: string, newKey: string) => void
}

/**
 * Build the primitive from a store's projection. `applyActive` and
 * `readActiveSlice` need no store handle, so actions use them inside
 * `create()`; `attach` binds the reconcile to the created store.
 */
export function createPerSpaceSlice<State, T>(
  options: PerSpaceSliceOptions<State, T>,
): PerSpaceSlice<State, T> {
  const { readMirror, writeMirror, getSlice, setSlice, fallback, onSwitch } = options
  const seedOnSwitch = options.seedOnSwitch ?? false
  const eq = options.equals ?? Object.is
  const seedOnFirstFire = options.seedOnFirstFire ?? ((): boolean => true)

  const applyActive = (state: State, value: T): Partial<State> => ({
    ...writeMirror(value),
    ...setSlice(state, activeSpaceKey(), value),
  })

  const readActiveSlice = (state: State): T | undefined => getSlice(state, activeSpaceKey())

  const attach = (store: StoreApi<State>): ((prevKey: string, newKey: string) => void) => {
    const reconcile = (prevKey: string, newKey: string): void => {
      const state = store.getState()

      // First fire (`fireImmediately`): make the active slice and mirror agree.
      if (prevKey === newKey) {
        const slice = getSlice(state, newKey)
        if (slice !== undefined) {
          // The mirror may hold a stale or foreign value: pull the slice.
          if (!eq(slice, readMirror(state))) store.setState(writeMirror(slice))
          return
        }
        const mirror = readMirror(state)
        if (seedOnFirstFire(newKey)) {
          // Seed the slice from the rehydrated mirror, which already holds it.
          store.setState(setSlice(state, newKey, mirror))
        } else {
          // The mirror may be foreign: reset it and leave the slice absent.
          const fresh = fallback({ newKey, prevKey, current: mirror })
          if (!eq(fresh, mirror)) store.setState(writeMirror(fresh))
        }
        return
      }

      // Real switch: flush the outgoing mirror, pull the incoming slice or the
      // fallback; seed it only with `seedOnSwitch`.
      const current = readMirror(state)
      const flushed = setSlice(state, prevKey, current)
      // Read from the post-flush state: both `setSlice` patches spread the same
      // map, so seeding off the pre-flush state would drop the flush.
      const afterFlush = { ...state, ...flushed }
      const incoming = getSlice(afterFlush, newKey) ?? fallback({ newKey, prevKey, current })
      const seeded = seedOnSwitch ? setSlice(afterFlush, newKey, incoming) : {}
      store.setState({ ...flushed, ...seeded, ...writeMirror(incoming) })
      onSwitch?.(prevKey, newKey)
    }

    createSpaceSubscriber(reconcile)
    return reconcile
  }

  return { applyActive, readActiveSlice, attach }
}
