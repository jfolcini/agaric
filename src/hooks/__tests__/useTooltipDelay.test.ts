import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getTooltipDelayMs, TOOLTIP_DELAY_MS, useTooltipDelay } from '@/hooks/useTooltipDelay'

const KEY = 'agaric-tooltip-delay'

function reset() {
  localStorage.clear()
}

beforeEach(() => {
  reset()
  vi.clearAllMocks()
})

afterEach(reset)

describe('TOOLTIP_DELAY_MS', () => {
  it('maps each enum choice to its documented ms value', () => {
    expect(TOOLTIP_DELAY_MS.instant).toBe(0)
    expect(TOOLTIP_DELAY_MS.fast).toBe(150)
    expect(TOOLTIP_DELAY_MS.default).toBe(300)
  })
})

describe('useTooltipDelay', () => {
  it('defaults to "default" / 300ms (no-change baseline)', () => {
    const { result } = renderHook(() => useTooltipDelay())
    expect(result.current.tooltipDelay).toBe('default')
    expect(result.current.delayMs).toBe(300)
  })

  it('reads a stored value from localStorage and resolves its ms value', () => {
    localStorage.setItem(KEY, 'fast')
    const { result } = renderHook(() => useTooltipDelay())
    expect(result.current.tooltipDelay).toBe('fast')
    expect(result.current.delayMs).toBe(150)
  })

  it('falls back to "default" for an unknown stored value', () => {
    localStorage.setItem(KEY, 'glacial')
    const { result } = renderHook(() => useTooltipDelay())
    expect(result.current.tooltipDelay).toBe('default')
    expect(result.current.delayMs).toBe(300)
  })

  it('setTooltipDelay persists the choice and updates the resolved ms value', () => {
    const { result } = renderHook(() => useTooltipDelay())
    act(() => result.current.setTooltipDelay('instant'))
    expect(result.current.tooltipDelay).toBe('instant')
    expect(result.current.delayMs).toBe(0)
    expect(localStorage.getItem(KEY)).toBe('instant')
  })
})

describe('getTooltipDelayMs', () => {
  it('returns the default (300) when nothing is stored', () => {
    expect(getTooltipDelayMs()).toBe(300)
  })

  it('returns the resolved ms value for a valid stored preference', () => {
    localStorage.setItem(KEY, 'instant')
    expect(getTooltipDelayMs()).toBe(0)
  })

  it('falls back to the default for an invalid stored preference', () => {
    localStorage.setItem(KEY, 'nonsense')
    expect(getTooltipDelayMs()).toBe(300)
  })
})
