/**
 * Tests for useDateInput hook.
 *
 * Validates:
 *  - Initial state: dateInput, datePreview, dateError
 *  - handleChange updates dateInput and computes datePreview
 *  - handleChange shows preview for ISO dates
 *  - handleChange shows preview for NL dates (e.g. "tomorrow")
 *  - handleChange sets datePreview to null for invalid input
 *  - handleChange clears dateError
 *  - handleBlur with empty input calls onSave('')
 *  - handleBlur with valid ISO calls onSave(isoDate)
 *  - handleBlur with valid NL calls onSave(parsed) and updates dateInput
 *  - handleBlur with invalid NL sets dateError=true, does not call onSave
 *  - handleBlur clears datePreview
 *  - Re-syncs when initialValue changes
 *  - Works without onSave (DateChipEditor pattern)
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDate } from '../../lib/parse-date'
import { useDateInput } from '../useDateInput'

// Mock parseDate to make tests deterministic
vi.mock('../../lib/parse-date', () => ({
  parseDate: vi.fn((input: string) => {
    const lower = input.trim().toLowerCase()
    if (lower === 'tomorrow') return '2025-07-02'
    if (lower === 'today') return '2025-07-01'
    if (lower === 'next week') return '2025-07-08'
    return null
  }),
}))

const mockedParseDate = vi.mocked(parseDate)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Flush the 300ms debounce inside an act() block. */
function flushDebounce() {
  act(() => {
    vi.advanceTimersByTime(301)
  })
}

function makeChangeEvent(value: string) {
  return { target: { value } } as React.ChangeEvent<HTMLInputElement>
}

describe('useDateInput initial state', () => {
  it('has empty dateInput by default', () => {
    const { result } = renderHook(() => useDateInput())
    expect(result.current.dateInput).toBe('')
  })

  it('uses initialValue when provided', () => {
    const { result } = renderHook(() => useDateInput({ initialValue: '2025-06-15' }))
    expect(result.current.dateInput).toBe('2025-06-15')
  })

  it('datePreview is null initially', () => {
    const { result } = renderHook(() => useDateInput())
    expect(result.current.datePreview).toBeNull()
  })

  it('dateError is false initially', () => {
    const { result } = renderHook(() => useDateInput())
    expect(result.current.dateError).toBe(false)
  })
})

describe('useDateInput handleChange', () => {
  it('updates dateInput with the new value', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.handleChange(makeChangeEvent('hello'))
    })

    expect(result.current.dateInput).toBe('hello')
  })

  it('sets datePreview for valid ISO dates', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.handleChange(makeChangeEvent('2025-04-15'))
    })

    expect(result.current.datePreview).toBe('2025-04-15')
  })

  it('sets datePreview for NL dates via parseDate (after debounce)', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.handleChange(makeChangeEvent('tomorrow'))
    })

    // Debounced — no preview yet
    expect(result.current.datePreview).toBeNull()
    expect(mockedParseDate).not.toHaveBeenCalled()

    flushDebounce()

    expect(mockedParseDate).toHaveBeenCalledWith('tomorrow')
    expect(result.current.datePreview).toBe('2025-07-02')
  })

  it('does not call parseDate within 300ms of typing (debounce)', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.handleChange(makeChangeEvent('tomo'))
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    act(() => {
      result.current.handleChange(makeChangeEvent('tomor'))
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    act(() => {
      result.current.handleChange(makeChangeEvent('tomorrow'))
    })

    // Only 200ms total elapsed — no parse should have fired yet
    expect(mockedParseDate).not.toHaveBeenCalled()

    flushDebounce()

    // Single parse call after debounce settles, on the final value
    expect(mockedParseDate).toHaveBeenCalledTimes(1)
    expect(mockedParseDate).toHaveBeenCalledWith('tomorrow')
    expect(result.current.datePreview).toBe('2025-07-02')
  })

  it('keeps preview null for unparseable input (no stale errors during typing)', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.handleChange(makeChangeEvent('not a date'))
    })

    flushDebounce()

    // Parse failed — datePreview is not updated (stays null), no error flag
    expect(result.current.datePreview).toBeNull()
    expect(result.current.dateError).toBe(false)
  })

  it('clears datePreview when input is empty', () => {
    const { result } = renderHook(() => useDateInput())

    // First set a value (debounced)
    act(() => {
      result.current.handleChange(makeChangeEvent('tomorrow'))
    })
    flushDebounce()
    expect(result.current.datePreview).toBe('2025-07-02')

    // Then clear — preview clears synchronously
    act(() => {
      result.current.handleChange(makeChangeEvent(''))
    })
    expect(result.current.datePreview).toBeNull()
  })

  it('clears dateError on change', () => {
    const onSave = vi.fn()
    const { result } = renderHook(() => useDateInput({ onSave }))

    // First trigger an error via handleBlur with invalid input
    act(() => {
      result.current.handleChange(makeChangeEvent('not a date'))
    })
    act(() => {
      result.current.handleBlur()
    })
    expect(result.current.dateError).toBe(true)

    // Then type again — error should clear
    act(() => {
      result.current.handleChange(makeChangeEvent('t'))
    })
    expect(result.current.dateError).toBe(false)
  })
})

describe('useDateInput handleBlur', () => {
  it('calls onSave with empty string when input is empty', () => {
    const onSave = vi.fn()
    const { result } = renderHook(() => useDateInput({ onSave }))

    act(() => {
      result.current.handleBlur()
    })

    expect(onSave).toHaveBeenCalledWith('')
  })

  it('calls onSave with ISO date as-is', () => {
    const onSave = vi.fn()
    const { result } = renderHook(() => useDateInput({ initialValue: '2025-04-15', onSave }))

    act(() => {
      result.current.handleBlur()
    })

    expect(onSave).toHaveBeenCalledWith('2025-04-15')
  })

  it('calls onSave with parsed NL date and updates dateInput', () => {
    const onSave = vi.fn()
    const { result } = renderHook(() => useDateInput({ onSave }))

    act(() => {
      result.current.handleChange(makeChangeEvent('tomorrow'))
    })

    act(() => {
      result.current.handleBlur()
    })

    expect(onSave).toHaveBeenCalledWith('2025-07-02')
    expect(result.current.dateInput).toBe('2025-07-02')
  })

  it('sets dateError for invalid NL input and does not call onSave', () => {
    const onSave = vi.fn()
    const { result } = renderHook(() => useDateInput({ onSave }))

    act(() => {
      result.current.handleChange(makeChangeEvent('not a date'))
    })

    act(() => {
      result.current.handleBlur()
    })

    expect(result.current.dateError).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('clears datePreview on blur', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.handleChange(makeChangeEvent('tomorrow'))
    })
    flushDebounce()
    expect(result.current.datePreview).toBe('2025-07-02')

    act(() => {
      result.current.handleBlur()
    })
    expect(result.current.datePreview).toBeNull()
  })

  it('clears dateError on successful blur', () => {
    const onSave = vi.fn()
    const { result } = renderHook(() => useDateInput({ onSave }))

    // First set an error
    act(() => {
      result.current.handleChange(makeChangeEvent('bad'))
    })
    act(() => {
      result.current.handleBlur()
    })
    expect(result.current.dateError).toBe(true)

    // Then blur with a valid input
    act(() => {
      result.current.handleChange(makeChangeEvent('2025-01-01'))
    })
    act(() => {
      result.current.handleBlur()
    })
    expect(result.current.dateError).toBe(false)
    expect(onSave).toHaveBeenCalledWith('2025-01-01')
  })

  it('works without onSave (DateChipEditor pattern)', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.handleChange(makeChangeEvent('tomorrow'))
    })

    // Should not throw
    act(() => {
      result.current.handleBlur()
    })

    expect(result.current.dateInput).toBe('2025-07-02')
    expect(result.current.dateError).toBe(false)
  })
})

describe('useDateInput initialValue sync', () => {
  it('re-syncs dateInput when initialValue changes', () => {
    const { result, rerender } = renderHook(({ initialValue }) => useDateInput({ initialValue }), {
      initialProps: { initialValue: '2025-01-01' },
    })

    expect(result.current.dateInput).toBe('2025-01-01')

    rerender({ initialValue: '2025-06-15' })

    expect(result.current.dateInput).toBe('2025-06-15')
  })

  it('clears datePreview and dateError on re-sync', () => {
    const onSave = vi.fn()
    const { result, rerender } = renderHook(
      ({ initialValue }) => useDateInput({ initialValue, onSave }),
      { initialProps: { initialValue: '' } },
    )

    // Create some state
    act(() => {
      result.current.handleChange(makeChangeEvent('bad'))
    })
    act(() => {
      result.current.handleBlur()
    })
    expect(result.current.dateError).toBe(true)

    // Re-sync should clear it
    rerender({ initialValue: '2025-03-01' })

    expect(result.current.dateInput).toBe('2025-03-01')
    expect(result.current.datePreview).toBeNull()
    expect(result.current.dateError).toBe(false)
  })
})

describe('useDateInput setDateInput', () => {
  it('allows programmatic state changes', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.setDateInput('2025-12-25')
    })

    expect(result.current.dateInput).toBe('2025-12-25')
  })
})

// UX-12 — `isParsing` exposes the in-flight NL-parse debounce so callers
// can render a "parsing…" hint while the 300 ms timer is pending.
describe('useDateInput isParsing', () => {
  it('is false initially', () => {
    const { result } = renderHook(() => useDateInput())
    expect(result.current.isParsing).toBe(false)
  })

  it('flips to true while the NL debounce is pending and false after it fires', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.handleChange(makeChangeEvent('tomorrow'))
    })

    // Debounce timer is pending — the caller should be able to render
    // a "parsing…" indicator.
    expect(result.current.isParsing).toBe(true)

    flushDebounce()

    expect(result.current.isParsing).toBe(false)
    expect(result.current.datePreview).toBe('2025-07-02')
  })

  it('stays false for ISO input (no debounce path)', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.handleChange(makeChangeEvent('2025-04-15'))
    })

    // ISO is parsed synchronously — no debounce, no isParsing flicker.
    expect(result.current.isParsing).toBe(false)
    expect(result.current.datePreview).toBe('2025-04-15')
  })

  it('resets to false on blur even if a debounce was pending', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.handleChange(makeChangeEvent('tomorrow'))
    })
    expect(result.current.isParsing).toBe(true)

    act(() => {
      result.current.handleBlur()
    })

    expect(result.current.isParsing).toBe(false)
  })

  it('resets to false when the input is cleared mid-debounce', () => {
    const { result } = renderHook(() => useDateInput())

    act(() => {
      result.current.handleChange(makeChangeEvent('tomorrow'))
    })
    expect(result.current.isParsing).toBe(true)

    act(() => {
      result.current.handleChange(makeChangeEvent(''))
    })

    expect(result.current.isParsing).toBe(false)
  })
})
