/**
 * Journal store: mode, date and scroll targets of the journal view. The flat
 * `currentDate` / `mode` mirror the active space's slots in
 * `currentDateBySpace` / `modeBySpace`, which are what persist; a fresh space
 * starts on today in `daily` mode.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { safePersistStorage } from '@/lib/safe-persist-storage'
import { createPerSpaceSlice } from '@/stores/createPerSpaceSlice'

export type JournalMode = 'daily' | 'weekly' | 'monthly' | 'agenda' | 'stream'
export type JournalPanel = 'due' | 'references' | 'done'

interface JournalStore {
  mode: JournalMode
  currentDate: Date
  /** Last-active date per space, as `YYYY-MM-DD`: a `Date` does not survive JSON. */
  currentDateBySpace: Record<string, string>
  /** Last-active mode per space. */
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
  /**
   * Jump to today for the current mode. Agenda and stream have no day to
   * scroll to, so Today lands on today's daily page, where the writing
   * happens; weekly and monthly scroll to today's section.
   */
  goToToday: () => void
  clearScrollTarget: () => void
}

/** Format a Date as a local-time `YYYY-MM-DD` string (matches `formatDate`). */
function dateToISO(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** A `YYYY-MM-DD` string as a local-time Date, or `null` when malformed or not a calendar date. */
export function parseISODate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  // Validate before constructing: `new Date(2026, 12, 45)` silently wraps.
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(year, month - 1, day)
  // Catch a day overflow (Feb 30 → Mar 2).
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

const JOURNAL_MODES: ReadonlySet<string> = new Set<JournalMode>([
  'daily',
  'weekly',
  'monthly',
  'agenda',
  'stream',
])

/** Coerce a persisted value into a `Record<string, string>`, dropping values that are not calendar dates. */
function coerceDateBySpace(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && parseISODate(value) !== null) out[key] = value
  }
  return out
}

/** Coerce a persisted value into a `Record<string, JournalMode>`. */
function coerceModeBySpace(raw: unknown): Record<string, JournalMode> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, JournalMode> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && JOURNAL_MODES.has(value)) out[key] = value as JournalMode
  }
  return out
}

/**
 * Coerce a whole persisted blob field by field (#823). Both `migrate` and
 * `merge` call it: zustand runs `migrate` only on a version mismatch, so a
 * corrupt blob with the current version reaches `merge` raw. Idempotent.
 */
function coercePersistedJournal(
  persisted: unknown,
): Pick<JournalStore, 'currentDateBySpace' | 'modeBySpace'> {
  const blob = (persisted != null && typeof persisted === 'object' ? persisted : {}) as Record<
    string,
    unknown
  >
  return {
    currentDateBySpace: coerceDateBySpace(blob['currentDateBySpace']),
    modeBySpace: coerceModeBySpace(blob['modeBySpace']),
  }
}

/**
 * Per-space slice of the `{ date, mode }` pair, which flush and pull together
 * (#3322). It carries a real `Date`, narrowed to `YYYY-MM-DD` only in the map.
 * `seedOnSwitch`: a fresh space's slice is seeded with today and `daily`, so a
 * later flush round-trips even if the view is never touched.
 */
const journalSlice = createPerSpaceSlice<JournalStore, { date: Date; mode: JournalMode }>({
  readMirror: (state) => ({ date: state.currentDate, mode: state.mode }),
  writeMirror: (value) => ({ currentDate: value.date, mode: value.mode }),
  getSlice: (state, key) => {
    const iso = state.currentDateBySpace[key]
    const mode = state.modeBySpace[key]
    // Absent only when neither field is stored; one alone keeps its value and
    // defaults the other.
    if (iso === undefined && mode === undefined) return undefined
    return {
      date: (iso === undefined ? null : parseISODate(iso)) ?? new Date(),
      mode: mode ?? 'daily',
    }
  },
  setSlice: (state, key, value) => ({
    currentDateBySpace: { ...state.currentDateBySpace, [key]: dateToISO(value.date) },
    modeBySpace: { ...state.modeBySpace, [key]: value.mode },
  }),
  fallback: () => ({ date: new Date(), mode: 'daily' }),
  seedOnSwitch: true,
  // The previous space's scroll targets would confuse the incoming view.
  onSwitch: () => {
    useJournalStore.setState({ scrollToDate: null, scrollToPanel: null })
  },
})

export const useJournalStore = create<JournalStore>()(
  persist(
    (set, get) => ({
      mode: 'daily',
      currentDate: new Date(),
      currentDateBySpace: {},
      modeBySpace: {},
      scrollToDate: null,
      scrollToPanel: null,
      setMode: (mode) =>
        set((state) => journalSlice.applyActive(state, { date: state.currentDate, mode })),
      setCurrentDate: (date) =>
        set((state) => journalSlice.applyActive(state, { date, mode: state.mode })),
      navigateToDate: (date, mode) =>
        set((state) => journalSlice.applyActive(state, { date, mode })),
      goToDateAndScroll: (date, scrollTarget) =>
        set((state) => ({
          ...journalSlice.applyActive(state, { date, mode: state.mode }),
          scrollToDate: scrollTarget,
        })),
      goToDateAndPanel: (date, panel) =>
        set((state) => ({
          ...journalSlice.applyActive(state, { date, mode: 'daily' }),
          scrollToPanel: panel,
        })),
      goToToday: () => {
        const { mode, navigateToDate, goToDateAndScroll, setCurrentDate } = get()
        const today = new Date()
        if (mode === 'agenda' || mode === 'stream') navigateToDate(today, 'daily')
        else if (mode === 'weekly' || mode === 'monthly') goToDateAndScroll(today, dateToISO(today))
        else setCurrentDate(today)
      },
      clearScrollTarget: () => set({ scrollToDate: null, scrollToPanel: null }),
    }),
    {
      name: 'agaric:journal',
      version: 1,
      storage: safePersistStorage,
      // Only the slices persist: the flat fields are their derived mirror, and
      // a `Date` does not survive JSON.
      partialize: (state) => ({
        currentDateBySpace: state.currentDateBySpace,
        modeBySpace: state.modeBySpace,
      }),
      // Both coerce: zustand calls `migrate` only on a version mismatch and
      // hands a same-version blob straight to `merge` (#823). Without
      // `migrate`, a version bump would discard every space's date and mode.
      migrate: (persisted, _version) => coercePersistedJournal(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...coercePersistedJournal(persisted),
      }),
    },
  ),
)

/**
 * The space-change reconcile, exported because its first-fire path runs once
 * at import and is otherwise unreachable from tests.
 */
export const reconcileJournalOnSpaceChange = journalSlice.attach(useJournalStore)
