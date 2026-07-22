/**
 * Tests for useRichContentCallbacks hook.
 *
 * Validates:
 * - resolveBlockTitle returns cached title or undefined fallback
 * - resolveBlockStatus returns 'active' or 'deleted'
 * - resolveTagName returns cached title or undefined fallback
 * - resolveTagStatus returns 'active' or 'deleted'
 * - Callbacks re-render when store version bumps
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2996 — `useTagClickHandler` now verifies an unresolved tag target via
// `getBlock` before navigating (mirroring the `[[` block-link guard). Mock the
// tauri wrapper and the notifier so the guard path is observable.
vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  getBlock: vi.fn(),
}))
vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { useRichContentCallbacks, useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import { notify } from '@/lib/notify'
import { getBlock } from '@/lib/tauri'
import { useNavigationStore } from '@/stores/navigation'
import { useResolveStore } from '@/stores/resolve'
import { useTabsStore } from '@/stores/tabs'

const mockedGetBlock = vi.mocked(getBlock)
const mockedNotifyError = vi.mocked(notify.error)

function makeBlockRow(overrides: Partial<Awaited<ReturnType<typeof getBlock>>>) {
  return {
    id: 'X',
    block_type: 'tag',
    content: null,
    parent_id: null,
    position: null,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
    ...overrides,
  } as Awaited<ReturnType<typeof getBlock>>
}

beforeEach(() => {
  useResolveStore.setState({
    cache: new Map(),
    version: 0,
    _preloaded: false,
  })
})

// ── resolveBlockTitle ──────────────────────────────────────────────────

describe('resolveBlockTitle', () => {
  it('returns cached title when the block is in the store', () => {
    useResolveStore.getState().set('BLOCK_A', 'My Page', false)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockTitle('BLOCK_A')).toBe('My Page')
  })

  it('returns undefined for uncached blocks', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockTitle('MISSING')).toBeUndefined()
  })

  it('picks up new entries after store update', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockTitle('BLOCK_B')).toBeUndefined()

    act(() => {
      useResolveStore.getState().set('BLOCK_B', 'Updated Title', false)
    })

    expect(result.current.resolveBlockTitle('BLOCK_B')).toBe('Updated Title')
  })
})

// ── resolveBlockStatus ─────────────────────────────────────────────────

describe('resolveBlockStatus', () => {
  it('returns "active" for non-deleted blocks', () => {
    useResolveStore.getState().set('BLOCK_A', 'Active Page', false)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockStatus('BLOCK_A')).toBe('active')
  })

  it('returns "deleted" for deleted blocks', () => {
    useResolveStore.getState().set('BLOCK_D', 'Deleted Page', true)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockStatus('BLOCK_D')).toBe('deleted')
  })

  it('returns "active" for uncached blocks', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockStatus('MISSING')).toBe('active')
  })
})

// ── resolveTagName ─────────────────────────────────────────────────────

describe('resolveTagName', () => {
  it('returns cached tag name', () => {
    useResolveStore.getState().set('TAG_A', 'project', false)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveTagName('TAG_A')).toBe('project')
  })

  it('returns undefined for uncached tags', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveTagName('MISSING')).toBeUndefined()
  })
})

// ── resolveTagStatus ───────────────────────────────────────────────────

describe('resolveTagStatus', () => {
  it('returns "active" for non-deleted tags', () => {
    useResolveStore.getState().set('TAG_A', 'active-tag', false)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveTagStatus('TAG_A')).toBe('active')
  })

  it('returns "deleted" for deleted tags', () => {
    useResolveStore.getState().set('TAG_D', 'deleted-tag', true)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveTagStatus('TAG_D')).toBe('deleted')
  })

  it('returns "active" for uncached tags', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveTagStatus('MISSING')).toBe('active')
  })
})

// ── useTagClickHandler ────────────────────────────────────────

describe('useTagClickHandler', () => {
  // Intersection type so the spy satisfies both Zustand's store signature
  // and Vitest's `expect(mock).toHaveBeenCalled…` assertions.
  let navigateToPage: Mock & ((pageId: string, title: string, blockId?: string | undefined) => void)

  beforeEach(() => {
    // #2996 — reset the guard-path IPC/notifier mocks so per-test call-count
    // assertions don't observe calls from a prior test.
    mockedGetBlock.mockReset()
    mockedNotifyError.mockReset()
    // Swap navigateToPage for a spy by calling setState — this triggers
    // Zustand subscriber notifications so hooks re-capture the new ref.
    navigateToPage = vi.fn() as typeof navigateToPage
    useNavigationStore.setState({
      currentView: 'journal',
      selectedBlockId: null,
    })
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
      navigateToPage,
    })
  })

  it('calls navigateToPage with resolved tag name and id', () => {
    useResolveStore.getState().set('TAG_X', 'project', false)

    const { result } = renderHook(() => useTagClickHandler())
    result.current('TAG_X')

    expect(navigateToPage).toHaveBeenCalledTimes(1)
    expect(navigateToPage).toHaveBeenCalledWith('TAG_X', 'project')
  })

  // #2996 — an unresolved tag is no longer navigated to blindly. The handler
  // verifies existence via `getBlock` first; a live tag navigates with its
  // fetched content (mirroring the `[[` block-link guard).
  it('verifies an uncached tag via getBlock and navigates when it exists', async () => {
    mockedGetBlock.mockResolvedValueOnce(makeBlockRow({ id: 'UNCACHED', content: 'realtag' }))

    const { result } = renderHook(() => useTagClickHandler())
    result.current('UNCACHED')

    await waitFor(() => expect(navigateToPage).toHaveBeenCalledWith('UNCACHED', 'realtag'))
    expect(mockedGetBlock).toHaveBeenCalledWith('UNCACHED')
    expect(mockedNotifyError).not.toHaveBeenCalled()
  })

  // #2996 — guard: a pill pointing at a tag that does not exist must NOT
  // navigate anywhere; it surfaces the not-found notice instead.
  it('does NOT navigate and notifies when the tag target does not exist', async () => {
    mockedGetBlock.mockRejectedValueOnce(new Error('not found'))

    const { result } = renderHook(() => useTagClickHandler())
    result.current('GHOST')

    await waitFor(() => expect(mockedNotifyError).toHaveBeenCalledTimes(1))
    expect(navigateToPage).not.toHaveBeenCalled()
  })

  // #2996 — guard: a tag that exists but was deleted must not navigate either.
  it('does NOT navigate and notifies when the tag target is deleted', async () => {
    mockedGetBlock.mockResolvedValueOnce(
      makeBlockRow({ id: 'DELETED', content: 'gone', deleted_at: 1753142400000 }),
    )

    const { result } = renderHook(() => useTagClickHandler())
    result.current('DELETED')

    await waitFor(() => expect(mockedNotifyError).toHaveBeenCalledTimes(1))
    expect(navigateToPage).not.toHaveBeenCalled()
  })

  it('takes the synchronous fast path (no getBlock) for a cached, live tag', () => {
    act(() => {
      useResolveStore.getState().set('LATE', 'late-tag', false)
    })
    const { result } = renderHook(() => useTagClickHandler())
    result.current('LATE')
    expect(navigateToPage).toHaveBeenLastCalledWith('LATE', 'late-tag')
    expect(mockedGetBlock).not.toHaveBeenCalled()
  })

  it('returns a stable callback across re-renders when nothing changes', () => {
    const { result, rerender } = renderHook(() => useTagClickHandler())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})

// ── Reactivity ─────────────────────────────────────────────────────────

describe('reactivity', () => {
  it('re-renders when store version changes via batchSet', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockTitle('B1')).toBeUndefined()
    expect(result.current.resolveTagName('T1')).toBeUndefined()

    act(() => {
      useResolveStore.getState().batchSet([
        { id: 'B1', title: 'Page One', deleted: false },
        { id: 'T1', title: 'tag-one', deleted: false },
      ])
    })

    expect(result.current.resolveBlockTitle('B1')).toBe('Page One')
    expect(result.current.resolveTagName('T1')).toBe('tag-one')
  })
})
