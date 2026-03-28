/**
 * Tests for TagList component.
 *
 * Validates:
 *  - Initial render loads tags
 *  - Creating a tag via the form
 *  - Deleting a tag
 *  - Empty state
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { TagList } from '../TagList'

const mockedInvoke = vi.mocked(invoke)

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

  it('deletes a tag', async () => {
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

    // The delete button is an icon-only button within the tag row
    const tagRow = screen.getByText('to-delete').closest('div.group')
    const deleteBtn = tagRow?.querySelector('button') as HTMLButtonElement
    expect(deleteBtn).toBeTruthy()
    await user.click(deleteBtn)

    // Tag should be removed from the list
    await waitFor(() => {
      expect(screen.queryByText('to-delete')).not.toBeInTheDocument()
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
