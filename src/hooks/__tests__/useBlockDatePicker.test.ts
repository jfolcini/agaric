import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { makeBlock } from '../../__tests__/fixtures'
import { announce } from '../../lib/announcer'
import {
  createPageBlockStore,
  PageBlockContext,
  type PageBlockState,
} from '../../stores/page-blocks'
import { useSpaceStore } from '../../stores/space'
import { useUndoStore } from '../../stores/undo'
import { useBlockDatePicker } from '../useBlockDatePicker'

vi.mock('../../lib/announcer', () => ({ announce: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PageBlockContext.Provider, { value: pageStore }, children)

const originalOnNewAction = useUndoStore.getState().onNewAction
const originalSpaceState = useSpaceStore.getState()
afterEach(() => {
  useUndoStore.setState({
    ...useUndoStore.getState(),
    onNewAction: originalOnNewAction,
    pages: new Map(),
  })
  useSpaceStore.setState(originalSpaceState)
})

function makeDefaultParams(overrides?: Partial<Parameters<typeof useBlockDatePicker>[0]>) {
  return {
    focusedBlockId: 'BLOCK_1' as string | null,
    rootParentId: 'PAGE_1' as string | null,
    pageStore,
    rovingEditor: {
      editor: null,
    } as { editor: null },
    pagesListRef: { current: [] as Array<{ id: string; title: string }> },
    t: vi.fn((key: string) => key),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(undefined)
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1' })] })
  // BUG-1 / H-3b — `handleDateMode` now routes through `createPageInSpace`,
  // which reads `currentSpaceId` from the space store. Seed a deterministic
  // active space so the date-mode flow has a target.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

describe('useBlockDatePicker initial state', () => {
  it('returns datePickerOpen as false', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    expect(result.current.datePickerOpen).toBe(false)
  })

  it('returns datePickerMode as date', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    expect(result.current.datePickerMode).toBe('date')
  })

  it('returns datePickerCursorPos as undefined ref', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    expect(result.current.datePickerCursorPos.current).toBeUndefined()
  })
})

describe('useBlockDatePicker setters', () => {
  it('setDatePickerOpen toggles open state', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerOpen(true)
    })
    expect(result.current.datePickerOpen).toBe(true)

    act(() => {
      result.current.setDatePickerOpen(false)
    })
    expect(result.current.datePickerOpen).toBe(false)
  })

  it('setDatePickerMode changes mode', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerMode('due')
    })
    expect(result.current.datePickerMode).toBe('due')

    act(() => {
      result.current.setDatePickerMode('schedule')
    })
    expect(result.current.datePickerMode).toBe('schedule')
  })
})

describe('useBlockDatePicker handleDatePick — due mode', () => {
  it('sets due date on focused block', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerMode('due')
    })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 0, 15))
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_due_date', {
      blockId: 'BLOCK_1',
      date: '2025-01-15',
    })
  })

  it('updates block store with due_date', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerMode('due')
    })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 5, 1))
    })

    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.due_date).toBe('2025-06-01')
  })

  it('closes the date picker', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerOpen(true)
      result.current.setDatePickerMode('due')
    })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 0, 1))
    })

    expect(result.current.datePickerOpen).toBe(false)
  })

  it('shows error toast on failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerMode('due')
    })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 0, 1))
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.setDueDateFailed')
  })

  it('does nothing when focusedBlockId is null', async () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerMode('due')
    })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 0, 1))
    })

    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})

describe('useBlockDatePicker handleDatePick — schedule mode', () => {
  it('sets scheduled date on focused block', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerMode('schedule')
    })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 2, 10))
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_scheduled_date', {
      blockId: 'BLOCK_1',
      date: '2025-03-10',
    })
  })

  it('announces scheduled date', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerMode('schedule')
    })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 2, 10))
    })

    expect(vi.mocked(announce)).toHaveBeenCalledWith('announce.scheduledDateSet')
  })
})

describe('useBlockDatePicker handleDatePick — repeat-until mode', () => {
  it('sets repeat-until property', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerMode('repeat-until')
    })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 11, 31))
    })

    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'repeat-until',
        valueDate: '2025-12-31',
      }),
    )
  })

  it('shows success toast', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerMode('repeat-until')
    })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 0, 1))
    })

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('blockTree.repeatUntilMessage')
  })
})

describe('useBlockDatePicker handleDatePick — date mode', () => {
  it('creates date page when none exists', async () => {
    // 1st invoke = list_blocks (no existing page); 2nd = create_page_in_space
    // (returns the new page's ULID as a plain string per BUG-1's contract).
    mockedInvoke.mockResolvedValueOnce({ items: [] })
    mockedInvoke.mockResolvedValueOnce('DATE_PAGE_1')
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 0, 15))
    })

    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_blocks',
      expect.objectContaining({
        blockType: 'page',
      }),
    )
    // BUG-1 / H-3b — date pages route through `create_page_in_space` so
    // they own a `space` property and surface in PageBrowser. The
    // legacy `create_block(blockType: 'page')` path is no longer used.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_page_in_space',
      expect.objectContaining({
        content: '2025-01-15',
        spaceId: 'SPACE_TEST',
      }),
    )
    // Negative: ensure the legacy bypass path is NOT taken.
    const legacyCalls = mockedInvoke.mock.calls.filter(
      ([cmd, args]) =>
        cmd === 'create_block' &&
        (args as { blockType?: string } | undefined)?.blockType === 'page',
    )
    expect(legacyCalls).toHaveLength(0)
  })

  it('uses existing date page if found', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [{ id: 'EXISTING_PAGE', content: '2025-01-15' }],
    })
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 0, 15))
    })

    expect(mockedInvoke).not.toHaveBeenCalledWith('create_page_in_space', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('create_block', expect.anything())
  })

  it('updates pagesListRef when creating new page', async () => {
    mockedInvoke.mockResolvedValueOnce({ items: [] })
    mockedInvoke.mockResolvedValueOnce('NEW_PAGE')
    const pagesListRef = { current: [] as Array<{ id: string; title: string }> }
    const params = makeDefaultParams({ pagesListRef })
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 5, 1))
    })

    expect(pagesListRef.current).toContainEqual({
      id: 'NEW_PAGE',
      title: '2025-06-01',
    })
  })
})

describe('useBlockDatePicker undo notifications', () => {
  const onNewActionSpy = vi.fn()

  beforeEach(() => {
    onNewActionSpy.mockClear()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })
  })

  it('calls onNewAction after setting due date', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerMode('due')
    })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 0, 1))
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('does not call onNewAction when rootParentId is null', async () => {
    const params = makeDefaultParams({ rootParentId: null })
    const { result } = renderHook(() => useBlockDatePicker(params), { wrapper })

    act(() => {
      result.current.setDatePickerMode('due')
    })

    await act(async () => {
      await result.current.handleDatePick(new Date(2025, 0, 1))
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })
})
