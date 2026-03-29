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
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
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

// ── Mock lucide-react ───────────────────────────────────────────────
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <svg data-testid="arrow-left-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
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
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedParentId = undefined
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
