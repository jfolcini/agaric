/**
 * Tests for PageEditor component.
 *
 * Validates:
 *  - Renders page title
 *  - Renders back button, calls onBack when clicked
 *  - Renders BlockTree with correct parentId
 *  - Title edit: change title, blur -> calls editBlock with new title
 *  - Add block button creates a new block
 *  - a11y compliance
 *  - Reloads blocks when pageId prop changes
 *  - Detail panel: hidden when no block focused
 *  - Detail panel: renders when a block is focused
 *  - Detail panel: tab switching between backlinks/history/tags
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

// ── Mock panel components ───────────────────────────────────────────
// Panels are tested independently; here we just verify they receive
// the correct blockId prop.
let capturedBacklinksBlockId: string | null = null
let capturedHistoryBlockId: string | null = null
let capturedTagBlockId: string | null = null

vi.mock('../BacklinksPanel', () => ({
  BacklinksPanel: (props: { blockId: string | null }) => {
    capturedBacklinksBlockId = props.blockId
    return <div data-testid="backlinks-panel" data-block-id={props.blockId ?? ''} />
  },
}))

vi.mock('../HistoryPanel', () => ({
  HistoryPanel: (props: { blockId: string | null }) => {
    capturedHistoryBlockId = props.blockId
    return <div data-testid="history-panel" data-block-id={props.blockId ?? ''} />
  },
}))

vi.mock('../TagPanel', () => ({
  TagPanel: (props: { blockId: string | null }) => {
    capturedTagBlockId = props.blockId
    return <div data-testid="tag-panel" data-block-id={props.blockId ?? ''} />
  },
}))

// ── Mock lucide-react ───────────────────────────────────────────────
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <svg data-testid="arrow-left-icon" />,
  ChevronDown: () => <svg data-testid="chevron-down-icon" />,
  ChevronUp: () => <svg data-testid="chevron-up-icon" />,
  History: () => <svg data-testid="history-icon" />,
  Link: () => <svg data-testid="link-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
  Tag: () => <svg data-testid="tag-icon" />,
}))

import { useBlockStore } from '../../stores/blocks'
import { PageEditor } from '../PageEditor'

const mockedInvoke = vi.mocked(invoke)

function makeBlock(id: string, content: string, parentId: string | null = null, position = 0) {
  return {
    id,
    block_type: 'text',
    content,
    parent_id: parentId,
    position,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
    depth: 0,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedParentId = undefined
  capturedBacklinksBlockId = null
  capturedHistoryBlockId = null
  capturedTagBlockId = null
  // Reset the Zustand store to a clean state before each test
  useBlockStore.setState({
    blocks: [],
    focusedBlockId: null,
    loading: false,
  })
})

describe('PageEditor', () => {
  it('renders page title', () => {
    render(<PageEditor pageId="PAGE_1" title="My Test Page" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })
    expect(titleEl).toBeInTheDocument()
    expect(titleEl).toHaveTextContent('My Test Page')
  })

  it('renders back button and calls onBack when clicked', async () => {
    const user = userEvent.setup()
    const onBack = vi.fn()

    render(<PageEditor pageId="PAGE_1" title="My Page" onBack={onBack} />)

    const backBtn = screen.getByRole('button', { name: /go back/i })
    expect(backBtn).toBeInTheDocument()

    await user.click(backBtn)

    expect(onBack).toHaveBeenCalledOnce()
  })

  it('does not render back button when onBack is not provided', () => {
    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    expect(screen.queryByRole('button', { name: /go back/i })).not.toBeInTheDocument()
  })

  it('renders BlockTree with correct parentId', () => {
    render(<PageEditor pageId="PAGE_123" title="Test" />)

    const blockTree = screen.getByTestId('block-tree')
    expect(blockTree).toBeInTheDocument()
    expect(blockTree).toHaveAttribute('data-parent-id', 'PAGE_123')
    expect(capturedParentId).toBe('PAGE_123')
  })

  it('updates BlockTree parentId when pageId prop changes', () => {
    const { rerender } = render(<PageEditor pageId="PAGE_A" title="Page A" />)

    expect(capturedParentId).toBe('PAGE_A')

    rerender(<PageEditor pageId="PAGE_B" title="Page B" />)

    expect(capturedParentId).toBe('PAGE_B')
    const blockTree = screen.getByTestId('block-tree')
    expect(blockTree).toHaveAttribute('data-parent-id', 'PAGE_B')
  })

  it('calls editBlock when title is changed and blurred', async () => {
    const user = userEvent.setup()

    // Mock the editBlock invoke
    mockedInvoke.mockResolvedValueOnce({
      id: 'PAGE_1',
      block_type: 'page',
      content: 'New Title',
      parent_id: null,
      position: null,
    })

    render(<PageEditor pageId="PAGE_1" title="Old Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })

    // Clear existing text and type new title
    await user.clear(titleEl)
    await user.type(titleEl, 'New Title')
    // Blur to trigger save
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'PAGE_1',
        toText: 'New Title',
      })
    })
  })

  it('does not call editBlock when title is unchanged on blur', async () => {
    const user = userEvent.setup()

    render(<PageEditor pageId="PAGE_1" title="Same Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })

    // Focus and immediately blur without changing
    await user.click(titleEl)
    await user.tab()

    // Should not have called edit_block
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
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
      block_type: 'text',
      content: '',
      parent_id: 'PAGE_1',
      position: 1,
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'text',
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
      block_type: 'text',
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
        blockType: 'text',
        content: '',
        parentId: 'PAGE_1',
        position: 0,
      })
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
    expect(screen.getByRole('button', { name: /backlinks/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /history/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /tags/i })).toBeInTheDocument()

    // Panel content should NOT be auto-opened
    expect(screen.queryByTestId('backlinks-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tag-panel')).not.toBeInTheDocument()
  })

  it('opens backlinks panel when user explicitly clicks Backlinks tab', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Panel content NOT shown yet
    expect(screen.queryByTestId('backlinks-panel')).not.toBeInTheDocument()

    // Click Backlinks tab explicitly
    await user.click(screen.getByRole('button', { name: /backlinks/i }))

    // Now panel content should be shown
    expect(screen.getByTestId('backlinks-panel')).toBeInTheDocument()
    expect(capturedBacklinksBlockId).toBe('BLOCK_1')
  })

  it('passes correct blockId to panel components after tab click', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_42' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Click a tab to open panel
    await user.click(screen.getByRole('button', { name: /backlinks/i }))

    expect(capturedBacklinksBlockId).toBe('BLOCK_42')
  })

  it('switches between backlinks, history, and tags tabs', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open Backlinks tab first (panel is collapsed by default)
    await user.click(screen.getByRole('button', { name: /backlinks/i }))
    expect(screen.getByTestId('backlinks-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tag-panel')).not.toBeInTheDocument()

    // Switch to History tab
    await user.click(screen.getByRole('button', { name: /history/i }))
    expect(screen.queryByTestId('backlinks-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('history-panel')).toBeInTheDocument()
    expect(capturedHistoryBlockId).toBe('BLOCK_1')

    // Switch to Tags tab
    await user.click(screen.getByRole('button', { name: /tags/i }))
    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('tag-panel')).toBeInTheDocument()
    expect(capturedTagBlockId).toBe('BLOCK_1')

    // Switch back to Backlinks tab
    await user.click(screen.getByRole('button', { name: /backlinks/i }))
    expect(screen.getByTestId('backlinks-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('tag-panel')).not.toBeInTheDocument()
  })

  it('persists panel when focusedBlockId becomes null', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    const { rerender } = render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open tab explicitly
    await user.click(screen.getByRole('button', { name: /backlinks/i }))

    // Panel visible with BLOCK_1
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument()
    expect(capturedBacklinksBlockId).toBe('BLOCK_1')

    // Clear focus — panel should persist with last block
    act(() => {
      useBlockStore.setState({ focusedBlockId: null })
    })
    rerender(<PageEditor pageId="PAGE_1" title="My Page" />)

    expect(screen.getByTestId('detail-panel')).toBeInTheDocument()
    expect(capturedBacklinksBlockId).toBe('BLOCK_1')
  })

  it('updates panel when focusedBlockId changes to a different block', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    const { rerender } = render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open tab explicitly
    await user.click(screen.getByRole('button', { name: /backlinks/i }))
    expect(capturedBacklinksBlockId).toBe('BLOCK_1')

    act(() => {
      useBlockStore.setState({ focusedBlockId: 'BLOCK_2' })
    })
    rerender(<PageEditor pageId="PAGE_1" title="My Page" />)

    expect(capturedBacklinksBlockId).toBe('BLOCK_2')
  })

  it('collapses and expands the detail panel', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open tab explicitly
    await user.click(screen.getByRole('button', { name: /backlinks/i }))

    // Panel content is visible
    expect(screen.getByTestId('backlinks-panel')).toBeInTheDocument()

    // Collapse the panel
    const collapseBtn = screen.getByRole('button', { name: /collapse detail panel/i })
    await user.click(collapseBtn)

    // Panel header still visible but content hidden
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('backlinks-panel')).not.toBeInTheDocument()

    // Expand the panel
    const expandBtn = screen.getByRole('button', { name: /expand detail panel/i })
    await user.click(expandBtn)

    expect(screen.getByTestId('backlinks-panel')).toBeInTheDocument()
  })

  it('detail panel content has bounded height to prevent layout push', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open tab to reveal content area
    await user.click(screen.getByRole('button', { name: /backlinks/i }))

    // The content container should have max-height + overflow classes
    const contentEl = screen.getByTestId('backlinks-panel').parentElement
    expect(contentEl).toHaveClass('max-h-60')
    expect(contentEl).toHaveClass('overflow-y-auto')
  })

  it('clicking a tab while collapsed expands the panel', async () => {
    const user = userEvent.setup()
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Open and then collapse
    await user.click(screen.getByRole('button', { name: /backlinks/i }))
    await user.click(screen.getByRole('button', { name: /collapse detail panel/i }))
    expect(screen.queryByTestId('backlinks-panel')).not.toBeInTheDocument()

    // Click History tab — should expand and switch tab
    await user.click(screen.getByRole('button', { name: /history/i }))
    expect(screen.getByTestId('history-panel')).toBeInTheDocument()
  })

  it('has no a11y violations when detail panel is visible', async () => {
    useBlockStore.setState({ focusedBlockId: 'BLOCK_1' })

    const { container } = render(<PageEditor pageId="PAGE_1" title="A11y Page" onBack={() => {}} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
