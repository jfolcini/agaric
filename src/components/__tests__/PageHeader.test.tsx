/**
 * Tests for PageHeader component.
 *
 * Validates:
 *  - Renders page title
 *  - Renders back button when onBack provided
 *  - Does not render back button when onBack omitted
 *  - Renders tag badges for applied tags
 *  - Title editing: blur, empty revert, Enter key
 *  - Tag management: add, remove, create, search, create option
 *  - Integration: badges update after add/remove
 *  - Edge cases: no tags, title edit error
 *  - Accessibility compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { useNavigationStore } from '../../stores/navigation'
import { useResolveStore } from '../../stores/resolve'
import { useUndoStore } from '../../stores/undo'
import { PageHeader } from '../PageHeader'

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false }

// Mock lucide-react
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <svg data-testid="arrow-left-icon" />,
  ChevronDown: () => <svg data-testid="chevron-down" />,
  ChevronRight: () => <svg data-testid="chevron-right" />,
  Plus: () => <svg data-testid="plus-icon" />,
  X: () => <svg data-testid="x-icon" />,
}))

// Mock sonner
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { toast } from 'sonner'

const mockedToastError = vi.mocked(toast.error)

beforeEach(() => {
  vi.clearAllMocks()
  useNavigationStore.setState({
    currentView: 'page-editor',
    pageStack: [{ pageId: 'PAGE_1', title: 'My Page' }],
    selectedBlockId: null,
  })
  useResolveStore.setState({ cache: new Map(), pagesList: [], version: 0, _preloaded: false })
  useUndoStore.setState({ pages: new Map() })
  // Default: no tags exist, no tags applied
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'list_blocks') return emptyPage
    if (cmd === 'list_tags_for_block') return []
    if (cmd === 'get_properties') return []
    if (cmd === 'list_property_defs') return []
    return null
  })
})

/** Helper to set up invoke mock with tags */
function setupTagMock(appliedIds: string[] = ['TAG_1']) {
  mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
    if (cmd === 'list_blocks') {
      return {
        items: [
          {
            id: 'TAG_1',
            block_type: 'tag',
            content: 'urgent',
            parent_id: null,
            position: null,
            deleted_at: null,
            archived_at: null,
            is_conflict: false,
            conflict_type: null,
          },
          {
            id: 'TAG_2',
            block_type: 'tag',
            content: 'review',
            parent_id: null,
            position: null,
            deleted_at: null,
            archived_at: null,
            is_conflict: false,
            conflict_type: null,
          },
        ],
        next_cursor: null,
        has_more: false,
      }
    }
    if (cmd === 'list_tags_for_block') return appliedIds
    if (cmd === 'add_tag') return { block_id: args?.block_id, tag_id: args?.tag_id }
    if (cmd === 'remove_tag') return { block_id: args?.block_id, tag_id: args?.tag_id }
    if (cmd === 'create_block')
      return {
        id: 'TAG_NEW',
        block_type: 'tag',
        content: args?.content,
        parent_id: null,
        position: null,
        deleted_at: null,
        archived_at: null,
        is_conflict: false,
        conflict_type: null,
      }
    if (cmd === 'edit_block')
      return {
        id: args?.blockId,
        block_type: 'page',
        content: args?.toText,
        parent_id: null,
        position: null,
      }
    if (cmd === 'get_properties') return []
    if (cmd === 'list_property_defs') return []
    return null
  })
}

describe('PageHeader rendering', () => {
  it('renders title', () => {
    render(<PageHeader pageId="PAGE_1" title="My Test Page" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })
    expect(titleEl).toBeInTheDocument()
    expect(titleEl).toHaveTextContent('My Test Page')
  })

  it('renders back button when onBack provided', () => {
    render(<PageHeader pageId="PAGE_1" title="My Page" onBack={() => {}} />)

    const backBtn = screen.getByRole('button', { name: /go back/i })
    expect(backBtn).toBeInTheDocument()
  })

  it('does not render back button when onBack omitted', () => {
    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    expect(screen.queryByRole('button', { name: /go back/i })).not.toBeInTheDocument()
  })

  it('renders tag badges for applied tags', async () => {
    setupTagMock(['TAG_1'])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for tags to load
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
    })

    // TAG_2 (review) should not be in badges since it's not applied
    expect(screen.queryByText('review')).not.toBeInTheDocument()
  })
})

describe('PageHeader title editing', () => {
  it('updates title on blur after editing', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    render(<PageHeader pageId="PAGE_1" title="Old Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })

    await user.clear(titleEl)
    await user.type(titleEl, 'New Title')
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'PAGE_1',
        toText: 'New Title',
      })
    })
  })

  it('reverts empty title on blur', async () => {
    const user = userEvent.setup()

    render(<PageHeader pageId="PAGE_1" title="Original Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })

    await user.clear(titleEl)
    await user.tab()

    // Should revert to original title
    expect(titleEl).toHaveTextContent('Original Title')
    // Should NOT have called editBlock
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
  })

  it('blur on Enter key', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    render(<PageHeader pageId="PAGE_1" title="Old Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })

    await user.clear(titleEl)
    await user.type(titleEl, 'Entered Title')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'PAGE_1',
        toText: 'Entered Title',
      })
    })
  })
})

describe('PageHeader tag management', () => {
  it('add tag via picker', async () => {
    const user = userEvent.setup()
    setupTagMock(['TAG_1'])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for tags to load
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
    })

    // Open tag picker
    const addBtn = screen.getByRole('button', { name: /add tag/i })
    await user.click(addBtn)

    // Wait for picker to open and click "review" tag
    await waitFor(() => {
      expect(screen.getByText('review')).toBeInTheDocument()
    })
    await user.click(screen.getByText('review'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('add_tag', {
        blockId: 'PAGE_1',
        tagId: 'TAG_2',
      })
    })
  })

  it('remove tag via badge X button', async () => {
    const user = userEvent.setup()
    setupTagMock(['TAG_1'])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for the tag badge to appear
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
    })

    // Click remove button
    const removeBtn = screen.getByRole('button', { name: /remove tag urgent/i })
    await user.click(removeBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('remove_tag', {
        blockId: 'PAGE_1',
        tagId: 'TAG_1',
      })
    })
  })

  it('create new tag', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Open tag picker
    const addBtn = screen.getByRole('button', { name: /add tag/i })
    await user.click(addBtn)

    // Wait for picker to open
    await waitFor(() => {
      expect(screen.getByLabelText('Search tags')).toBeInTheDocument()
    })

    // Type a new tag name
    const searchInput = screen.getByLabelText('Search tags')
    await user.type(searchInput, 'newtag')

    // Click Create button
    await waitFor(() => {
      expect(screen.getByText(/Create "newtag"/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/Create "newtag"/))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'tag',
        content: 'newtag',
        parentId: null,
        position: null,
      })
    })
  })

  it('search filters available tags', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Open picker
    const addBtn = screen.getByRole('button', { name: /add tag/i })
    await user.click(addBtn)

    // Wait for tags to show
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
      expect(screen.getByText('review')).toBeInTheDocument()
    })

    // Type search filter
    const searchInput = screen.getByLabelText('Search tags')
    await user.type(searchInput, 'urg')

    // "urgent" should still be visible, "review" should not
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
      expect(screen.queryByText('review')).not.toBeInTheDocument()
    })
  })

  it('picker shows "Create" option for new tag name', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Open picker
    const addBtn = screen.getByRole('button', { name: /add tag/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(screen.getByLabelText('Search tags')).toBeInTheDocument()
    })

    // Type a name that doesn't match any tag
    const searchInput = screen.getByLabelText('Search tags')
    await user.type(searchInput, 'brandnew')

    await waitFor(() => {
      expect(screen.getByText(/Create "brandnew"/)).toBeInTheDocument()
    })
  })
})

describe('PageHeader integration', () => {
  it('tag badges update after adding a tag', async () => {
    const user = userEvent.setup()
    setupTagMock(['TAG_1'])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for initial badge
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
    })

    // "review" should not be a badge yet
    expect(screen.queryByRole('button', { name: /remove tag review/i })).not.toBeInTheDocument()

    // Open picker and add "review"
    const addBtn = screen.getByRole('button', { name: /add tag/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(screen.getByText('review')).toBeInTheDocument()
    })
    await user.click(screen.getByText('review'))

    // After adding, "review" should appear as a badge
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove tag review/i })).toBeInTheDocument()
    })
  })

  it('tag badges update after removing a tag', async () => {
    const user = userEvent.setup()
    setupTagMock(['TAG_1', 'TAG_2'])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for both badges
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
      expect(screen.getByText('review')).toBeInTheDocument()
    })

    // Remove "urgent"
    const removeBtn = screen.getByRole('button', { name: /remove tag urgent/i })
    await user.click(removeBtn)

    // "urgent" badge should disappear
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /remove tag urgent/i })).not.toBeInTheDocument()
    })

    // "review" should still be there
    expect(screen.getByText('review')).toBeInTheDocument()
  })
})

describe('PageHeader edge cases', () => {
  it('no tags renders empty state with Add tag button', () => {
    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    const addBtn = screen.getByRole('button', { name: /add tag/i })
    expect(addBtn).toBeInTheDocument()
    expect(addBtn).toHaveTextContent('Add tag')
  })

  it('handles title edit error gracefully', async () => {
    const user = userEvent.setup()

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'edit_block') throw new Error('backend error')
      return null
    })

    render(<PageHeader pageId="PAGE_1" title="Original Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })

    await user.clear(titleEl)
    await user.type(titleEl, 'Bad Title')
    await user.tab()

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to rename page')
    })

    // Title should revert
    expect(titleEl).toHaveTextContent('Original Title')
  })
})

describe('PageHeader accessibility', () => {
  it('has no a11y violations', async () => {
    const { container } = render(
      <PageHeader pageId="PAGE_1" title="Accessible Page" onBack={() => {}} />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with tag picker open', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    const { container } = render(<PageHeader pageId="PAGE_1" title="A11y Page" />)

    // Wait for tags to load then open picker
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add tag/i })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /add tag/i }))

    await waitFor(() => {
      expect(screen.getByLabelText('Tag picker')).toBeInTheDocument()
    })

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
