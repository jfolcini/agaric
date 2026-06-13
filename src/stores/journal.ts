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

import { activeSpaceKey } from '../lib/active-space'
import { createSpaceSubscriber } from '../lib/createSpaceSubscriber'

export type JournalMode = 'daily' | 'weekly' | 'monthly' | 'agenda'
export type JournalPanel = 'due' | 'references' | 'done'

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
export function parseISODate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  // FE-L-6: validate components BEFORE constructing the Date — `new Date(2026, 12, 45)`
  // silently wraps to 2027-02-14, and `Number.isNaN(date.getTime())` doesn't catch it.
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(year, month - 1, day)
  // Catch day-overflow wrap (e.g. Feb 30 → Mar 2).
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

const JOURNAL_MODES: ReadonlySet<string> = new Set<JournalMode>([
  'daily',
  'weekly',
  'monthly',
  'agenda',
])

/**
 * CR-PERSIST — coerce a persisted value into a `Record<string, string>` of
 * ISO `YYYY-MM-DD` dates, dropping any entry whose value isn't a valid
 * calendar date. `localStorage` can hold anything (manual edits, a corrupt
 * write, a future-shape downgrade); validating on read keeps a malformed
 * blob from poisoning the date selectors.
 */
function coerceDateBySpace(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && parseISODate(value) !== null) out[key] = value
  }
  return out
}

/** CR-PERSIST — coerce a persisted value into a `Record<string, JournalMode>`. */
function coerceModeBySpace(raw: unknown): Record<string, JournalMode> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, JournalMode> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && JOURNAL_MODES.has(value)) out[key] = value as JournalMode
  }
  return out
}

/**
 * CR-PERSIST (#823) — coerce an entire persisted journal blob
 * field-by-field. Shared by `migrate` (version-mismatched blobs) and
 * `merge` (same-version blobs): zustand's persist middleware only calls
 * `migrate` when the stored version DIFFERS from `options.version`, so a
 * corrupt blob that still carries `version: 1` (or a non-numeric version)
 * bypasses `migrate` entirely and reaches the default shallow `merge` raw —
 * coercing in `merge` as well closes that path. The coercion is idempotent,
 * so the migrate→merge double pass on version-mismatched blobs is harmless.
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
      // CR-PERSIST — coercing migrate. Without it, a future `version: 2`
      // bump makes zustand's persist middleware feed `undefined` to
      // `merge`, silently discarding the persisted blob to defaults — the
      // user loses every space's last-active date and mode. It also runs
      // on any legacy/version-mismatched blob, dropping entries with
      // invalid dates / unknown modes so a corrupt payload can't poison
      // the rehydrate path.
      //
      // CR-PERSIST (#823): the field-by-field coercion is shared with
      // `merge` below. zustand only invokes `migrate` on a version
      // MISMATCH — same-version blobs are coerced by `merge`.
      migrate: (persisted, _version) => coercePersistedJournal(persisted),
      // CR-PERSIST (#823) — zustand skips `migrate` when the stored
      // version equals `options.version` (or isn't a number), handing the
      // raw blob straight to `merge`. Coerce here too so a corrupt
      // `localStorage` payload that still says `version: 1` (e.g. an
      // invalid-calendar-date string, an unknown mode) can't poison the
      // date / mode selectors on rehydrate.
      merge: (persisted, current) => ({
        ...current,
        ...coercePersistedJournal(persisted),
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
// MAINT-122: subscription mechanics + diff detection live in
// `createSpaceSubscriber`; this site only owns the journal-specific
// flush / pull logic. On first fire (`prevKey === newKey`) we pull the
// active-space slice into the flat fields so a returning user lands on
// the same date + mode they last had in their active space, even
// though the flat fields were not persisted.
createSpaceSubscriber((prevKey, newKey) => {
  const journal = useJournalStore.getState()
  if (prevKey === newKey) {
    // First fire after boot — pull the active-space slice into the flat
    // fields if it exists. If not, leave the defaults (today + daily)
    // and seed the slice so the next space switch can flush cleanly.
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
    return
  }

  // 1. Flush outgoing.
  const flushedDateBySpace = {
    ...journal.currentDateBySpace,
    [prevKey]: dateToISO(journal.currentDate),
  }
  const flushedModeBySpace = {
    ...journal.modeBySpace,
    [prevKey]: journal.mode,
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
})
