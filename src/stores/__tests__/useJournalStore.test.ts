/**
 * FEAT-3p5 — per-space journal store tests.
 *
 * Verifies the `currentDateBySpace` / `modeBySpace` slices, the
 * `useSpaceStore` flush/pull subscriber, the rehydrate-after-deletion
 * fallback, and the persistence partialize round-trip. Mirrors the
 * `useNavigationStore` per-space tab tests (FEAT-3 Phase 3).
 *
 * The subscriber is module-scoped (registered when `journal.ts` first
 * imports), so each test must drive `useSpaceStore.setState` to fire it.
 * `prevSpaceKey` inside the subscriber is module-private and persists
 * across tests within the same vitest worker — tests that need to
 * observe the "first fire" behaviour deliberately don't reset it.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useJournalStore } from '../journal'
import { useSpaceStore } from '../space'

const PERSONAL = 'SPACE_PERSONAL'
const WORK = 'SPACE_WORK'

beforeEach(() => {
  // Reset both stores to clean defaults so tests don't observe leakage.
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(2026, 0, 1),
    currentDateBySpace: {},
    modeBySpace: {},
    scrollToDate: null,
    scrollToPanel: null,
  })
  useSpaceStore.setState({
    currentSpaceId: null,
    availableSpaces: [],
    isReady: false,
  })
  localStorage.clear()
})

describe('useJournalStore — per-space slices (FEAT-3p5)', () => {
  // ------------------------------------------------------------------
  // Slice update on action
  // ------------------------------------------------------------------

  it('setCurrentDate writes the active-space slice', () => {
    useSpaceStore.setState({ currentSpaceId: PERSONAL })
    const date = new Date(2026, 5, 15)
    useJournalStore.getState().setCurrentDate(date)

    const state = useJournalStore.getState()
    expect(state.currentDate).toEqual(date)
    expect(state.currentDateBySpace[PERSONAL]).toBe('2026-06-15')
  })

  it('setMode writes the active-space slice', () => {
    useSpaceStore.setState({ currentSpaceId: PERSONAL })
    useJournalStore.getState().setMode('weekly')

    const state = useJournalStore.getState()
    expect(state.mode).toBe('weekly')
    expect(state.modeBySpace[PERSONAL]).toBe('weekly')
  })

  it('navigateToDate writes both slices', () => {
    useSpaceStore.setState({ currentSpaceId: PERSONAL })
    useJournalStore.getState().navigateToDate(new Date(2026, 11, 25), 'monthly')

    const state = useJournalStore.getState()
    expect(state.currentDateBySpace[PERSONAL]).toBe('2026-12-25')
    expect(state.modeBySpace[PERSONAL]).toBe('monthly')
  })

  // ------------------------------------------------------------------
  // Space-switch subscriber: flush + pull
  // ------------------------------------------------------------------

  it('switching space flushes outgoing slice and pulls incoming slice', () => {
    // Start in Personal at 2026-04-15 + weekly.
    useSpaceStore.setState({ currentSpaceId: PERSONAL })
    useJournalStore.getState().navigateToDate(new Date(2026, 3, 15), 'weekly')

    // Pre-seed Work's slice (as if the user previously had it).
    useJournalStore.setState((s) => ({
      currentDateBySpace: { ...s.currentDateBySpace, [WORK]: '2025-12-01' },
      modeBySpace: { ...s.modeBySpace, [WORK]: 'monthly' },
    }))

    // Switch to Work.
    useSpaceStore.setState({ currentSpaceId: WORK })

    const state = useJournalStore.getState()
    // Outgoing flush: Personal slice still has the date we set.
    expect(state.currentDateBySpace[PERSONAL]).toBe('2026-04-15')
    expect(state.modeBySpace[PERSONAL]).toBe('weekly')
    // Incoming pull: flat fields reflect Work.
    expect(state.currentDateBySpace[WORK]).toBe('2025-12-01')
    expect(state.modeBySpace[WORK]).toBe('monthly')
    expect(state.currentDate.getFullYear()).toBe(2025)
    expect(state.currentDate.getMonth()).toBe(11)
    expect(state.currentDate.getDate()).toBe(1)
    expect(state.mode).toBe('monthly')
  })

  it('switching to a fresh space defaults to today + daily', () => {
    // Start in Personal with a non-default date.
    useSpaceStore.setState({ currentSpaceId: PERSONAL })
    useJournalStore.getState().navigateToDate(new Date(2026, 3, 15), 'weekly')

    // Switch to a Work that has never been visited — no slice yet.
    useSpaceStore.setState({ currentSpaceId: WORK })

    const state = useJournalStore.getState()
    expect(state.mode).toBe('daily')
    // Date defaults to today; we can't pin the exact day in a unit test
    // (CI clock varies), but the YYYY-MM-DD ISO of currentDate must
    // match what got seeded in the slice for Work.
    const todayISO = `${state.currentDate.getFullYear()}-${String(state.currentDate.getMonth() + 1).padStart(2, '0')}-${String(state.currentDate.getDate()).padStart(2, '0')}`
    expect(state.currentDateBySpace[WORK]).toBe(todayISO)
    expect(state.modeBySpace[WORK]).toBe('daily')
  })

  it('switching back restores the original space slice', () => {
    useSpaceStore.setState({ currentSpaceId: PERSONAL })
    useJournalStore.getState().navigateToDate(new Date(2026, 3, 15), 'weekly')

    useSpaceStore.setState({ currentSpaceId: WORK })
    useJournalStore.getState().navigateToDate(new Date(2025, 11, 1), 'monthly')

    // Swap back to Personal — flat fields must restore the original
    // 2026-04-15 weekly view.
    useSpaceStore.setState({ currentSpaceId: PERSONAL })

    const state = useJournalStore.getState()
    expect(state.mode).toBe('weekly')
    expect(state.currentDate.getFullYear()).toBe(2026)
    expect(state.currentDate.getMonth()).toBe(3) // April (0-indexed)
    expect(state.currentDate.getDate()).toBe(15)
  })

  it('rehydrate after a space deletion: stale slice id falls through to today + daily', () => {
    // Simulate a rehydrate-with-deleted-space scenario: persisted
    // slices contain a space id that no longer exists. Switching to
    // a different (or fresh) space must not crash and must default
    // to today + daily.
    useJournalStore.setState({
      currentDateBySpace: { DELETED_SPACE: '2024-01-01' },
      modeBySpace: { DELETED_SPACE: 'monthly' },
    })

    useSpaceStore.setState({ currentSpaceId: WORK })

    const state = useJournalStore.getState()
    // Work has no slice → falls back to today.
    expect(state.mode).toBe('daily')
    const todayISO = `${state.currentDate.getFullYear()}-${String(state.currentDate.getMonth() + 1).padStart(2, '0')}-${String(state.currentDate.getDate()).padStart(2, '0')}`
    expect(state.currentDateBySpace[WORK]).toBe(todayISO)
  })

  // ------------------------------------------------------------------
  // Persistence round-trip
  // ------------------------------------------------------------------

  it('persists per-space slices to localStorage (round-trip survives reload)', () => {
    useSpaceStore.setState({ currentSpaceId: PERSONAL })
    useJournalStore.getState().navigateToDate(new Date(2026, 5, 15), 'weekly')

    // Inspect the localStorage payload — zustand persist writes a JSON
    // blob keyed by the store's `name`. The `partialize` in the store
    // emits only the per-space slices.
    const raw = localStorage.getItem('agaric:journal')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string)
    expect(parsed.state.currentDateBySpace[PERSONAL]).toBe('2026-06-15')
    expect(parsed.state.modeBySpace[PERSONAL]).toBe('weekly')
    // The flat `currentDate` / `mode` fields are NOT persisted (they
    // are derived from the active slice on rehydrate).
    expect(parsed.state.currentDate).toBeUndefined()
    expect(parsed.state.mode).toBeUndefined()
  })

  it('mode set in space-A does not bleed into space-B', () => {
    // Space-A picks weekly, space-B keeps daily — switching back and
    // forth must not mutate the inactive space's mode.
    useSpaceStore.setState({ currentSpaceId: PERSONAL })
    useJournalStore.getState().setMode('weekly')

    useSpaceStore.setState({ currentSpaceId: WORK })
    // First time we visit Work, we get the default daily mode.
    expect(useJournalStore.getState().mode).toBe('daily')

    // Switch to monthly inside Work.
    useJournalStore.getState().setMode('monthly')

    useSpaceStore.setState({ currentSpaceId: PERSONAL })
    // Personal must still be weekly — Work's monthly didn't bleed back.
    expect(useJournalStore.getState().mode).toBe('weekly')

    useSpaceStore.setState({ currentSpaceId: WORK })
    expect(useJournalStore.getState().mode).toBe('monthly')
  })
})
