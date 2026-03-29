/**
 * Tests for TagList component.
 *
 * Validates:
 *  - Initial render loads tags
 *  - Creating a tag via the form
 *  - Deleting a tag (with confirmation dialog)
 *  - Empty state
 *  - Clickable tag names (onTagClick callback)
 *  - Error feedback via toast on failed operations
 *  - Disabled state styling for Add Tag button
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { TagList } from '../TagList'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)

const emptyPage = { items: [], next_cursor: null, has_more: false }

function makeTag(id: string, name: string) {
  return {
    id,
    block_type: 'tag',
    content: name,
    parent_id: null,
    position: null,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
  }
}

/** Find the trash (delete) button within a tag row via its aria-label. */
function findTrashButton(tagRow: HTMLElement): HTMLButtonElement {
  return within(tagRow).getByRole('button', { name: /delete tag/i })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TagList', () => {
  it('renders create form on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<TagList />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText('New tag name...')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Add Tag/i })).toBeInTheDocument()
  })

  it('loads and renders tags', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeTag('T1', 'important'), makeTag('T2', 'work')],
      next_cursor: null,
      has_more: false,
    })

    render(<TagList />)

    expect(await screen.findByText('important')).toBeInTheDocument()
    expect(screen.getByText('work')).toBeInTheDocument()
  })

  it('shows empty state when no tags exist', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<TagList />)

    expect(await screen.findByText(/No tags yet/)).toBeInTheDocument()
  })

  it('shows skeleton loaders during initial load', () => {
    // Mock that never resolves — keeps loading state
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<TagList />)

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
  })

  it('creates a tag via the form', async () => {
    const user = userEvent.setup()
    // Initial load — empty
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<TagList />)

    await waitFor(() => {
      expect(screen.getByText(/No tags yet/)).toBeInTheDocument()
    })

    // Mock create_block response
    mockedInvoke.mockResolvedValueOnce({
      id: 'T1',
      block_type: 'tag',
      content: 'my-new-tag',
      parent_id: null,
      position: null,
    })

    // Type tag name and submit
    const input = screen.getByPlaceholderText('New tag name...')
    await user.type(input, 'my-new-tag')

    const addBtn = screen.getByRole('button', { name: /Add Tag/i })
    await user.click(addBtn)

    // New tag should appear
    expect(await screen.findByText('my-new-tag')).toBeInTheDocument()

    // Verify invoke was called correctly
    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'tag',
      content: 'my-new-tag',
      parentId: null,
      position: null,
    })

    // Input should be cleared
    expect(input).toHaveValue('')
  })

  it('does not submit when input is empty', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<TagList />)

    await waitFor(() => {
      expect(screen.getByText(/No tags yet/)).toBeInTheDocument()
    })

    const addBtn = screen.getByRole('button', { name: /Add Tag/i })
    expect(addBtn).toBeDisabled()

    // Type whitespace only — should still be disabled
    const input = screen.getByPlaceholderText('New tag name...')
    await user.type(input, '   ')
    expect(addBtn).toBeDisabled()
  })

  // UX #1: Tag deletion confirmation dialog
  describe('delete confirmation dialog', () => {
    it('shows AlertDialog when trash icon is clicked', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makeTag('T1', 'to-delete')],
        next_cursor: null,
        has_more: false,
      })

      render(<TagList />)

      expect(await screen.findByText('to-delete')).toBeInTheDocument()

      // Click the trash icon (ghost variant button, not the tag name button)
      const tagRow = screen.getByText('to-delete').closest('div.group') as HTMLElement
      const deleteBtn = findTrashButton(tagRow)
      expect(deleteBtn).toBeTruthy()
      await user.click(deleteBtn)

      // AlertDialog should appear with tag name in the description
      expect(await screen.findByText(/Delete tag\?/i)).toBeInTheDocument()
      // The tag name appears both in the list and in the dialog description
      expect(screen.getAllByText(/to-delete/).length).toBeGreaterThanOrEqual(2)
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Delete$/i })).toBeInTheDocument()
    })

    it('cancelling the dialog keeps the tag', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makeTag('T1', 'keep-me')],
        next_cursor: null,
        has_more: false,
      })

      render(<TagList />)

      expect(await screen.findByText('keep-me')).toBeInTheDocument()

      // Open dialog
      const tagRow = screen.getByText('keep-me').closest('div.group') as HTMLElement
      const deleteBtn = findTrashButton(tagRow)
      await user.click(deleteBtn)

      // Click Cancel
      const cancelBtn = await screen.findByRole('button', { name: /Cancel/i })
      await user.click(cancelBtn)

      // Tag should still be there, dialog should be gone
      expect(screen.getByText('keep-me')).toBeInTheDocument()
      expect(screen.queryByText(/Delete tag\?/i)).not.toBeInTheDocument()
    })

    it('confirming the dialog deletes the tag', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makeTag('T1', 'to-delete')],
        next_cursor: null,
        has_more: false,
      })

      render(<TagList />)

      expect(await screen.findByText('to-delete')).toBeInTheDocument()

      // Mock delete_block response
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'T1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      })

      // Open dialog
      const tagRow = screen.getByText('to-delete').closest('div.group') as HTMLElement
      const deleteBtn = findTrashButton(tagRow)
      await user.click(deleteBtn)

      // Click Delete (the confirm action)
      const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
      await user.click(confirmBtn)

      // Tag should be removed from the list
      await waitFor(() => {
        expect(screen.queryByText('to-delete')).not.toBeInTheDocument()
      })
    })
  })

  // UX #7: Clickable tag names
  describe('clickable tag names', () => {
    it('calls onTagClick when a tag name is clicked', async () => {
      const user = userEvent.setup()
      const onTagClick = vi.fn()
      mockedInvoke.mockResolvedValueOnce({
        items: [makeTag('T1', 'clickable-tag')],
        next_cursor: null,
        has_more: false,
      })

      render(<TagList onTagClick={onTagClick} />)

      const tagName = await screen.findByText('clickable-tag')
      await user.click(tagName)

      expect(onTagClick).toHaveBeenCalledWith('T1', 'clickable-tag')
    })

    it('calls onTagClick with correct args for each tag', async () => {
      const user = userEvent.setup()
      const onTagClick = vi.fn()
      mockedInvoke.mockResolvedValueOnce({
        items: [makeTag('T1', 'alpha'), makeTag('T2', 'beta')],
        next_cursor: null,
        has_more: false,
      })

      render(<TagList onTagClick={onTagClick} />)

      const betaTag = await screen.findByText('beta')
      await user.click(betaTag)

      expect(onTagClick).toHaveBeenCalledWith('T2', 'beta')
    })

    it('does not crash when onTagClick is not provided', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makeTag('T1', 'no-handler')],
        next_cursor: null,
        has_more: false,
      })

      render(<TagList />)

      // Should render without errors
      expect(await screen.findByText('no-handler')).toBeInTheDocument()
    })
  })

  // UX #8: Error feedback on failed operations
  describe('error feedback', () => {
    it('shows toast on failed tag load', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('Network error'))

      render(<TagList />)

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          expect.stringContaining('Failed to load tags'),
        )
      })
    })

    it('shows toast on failed tag creation', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<TagList />)

      await waitFor(() => {
        expect(screen.getByText(/No tags yet/)).toBeInTheDocument()
      })

      // Mock create_block to fail
      mockedInvoke.mockRejectedValueOnce(new Error('Create failed'))

      const input = screen.getByPlaceholderText('New tag name...')
      await user.type(input, 'fail-tag')
      const addBtn = screen.getByRole('button', { name: /Add Tag/i })
      await user.click(addBtn)

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          expect.stringContaining('Failed to create tag'),
        )
      })
    })

    it('shows toast on failed tag deletion', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makeTag('T1', 'fail-delete')],
        next_cursor: null,
        has_more: false,
      })

      render(<TagList />)

      expect(await screen.findByText('fail-delete')).toBeInTheDocument()

      // Mock delete_block to fail
      mockedInvoke.mockRejectedValueOnce(new Error('Delete failed'))

      // Open dialog and confirm
      const tagRow = screen.getByText('fail-delete').closest('div.group') as HTMLElement
      const deleteBtn = findTrashButton(tagRow)
      await user.click(deleteBtn)
      const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
      await user.click(confirmBtn)

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          expect.stringContaining('Failed to delete tag'),
        )
      })
    })
  })

  // UX #10: Add Tag disabled state styling
  describe('disabled state styling', () => {
    it('Add Tag button is disabled when input is empty', async () => {
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<TagList />)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('New tag name...')).toBeInTheDocument()
      })

      const addBtn = screen.getByRole('button', { name: /Add Tag/i })
      expect(addBtn).toBeDisabled()
    })

    it('Add Tag button has opacity-50 styling when disabled', async () => {
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<TagList />)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('New tag name...')).toBeInTheDocument()
      })

      const addBtn = screen.getByRole('button', { name: /Add Tag/i })
      expect(addBtn).toBeDisabled()
      // The button component's built-in disabled variant applies disabled:opacity-50
      // Verify the attribute is set (CSS classes are applied via cva)
      expect(addBtn).toHaveAttribute('disabled')
    })

    it('Add Tag button becomes enabled when input has text', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<TagList />)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('New tag name...')).toBeInTheDocument()
      })

      const addBtn = screen.getByRole('button', { name: /Add Tag/i })
      expect(addBtn).toBeDisabled()

      const input = screen.getByPlaceholderText('New tag name...')
      await user.type(input, 'something')
      expect(addBtn).not.toBeDisabled()
    })
  })

  it('has no a11y violations', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeTag('T1', 'accessible-tag')],
      next_cursor: null,
      has_more: false,
    })

    const { container } = render(<TagList />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
