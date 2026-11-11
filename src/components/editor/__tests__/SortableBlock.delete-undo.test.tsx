/**
 * The context menu's Delete takes the swipe delete's "Block deleted · Undo"
 * toast (#6547): one rule for every explicit delete of a block.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { TestBlockActionsOverride } from '@/components/__tests__/_test-utils/TestBlockActionsOverride'
import type { BlockActions } from '@/components/block-tree/use-block-actions'
import { SortableBlock } from '@/components/editor/SortableBlock'
import { PageBlockStoreProvider } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}))

vi.mock('@/components/editor/EditableBlock', () => ({
  EditableBlock: (props: { blockId: string }) => <div>{props.blockId}</div>,
}))

/** The action bag SortableBlock hands its context menu. */
const menuActions = vi.hoisted(() => ({ current: null as BlockActions | null }))

vi.mock('@/components/editor/BlockContextMenu', () => ({
  BlockContextMenu: ({ actions }: { actions: BlockActions }) => {
    menuActions.current = actions
    return <div role="menu" aria-label="Block actions" />
  },
}))

function rovingEditor() {
  return {
    editor: null,
    mount: vi.fn(),
    updateListMarker: vi.fn(),
    listMarker: vi.fn(() => ({ style: 'none' as const, ordinal: undefined })),
    unmount: vi.fn(() => null),
    activeBlockId: null,
    getMarkdown: vi.fn(() => null),
    splitAtCaret: vi.fn(() => null),
    originalMarkdown: '',
    setOnUpdate: vi.fn(),
    markCommitted: vi.fn(),
    storedMarkdown: '',
    readAsTyped: vi.fn(),
  }
}

const mockedInvoke = vi.mocked(invoke)
const mockedToast = vi.mocked(toast)
const originalUndoDeleteOf = useUndoStore.getState().undoDeleteOf

/** Render one row in page PAGE_1, open its context menu and run the menu's Delete. */
function deleteFromMenu(onDelete: (id: string) => void): HTMLElement {
  const { container } = render(
    <PageBlockStoreProvider pageId="PAGE_1">
      <TestBlockActionsOverride actions={{ onDelete }}>
        <SortableBlock
          blockId="BLOCK_A"
          content="a"
          isFocused={false}
          rovingEditor={rovingEditor()}
        />
      </TestBlockActionsOverride>
    </PageBlockStoreProvider>,
  )
  fireEvent.contextMenu(screen.getByTestId('sortable-block'), { clientX: 10, clientY: 10 })
  expect(screen.getByRole('menu', { name: 'Block actions' })).toBeInTheDocument()
  act(() => {
    menuActions.current?.onDelete?.('BLOCK_A')
  })
  return container
}

/** The Undo action of the toast the delete raised. */
function undoAction(): () => void {
  expect(mockedToast).toHaveBeenCalledOnce()
  const [message, opts]: unknown[] = mockedToast.mock.calls[0] ?? []
  expect(message).toBe('Block deleted')
  return (opts as { action: { onClick: () => void } }).action.onClick
}

beforeEach(() => {
  vi.clearAllMocks()
  menuActions.current = null
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
})

afterEach(() => {
  useUndoStore.setState({ ...useUndoStore.getState(), undoDeleteOf: originalUndoDeleteOf })
})

describe('SortableBlock context-menu Delete (#6547)', () => {
  it('deletes the block and offers an Undo that reverses that delete', async () => {
    const onDelete = vi.fn()
    const undoDeleteOf = vi.fn().mockResolvedValue(undefined)
    useUndoStore.setState({ ...useUndoStore.getState(), undoDeleteOf })

    deleteFromMenu(onDelete)

    expect(onDelete).toHaveBeenCalledExactlyOnceWith('BLOCK_A')
    await act(async () => {
      undoAction()()
    })
    expect(undoDeleteOf).toHaveBeenCalledExactlyOnceWith('PAGE_1', 'BLOCK_A', expect.any(Function))
  })

  it('reports a failed Undo instead of dropping it', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_page_history: () => {
          throw new Error('history unavailable')
        },
      }),
    )

    deleteFromMenu(vi.fn())
    await act(async () => {
      undoAction()()
    })

    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith('Undo failed')
    })
  })

  it('has no a11y violations with the menu open', async () => {
    const container = deleteFromMenu(vi.fn())
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
