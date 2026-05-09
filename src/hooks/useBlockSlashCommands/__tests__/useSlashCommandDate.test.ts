/**
 * Date-related slash commands. Each handler opens the date picker in a
 * specific mode and parks the editor cursor (when present) so the picker
 * can re-anchor after close.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSlashCommandDate } from '../useSlashCommandDate'
import { makeSyntheticCtx } from './test-utils'

vi.mock('../../../lib/announcer', () => ({ announce: vi.fn() }))
vi.mock('../../../lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe('useSlashCommandDate', () => {
  it('opens picker in `date` mode for /date', () => {
    const { result } = renderHook(() => useSlashCommandDate())
    const { ctx, setDatePickerMode, setDatePickerOpen } = makeSyntheticCtx()

    result.current.exact['date']?.(ctx, { id: 'date', label: 'DATE' })

    expect(setDatePickerMode).toHaveBeenCalledWith('date')
    expect(setDatePickerOpen).toHaveBeenCalledWith(true)
  })

  it('opens picker in `due` mode for /due', () => {
    const { result } = renderHook(() => useSlashCommandDate())
    const { ctx, setDatePickerMode, setDatePickerOpen } = makeSyntheticCtx()

    result.current.exact['due']?.(ctx, { id: 'due', label: 'DUE' })

    expect(setDatePickerMode).toHaveBeenCalledWith('due')
    expect(setDatePickerOpen).toHaveBeenCalledWith(true)
  })

  it('opens picker in `schedule` mode for /schedule', () => {
    const { result } = renderHook(() => useSlashCommandDate())
    const { ctx, setDatePickerMode, setDatePickerOpen } = makeSyntheticCtx()

    result.current.exact['schedule']?.(ctx, { id: 'schedule', label: 'SCHEDULED' })

    expect(setDatePickerMode).toHaveBeenCalledWith('schedule')
    expect(setDatePickerOpen).toHaveBeenCalledWith(true)
  })

  it('opens picker in `repeat-until` mode for /repeat-until', () => {
    const { result } = renderHook(() => useSlashCommandDate())
    const { ctx, setDatePickerMode, setDatePickerOpen } = makeSyntheticCtx()

    result.current.exact['repeat-until']?.(ctx, { id: 'repeat-until', label: 'REPEAT UNTIL' })

    expect(setDatePickerMode).toHaveBeenCalledWith('repeat-until')
    expect(setDatePickerOpen).toHaveBeenCalledWith(true)
  })

  it('exposes exactly the four date commands and no prefix entries', () => {
    const { result } = renderHook(() => useSlashCommandDate())
    expect(Object.keys(result.current.exact).sort()).toEqual(
      ['date', 'due', 'repeat-until', 'schedule'].sort(),
    )
    expect(result.current.prefix).toEqual([])
  })

  it('returns a stable table identity across rerenders', () => {
    const { result, rerender } = renderHook(() => useSlashCommandDate())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
