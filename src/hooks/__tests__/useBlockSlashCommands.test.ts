import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import {
  createPageBlockStore,
  PageBlockContext,
  type PageBlockState,
} from '../../stores/page-blocks'
import { useUndoStore } from '../../stores/undo'
import {
  SLASH_COMMANDS,
  searchPropertyKeys,
  searchSlashCommands,
  useBlockSlashCommands,
} from '../useBlockSlashCommands'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../../lib/announcer', () => ({ announce: vi.fn() }))
vi.mock('../../editor/markdown-serializer', () => ({
  serialize: vi.fn(() => 'content'),
}))
vi.mock('../../lib/repeat-utils', () => ({
  formatRepeatLabel: vi.fn((v: string) => v),
}))
vi.mock('../../lib/template-utils', () => ({
  insertTemplateBlocks: vi.fn(async () => ['NEW_1']),
  loadTemplatePagesWithPreview: vi.fn(async () => []),
}))
vi.mock('../../components/BlockTree', () => ({
  guessMimeType: vi.fn(() => 'application/octet-stream'),
}))

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PageBlockContext.Provider, { value: pageStore }, children)

function makeBlock(id: string, content = '', parentId: string | null = null) {
  return {
    id,
    block_type: 'content' as const,
    content,
    parent_id: parentId,
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
    depth: 0,
  }
}

function makeDefaultParams(overrides?: Partial<Parameters<typeof useBlockSlashCommands>[0]>) {
  return {
    focusedBlockId: 'BLOCK_1' as string | null,
    rootParentId: 'PAGE_1' as string | null,
    pageStore,
    rovingEditor: {
      editor: null,
      mount: vi.fn() as unknown as (blockId: string, markdown: string) => void,
    },
    datePickerCursorPos: { current: undefined as number | undefined },
    setDatePickerMode: vi.fn(),
    setDatePickerOpen: vi.fn(),
    blocks: [makeBlock('BLOCK_1', 'hello', 'PAGE_1')],
    load: vi.fn(async () => {}),
    t: vi.fn((key: string) => key),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(undefined)
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'hello', 'PAGE_1')] })
})

describe('SLASH_COMMANDS', () => {
  it('contains expected base commands', () => {
    const ids = SLASH_COMMANDS.map((c) => c.id)
    expect(ids).toContain('todo')
    expect(ids).toContain('done')
    expect(ids).toContain('date')
    expect(ids).toContain('template')
    expect(ids).toContain('attach')
  })

  it('all commands have category and icon metadata (UX-50)', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.category).toBeTruthy()
      expect(cmd.icon).toBeTruthy()
    }
  })
})

describe('searchSlashCommands', () => {
  it('returns all base commands for empty query', () => {
    const results = searchSlashCommands('')
    expect(results.length).toBe(SLASH_COMMANDS.length)
  })

  it('filters by query string', () => {
    const results = searchSlashCommands('todo')
    expect(results.some((r) => r.id === 'todo')).toBe(true)
    // With fuzzy matching, top results should include 'todo'
    expect(results[0]?.id).toBe('todo')
  })

  it('includes priority commands when query matches', () => {
    const results = searchSlashCommands('priority')
    expect(results.some((r) => r.id === 'priority-high')).toBe(true)
    expect(results.some((r) => r.id === 'priority-medium')).toBe(true)
    expect(results.some((r) => r.id === 'priority-low')).toBe(true)
  })

  it('includes heading commands when query matches', () => {
    const results = searchSlashCommands('heading')
    expect(results.some((r) => r.id === 'h1')).toBe(true)
    expect(results.some((r) => r.id === 'h6')).toBe(true)
  })

  it('includes repeat commands when query matches', () => {
    const results = searchSlashCommands('repeat')
    expect(results.some((r) => r.id === 'repeat-daily')).toBe(true)
    expect(results.some((r) => r.id === 'repeat-remove')).toBe(true)
  })

  it('includes effort commands when query matches', () => {
    const results = searchSlashCommands('effort')
    expect(results.some((r) => r.id === 'effort-1h')).toBe(true)
  })

  it('includes assignee commands when query matches', () => {
    const results = searchSlashCommands('assignee')
    expect(results.some((r) => r.id === 'assignee-me')).toBe(true)
  })

  it('includes location commands when query matches', () => {
    const results = searchSlashCommands('location')
    expect(results.some((r) => r.id === 'location-office')).toBe(true)
  })

  it('handles table NxM pattern', () => {
    const results = searchSlashCommands('table 4x6')
    expect(results.some((r) => r.id === 'table:4:6')).toBe(true)
    expect(results.every((r) => r.id !== 'table')).toBe(true)
  })

  it('returns empty array-like for non-matching query', () => {
    const results = searchSlashCommands('zzzzzzzznonexistent')
    expect(results.length).toBe(0)
  })

  it('filtered results preserve category and icon metadata (UX-50)', () => {
    const results = searchSlashCommands('todo')
    const todoItem = results.find((r) => r.id === 'todo')
    expect(todoItem).toBeDefined()
    expect(todoItem?.category).toBe('slashCommand.categories.tasks')
    expect(todoItem?.icon).toBeTruthy()
  })

  it('dynamic table command includes category and icon (UX-50)', () => {
    const results = searchSlashCommands('table 3x3')
    const tableItem = results.find((r) => r.id === 'table:3:3')
    expect(tableItem).toBeDefined()
    expect(tableItem?.category).toBe('slashCommand.categories.structure')
    expect(tableItem?.icon).toBeTruthy()
  })

  // -- UX-68: Fuzzy matching --------------------------------------------------

  it('fuzzy matches non-substring queries (UX-68)', () => {
    // "tdo" is not a substring of "TODO — Mark as to-do" but fuzzy should match
    const results = searchSlashCommands('tdo')
    expect(results.some((r) => r.id === 'todo')).toBe(true)
  })

  it('fuzzy matches across command groups (UX-68)', () => {
    // "prihi" should fuzzy match "PRIORITY 1 — Set high priority"
    const results = searchSlashCommands('pri')
    expect(results.some((r) => r.id === 'priority-high')).toBe(true)
  })
})

describe('searchPropertyKeys', () => {
  it('returns matching property keys', async () => {
    mockedInvoke.mockResolvedValueOnce(['effort', 'assignee', 'location'])
    const results = await searchPropertyKeys('eff')
    expect(results).toEqual([{ id: 'effort', label: 'effort' }])
  })

  it('returns all keys for empty query', async () => {
    mockedInvoke.mockResolvedValueOnce(['effort', 'assignee'])
    const results = await searchPropertyKeys('')
    expect(results).toHaveLength(2)
  })

  it('returns empty array on error', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const results = await searchPropertyKeys('x')
    expect(results).toEqual([])
  })
})

describe('useBlockSlashCommands handleSlashCommand', () => {
  it('sets todo state for /TODO command', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'todo', label: 'TODO' })
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: 'TODO',
    })
  })

  it('sets priority for /priority-high command', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'priority-high', label: 'PRIORITY 1' })
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: '1',
    })
  })

  it('opens date picker for /date command', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'date', label: 'DATE' })
    })

    expect(params.setDatePickerMode).toHaveBeenCalledWith('date')
    expect(params.setDatePickerOpen).toHaveBeenCalledWith(true)
  })

  it('opens date picker for /due command', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'due', label: 'DUE' })
    })

    expect(params.setDatePickerMode).toHaveBeenCalledWith('due')
    expect(params.setDatePickerOpen).toHaveBeenCalledWith(true)
  })

  it('opens date picker for /schedule command', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'schedule', label: 'SCHEDULED' })
    })

    expect(params.setDatePickerMode).toHaveBeenCalledWith('schedule')
    expect(params.setDatePickerOpen).toHaveBeenCalledWith(true)
  })

  it('does nothing when focusedBlockId is null', async () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'todo', label: 'TODO' })
    })

    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('shows error toast on set_todo_state failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'todo', label: 'TODO' })
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.setTaskStateFailed')
  })

  it('sets effort property for /effort command', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'effort-1h', label: 'EFFORT 1h' })
    })

    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'effort',
        valueText: '1h',
      }),
    )
  })

  it('sets repeat property for /repeat command', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'repeat-daily', label: 'REPEAT DAILY' })
    })

    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'repeat',
        valueText: 'daily',
      }),
    )
  })

  it('removes repeat for repeat-remove command', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'repeat-remove', label: 'REPEAT REMOVE' })
    })

    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'BLOCK_1',
      key: 'repeat',
    })
  })

  it('opens repeat-until date picker', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'repeat-until', label: 'REPEAT UNTIL' })
    })

    expect(params.setDatePickerMode).toHaveBeenCalledWith('repeat-until')
    expect(params.setDatePickerOpen).toHaveBeenCalledWith(true)
  })

  it('sets repeat limit for repeat-limit-5 command', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'repeat-limit-5', label: 'REPEAT LIMIT 5' })
    })

    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'repeat-count',
        valueNum: 5,
      }),
    )
  })

  it('removes repeat limit for repeat-limit-remove', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({
        id: 'repeat-limit-remove',
        label: 'REPEAT LIMIT REMOVE',
      })
    })

    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'BLOCK_1',
      key: 'repeat-count',
    })
  })
})

describe('useBlockSlashCommands handleCheckboxSyntax', () => {
  it('sets TODO state optimistically', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    act(() => {
      result.current.handleCheckboxSyntax('TODO')
    })

    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBe('TODO')
  })

  it('sets DONE state optimistically', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    act(() => {
      result.current.handleCheckboxSyntax('DONE')
    })

    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBe('DONE')
  })

  it('does nothing when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    act(() => {
      result.current.handleCheckboxSyntax('TODO')
    })

    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})

describe('useBlockSlashCommands handleTemplateSelect', () => {
  it('closes template picker on select', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleTemplateSelect('TEMPLATE_1')
    })

    expect(result.current.templatePickerOpen).toBe(false)
  })

  it('does nothing when focusedBlockId is null', async () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleTemplateSelect('TEMPLATE_1')
    })

    expect(params.load).not.toHaveBeenCalled()
  })
})

describe('useBlockSlashCommands undo notifications', () => {
  const onNewActionSpy = vi.fn()

  beforeEach(() => {
    onNewActionSpy.mockClear()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })
  })

  it('calls onNewAction after successful todo state set', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'todo', label: 'TODO' })
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('does not call onNewAction when rootParentId is null', async () => {
    const params = makeDefaultParams({ rootParentId: null })
    const { result } = renderHook(() => useBlockSlashCommands(params), { wrapper })

    await act(async () => {
      await result.current.handleSlashCommand({ id: 'todo', label: 'TODO' })
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })
})

describe('useBlockSlashCommands handleSlashCommand stability (#MAINT-10)', () => {
  it('keeps handleSlashCommand identity stable when rootParentId/t/rovingEditor change', () => {
    // rootParentId, t, rovingEditor are all accessed via refs inside the callback
    // (not listed in deps). Changing these props must NOT rebuild the callback.
    const params1 = makeDefaultParams({ rootParentId: 'PAGE_1' })
    const { result, rerender } = renderHook(
      ({ params }: { params: ReturnType<typeof makeDefaultParams> }) =>
        useBlockSlashCommands(params),
      { wrapper, initialProps: { params: params1 } },
    )
    const firstRef = result.current.handleSlashCommand

    // Change rootParentId (via ref)
    const params2 = makeDefaultParams({ rootParentId: 'PAGE_2' })
    rerender({ params: params2 })
    expect(result.current.handleSlashCommand).toBe(firstRef)

    // Change t (via ref)
    const params3 = makeDefaultParams({ rootParentId: 'PAGE_2', t: vi.fn((k: string) => k) })
    rerender({ params: params3 })
    expect(result.current.handleSlashCommand).toBe(firstRef)

    // Change rovingEditor (via ref)
    const params4 = makeDefaultParams({
      rootParentId: 'PAGE_2',
      rovingEditor: {
        editor: null,
        mount: vi.fn() as unknown as (blockId: string, markdown: string) => void,
      },
    })
    rerender({ params: params4 })
    expect(result.current.handleSlashCommand).toBe(firstRef)
  })

  it('rebuilds handleSlashCommand only when focusedBlockId changes (the real dep)', () => {
    const params1 = makeDefaultParams({ focusedBlockId: 'BLOCK_A' })
    const { result, rerender } = renderHook(
      ({ params }: { params: ReturnType<typeof makeDefaultParams> }) =>
        useBlockSlashCommands(params),
      { wrapper, initialProps: { params: params1 } },
    )
    const firstRef = result.current.handleSlashCommand

    const params2 = makeDefaultParams({ focusedBlockId: 'BLOCK_B' })
    rerender({ params: params2 })
    expect(result.current.handleSlashCommand).not.toBe(firstRef)
  })

  it('reads the latest rootParentId via ref even though it is not in deps', async () => {
    // onNewAction is called with the latest rootParentId, proving the ref
    // captures the current value without rebuilding the callback.
    const onNewActionSpy = vi.fn()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    const params1 = makeDefaultParams({ rootParentId: 'PAGE_INITIAL' })
    const { result, rerender } = renderHook(
      ({ params }: { params: ReturnType<typeof makeDefaultParams> }) =>
        useBlockSlashCommands(params),
      { wrapper, initialProps: { params: params1 } },
    )
    const callbackRef = result.current.handleSlashCommand

    // Update rootParentId — callback identity should be stable.
    const params2 = makeDefaultParams({ rootParentId: 'PAGE_UPDATED' })
    rerender({ params: params2 })
    expect(result.current.handleSlashCommand).toBe(callbackRef)

    // Invoking the callback should use the LATEST rootParentId (via ref).
    await act(async () => {
      await result.current.handleSlashCommand({ id: 'todo', label: 'TODO' })
    })
    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_UPDATED')
  })
})
