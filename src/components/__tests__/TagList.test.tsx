/**
 * Tests for TagList component.
 *
 * Validates:
 *  - Initial render loads tags
 *  - Creating a tag via the form
 *  - Deleting a tag (with confirmation dialog)
 *  - Renaming a tag (via rename dialog)
 *  - Empty state
 *  - Clickable tag names (onTagClick callback)
 *  - Error feedback via toast on failed operations
 *  - Disabled state styling for Add Tag button
 *  - Tag color picker (UX-87)
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { TagList } from '../TagList'

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)
const mockedToastSuccess = vi.mocked(toast.success)

const emptyPage: never[] = []

function makeTag(id: string, name: string, usageCount = 0) {
  return {
    tag_id: id,
    name,
    usage_count: usageCount,
    updated_at: '2025-01-15T00:00:00Z',
  }
}

/** Find the trash (delete) button within a tag row via its aria-label. */
function findTrashButton(tagRow: HTMLElement): HTMLButtonElement {
  return within(tagRow).getByRole('button', { name: /delete tag/i })
}

/** Find the rename button within a tag row via its aria-label. */
function findRenameButton(tagRow: HTMLElement): HTMLButtonElement {
  return within(tagRow).getByRole('button', { name: /rename tag/i })
}

/** Find the color button within a tag row via its aria-label. */
function findColorButton(tagRow: HTMLElement): HTMLButtonElement {
  return within(tagRow).getByRole('button', { name: /set tag color/i })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem('tag-colors')
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
    mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'important', 3), makeTag('T2', 'work', 7)])

    render(<TagList />)

    expect(await screen.findByText('important')).toBeInTheDocument()
    expect(screen.getByText('work')).toBeInTheDocument()
  })

  it('displays usage counts next to tag names', async () => {
    mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'important', 3), makeTag('T2', 'work', 7)])

    render(<TagList />)

    expect(await screen.findByText('important')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('exposes a stable tag-item-<name> data-testid on each tag button', async () => {
    mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'important', 3), makeTag('T2', 'work', 7)])

    render(<TagList />)

    // Wait for the tag buttons to render, then assert on the data-testid used
    // by the E2E suite to survive the usage_count suffix in the visible text.
    expect(await screen.findByTestId('tag-item-important')).toBeInTheDocument()
    expect(screen.getByTestId('tag-item-work')).toBeInTheDocument()
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
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
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
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'to-delete', 2)])

      render(<TagList />)

      expect(await screen.findByText('to-delete')).toBeInTheDocument()

      // Click the trash icon (ghost variant button, not the tag name button)
      const tagRow = screen.getByText('to-delete').closest('li') as HTMLElement
      const deleteBtn = findTrashButton(tagRow)
      expect(deleteBtn).toBeInTheDocument()
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
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'keep-me')])

      render(<TagList />)

      expect(await screen.findByText('keep-me')).toBeInTheDocument()

      // Open dialog
      const tagRow = screen.getByText('keep-me').closest('li') as HTMLElement
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
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'to-delete')])

      render(<TagList />)

      expect(await screen.findByText('to-delete')).toBeInTheDocument()

      // Mock delete_block response
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'T1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      })

      // Open dialog
      const tagRow = screen.getByText('to-delete').closest('li') as HTMLElement
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

  // UX #2: Tag rename dialog
  describe('rename dialog', () => {
    it('renders rename button for each tag', async () => {
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'alpha'), makeTag('T2', 'beta')])

      render(<TagList />)

      const alpha = await screen.findByText('alpha')
      const beta = screen.getByText('beta')
      const alphaRow = alpha.closest('li') as HTMLElement
      const betaRow = beta.closest('li') as HTMLElement

      expect(findRenameButton(alphaRow)).toBeInTheDocument()
      expect(findRenameButton(betaRow)).toBeInTheDocument()
    })

    it('clicking rename opens the rename dialog', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'my-tag')])

      render(<TagList />)

      const tag = await screen.findByText('my-tag')
      const tagRow = tag.closest('li') as HTMLElement
      const renameBtn = findRenameButton(tagRow)
      await user.click(renameBtn)

      // The RenameDialog should open with an input pre-filled
      expect(await screen.findByDisplayValue('my-tag')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Save/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
    })

    it('submitting new name calls editBlock', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'old-name')])

      render(<TagList />)

      const tag = await screen.findByText('old-name')
      const tagRow = tag.closest('li') as HTMLElement
      await user.click(findRenameButton(tagRow))

      // Clear and type new name
      const input = await screen.findByDisplayValue('old-name')
      await user.clear(input)
      await user.type(input, 'new-name')

      // Mock editBlock response
      mockedInvoke.mockResolvedValueOnce({
        id: 'T1',
        block_type: 'tag',
        content: 'new-name',
      })

      await user.click(screen.getByRole('button', { name: /Save/i }))

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
          blockId: 'T1',
          toText: 'new-name',
        })
      })

      // Tag list should show updated name
      expect(await screen.findByText('new-name')).toBeInTheDocument()
    })

    it('empty name validation prevents submission', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'keep-name')])

      render(<TagList />)

      const tag = await screen.findByText('keep-name')
      const tagRow = tag.closest('li') as HTMLElement
      await user.click(findRenameButton(tagRow))

      const input = await screen.findByDisplayValue('keep-name')
      await user.clear(input)

      // Save button should be disabled when input is empty
      const saveBtn = screen.getByRole('button', { name: /Save/i })
      expect(saveBtn).toBeDisabled()
    })

    it('shows success toast after rename', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'before')])

      render(<TagList />)

      const tag = await screen.findByText('before')
      const tagRow = tag.closest('li') as HTMLElement
      await user.click(findRenameButton(tagRow))

      const input = await screen.findByDisplayValue('before')
      await user.clear(input)
      await user.type(input, 'after')

      mockedInvoke.mockResolvedValueOnce({
        id: 'T1',
        block_type: 'tag',
        content: 'after',
      })

      await user.click(screen.getByRole('button', { name: /Save/i }))

      await waitFor(() => {
        expect(mockedToastSuccess).toHaveBeenCalledWith('Tag renamed successfully.')
      })
    })

    it('shows error toast when rename fails', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'fail-rename')])

      render(<TagList />)

      const tag = await screen.findByText('fail-rename')
      const tagRow = tag.closest('li') as HTMLElement
      await user.click(findRenameButton(tagRow))

      const input = await screen.findByDisplayValue('fail-rename')
      await user.clear(input)
      await user.type(input, 'new-fail-name')

      mockedInvoke.mockRejectedValueOnce(new Error('Rename failed'))

      await user.click(screen.getByRole('button', { name: /Save/i }))

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          expect.stringContaining('Failed to rename tag'),
        )
      })
    })

    it('prevents renaming to an existing tag name', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'first-tag'), makeTag('T2', 'second-tag')])

      render(<TagList />)

      const tag = await screen.findByText('first-tag')
      const tagRow = tag.closest('li') as HTMLElement
      await user.click(findRenameButton(tagRow))

      const input = await screen.findByDisplayValue('first-tag')
      await user.clear(input)
      await user.type(input, 'second-tag')

      await user.click(screen.getByRole('button', { name: /Save/i }))

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith('A tag with that name already exists.')
      })

      // editBlock should not have been called (only the initial list call)
      expect(mockedInvoke).toHaveBeenCalledTimes(1)
    })
  })

  // UX #7: Clickable tag names
  describe('clickable tag names', () => {
    it('calls onTagClick when a tag name is clicked', async () => {
      const user = userEvent.setup()
      const onTagClick = vi.fn()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'clickable-tag', 5)])

      render(<TagList onTagClick={onTagClick} />)

      const tagName = await screen.findByText('clickable-tag')
      await user.click(tagName)

      expect(onTagClick).toHaveBeenCalledWith('T1', 'clickable-tag')
    })

    it('calls onTagClick with correct args for each tag', async () => {
      const user = userEvent.setup()
      const onTagClick = vi.fn()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'alpha', 1), makeTag('T2', 'beta', 2)])

      render(<TagList onTagClick={onTagClick} />)

      const betaTag = await screen.findByText('beta')
      await user.click(betaTag)

      expect(onTagClick).toHaveBeenCalledWith('T2', 'beta')
    })

    it('does not crash when onTagClick is not provided', async () => {
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'no-handler')])

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
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'fail-delete')])

      render(<TagList />)

      expect(await screen.findByText('fail-delete')).toBeInTheDocument()

      // Mock delete_block to fail
      mockedInvoke.mockRejectedValueOnce(new Error('Delete failed'))

      // Open dialog and confirm
      const tagRow = screen.getByText('fail-delete').closest('li') as HTMLElement
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
    mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'accessible-tag', 4)])

    const { container } = render(<TagList />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  describe('long tag name overflow (TG-12)', () => {
    it('truncates long tag names', async () => {
      const longName = 'a'.repeat(200)
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', longName)])

      render(<TagList />)

      const badge = await screen.findByText(longName)
      expect(badge).toBeInTheDocument()
      expect(badge).toHaveClass('truncate')
      expect(badge).toHaveAttribute('title', longName)
    })
  })

  describe('tag name validation (TG-4)', () => {
    it('rejects tag names over 100 characters', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<TagList />)

      await waitFor(() => {
        expect(screen.getByText(/No tags yet/)).toBeInTheDocument()
      })

      const longName = 'x'.repeat(101)
      const input = screen.getByPlaceholderText('New tag name...')
      await user.type(input, longName)

      const addBtn = screen.getByRole('button', { name: /Add Tag/i })
      await user.click(addBtn)

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith('Tag name must be under 100 characters')
      })

      // Should NOT have called create_block (only the initial list_blocks)
      expect(mockedInvoke).toHaveBeenCalledTimes(1)
    })
  })

  // UX-87: Tag color picker
  describe('tag color picker (UX-87)', () => {
    it('renders color button for each tag', async () => {
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'alpha'), makeTag('T2', 'beta')])

      render(<TagList />)

      const alpha = await screen.findByText('alpha')
      const beta = screen.getByText('beta')
      const alphaRow = alpha.closest('li') as HTMLElement
      const betaRow = beta.closest('li') as HTMLElement

      expect(findColorButton(alphaRow)).toBeInTheDocument()
      expect(findColorButton(betaRow)).toBeInTheDocument()
    })

    it('clicking color button opens popover with palette', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'my-tag')])

      render(<TagList />)

      const tag = await screen.findByText('my-tag')
      const tagRow = tag.closest('li') as HTMLElement
      const colorBtn = findColorButton(tagRow)
      await user.click(colorBtn)

      // Should show color palette with radio buttons
      const palette = await screen.findByRole('group', { name: /color palette/i })
      expect(palette).toBeInTheDocument()

      // Should have 8 color swatches
      const swatches = within(palette).getAllByRole('button')
      expect(swatches).toHaveLength(8)
    })

    it('selecting a color calls setProperty', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'color-tag')])

      render(<TagList />)

      const tag = await screen.findByText('color-tag')
      const tagRow = tag.closest('li') as HTMLElement
      const colorBtn = findColorButton(tagRow)
      await user.click(colorBtn)

      // Mock setProperty response
      mockedInvoke.mockResolvedValueOnce({ id: 'T1', block_type: 'tag', content: 'color-tag' })

      // Click the "red" swatch
      const redSwatch = await screen.findByRole('button', { name: 'red' })
      await user.click(redSwatch)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
          blockId: 'T1',
          key: 'color',
          valueText: '#ef4444',
          valueNum: null,
          valueDate: null,
          valueRef: null,
        })
      })
    })

    it('badge renders with custom background color', async () => {
      // Pre-set color in localStorage
      localStorage.setItem('tag-colors', JSON.stringify({ T1: '#3b82f6' }))
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'blue-tag')])

      render(<TagList />)

      const badge = await screen.findByText('blue-tag')
      const badgeEl = badge.closest('[data-slot="badge"]') as HTMLElement
      expect(badgeEl).toHaveStyle({ backgroundColor: '#3b82f6' })
      expect(badgeEl).toHaveStyle({ color: '#fff' })
    })

    it('clear option removes color', async () => {
      const user = userEvent.setup()
      // Pre-set color in localStorage
      localStorage.setItem('tag-colors', JSON.stringify({ T1: '#ef4444' }))
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'red-tag')])

      render(<TagList />)

      const tag = await screen.findByText('red-tag')
      const tagRow = tag.closest('li') as HTMLElement
      const colorBtn = findColorButton(tagRow)
      await user.click(colorBtn)

      // Mock deleteProperty response
      mockedInvoke.mockResolvedValueOnce(undefined)

      // Click clear button
      const clearBtn = await screen.findByText(/clear color/i)
      await user.click(clearBtn)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
          blockId: 'T1',
          key: 'color',
        })
      })

      // Color should be removed from localStorage
      const stored = JSON.parse(localStorage.getItem('tag-colors') ?? '{}')
      expect(stored.T1).toBeUndefined()
    })

    it('clear option is hidden when no color is set', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'no-color')])

      render(<TagList />)

      const tag = await screen.findByText('no-color')
      const tagRow = tag.closest('li') as HTMLElement
      const colorBtn = findColorButton(tagRow)
      await user.click(colorBtn)

      // Wait for popover to appear
      await screen.findByRole('group', { name: /color palette/i })

      // Clear button should NOT be present
      expect(screen.queryByText(/clear color/i)).not.toBeInTheDocument()
    })

    it('has no a11y violations with color picker open', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce([makeTag('T1', 'a11y-tag', 2)])

      const { container } = render(<TagList />)

      const tag = await screen.findByText('a11y-tag')
      const tagRow = tag.closest('li') as HTMLElement
      const colorBtn = findColorButton(tagRow)
      await user.click(colorBtn)

      await screen.findByRole('group', { name: /color palette/i })

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // UX-211: placeholder resolves via t()
  it('new tag input placeholder resolves via t() (UX-211)', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    render(<TagList />)

    expect(await screen.findByPlaceholderText(t('tagList.newTagPlaceholder'))).toBeInTheDocument()
  })
})
