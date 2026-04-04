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

// Mock editor that tracks chain calls for slash command handler tests
const mockInsertContent = vi.fn()
const mockToggleCodeBlock = vi.fn()
const mockRun = vi.fn()
const mockChain = {
  focus: vi.fn(() => mockChain),
  insertContent: vi.fn((content: string) => {
    mockInsertContent(content)
    return mockChain
  }),
  toggleCodeBlock: vi.fn(() => {
    mockToggleCodeBlock()
    return mockChain
  }),
  run: mockRun,
}
/** Set to true to provide a mock editor to useRovingEditor; false returns editor: null. */
let useMockEditor = false
const mockEditor = {
  chain: vi.fn(() => mockChain),
  state: { selection: { $anchor: { pos: 0 } } },
}

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
      editor: useMockEditor ? mockEditor : null,
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
  const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
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
    onZoomIn?: (id: string) => void
    isSelected?: boolean
    onSelect?: (blockId: string, mode: 'toggle' | 'range') => void
  }) => (
    <div
      data-testid={`sortable-block-${props.blockId}`}
      data-has-children={props.hasChildren ?? false}
      data-is-collapsed={props.isCollapsed ?? false}
      data-todo-state={props.todoState ?? ''}
      data-priority={props.priority ?? ''}
      data-selected={props.isSelected ? 'true' : 'false'}
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
      {props.onZoomIn && (
        <button
          data-testid={`zoom-in-${props.blockId}`}
          onClick={() => props.onZoomIn?.(props.blockId)}
          type="button"
        >
          Zoom In
        </button>
      )}
      {props.onSelect && (
        <button
          data-testid={`select-${props.blockId}`}
          onClick={() => props.onSelect?.(props.blockId, 'toggle')}
          type="button"
        >
          Select
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

// Mock Calendar to immediately invoke onSelect with a known date when rendered
let mockCalendarOnSelect: ((day: Date | undefined) => void) | undefined
vi.mock('../ui/calendar', () => ({
  Calendar: (props: { onSelect?: (day: Date | undefined) => void }) => {
    mockCalendarOnSelect = props.onSelect
    return <div data-testid="mock-calendar">Calendar</div>
  },
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
  try {
    localStorage.removeItem('collapsed_ids')
  } catch {
    // jsdom localStorage may not be available
  }
  capturedSearchTags = undefined
  capturedSearchPages = undefined
  capturedOnCreatePage = undefined
  capturedOnNavigate = undefined
  capturedSearchSlashCommands = undefined
  capturedOnSlashCommand = undefined
  capturedBlockKeyboardOpts = undefined
  mockCalendarOnSelect = undefined
  useMockEditor = false
  useBlockStore.setState({
    blocks: [],
    rootParentId: null,
    focusedBlockId: null,
    loading: false,
    selectedBlockIds: [],
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
      limit: null,
    })
    expect(results).toEqual([
      { id: 'TAG_01', label: 'important' },
      { id: 'TAG_02', label: 'improvement' },
      { id: '__create__', label: 'imp', isCreate: true },
    ])
  })

  it('searchTags returns "Create new tag" option when no tags match', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchTags).toBeDefined()
    })

    mockedInvoke.mockResolvedValueOnce([])

    const results = await capturedSearchTags?.('nonexistent')

    expect(results).toEqual([{ id: '__create__', label: 'nonexistent', isCreate: true }])
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
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
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
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
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
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
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
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
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
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
  todo_state: null,
  priority: null,
  due_date: null,
  scheduled_date: null,
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

  it('passes todoState to SortableBlock from block store field', async () => {
    const tree = [{ ...makeBlock('A', null, 0, 'Task block'), todo_state: 'TODO' }]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })
    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'TODO')
    })
  })

  it('passes empty todoState when block has no todo_state', async () => {
    const tree = [makeBlock('A', null, 0, 'No task')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })
    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', '')
    })
  })

  it('cycles from none to TODO when todo toggle is clicked', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Block')]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })
    mockedInvoke.mockResolvedValue(null)

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('todo-toggle-A')).toBeInTheDocument()
    })

    await user.click(screen.getByTestId('todo-toggle-A'))

    // Should have called set_todo_state with TODO
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
        blockId: 'A',
        state: 'TODO',
      })
    })

    // State should update to TODO
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'TODO')
    })
  })

  it('cycles from TODO to DOING', async () => {
    const user = userEvent.setup()
    const tree = [{ ...makeBlock('A', null, 0, 'Block'), todo_state: 'TODO' }]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })
    mockedInvoke.mockResolvedValue(null)

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'TODO')
    })

    await user.click(screen.getByTestId('todo-toggle-A'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
        blockId: 'A',
        state: 'DOING',
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'DOING')
    })
  })

  it('cycles from DONE to none (clears state)', async () => {
    const user = userEvent.setup()
    const tree = [{ ...makeBlock('A', null, 0, 'Block'), todo_state: 'DONE' }]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })
    mockedInvoke.mockResolvedValue(null)

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'DONE')
    })

    await user.click(screen.getByTestId('todo-toggle-A'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
        blockId: 'A',
        state: null,
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
    mockedInvoke.mockResolvedValue(null)

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

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
        blockId: 'A',
        state: 'TODO',
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

    // Should not call set_todo_state
    await new Promise((r) => setTimeout(r, 50))
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_todo_state', expect.anything())
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

    expect(results).toHaveLength(17)
    expect(results?.map((r) => r.id)).toEqual([
      'todo',
      'doing',
      'done',
      'date',
      'due',
      'schedule',
      'link',
      'tag',
      'code',
      'effort',
      'assignee',
      'location',
      'repeat',
      'template',
      'quote',
      'table',
      'query',
    ])
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

    expect(results?.length).toBeGreaterThanOrEqual(1)
    expect(results?.[0].id).toBe('done')
  })

  it('searchSlashCommands returns /link command when query matches "link"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('link')

    expect(results?.some((r) => r.id === 'link')).toBe(true)
  })

  it('searchSlashCommands returns /tag command when query matches "tag"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('tag')

    expect(results?.some((r) => r.id === 'tag')).toBe(true)
  })

  it('searchSlashCommands returns /code command when query matches "code"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('code')

    expect(results?.some((r) => r.id === 'code')).toBe(true)
  })

  it('searchSlashCommands returns /effort command when query matches "effort"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('effort')

    expect(results?.some((r) => r.id === 'effort')).toBe(true)
  })

  it('searchSlashCommands returns /assignee command when query matches "assignee"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('assignee')

    expect(results?.some((r) => r.id === 'assignee')).toBe(true)
  })

  it('searchSlashCommands returns /location command when query matches "location"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('location')

    expect(results?.some((r) => r.id === 'location')).toBe(true)
  })

  it('searchSlashCommands returns /repeat command when query matches "repeat"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('repeat')

    expect(results?.some((r) => r.id === 'repeat')).toBe(true)
  })

  it('searchSlashCommands returns /query command when query matches "query"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('query')

    expect(results?.some((r) => r.id === 'query')).toBe(true)
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
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    // Route by command name to avoid resolve_page_by_alias consuming the mock
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return pagesResp
      if (cmd === 'resolve_page_by_alias') return null
      return emptyPage
    })
    // Use short query (≤2 chars) to hit the cache path
    const result1 = await capturedSearchPages?.('al')

    expect(result1).toEqual([
      { id: 'P1', label: 'Alpha Page' },
      { id: '__create__', label: 'al', isCreate: true },
    ])

    // Second call — should NOT trigger another list_blocks call (cached in pagesListRef)
    // But resolve_page_by_alias is still called (not cached)
    const listBlocksCallsBefore = mockedInvoke.mock.calls.filter(
      (c) => c[0] === 'list_blocks',
    ).length
    const result2 = await capturedSearchPages?.('al')
    const listBlocksCallsAfter = mockedInvoke.mock.calls.filter(
      (c) => c[0] === 'list_blocks',
    ).length

    expect(listBlocksCallsAfter).toBe(listBlocksCallsBefore)
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
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
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

  it('onSlashCommand sets priority 1 for priority-high', async () => {
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
      expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
        blockId: 'A',
        level: '1',
      })
    })
  })

  it('onSlashCommand sets priority 2 for priority-medium', async () => {
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
      expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
        blockId: 'A',
        level: '2',
      })
    })
  })

  it('onSlashCommand sets priority 3 for priority-low', async () => {
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
      expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
        blockId: 'A',
        level: '3',
      })
    })
  })

  it('passes priority prop to SortableBlock from block store field', async () => {
    const tree = [{ ...makeBlock('A', null, 0, 'Priority block'), priority: '2' }]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })
    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-priority', '2')
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
    mockedInvoke.mockResolvedValue(null)

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('priority-toggle-A')).toBeInTheDocument()
    })

    await user.click(screen.getByTestId('priority-toggle-A'))

    // Should have called set_priority with 1 (cycling from none)
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
        blockId: 'A',
        level: '1',
      })
    })

    // State should update to 1
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-priority', '1')
    })
  })
})

// =========================================================================
// Repeat slash commands tests (#640)
// =========================================================================

describe('BlockTree repeat slash commands', () => {
  it('searchSlashCommands returns repeat preset commands when query matches "repeat"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('repeat')

    expect(results).toBeDefined()
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).toContain('repeat-daily')
    expect(ids).toContain('repeat-weekly')
    expect(ids).toContain('repeat-monthly')
    expect(ids).toContain('repeat-yearly')
  })

  it('repeat preset commands have correct labels', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('repeat')

    const labels = results?.map((r) => r.label) ?? []
    expect(labels).toContain('REPEAT DAILY — Every day')
    expect(labels).toContain('REPEAT WEEKLY — Every week')
    expect(labels).toContain('REPEAT MONTHLY — Every month')
    expect(labels).toContain('REPEAT YEARLY — Every year')
  })

  it('repeat preset commands are not shown for empty query', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('')

    const ids = results?.map((r) => r.id) ?? []
    expect(ids).not.toContain('repeat-daily')
    expect(ids).not.toContain('repeat-weekly')
    expect(ids).not.toContain('repeat-monthly')
    expect(ids).not.toContain('repeat-yearly')
  })

  it('onSlashCommand sets repeat property to weekly for repeat-weekly', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'repeat-weekly', label: 'REPEAT WEEKLY — Every week' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'repeat',
        valueText: 'weekly',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('onSlashCommand sets repeat property to daily for repeat-daily', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'repeat-daily', label: 'REPEAT DAILY — Every day' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'repeat',
        valueText: 'daily',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('onSlashCommand sets repeat property to monthly for repeat-monthly', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'repeat-monthly', label: 'REPEAT MONTHLY — Every month' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'repeat',
        valueText: 'monthly',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('onSlashCommand sets repeat property to yearly for repeat-yearly', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'repeat-yearly', label: 'REPEAT YEARLY — Every year' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'repeat',
        valueText: 'yearly',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })
})

// =========================================================================
// Repeat mode variants and end-condition tests (Tasks 6 & 7)
// =========================================================================

describe('BlockTree repeat mode variants', () => {
  it('searchSlashCommands returns .+ and ++ mode variants for repeat query', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('repeat')

    expect(results).toBeDefined()
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).toContain('repeat-.+daily')
    expect(ids).toContain('repeat-.+weekly')
    expect(ids).toContain('repeat-.+monthly')
    expect(ids).toContain('repeat-++daily')
    expect(ids).toContain('repeat-++weekly')
    expect(ids).toContain('repeat-++monthly')
  })

  it('onSlashCommand sets repeat property with .+ prefix for from-completion mode', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({
        id: 'repeat-.+weekly',
        label: 'REPEAT WEEKLY (from completion) — Weeks from when done',
      })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'repeat',
        valueText: '.+weekly',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('onSlashCommand sets repeat property with ++ prefix for catch-up mode', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({
        id: 'repeat-++daily',
        label: 'REPEAT DAILY (catch-up) — Advance to next future date',
      })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'repeat',
        valueText: '++daily',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('repeat-remove deletes the repeat property', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({
        id: 'repeat-remove',
        label: 'REPEAT REMOVE — Clear recurrence',
      })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
        blockId: 'A',
        key: 'repeat',
      })
    })
  })
})

describe('BlockTree repeat end-condition commands', () => {
  it('searchSlashCommands returns end-condition commands for repeat query', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('repeat')

    expect(results).toBeDefined()
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).toContain('repeat-until')
    expect(ids).toContain('repeat-limit-5')
    expect(ids).toContain('repeat-limit-10')
    expect(ids).toContain('repeat-limit-20')
    expect(ids).toContain('repeat-limit-remove')
  })

  it('repeat-until opens date picker with repeat-until mode', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })
    useMockEditor = true

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    await act(async () => {
      capturedOnSlashCommand?.({
        id: 'repeat-until',
        label: 'REPEAT UNTIL — Stop repeating after a date',
      })
    })

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Date picker' })).toBeInTheDocument()
    })
  })

  it('handleDatePick sets repeat-until property when date is selected', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })
    useMockEditor = true

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    // Open the date picker in repeat-until mode
    await act(async () => {
      capturedOnSlashCommand?.({
        id: 'repeat-until',
        label: 'REPEAT UNTIL — Stop repeating after a date',
      })
    })

    await waitFor(() => {
      expect(mockCalendarOnSelect).toBeDefined()
    })

    mockedInvoke.mockResolvedValueOnce(null)

    // Simulate selecting June 30, 2026 from the calendar
    await act(async () => {
      mockCalendarOnSelect?.(new Date(2026, 5, 30))
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'repeat-until',
        valueText: null,
        valueNum: null,
        valueDate: '2026-06-30',
        valueRef: null,
      })
    })
  })

  it('repeat-limit sets repeat-count property', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({
        id: 'repeat-limit-10',
        label: 'REPEAT LIMIT 10 — Stop after 10 occurrences',
      })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'repeat-count',
        valueText: null,
        valueNum: 10,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('repeat-limit-remove deletes end condition properties', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({
        id: 'repeat-limit-remove',
        label: 'REPEAT LIMIT REMOVE — Clear end condition',
      })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
        blockId: 'A',
        key: 'repeat-count',
      })
      expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
        blockId: 'A',
        key: 'repeat-until',
      })
    })
  })
})

// =========================================================================
// Effort slash commands tests (#645)
// =========================================================================

describe('BlockTree effort slash commands', () => {
  it('searchSlashCommands returns effort presets when query matches "effort"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('effort')

    expect(results).toBeDefined()
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).toContain('effort-15m')
    expect(ids).toContain('effort-30m')
    expect(ids).toContain('effort-1h')
    expect(ids).toContain('effort-2h')
    expect(ids).toContain('effort-4h')
    expect(ids).toContain('effort-1d')
  })

  it('effort-1h preset sets effort property to "1h"', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'effort-1h', label: 'EFFORT 1h — 1 hour' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'effort',
        valueText: '1h',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })
})

// =========================================================================
// Due date slash command tests
// =========================================================================

describe('BlockTree due slash command', () => {
  it('searchSlashCommands returns due command when query matches "due"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('due')

    expect(results).toBeDefined()
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).toContain('due')
  })

  it('due command has correct label', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('due')

    const dueItem = results?.find((r) => r.id === 'due')
    expect(dueItem).toBeDefined()
    expect(dueItem?.label).toContain('DUE')
  })

  it('due command is not returned for non-matching query', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('zzz_nothing')
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).not.toContain('due')
  })
})

// =========================================================================
// Scheduled date slash command tests (#592)
// =========================================================================

describe('BlockTree schedule slash command', () => {
  it('searchSlashCommands returns schedule command when query matches "schedule"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('schedule')

    expect(results).toBeDefined()
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).toContain('schedule')
  })

  it('schedule command has correct label', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('schedule')

    const scheduleItem = results?.find((r) => r.id === 'schedule')
    expect(scheduleItem).toBeDefined()
    expect(scheduleItem?.label).toContain('SCHEDULED')
  })

  it('schedule command is not returned for non-matching query', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('zzz_nothing')
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).not.toContain('schedule')
  })

  it('sets scheduled date on block when /schedule command is executed', async () => {
    const tree = [makeBlock('A', null, 0, 'Some block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    // Return block A for list_blocks so load() doesn't wipe the store
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') {
        return { items: [tree[0]], next_cursor: null, has_more: false }
      }
      return emptyPage
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    // Trigger the /schedule command to open the date picker in schedule mode
    await act(async () => {
      capturedOnSlashCommand?.({ id: 'schedule', label: 'SCHEDULED — Set scheduled date on block' })
    })

    // The date picker should now be open
    await waitFor(() => {
      expect(mockCalendarOnSelect).toBeDefined()
    })

    // Mock set_scheduled_date response
    mockedInvoke.mockResolvedValueOnce({
      id: 'A',
      block_type: 'content',
      content: 'Some block',
      parent_id: null,
      position: 0,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: '2025-03-15',
    })

    // Simulate selecting March 15, 2025 from the calendar
    await act(async () => {
      mockCalendarOnSelect?.(new Date(2025, 2, 15))
    })

    // Verify set_scheduled_date was called
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_scheduled_date', {
        blockId: 'A',
        date: '2025-03-15',
      })
    })

    // Verify block store was updated optimistically
    await waitFor(() => {
      const block = useBlockStore.getState().blocks.find((b) => b.id === 'A')
      expect((block as unknown as Record<string, unknown>)?.scheduled_date).toBe('2025-03-15')
    })

    // Verify it did NOT call create_block (no date page created)
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: '2025-03-15' }),
    )
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
    mockedInvoke.mockResolvedValue(null)

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('todo-toggle-A')).toBeInTheDocument()
    })

    await user.click(screen.getByTestId('todo-toggle-A'))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Task state: To do')
    })
  })

  it('announces task state when cycling from TODO to DOING', async () => {
    const user = userEvent.setup()
    const tree = [{ ...makeBlock('A', null, 0, 'Task block'), todo_state: 'TODO' }]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })
    mockedInvoke.mockResolvedValue(null)

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'TODO')
    })

    await user.click(screen.getByTestId('todo-toggle-A'))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Task state: In progress')
    })
  })

  it('announces "Task state: none" when cycling from DONE to none', async () => {
    const user = userEvent.setup()
    const tree = [{ ...makeBlock('A', null, 0, 'Task block'), todo_state: 'DONE' }]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })
    mockedInvoke.mockResolvedValue(null)

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-todo-state', 'DONE')
    })

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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
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

  it('set-priority-1 event sets priority 1 on focused block', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue(null)

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
    })

    act(() => {
      document.dispatchEvent(new Event('set-priority-1'))
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
        blockId: 'A',
        level: '1',
      })
    })

    // Priority should update in UI
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-priority', '1')
    })
  })

  it('set-priority-2 event sets priority 2 on focused block', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue(null)

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
    })

    act(() => {
      document.dispatchEvent(new Event('set-priority-2'))
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
        blockId: 'A',
        level: '2',
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-priority', '2')
    })
  })

  it('set-priority-3 event sets priority 3 on focused block', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue(null)

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
    })

    act(() => {
      document.dispatchEvent(new Event('set-priority-3'))
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
        blockId: 'A',
        level: '3',
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toHaveAttribute('data-priority', '3')
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
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_priority', expect.anything())
  })
})

// =========================================================================
// #536: handleDatePick creates date pages in YYYY-MM-DD format
// =========================================================================

describe('BlockTree handleDatePick date format', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('creates date page in YYYY-MM-DD format (not DD/MM/YYYY)', async () => {
    const tree = [makeBlock('A', null, 0, 'Some block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    // Default response for load/preload/batch-resolve effects
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    // Trigger the /date command to open the date picker
    await act(async () => {
      capturedOnSlashCommand?.({ id: 'date', label: 'DATE — Link to a date page' })
    })

    // The date picker should now be open, and mockCalendarOnSelect captured
    await waitFor(() => {
      expect(mockCalendarOnSelect).toBeDefined()
    })

    // Mock listBlocks to return no existing date page (so a new one is created)
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    // Mock createBlock response for the new date page
    mockedInvoke.mockResolvedValueOnce({
      id: 'DATE_PAGE_1',
      block_type: 'page',
      content: '2025-03-15',
      parent_id: null,
      position: 0,
    })

    // Simulate selecting March 15, 2025 from the calendar
    await act(async () => {
      mockCalendarOnSelect?.(new Date(2025, 2, 15)) // month is 0-indexed
    })

    // Verify createBlock was called with YYYY-MM-DD format
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'page',
        content: '2025-03-15',
        parentId: null,
        position: null,
      })
    })

    // Ensure it was NOT called with the old DD/MM/YYYY format
    expect(mockedInvoke).not.toHaveBeenCalledWith('create_block', {
      blockType: 'page',
      content: '15/03/2025',
      parentId: null,
      position: null,
    })
  })

  it('finds existing date page by YYYY-MM-DD format', async () => {
    const tree = [makeBlock('A', null, 0, 'Some block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'date', label: 'DATE — Link to a date page' })
    })

    await waitFor(() => {
      expect(mockCalendarOnSelect).toBeDefined()
    })

    // Mock listBlocks to return an existing page in YYYY-MM-DD format
    mockedInvoke.mockResolvedValueOnce({
      items: [
        {
          id: 'EXISTING_DATE_PAGE',
          block_type: 'page',
          content: '2025-03-15',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    })

    await act(async () => {
      mockCalendarOnSelect?.(new Date(2025, 2, 15))
    })

    // Should NOT call create_block since the page already exists
    await new Promise((r) => setTimeout(r, 50))
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: '2025-03-15' }),
    )
  })

  it('sets due date on block when /due command is executed', async () => {
    const tree = [makeBlock('A', null, 0, 'Some block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    // Return block A for list_blocks so load() doesn't wipe the store
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') {
        return { items: [tree[0]], next_cursor: null, has_more: false }
      }
      return emptyPage
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    // Trigger the /due command to open the date picker in due-date mode
    await act(async () => {
      capturedOnSlashCommand?.({ id: 'due', label: 'DUE — Set due date on block' })
    })

    // The date picker should now be open
    await waitFor(() => {
      expect(mockCalendarOnSelect).toBeDefined()
    })

    // Mock set_due_date response
    mockedInvoke.mockResolvedValueOnce({
      id: 'A',
      block_type: 'content',
      content: 'Some block',
      parent_id: null,
      position: 0,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: '2025-03-15',
    })

    // Simulate selecting March 15, 2025 from the calendar
    await act(async () => {
      mockCalendarOnSelect?.(new Date(2025, 2, 15))
    })

    // Verify set_due_date was called (not create_block for a date page)
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_due_date', {
        blockId: 'A',
        date: '2025-03-15',
      })
    })

    // Verify block store was updated optimistically
    await waitFor(() => {
      const block = useBlockStore.getState().blocks.find((b) => b.id === 'A')
      expect(block?.due_date).toBe('2025-03-15')
    })

    // Verify it did NOT call create_block (no date page created)
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({ content: '2025-03-15' }),
    )
  })
})

// =========================================================================
// Link / Tag / Code slash command handler tests (#589)
// =========================================================================

describe('BlockTree link/tag/code slash commands', () => {
  it('onSlashCommand for /link inserts [[ via editor chain', async () => {
    useMockEditor = true
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'link', label: 'LINK — Insert page link' })
    })

    expect(mockInsertContent).toHaveBeenCalledWith('[[')
  })

  it('onSlashCommand for /tag inserts @ via editor chain', async () => {
    useMockEditor = true
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'tag', label: 'TAG — Insert tag reference' })
    })

    expect(mockInsertContent).toHaveBeenCalledWith('@')
  })

  it('onSlashCommand for /code calls toggleCodeBlock via editor chain', async () => {
    useMockEditor = true
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'code', label: 'CODE — Insert code block' })
    })

    expect(mockToggleCodeBlock).toHaveBeenCalled()
  })

  it('onSlashCommand for /query inserts query template via editor chain', async () => {
    useMockEditor = true
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'query', label: 'QUERY — Insert embedded query block' })
    })

    expect(mockInsertContent).toHaveBeenCalledWith('{{query type:tag expr:}}')
  })
})

// =========================================================================
// Date picker text input integration tests (#599)
// =========================================================================

describe('DatePickerOverlay text input', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('date picker shows text input field', async () => {
    const tree = [makeBlock('A', null, 0, 'Some block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    // Open the date picker via /date slash command
    await act(async () => {
      capturedOnSlashCommand?.({ id: 'date', label: 'DATE — Link to a date page' })
    })

    // Verify the text input is rendered inside the date picker
    const input = screen.getByLabelText('Type a date')
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('placeholder', 'Type a date... (today, +3d, Apr 15)')

    // Calendar should also be present
    expect(screen.getByTestId('mock-calendar')).toBeInTheDocument()
  })

  it("typing 'tomorrow' shows parsed preview", async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Some block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    // Open the date picker
    await act(async () => {
      capturedOnSlashCommand?.({ id: 'date', label: 'DATE — Link to a date page' })
    })

    const input = screen.getByLabelText('Type a date')

    // Type 'tomorrow'
    await user.type(input, 'tomorrow')

    // The preview should show a parsed date (format YYYY-MM-DD)
    expect(screen.getByText(/Parsed:/)).toBeInTheDocument()
    expect(screen.getByText(/press Enter to apply/)).toBeInTheDocument()

    // Should NOT show the error message
    expect(screen.queryByText('Could not parse date')).not.toBeInTheDocument()
  })

  it('typing an invalid date shows error message', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Some block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    // Open the date picker
    await act(async () => {
      capturedOnSlashCommand?.({ id: 'date', label: 'DATE — Link to a date page' })
    })

    const input = screen.getByLabelText('Type a date')

    // Type something unparseable
    await user.type(input, 'notadate')

    // Should show the error message
    expect(screen.getByText('Could not parse date')).toBeInTheDocument()
    expect(screen.queryByText(/Parsed:/)).not.toBeInTheDocument()
  })

  it('pressing Enter with valid date applies it via the date handler', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Some block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    // Use mockImplementation to handle set_due_date specifically
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') {
        return { items: [tree[0]], next_cursor: null, has_more: false }
      }
      if (cmd === 'set_due_date') {
        return {
          id: 'A',
          block_type: 'content',
          content: 'Some block',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: '2025-04-15',
          scheduled_date: null,
        }
      }
      return emptyPage
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    // Open the date picker in due-date mode so we can verify set_due_date is called
    await act(async () => {
      capturedOnSlashCommand?.({ id: 'due', label: 'DUE — Set due date on block' })
    })

    await waitFor(() => {
      expect(screen.getByLabelText('Type a date')).toBeInTheDocument()
    })

    const input = screen.getByLabelText('Type a date')

    // Type a specific date and press Enter
    await user.type(input, '2025-04-15{Enter}')

    // Verify set_due_date was called with the parsed date
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_due_date', {
        blockId: 'A',
        date: '2025-04-15',
      })
    })

    // Verify block store was updated
    await waitFor(() => {
      const block = useBlockStore.getState().blocks.find((b) => b.id === 'A')
      expect(block?.due_date).toBe('2025-04-15')
    })
  })
})

// =========================================================================
// Enter creates new sibling block + empty-block cleanup (#636)
// =========================================================================

describe('BlockTree Enter creates new sibling block', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('Enter creates a new sibling block below and focuses it', async () => {
    const tree = [makeBlock('A', null, 0, 'First block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    // Mock create_block to return a new block
    // Default return [] causes load() to fail silently, preserving pre-set store
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'create_block') {
        return {
          id: 'NEW_BLOCK_01',
          block_type: 'content',
          content: '',
          parent_id: (args?.parentId as string) ?? null,
          position: 1,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
        }
      }
      return []
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onEnterSave).toBeDefined()
    })

    await act(async () => {
      ;(capturedBlockKeyboardOpts as { onEnterSave: () => void }).onEnterSave()
    })

    // Verify create_block was called
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'content',
        content: '',
        parentId: null,
        position: 1,
      })
    })

    // Verify focus moved to the new block
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('NEW_BLOCK_01')
    })

    // Verify the new block exists in the store
    const newBlock = useBlockStore.getState().blocks.find((b) => b.id === 'NEW_BLOCK_01')
    expect(newBlock).toBeDefined()
  })

  it('empty just-created block is deleted when focus changes', async () => {
    const tree = [makeBlock('A', null, 0, 'First block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'create_block') {
        return {
          id: 'NEW_EMPTY',
          block_type: 'content',
          content: '',
          parent_id: (args?.parentId as string) ?? null,
          position: 1,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
        }
      }
      if (cmd === 'delete_block') {
        return { deleted_count: 1 }
      }
      return []
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onEnterSave).toBeDefined()
    })

    // Create new block via Enter
    await act(async () => {
      ;(capturedBlockKeyboardOpts as { onEnterSave: () => void }).onEnterSave()
    })

    // Verify the new block was created and focused
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('NEW_EMPTY')
    })

    // Now change focus away from the empty just-created block
    act(() => {
      useBlockStore.setState({ focusedBlockId: 'A' })
    })

    // Verify delete_block was called to clean up the empty block
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'NEW_EMPTY' })
    })
  })

  it('non-empty just-created block is NOT deleted when focus changes', async () => {
    const tree = [makeBlock('A', null, 0, 'First block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'create_block') {
        return {
          id: 'NEW_WITH_CONTENT',
          block_type: 'content',
          content: '',
          parent_id: (args?.parentId as string) ?? null,
          position: 1,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
        }
      }
      if (cmd === 'edit_block') {
        return args
      }
      if (cmd === 'delete_block') {
        return { deleted_count: 1 }
      }
      return []
    })

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts?.onEnterSave).toBeDefined()
    })

    // Create new block via Enter
    await act(async () => {
      ;(capturedBlockKeyboardOpts as { onEnterSave: () => void }).onEnterSave()
    })

    // Verify the new block was created and focused
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('NEW_WITH_CONTENT')
    })

    // Simulate the user typing content into the new block (update store state)
    act(() => {
      useBlockStore.setState((s) => ({
        blocks: s.blocks.map((b) =>
          b.id === 'NEW_WITH_CONTENT' ? { ...b, content: 'User typed something' } : b,
        ),
      }))
    })

    // Clear the mock to track only future calls
    mockedInvoke.mockClear()

    // Now change focus away from the non-empty just-created block
    act(() => {
      useBlockStore.setState({ focusedBlockId: 'A' })
    })

    // Wait a tick to ensure the cleanup effect has run
    await new Promise((r) => setTimeout(r, 50))

    // Verify delete_block was NOT called (block has content)
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', {
      blockId: 'NEW_WITH_CONTENT',
    })
  })
})

// =========================================================================
// Zoom-in to block with breadcrumb trail (#637)
// =========================================================================

describe('BlockTree zoom-in', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('zoom filters blocks to descendants only', async () => {
    const user = userEvent.setup()
    const tree = [
      makeBlock('A', null, 0, 'Parent A'),
      makeBlock('B', 'A', 1, 'Child B'),
      makeBlock('D', 'B', 2, 'Grandchild D'),
      makeBlock('C', 'A', 1, 'Child C'),
    ]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    // All blocks visible initially
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-B')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-C')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-D')).toBeInTheDocument()
    })

    // Block A has children, so it should have a zoom-in button
    expect(screen.getByTestId('zoom-in-A')).toBeInTheDocument()

    // Zoom into A
    await user.click(screen.getByTestId('zoom-in-A'))

    // After zooming into A, only descendants (B, C, D) should be visible; A itself should not
    await waitFor(() => {
      expect(screen.queryByTestId('sortable-block-A')).not.toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-B')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-C')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-D')).toBeInTheDocument()
    })
  })

  it('breadcrumb renders when zoomed', async () => {
    const user = userEvent.setup()
    const tree = [
      makeBlock('A', null, 0, 'Root A'),
      makeBlock('B', 'A', 1, 'Child B'),
      makeBlock('C', 'B', 2, 'Grandchild C'),
    ]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-B')).toBeInTheDocument()
    })

    // No breadcrumb initially
    expect(screen.queryByRole('navigation', { name: 'Block breadcrumb' })).not.toBeInTheDocument()

    // Zoom into B (which has children)
    await user.click(screen.getByTestId('zoom-in-B'))

    // Breadcrumb should appear
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Block breadcrumb' })).toBeInTheDocument()
    })

    // Breadcrumb should contain the ancestor trail: A → B
    expect(screen.getByText('Root A')).toBeInTheDocument()
    expect(screen.getByText('Child B')).toBeInTheDocument()
  })

  it('clicking home button in breadcrumb resets zoom', async () => {
    const user = userEvent.setup()
    const tree = [
      makeBlock('A', null, 0, 'Root A'),
      makeBlock('B', 'A', 1, 'Child B'),
      makeBlock('C', 'B', 2, 'Grandchild C'),
    ]

    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: null })

    render(<BlockTree />)

    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
    })

    // Zoom into A
    await user.click(screen.getByTestId('zoom-in-A'))

    // Verify zoom is active (A is hidden, descendants visible)
    await waitFor(() => {
      expect(screen.queryByTestId('sortable-block-A')).not.toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-B')).toBeInTheDocument()
    })

    // Breadcrumb should be visible
    const nav = screen.getByRole('navigation', { name: 'Block breadcrumb' })
    expect(nav).toBeInTheDocument()

    // Click the home button (first button inside the nav)
    const homeButton = nav.querySelector('button')
    expect(homeButton).not.toBeNull()
    await user.click(homeButton!)

    // All blocks should be visible again
    await waitFor(() => {
      expect(screen.getByTestId('sortable-block-A')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-B')).toBeInTheDocument()
      expect(screen.getByTestId('sortable-block-C')).toBeInTheDocument()
    })

    // Breadcrumb should be gone
    expect(screen.queryByRole('navigation', { name: 'Block breadcrumb' })).not.toBeInTheDocument()
  })
})

// =========================================================================
// Template slash command tests (#632)
// =========================================================================

describe('BlockTree /template slash command', () => {
  it('searchSlashCommands returns /template command when query matches "template"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('template')

    expect(results?.some((r) => r.id === 'template')).toBe(true)
  })

  it('searchSlashCommands includes template in full command list', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('')

    expect(results?.some((r) => r.id === 'template')).toBe(true)
  })
})

// =========================================================================
// Keyboard shortcut wiring: Ctrl+Shift+P → onShowProperties (#645)
// =========================================================================

describe('BlockTree Ctrl+Shift+P keyboard shortcut', () => {
  it('passes onShowProperties to useBlockKeyboard', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedBlockKeyboardOpts).toBeDefined()
    })

    expect(typeof capturedBlockKeyboardOpts?.onShowProperties).toBe('function')
  })
})

// =========================================================================
// Assignee slash command presets (#645-12)
// =========================================================================

describe('BlockTree assignee slash command presets', () => {
  it('searchSlashCommands returns assignee presets when query matches "assignee"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('assignee')

    expect(results).toBeDefined()
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).toContain('assignee')
    expect(ids).toContain('assignee-me')
    expect(ids).toContain('assignee-custom')
  })

  it('assignee-me preset sets assignee property to "Me"', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'assignee-me', label: 'ASSIGNEE Me — Assign to me' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'assignee',
        valueText: 'Me',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('assignee-custom preset sets assignee property to empty string', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({
        id: 'assignee-custom',
        label: 'ASSIGNEE Custom... — Enter custom assignee',
      })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'assignee',
        valueText: '',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })
})

// =========================================================================
// Location slash command presets (#645-12)
// =========================================================================

describe('BlockTree location slash command presets', () => {
  it('searchSlashCommands returns location presets when query matches "location"', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedSearchSlashCommands).toBeDefined()
    })

    const results = await capturedSearchSlashCommands?.('location')

    expect(results).toBeDefined()
    const ids = results?.map((r) => r.id) ?? []
    expect(ids).toContain('location')
    expect(ids).toContain('location-office')
    expect(ids).toContain('location-home')
    expect(ids).toContain('location-remote')
    expect(ids).toContain('location-custom')
  })

  it('location-office preset sets location property to "Office"', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({ id: 'location-office', label: 'LOCATION Office — Office' })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'location',
        valueText: 'Office',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('location-custom preset sets location property to empty string', async () => {
    const tree = [makeBlock('A', null, 0, 'Block')]
    useBlockStore.setState({ blocks: tree, loading: false, focusedBlockId: 'A' })

    mockedInvoke.mockResolvedValue([])

    render(<BlockTree />)

    await waitFor(() => {
      expect(capturedOnSlashCommand).toBeDefined()
    })

    mockedInvoke.mockResolvedValue(null)

    await act(async () => {
      capturedOnSlashCommand?.({
        id: 'location-custom',
        label: 'LOCATION Custom... — Enter custom location',
      })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'A',
        key: 'location',
        valueText: '',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })
})

// =========================================================================
// Multi-selection tests (#657)
// =========================================================================

describe('BlockTree multi-selection (#657)', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('Ctrl+Click toggles block selection via onSelect', async () => {
    const tree = [makeBlock('A', null, 0, 'Alpha'), makeBlock('B', null, 1, 'Beta')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: [],
    })

    render(<BlockTree />)
    await screen.findByTestId('sortable-block-A')

    const selectA = screen.getByTestId('select-A')
    await userEvent.setup().click(selectA)

    expect(useBlockStore.getState().selectedBlockIds).toContain('A')
  })

  it('isSelected prop is passed to SortableBlock', async () => {
    const tree = [makeBlock('A', null, 0, 'Alpha')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: ['A'],
    })

    render(<BlockTree />)
    const block = await screen.findByTestId('sortable-block-A')
    expect(block.dataset.selected).toBe('true')
  })

  it('unselected block has data-selected=false', async () => {
    const tree = [makeBlock('A', null, 0, 'Alpha')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: [],
    })

    render(<BlockTree />)
    const block = await screen.findByTestId('sortable-block-A')
    expect(block.dataset.selected).toBe('false')
  })

  it('Escape clears selection when not editing', async () => {
    const tree = [makeBlock('A', null, 0, 'Alpha')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: ['A'],
    })

    render(<BlockTree />)
    await screen.findByTestId('sortable-block-A')

    await userEvent.setup().keyboard('{Escape}')

    expect(useBlockStore.getState().selectedBlockIds).toEqual([])
  })

  it('selection is cleared when entering edit mode (setFocused)', () => {
    const tree = [makeBlock('A', null, 0, 'Alpha')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: ['A'],
    })

    useBlockStore.getState().setFocused('A')
    expect(useBlockStore.getState().selectedBlockIds).toEqual([])
  })
})

// =========================================================================
// Batch toolbar (#657)
// =========================================================================

describe('BlockTree batch toolbar (#657)', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('shows batch toolbar when blocks are selected', async () => {
    const tree = [makeBlock('A', null, 0, 'Alpha'), makeBlock('B', null, 1, 'Beta')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: ['A'],
    })

    render(<BlockTree />)
    await screen.findByTestId('sortable-block-A')

    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })

  it('batch toolbar hidden when no selection', async () => {
    const tree = [makeBlock('A', null, 0, 'Alpha')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: [],
    })

    render(<BlockTree />)
    await screen.findByTestId('sortable-block-A')

    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
  })

  it('batch delete shows confirmation dialog', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Alpha'), makeBlock('B', null, 1, 'Beta')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: ['A', 'B'],
    })

    render(<BlockTree />)
    await screen.findByTestId('sortable-block-A')

    const deleteBtn = screen.getByRole('button', { name: /Delete/i })
    await user.click(deleteBtn)

    expect(screen.getByText(/Delete 2 block/)).toBeInTheDocument()
  })

  it('batch delete calls deleteBlock for each selected', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Alpha'), makeBlock('B', null, 1, 'Beta')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: ['A', 'B'],
    })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'delete_block')
        return {
          block_id: 'X',
          deleted_at: '2026-04-03T00:00:00Z',
          descendants_affected: 0,
        }
      return null
    })

    render(<BlockTree />)
    await screen.findByTestId('sortable-block-A')

    // Click Delete, then confirm
    await user.click(screen.getByRole('button', { name: /Delete/i }))
    await user.click(screen.getByRole('button', { name: /Yes, delete/i }))

    await waitFor(() => {
      const deleteCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_block')
      expect(deleteCalls.length).toBe(2)
    })

    // Selection should be cleared
    expect(useBlockStore.getState().selectedBlockIds).toEqual([])
  })

  it('batch set todo state calls setTodoState for each selected', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Alpha'), makeBlock('B', null, 1, 'Beta')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: ['A', 'B'],
    })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_todo_state')
        return {
          id: 'X',
          block_type: 'content',
          content: 'X',
          parent_id: null,
          position: 0,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: 'TODO',
          priority: null,
          due_date: null,
          scheduled_date: null,
        }
      return null
    })

    render(<BlockTree />)
    await screen.findByTestId('sortable-block-A')

    // Click TODO button in the batch toolbar
    await user.click(screen.getByRole('button', { name: 'TODO' }))

    await waitFor(() => {
      const todoCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'set_todo_state')
      expect(todoCalls.length).toBe(2)
    })

    // Selection should be cleared
    expect(useBlockStore.getState().selectedBlockIds).toEqual([])
  })

  it('clear selection button clears selectedBlockIds', async () => {
    const user = userEvent.setup()
    const tree = [makeBlock('A', null, 0, 'Alpha')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: ['A'],
    })

    render(<BlockTree />)
    await screen.findByTestId('sortable-block-A')

    await user.click(screen.getByRole('button', { name: /Clear selection/i }))

    expect(useBlockStore.getState().selectedBlockIds).toEqual([])
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
  })

  it('batch buttons disabled during operation', async () => {
    let resolveInvoke!: (v: unknown) => void
    const tree = [makeBlock('A', null, 0, 'Alpha'), makeBlock('B', null, 1, 'Beta')]
    useBlockStore.setState({
      blocks: tree,
      loading: false,
      focusedBlockId: null,
      selectedBlockIds: ['A', 'B'],
    })

    render(<BlockTree />)
    await screen.findByTestId('sortable-block-A')

    // Now mock set_todo_state to block, after initial render is done
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_todo_state') {
        return new Promise((resolve) => {
          resolveInvoke = resolve
        })
      }
      return { items: [], next_cursor: null, has_more: false }
    })

    // Start a batch TODO operation
    const todoBtn = screen.getByRole('button', { name: 'TODO' })
    await userEvent.click(todoBtn)

    // Buttons should be disabled while operation is in progress
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'TODO' })).toBeDisabled()
    })
    expect(screen.getByRole('button', { name: 'DOING' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'DONE' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Delete/i })).toBeDisabled()

    // Resolve the pending invoke calls to clean up
    resolveInvoke({
      id: 'A',
      block_type: 'content',
      content: 'Alpha',
      parent_id: null,
      position: 0,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: 'TODO',
      priority: null,
      due_date: null,
      scheduled_date: null,
    })
  })
})
