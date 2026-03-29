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
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PickerItem } from '../../editor/SuggestionList'
import { useBlockStore } from '../../stores/blocks'

// Capture the options passed to useRovingEditor so we can call searchTags/searchPages directly.
let capturedSearchTags: ((query: string) => PickerItem[] | Promise<PickerItem[]>) | undefined
let capturedSearchPages: ((query: string) => PickerItem[] | Promise<PickerItem[]>) | undefined

vi.mock('../../editor/use-roving-editor', () => ({
  useRovingEditor: (opts: {
    searchTags?: (query: string) => PickerItem[] | Promise<PickerItem[]>
    searchPages?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  }) => {
    capturedSearchTags = opts.searchTags
    capturedSearchPages = opts.searchPages
    return {
      editor: null,
      mount: vi.fn(),
      unmount: vi.fn(() => null),
      activeBlockId: null,
    }
  },
}))

vi.mock('../../editor/use-block-keyboard', () => ({
  useBlockKeyboard: vi.fn(),
}))

vi.mock('../../hooks/useViewportObserver', () => ({
  useViewportObserver: () => ({
    isOffscreen: () => false,
    observeRef: vi.fn(),
    getHeight: () => 40,
  }),
}))

// Minimal mock for SortableBlock
vi.mock('../SortableBlock', () => ({
  SortableBlock: (props: { blockId: string }) => (
    <div data-testid={`sortable-block-${props.blockId}`}>SortableBlock</div>
  ),
}))

// Minimal mock for @dnd-kit
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
}))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
}))

import { BlockTree } from '../BlockTree'

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
  capturedSearchTags = undefined
  capturedSearchPages = undefined
  useBlockStore.setState({
    blocks: [],
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

  it('searchPages calls list_blocks with blockType=page and limit=20', async () => {
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
        },
        {
          id: 'P2',
          block_type: 'page',
          content: 'Project Plan',
          parent_id: null,
          position: 1,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
        },
        {
          id: 'P3',
          block_type: 'page',
          content: 'Daily Log',
          parent_id: null,
          position: 2,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(pagesResp)

    const results = await capturedSearchPages?.('meet')

    expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
      parentId: null,
      blockType: 'page',
      tagId: null,
      showDeleted: null,
      agendaDate: null,
      cursor: null,
      limit: 20,
    })
    expect(results).toEqual([{ id: 'P1', label: 'Meeting Notes' }])
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

  it('searchPages returns empty array when no pages match query', async () => {
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
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(pagesResp)

    const results = await capturedSearchPages?.('zzz_no_match')

    expect(results).toEqual([])
  })

  it('renders loading state', () => {
    useBlockStore.setState({ loading: true })

    const { container } = render(<BlockTree />)

    expect(container.querySelector('.block-tree-loading')).toBeInTheDocument()
  })

  it('renders empty state when no blocks', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<BlockTree />)

    await waitFor(() => {
      expect(useBlockStore.getState().loading).toBe(false)
    })

    const emptyEl = document.querySelector('.block-tree-empty')
    expect(emptyEl).toBeInTheDocument()
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
