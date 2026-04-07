import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { announce } from '../../lib/announcer'
import type { FlatBlock } from '../../lib/tree-utils'
import { useBlockKeyboardHandlers } from '../useBlockKeyboardHandlers'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))
vi.mock('../../lib/announcer', () => ({ announce: vi.fn() }))
vi.mock('../../editor/markdown-serializer', () => ({
  parse: vi.fn((s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  })),
  serialize: vi.fn(() => 'content'),
}))
vi.mock('../../editor/types', () => ({
  pmEndOfFirstBlock: vi.fn(() => 1),
}))

const mockedAnnounce = vi.mocked(announce)

function makeFlatBlock(id: string, depth = 0, content = `Block ${id}`): FlatBlock {
  return {
    id,
    block_type: 'content',
    content,
    parent_id: null,
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    depth,
  }
}

function makeDefaultParams(overrides?: Partial<Parameters<typeof useBlockKeyboardHandlers>[0]>) {
  return {
    focusedBlockId: 'B' as string | null,
    collapsedVisible: [
      makeFlatBlock('A', 0, 'Alpha'),
      makeFlatBlock('B', 0, 'Beta'),
      makeFlatBlock('C', 0, 'Charlie'),
    ],
    rovingEditor: {
      editor: null as null,
      mount: vi.fn(),
      unmount: vi.fn(() => null as string | null),
      getMarkdown: vi.fn(() => null as string | null),
    },
    setFocused: vi.fn(),
    handleFlush: vi.fn(() => null as string | null),
    remove: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    indent: vi.fn(async () => {}),
    dedent: vi.fn(async () => {}),
    moveUp: vi.fn(async () => {}),
    moveDown: vi.fn(async () => {}),
    createBelow: vi.fn(async () => 'NEW_1' as string | null),
    justCreatedBlockIds: { current: new Set<string>() },
    discardDraft: vi.fn(),
    t: vi.fn((key: string) => key),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useBlockKeyboardHandlers handleFocusPrev', () => {
  it('focuses previous block', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleFocusPrev()
    })

    expect(params.setFocused).toHaveBeenCalledWith('A')
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('A', 'Alpha')
  })

  it('announces the block being edited', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleFocusPrev()
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('Editing block: Alpha')
  })

  it('does nothing when at first block', () => {
    const params = makeDefaultParams({ focusedBlockId: 'A' })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleFocusPrev()
    })

    expect(params.setFocused).not.toHaveBeenCalled()
  })

  it('announces empty block for block with no content', () => {
    const params = makeDefaultParams({
      focusedBlockId: 'B',
      collapsedVisible: [makeFlatBlock('A', 0, ''), makeFlatBlock('B', 0, 'Beta')],
    })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleFocusPrev()
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('Editing block: empty block')
  })
})

describe('useBlockKeyboardHandlers handleFocusNext', () => {
  it('focuses next block', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleFocusNext()
    })

    expect(params.setFocused).toHaveBeenCalledWith('C')
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('C', 'Charlie')
  })

  it('does nothing when at last block', () => {
    const params = makeDefaultParams({ focusedBlockId: 'C' })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleFocusNext()
    })

    expect(params.setFocused).not.toHaveBeenCalled()
  })
})

describe('useBlockKeyboardHandlers handleDeleteBlock', () => {
  it('deletes focused block and focuses previous', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleDeleteBlock()
    })

    expect(params.rovingEditor.unmount).toHaveBeenCalled()
    expect(params.remove).toHaveBeenCalledWith('B')
    expect(params.setFocused).toHaveBeenCalledWith('A')
    expect(mockedAnnounce).toHaveBeenCalledWith('Block deleted')
  })

  it('focuses next block when deleting first block', () => {
    const params = makeDefaultParams({ focusedBlockId: 'A' })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleDeleteBlock()
    })

    expect(params.setFocused).toHaveBeenCalledWith('B')
  })

  it('prevents deletion of last remaining block', () => {
    const params = makeDefaultParams({
      collapsedVisible: [makeFlatBlock('A')],
      focusedBlockId: 'A',
    })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleDeleteBlock()
    })

    expect(params.remove).not.toHaveBeenCalled()
    expect(params.t).toHaveBeenCalledWith('blockTree.cannotDeleteLastBlock')
  })

  it('does nothing when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleDeleteBlock()
    })

    expect(params.remove).not.toHaveBeenCalled()
  })

  it('sets focused to null when single block after delete', () => {
    const params = makeDefaultParams({
      collapsedVisible: [makeFlatBlock('A'), makeFlatBlock('B')],
      focusedBlockId: 'B',
    })

    params.remove = vi.fn(async () => {
      params.collapsedVisible.splice(1, 1)
    })

    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleDeleteBlock()
    })

    expect(params.setFocused).toHaveBeenCalledWith('A')
  })

  it('does not delete when delete is already in progress', () => {
    const params = makeDefaultParams()
    // Make remove block so deleteInProgress stays true within the same synchronous act
    let removeCallCount = 0
    params.remove = vi.fn(async () => {
      removeCallCount++
    })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleDeleteBlock()
      result.current.handleDeleteBlock()
    })

    expect(removeCallCount).toBe(1)
  })
})

describe('useBlockKeyboardHandlers handleIndent', () => {
  it('flushes and indents focused block', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleIndent()
    })

    expect(params.handleFlush).toHaveBeenCalled()
    expect(params.indent).toHaveBeenCalledWith('B')
    expect(mockedAnnounce).toHaveBeenCalledWith('Block indented')
  })

  it('does nothing when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleIndent()
    })

    expect(params.indent).not.toHaveBeenCalled()
  })
})

describe('useBlockKeyboardHandlers handleDedent', () => {
  it('flushes and dedents focused block', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleDedent()
    })

    expect(params.handleFlush).toHaveBeenCalled()
    expect(params.dedent).toHaveBeenCalledWith('B')
    expect(mockedAnnounce).toHaveBeenCalledWith('Block outdented')
  })
})

describe('useBlockKeyboardHandlers handleMoveUp/Down', () => {
  it('flushes and moves block up', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleMoveUp()
    })

    expect(params.handleFlush).toHaveBeenCalled()
    expect(params.moveUp).toHaveBeenCalledWith('B')
    expect(mockedAnnounce).toHaveBeenCalledWith('Block moved up')
  })

  it('flushes and moves block down', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleMoveDown()
    })

    expect(params.handleFlush).toHaveBeenCalled()
    expect(params.moveDown).toHaveBeenCalledWith('B')
    expect(mockedAnnounce).toHaveBeenCalledWith('Block moved down')
  })

  it('handleMoveUp does nothing when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleMoveUp()
    })

    expect(params.moveUp).not.toHaveBeenCalled()
  })
})

describe('useBlockKeyboardHandlers handleMoveUpById/DownById', () => {
  it('flushes and moves block by id', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleMoveUpById('C')
    })

    expect(params.handleFlush).toHaveBeenCalled()
    expect(params.moveUp).toHaveBeenCalledWith('C')
  })

  it('flushes and moves block down by id', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleMoveDownById('A')
    })

    expect(params.handleFlush).toHaveBeenCalled()
    expect(params.moveDown).toHaveBeenCalledWith('A')
  })
})

describe('useBlockKeyboardHandlers handleMergeWithPrev', () => {
  it('merges with previous block', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.edit).toHaveBeenCalledWith('A', 'AlphaBeta')
    expect(params.remove).toHaveBeenCalledWith('B')
    expect(params.setFocused).toHaveBeenCalledWith('A')
  })

  it('does nothing when at first block', async () => {
    const params = makeDefaultParams({ focusedBlockId: 'A' })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.edit).not.toHaveBeenCalled()
  })

  it('does nothing when focusedBlockId is null', async () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.edit).not.toHaveBeenCalled()
  })

  it('re-mounts editor on merge failure', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    params.edit = vi.fn(async () => {
      throw new Error('fail')
    })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'Beta')
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.mergeBlocksFailed')
  })

  it('reverts edit when remove fails after successful edit', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    params.edit = vi.fn(async () => {})
    params.remove = vi.fn(async () => {
      throw new Error('remove failed')
    })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.edit).toHaveBeenCalledTimes(2)
    expect(params.edit).toHaveBeenNthCalledWith(1, 'A', 'AlphaBeta')
    expect(params.edit).toHaveBeenNthCalledWith(2, 'A', 'Alpha')
    expect(params.rovingEditor.mount).toHaveBeenCalledWith('B', 'Beta')
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.mergeBlocksFailed')
  })

  it('does not revert when edit itself fails', async () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'Beta')
    params.edit = vi.fn(async () => {
      throw new Error('edit failed')
    })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleMergeWithPrev()
    })

    expect(params.edit).toHaveBeenCalledTimes(1)
    expect(params.remove).not.toHaveBeenCalled()
  })
})

describe('useBlockKeyboardHandlers handleMergeById', () => {
  it('merges block by id with previous', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.edit).toHaveBeenCalledWith('B', 'BetaCharlie')
    expect(params.remove).toHaveBeenCalledWith('C')
    expect(params.setFocused).toHaveBeenCalledWith('B')
  })

  it('does nothing for first block', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleMergeById('A')
    })

    expect(params.edit).not.toHaveBeenCalled()
  })

  it('unmounts editor when merging focused block', async () => {
    const params = makeDefaultParams({ focusedBlockId: 'C' })
    params.rovingEditor.unmount = vi.fn(() => 'Edited Charlie')
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.rovingEditor.unmount).toHaveBeenCalled()
    expect(params.edit).toHaveBeenCalledWith('B', 'BetaEdited Charlie')
  })

  it('reverts edit when remove fails after successful edit', async () => {
    const params = makeDefaultParams()
    params.edit = vi.fn(async () => {})
    params.remove = vi.fn(async () => {
      throw new Error('remove failed')
    })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.edit).toHaveBeenCalledTimes(2)
    expect(params.edit).toHaveBeenNthCalledWith(1, 'B', 'BetaCharlie')
    expect(params.edit).toHaveBeenNthCalledWith(2, 'B', 'Beta')
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.mergeBlocksFailed')
  })

  it('does not revert when edit itself fails', async () => {
    const params = makeDefaultParams()
    params.edit = vi.fn(async () => {
      throw new Error('edit failed')
    })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleMergeById('C')
    })

    expect(params.edit).toHaveBeenCalledTimes(1)
    expect(params.remove).not.toHaveBeenCalled()
  })
})

describe('useBlockKeyboardHandlers handleEnterSave', () => {
  it('flushes and creates block below', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.handleFlush).toHaveBeenCalled()
    expect(params.createBelow).toHaveBeenCalledWith('B')
    expect(params.setFocused).toHaveBeenCalledWith('NEW_1')
  })

  it('adds new block to justCreatedBlockIds', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.justCreatedBlockIds.current.has('NEW_1')).toBe(true)
  })

  it('does nothing when focusedBlockId is null', async () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.createBelow).not.toHaveBeenCalled()
  })

  it('does not set focused when createBelow returns null', async () => {
    const params = makeDefaultParams()
    params.createBelow = vi.fn(async () => null)
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    await act(async () => {
      await result.current.handleEnterSave()
    })

    expect(params.setFocused).not.toHaveBeenCalled()
  })
})

describe('useBlockKeyboardHandlers handleEscapeCancel', () => {
  it('unmounts editor and unfocuses', () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => 'changed content')
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.rovingEditor.unmount).toHaveBeenCalled()
    expect(params.setFocused).toHaveBeenCalledWith(null)
    expect(vi.mocked(toast)).toHaveBeenCalledWith('Changes discarded', { duration: 2000 })
  })

  it('does not show toast when no changes', () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => null)
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.setFocused).toHaveBeenCalledWith(null)
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })

  it('does nothing when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.rovingEditor.unmount).not.toHaveBeenCalled()
    expect(params.setFocused).not.toHaveBeenCalled()
  })

  it('removes just-created empty block on Escape', () => {
    const params = makeDefaultParams({
      focusedBlockId: 'B',
      collapsedVisible: [
        makeFlatBlock('A', 0, 'Alpha'),
        makeFlatBlock('B', 0, ''),
        makeFlatBlock('C', 0, 'Charlie'),
      ],
    })
    params.justCreatedBlockIds.current.add('B')
    params.rovingEditor.unmount = vi.fn(() => null)
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.remove).toHaveBeenCalledWith('B')
    expect(params.justCreatedBlockIds.current.has('B')).toBe(false)
    expect(params.setFocused).toHaveBeenCalledWith(null)
  })

  it('does not remove block that was not just created', () => {
    const params = makeDefaultParams({
      focusedBlockId: 'B',
      collapsedVisible: [
        makeFlatBlock('A', 0, 'Alpha'),
        makeFlatBlock('B', 0, ''),
        makeFlatBlock('C', 0, 'Charlie'),
      ],
    })
    // B is NOT in justCreatedBlockIds
    params.rovingEditor.unmount = vi.fn(() => null)
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.remove).not.toHaveBeenCalled()
    expect(params.setFocused).toHaveBeenCalledWith(null)
  })

  it('does not remove just-created block when user has typed content', () => {
    const params = makeDefaultParams({ focusedBlockId: 'B' })
    params.justCreatedBlockIds.current.add('B')
    // unmount returns non-null → user typed content that was discarded
    params.rovingEditor.unmount = vi.fn(() => 'some content')
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    // Block should NOT be removed because user had typed content
    expect(params.remove).not.toHaveBeenCalled()
    expect(params.setFocused).toHaveBeenCalledWith(null)
  })

  it('calls discardDraft with the focused block ID before unmount', () => {
    const params = makeDefaultParams()
    const callOrder: string[] = []
    params.discardDraft = vi.fn(() => {
      callOrder.push('discardDraft')
    })
    params.rovingEditor.unmount = vi.fn(() => {
      callOrder.push('unmount')
      return 'changed content'
    })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.discardDraft).toHaveBeenCalledWith('B')
    expect(callOrder).toEqual(['discardDraft', 'unmount'])
  })

  it('calls discardDraft even when no changes on Escape', () => {
    const params = makeDefaultParams()
    params.rovingEditor.unmount = vi.fn(() => null)
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.discardDraft).toHaveBeenCalledWith('B')
    expect(params.setFocused).toHaveBeenCalledWith(null)
  })

  it('does not call discardDraft when focusedBlockId is null', () => {
    const params = makeDefaultParams({ focusedBlockId: null })
    const { result } = renderHook(() => useBlockKeyboardHandlers(params))

    act(() => {
      result.current.handleEscapeCancel()
    })

    expect(params.discardDraft).not.toHaveBeenCalled()
  })
})
