/**
 * Tests for TagPanel component.
 *
 * Validates:
 *  - Empty state when blockId is null
 *  - Loads all tags and applied tags on mount
 *  - Renders applied tags as badges
 *  - Remove button calls remove_tag and removes badge
 *  - "Add tag" button opens picker
 *  - Picker shows only non-applied tags
 *  - Picker filters by search query
 *  - Clicking a picker item calls add_tag
 *  - Adding a tag closes picker and shows new badge
 *  - Create tag flow (no match → create link → form → create_block + add_tag)
 *  - Error handling (list_blocks failure)
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('lucide-react', () => ({
  Plus: (props: { className?: string }) => (
    <svg data-testid="plus-icon" className={props.className} />
  ),
  X: (props: { className?: string }) => <svg data-testid="x-icon" className={props.className} />,
}))

vi.mock('../EmptyState', () => ({
  EmptyState: ({ message }: { message: string }) => <div data-testid="empty-state">{message}</div>,
}))

import { TagPanel } from '../TagPanel'

const mockedInvoke = vi.mocked(invoke)

const mockTags = [
  {
    id: 'TAG1',
    block_type: 'tag',
    content: 'work',
    parent_id: null,
    position: 0,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
  },
  {
    id: 'TAG2',
    block_type: 'tag',
    content: 'personal',
    parent_id: null,
    position: 1,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
  },
  {
    id: 'TAG3',
    block_type: 'tag',
    content: 'idea',
    parent_id: null,
    position: 2,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
  },
]

function setupDefaultMock() {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'list_blocks') return { items: mockTags, next_cursor: null, has_more: false }
    if (cmd === 'list_tags_for_block') return ['TAG1'] // block has "work" tag applied
    if (cmd === 'add_tag') return { block_id: 'BLOCK1', tag_id: 'TAG2' }
    if (cmd === 'remove_tag') return { block_id: 'BLOCK1', tag_id: 'TAG1' }
    if (cmd === 'create_block')
      return {
        id: 'NEW_TAG',
        block_type: 'tag',
        content: 'new-tag',
        parent_id: null,
        position: 3,
        deleted_at: null,
      }
    return null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TagPanel', () => {
  // -----------------------------------------------------------------------
  // Empty state
  // -----------------------------------------------------------------------
  it('renders empty state when blockId is null', () => {
    render(<TagPanel blockId={null} />)

    expect(screen.getByTestId('empty-state')).toHaveTextContent('Select a block to manage tags')
  })

  // -----------------------------------------------------------------------
  // Mount behaviour
  // -----------------------------------------------------------------------
  it('loads all tags and applied tags on mount', async () => {
    setupDefaultMock()

    render(<TagPanel blockId="BLOCK1" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ blockType: 'tag' }),
      )
      expect(mockedInvoke).toHaveBeenCalledWith('list_tags_for_block', { blockId: 'BLOCK1' })
    })
  })

  // -----------------------------------------------------------------------
  // Applied tags display
  // -----------------------------------------------------------------------
  it('renders applied tags as badges', async () => {
    setupDefaultMock()

    render(<TagPanel blockId="BLOCK1" />)

    // "work" (TAG1) is applied
    expect(await screen.findByText('work')).toBeInTheDocument()
    // "personal" is not applied — should NOT appear as a badge
    expect(screen.queryByText('personal')).not.toBeInTheDocument()
  })

  it('remove button calls remove_tag', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    // Wait for "work" badge to appear
    const removeBtn = await screen.findByLabelText('Remove tag work')
    await user.click(removeBtn)

    expect(mockedInvoke).toHaveBeenCalledWith('remove_tag', { blockId: 'BLOCK1', tagId: 'TAG1' })
  })

  it('remove updates the applied tags set (badge disappears)', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    const removeBtn = await screen.findByLabelText('Remove tag work')
    await user.click(removeBtn)

    await waitFor(() => {
      expect(screen.queryByText('work')).not.toBeInTheDocument()
    })
  })

  // -----------------------------------------------------------------------
  // Tag picker
  // -----------------------------------------------------------------------
  it('"Add tag" button opens picker', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    // Wait for data to load
    await screen.findByText('work')

    const addBtn = screen.getByRole('button', { name: /Add tag/i })
    await user.click(addBtn)

    expect(screen.getByPlaceholderText('Search tags...')).toBeInTheDocument()
  })

  it('picker shows only non-applied tags', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    await screen.findByText('work')

    const addBtn = screen.getByRole('button', { name: /Add tag/i })
    await user.click(addBtn)

    // "personal" and "idea" should be in the picker (not applied)
    expect(screen.getByRole('option', { name: 'personal' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'idea' })).toBeInTheDocument()

    // "work" is applied — should NOT appear in picker
    expect(screen.queryByRole('option', { name: 'work' })).not.toBeInTheDocument()
  })

  it('picker filters by search query', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    await screen.findByText('work')

    await user.click(screen.getByRole('button', { name: /Add tag/i }))

    const searchInput = screen.getByPlaceholderText('Search tags...')
    await user.type(searchInput, 'per')

    // Only "personal" should match
    expect(screen.getByRole('option', { name: 'personal' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'idea' })).not.toBeInTheDocument()
  })

  it('clicking a picker item calls add_tag', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    await screen.findByText('work')

    await user.click(screen.getByRole('button', { name: /Add tag/i }))

    const personalOption = screen.getByRole('option', { name: 'personal' })
    await user.click(personalOption)

    expect(mockedInvoke).toHaveBeenCalledWith('add_tag', { blockId: 'BLOCK1', tagId: 'TAG2' })
  })

  it('adding a tag closes picker and shows new badge', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    await screen.findByText('work')

    await user.click(screen.getByRole('button', { name: /Add tag/i }))

    const personalOption = screen.getByRole('option', { name: 'personal' })
    await user.click(personalOption)

    // Picker should close (search input gone)
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Search tags...')).not.toBeInTheDocument()
    })

    // New badge should appear
    expect(screen.getByText('personal')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // Create tag flow
  // -----------------------------------------------------------------------
  it('shows "Create" link when no tags match query', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    await screen.findByText('work')

    await user.click(screen.getByRole('button', { name: /Add tag/i }))

    const searchInput = screen.getByPlaceholderText('Search tags...')
    await user.type(searchInput, 'newstuff')

    // No options should be visible
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    // "Create" link should appear
    expect(screen.getByText(/Create "newstuff"/)).toBeInTheDocument()
  })

  it('clicking "Create" link populates create form', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    await screen.findByText('work')

    await user.click(screen.getByRole('button', { name: /Add tag/i }))

    const searchInput = screen.getByPlaceholderText('Search tags...')
    await user.type(searchInput, 'newstuff')

    await user.click(screen.getByText(/Create "newstuff"/))

    // Picker should close, form should appear
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Search tags...')).not.toBeInTheDocument()
    })

    // Form input should have the tag name pre-filled
    const createInput = screen.getByDisplayValue('newstuff')
    expect(createInput).toBeInTheDocument()

    // "Create tag" and "Cancel" buttons should be present
    expect(screen.getByRole('button', { name: 'Create tag' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('"Create tag" button calls create_block then add_tag', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    await screen.findByText('work')

    await user.click(screen.getByRole('button', { name: /Add tag/i }))

    const searchInput = screen.getByPlaceholderText('Search tags...')
    await user.type(searchInput, 'newstuff')

    await user.click(screen.getByText(/Create "newstuff"/))

    await user.click(screen.getByRole('button', { name: 'Create tag' }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({
          blockType: 'tag',
          content: 'newstuff',
        }),
      )
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('add_tag', { blockId: 'BLOCK1', tagId: 'NEW_TAG' })
    })
  })

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  it('handles list_blocks error gracefully', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') throw new Error('backend error')
      if (cmd === 'list_tags_for_block') return ['TAG1']
      return null
    })

    // Should not throw
    render(<TagPanel blockId="BLOCK1" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', expect.anything())
    })

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load tags')
    })

    // Component should still render without crashing
    expect(screen.getByText(/Applied tags/i)).toBeInTheDocument()
  })

  it('shows toast on failed tag removal', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockTags, next_cursor: null, has_more: false }
      if (cmd === 'list_tags_for_block') return ['TAG1']
      if (cmd === 'remove_tag') throw new Error('fail')
      return null
    })
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    const removeBtn = await screen.findByLabelText('Remove tag work')
    await user.click(removeBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete tag')
    })
  })

  it('shows toast on failed tag creation', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: mockTags, next_cursor: null, has_more: false }
      if (cmd === 'list_tags_for_block') return ['TAG1']
      if (cmd === 'create_block') throw new Error('fail')
      return null
    })
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    await screen.findByText('work')

    await user.click(screen.getByRole('button', { name: /Add tag/i }))
    const searchInput = screen.getByPlaceholderText('Search tags...')
    await user.type(searchInput, 'newstuff')
    await user.click(screen.getByText(/Create "newstuff"/))
    await user.click(screen.getByRole('button', { name: 'Create tag' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create tag')
    })
  })

  // -----------------------------------------------------------------------
  // Keyboard hints & handlers
  // -----------------------------------------------------------------------
  it('shows keyboard hint text when create form is visible', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    await screen.findByText('work')

    await user.click(screen.getByRole('button', { name: /Add tag/i }))

    const searchInput = screen.getByPlaceholderText('Search tags...')
    await user.type(searchInput, 'newstuff')

    await user.click(screen.getByText(/Create "newstuff"/))

    expect(screen.getByText('Press Enter to create, Escape to cancel')).toBeInTheDocument()
  })

  it('Enter key in create form submits the form', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    await screen.findByText('work')

    await user.click(screen.getByRole('button', { name: /Add tag/i }))

    const searchInput = screen.getByPlaceholderText('Search tags...')
    await user.type(searchInput, 'newstuff')

    await user.click(screen.getByText(/Create "newstuff"/))

    const createInput = screen.getByDisplayValue('newstuff')
    fireEvent.keyDown(createInput, { key: 'Enter' })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({
          blockType: 'tag',
          content: 'newstuff',
        }),
      )
    })
  })

  it('Escape key in create form cancels the form', async () => {
    setupDefaultMock()
    const user = userEvent.setup()

    render(<TagPanel blockId="BLOCK1" />)

    await screen.findByText('work')

    await user.click(screen.getByRole('button', { name: /Add tag/i }))

    const searchInput = screen.getByPlaceholderText('Search tags...')
    await user.type(searchInput, 'newstuff')

    await user.click(screen.getByText(/Create "newstuff"/))

    const createInput = screen.getByDisplayValue('newstuff')
    expect(createInput).toBeInTheDocument()

    fireEvent.keyDown(createInput, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByDisplayValue('newstuff')).not.toBeInTheDocument()
    })
  })

  // -----------------------------------------------------------------------
  // Accessibility
  // -----------------------------------------------------------------------
  it('has no a11y violations', async () => {
    setupDefaultMock()

    const { container } = render(<TagPanel blockId="BLOCK1" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
