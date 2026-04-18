/**
 * Tests for useTheme hook.
 *
 * Validates:
 *  - Theme cycling: auto → dark → light → auto
 *  - localStorage persistence
 *  - .dark class applied to document.documentElement
 *  - System dark mode respected in auto mode
 *  - UX-203: VSCode-inspired themes (solarized-light, solarized-dark, dracula, one-dark-pro)
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTheme } from '../useTheme'

// Mock matchMedia
let mockDarkQuery = false
const mockAddEventListener = vi.fn()
const mockRemoveEventListener = vi.fn()

/** All theme-related CSS classes the hook may add or remove. */
const ALL_THEME_CLASSES = [
  'dark',
  'theme-solarized-light',
  'theme-solarized-dark',
  'theme-dracula',
  'theme-one-dark-pro',
]

beforeEach(() => {
  vi.clearAllMocks()
  mockDarkQuery = false
  localStorage.clear()
  for (const cls of ALL_THEME_CLASSES) document.documentElement.classList.remove(cls)

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
  for (const cls of ALL_THEME_CLASSES) document.documentElement.classList.remove(cls)
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

    // light(light) → auto would be a no-op (both light with system=light), so skip to dark
    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('dark')
    expect(result.current.isDark).toBe(true)
  })

  // ── UX-203: VSCode-inspired themes ─────────────────────────────────

  describe('setTheme', () => {
    it('sets theme to solarized-light and applies correct classes', () => {
      const { result } = renderHook(() => useTheme())

      act(() => result.current.setTheme('solarized-light'))

      expect(result.current.theme).toBe('solarized-light')
      expect(result.current.isDark).toBe(false)
      const cls = document.documentElement.classList
      expect(cls.contains('theme-solarized-light')).toBe(true)
      expect(cls.contains('dark')).toBe(false)
      expect(cls.contains('theme-solarized-dark')).toBe(false)
      expect(cls.contains('theme-dracula')).toBe(false)
      expect(cls.contains('theme-one-dark-pro')).toBe(false)
    })

    it('sets theme to solarized-dark and applies .dark + theme-solarized-dark', () => {
      const { result } = renderHook(() => useTheme())

      act(() => result.current.setTheme('solarized-dark'))

      expect(result.current.theme).toBe('solarized-dark')
      expect(result.current.isDark).toBe(true)
      const cls = document.documentElement.classList
      expect(cls.contains('dark')).toBe(true)
      expect(cls.contains('theme-solarized-dark')).toBe(true)
      expect(cls.contains('theme-solarized-light')).toBe(false)
      expect(cls.contains('theme-dracula')).toBe(false)
      expect(cls.contains('theme-one-dark-pro')).toBe(false)
    })

    it('sets theme to dracula and applies .dark + theme-dracula', () => {
      const { result } = renderHook(() => useTheme())

      act(() => result.current.setTheme('dracula'))

      expect(result.current.theme).toBe('dracula')
      expect(result.current.isDark).toBe(true)
      const cls = document.documentElement.classList
      expect(cls.contains('dark')).toBe(true)
      expect(cls.contains('theme-dracula')).toBe(true)
      expect(cls.contains('theme-solarized-dark')).toBe(false)
      expect(cls.contains('theme-solarized-light')).toBe(false)
      expect(cls.contains('theme-one-dark-pro')).toBe(false)
    })

    it('sets theme to one-dark-pro and applies .dark + theme-one-dark-pro', () => {
      const { result } = renderHook(() => useTheme())

      act(() => result.current.setTheme('one-dark-pro'))

      expect(result.current.theme).toBe('one-dark-pro')
      expect(result.current.isDark).toBe(true)
      const cls = document.documentElement.classList
      expect(cls.contains('dark')).toBe(true)
      expect(cls.contains('theme-one-dark-pro')).toBe(true)
      expect(cls.contains('theme-dracula')).toBe(false)
      expect(cls.contains('theme-solarized-dark')).toBe(false)
      expect(cls.contains('theme-solarized-light')).toBe(false)
    })

    it('persists the chosen theme to localStorage', () => {
      const { result } = renderHook(() => useTheme())

      act(() => result.current.setTheme('dracula'))
      expect(localStorage.getItem('theme-preference')).toBe('dracula')

      act(() => result.current.setTheme('solarized-light'))
      expect(localStorage.getItem('theme-preference')).toBe('solarized-light')

      act(() => result.current.setTheme('one-dark-pro'))
      expect(localStorage.getItem('theme-preference')).toBe('one-dark-pro')
    })

    it('rereads persisted custom theme on mount', () => {
      localStorage.setItem('theme-preference', 'dracula')
      const { result } = renderHook(() => useTheme())
      expect(result.current.theme).toBe('dracula')
      expect(result.current.isDark).toBe(true)
      expect(document.documentElement.classList.contains('theme-dracula')).toBe(true)
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })

    it('removes prior theme classes when switching themes', () => {
      const { result } = renderHook(() => useTheme())

      act(() => result.current.setTheme('dracula'))
      expect(document.documentElement.classList.contains('theme-dracula')).toBe(true)

      act(() => result.current.setTheme('solarized-light'))
      // Dracula class must be removed when switching to Solarized Light
      expect(document.documentElement.classList.contains('theme-dracula')).toBe(false)
      expect(document.documentElement.classList.contains('dark')).toBe(false)
      expect(document.documentElement.classList.contains('theme-solarized-light')).toBe(true)
    })

    it('setting same theme is a no-op (no re-render, no extra writes)', () => {
      localStorage.setItem('theme-preference', 'dracula')
      const { result } = renderHook(() => useTheme())
      expect(result.current.theme).toBe('dracula')

      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
      act(() => result.current.setTheme('dracula'))
      expect(setItemSpy).not.toHaveBeenCalled()
      setItemSpy.mockRestore()
    })

    it('returning from custom dark theme to light via setTheme strips .dark', () => {
      const { result } = renderHook(() => useTheme())

      act(() => result.current.setTheme('one-dark-pro'))
      expect(document.documentElement.classList.contains('dark')).toBe(true)

      act(() => result.current.setTheme('light'))
      expect(document.documentElement.classList.contains('dark')).toBe(false)
      expect(document.documentElement.classList.contains('theme-one-dark-pro')).toBe(false)
    })
  })

  describe('readPreference validates stored value', () => {
    it('accepts solarized-light', () => {
      localStorage.setItem('theme-preference', 'solarized-light')
      const { result } = renderHook(() => useTheme())
      expect(result.current.theme).toBe('solarized-light')
    })

    it('accepts solarized-dark', () => {
      localStorage.setItem('theme-preference', 'solarized-dark')
      const { result } = renderHook(() => useTheme())
      expect(result.current.theme).toBe('solarized-dark')
    })

    it('accepts dracula', () => {
      localStorage.setItem('theme-preference', 'dracula')
      const { result } = renderHook(() => useTheme())
      expect(result.current.theme).toBe('dracula')
    })

    it('accepts one-dark-pro', () => {
      localStorage.setItem('theme-preference', 'one-dark-pro')
      const { result } = renderHook(() => useTheme())
      expect(result.current.theme).toBe('one-dark-pro')
    })
  })

  describe('toggleTheme from a custom theme re-enters the classic cycle', () => {
    it('toggling from solarized-dark moves to a non-dark classic state', () => {
      mockDarkQuery = false
      localStorage.setItem('theme-preference', 'solarized-dark')
      const { result } = renderHook(() => useTheme())
      expect(result.current.isDark).toBe(true)

      act(() => result.current.toggleTheme())
      // prev is solarized-dark (dark). Classic cycle index is -1; first candidate
      // is 'auto' (system=light → light) which differs in isDark, so we land there.
      expect(result.current.theme).toBe('auto')
      expect(result.current.isDark).toBe(false)
      expect(document.documentElement.classList.contains('dark')).toBe(false)
      expect(document.documentElement.classList.contains('theme-solarized-dark')).toBe(false)
    })

    it('toggling from dracula (dark) lands on a non-dark classic state', () => {
      mockDarkQuery = false
      localStorage.setItem('theme-preference', 'dracula')
      const { result } = renderHook(() => useTheme())
      expect(result.current.isDark).toBe(true)

      act(() => result.current.toggleTheme())
      expect(result.current.isDark).toBe(false)
      expect(document.documentElement.classList.contains('theme-dracula')).toBe(false)
    })

    it('toggling from solarized-light (light) lands on a dark classic state', () => {
      mockDarkQuery = false
      localStorage.setItem('theme-preference', 'solarized-light')
      const { result } = renderHook(() => useTheme())
      expect(result.current.isDark).toBe(false)

      act(() => result.current.toggleTheme())
      expect(result.current.isDark).toBe(true)
      expect(document.documentElement.classList.contains('theme-solarized-light')).toBe(false)
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })
  })
})
