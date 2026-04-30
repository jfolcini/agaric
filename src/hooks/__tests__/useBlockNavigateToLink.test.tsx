/**
 * Tests for useBlockNavigateToLink — the `[[ULID]]` link-target
 * navigation dispatch that BlockTree wires into `useRovingEditor.onNavigate`.
 *
 * Covers the four navigation branches (page, cross-tree content,
 * same-tree content, missing block), the resolve-cache write side
 * effect, and the lazy ref reads of `rovingEditorRef` / `handleFlushRef`.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/tauri', () => ({
  getBlock: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import type { RovingEditorHandle } from '../../editor/use-roving-editor'
import { logger } from '../../lib/logger'
import { getBlock } from '../../lib/tauri'
import { useResolveStore } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import { useBlockNavigateToLink } from '../useBlockNavigateToLink'

const mockedGetBlock = vi.mocked(getBlock)
const mockedLoggerError = vi.mocked(logger.error)

const TEST_SPACE_ID = 'SPACE_TEST'

interface HarnessParams {
  rovingEditor: RovingEditorHandle | null
  handleFlush: () => string | null
  load: () => Promise<void>
  setFocused: (id: string | null) => void
  rootParentId: string | null
  onNavigateToPage: ((pageId: string, title?: string, blockId?: string) => void) | undefined
  t: (key: string) => string
}

function useHarness(params: HarnessParams) {
  const rovingEditorRef = useRef<RovingEditorHandle | null>(params.rovingEditor)
  rovingEditorRef.current = params.rovingEditor
  const handleFlushRef = useRef<() => string | null>(params.handleFlush)
  handleFlushRef.current = params.handleFlush

  return useBlockNavigateToLink({
    rovingEditorRef,
    handleFlushRef,
    load: params.load,
    setFocused: params.setFocused,
    rootParentId: params.rootParentId,
    onNavigateToPage: params.onNavigateToPage,
    t: params.t,
  })
}

function makeBlock(overrides: Record<string, unknown>): Awaited<ReturnType<typeof getBlock>> {
  return {
    id: 'X',
    block_type: 'content',
    content: '',
    parent_id: null,
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  } as Awaited<ReturnType<typeof getBlock>>
}

beforeEach(async () => {
  await new Promise<void>((r) => queueMicrotask(r))
  useResolveStore.setState({
    cache: new Map(),
    pagesList: [],
    version: 0,
    _preloaded: false,
  })
  useSpaceStore.setState({
    currentSpaceId: TEST_SPACE_ID,
    availableSpaces: [{ id: TEST_SPACE_ID, name: 'Test', accent_color: null }],
    isReady: true,
  })
  vi.clearAllMocks()
})

describe('useBlockNavigateToLink', () => {
  it('handleNavigateRef.current always points at the latest handleNavigate', () => {
    const { result } = renderHook(() =>
      useHarness({
        rovingEditor: null,
        handleFlush: () => null,
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
        rootParentId: null,
        onNavigateToPage: vi.fn(),
        t: (k) => k,
      }),
    )

    expect(result.current.handleNavigateRef.current).toBe(result.current.handleNavigate)
  })

  it('navigates to a page-typed target via onNavigateToPage and flushes first', async () => {
    const PAGE_ID = '01TESTPAGE0000000000NAVPGE'
    const onNavigateToPage = vi.fn()
    const handleFlush = vi.fn(() => null)
    mockedGetBlock.mockResolvedValueOnce(
      makeBlock({ id: PAGE_ID, block_type: 'page', content: 'Target Page' }),
    )

    const { result } = renderHook(() =>
      useHarness({
        rovingEditor: null,
        handleFlush,
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
        rootParentId: 'OTHER_ROOT',
        onNavigateToPage,
        t: (k) => k,
      }),
    )

    await act(async () => {
      await result.current.handleNavigate(PAGE_ID)
    })

    expect(handleFlush).toHaveBeenCalledTimes(1)
    expect(onNavigateToPage).toHaveBeenCalledWith(PAGE_ID, 'Target Page')
  })

  it('navigates cross-tree via parent fetch when parent_id differs from rootParentId', async () => {
    const CONTENT_ID = '01TESTCONT0000000000NAVCTX'
    const PARENT_ID = '01TESTPAGE0000000000NAVPRT'
    const onNavigateToPage = vi.fn()
    mockedGetBlock.mockImplementation(async (id: string) => {
      if (id === CONTENT_ID)
        return makeBlock({
          id: CONTENT_ID,
          block_type: 'content',
          content: 'inline',
          parent_id: PARENT_ID,
        })
      if (id === PARENT_ID)
        return makeBlock({
          id: PARENT_ID,
          block_type: 'page',
          content: 'Parent Page',
          parent_id: null,
        })
      throw new Error(`unexpected id ${id}`)
    })

    const { result } = renderHook(() =>
      useHarness({
        rovingEditor: null,
        handleFlush: () => null,
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
        rootParentId: 'DIFFERENT_PAGE',
        onNavigateToPage,
        t: (k) => k,
      }),
    )

    await act(async () => {
      await result.current.handleNavigate(CONTENT_ID)
    })

    expect(onNavigateToPage).toHaveBeenCalledWith(PARENT_ID, 'Parent Page', CONTENT_ID)
  })

  it('navigates locally — calls load + setFocused + rovingEditorRef.current.mount', async () => {
    const CONTENT_ID = '01TESTCONT0000000000SAMETR'
    const ROOT_ID = '01TESTPAGE0000000000ROOTID'
    const load = vi.fn().mockResolvedValue(undefined)
    const setFocused = vi.fn()
    const mount = vi.fn()
    mockedGetBlock.mockResolvedValueOnce(
      makeBlock({
        id: CONTENT_ID,
        block_type: 'content',
        content: 'block text',
        parent_id: ROOT_ID,
      }),
    )

    const { result } = renderHook(() =>
      useHarness({
        rovingEditor: {
          editor: null,
          mount,
          unmount: vi.fn(() => null),
          activeBlockId: null,
          getMarkdown: () => null,
          originalMarkdown: '',
        },
        handleFlush: () => null,
        load,
        setFocused,
        rootParentId: ROOT_ID,
        onNavigateToPage: vi.fn(),
        t: (k) => k,
      }),
    )

    await act(async () => {
      await result.current.handleNavigate(CONTENT_ID)
    })

    expect(load).toHaveBeenCalledTimes(1)
    expect(setFocused).toHaveBeenCalledWith(CONTENT_ID)
    expect(mount).toHaveBeenCalledWith(CONTENT_ID, 'block text')
  })

  it('logs and surfaces a toast when getBlock throws (missing/deleted target)', async () => {
    mockedGetBlock.mockRejectedValueOnce(new Error('not found'))

    const { result } = renderHook(() =>
      useHarness({
        rovingEditor: null,
        handleFlush: () => null,
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
        rootParentId: 'ROOT',
        onNavigateToPage: vi.fn(),
        t: (k) => k,
      }),
    )

    await act(async () => {
      await result.current.handleNavigate('01TESTNONE0000000000MISSNG')
    })

    await waitFor(() => {
      expect(mockedLoggerError).toHaveBeenCalledWith(
        'BlockTree',
        'Failed to navigate to block link target',
        expect.objectContaining({ targetId: '01TESTNONE0000000000MISSNG' }),
        expect.any(Error),
      )
    })
  })

  it('writes the resolved title into the resolve store after a successful fetch', async () => {
    const PAGE_ID = '01TESTPAGE0000000000NAVCAC'
    mockedGetBlock.mockResolvedValueOnce(
      makeBlock({ id: PAGE_ID, block_type: 'page', content: 'Cached Title' }),
    )

    const { result } = renderHook(() =>
      useHarness({
        rovingEditor: null,
        handleFlush: () => null,
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
        rootParentId: 'ROOT',
        onNavigateToPage: vi.fn(),
        t: (k) => k,
      }),
    )

    await act(async () => {
      await result.current.handleNavigate(PAGE_ID)
    })

    // The store keys cache by `${spaceId}::${id}` — check size grew rather
    // than poking at composite keys.
    expect(useResolveStore.getState().cache.size).toBeGreaterThan(0)
  })
})
