/**
 * Tests for PageEditor component.
 *
 * Validates:
 *  - Renders PageHeader with correct props
 *  - Renders BlockTree with correct parentId
 *  - Add block button creates a new block
 *  - a11y compliance
 *  - Reloads blocks when pageId prop changes
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// ── Mock BlockTree ──────────────────────────────────────────────────
// BlockTree is heavy (DnD, TipTap, viewport observer). Mock it to a
// simple div that exposes the parentId prop for verification.
let capturedParentId: string | undefined
let capturedAutoCreateFirstBlock: boolean | undefined
vi.mock('../BlockTree', () => ({
  BlockTree: (props: { parentId?: string; autoCreateFirstBlock?: boolean }) => {
    capturedParentId = props.parentId
    capturedAutoCreateFirstBlock = props.autoCreateFirstBlock
    return (
      <div
        data-testid="block-tree"
        data-parent-id={props.parentId ?? ''}
        data-auto-create={props.autoCreateFirstBlock ?? true}
        className="block-tree"
      />
    )
  },
}))

// ── Mock PageHeader ─────────────────────────────────────────────────
let capturedPageHeaderProps: { pageId: string; title: string; onBack?: () => void } | null = null
vi.mock('../PageHeader', () => ({
  PageHeader: (props: { pageId: string; title: string; onBack?: () => void }) => {
    capturedPageHeaderProps = props
    return <div data-testid="page-header" data-page-id={props.pageId} data-title={props.title} />
  },
}))

// ── Mock panel components ───────────────────────────────────────────
let capturedLinkedRefsPageId: string | undefined
vi.mock('../LinkedReferences', () => ({
  LinkedReferences: (props: { pageId: string; onNavigateToPage?: unknown }) => {
    capturedLinkedRefsPageId = props.pageId
    return <div data-testid="linked-references" data-page-id={props.pageId} />
  },
}))

let capturedUnlinkedRefsProps: { pageId: string; pageTitle: string } | undefined
vi.mock('../UnlinkedReferences', () => ({
  UnlinkedReferences: (props: {
    pageId: string
    pageTitle: string
    onNavigateToPage?: unknown
  }) => {
    capturedUnlinkedRefsProps = { pageId: props.pageId, pageTitle: props.pageTitle }
    return (
      <div
        data-testid="unlinked-references"
        data-page-id={props.pageId}
        data-page-title={props.pageTitle}
      />
    )
  },
}))

let capturedDuePanelDate: string | undefined
vi.mock('../DuePanel', () => ({
  DuePanel: (props: { date: string; onNavigateToPage?: unknown }) => {
    capturedDuePanelDate = props.date
    return <div data-testid="due-panel" data-date={props.date} />
  },
}))

let capturedDonePanelDate: string | undefined
vi.mock('../DonePanel', () => ({
  DonePanel: (props: { date: string; onNavigateToPage?: unknown }) => {
    capturedDonePanelDate = props.date
    return <div data-testid="done-panel" data-date={props.date} />
  },
}))

// ── Mock PageMetadataBar ────────────────────────────────────────────
vi.mock('../PageMetadataBar', () => ({
  PageMetadataBar: (props: { blocks: unknown[]; pageId: string }) => (
    <div data-testid="page-metadata-bar" data-page-id={props.pageId} />
  ),
}))

// ── Mock lucide-react ───────────────────────────────────────────────
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <svg data-testid="arrow-left-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
}))

// ── Mock sonner ─────────────────────────────────────────────────────
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { toast } from 'sonner'

import { useBlockStore } from '../../stores/blocks'
import { useNavigationStore } from '../../stores/navigation'
import { pageBlockRegistry } from '../../stores/page-blocks'
import { useUndoStore } from '../../stores/undo'
import { PageEditor } from '../PageEditor'

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)

function makeBlock(id: string, content: string, parentId: string | null = null, position = 0) {
  return {
    id,
    block_type: 'content',
    content,
    parent_id: parentId,
    position,
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

beforeEach(() => {
  vi.clearAllMocks()
  capturedParentId = undefined
  capturedAutoCreateFirstBlock = undefined
  capturedLinkedRefsPageId = undefined
  capturedUnlinkedRefsProps = undefined
  capturedPageHeaderProps = null
  capturedDuePanelDate = undefined
  capturedDonePanelDate = undefined
  // Reset the Zustand stores to a clean state before each test
  useBlockStore.setState({
    focusedBlockId: null,
    selectedBlockIds: [],
  })
  pageBlockRegistry.clear()
  useUndoStore.setState({ pages: new Map() })
  useNavigationStore.setState({
    currentView: 'page-editor',
    tabs: [{ id: '0', pageStack: [{ pageId: 'PAGE_1', title: 'My Page' }], label: 'My Page' }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })
})

describe('PageEditor', () => {
  it('passes correct props to PageHeader', () => {
    const onBack = vi.fn()
    render(<PageEditor pageId="PAGE_1" title="My Test Page" onBack={onBack} />)

    expect(capturedPageHeaderProps).not.toBeNull()
    expect(capturedPageHeaderProps?.pageId).toBe('PAGE_1')
    expect(capturedPageHeaderProps?.title).toBe('My Test Page')
    expect(capturedPageHeaderProps?.onBack).toBe(onBack)
  })

  it('renders PageHeader component', () => {
    render(<PageEditor pageId="PAGE_1" title="My Test Page" />)

    const header = screen.getByTestId('page-header')
    expect(header).toBeInTheDocument()
    expect(header).toHaveAttribute('data-page-id', 'PAGE_1')
    expect(header).toHaveAttribute('data-title', 'My Test Page')
  })

  it('renders BlockTree with correct parentId', () => {
    render(<PageEditor pageId="PAGE_123" title="Test" />)

    const blockTree = screen.getByTestId('block-tree')
    expect(blockTree).toBeInTheDocument()
    expect(blockTree).toHaveAttribute('data-parent-id', 'PAGE_123')
    expect(capturedParentId).toBe('PAGE_123')
  })

  it('renders LinkedReferences with correct pageId', () => {
    render(<PageEditor pageId="PAGE_123" title="Test" />)

    const linkedRefs = screen.getByTestId('linked-references')
    expect(linkedRefs).toBeInTheDocument()
    expect(linkedRefs).toHaveAttribute('data-page-id', 'PAGE_123')
    expect(capturedLinkedRefsPageId).toBe('PAGE_123')
  })

  it('renders UnlinkedReferences with correct pageId and pageTitle', () => {
    render(<PageEditor pageId="PAGE_123" title="Test Title" />)

    const unlinkedRefs = screen.getByTestId('unlinked-references')
    expect(unlinkedRefs).toBeInTheDocument()
    expect(unlinkedRefs).toHaveAttribute('data-page-id', 'PAGE_123')
    expect(unlinkedRefs).toHaveAttribute('data-page-title', 'Test Title')
    expect(capturedUnlinkedRefsProps).toEqual({
      pageId: 'PAGE_123',
      pageTitle: 'Test Title',
    })
  })

  it('updates BlockTree parentId when pageId prop changes', () => {
    const { rerender } = render(<PageEditor pageId="PAGE_A" title="Page A" />)

    expect(capturedParentId).toBe('PAGE_A')

    rerender(<PageEditor pageId="PAGE_B" title="Page B" />)

    expect(capturedParentId).toBe('PAGE_B')
    const blockTree = screen.getByTestId('block-tree')
    expect(blockTree).toHaveAttribute('data-parent-id', 'PAGE_B')
  })

  it('renders Add block button', () => {
    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const addBtn = screen.getByRole('button', { name: /add block/i })
    expect(addBtn).toBeInTheDocument()
  })

  it('Add block button creates a new block when blocks exist', async () => {
    const user = userEvent.setup()

    // Mock createBlock response for the new block
    mockedInvoke.mockResolvedValueOnce({
      id: 'B2',
      block_type: 'content',
      content: '',
      parent_id: 'PAGE_1',
      position: 1,
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Pre-populate per-page store with a block (via registry after mount)
    act(() => {
      pageBlockRegistry.get('PAGE_1')?.setState({
        blocks: [makeBlock('B1', 'First block', 'PAGE_1', 0)],
      })
    })

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'content',
        content: '',
        parentId: 'PAGE_1',
        position: 1,
      })
    })

    // Should focus the new block
    await waitFor(() => {
      const state = useBlockStore.getState()
      expect(state.focusedBlockId).toBe('B2')
    })
  })

  it('Add block button creates first block when no blocks exist', async () => {
    const user = userEvent.setup()

    // Store starts empty (per-page store is fresh)

    // Mock createBlock response for the new block
    mockedInvoke.mockResolvedValueOnce({
      id: 'B1',
      block_type: 'content',
      content: '',
      parent_id: 'PAGE_1',
      position: 0,
    })
    // Mock the subsequent load(pageId) call
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock('B1', '', 'PAGE_1', 0)],
      next_cursor: null,
      has_more: false,
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'content',
        content: '',
        parentId: 'PAGE_1',
        position: null,
      })
    })
  })

  it('Add block button creates top-level block when page has nested blocks', async () => {
    const user = userEvent.setup()

    // Mock createBlock response — the new block should be under PAGE_1
    mockedInvoke.mockResolvedValueOnce({
      id: 'B4',
      block_type: 'content',
      content: '',
      parent_id: 'PAGE_1',
      position: 1,
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Pre-populate per-page store with a nested block tree:
    //   B1 (depth 0, parent PAGE_1)
    //     B2 (depth 1, parent B1)
    //       B3 (depth 2, parent B2)
    // The last entry in the flat tree is B3 (deeply nested).
    // "Add block" must create a top-level sibling of B1, NOT a sibling of B3.
    act(() => {
      pageBlockRegistry.get('PAGE_1')?.setState({
        blocks: [
          { ...makeBlock('B1', 'Top-level block', 'PAGE_1', 0), depth: 0 },
          { ...makeBlock('B2', 'Nested child', 'B1', 0), depth: 1 },
          { ...makeBlock('B3', 'Deeply nested', 'B2', 0), depth: 2 },
        ],
      })
    })

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    await waitFor(() => {
      // Must create under PAGE_1 (top-level), not under B2 (nested parent)
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'content',
        content: '',
        parentId: 'PAGE_1',
        position: 1,
      })
    })

    // Should focus the new block
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('B4')
    })
  })

  it('Add block button shows toast on failure when no blocks exist', async () => {
    const user = userEvent.setup()

    // Per-page store starts empty

    mockedInvoke.mockRejectedValueOnce(new Error('backend error'))

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to create block')
    })
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <PageEditor pageId="PAGE_1" title="Accessible Page" onBack={() => {}} />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations without back button', async () => {
    const { container } = render(<PageEditor pageId="PAGE_1" title="No Back Page" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

describe('PageEditor undo/redo integration', () => {
  it('clears undo state for the page on unmount', () => {
    // Seed undo state for the page
    const pages = new Map()
    pages.set('PAGE_1', { redoStack: [], undoDepth: 3 })
    useUndoStore.setState({ pages })

    const { unmount } = render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Undo state exists before unmount
    expect(useUndoStore.getState().pages.has('PAGE_1')).toBe(true)

    unmount()

    // After unmount, clearPage should have removed the entry
    expect(useUndoStore.getState().pages.has('PAGE_1')).toBe(false)
  })

  it('clears undo state for the old page when pageId changes', () => {
    // Seed undo state for both pages
    const pages = new Map()
    pages.set('PAGE_A', { redoStack: [], undoDepth: 2 })
    pages.set('PAGE_B', { redoStack: [], undoDepth: 1 })
    useUndoStore.setState({ pages })

    const { rerender } = render(<PageEditor pageId="PAGE_A" title="Page A" />)

    // PAGE_A state exists
    expect(useUndoStore.getState().pages.has('PAGE_A')).toBe(true)

    // Navigate to PAGE_B — cleanup effect runs for PAGE_A
    rerender(<PageEditor pageId="PAGE_B" title="Page B" />)

    // PAGE_A should be cleared, PAGE_B should still exist
    expect(useUndoStore.getState().pages.has('PAGE_A')).toBe(false)
    expect(useUndoStore.getState().pages.has('PAGE_B')).toBe(true)
  })
})

describe('PageEditor background pointerdown (UX-M9)', () => {
  it('pointerdown on page background closes active editor', () => {
    useBlockStore.setState({
      focusedBlockId: 'B1',
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // The outer container has class "page-editor"
    const container = document.querySelector('.page-editor') as HTMLElement
    fireEvent.pointerDown(container)

    expect(useBlockStore.getState().focusedBlockId).toBeNull()
  })

  it('pointerdown on child element does not close editor', () => {
    useBlockStore.setState({
      focusedBlockId: 'B1',
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Click on a child (e.g. the block-tree mock div)
    const child = screen.getByTestId('block-tree')
    fireEvent.pointerDown(child)

    // Should NOT close the editor since target !== currentTarget
    expect(useBlockStore.getState().focusedBlockId).toBe('B1')
  })
})

describe('PageEditor BlockTree auto-creation prop', () => {
  it('renders BlockTree with default autoCreateFirstBlock (not explicitly set)', () => {
    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const blockTree = screen.getByTestId('block-tree')
    expect(blockTree).toBeInTheDocument()
    // PageEditor does not pass autoCreateFirstBlock, so BlockTree uses the default (true)
    expect(capturedAutoCreateFirstBlock).toBeUndefined()
  })

  it('manual add block works when page is empty and creates block directly', async () => {
    const user = userEvent.setup()

    // Per-page store starts empty

    // Mock createBlock and subsequent load
    mockedInvoke.mockResolvedValueOnce({
      id: 'FIRST_BLOCK',
      block_type: 'content',
      content: '',
      parent_id: 'PAGE_1',
      position: 0,
    })
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock('FIRST_BLOCK', '', 'PAGE_1', 0)],
      next_cursor: null,
      has_more: false,
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'content',
        content: '',
        parentId: 'PAGE_1',
        position: null,
      })
    })

    // Should focus the new block
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('FIRST_BLOCK')
    })
  })
})

describe('PageEditor date-page panels (B-1)', () => {
  it('renders DuePanel and DonePanel for date-formatted page title', () => {
    render(<PageEditor pageId="PAGE_DATE" title="2026-04-06" />)

    expect(screen.getByTestId('due-panel')).toBeInTheDocument()
    expect(screen.getByTestId('due-panel')).toHaveAttribute('data-date', '2026-04-06')
    expect(screen.getByTestId('done-panel')).toBeInTheDocument()
    expect(screen.getByTestId('done-panel')).toHaveAttribute('data-date', '2026-04-06')
    expect(capturedDuePanelDate).toBe('2026-04-06')
    expect(capturedDonePanelDate).toBe('2026-04-06')
  })

  it('does not render DuePanel/DonePanel for non-date page title', () => {
    render(<PageEditor pageId="PAGE_1" title="My Notes" />)

    expect(screen.queryByTestId('due-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('done-panel')).not.toBeInTheDocument()
  })

  it('does not render DuePanel/DonePanel for partial date title', () => {
    render(<PageEditor pageId="PAGE_1" title="2026-04" />)

    expect(screen.queryByTestId('due-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('done-panel')).not.toBeInTheDocument()
  })
})
