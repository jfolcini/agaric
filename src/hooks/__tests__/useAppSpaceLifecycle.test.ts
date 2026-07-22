/**
 * Unit tests for useAppSpaceLifecycle (stretch).
 *
 * Validates the three space-driven side-effects in isolation:
 * Preload, cross-space link enforcement, and
 * Visual identity. Integration coverage of the App-level
 * wiring stays in `App.test.tsx`.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppSpaceLifecycle } from '@/hooks/useAppSpaceLifecycle'
import { setWindowTitle } from '@/lib/tauri'
import { useNavigationStore } from '@/stores/navigation'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri')
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
  // #2944 — the title now also reflects the active view/page, so pin
  // both to a known baseline ('journal', no open page) for every test
  // that doesn't explicitly exercise that behaviour. `currentViewBySpace`
  // is seeded for both fixture spaces too: switching `currentSpaceId`
  // fires `navigationSlice`'s own space-change reconcile (unrelated to
  // this hook), which defaults a never-visited space's view to
  // 'page-editor' — seeding it keeps that pre-existing mechanism from
  // leaking into these space/title assertions.
  useNavigationStore.setState({
    currentView: 'journal',
    currentViewBySpace: { SPACE_PERSONAL: 'journal', SPACE_WORK: 'journal' },
  })
  useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
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

  it('calls setWindowTitle with the active view and space name on mount', async () => {
    renderHook(() => useAppSpaceLifecycle())
    await waitFor(() => {
      expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith(
        'Journal \u00B7 Personal \u00B7 Agaric',
      )
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
      expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith(
        'Journal \u00B7 Personal \u00B7 Agaric',
      )
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
      expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith('Journal \u00B7 Work \u00B7 Agaric')
    })
  })

  it('re-stamps the title when the active view changes', async () => {
    renderHook(() => useAppSpaceLifecycle())
    await waitFor(() => {
      expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith(
        'Journal \u00B7 Personal \u00B7 Agaric',
      )
    })
    vi.mocked(setWindowTitle).mockClear()

    useNavigationStore.setState({ currentView: 'pages' })

    await waitFor(() => {
      expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith('Pages \u00B7 Personal \u00B7 Agaric')
    })
  })

  it('uses the open page title (not a generic label) when in page-editor view', async () => {
    useNavigationStore.setState({ currentView: 'page-editor' })
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [{ pageId: 'PAGE_1', title: 'My Great Page' }], label: '' }],
      activeTabIndex: 0,
    })

    renderHook(() => useAppSpaceLifecycle())

    await waitFor(() => {
      expect(vi.mocked(setWindowTitle)).toHaveBeenCalledWith(
        'My Great Page \u00B7 Personal \u00B7 Agaric',
      )
    })
  })
})
