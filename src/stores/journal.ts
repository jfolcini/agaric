/**
 * Journal store — shared state for the journal view (mode, date, pageMap).
 *
 * Used by both App.tsx (header controls) and JournalPage.tsx (content).
 *
 * Per-space slices for `currentDate` and `mode`.
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
 * (Phase 3, session 498).
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
  /**
   * Last-active date per space, keyed by space ULID. Stored
   * as `YYYY-MM-DD` strings so JSON persistence round-trips cleanly
   * (Date objects don't survive `JSON.stringify`).
   */
  currentDateBySpace: Record<string, string>
  /** last-active mode per space, keyed by space ULID. */
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
  'stream',
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

/**
 * #3322 — the per-space primitive owning `currentDateBySpace` / `modeBySpace`,
 * the derived flat `currentDate` / `mode` mirror, and the space-change
 * flush/pull reconcile. Journal used to hand-roll all three (five action
 * bodies each rewriting map and mirror as two independent object literals,
 * plus a 62-line bespoke `createSpaceSubscriber` reconcile) — exactly the
 * shape `createPerSpaceSlice` exists to own once, and exactly the shape whose
 * hand-rolling produced the two defects its doc comment cites. Routing the
 * writes through `applyActive` makes mirror-vs-slice drift unrepresentable:
 * there is no way to write one without the other.
 *
 * The slice unit is the `{ date, mode }` composite because the two fields
 * flush and pull together. It carries a real `Date` (not the ISO string the
 * map stores) so the mirror keeps the exact `Date` an action was handed —
 * `setSlice` narrows to `YYYY-MM-DD` for persistence, `getSlice` parses back
 * to a local-midnight `Date`, which is what the pull path always produced.
 *
 * `seedOnSwitch` preserves journal's long-standing divergence from the
 * primitive's default (see the option's doc): a fresh space's slice IS seeded
 * with today + `daily` so a later flush round-trips even if the user never
 * touches the view.
 */
const journalSlice = createPerSpaceSlice<JournalStore, { date: Date; mode: JournalMode }>({
  readMirror: (state) => ({ date: state.currentDate, mode: state.mode }),
  writeMirror: (value) => ({ currentDate: value.date, mode: value.mode }),
  getSlice: (state, key) => {
    const iso = state.currentDateBySpace[key]
    const mode = state.modeBySpace[key]
    // A slice counts as absent only when NEITHER field is stored. A blob that
    // carries just one (a partial coercion drop) keeps that field and takes
    // the fresh-space default for the other, rather than being discarded.
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
  // Transient scroll targets belong to the previous space's last navigation
  // and would confuse the incoming view.
  onSwitch: () => {
    useJournalStore.setState({ scrollToDate: null, scrollToPanel: null })
  },
})

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
      clearScrollTarget: () => set({ scrollToDate: null, scrollToPanel: null }),
    }),
    {
      name: 'agaric:journal',
      version: 1,
      storage: safePersistStorage,
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

/**
 * Flush the outgoing space's `{ date, mode }` into its slice and pull the
 * incoming space's slice into the flat mirror on a space change. The
 * flush/pull/first-fire logic lives in the shared `createPerSpaceSlice`
 * primitive (`journalSlice`); this is the wired reconcile callback,
 * re-exported because the module-level subscriber fires its first-fire path
 * once at import, so that path is otherwise unreachable from the test runtime
 * (same reason `recent-pages` re-exports its own).
 */
export const reconcileJournalOnSpaceChange = journalSlice.attach(useJournalStore)
