import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { useBlockPageHistory } from '@/components/block-tree/use-block-page-history'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'
import { createPageBlockStore } from '@/stores/page-blocks'

const performPageUndo = vi.fn(async (_pageId: string) => true)
const performPageRedo = vi.fn(async (_pageId: string) => true)
vi.mock('@/hooks/useUndoShortcuts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useUndoShortcuts')>()),
  performPageUndo: (pageId: string) => performPageUndo(pageId),
  performPageRedo: (pageId: string) => performPageRedo(pageId),
}))

function makeHandle(blockId: string): RovingEditorHandle {
  return {
    editor: null,
    mount: vi.fn(),
    updateListMarker: vi.fn(),
    listMarker: vi.fn(() => ({ style: 'none' as const, ordinal: undefined })),
    unmount: vi.fn(() => null),
    activeBlockId: blockId,
    getMarkdown: vi.fn(() => ''),
    splitAtCaret: vi.fn(() => null),
    originalMarkdown: '',
    setOnUpdate: vi.fn(),
    markCommitted: vi.fn(),
    storedMarkdown: '',
    readAsTyped: vi.fn(),
  }
}

function renderPageHistory(
  handle: RovingEditorHandle,
  edit: (blockId: string, content: string) => Promise<boolean> = vi.fn(),
) {
  const pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({ blocks: [makeBlock({ id: 'A', content: 'restored' })] })
  pageStore.setState({ blocksById: new Map(pageStore.getState().blocks.map((b) => [b.id, b])) })
  const { result } = renderHook(() =>
    useBlockPageHistory({
      rovingEditorRef: { current: handle },
      rootParentId: 'PAGE_1',
      pageStore,
      visibleIdsRef: { current: ['A'] },
      preserveEmptyBlockIdsRef: { current: new Set<string>() },
      edit,
      splitBlock: vi.fn(),
    }),
  )
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
  useBlockStore.setState({ focusedBlockId: 'A' })
})

describe('useBlockPageHistory (#6556)', () => {
  it('runs the page undo for the page and puts the editor back on the block', async () => {
    useNavigationStore.setState({ currentView: 'page-editor' })
    const handle = makeHandle('A')
    const pageHistory = renderPageHistory(handle)

    let took = false
    act(() => {
      took = pageHistory.current('undo')
    })

    expect(took).toBe(true)
    await waitFor(() => expect(handle.mount).toHaveBeenCalledWith('A', 'restored'))
    expect(performPageUndo.mock.calls).toEqual([['PAGE_1']])
    expect(performPageRedo).not.toHaveBeenCalled()
    expect(useBlockStore.getState().focusedBlockId).toBe('A')
  })

  it('keeps the typed text and undoes nothing when its save fails', async () => {
    useNavigationStore.setState({ currentView: 'page-editor' })
    const handle = makeHandle('A')
    handle.originalMarkdown = 'loaded'
    vi.mocked(handle.unmount).mockReturnValue('typed')
    const pageHistory = renderPageHistory(handle, async () => false)

    act(() => {
      pageHistory.current('undo')
    })

    await waitFor(() => expect(handle.mount).toHaveBeenCalledWith('A', 'typed'))
    // Baseline back to the loaded text, so the editor still counts the typing as unsaved.
    expect(handle.markCommitted).toHaveBeenCalledWith('loaded')
    expect(performPageUndo).not.toHaveBeenCalled()
    expect(useBlockStore.getState().focusedBlockId).toBe('A')
  })

  it('declines in the journal, leaving the editor alone', () => {
    useNavigationStore.setState({ currentView: 'journal' })
    const handle = makeHandle('A')
    const pageHistory = renderPageHistory(handle)

    expect(pageHistory.current('undo')).toBe(false)
    expect(handle.unmount).not.toHaveBeenCalled()
    expect(performPageUndo).not.toHaveBeenCalled()
  })
})
