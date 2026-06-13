/**
 * Tests for journal store — setMode, setCurrentDate, navigateToDate,
 * goToDateAndScroll, clearScrollTarget.
 *
 * Covers all five store actions and validates correct state isolation
 * (each action only touches its intended fields).
 *
 * FEAT-3p5 — also covers the per-space slices and the
 * `useSpaceStore` flush/pull subscriber. Per-space tests live in
 * `useJournalStore.test.ts` (separate file because they exercise the
 * subscriber side-effect, which needs careful isolation).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { parseISODate, useJournalStore } from '../journal'

beforeEach(() => {
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(2026, 0, 1),
    currentDateBySpace: {},
    modeBySpace: {},
    scrollToDate: null,
    scrollToPanel: null,
  })
})

describe('journal store', () => {
  it('scrollToDate defaults to null', () => {
    expect(useJournalStore.getState().scrollToDate).toBeNull()
  })

  // -- setMode --
  it('setMode updates the mode', () => {
    useJournalStore.getState().setMode('weekly')
    expect(useJournalStore.getState().mode).toBe('weekly')
  })

  it('setMode does not change currentDate or scrollToDate', () => {
    const dateBefore = useJournalStore.getState().currentDate
    useJournalStore.getState().setMode('monthly')
    expect(useJournalStore.getState().currentDate).toEqual(dateBefore)
    expect(useJournalStore.getState().scrollToDate).toBeNull()
  })

  // -- setCurrentDate --
  it('setCurrentDate updates the currentDate', () => {
    const newDate = new Date(2026, 5, 15)
    useJournalStore.getState().setCurrentDate(newDate)
    expect(useJournalStore.getState().currentDate).toEqual(newDate)
  })

  it('setCurrentDate does not change mode or scrollToDate', () => {
    useJournalStore.setState({ mode: 'weekly' })
    useJournalStore.getState().setCurrentDate(new Date(2026, 6, 1))
    expect(useJournalStore.getState().mode).toBe('weekly')
    expect(useJournalStore.getState().scrollToDate).toBeNull()
  })

  // -- navigateToDate --
  it('navigateToDate sets both currentDate and mode', () => {
    const newDate = new Date(2026, 11, 25)
    useJournalStore.getState().navigateToDate(newDate, 'monthly')
    const state = useJournalStore.getState()
    expect(state.currentDate).toEqual(newDate)
    expect(state.mode).toBe('monthly')
  })

  it('navigateToDate does not change scrollToDate', () => {
    useJournalStore.setState({ scrollToDate: '2026-01-01' })
    useJournalStore.getState().navigateToDate(new Date(), 'agenda')
    expect(useJournalStore.getState().scrollToDate).toBe('2026-01-01')
  })

  it('goToDateAndScroll sets currentDate and scrollToDate', () => {
    const target = new Date(2026, 2, 15)
    useJournalStore.getState().goToDateAndScroll(target, '2026-03-15')

    const state = useJournalStore.getState()
    expect(state.currentDate).toEqual(target)
    expect(state.scrollToDate).toBe('2026-03-15')
  })

  it('clearScrollTarget sets scrollToDate to null', () => {
    useJournalStore.setState({ scrollToDate: '2026-03-15' })
    expect(useJournalStore.getState().scrollToDate).toBe('2026-03-15')

    useJournalStore.getState().clearScrollTarget()
    expect(useJournalStore.getState().scrollToDate).toBeNull()
  })

  it('goToDateAndScroll followed by clearScrollTarget resets scrollToDate', () => {
    const target = new Date(2026, 5, 10)
    const { goToDateAndScroll, clearScrollTarget } = useJournalStore.getState()

    goToDateAndScroll(target, '2026-06-10')
    expect(useJournalStore.getState().scrollToDate).toBe('2026-06-10')

    clearScrollTarget()
    expect(useJournalStore.getState().scrollToDate).toBeNull()
    // currentDate should remain unchanged
    expect(useJournalStore.getState().currentDate).toEqual(target)
  })

  it('goToDateAndScroll does not change mode', () => {
    useJournalStore.setState({ mode: 'weekly' })
    const target = new Date(2026, 2, 31)

    useJournalStore.getState().goToDateAndScroll(target, '2026-03-31')

    expect(useJournalStore.getState().mode).toBe('weekly')
  })

  it('goToDateAndPanel sets currentDate, mode=daily, and scrollToPanel', () => {
    const target = new Date(2026, 5, 10)
    useJournalStore.getState().goToDateAndPanel(target, 'due')

    const state = useJournalStore.getState()
    expect(state.currentDate).toEqual(target)
    expect(state.mode).toBe('daily')
    expect(state.scrollToPanel).toBe('due')
  })

  it('clearScrollTarget clears both scrollToDate and scrollToPanel', () => {
    useJournalStore.setState({ scrollToDate: '2026-06-10', scrollToPanel: 'references' })
    useJournalStore.getState().clearScrollTarget()

    const state = useJournalStore.getState()
    expect(state.scrollToDate).toBeNull()
    expect(state.scrollToPanel).toBeNull()
  })

  // -- parseISODate (FE-L-6: reject wrap-around invalid dates) --
  it('parseISODate rejects out-of-range components (2026-13-45)', () => {
    expect(parseISODate('2026-13-45')).toBeNull()
  })

  it('parseISODate rejects day-overflow wrap (2026-02-30 → Mar 2)', () => {
    expect(parseISODate('2026-02-30')).toBeNull()
  })
})

// CR-PERSIST — coercing `migrate` seam. The migrate is the safety net for a
// future `version` bump (without it zustand silently discards the persisted
// blob to defaults, losing every space's last-active date/mode) and doubles
// as corruption defense for a malformed `localStorage` payload. Reached
// through the same public seam zustand uses on rehydrate.
describe('journal persist migrate', () => {
  const migrate = useJournalStore.persist.getOptions().migrate

  type PersistedJournal = {
    currentDateBySpace: Record<string, string>
    modeBySpace: Record<string, string>
  }
  const run = (blob: unknown): PersistedJournal => migrate?.(blob, 0) as PersistedJournal

  it('is wired into the persist options', () => {
    expect(typeof migrate).toBe('function')
  })

  it('returns empty slices for a null/undefined or non-object blob', () => {
    expect(run(undefined)).toEqual({ currentDateBySpace: {}, modeBySpace: {} })
    expect(run('corrupt')).toEqual({ currentDateBySpace: {}, modeBySpace: {} })
  })

  it('preserves valid per-space dates and modes', () => {
    const blob = {
      currentDateBySpace: { SPACE_A: '2026-05-25', SPACE_B: '2026-01-01' },
      modeBySpace: { SPACE_A: 'weekly', SPACE_B: 'agenda' },
    }
    expect(run(blob)).toEqual(blob)
  })

  it('drops entries with invalid calendar dates', () => {
    const result = run({
      currentDateBySpace: { OK: '2026-05-25', BAD: '2026-13-45', WRAP: '2026-02-30', X: 5 },
    })
    expect(result.currentDateBySpace).toEqual({ OK: '2026-05-25' })
  })

  it('drops entries with unknown journal modes', () => {
    const result = run({ modeBySpace: { OK: 'daily', BAD: 'yearly', X: 1 } })
    expect(result.modeBySpace).toEqual({ OK: 'daily' })
  })

  it('is idempotent — coercing an already-valid blob is a no-op', () => {
    const blob = {
      currentDateBySpace: { SPACE_A: '2026-05-25', SPACE_B: '2026-01-01' },
      modeBySpace: { SPACE_A: 'weekly', SPACE_B: 'agenda' },
    }
    const once = run(blob)
    const twice = run(once)
    expect(twice).toEqual(once)
    expect(once).toEqual(blob)
  })
})

// ---------------------------------------------------------------------------
// CR-PERSIST (#823) — coercing `merge`. zustand's persist middleware only
// invokes `migrate` when the stored version DIFFERS from `options.version`.
// A corrupt blob that still carries the CURRENT `version: 1` (or a
// non-numeric version) bypasses `migrate` entirely and is handed RAW to the
// default shallow `merge`, letting a malformed `localStorage` payload reach
// the date / mode selectors. The coercion therefore also lives in a custom
// `merge` — this block pins that seam (mirrors navigation.test.ts).
// ---------------------------------------------------------------------------
describe('journal persist merge (#823 — same-version blobs bypass migrate)', () => {
  const options = useJournalStore.persist.getOptions()
  const defaults = {
    currentDateBySpace: {},
    modeBySpace: {},
  } as unknown as Parameters<NonNullable<typeof options.merge>>[1]

  type MergedJournal = {
    currentDateBySpace: Record<string, string>
    modeBySpace: Record<string, string>
  }
  function mergeRun(blob: unknown): MergedJournal {
    return options.merge?.(blob, defaults) as unknown as MergedJournal
  }

  it('is wired into the persist options', () => {
    expect(typeof options.merge).toBe('function')
  })

  // The headline #823 case: a same-version (v1) blob carrying garbage
  // fields. Previously this flowed raw through the default shallow merge.
  it('coerces a corrupt same-version blob instead of passing it through', () => {
    const result = mergeRun({
      currentDateBySpace: { OK: '2026-05-25', BAD: '2026-13-45', WRAP: '2026-02-30', X: 5 },
      modeBySpace: { OK: 'daily', BAD: 'yearly', Y: 1 },
    })
    expect(result.currentDateBySpace).toEqual({ OK: '2026-05-25' })
    expect(result.modeBySpace).toEqual({ OK: 'daily' })
  })

  it('passes a well-formed blob through unchanged', () => {
    const blob = {
      currentDateBySpace: { SPACE_A: '2026-05-25' },
      modeBySpace: { SPACE_A: 'weekly' },
    }
    const result = mergeRun(blob)
    expect(result.currentDateBySpace).toEqual({ SPACE_A: '2026-05-25' })
    expect(result.modeBySpace).toEqual({ SPACE_A: 'weekly' })
  })

  it('falls back to empty slices when storage is empty (undefined persisted)', () => {
    const result = mergeRun(undefined)
    expect(result.currentDateBySpace).toEqual({})
    expect(result.modeBySpace).toEqual({})
  })

  it('does not throw on a wholly non-object blob', () => {
    expect(() => mergeRun('corrupt')).not.toThrow()
    expect(mergeRun('corrupt')).toMatchObject({ currentDateBySpace: {}, modeBySpace: {} })
  })

  // The corrupt-blob path actually demonstrated end-to-end: seed
  // localStorage with a same-version blob and rehydrate the live store.
  it('end-to-end: rehydrating a same-version corrupt blob repairs the store', () => {
    const STORAGE_KEY = 'agaric:journal'
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          currentDateBySpace: { OK: '2026-05-25', BAD: '2026-13-45' },
          modeBySpace: { OK: 'weekly', BAD: 'yearly' },
        },
        version: 1,
      }),
    )

    expect(() => useJournalStore.persist.rehydrate()).not.toThrow()

    const state = useJournalStore.getState()
    expect(state.currentDateBySpace).toEqual({ OK: '2026-05-25' })
    expect(state.modeBySpace).toEqual({ OK: 'weekly' })

    localStorage.removeItem(STORAGE_KEY)
  })
})
