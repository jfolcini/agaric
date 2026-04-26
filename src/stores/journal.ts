/**
 * Journal store — shared state for the journal view (mode, date, pageMap).
 *
 * Used by both App.tsx (header controls) and JournalPage.tsx (content).
 *
 * FEAT-3p5 — per-space slices for `currentDate` and `mode`.
 *
 * The flat `currentDate` / `mode` fields remain the active-view selectors
 * every consumer reads from (no consumer plumbing needed). Two new
 * persisted maps mirror them per-space:
 *
 *  - `currentDateBySpace: Record<SpaceId, string>` — ISO YYYY-MM-DD per space.
 *  - `modeBySpace: Record<SpaceId, JournalMode>` — last-active mode per space.
 *
 * On `useSpaceStore` space-switch, a subscriber flushes the OUTGOING
 * space's flat fields into its slice and pulls the INCOMING space's
 * slice into the flat fields. Fresh-space default: today's date in
 * `daily` mode. The pattern mirrors `useNavigationStore.tabsBySpace`
 * (FEAT-3 Phase 3, session 498).
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useSpaceStore } from './space'

export type JournalMode = 'daily' | 'weekly' | 'monthly' | 'agenda'
export type JournalPanel = 'due' | 'references' | 'done'

/**
 * Reserved key used for the "no active space" slice. If a user boots
 * without `currentSpaceId` set (early boot, or no spaces yet) actions
 * read/write this slice rather than dropping data on the floor.
 */
const LEGACY_SPACE_KEY = '__legacy__'

interface JournalStore {
  mode: JournalMode
  currentDate: Date
  /**
   * FEAT-3p5 — last-active date per space, keyed by space ULID. Stored
   * as `YYYY-MM-DD` strings so JSON persistence round-trips cleanly
   * (Date objects don't survive `JSON.stringify`).
   */
  currentDateBySpace: Record<string, string>
  /** FEAT-3p5 — last-active mode per space, keyed by space ULID. */
  modeBySpace: Record<string, JournalMode>
  /** Date string (YYYY-MM-DD) to scroll into view after render, or null. */
  scrollToDate: string | null
  /** Panel to scroll to after navigating to daily view, or null. */
  scrollToPanel: JournalPanel | null
  setMode: (mode: JournalMode) => void
  setCurrentDate: (date: Date) => void
  navigateToDate: (date: Date, mode: JournalMode) => void
  /** Set currentDate and request a scroll to a specific date section. */
  goToDateAndScroll: (date: Date, scrollTarget: string) => void
  /** Navigate to daily view for a date and scroll to a specific panel. */
  goToDateAndPanel: (date: Date, panel: JournalPanel) => void
  clearScrollTarget: () => void
}

/** Resolve the active per-space key, falling back to the legacy slot. */
function activeSpaceKey(): string {
  return useSpaceStore.getState().currentSpaceId ?? LEGACY_SPACE_KEY
}

/** Format a Date as a local-time `YYYY-MM-DD` string (matches `formatDate`). */
function dateToISO(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Parse a `YYYY-MM-DD` string into a local-time Date. Returns `null`
 * for shape mismatch / invalid calendar dates so the rehydrate path
 * can fall through to today.
 */
function parseISODate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? null : date
}

export const useJournalStore = create<JournalStore>()(
  persist(
    (set) => ({
      mode: 'daily',
      currentDate: new Date(),
      currentDateBySpace: {},
      modeBySpace: {},
      scrollToDate: null,
      scrollToPanel: null,
      setMode: (mode) =>
        set((state) => {
          const key = activeSpaceKey()
          return {
            mode,
            modeBySpace: { ...state.modeBySpace, [key]: mode },
          }
        }),
      setCurrentDate: (date) =>
        set((state) => {
          const key = activeSpaceKey()
          return {
            currentDate: date,
            currentDateBySpace: { ...state.currentDateBySpace, [key]: dateToISO(date) },
          }
        }),
      navigateToDate: (date, mode) =>
        set((state) => {
          const key = activeSpaceKey()
          return {
            currentDate: date,
            mode,
            currentDateBySpace: { ...state.currentDateBySpace, [key]: dateToISO(date) },
            modeBySpace: { ...state.modeBySpace, [key]: mode },
          }
        }),
      goToDateAndScroll: (date, scrollTarget) =>
        set((state) => {
          const key = activeSpaceKey()
          return {
            currentDate: date,
            scrollToDate: scrollTarget,
            currentDateBySpace: { ...state.currentDateBySpace, [key]: dateToISO(date) },
          }
        }),
      goToDateAndPanel: (date, panel) =>
        set((state) => {
          const key = activeSpaceKey()
          return {
            currentDate: date,
            mode: 'daily' as JournalMode,
            scrollToPanel: panel,
            currentDateBySpace: { ...state.currentDateBySpace, [key]: dateToISO(date) },
            modeBySpace: { ...state.modeBySpace, [key]: 'daily' as JournalMode },
          }
        }),
      clearScrollTarget: () => set({ scrollToDate: null, scrollToPanel: null }),
    }),
    {
      name: 'agaric:journal',
      version: 1,
      // Persist only the per-space slices — the flat `currentDate` /
      // `mode` fields are derived (mirror of the active-space slice)
      // and would round-trip lossily through JSON anyway (Date objects
      // serialise as strings without their type info). On rehydrate
      // the space-switch subscriber populates the flat fields from
      // the active slice, defaulting to today + `daily` for fresh
      // spaces.
      partialize: (state) => ({
        currentDateBySpace: state.currentDateBySpace,
        modeBySpace: state.modeBySpace,
      }),
    },
  ),
)

// ---------------------------------------------------------------------------
// FEAT-3p5 — space-switch subscriber
// ---------------------------------------------------------------------------
//
// Mirrors the `tabsBySpace` flush/pull pattern from `useNavigationStore`
// (FEAT-3 Phase 3, session 498). On every `currentSpaceId` change:
//
//   1. Flush the outgoing flat `currentDate` + `mode` into the outgoing
//      space's slice.
//   2. Pull the incoming space's slice into the flat fields.
//   3. If the incoming space has no slice yet, default to today +
//      `daily` (and seed both slices so the user lands somewhere
//      stable).
//
// `prevSpaceKey` is initialised lazily on the first subscriber fire so we
// don't sample `useSpaceStore.getState().currentSpaceId` at module-load
// time (which races with Zustand's async persist rehydration — the space
// store may rehydrate AFTER the journal store and would otherwise
// trigger a spurious flush of the just-rehydrated flat fields into the
// `__legacy__` slice). On first fire we also pull the active-space
// slice into the flat fields so a returning user lands on the same
// date + mode they last had in their active space, even though the
// flat fields were not persisted.
let prevSpaceKey: string | undefined

useSpaceStore.subscribe((state) => {
  const newKey = state.currentSpaceId ?? LEGACY_SPACE_KEY
  if (prevSpaceKey === undefined) {
    // First fire after boot — pull the active-space slice into the flat
    // fields if it exists. If not, leave the defaults (today + daily)
    // and seed the slice so the next space switch can flush cleanly.
    const journal = useJournalStore.getState()
    const persistedDate = journal.currentDateBySpace[newKey]
    const persistedMode = journal.modeBySpace[newKey]
    const newDate = persistedDate
      ? (parseISODate(persistedDate) ?? new Date())
      : journal.currentDate
    const newMode = persistedMode ?? journal.mode
    useJournalStore.setState({
      currentDate: newDate,
      mode: newMode,
      currentDateBySpace: {
        ...journal.currentDateBySpace,
        [newKey]: dateToISO(newDate),
      },
      modeBySpace: {
        ...journal.modeBySpace,
        [newKey]: newMode,
      },
    })
    prevSpaceKey = newKey
    return
  }
  if (newKey === prevSpaceKey) return

  const journal = useJournalStore.getState()

  // 1. Flush outgoing.
  const flushedDateBySpace = {
    ...journal.currentDateBySpace,
    [prevSpaceKey]: dateToISO(journal.currentDate),
  }
  const flushedModeBySpace = {
    ...journal.modeBySpace,
    [prevSpaceKey]: journal.mode,
  }

  // 2. Pull incoming, defaulting to today + daily.
  const incomingDateStr = flushedDateBySpace[newKey]
  const incomingMode = flushedModeBySpace[newKey]
  const incomingDate = incomingDateStr ? (parseISODate(incomingDateStr) ?? new Date()) : new Date()
  const incomingModeResolved: JournalMode = incomingMode ?? 'daily'

  useJournalStore.setState({
    currentDate: incomingDate,
    mode: incomingModeResolved,
    currentDateBySpace: {
      ...flushedDateBySpace,
      // Seed the incoming slice so subsequent flushes round-trip even if
      // the user doesn't touch anything before switching back.
      [newKey]: dateToISO(incomingDate),
    },
    modeBySpace: {
      ...flushedModeBySpace,
      [newKey]: incomingModeResolved,
    },
    // Drop transient scroll targets — they belong to the previous
    // space's last navigation and will confuse the new view.
    scrollToDate: null,
    scrollToPanel: null,
  })
  prevSpaceKey = newKey
})
