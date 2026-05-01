/**
 * Tests for useJournalBlockCreation hook.
 *
 * Validates:
 *  - Creates a page via createPageInSpace + content block when no page exists
 *  - Skips page creation when an entry already exists in pageMap
 *  - Skips page creation when an entry already exists in createdPages (local)
 *  - Loads per-space template when configured (FEAT-3p5b)
 *  - Falls back to legacy `journal-template` page when per-space is empty
 *  - Falls back to a blank content block when no template is configured
 *  - Surfaces a toast on errors and bails out gracefully
 *  - Refuses to create a page without an active space
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSpaceStore } from '../../stores/space'
import { useJournalBlockCreation } from '../useJournalBlockCreation'

vi.mock('../../lib/template-utils', () => ({
  loadJournalTemplate: vi.fn(async () => ({ template: null, duplicateWarning: null })),
  loadJournalTemplateForSpace: vi.fn(async () => null),
  insertTemplateBlocks: vi.fn(async () => []),
  insertTemplateBlocksFromString: vi.fn(async () => []),
}))

import {
  insertTemplateBlocks,
  insertTemplateBlocksFromString,
  loadJournalTemplate,
  loadJournalTemplateForSpace,
} from '../../lib/template-utils'

const mockedInvoke = vi.mocked(invoke)
const mockedLoadJournalTemplate = vi.mocked(loadJournalTemplate)
const mockedLoadJournalTemplateForSpace = vi.mocked(loadJournalTemplateForSpace)
const mockedInsertTemplateBlocks = vi.mocked(insertTemplateBlocks)
const mockedInsertTemplateBlocksFromString = vi.mocked(insertTemplateBlocksFromString)

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  mockedLoadJournalTemplate.mockResolvedValue({ template: null, duplicateWarning: null })
  mockedLoadJournalTemplateForSpace.mockResolvedValue(null)
  mockedInsertTemplateBlocks.mockResolvedValue([])
  mockedInsertTemplateBlocksFromString.mockResolvedValue([])
})

interface PageCreatedCall {
  dateStr: string
  pageId: string
}

interface SetupResult {
  result: { current: ReturnType<typeof useJournalBlockCreation> }
  rerender: (props: {
    pageMap: Map<string, string>
    onPageCreated: (dateStr: string, pageId: string) => void
  }) => void
  pageCreatedCalls: PageCreatedCall[]
  unmount: () => void
}

function setup(initialPageMap: Map<string, string> = new Map()): SetupResult {
  const pageCreatedCalls: PageCreatedCall[] = []
  const onPageCreated = (dateStr: string, pageId: string) => {
    pageCreatedCalls.push({ dateStr, pageId })
  }
  const rendered = renderHook(
    ({ pageMap, onPageCreated: cb }) => useJournalBlockCreation({ pageMap, onPageCreated: cb }),
    { initialProps: { pageMap: initialPageMap, onPageCreated } },
  )
  return {
    result: rendered.result,
    rerender: rendered.rerender,
    pageCreatedCalls,
    unmount: rendered.unmount,
  }
}

describe('useJournalBlockCreation', () => {
  it('creates a page + content block when no page exists for the date', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'create_page_in_space') return 'PNEW'
      if (cmd === 'create_block') {
        const params = args as { blockType: string; content?: string; parentId?: string }
        return {
          id: 'BNEW',
          block_type: params.blockType,
          content: params.content ?? '',
          parent_id: params.parentId ?? null,
          position: 0,
        }
      }
      return null
    })

    const { result, pageCreatedCalls } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    // Page was created for the date with the active space
    expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
      parentId: null,
      content: '2025-06-15',
      spaceId: 'SPACE_TEST',
    })
    // Then a content block under it
    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'content',
      content: '',
      parentId: 'PNEW',
      position: null,
      spaceId: null,
    })
    // onPageCreated callback fired
    expect(pageCreatedCalls).toEqual([{ dateStr: '2025-06-15', pageId: 'PNEW' }])
    // createdPages map updated
    expect(result.current.createdPages.get('2025-06-15')).toBe('PNEW')
  })

  it('does not create a new page when one already exists in pageMap', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'create_block') {
        return { id: 'B1', block_type: 'content', content: '', parent_id: 'PEXIST', position: 1 }
      }
      return null
    })

    const { result, pageCreatedCalls } = setup(new Map([['2025-06-15', 'PEXIST']]))

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    // No create_page_in_space call
    const createPageCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'create_page_in_space',
    )
    expect(createPageCalls).toHaveLength(0)

    // create_block under the existing page
    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'content',
      content: '',
      parentId: 'PEXIST',
      position: null,
      spaceId: null,
    })
    expect(pageCreatedCalls).toHaveLength(0)
  })

  it('uses the per-space journal template when configured', async () => {
    mockedLoadJournalTemplateForSpace.mockResolvedValue('# Daily plan\n- ')
    mockedInsertTemplateBlocksFromString.mockResolvedValue(['ID1', 'ID2'])

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'create_page_in_space') return 'PNEW'
      return null
    })

    const { result } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    expect(mockedLoadJournalTemplateForSpace).toHaveBeenCalledWith('SPACE_TEST')
    expect(mockedInsertTemplateBlocksFromString).toHaveBeenCalledWith('# Daily plan\n- ', 'PNEW', {
      pageTitle: '2025-06-15',
    })
    // Did NOT fall through to the legacy template path
    expect(mockedLoadJournalTemplate).not.toHaveBeenCalled()
    // Did NOT create a blank content block (template inserts its own blocks)
    const createBlockCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createBlockCalls).toHaveLength(0)
  })

  it('falls back to the legacy journal template when per-space is empty', async () => {
    mockedLoadJournalTemplateForSpace.mockResolvedValue(null)
    mockedLoadJournalTemplate.mockResolvedValue({
      template: {
        id: 'TMPL',
        block_type: 'page',
        content: 'Tmpl',
        parent_id: null,
        position: 0,
        deleted_at: null,
        is_conflict: false,
        conflict_type: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
        page_id: null,
      },
      duplicateWarning: null,
    })
    mockedInsertTemplateBlocks.mockResolvedValue(['T1'])

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'create_page_in_space') return 'PNEW'
      return null
    })

    const { result } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    expect(mockedLoadJournalTemplateForSpace).toHaveBeenCalled()
    expect(mockedLoadJournalTemplate).toHaveBeenCalled()
    // FEAT-3 Phase 4 — `insertTemplateBlocks` now accepts `spaceId` as
    // its third positional arg (the active space scopes the recursive
    // copy walk).
    expect(mockedInsertTemplateBlocks).toHaveBeenCalledWith('TMPL', 'PNEW', 'SPACE_TEST', {
      pageTitle: '2025-06-15',
    })
  })

  it('creates a blank content block when no template is configured', async () => {
    mockedLoadJournalTemplateForSpace.mockResolvedValue(null)
    mockedLoadJournalTemplate.mockResolvedValue({ template: null, duplicateWarning: null })

    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'create_page_in_space') return 'PNEW'
      if (cmd === 'create_block') {
        const params = args as { blockType: string; content?: string; parentId?: string }
        return {
          id: 'B1',
          block_type: params.blockType,
          content: params.content ?? '',
          parent_id: params.parentId ?? null,
          position: 0,
        }
      }
      return null
    })

    const { result } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'content',
      content: '',
      parentId: 'PNEW',
      position: null,
      spaceId: null,
    })
  })

  it('shows a toast and bails when there is no active space', async () => {
    useSpaceStore.setState({
      currentSpaceId: null,
      availableSpaces: [],
      isReady: false,
    })

    const { result } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalled()
    // No page was created
    const createPageCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'create_page_in_space',
    )
    expect(createPageCalls).toHaveLength(0)
  })

  it('shows a toast when create_page_in_space rejects', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('backend down'))

    const { result } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled()
    })
  })

  it('does not re-create a page once it exists in createdPages (idempotent)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'create_page_in_space') return 'PNEW'
      if (cmd === 'create_block') {
        return { id: 'B1', block_type: 'content', content: '', parent_id: 'PNEW', position: 0 }
      }
      return null
    })

    const { result } = setup()

    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    const createPageCallsAfterFirst = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'create_page_in_space',
    ).length
    expect(createPageCallsAfterFirst).toBe(1)

    // Second call to handleAddBlock for the same date — page already in createdPages
    await act(async () => {
      await result.current.handleAddBlock('2025-06-15')
    })

    const createPageCallsAfterSecond = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'create_page_in_space',
    ).length
    expect(createPageCallsAfterSecond).toBe(1)
  })
})
