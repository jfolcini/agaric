/**
 * Tests for BlockTree picker integration.
 *
 * Validates:
 *  - searchTags callback calls list_tags_by_prefix and maps to PickerItem[]
 *  - searchPages callback calls list_blocks with blockType='page' and filters
 *  - Correct PickerItem mapping (id + label)
 *  - Edge cases: empty results, null content
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PickerItem } from '../../editor/SuggestionList'
import { useBlockStore } from '../../stores/blocks'

// Capture the options passed to useRovingEditor so we can call searchTags/searchPages directly.
let capturedSearchTags: ((query: string) => PickerItem[] | Promise<PickerItem[]>) | undefined
let capturedSearchPages: ((query: string) => PickerItem[] | Promise<PickerItem[]>) | undefined
let capturedOnCreatePage: ((label: string) => Promise<string>) | undefined
let capturedOnNavigate: ((id: string) => void) | undefined
let capturedSearchSlashCommands:
  | ((query: string) => PickerItem[] | Promise<PickerItem[]>)
  | undefined
let capturedOnSlashCommand: ((item: PickerItem) => void) | undefined

vi.mock('../../editor/use-roving-editor', () => ({
  useRovingEditor: (opts: {
    searchTags?: (query: string) => PickerItem[] | Promise<PickerItem[]>
    searchPages?: (query: string) => PickerItem[] | Promise<PickerItem[]>
    onCreatePage?: (label: string) => Promise<string>
    onNavigate?: (id: string) => void
    searchSlashCommands?: (query: string) => PickerItem[] | Promise<PickerItem[]>
    onSlashCommand?: (item: PickerItem) => void
  }) => {
    capturedSearchTags = opts.searchTags
    capturedSearchPages = opts.searchPages
    capturedOnCreatePage = opts.onCreatePage
    capturedOnNavigate = opts.onNavigate
    capturedSearchSlashCommands = opts.searchSlashCommands
    capturedOnSlashCommand = opts.onSlashCommand
    return {
      editor: null,
      mount: vi.fn(),
      unmount: vi.fn(() => null),
      activeBlockId: null,
    }
  },
}))

// Capture useBlockKeyboard callbacks to test focus/delete handlers
let capturedBlockKeyboardOpts:
  | {
      onFocusPrev?: () => void
      onFocusNext?: () => void
      onDeleteBlock?: () => void
      [key: string]: unknown
    }
  | undefined

vi.mock('../../editor/use-block-keyboard', () => ({
  useBlockKeyboard: (
    _editor: unknown,
    opts: {
      onFocusPrev?: () => void
      onFocusNext?: () => void
      onDeleteBlock?: () => void
    },
  ) => {
    capturedBlockKeyboardOpts = opts
  },
}))

vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() })
  return { toast }
})

vi.mock('../../hooks/useViewportObserver', () => ({
  useViewportObserver: () => ({
    isOffscreen: () => false,
    observeRef: vi.fn(),
    getHeight: () => 40,
  }),
}))

// Minimal mock for SortableBlock
vi.mock('../SortableBlock', () => ({
  SortableBlock: (props: {
    blockId: string
    hasChildren?: boolean
    isCollapsed?: boolean
    onToggleCollapse?: (id: string) => void
    todoState?: string | null
    onToggleTodo?: (id: string) => void
    priority?: string | null
    onTogglePriority?: (id: string) => void
  }) => (
    <div
      data-testid={`sortable-block-${props.blockId}`}
      data-has-children={props.hasChildren ?? false}
      data-is-collapsed={props.isCollapsed ?? false}
      data-todo-state={props.todoState ?? ''}
      data-priority={props.priority ?? ''}
    >
      {props.hasChildren && props.onToggleCollapse && (
        <button
          data-testid={`toggle-${props.blockId}`}
          onClick={() => props.onToggleCollapse?.(props.blockId)}
          type="button"
        >
          Toggle
        </button>
      )}
      {props.onToggleTodo && (
        <button
          data-testid={`todo-toggle-${props.blockId}`}
          onClick={() => props.onToggleTodo?.(props.blockId)}
          type="button"
        >
          Todo
        </button>
      )}
      {props.onTogglePriority && (
        <button
          data-testid={`priority-toggle-${props.blockId}`}
          onClick={() => props.onTogglePriority?.(props.blockId)}
          type="button"
        >
          Priority
        </button>
      )}
      SortableBlock
    </div>
  ),
  INDENT_WIDTH: 24,
}))

vi.mock('../../lib/announcer', () => ({
  announce: vi.fn(),
}))

// Minimal mock for @dnd-kit
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
  MeasuringStrategy: { Always: 'always' },
}))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
}))

import { announce } from '../../lib/announcer'
import { BlockTree, processCheckboxSyntax } from '../BlockTree'

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
  capturedSearchTags = undefined
  capturedSearchPages = undefined
  capturedOnCreatePage = undefined
  capturedOnNavigate = undefined
  capturedSearchSlashCommands = undefined
  capturedOnSlashCommand = undefined
  capturedBlockKeyboardOpts = undefined
  useBlockStore.setState({
    blocks: [],
    rootParentId: null,
    focusedBlockId: null,
    loading: false,
  })
})

describe('BlockTree picker wiring', () => {
  it('passes searchTags to useRovingEditor', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchTags).toBeDefined()
    })
    expect(typeof capturedSearchTags).toBe('function')
  })

  it('passes searchPages to useRovingEditor', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchPages).toBeDefined()
    })
    expect(typeof capturedSearchPages).toBe('function')
  })

  it('searchTags calls list_tags_by_prefix with the query as prefix', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchTags).toBeDefined()
    })

    // Mock the tags response for the searchTags call
    mockedInvoke.mockResolvedValueOnce([
      { tag_id: 'TAG_01', name: 'important', usage_count: 5, updated_at: '2025-01-01T00:00:00Z' },
      { tag_id: 'TAG_02', name: 'improvement', usage_count: 3, updated_at: '2025-01-02T00:00:00Z' },
    ])

    const results = await capturedSearchTags?.('imp')

    expect(mockedInvoke).toHaveBeenCalledWith('list_tags_by_prefix', {
      prefix: 'imp',
    })
    expect(results).toEqual([
      { id: 'TAG_01', label: 'important' },
      { id: 'TAG_02', label: 'improvement' },
    ])
  })

  it('searchTags returns empty array when no tags match', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchTags).toBeDefined()
    })

    mockedInvoke.mockResolvedValueOnce([])

    const results = await capturedSearchTags?.('nonexistent')

    expect(results).toEqual([])
  })

  it('searchPages uses FTS5 for longer queries and filters to pages', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchPages).toBeDefined()
    })

    // For queries > 2 chars, searchPages uses search_blocks (FTS5)
    const searchResp = {
      items: [
        {
          id: 'P1',
          block_type: 'page',
          content: 'Meeting Notes',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        },
        {
          id: 'C1',
          block_type: 'content',
          content: 'Meeting agenda item',
          parent_id: 'P1',
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(searchResp)

    const results = await capturedSearchPages?.('meet')

    // Should call search_blocks for FTS5
    expect(mockedInvoke).toHaveBeenCalledWith(
      'search_blocks',
      expect.objectContaining({ query: 'meet' }),
    )
    // Should filter to pages only (exclude content blocks)
    expect(results).toEqual([
      { id: 'P1', label: 'Meeting Notes' },
      { id: '__create__', label: 'meet', isCreate: true },
    ])
  })

  it('searchPages filters case-insensitively', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchPages).toBeDefined()
    })

    const pagesResp = {
      items: [
        {
          id: 'P1',
          block_type: 'page',
          content: 'UPPERCASE PAGE',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        },
        {
          id: 'P2',
          block_type: 'page',
          content: 'lowercase page',
          parent_id: null,
          position: 1,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(pagesResp)

    const results = await capturedSearchPages?.('PAGE')

    expect(results).toEqual([
      { id: 'P1', label: 'UPPERCASE PAGE' },
      { id: 'P2', label: 'lowercase page' },
      { id: '__create__', label: 'PAGE', isCreate: true },
    ])
  })

  it('searchPages shows Untitled for pages with null content', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchPages).toBeDefined()
    })

    const pagesResp = {
      items: [
        {
          id: 'P1',
          block_type: 'page',
          content: null,
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(pagesResp)

    // Empty query matches everything (including null content treated as '')
    const results = await capturedSearchPages?.('')

    expect(results).toEqual([{ id: 'P1', label: 'Untitled' }])
  })

  it('searchPages returns create-new item when no pages match query', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchPages).toBeDefined()
    })

    // FTS5 returns no results for this query
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const results = await capturedSearchPages?.('zzz_no_match')

    expect(results).toEqual([{ id: '__create__', label: 'zzz_no_match', isCreate: true }])
  })

  it('searchPages appends create-new item when query partially matches but no exact match', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchPages).toBeDefined()
    })

    const pagesResp = {
      items: [
        {
          id: 'P1',
          block_type: 'page',
          content: 'Meeting Notes',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(pagesResp)

    const results = await capturedSearchPages?.('Meet')

    expect(results).toEqual([
      { id: 'P1', label: 'Meeting Notes' },
      { id: '__create__', label: 'Meet', isCreate: true },
    ])
  })

  it('searchPages does NOT append create-new when exact match exists (case-insensitive)', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchPages).toBeDefined()
    })

    const pagesResp = {
      items: [
        {
          id: 'P1',
          block_type: 'page',
          content: 'Meeting Notes',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(pagesResp)

    const results = await capturedSearchPages?.('meeting notes')

    expect(results).toEqual([{ id: 'P1', label: 'Meeting Notes' }])
  })

  it('searchPages does NOT append create-new for empty query', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchPages).toBeDefined()
    })

    const pagesResp = {
      items: [
        {
          id: 'P1',
          block_type: 'page',
          content: 'Some page',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(pagesResp)

    const results = await capturedSearchPages?.('')

    expect(results).toEqual([{ id: 'P1', label: 'Some page' }])
  })

  it('searchPages does NOT append create-new for whitespace-only query', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchPages).toBeDefined()
    })

    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const results = await capturedSearchPages?.('   ')

    expect(results).toEqual([])
  })

  it('passes onCreatePage to useRovingEditor', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnCreatePage).toBeDefined()
    })
    expect(typeof capturedOnCreatePage).toBe('function')
  })

  it('onCreatePage calls create_block with blockType page and returns the ID', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnCreatePage).toBeDefined()
    })

    mockedInvoke.mockResolvedValueOnce({
      id: 'NEW_PAGE_ID_00000000000000',
      block_type: 'page',
      content: 'My New Page',
      parent_id: null,
      position: 0,
    })

    const resultId = await capturedOnCreatePage?.('My New Page')

    expect(resultId).toBe('NEW_PAGE_ID_00000000000000')
    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'page',
      content: 'My New Page',
      parentId: null,
      position: null,
    })
  })

  it('renders loading state with skeleton placeholders', () => {
    useBlockStore.setState({ loading: true })

    const { container } = render(<BlockTree />)

    const loadingEl = container.querySelector('.block-tree-loading')
    expect(loadingEl).toBeInTheDocument()
    expect(loadingEl).toHaveAttribute('aria-busy', 'true')
    expect(loadingEl).toHaveAttribute('aria-label', 'Loading blocks')

    // Should render 4 skeleton elements
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons).toHaveLength(4)
  })

  it('renders empty state when no blocks', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(useBlockStore.getState().loading).toBe(false)
    })

    expect(
      screen.getByText('No blocks yet. Click + Add block below to start writing.'),
    ).toBeInTheDocument()
  })

  it('has no a11y violations in empty state', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    const { container } = render(<BlockTree />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

// =========================================================================
// REVIEW-LATER #59: Edge-case tests for BlockTree rendering
// =========================================================================

describe('BlockTree rendering edge cases', () => {
  it('renders deeply nested blocks (3+ levels)', async () => {
    // Default fallback for preload + load effects
    mockedInvoke.mockResolvedValue(emptyPage)

    const deepBlocks = [
      {
        id: 'ROOT',
        block_type: 'content',
        content: 'Root',
        parent_id: null,
        position: 0,
        deleted_at: null,
        archived_at: null,
        is_conflict: false,
        conflict_type: null,
        depth: 0,
      },
      {
        id: 'L1',
        block_type: 'content',
        content: 'Level 1',
        parent_id: 'ROOT',
        position: 0,
        deleted_at: null,
        archived_at: null,
        is_conflict: false,
        conflict_type: null,
        depth: 1,
      },
      {
        id: 'L2',
        block_type: 'content',
        content: 'Level 2',
        parent_id: 'L1',
        position: 0,
        deleted_at: null,
        archived_at: null,
        is_conflict: false,
        conflict_type: null,
        depth: 2,
      },
      {
        id: 'L3',
        block_type: 'content',
        content: 'Level 3',
        parent_id: 'L2',
        position: 0,
        deleted_at: null,
        archived_at: null,
        is_conflict: false,
        conflict_type: null,
        depth: 3,
      },
    ]

    mockedInvoke.mockResolvedValueOnce({
      items: deepBlocks,
      next_cursor: null,
      has_more: false,
    })

    useBlockStore.setState({ blocks: deepBlocks, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    // All 4 blocks should be rendered (BlockTree renders flat list)
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-ROOT')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-L1')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-L2')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-L3')).toBeInTheDocument()
    })

    // Empty state should NOT be shown
    expect(document.querySelector('.block-tree-empty')).not.toBeInTheDocument()
  })

  it('renders empty state when children array is empty', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    useBlockStore.setState({ blocks: [], loading: false, focusedBlockId: null })

    render(<BlockTree />)

    await waitFor(() => {
      expect(
        screen.getByText('No blocks yet. Click + Add block below to start writing.'),
      ).toBeInTheDocument()
    })

    // No sortable blocks should be rendered
    expect(document.querySelector('[data-testid^="sortable-block-"]')).not.toBeInTheDocument()
  })

  it('renders single root block with no children', async () => {
    // Default fallback for preload + load effects
    mockedInvoke.mockResolvedValue(emptyPage)

    const singleBlock = [
      {
        id: 'ONLY',
        block_type: 'content',
        content: 'Only block',
        parent_id: null,
        position: 0,
        deleted_at: null,
        archived_at: null,
        is_conflict: false,
        conflict_type: null,
        depth: 0,
      },
    ]

    mockedInvoke.mockResolvedValueOnce({
      items: singleBlock,
      next_cursor: null,
      has_more: false,
    })

    useBlockStore.setState({ blocks: singleBlock, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-ONLY')).toBeInTheDocument()
    })

    // Empty state should NOT be shown
    expect(document.querySelector('.block-tree-empty')).not.toBeInTheDocument()
  })
})

// =========================================================================
// Collapse / expand tests
// =========================================================================

const makeBlock = (
  id: string,
  parentId: string | null,
  depth: number,
  content = `Block ${id}`,
) => ({
  id,
  block_type: 'content',
  content,
  parent_id: parentId,
  position: 0,
  deleted_at: null,
  archived_at: null,
  is_conflict: false,
  conflict_type: null,
  depth,
})

describe('BlockTree collapse/expand', () => {
  beforeEach(() => {
    // Reset invoke so load() fails and doesn't overwrite store blocks
    mockedInvoke.mockReset()
  })

  it('passes hasChildren=true for blocks with children', async () => {
    const parentChild = [makeBlock('A', null, 0, 'Parent'), makeBlock('B', 'A', 1, 'Child')]

    useBlockStore.setState({ blocks: parentChild, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-has-children', 'true')
    })
    expect(screen.getByTestId('sortable-block-B')).toHaveAttribute('data-has-children', 'false')
  })

  it('passes hasChildren=false for leaf blocks', async () => {
    const leaf = [makeBlock('LEAF', null, 0)]

    useBlockStore.setState({ blocks: leaf, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-LEAF')).toHaveAttribute(
        'data-has-children',
        'false',
      )
    })
  })

  it('hides children when parent is collapsed via toggle button', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Parent'), makeBlock('B', 'A', 1, 'Child')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    // Both visible initially
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-B')).toBeInTheDocument()
    })

    // Click toggle on parent
    await user.click(screen.getByTestId('toggle-A'))

    // Child should be hidden
    expect(screen.queryByTestId('sortable-block-B')).not.toBeInTheDocument()
    // Parent still visible and marked collapsed
    expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
    expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-is-collapsed', 'true')
  })

  it('shows children again when parent is expanded', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Parent'), makeBlock('B', 'A', 1, 'Child')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-B')).toBeInTheDocument()
    })

    // Collapse
    await user.click(screen.getByTestId('toggle-A'))
    expect(screen.queryByTestId('sortable-block-B')).not.toBeInTheDocument()

    // Expand
    await user.click(screen.getByTestId('toggle-A'))
    expect(screen.getByTestId('sortable-block-B')).toBeInTheDocument()
    expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-is-collapsed', 'false')
  })

  it('hides all descendants when an ancestor is collapsed', async () => {
    const user = userEvent.setup()
    const tree = [
      makeBlock('A', null, 0),
      makeBlock('B', 'A', 1),
      makeBlock('C', 'B', 2),
      makeBlock('D', 'C', 3),
    ]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-D')).toBeInTheDocument()
    })

    // Collapse root A — all descendants hidden
    await user.click(screen.getByTestId('toggle-A'))

    expect(screen.queryByTestId('sortable-block-B')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sortable-block-C')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sortable-block-D')).not.toBeInTheDocument()
    expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
  })

  it('collapsing one sibling does not affect the other', async () => {
    const user = userEvent.setup()
    const tree = [
      makeBlock('A', null, 0),
      makeBlock('A1', 'A', 1),
      makeBlock('B', null, 0),
      makeBlock('B1', 'B', 1),
    ]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A1')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-B1')).toBeInTheDocument()
    })

    // Collapse A only
    await user.click(screen.getByTestId('toggle-A'))

    expect(screen.queryByTestId('sortable-block-A1')).not.toBeInTheDocument()
    expect(screen.getByTestId('sortable-block-B1')).toBeInTheDocument()
  })

  it('does not show toggle button for leaf blocks (no children)', async () => {
    const tree = [makeBlock('LEAF', null, 0)]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-LEAF')).toBeInTheDocument()
    })

    expect(screen.queryByTestId('toggle-LEAF')).not.toBeInTheDocument()
  })
})

// =========================================================================
// Task state cycling tests
// =========================================================================

describe('BlockTree task cycling', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('passes todoState to SortableBlock based on fetched properties', async () => {
    const tree = [makeBlock('A', null, 0, 'Task block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    // Mock get_batch_properties to return a TODO property for block A
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) {
          if (id === 'A')
            result[id] = [
              {
                key: 'todo',
                value_text: 'TODO',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          else result[id] = []
        }
        return result
      }
      return []
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'TODO')
    })
  })

  it('passes empty todoState when block has no todo property', async () => {
    const tree = [makeBlock('A', null, 0, 'No task')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    // Mock get_batch_properties to return empty arrays
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) result[id] = []
        return result
      }
      return []
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', '')
    })
  })

  it('cycles from none to TODO when todo toggle is clicked', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    // Initially no properties
    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('todo-toggle-A')).toBeInTheDocument()
    })

    // Now mock set_property for the cycling call
    mockedInvoke.mockResolvedValue(null)

    await user.click(screen.getByTestId('todo-toggle-A'))

    // Should have called set_property with TODO
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'todo',
        valueText: 'TODO',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })

    // State should update to TODO
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'TODO')
    })
  })

  it('cycles from TODO to DOING', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    // Block A starts with TODO property
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) {
          if (id === 'A')
            result[id] = [
              {
                key: 'todo',
                value_text: 'TODO',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          else result[id] = []
        }
        return result
      }
      return []
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'TODO')
    })

    // Mock the set_property call
    mockedInvoke.mockResolvedValue(null)

    await user.click(screen.getByTestId('todo-toggle-A'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'todo',
        valueText: 'DOING',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'DOING')
    })
  })

  it('cycles from DONE to none (deletes property)', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    // Block A starts with DONE property
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) {
          if (id === 'A')
            result[id] = [
              {
                key: 'todo',
                value_text: 'DONE',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          else result[id] = []
        }
        return result
      }
      return []
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'DONE')
    })

    // Mock the delete_property call
    mockedInvoke.mockResolvedValue(null)

    await user.click(screen.getByTestId('todo-toggle-A'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
        blockId: 'A',
        key: 'todo',
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', '')
    })
  })

  it('renders todo toggle button for each block', async () => {
    const tree = [makeBlock('A', null, 0, 'First'), makeBlock('B', null, 0, 'Second')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('todo-toggle-A')).toBeInTheDocument()
      expect(screen.getByTestId('todo-toggle-B')).toBeInTheDocument()
    })
  })

  it('Ctrl+Enter cycles task state on focused block', async () => {
    const tree = [makeBlock('A', null, 0, 'Focused block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
    })

    // Mock set_property for the Ctrl+Enter cycling call
    mockedInvoke.mockResolvedValue(null)

    // Fire Ctrl+Enter keydown
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
    })
    document.dispatchEvent(event)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'todo',
        valueText: 'TODO',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('Ctrl+Enter does nothing when no block is focused', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
    })

    // Fire Ctrl+Enter keydown
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
    })
    document.dispatchEvent(event)

    // Should not call set_property or delete_property
    await new Promise((r) => setTimeout(r, 50))
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_property', expect.anything())
  })
})

// =========================================================================
// Checkbox markdown syntax processing tests
// =========================================================================

describe('processCheckboxSyntax', () => {
  it('detects "- [ ] " prefix and returns TODO state', () => {
    const result = processCheckboxSyntax('- [ ] Buy groceries')
    expect(result).toEqual({ cleanContent: 'Buy groceries', todoState: 'TODO' })
  })

  it('detects "- [x] " prefix (lowercase) and returns DONE state', () => {
    const result = processCheckboxSyntax('- [x] Completed task')
    expect(result).toEqual({ cleanContent: 'Completed task', todoState: 'DONE' })
  })

  it('detects "- [X] " prefix (uppercase) and returns DONE state', () => {
    const result = processCheckboxSyntax('- [X] Completed task')
    expect(result).toEqual({ cleanContent: 'Completed task', todoState: 'DONE' })
  })

  it('returns null todoState for content without checkbox syntax', () => {
    const result = processCheckboxSyntax('Just normal text')
    expect(result).toEqual({ cleanContent: 'Just normal text', todoState: null })
  })

  it('returns null todoState for empty content', () => {
    const result = processCheckboxSyntax('')
    expect(result).toEqual({ cleanContent: '', todoState: null })
  })

  it('does not match "- [ ]" without trailing space', () => {
    const result = processCheckboxSyntax('- [ ]no space')
    expect(result).toEqual({ cleanContent: '- [ ]no space', todoState: null })
  })

  it('does not match "- [x]" without trailing space', () => {
    const result = processCheckboxSyntax('- [x]no space')
    expect(result).toEqual({ cleanContent: '- [x]no space', todoState: null })
  })

  it('does not match checkbox syntax in the middle of content', () => {
    const result = processCheckboxSyntax('Some text - [ ] not at start')
    expect(result).toEqual({ cleanContent: 'Some text - [ ] not at start', todoState: null })
  })

  it('handles "- [ ] " with empty content after prefix', () => {
    const result = processCheckboxSyntax('- [ ] ')
    expect(result).toEqual({ cleanContent: '', todoState: 'TODO' })
  })

  it('handles "- [x] " with empty content after prefix', () => {
    const result = processCheckboxSyntax('- [x] ')
    expect(result).toEqual({ cleanContent: '', todoState: 'DONE' })
  })

  it('preserves content after the 6-character prefix exactly', () => {
    const result = processCheckboxSyntax('- [ ] - [ ] nested checkbox look')
    expect(result).toEqual({ cleanContent: '- [ ] nested checkbox look', todoState: 'TODO' })
  })
})

// =========================================================================
// Slash command tests
// =========================================================================

describe('BlockTree slash command wiring', () => {
  it('passes searchSlashCommands to useRovingEditor', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })
    expect(typeof capturedSearchSlashCommands).toBe('function')
  })

  it('passes onSlashCommand to useRovingEditor', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })
    expect(typeof capturedOnSlashCommand).toBe('function')
  })

  it('searchSlashCommands returns all commands for empty query', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('')

    expect(results).toHaveLength(4)
    expect(results?.map((r) => r.id)).toEqual(['todo', 'doing', 'done', 'date'])
  })

  it('searchSlashCommands filters commands by query', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('to-do')

    expect(results).toHaveLength(1)
    expect(results?.[0].id).toBe('todo')
  })

  it('searchSlashCommands returns empty array when nothing matches', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('zzz_nonexistent')

    expect(results).toEqual([])
  })

  it('searchSlashCommands is case-insensitive', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('DONE')

    expect(results).toHaveLength(1)
    expect(results?.[0].id).toBe('done')
  })
})

// =========================================================================
// Cross-page navigation tests
// =========================================================================

describe('BlockTree cross-page navigation', () => {
  it('accepts onNavigateToPage prop without error', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)
    const onNav = vi.fn()

    render(<BlockTree onNavigateToPage={onNav} />)

    await waitFor(() => {
      expect(capturedSearchTags).toBeDefined()
    })
    // No crash — prop is accepted
    expect(onNav).not.toHaveBeenCalled()
  })
})

// =========================================================================
// Resolve cache preload tests
// =========================================================================

describe('BlockTree resolve cache preload', () => {
  it('does NOT fetch pages or tags on mount (App.tsx preloads those)', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchTags).toBeDefined()
    })

    // Pages + tags preload is now done once by App.tsx via
    // useResolveStore.preload(), so BlockTree must NOT duplicate it.
    const pageCalls = mockedInvoke.mock.calls.filter(
      ([cmd, args]) =>
        cmd === 'list_blocks' &&
        (args as Record<string, unknown>)?.blockType === 'page' &&
        (args as Record<string, unknown>)?.limit === 1000,
    )
    expect(pageCalls).toHaveLength(0)

    const tagCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_tags_by_prefix')
    expect(tagCalls).toHaveLength(0)
  })

  it('preload fetches uncached ULIDs found in block content', async () => {
    const CONTENT_ULID = '01TESTUNCACHED0000000BLKX1'
    const blockWithLink = {
      id: 'B1',
      block_type: 'content',
      content: `See [[${CONTENT_ULID}]] here`,
      parent_id: null,
      position: 0,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
    }
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'list_blocks') {
        if (args?.blockType === 'page') return emptyPage
        // load() call — return block with link content
        return { items: [blockWithLink], next_cursor: null, has_more: false }
      }
      if (cmd === 'batch_resolve') {
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        const ids = ((args as any)?.ids as string[]) ?? []
        return ids
          .filter((id: string) => id === CONTENT_ULID)
          .map((id: string) => ({
            id,
            title: 'Referenced block',
            block_type: 'content',
            deleted: false,
          }))
      }
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) result[id] = []
        return result
      }
      return emptyPage
    })

    render(<BlockTree />)

    await waitFor(
      () => {
        // Preload should call batch_resolve for the uncached ULID
        expect(mockedInvoke).toHaveBeenCalledWith('batch_resolve', { ids: [CONTENT_ULID] })
      },
      { timeout: 3000 },
    )
  })

  it('preload handles API errors gracefully', async () => {
    mockedInvoke.mockRejectedValue(new Error('Network failure'))

    render(<BlockTree />)

    // Should not crash — component renders empty state
    await waitFor(() => {
      expect(
        screen.getByText('No blocks yet. Click + Add block below to start writing.'),
      ).toBeInTheDocument()
    })
  })
})

// =========================================================================
// handleNavigate tests
// =========================================================================

describe('BlockTree handleNavigate', () => {
  it('navigates to page block via onNavigateToPage', async () => {
    const PAGE_ID = '01TESTPAGE00000000000NAV01'
    const onNav = vi.fn()

    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_block' && args?.blockId === PAGE_ID) {
        return {
          id: PAGE_ID,
          block_type: 'page',
          content: 'Target Page Title',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        }
      }
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) result[id] = []
        return result
      }
      return emptyPage
    })

    render(<BlockTree onNavigateToPage={onNav} />)

    await waitFor(() => {
      expect(capturedOnNavigate).toBeDefined()
    })

    await act(async () => {
      capturedOnNavigate?.(PAGE_ID)
    })

    await waitFor(() => {
      expect(onNav).toHaveBeenCalledWith(PAGE_ID, 'Target Page Title')
    })
  })

  it('navigates to content block in different tree — fetches parent title', async () => {
    const CONTENT_ID = '01TESTCONT00000000000NAV02'
    const PARENT_ID = '01TESTPAGE00000000000NAV03'
    const onNav = vi.fn()

    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_block' && args?.blockId === CONTENT_ID) {
        return {
          id: CONTENT_ID,
          block_type: 'content',
          content: 'Some block text',
          parent_id: PARENT_ID,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        }
      }
      if (cmd === 'get_block' && args?.blockId === PARENT_ID) {
        return {
          id: PARENT_ID,
          block_type: 'page',
          content: 'Parent Page Title',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        }
      }
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) result[id] = []
        return result
      }
      if (cmd === 'batch_resolve') return []
      return emptyPage
    })

    // parentId differs from PARENT_ID so handleNavigate goes cross-page
    render(<BlockTree parentId="DIFFERENT_PARENT" onNavigateToPage={onNav} />)

    await waitFor(() => {
      expect(capturedOnNavigate).toBeDefined()
    })

    await act(async () => {
      capturedOnNavigate?.(CONTENT_ID)
    })

    await waitFor(() => {
      // Should navigate to parent page with its title, NOT the content block's text
      // Also passes targetId for scroll-to-block
      expect(onNav).toHaveBeenCalledWith(PARENT_ID, 'Parent Page Title', CONTENT_ID)
    })
  })

  it('handles missing/deleted block without crashing', async () => {
    const onNav = vi.fn()

    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_block') throw new Error('Block not found')
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) result[id] = []
        return result
      }
      return emptyPage
    })

    render(<BlockTree onNavigateToPage={onNav} />)

    await waitFor(() => {
      expect(capturedOnNavigate).toBeDefined()
    })

    // Should not throw
    await act(async () => {
      capturedOnNavigate?.('01NONEXISTENT00000000BLK01')
    })

    // onNavigateToPage should NOT be called for missing blocks
    expect(onNav).not.toHaveBeenCalled()
  })
})

// =========================================================================
// searchPages cache tests
// =========================================================================

describe('BlockTree searchPages caching', () => {
  it('searchPages short-query fallback caches results for subsequent calls', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchPages).toBeDefined()
    })

    // Short query (≤2 chars) uses cache path with listBlocks fallback
    const pagesResp = {
      items: [
        {
          id: 'P1',
          block_type: 'page',
          content: 'Alpha Page',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(pagesResp)
    // Use short query (≤2 chars) to hit the cache path
    const result1 = await capturedSearchPages?.('al')

    expect(result1).toEqual([
      { id: 'P1', label: 'Alpha Page' },
      { id: '__create__', label: 'al', isCreate: true },
    ])

    // Second call — should NOT trigger another API call (cached in pagesListRef)
    const callsBefore = mockedInvoke.mock.calls.length
    const result2 = await capturedSearchPages?.('al')
    const callsAfter = mockedInvoke.mock.calls.length

    expect(callsAfter).toBe(callsBefore)
    expect(result2).toEqual([
      { id: 'P1', label: 'Alpha Page' },
      { id: '__create__', label: 'al', isCreate: true },
    ])
  })

  it('onCreatePage adds new page to search results', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnCreatePage).toBeDefined()
    })

    // Mock create_block
    mockedInvoke.mockResolvedValueOnce({
      id: 'NEW_PAGE_ID',
      block_type: 'page',
      content: 'Freshly Created',
      parent_id: null,
      position: 0,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
    })

    await capturedOnCreatePage?.('Freshly Created')

    // The new page should appear in searchPages
    const results = await capturedSearchPages?.('freshly')
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).toContain('NEW_PAGE_ID')
  })
})

// =========================================================================
// Priority slash commands tests
// =========================================================================

describe('BlockTree priority slash commands', () => {
  it('searchSlashCommands returns priority commands when query matches "priority"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('priority')

    expect(results).toBeDefined()
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).toContain('priority-high')
    expect(ids).toContain('priority-medium')
    expect(ids).toContain('priority-low')
  })

  it('priority commands have "PRIORITY 1/2/3" labels', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('priority')

    const labels = results?.map((r) => r.label) ?? []
    expect(labels).toContain('PRIORITY 1 — Set high priority')
    expect(labels).toContain('PRIORITY 2 — Set medium priority')
    expect(labels).toContain('PRIORITY 3 — Set low priority')
  })

  it('priority commands are not shown for empty query', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('')

    const ids = results?.map((r) => r.id) ?? []
    expect(ids).not.toContain('priority-high')
    expect(ids).not.toContain('priority-medium')
    expect(ids).not.toContain('priority-low')
  })

  it('onSlashCommand sets priority A for priority-high', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'priority-high', label: 'PRIORITY 1 — Set high priority' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'priority',
        valueText: 'A',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('onSlashCommand sets priority B for priority-medium', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'priority-medium', label: 'PRIORITY 2 — Set medium priority' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'priority',
        valueText: 'B',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('onSlashCommand sets priority C for priority-low', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'priority-low', label: 'PRIORITY 3 — Set low priority' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'priority',
        valueText: 'C',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('passes priority prop to SortableBlock based on fetched properties', async () => {
    const tree = [makeBlock('A', null, 0, 'Priority block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) {
          if (id === 'A')
            result[id] = [
              {
                key: 'priority',
                value_text: 'B',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          else result[id] = []
        }
        return result
      }
      return []
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-priority', 'B')
    })
  })

  it('renders priority toggle button for each block', async () => {
    const tree = [makeBlock('A', null, 0, 'First'), makeBlock('B', null, 0, 'Second')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('priority-toggle-A')).toBeInTheDocument()
      expect(screen.getByTestId('priority-toggle-B')).toBeInTheDocument()
    })
  })

  it('priority toggle cycles priority via handleTogglePriority', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    // Initially no properties
    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('priority-toggle-A')).toBeInTheDocument()
    })

    // Now mock set_property for the cycling call
    mockedInvoke.mockResolvedValue(null)

    await user.click(screen.getByTestId('priority-toggle-A'))

    // Should have called set_property with priority A (cycling from none)
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'priority',
        valueText: 'A',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })

    // State should update to A
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-priority', 'A')
    })
  })
})

// =========================================================================
// Heading slash command execution tests
// =========================================================================

describe('BlockTree heading slash command execution', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('when /h1 is selected, block content gets "# " prefix', async () => {
    const tree = [makeBlock('A', null, 0, 'My heading text')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    // Mock edit_block call
    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'h1', label: 'Heading 1 — Large heading' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'A',
        toText: '# My heading text',
      })
    })

    // Store should reflect the new content
    await waitFor(() => {
      const block = useBlockStore.getState().blocks.find((b) => b.id === 'A')
      expect(block?.content).toBe('# My heading text')
    })
  })

  it('when /h3 is selected, block content gets "### " prefix', async () => {
    const tree = [makeBlock('A', null, 0, 'Small heading')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'h3', label: 'Heading 3 — Small heading' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'A',
        toText: '### Small heading',
      })
    })

    await waitFor(() => {
      const block = useBlockStore.getState().blocks.find((b) => b.id === 'A')
      expect(block?.content).toBe('### Small heading')
    })
  })

  it('when /h2 is selected, block content gets "## " prefix', async () => {
    const tree = [makeBlock('A', null, 0, 'Medium')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'h2', label: 'Heading 2 — Medium heading' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'A',
        toText: '## Medium',
      })
    })
  })

  it('heading commands appear in searchSlashCommands when query matches', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('heading')

    expect(results).toBeDefined()
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).toContain('h1')
    expect(ids).toContain('h2')
    expect(ids).toContain('h3')
  })
})

// =========================================================================
// Aria-live announcements (#41, #47, #48)
// =========================================================================

const mockedAnnounce = vi.mocked(announce)

describe('BlockTree aria-live announcements', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  // ── #41 — Focus change announcements ──────────────────────────────

  it('announces block content when navigating to previous block', async () => {
    const tree = [makeBlock('A', null, 0, 'First block'), makeBlock('B', null, 0, 'Second block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'B' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onFocusPrev).toBeDefined()
    })

    act(() => {
      capturedBlockKeyboardOpts?.onFocusPrev?.()
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('Editing block: First block')
  })

  it('announces block content when navigating to next block', async () => {
    const tree = [makeBlock('A', null, 0, 'First block'), makeBlock('B', null, 0, 'Second block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onFocusNext).toBeDefined()
    })

    act(() => {
      capturedBlockKeyboardOpts?.onFocusNext?.()
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('Editing block: Second block')
  })

  it('announces "empty block" when navigating to a block with no content', async () => {
    const tree = [makeBlock('A', null, 0, ''), makeBlock('B', null, 0, 'Has content')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'B' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onFocusPrev).toBeDefined()
    })

    act(() => {
      capturedBlockKeyboardOpts?.onFocusPrev?.()
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('Editing block: empty block')
  })

  it('truncates long content to 50 characters in focus announcement', async () => {
    const longContent = 'A'.repeat(80)
    const tree = [makeBlock('A', null, 0, longContent), makeBlock('B', null, 0, 'Short')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'B' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onFocusPrev).toBeDefined()
    })

    act(() => {
      capturedBlockKeyboardOpts?.onFocusPrev?.()
    })

    expect(mockedAnnounce).toHaveBeenCalledWith(`Editing block: ${'A'.repeat(50)}`)
  })

  // ── #48 — Delete block announcement ───────────────────────────────

  it('announces "Block deleted" when a block is deleted', async () => {
    const tree = [makeBlock('A', null, 0, 'First'), makeBlock('B', null, 0, 'Second')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'B' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onDeleteBlock).toBeDefined()
    })

    act(() => {
      capturedBlockKeyboardOpts?.onDeleteBlock?.()
    })

    expect(mockedAnnounce).toHaveBeenCalledWith('Block deleted')
  })

  // ── #47 — Task state change announcement ──────────────────────────

  it('announces task state when cycling from none to TODO via button click', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Task block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    // Initially no properties
    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('todo-toggle-A')).toBeInTheDocument()
    })

    // Mock set_property for the cycling call
    mockedInvoke.mockResolvedValue(null)

    await user.click(screen.getByTestId('todo-toggle-A'))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Task state: To do')
    })
  })

  it('announces task state when cycling from TODO to DOING', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Task block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    // Block A starts with TODO property
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) {
          if (id === 'A')
            result[id] = [
              {
                key: 'todo',
                value_text: 'TODO',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          else result[id] = []
        }
        return result
      }
      return []
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'TODO')
    })

    mockedInvoke.mockResolvedValue(null)

    await user.click(screen.getByTestId('todo-toggle-A'))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Task state: In progress')
    })
  })

  it('announces "Task state: none" when cycling from DONE to none', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Task block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    // Block A starts with DONE property
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) {
          if (id === 'A')
            result[id] = [
              {
                key: 'todo',
                value_text: 'DONE',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ]
          else result[id] = []
        }
        return result
      }
      return []
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'DONE')
    })

    mockedInvoke.mockResolvedValue(null)

    await user.click(screen.getByTestId('todo-toggle-A'))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Task state: none')
    })
  })
})

// =========================================================================
// handleNavigate — same-tree local navigation
// =========================================================================

describe('BlockTree handleNavigate — same-tree navigation', () => {
  it('same-tree navigation focuses the target block without calling onNavigateToPage', async () => {
    const BLOCK_ID = '01TESTLOCAL0000000000NAV01'
    const onNav = vi.fn()

    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_block' && args?.blockId === BLOCK_ID) {
        return {
          id: BLOCK_ID,
          block_type: 'content',
          content: 'Local block text',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        }
      }
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) result[id] = []
        return result
      }
      return emptyPage
    })

    render(<BlockTree onNavigateToPage={onNav} />)

    await waitFor(() => {
      expect(capturedOnNavigate).toBeDefined()
    })

    await act(async () => {
      capturedOnNavigate?.(BLOCK_ID)
    })

    // Same-tree: should NOT call onNavigateToPage
    expect(onNav).not.toHaveBeenCalled()
    // Should set focus to the target block
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe(BLOCK_ID)
    })
  })

  it('navigates to parent page with fallback Untitled when parent fetch fails', async () => {
    const CONTENT_ID = '01TESTCONT00000000000NAV04'
    const PARENT_ID = '01TESTPAGE00000000000NAV05'
    const onNav = vi.fn()

    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_block' && args?.blockId === CONTENT_ID) {
        return {
          id: CONTENT_ID,
          block_type: 'content',
          content: 'Cross-page block',
          parent_id: PARENT_ID,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        }
      }
      // Parent fetch fails
      if (cmd === 'get_block' && args?.blockId === PARENT_ID) {
        throw new Error('Parent not found')
      }
      if (cmd === 'get_batch_properties') {
        const result: Record<string, unknown[]> = {}
        for (const id of args?.blockIds ?? []) result[id] = []
        return result
      }
      return emptyPage
    })

    render(<BlockTree parentId="DIFFERENT_ROOT" onNavigateToPage={onNav} />)

    await waitFor(() => {
      expect(capturedOnNavigate).toBeDefined()
    })

    await act(async () => {
      capturedOnNavigate?.(CONTENT_ID)
    })

    // Should navigate to parent page with fallback title
    await waitFor(() => {
      expect(onNav).toHaveBeenCalledWith(PARENT_ID, 'Untitled', CONTENT_ID)
    })
  })
})

// =========================================================================
// handleDeleteBlock
// =========================================================================

describe('BlockTree handleDeleteBlock', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('deleting a block calls delete_block via invoke', async () => {
    const tree = [makeBlock('A', null, 0, 'First'), makeBlock('B', null, 0, 'Second')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'B' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onDeleteBlock).toBeDefined()
    })

    act(() => {
      capturedBlockKeyboardOpts?.onDeleteBlock?.()
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'B' })
    })
  })

  it('deleting the only block in the tree is prevented (#75)', async () => {
    const { toast } = await import('sonner')
    const tree = [makeBlock('ONLY', null, 0, 'The only block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'ONLY' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onDeleteBlock).toBeDefined()
    })

    act(() => {
      capturedBlockKeyboardOpts?.onDeleteBlock?.()
    })

    // Block should NOT be deleted — guard prevents it
    expect(useBlockStore.getState().blocks).toHaveLength(1)
    expect(useBlockStore.getState().focusedBlockId).toBe('ONLY')
    expect(toast.error).toHaveBeenCalledWith('Cannot delete the last block on a page')
  })

  it('deleting a focused block moves focus to the previous block', async () => {
    const tree = [
      makeBlock('A', null, 0, 'First'),
      makeBlock('B', null, 0, 'Second'),
      makeBlock('C', null, 0, 'Third'),
    ]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'B' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onDeleteBlock).toBeDefined()
    })

    act(() => {
      capturedBlockKeyboardOpts?.onDeleteBlock?.()
    })

    // Focus should move to previous block A
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('A')
    })
  })

  it('deleting the first block moves focus to the next block', async () => {
    const tree = [makeBlock('A', null, 0, 'First'), makeBlock('B', null, 0, 'Second')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onDeleteBlock).toBeDefined()
    })

    act(() => {
      capturedBlockKeyboardOpts?.onDeleteBlock?.()
    })

    // Since A is the first block (idx=0), focus moves to the next block B
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('B')
    })
  })
})

// =========================================================================
// handleMergeWithPrev (Backspace at start merges with previous block)
// =========================================================================

describe('BlockTree handleMergeWithPrev', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('merge concatenates previous block content with current and removes current', async () => {
    const tree = [makeBlock('A', null, 0, 'Hello '), makeBlock('B', null, 0, 'World')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'B' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      const handler = capturedBlockKeyboardOpts?.onMergeWithPrev
      expect(handler).toBeDefined()
    })

    act(() => {
      ;(capturedBlockKeyboardOpts?.onMergeWithPrev as () => void)?.()
    })

    // Should edit previous block with concatenated content
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'A',
        toText: 'Hello World',
      })
    })

    // Should delete current block
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'B' })
    })

    // Focus should move to previous block
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('A')
    })
  })

  it('merge on first block is a no-op', async () => {
    const tree = [makeBlock('A', null, 0, 'Only block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      const handler = capturedBlockKeyboardOpts?.onMergeWithPrev
      expect(handler).toBeDefined()
    })

    act(() => {
      ;(capturedBlockKeyboardOpts?.onMergeWithPrev as () => void)?.()
    })

    // No edit_block or delete_block should be called
    await new Promise((r) => setTimeout(r, 50))
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', expect.anything())
  })
})

// =========================================================================
// handleIndent / handleDedent (Tab / Shift+Tab in block tree context)
// =========================================================================

describe('BlockTree handleIndent / handleDedent', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('indent calls move_block with previous sibling as new parent', async () => {
    const tree = [makeBlock('A', null, 0, 'First'), makeBlock('B', null, 0, 'Second')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'B' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      const handler = capturedBlockKeyboardOpts?.onIndent
      expect(handler).toBeDefined()
    })

    act(() => {
      ;(capturedBlockKeyboardOpts?.onIndent as () => void)?.()
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'A',
        newPosition: 0,
      })
    })
  })

  it('dedent calls move_block with grandparent as new parent', async () => {
    const tree = [makeBlock('A', null, 0, 'Parent'), makeBlock('B', 'A', 1, 'Child')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'B' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      const handler = capturedBlockKeyboardOpts?.onDedent
      expect(handler).toBeDefined()
    })

    act(() => {
      ;(capturedBlockKeyboardOpts?.onDedent as () => void)?.()
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: null,
        newPosition: 1,
      })
    })
  })

  it('indent on the first block is a no-op', async () => {
    const tree = [makeBlock('A', null, 0, 'Only block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      const handler = capturedBlockKeyboardOpts?.onIndent
      expect(handler).toBeDefined()
    })

    act(() => {
      ;(capturedBlockKeyboardOpts?.onIndent as () => void)?.()
    })

    // No move_block should be called
    await new Promise((r) => setTimeout(r, 50))
    expect(mockedInvoke).not.toHaveBeenCalledWith('move_block', expect.anything())
  })

  it('dedent on a root-level block is a no-op', async () => {
    const tree = [makeBlock('A', null, 0, 'Root block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      const handler = capturedBlockKeyboardOpts?.onDedent
      expect(handler).toBeDefined()
    })

    act(() => {
      ;(capturedBlockKeyboardOpts?.onDedent as () => void)?.()
    })

    // No move_block should be called (already at root)
    await new Promise((r) => setTimeout(r, 50))
    expect(mockedInvoke).not.toHaveBeenCalledWith('move_block', expect.anything())
  })
})

// =========================================================================
// Priority keyboard shortcuts (Mod+Shift+1/2/3)
// =========================================================================

describe('BlockTree priority keyboard shortcuts', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('set-priority-1 event sets priority A on focused block', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
    })

    act(() => {
      document.dispatchEvent(new Event('set-priority-1'))
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'priority',
        valueText: 'A',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })

    // Priority should update in UI
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-priority', 'A')
    })
  })

  it('set-priority-2 event sets priority B on focused block', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
    })

    act(() => {
      document.dispatchEvent(new Event('set-priority-2'))
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'priority',
        valueText: 'B',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-priority', 'B')
    })
  })

  it('set-priority-3 event sets priority C on focused block', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
    })

    act(() => {
      document.dispatchEvent(new Event('set-priority-3'))
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'priority',
        valueText: 'C',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-priority', 'C')
    })
  })

  it('priority event does nothing when no block is focused', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
    })

    act(() => {
      document.dispatchEvent(new Event('set-priority-1'))
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
  })
})
