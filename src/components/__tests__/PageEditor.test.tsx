/**
 * Tests for PageEditor component.
 *
 * Validates:
 *  - Renders PageHeader with correct props
 *  - Renders BlockTree with correct parentId
 *  - Add block button creates a new block
 *  - a11y compliance
 *  - Reloads blocks when pageId prop changes
 *  - Detail panel: hidden when no block focused
 *  - Detail panel: renders when a block is focused
 *  - Detail panel: tab switching between history/properties
 *  - Detail panel: persists when focusedBlockId becomes null
 *  - Detail panel: collapsible
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// ── Mock BlockTree ──────────────────────────────────────────────────
// BlockTree is heavy (DnD, TipTap, viewport observer). Mock it to a
// simple div that exposes the parentId prop for verification.
let capturedParentId: string | undefined
vi.mock('../BlockTree', () => ({
  BlockTree: (props: { parentId?: string }) => {
    capturedParentId = props.parentId
    return (
      <div data-testid="block-tree" data-parent-id={props.parentId ?? ''} className="block-tree" />
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
// Panels are tested independently; here we just verify they receive
// the correct blockId prop.
let capturedHistoryBlockId: string | null = null

let capturedLinkedRefsPageId: string | undefined
vi.mock('../LinkedReferences', () => ({
  LinkedReferences: (props: { pageId: string; onNavigateToPage?: unknown }) => {
    capturedLinkedRefsPageId = props.pageId
    return <div data-testid="linked-references" data-page-id={props.pageId} />
  },
}))

vi.mock('../HistoryPanel', () => ({
  HistoryPanel: (props: { blockId: string | null }) => {
    capturedHistoryBlockId = props.blockId
    return <div data-testid="history-panel" data-block-id={props.blockId ?? ''} />
  },
}))

vi.mock('../PropertiesPanel', () => ({
  PropertiesPanel: (props: { blockId: string | null }) => {
    return <div data-testid="properties-panel" data-block-id={props.blockId ?? ''} />
  },
}))

// ── Mock lucide-react ───────────────────────────────────────────────
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <svg data-testid="arrow-left-icon" />,
  ChevronDown: () => <svg data-testid="chevron-down-icon" />,
  ChevronUp: () => <svg data-testid="chevron-up-icon" />,
  History: () => <svg data-testid="history-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
}))

// ── Mock sonner ─────────────────────────────────────────────────────
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { toast } from 'sonner'

import { useBlockStore } from '../../stores/blocks'
import { useNavigationStore } from '../../stores/navigation'
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
    archived_at: null,
    is_conflict: false,
    conflict_type: null,
    depth: 0,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedParentId = undefined
  capturedHistoryBlockId = null
  capturedLinkedRefsPageId = undefined
  capturedPageHeaderProps = null
  // Reset the Zustand stores to a clean state before each test
  useBlockStore.setState({
    blocks: [],
    rootParentId: null,
    focusedBlockId: null,
    loading: false,
  })
  useUndoStore.setState({ pages: new Map() })
  useNavigationStore.setState({
    currentView: 'page-editor',
    pageStack: [{ pageId: 'PAGE_1', title: 'My Page' }],
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

    // Pre-populate store with a block
    useBlockStore.setState({
      blocks: [makeBlock('B1', 'First block', 'PAGE_1', 0)],
      focusedBlockId: null,
      loading: false,
    })

    // Mock createBlock response for the new block
    mockedInvoke.mockResolvedValueOnce({
      id: 'B2',
      block_type: 'content',
      content: '',
      parent_id: 'PAGE_1',
      position: 1,
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

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

    // Store starts empty
    useBlockStore.setState({
      blocks: [],
      focusedBlockId: null,
      loading: false,
    })

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
        position: 0,
      })
    })
  })

  it('Add block button creates top-level block when page has nested blocks', async () => {
    const user = userEvent.setup()

    // Pre-populate store with a nested block tree:
    //   B1 (depth 0, parent PAGE_1)
    //     B2 (depth 1, parent B1)
    //       B3 (depth 2, parent B2)
    // The last entry in the flat tree is B3 (deeply nested).
    // "Add block" must create a top-level sibling of B1, NOT a sibling of B3.
    useBlockStore.setState({
      blocks: [
        { ...makeBlock('B1', 'Top-level block', 'PAGE_1', 0), depth: 0 },
        { ...makeBlock('B2', 'Nested child', 'B1', 0), depth: 1 },
        { ...makeBlock('B3', 'Deeply nested', 'B2', 0), depth: 2 },
      ],
      focusedBlockId: null,
      loading: false,
    })

    // Mock createBlock response — the new block should be under PAGE_1
    mockedInvoke.mockResolvedValueOnce({
      id: 'B4',
      block_type: 'content',
      content: '',
      parent_id: 'PAGE_1',
      position: 1,
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

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

    useBlockStore.setState({
      blocks: [],
      focusedBlockId: null,
      loading: false,
    })

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

describe('PageEditor detail panel', () => {
  it('does not show detail panel when no block has been focused', () => {
    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    expect(screen.queryByTestId('detail-panel')).not.toBeInTheDocument()
  })

  it('shows tab bar but NOT panel content when a block is focused (collapsed by default)', () => {
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Tab bar should be visible
    const panel = screen.getByTestId('detail-panel')
    expect(panel).toBeInTheDocument()

    // Tab buttons should be visible
    expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /properties/i })).toBeInTheDocument()

    // Panel content should NOT be auto-opened
    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('properties-panel')).not.toBeInTheDocument()
  })

  it('passes correct blockId to panel components after tab click', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_42' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Click a tab to open panel
    await user.click(screen.getByRole('tab', { name: /history/i }))

    expect(capturedHistoryBlockId).toBe('BLOCK_42')
  })

  it('switches between history and properties tabs', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open History tab first (panel is collapsed by default)
    await user.click(screen.getByRole('tab', { name: /history/i }))
    expect(screen.getByTestId('history-panel')).toBeInTheDocument()

    // Switch to Properties tab
    await user.click(screen.getByRole('tab', { name: /properties/i }))
    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('properties-panel')).toBeInTheDocument()

    // Switch back to History tab
    await user.click(screen.getByRole('tab', { name: /history/i }))
    expect(screen.getByTestId('history-panel')).toBeInTheDocument()
    expect(capturedHistoryBlockId).toBe('BLOCK_1')
  })

  it('persists panel when focusedBlockId becomes null', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    const { rerender } = render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open tab explicitly
    await user.click(screen.getByRole('tab', { name: /history/i }))

    // Panel visible with BLOCK_1
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument()
    expect(capturedHistoryBlockId).toBe('BLOCK_1')

    // Clear focus — panel should persist with last block
    act(() => {
      useBlockStore.setState({ focusedBlockId: null })
    })
    rerender(<PageEditor pageId="PAGE_1" title="My Page" />)

    expect(screen.getByTestId('detail-panel')).toBeInTheDocument()
    expect(capturedHistoryBlockId).toBe('BLOCK_1')
  })

  it('updates panel when focusedBlockId changes to a different block', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    const { rerender } = render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open tab explicitly
    await user.click(screen.getByRole('tab', { name: /history/i }))
    expect(capturedHistoryBlockId).toBe('BLOCK_1')

    act(() => {
      useBlockStore.setState({ focusedBlockId: 'BLOCK_2' })
    })
    rerender(<PageEditor pageId="PAGE_1" title="My Page" />)

    expect(capturedHistoryBlockId).toBe('BLOCK_2')
  })

  it('collapses and expands the detail panel', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open tab explicitly
    await user.click(screen.getByRole('tab', { name: /history/i }))

    // Panel content is visible
    expect(screen.getByTestId('history-panel')).toBeInTheDocument()

    // Collapse the panel
    const collapseBtn = screen.getByRole('button', { name: /collapse detail panel/i })
    await user.click(collapseBtn)

    // Panel header still visible but content hidden
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument()

    // Expand the panel
    const expandBtn = screen.getByRole('button', { name: /expand detail panel/i })
    await user.click(expandBtn)

    expect(screen.getByTestId('history-panel')).toBeInTheDocument()
  })

  it('detail panel content has bounded height to prevent layout push', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open tab to reveal content area
    await user.click(screen.getByRole('tab', { name: /history/i }))

    // The content container should have max-height + overflow classes
    const contentEl = screen.getByTestId('history-panel').parentElement
    expect(contentEl).toHaveClass('max-h-96')
    expect(contentEl).toHaveClass('overflow-y-auto')
  })

  it('clicking a tab while collapsed expands the panel', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open and then collapse
    await user.click(screen.getByRole('tab', { name: /history/i }))
    await user.click(screen.getByRole('button', { name: /collapse detail panel/i }))
    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument()

    // Click Properties tab — should expand and switch tab
    await user.click(screen.getByRole('tab', { name: /properties/i }))
    expect(screen.getByTestId('properties-panel')).toBeInTheDocument()
  })

  it('has no a11y violations when detail panel is visible', async () => {
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    // biome-ignore format: render call is cleaner on one line
    const { container } = render(<PageEditor pageId="PAGE_1" title="A11y Page" onBack={() => {}} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('tab bar has tablist role and tab buttons have tab role with aria-selected', () => {
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // tablist wrapper
    const tablist = screen.getByRole('tablist', { name: /block details/i })
    expect(tablist).toBeInTheDocument()

    // Each tab button
    const historyTab = screen.getByRole('tab', { name: /history/i })
    const propertiesTab = screen.getByRole('tab', { name: /properties/i })

    expect(historyTab).toHaveAttribute('aria-selected', 'false')
    expect(propertiesTab).toHaveAttribute('aria-selected', 'false')
  })

  it('clicking a tab sets aria-selected and renders tabpanel with aria-labelledby', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Click History tab
    await user.click(screen.getByRole('tab', { name: /history/i }))

    // aria-selected should be true for the clicked tab
    expect(screen.getByRole('tab', { name: /history/i })).toHaveAttribute('aria-selected', 'true')

    // tabpanel should appear with correct aria-labelledby
    const tabpanel = screen.getByRole('tabpanel')
    expect(tabpanel).toHaveAttribute('id', 'detail-tabpanel')
    expect(tabpanel).toHaveAttribute('aria-labelledby', 'detail-tab-history')

    // Switch to properties
    await user.click(screen.getByRole('tab', { name: /properties/i }))

    expect(screen.getByRole('tab', { name: /history/i })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: /properties/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    const updatedTabpanel = screen.getByRole('tabpanel')
    expect(updatedTabpanel).toHaveAttribute('aria-labelledby', 'detail-tab-properties')
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
