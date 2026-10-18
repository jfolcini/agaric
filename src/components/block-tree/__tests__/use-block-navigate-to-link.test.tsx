/**
 * Tests for useBlockNavigateToLink — the `[[ULID]]` link-target
 * navigation dispatch that BlockTree wires into `useRovingEditor.onNavigate`.
 *
 * Covers the four navigation branches (page, cross-tree content,
 * same-tree content, missing block), the resolve-cache write side
 * effect, and the lazy ref reads of `rovingEditorRef` / `handleFlushRef`.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

// #2927 phase 5 — the hook now calls the generated `commands.getBlock`, so
// mocking only the hand-written wrapper no longer intercepts. Back the
// generated surface instead, resolving the same typed-result envelope `unwrap`
// expects.
const mockedGetBlock = vi.hoisted(() => vi.fn())
// #3306 — the hook now also asks the SPACE-SCOPED resolver whether the target
// belongs to the active space before caching its title or navigating. These
// unit tests all exercise same-space targets, so the default stub answers "yes"
// for whatever was asked. The cross-space refusal is covered end-to-end against
// the real backend model in `use-block-navigate-to-link.cross-space.test.tsx`.
const mockedBatchResolve = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getBlock: (...args: unknown[]) =>
        mockedGetBlock(...args).then((data: unknown) => ({ status: 'ok', data })),
      batchResolve: (...args: unknown[]) =>
        mockedBatchResolve(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { makeBlock as makeFlatBlock } from '@/__tests__/fixtures'
import { deferred } from '@/__tests__/helpers/invoke'
import { useBlockNavigateToLink } from '@/components/block-tree/use-block-navigate-to-link'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import type { BlockRow } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const mockedLoggerError = vi.mocked(logger.error)

const TEST_SPACE_ID = 'SPACE_TEST'

interface HarnessParams {
  pageStore?: StoreApi<PageBlockState>
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
  const handleFlushRef = useRef<() => string | null>(params.handleFlush)
  const [defaultPageStore] = useState(() => createPageBlockStore('HARNESS_PAGE'))
  useLayoutEffect(() => {
    rovingEditorRef.current = params.rovingEditor
    handleFlushRef.current = params.handleFlush
  })

  return useBlockNavigateToLink({
    rovingEditorRef,
    handleFlushRef,
    pageStore: params.pageStore ?? defaultPageStore,
    load: params.load,
    setFocused: params.setFocused,
    rootParentId: params.rootParentId,
    onNavigateToPage: params.onNavigateToPage,
    t: params.t as unknown as TFunction,
  })
}

function makeBlock(overrides: Record<string, unknown>): BlockRow {
  return {
    id: 'X',
    block_type: 'content',
    content: '',
    parent_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  } as BlockRow
}

beforeEach(async () => {
  await new Promise<void>((r) => queueMicrotask(r))
  useResolveStore.setState({
    cache: new Map(),
    version: 0,
    _preloaded: false,
  })
  useSpaceStore.setState({
    currentSpaceId: TEST_SPACE_ID,
    availableSpaces: [{ id: TEST_SPACE_ID, name: 'Test', accent_color: null }],
    isReady: true,
  })
  vi.clearAllMocks()
  mockedBatchResolve.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, title: null, block_type: 'page', deleted: false })),
  )
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

  it('navigates cross-tree via a page fetch when page_id differs from rootParentId', async () => {
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
          page_id: PARENT_ID,
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

  // An indented target's `parent_id` is a block; opening it as a page fails.
  it.each([
    [
      'on another page, opens that page',
      'OTHER_PAGE',
      [['OTHER_PAGE', 'Other Page', 'NESTED']],
      [],
    ],
    ['on this tree’s page, focuses it here', 'ROOT_PAGE', [], [['NESTED']]],
  ])('an indented target %s', async (_case, pageId, opened, focused) => {
    mockedGetBlock.mockImplementation(async (id: string) => {
      if (id === 'NESTED')
        return makeBlock({ id, content: 'nested', parent_id: 'PARENT_BLOCK', page_id: pageId })
      if (id === 'OTHER_PAGE')
        return makeBlock({ id, block_type: 'page', content: 'Other Page', page_id: id })
      throw new Error(`unexpected id ${id}`)
    })
    const onNavigateToPage = vi.fn()
    const setFocused = vi.fn()
    const { result } = renderHook(() =>
      useHarness({
        rovingEditor: null,
        handleFlush: () => null,
        load: vi.fn().mockResolvedValue(undefined),
        setFocused,
        rootParentId: 'ROOT_PAGE',
        onNavigateToPage,
        t: (k) => k,
      }),
    )

    await act(async () => {
      await result.current.handleNavigate('NESTED')
    })

    expect(onNavigateToPage.mock.calls).toEqual(opened)
    expect(setFocused.mock.calls).toEqual(focused)
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
        page_id: ROOT_ID,
      }),
    )

    const { result } = renderHook(() =>
      useHarness({
        rovingEditor: {
          editor: null,
          mount,
          updateListMarker: vi.fn(),
          listMarker: vi.fn(() => ({ style: 'none' as const, ordinal: undefined })),
          unmount: vi.fn(() => null),
          activeBlockId: null,
          getMarkdown: () => null,
          splitAtCaret: () => null,
          originalMarkdown: '',
          setOnUpdate: vi.fn(),
          markCommitted: vi.fn(),
          storedMarkdown: '',
          readAsTyped: vi.fn(),
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

  it.each([
    ['a page target', 'PAGE_T', 'page', null, ['PAGE_T', 'Target Page']],
    ['a block on this tree’s page', 'BLOCK_T', 'content', 'ROOT_PAGE', ['ROOT_PAGE', 'Root Page']],
    ['a block on no page', 'TAG_T', 'tag', null, null],
  ])(
    'with openPage, hands it the page of %s and leaves the editor and the view alone',
    async (_case, targetId, blockType, parentId, opened) => {
      mockedGetBlock.mockImplementation(async (id: string) => {
        if (id === targetId)
          return makeBlock({
            id,
            block_type: blockType,
            content: 'Target Page',
            parent_id: parentId,
            page_id: parentId,
          })
        if (id === 'ROOT_PAGE')
          return makeBlock({ id, block_type: 'page', content: 'Root Page', parent_id: null })
        throw new Error(`unexpected id ${id}`)
      })
      const handleFlush = vi.fn(() => null)
      const load = vi.fn().mockResolvedValue(undefined)
      const setFocused = vi.fn()
      const onNavigateToPage = vi.fn()
      const openPage = vi.fn()
      const { result } = renderHook(() =>
        useHarness({
          rovingEditor: null,
          handleFlush,
          load,
          setFocused,
          rootParentId: 'ROOT_PAGE',
          onNavigateToPage,
          t: (k) => k,
        }),
      )

      await act(async () => {
        await result.current.handleNavigate(targetId, openPage)
      })

      expect(openPage.mock.calls.map((call) => call.slice(0, 2))).toEqual(opened ? [opened] : [])
      expect(onNavigateToPage).not.toHaveBeenCalled()
      expect(handleFlush).not.toHaveBeenCalled()
      expect(load).not.toHaveBeenCalled()
      expect(setFocused).not.toHaveBeenCalled()
    },
  )

  it('skips load when the same-page target is already in the page store', async () => {
    const CONTENT_ID = '01TESTCONT0000000000LOADED'
    const ROOT_ID = '01TESTPAGE0000000000ROOTLD'
    const pageStore = createPageBlockStore(ROOT_ID)
    pageStore.setState({ blocks: [makeFlatBlock({ id: CONTENT_ID, parent_id: ROOT_ID })] })
    const load = vi.fn().mockResolvedValue(undefined)
    const setFocused = vi.fn()
    const mount = vi.fn()
    mockedGetBlock.mockResolvedValueOnce(
      makeBlock({ id: CONTENT_ID, content: 'block text', parent_id: ROOT_ID, page_id: ROOT_ID }),
    )

    const { result } = renderHook(() =>
      useHarness({
        pageStore,
        rovingEditor: {
          editor: null,
          mount,
          updateListMarker: vi.fn(),
          listMarker: vi.fn(() => ({ style: 'none' as const, ordinal: undefined })),
          unmount: vi.fn(() => null),
          activeBlockId: null,
          getMarkdown: () => null,
          splitAtCaret: () => null,
          originalMarkdown: '',
          setOnUpdate: vi.fn(),
          markCommitted: vi.fn(),
          storedMarkdown: '',
          readAsTyped: vi.fn(),
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

    expect(load).not.toHaveBeenCalled()
    expect(setFocused).toHaveBeenCalledWith(CONTENT_ID)
    expect(mount).toHaveBeenCalledWith(CONTENT_ID, 'block text')
  })

  it('issues getBlock and the space check in the same round', async () => {
    const PAGE_ID = '01TESTPAGE0000000000PARALL'
    const onNavigateToPage = vi.fn()
    const block = deferred<BlockRow>()
    const resolved = deferred<Array<{ id: string; title: string | null }>>()
    mockedGetBlock.mockImplementation(() => block.promise)
    mockedBatchResolve.mockImplementation(() => resolved.promise)

    const { result } = renderHook(() =>
      useHarness({
        rovingEditor: null,
        handleFlush: () => null,
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
        rootParentId: 'ROOT',
        onNavigateToPage,
        t: (k) => k,
      }),
    )

    let navigation!: Promise<void>
    act(() => {
      navigation = result.current.handleNavigate(PAGE_ID)
    })

    expect(mockedGetBlock).toHaveBeenCalledWith(PAGE_ID)
    expect(mockedBatchResolve).toHaveBeenCalledWith([PAGE_ID], {
      kind: 'active',
      space_id: TEST_SPACE_ID,
    })

    await act(async () => {
      block.resolve(makeBlock({ id: PAGE_ID, block_type: 'page', content: 'Target Page' }))
      resolved.resolve([{ id: PAGE_ID, title: 'Target Page' }])
      await navigation
    })
    expect(onNavigateToPage).toHaveBeenCalledWith(PAGE_ID, 'Target Page')
  })

  it('logs and toasts without navigating when the space check rejects', async () => {
    const PAGE_ID = '01TESTPAGE0000000000SPCERR'
    const onNavigateToPage = vi.fn()
    mockedGetBlock.mockResolvedValueOnce(
      makeBlock({ id: PAGE_ID, block_type: 'page', content: 'Target Page' }),
    )
    mockedBatchResolve.mockRejectedValueOnce(new Error('resolve failed'))

    const { result } = renderHook(() =>
      useHarness({
        rovingEditor: null,
        handleFlush: () => null,
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
        rootParentId: 'ROOT',
        onNavigateToPage,
        t: (k) => k,
      }),
    )

    await act(async () => {
      await result.current.handleNavigate(PAGE_ID)
    })

    expect(mockedLoggerError).toHaveBeenCalledWith(
      'BlockTree',
      'Failed to navigate to block link target',
      { targetId: PAGE_ID },
      expect.any(Error),
    )
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.linkTargetNotFound')
    expect(onNavigateToPage).not.toHaveBeenCalled()
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
