import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_JOURNAL_DATE_FORMAT,
  getJournalDateFormat,
  useJournalDateFormat,
} from '../useJournalDateFormat'

const KEY = 'journal-date-format'

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  localStorage.clear()
})

describe('useJournalDateFormat', () => {
  it('defaults to the localized preset when no preference set (no-change baseline)', () => {
    const { result } = renderHook(() => useJournalDateFormat())
    expect(result.current.journalDateFormat).toBe('locale')
    expect(DEFAULT_JOURNAL_DATE_FORMAT).toBe('locale')
  })

  it('reads a stored preset from localStorage', () => {
    localStorage.setItem(KEY, 'MMMM d, yyyy')
    const { result } = renderHook(() => useJournalDateFormat())
    expect(result.current.journalDateFormat).toBe('MMMM d, yyyy')
  })

  it('falls back to the default preset for an unknown stored value', () => {
    localStorage.setItem(KEY, 'not-a-real-format')
    const { result } = renderHook(() => useJournalDateFormat())
    expect(result.current.journalDateFormat).toBe('locale')
  })

  it('setJournalDateFormat persists the chosen token to localStorage', () => {
    const { result } = renderHook(() => useJournalDateFormat())
    act(() => result.current.setJournalDateFormat('dd/MM/yyyy'))
    expect(localStorage.getItem(KEY)).toBe('dd/MM/yyyy')
  })

  it('re-reads via the synthetic storage event so the same-tab value updates', () => {
    const { result } = renderHook(() => useJournalDateFormat())
    act(() => result.current.setJournalDateFormat('EEE, MMM d'))
    expect(result.current.journalDateFormat).toBe('EEE, MMM d')
  })

  it('dispatches a fully populated StorageEvent on change', () => {
    localStorage.setItem(KEY, 'yyyy-MM-dd')
    const events: StorageEvent[] = []
    const listener = (e: StorageEvent) => events.push(e)
    window.addEventListener('storage', listener)
    try {
      const { result } = renderHook(() => useJournalDateFormat())
      act(() => result.current.setJournalDateFormat('dd/MM/yyyy'))
      expect(events).toHaveLength(1)
      const e = events[0]
      if (!e) throw new Error('no StorageEvent dispatched')
      expect(e.key).toBe(KEY)
      expect(e.oldValue).toBe('yyyy-MM-dd')
      expect(e.newValue).toBe('dd/MM/yyyy')
      expect(e.storageArea).toBe(window.localStorage)
    } finally {
      window.removeEventListener('storage', listener)
    }
  })

  it('degrades to a no-op (no throw, no event) when storage write throws', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const events: StorageEvent[] = []
    const listener = (e: StorageEvent) => events.push(e)
    window.addEventListener('storage', listener)
    try {
      const { result } = renderHook(() => useJournalDateFormat())
      expect(() => act(() => result.current.setJournalDateFormat('dd/MM/yyyy'))).not.toThrow()
      expect(events).toHaveLength(0)
    } finally {
      window.removeEventListener('storage', listener)
      spy.mockRestore()
    }
  })
})

describe('getJournalDateFormat', () => {
  it('returns the default preset when no preference set', () => {
    expect(getJournalDateFormat()).toBe('locale')
  })

  it('returns the stored preset', () => {
    localStorage.setItem(KEY, 'MMMM d, yyyy')
    expect(getJournalDateFormat()).toBe('MMMM d, yyyy')
  })

  it('returns the default without throwing when the storage read throws (render-path safety)', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    try {
      expect(() => getJournalDateFormat()).not.toThrow()
      expect(getJournalDateFormat()).toBe('locale')
    } finally {
      spy.mockRestore()
    }
  })
})
