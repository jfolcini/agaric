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
import { useJournalStore } from '../journal'

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
})
