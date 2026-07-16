/**
 * createPerSpaceSlice — the per-space "map + derived active mirror + reconcile"
 * primitive.
 *
 * Several stores (`recent-pages`, `tabs`, `navigation`, …) partition their
 * state by the active space. Each historically encoded the SAME shape by hand:
 *
 *   1. a per-space `Record<string, T>` map (the canonical source of truth),
 *   2. a top-level FLAT field mirroring the active space's slice that every
 *      action had to rewrite in lock-step, and
 *   3. a hand-written `reconcile…OnSpaceChange(prev, new)` flush/pull wired
 *      through {@link createSpaceSubscriber}.
 *
 * Re-deriving that shape per store produced real defects — see the
 * `recent-pages` "write-time corruption" (Defect 1: an action reading the stale
 * flat mirror and persisting it into the wrong space's slice) and "Defect 2"
 * (a rehydrate leaving the flat mirror holding a different space's list). This
 * primitive owns all three pieces ONCE so no store re-invents the footgun:
 *
 *   - `applyActive(state, value)` composes the state patch that writes `value`
 *     into the active space's slice AND derives the flat mirror from it in a
 *     single, atomic update. Actions call this instead of hand-writing the
 *     mirror, so the mirror can never drift from its slice.
 *   - `attach(store)` wires the space-change reconcile through
 *     {@link createSpaceSubscriber}. On a real switch it flushes the outgoing
 *     mirror into the outgoing slice and pulls the incoming slice (or a
 *     fallback) into the mirror. On the first fire it seeds an absent slice
 *     from the rehydrated mirror, otherwise pulls the slice into the mirror
 *     (the Defect-2 fix).
 *
 * The map remains the single source of truth; the mirror is always derived.
 */

import type { StoreApi } from 'zustand'

import { activeSpaceKey } from '@/lib/active-space'
import { createSpaceSubscriber } from '@/lib/createSpaceSubscriber'

/** Context handed to {@link PerSpaceSliceOptions.fallback} on a real switch. */
export interface PerSpaceSwitchContext<T> {
  /** The space being switched TO. */
  newKey: string
  /** The space being switched FROM. */
  prevKey: string
  /** The active mirror value at switch time (the outgoing space's slice). */
  current: T
}

export interface PerSpaceSliceOptions<State, T> {
  /**
   * Read the active mirror value out of the flat state field(s). For a
   * single-field mirror this is `(s) => s.someFlatField`; for a composite
   * mirror (e.g. tabs' `{ tabs, activeTabIndex }`) it assembles the value
   * from every flat field it spans.
   */
  readMirror: (state: State) => T
  /**
   * Project an active value into a state patch that updates the flat
   * mirror field(s). The inverse of {@link readMirror}. May transform the
   * value (e.g. an ISO-string slice → a `Date` mirror).
   */
  writeMirror: (value: T) => Partial<State>
  /** Read the per-space slice for `key`, or `undefined` when the space has none yet. */
  getSlice: (state: State, key: string) => T | undefined
  /** State patch that writes `value` into the per-space slice for `key`. */
  setSlice: (state: State, key: string, value: T) => Partial<State>
  /**
   * Value pulled into the mirror when the incoming space has no slice yet
   * (the fresh-space default). Receives the switch context so a store can
   * vary the default by direction — e.g. navigation keeps the current view on
   * the initial `__legacy__` → real-space hydration, but defaults to
   * `page-editor` on a genuine user-initiated switch.
   */
  fallback: (ctx: PerSpaceSwitchContext<T>) => T
  /**
   * Optional cross-store side effect run AFTER a real (prev ≠ new) switch has
   * been applied — e.g. tabs clears the navigation store's transient
   * `selectedBlockId` so a highlight from the previous space doesn't bleed in.
   */
  onSwitch?: (prevKey: string, newKey: string) => void
  /**
   * Whether the first fire may seed an ABSENT slice for `newKey` from the flat
   * mirror. Defaults to `true` (the v0→v1 carry: the persisted flat field is
   * the last-active value and is a safe seed — navigation/tabs).
   *
   * `recent-pages` overrides this to `(key) => key === LEGACY_SPACE_KEY`: its
   * flat mirror can hold a *foreign* space's list after a rehydrate, so seeding
   * a real space's slice from it would persist cross-space data (the "write-time
   * corruption" defect). When seeding is declined the mirror is instead reset to
   * the fallback and the slice is left absent.
   */
  seedOnFirstFire?: (newKey: string) => boolean
  /**
   * Equality used to skip a redundant mirror pull on the first fire. Defaults
   * to `Object.is`, which is exact for the reference-stable single-field
   * mirrors (`recent-pages`, `navigation`); composite mirrors that rebuild a
   * fresh object per read simply always pull on the (import-time only) first
   * fire, which is harmless.
   */
  equals?: (a: T, b: T) => boolean
}

export interface PerSpaceSlice<State, T> {
  /**
   * Compose the state patch an action applies to write `value` into the
   * ACTIVE space's slice and derive the flat mirror from it in one update.
   * The active space is resolved via {@link activeSpaceKey} at call time.
   */
  applyActive: (state: State, value: T) => Partial<State>
  /** The active space's slice, or `undefined` when it has none yet. */
  readActiveSlice: (state: State) => T | undefined
  /**
   * Wire the space-change reconcile through {@link createSpaceSubscriber} and
   * return the reconcile callback (so a store can re-export it for tests that
   * drive the first-fire path directly). Call once, at module scope, after the
   * store is created.
   */
  attach: (store: StoreApi<State>) => (prevKey: string, newKey: string) => void
}

/**
 * Build the per-space primitive from a store-specific projection. The returned
 * `applyActive` / `readActiveSlice` are pure (no store handle needed, so
 * actions can use them inside the `create()` initializer); `attach` binds the
 * reconcile to the created store.
 */
export function createPerSpaceSlice<State, T>(
  options: PerSpaceSliceOptions<State, T>,
): PerSpaceSlice<State, T> {
  const { readMirror, writeMirror, getSlice, setSlice, fallback, onSwitch } = options
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

      // First fire (`prevKey === newKey`, via `fireImmediately`): the space
      // store just woke up / rehydrated. Materialise the invariant that the
      // active slice and the mirror agree.
      if (prevKey === newKey) {
        const slice = getSlice(state, newKey)
        if (slice !== undefined) {
          // The mirror holds a different (stale, possibly foreign) value than
          // the active slice — pull the slice into the mirror (Defect 2).
          if (!eq(slice, readMirror(state))) store.setState(writeMirror(slice))
          return
        }
        // No slice yet.
        const mirror = readMirror(state)
        if (seedOnFirstFire(newKey)) {
          // Seed the slice from the rehydrated flat mirror (the v0→v1
          // flat-only carry). The mirror already holds this value, so only
          // the map changes.
          store.setState(setSlice(state, newKey, mirror))
        } else {
          // The mirror may be foreign (recent-pages) — don't persist it into
          // this space's slice. Reset the mirror to the fallback and leave the
          // slice absent (its selector falls back).
          const fresh = fallback({ newKey, prevKey, current: mirror })
          if (!eq(fresh, mirror)) store.setState(writeMirror(fresh))
        }
        return
      }

      // Real switch: flush the outgoing mirror into the outgoing slice, then
      // pull the incoming slice — or the fresh-space fallback — into the
      // mirror. The incoming slice is deliberately NOT seeded: a fresh space
      // keeps an absent slice (its selector falls back), so switching in and
      // straight back out can't leave an empty seed masking future data.
      const current = readMirror(state)
      const flushed = setSlice(state, prevKey, current)
      const incoming = getSlice(state, newKey) ?? fallback({ newKey, prevKey, current })
      store.setState({ ...flushed, ...writeMirror(incoming) })
      onSwitch?.(prevKey, newKey)
    }

    createSpaceSubscriber(reconcile)
    return reconcile
  }

  return { applyActive, readActiveSlice, attach }
}
