/**
 * Tests for journal store — scrollToDate, goToDateAndScroll, clearScrollTarget.
 *
 * Validates the new scroll-to-today feature where clicking "Today" in
 * weekly/monthly mode sets both currentDate and a scroll target.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useJournalStore } from '../journal'

beforeEach(() => {
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(2026, 0, 1),
    scrollToDate: null,
  })
})

describe('journal store', () => {
  it('scrollToDate defaults to null', () => {
    expect(useJournalStore.getState().scrollToDate).toBeNull()
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
})
