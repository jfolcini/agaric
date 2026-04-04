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
  MoreVertical: () => <svg data-testid="more-vertical-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
  Redo2: () => <svg data-testid="redo2-icon" />,
  Undo2: () => <svg data-testid="undo2-icon" />,
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
    if (cmd === 'get_page_aliases') return []
    return null
  })
})

/** Helper to set up invoke mock with tags */
function setupTagMock(appliedIds: string[] = ['TAG_1'], aliases: string[] = []) {
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
    if (cmd === 'get_page_aliases') return aliases
    if (cmd === 'set_page_aliases') return args?.aliases ?? []
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
      if (cmd === 'get_page_aliases') return []
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

// ── Alias display & editing ───────────────────────────────────────────────

describe('PageHeader alias display', () => {
  it('fetches and displays aliases on mount', async () => {
    setupTagMock([], ['daily-note', 'DN'])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    await waitFor(() => {
      expect(screen.getByText('Also known as:')).toBeInTheDocument()
      expect(screen.getByText('daily-note')).toBeInTheDocument()
      expect(screen.getByText('DN')).toBeInTheDocument()
    })

    // Verify get_page_aliases was called
    expect(mockedInvoke).toHaveBeenCalledWith('get_page_aliases', { pageId: 'PAGE_1' })
  })

  it('shows "Add alias" button when no aliases', async () => {
    setupTagMock([])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    await waitFor(() => {
      const addAliasBtn = screen.getByRole('button', { name: /\+ add alias/i })
      expect(addAliasBtn).toBeInTheDocument()
    })
  })

  it('clicking Edit enables alias editing mode', async () => {
    const user = userEvent.setup()
    setupTagMock([], ['my-alias'])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for aliases to render
    await waitFor(() => {
      expect(screen.getByText('my-alias')).toBeInTheDocument()
    })

    // Click the Edit button
    const editBtn = screen.getByRole('button', { name: /edit/i })
    await user.click(editBtn)

    // Should now show the alias input form
    await waitFor(() => {
      expect(screen.getByLabelText('New alias input')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument()
    })

    // Should show remove button on existing alias
    expect(screen.getByRole('button', { name: /remove alias my-alias/i })).toBeInTheDocument()
  })

  it('adding an alias calls setPageAliases', async () => {
    const user = userEvent.setup()
    setupTagMock([], ['existing-alias'])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for aliases to render, then enter edit mode
    await waitFor(() => {
      expect(screen.getByText('existing-alias')).toBeInTheDocument()
    })

    const editBtn = screen.getByRole('button', { name: /edit/i })
    await user.click(editBtn)

    // Type a new alias and submit
    const aliasInput = screen.getByLabelText('New alias input')
    await user.type(aliasInput, 'new-alias')
    await user.click(screen.getByRole('button', { name: /^add$/i }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_page_aliases', {
        pageId: 'PAGE_1',
        aliases: ['existing-alias', 'new-alias'],
      })
    })

    // The new alias should appear in the UI
    expect(screen.getByText('new-alias')).toBeInTheDocument()
  })

  it('removing an alias calls setPageAliases', async () => {
    const user = userEvent.setup()
    setupTagMock([], ['alias-a', 'alias-b'])

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for aliases to render
    await waitFor(() => {
      expect(screen.getByText('alias-a')).toBeInTheDocument()
      expect(screen.getByText('alias-b')).toBeInTheDocument()
    })

    // Enter edit mode
    const editBtn = screen.getByRole('button', { name: /edit/i })
    await user.click(editBtn)

    // Remove alias-a
    const removeBtn = screen.getByRole('button', { name: /remove alias alias-a/i })
    await user.click(removeBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_page_aliases', {
        pageId: 'PAGE_1',
        aliases: ['alias-b'],
      })
    })
  })

  it('alias badges use the same styling pattern as tag badges', async () => {
    setupTagMock(['TAG_1'], ['alias-1'])

    render(<PageHeader pageId="PAGE_1" title="Test" />)

    // Wait for both alias and tag badges to render
    await waitFor(() => {
      expect(screen.getByText('alias-1')).toBeInTheDocument()
      expect(screen.getByText('urgent')).toBeInTheDocument()
    })

    // Alias badges should use Badge component (has data-slot="badge")
    const aliasBadge = screen.getByText('alias-1').closest('[data-slot="badge"]')
    expect(aliasBadge).toBeInTheDocument()

    // Tag badges should also use Badge component
    const tagBadge = screen.getByText('urgent').closest('[data-slot="badge"]')
    expect(tagBadge).toBeInTheDocument()

    // Both should have the same variant
    expect(aliasBadge).toHaveAttribute('data-variant', 'secondary')
    expect(tagBadge).toHaveAttribute('data-variant', 'secondary')
  })
})

// ── Page-level undo / redo buttons ────────────────────────────────────────

describe('PageHeader page-level undo/redo buttons', () => {
  it('renders page undo button', () => {
    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    const undoBtn = screen.getByRole('button', { name: /undo last page action/i })
    expect(undoBtn).toBeInTheDocument()
  })

  it('renders page redo button', () => {
    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    const redoBtn = screen.getByRole('button', { name: /redo last page action/i })
    expect(redoBtn).toBeInTheDocument()
  })

  it('undo button calls undoPageOp', async () => {
    const user = userEvent.setup()

    // Set up invoke mock so undo_page_op returns a valid UndoResult
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'undo_page_op')
        return {
          reversed_op: { device_id: 'dev1', seq: 1 },
          new_op_ref: { device_id: 'dev1', seq: 2 },
          new_op_type: 'reverse',
          is_redo: false,
        }
      if (cmd === 'get_block')
        return {
          id: 'PAGE_1',
          block_type: 'page',
          content: 'My Page',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
        }
      return null
    })

    render(<PageHeader pageId="PAGE_1" title="My Page" />)

    const undoBtn = screen.getByRole('button', { name: /undo last page action/i })
    await user.click(undoBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('undo_page_op', {
        pageId: 'PAGE_1',
        undoDepth: 0,
      })
    })
  })
})

// ── Breadcrumb navigation for namespaced pages ────────────────────────────

describe('PageHeader breadcrumb', () => {
  it('shows breadcrumb for namespaced page title', () => {
    render(<PageHeader pageId="PAGE_1" title="work/project-alpha/tasks" />)

    const nav = screen.getByRole('navigation', { name: /page breadcrumb/i })
    expect(nav).toBeInTheDocument()

    // Ancestor segments should appear as buttons
    expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'project-alpha' })).toBeInTheDocument()

    // Final segment should appear as plain text (not a button)
    expect(nav).toHaveTextContent('tasks')
    const buttons = nav.querySelectorAll('button')
    const buttonTexts = Array.from(buttons).map((b) => b.textContent)
    expect(buttonTexts).not.toContain('tasks')
  })

  it('does not show breadcrumb for flat page title', () => {
    render(<PageHeader pageId="PAGE_1" title="Simple Page" />)

    expect(screen.queryByRole('navigation', { name: /page breadcrumb/i })).not.toBeInTheDocument()
  })

  it('breadcrumb ancestor navigates to pages view', async () => {
    const user = userEvent.setup()
    render(<PageHeader pageId="PAGE_1" title="work/project-alpha" />)

    const workBtn = screen.getByRole('button', { name: 'work' })
    await user.click(workBtn)

    expect(useNavigationStore.getState().currentView).toBe('pages')
  })

  it('a11y: no violations with breadcrumb', async () => {
    const { container } = render(
      <PageHeader pageId="PAGE_1" title="work/project-alpha/tasks" onBack={() => {}} />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

// ── Kebab menu (#639) ─────────────────────────────────────────────────────

describe('PageHeader kebab menu (#639)', () => {
  it('renders page actions menu button', async () => {
    render(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /page actions/i })).toBeInTheDocument()
    })
  })

  it('shows "Save as template" when page is not a template', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      return null
    })
    render(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Save as template/i)).toBeInTheDocument()
  })

  it('shows "Remove template status" when page is a template', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties')
        return [
          {
            key: 'template',
            value_text: 'true',
            value_num: null,
            value_date: null,
            value_ref: null,
          },
        ]
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      return null
    })
    render(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Remove template status/i)).toBeInTheDocument()
  })

  it('shows "Set as journal template" when page is not a journal template', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      return null
    })
    render(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Set as journal template/i)).toBeInTheDocument()
  })

  it('shows "Remove journal template" when page is a journal template', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties')
        return [
          {
            key: 'journal-template',
            value_text: 'true',
            value_num: null,
            value_date: null,
            value_ref: null,
          },
        ]
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      return null
    })
    render(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Remove journal template/i)).toBeInTheDocument()
  })

  it('toggles template property on click', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'set_property') return null
      return null
    })
    render(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Save as template/i))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'template',
        valueText: 'true',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('shows Export as Markdown option', async () => {
    const user = userEvent.setup()
    render(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Export as Markdown/i)).toBeInTheDocument()
  })

  it('shows Delete page option', async () => {
    const user = userEvent.setup()
    render(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Delete page/i)).toBeInTheDocument()
  })
})
