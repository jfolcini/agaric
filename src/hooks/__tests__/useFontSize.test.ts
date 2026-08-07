import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyFontSize, FONT_SIZE_PX, useFontSize } from '@/hooks/useFontSize'

const KEY = 'agaric-font-size'

function reset() {
  localStorage.clear()
  document.documentElement.style.removeProperty('--agaric-font-size')
}

beforeEach(() => {
  reset()
  vi.clearAllMocks()
})

afterEach(reset)

describe('applyFontSize', () => {
  it('maps every preference to its documented pixel value', () => {
    expect(FONT_SIZE_PX).toEqual({ small: '14px', medium: '16px', large: '18px' })

    applyFontSize('small')
    expect(document.documentElement.style.getPropertyValue('--agaric-font-size')).toBe('14px')
    applyFontSize('medium')
    expect(document.documentElement.style.getPropertyValue('--agaric-font-size')).toBe('16px')
    applyFontSize('large')
    expect(document.documentElement.style.getPropertyValue('--agaric-font-size')).toBe('18px')
  })
})

describe('useFontSize', () => {
  it('defaults to medium and applies 16px', () => {
    const { result } = renderHook(() => useFontSize())

    expect(result.current.fontSize).toBe('medium')
    expect(document.documentElement.style.getPropertyValue('--agaric-font-size')).toBe('16px')
  })

  it('reads and applies a stored preference', () => {
    localStorage.setItem(KEY, 'large')
    const { result } = renderHook(() => useFontSize())

    expect(result.current.fontSize).toBe('large')
    expect(document.documentElement.style.getPropertyValue('--agaric-font-size')).toBe('18px')
  })

  it('falls back to medium for an unknown stored value', () => {
    localStorage.setItem(KEY, 'huge')
    const { result } = renderHook(() => useFontSize())

    expect(result.current.fontSize).toBe('medium')
    expect(document.documentElement.style.getPropertyValue('--agaric-font-size')).toBe('16px')
  })

  it('persists and applies changes', () => {
    const { result } = renderHook(() => useFontSize())

    act(() => result.current.setFontSize('small'))

    expect(result.current.fontSize).toBe('small')
    expect(localStorage.getItem(KEY)).toBe('small')
    expect(document.documentElement.style.getPropertyValue('--agaric-font-size')).toBe('14px')
  })
})
