/**
 * Tests for src/hooks/useAgendaPreferences.ts — localStorage persistence
 * for agenda groupBy/sortBy preferences.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgendaPreferences } from '../useAgendaPreferences'

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('useAgendaPreferences', () => {
  describe('defaults', () => {
    it('returns groupBy=date when localStorage is empty', () => {
      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.groupBy).toBe('date')
    })

    it('returns sortBy=date when localStorage is empty', () => {
      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.sortBy).toBe('date')
    })
  })

  describe('read from localStorage', () => {
    it('reads stored groupBy value', () => {
      localStorage.setItem('agaric:agenda:groupBy', 'priority')
      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.groupBy).toBe('priority')
    })

    it('reads stored sortBy value', () => {
      localStorage.setItem('agaric:agenda:sortBy', 'state')
      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.sortBy).toBe('state')
    })

    it('reads groupBy=state', () => {
      localStorage.setItem('agaric:agenda:groupBy', 'state')
      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.groupBy).toBe('state')
    })

    it('reads groupBy=none', () => {
      localStorage.setItem('agaric:agenda:groupBy', 'none')
      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.groupBy).toBe('none')
    })

    it('reads sortBy=priority', () => {
      localStorage.setItem('agaric:agenda:sortBy', 'priority')
      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.sortBy).toBe('priority')
    })
  })

  describe('invalid stored values', () => {
    it('falls back to default groupBy for invalid stored value', () => {
      localStorage.setItem('agaric:agenda:groupBy', 'invalid')
      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.groupBy).toBe('date')
    })

    it('falls back to default sortBy for invalid stored value', () => {
      localStorage.setItem('agaric:agenda:sortBy', 'invalid')
      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.sortBy).toBe('date')
    })

    it('falls back to default groupBy for empty string', () => {
      localStorage.setItem('agaric:agenda:groupBy', '')
      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.groupBy).toBe('date')
    })

    it('falls back to default sortBy for none (not valid for sortBy)', () => {
      localStorage.setItem('agaric:agenda:sortBy', 'none')
      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.sortBy).toBe('date')
    })
  })

  describe('write to localStorage', () => {
    it('persists groupBy changes', () => {
      const { result } = renderHook(() => useAgendaPreferences())

      act(() => {
        result.current.setGroupBy('state')
      })

      expect(result.current.groupBy).toBe('state')
      expect(localStorage.getItem('agaric:agenda:groupBy')).toBe('state')
    })

    it('persists sortBy changes', () => {
      const { result } = renderHook(() => useAgendaPreferences())

      act(() => {
        result.current.setSortBy('priority')
      })

      expect(result.current.sortBy).toBe('priority')
      expect(localStorage.getItem('agaric:agenda:sortBy')).toBe('priority')
    })

    it('persists groupBy=none', () => {
      const { result } = renderHook(() => useAgendaPreferences())

      act(() => {
        result.current.setGroupBy('none')
      })

      expect(localStorage.getItem('agaric:agenda:groupBy')).toBe('none')
    })
  })

  describe('localStorage error handling', () => {
    it('returns defaults when getItem throws', () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('access denied')
      })

      const { result } = renderHook(() => useAgendaPreferences())
      expect(result.current.groupBy).toBe('date')
      expect(result.current.sortBy).toBe('date')

      spy.mockRestore()
    })

    it('does not throw when setItem throws', () => {
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded')
      })

      const { result } = renderHook(() => useAgendaPreferences())

      // Should not throw
      act(() => {
        result.current.setGroupBy('priority')
      })

      // State should still update in React
      expect(result.current.groupBy).toBe('priority')

      spy.mockRestore()
    })
  })
})
