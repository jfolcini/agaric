/**
 * Tests for useTheme hook.
 *
 * Validates:
 *  - Theme cycling: auto → dark → light → auto
 *  - localStorage persistence
 *  - .dark class applied to document.documentElement
 *  - System dark mode respected in auto mode
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTheme } from '../useTheme'

// Mock matchMedia
let mockDarkQuery = false
const mockAddEventListener = vi.fn()
const mockRemoveEventListener = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockDarkQuery = false
  localStorage.clear()
  document.documentElement.classList.remove('dark')

  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? mockDarkQuery : false,
      media: query,
      addEventListener: mockAddEventListener,
      removeEventListener: mockRemoveEventListener,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})

describe('useTheme', () => {
  it('defaults to auto theme', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('auto')
  })

  it('reads initial theme from localStorage', () => {
    localStorage.setItem('theme-preference', 'dark')
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('dark')
    expect(result.current.isDark).toBe(true)
  })

  it('cycles with smart skip (system light: auto → dark → light → dark)', () => {
    // system=light, so auto resolves to light; skip states that don't change isDark
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('auto')

    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('dark')

    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('light')

    // light→auto would be a no-op (both light), so skip to dark
    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('dark')
  })

  it('persists theme choice to localStorage', () => {
    const { result } = renderHook(() => useTheme())

    act(() => result.current.toggleTheme())
    expect(localStorage.getItem('theme-preference')).toBe('dark')

    act(() => result.current.toggleTheme())
    expect(localStorage.getItem('theme-preference')).toBe('light')

    // light→auto skipped (both light with system=light), goes to dark
    act(() => result.current.toggleTheme())
    expect(localStorage.getItem('theme-preference')).toBe('dark')
  })

  it('applies .dark class when isDark is true', () => {
    localStorage.setItem('theme-preference', 'dark')
    renderHook(() => useTheme())
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('removes .dark class when isDark is false', () => {
    localStorage.setItem('theme-preference', 'light')
    renderHook(() => useTheme())
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('respects system dark mode when theme is auto', () => {
    mockDarkQuery = true
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('auto')
    expect(result.current.isDark).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('isDark is false in auto mode when system is light', () => {
    mockDarkQuery = false
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('auto')
    expect(result.current.isDark).toBe(false)
  })

  it('isDark is true when theme is dark regardless of system', () => {
    mockDarkQuery = false
    localStorage.setItem('theme-preference', 'dark')
    const { result } = renderHook(() => useTheme())
    expect(result.current.isDark).toBe(true)
  })

  it('isDark is false when theme is light regardless of system', () => {
    mockDarkQuery = true
    localStorage.setItem('theme-preference', 'light')
    const { result } = renderHook(() => useTheme())
    expect(result.current.isDark).toBe(false)
  })

  it('ignores invalid localStorage values', () => {
    localStorage.setItem('theme-preference', 'invalid-value')
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('auto')
  })

  it('skips dark when system is dark (auto → light)', () => {
    mockDarkQuery = true
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('auto')
    expect(result.current.isDark).toBe(true)

    // auto(dark) → dark would be a no-op, so skip to light
    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('light')
    expect(result.current.isDark).toBe(false)
  })

  it('skips auto when system is light (light → dark)', () => {
    mockDarkQuery = false
    localStorage.setItem('theme-preference', 'light')
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('light')
    expect(result.current.isDark).toBe(false)

    // light(light) → auto would be a no-op (both light), so skip to dark
    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('dark')
    expect(result.current.isDark).toBe(true)
  })
})
