/**
 * Unit tests for useAppSpaceLifecycle (MAINT-124 step 4 stretch).
 *
 * Validates the three space-driven side-effects in isolation:
 * preload (FEAT-3p7), cross-space link enforcement (FEAT-3p7), and
 * visual identity (FEAT-3p10). Integration coverage of the App-level
 * wiring stays in `App.test.tsx`.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setWindowTitle } from '../../lib/tauri'
import { useResolveStore } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import { useAppSpaceLifecycle } from '../useAppSpaceLifecycle'

vi.mock('../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../lib/tauri')>('../../lib/tauri')
  return {
    ...actual,
    setWindowTitle: vi.fn().mockResolvedValue(undefined),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  document.documentElement.style.removeProperty('--accent-current')

  useSpaceStore.setState({
    currentSpaceId: 'SPACE_PERSONAL',
    availableSpaces: [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }],
    isReady: true,
  })
})

afterEach(() => {
  document.documentElement.style.removeProperty('--accent-current')
})

describe('useAppSpaceLifecycle — preload', () => {
  it('calls preload(currentSpaceId) on mount', () => {
    const preload = vi.spyOn(useResolveStore.getState(), 'preload')
    renderHook(() => useAppSpaceLifecycle())
    expect(preload).toHaveBeenCalledWith('SPACE_PERSONAL')
  })
})

describe('useAppSpaceLifecycle — cross-space link enforcement', () => {
  it('flushes the pages list on mount', () => {
    const clearPagesList = vi.spyOn(useResolveStore.getState(), 'clearPagesList')
    renderHook(() => useAppSpaceLifecycle())
    expect(clearPagesList).toHaveBeenCalled()
  })

  it('flushes the previous space cache when currentSpaceId changes', async () => {
    const clearAllForSpace = vi.spyOn(useResolveStore.getState(), 'clearAllForSpace')

    const { rerender } = renderHook(() => useAppSpaceLifecycle())
    expect(clearAllForSpace).not.toHaveBeenCalled()

    // Switch to a different space — the effect should observe the
    // change and flush the previous prefix.
    useSpaceStore.setState({ currentSpaceId: 'SPACE_WORK' })
    rerender()

    await waitFor(() => {
      expect(clearAllForSpace).toHaveBeenCalledWith('SPACE_PERSONAL')
    })
  })
})

describe('useAppSpaceLifecycle — visual identity', () => {
  it('sets --accent-current on mount', () => {
    renderHook(() => useAppSpaceLifecycle())
    expect(document.documentElement.style.getPropertyValue('--accent-current')).toBe(
      'var(--accent-emerald)',
    )
  })

  it('calls setWindowTitle with the active space name on mount', async () => {
    renderHook(() => useAppSpaceLifecycle())
    await waitFor(() => {
      expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith('Personal \u00b7 Agaric')
    })
  })

  it('falls back to plain "Agaric" when no space is active', async () => {
    useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [] })

    renderHook(() => useAppSpaceLifecycle())
    await waitFor(() => {
      expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith('Agaric')
    })
  })

  it('re-stamps the title and accent when the active space changes', async () => {
    useSpaceStore.setState({
      availableSpaces: [
        { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' },
        { id: 'SPACE_WORK', name: 'Work', accent_color: 'accent-blue' },
      ],
    })

    const { rerender } = renderHook(() => useAppSpaceLifecycle())
    await waitFor(() => {
      expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith('Personal \u00b7 Agaric')
    })
    vi.mocked(setWindowTitle).mockClear()

    useSpaceStore.setState({ currentSpaceId: 'SPACE_WORK' })
    rerender()

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--accent-current')).toBe(
        'var(--accent-blue)',
      )
    })
    await waitFor(() => {
      expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith('Work \u00b7 Agaric')
    })
  })
})
