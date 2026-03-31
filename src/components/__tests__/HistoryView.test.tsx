/**
 * Tests for HistoryView component.
 *
 * Validates:
 *  - Renders empty state when no history entries
 *  - Renders history entries with correct badges, timestamps, previews
 *  - Checkbox toggles selection on click
 *  - Shift+click selects range
 *  - Arrow key navigation moves focus
 *  - Space toggles checkbox on focused item
 *  - Enter with selection shows confirmation dialog
 *  - Confirmation dialog "Revert" calls revertOps with correct ops in reverse chronological order
 *  - Non-reversible ops (purge_block) have disabled checkbox
 *  - "Load more" button appears when hasMore=true
 *  - Op type filter updates query
 *  - a11y compliance
 *  - Selection toolbar shows correct count
 *  - "Clear selection" button clears all
 *  - Escape key clears selection
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { HistoryView } from '../HistoryView'

const mockedInvoke = vi.mocked(invoke)

function makeHistoryEntry(
  seq: number,
  opType: string,
  payload: Record<string, unknown>,
  createdAt = '2025-01-15T12:00:00Z',
  deviceId = 'DEVICE01',
) {
  return {
    device_id: deviceId,
    seq,
    op_type: opType,
    payload: JSON.stringify(payload),
    created_at: createdAt,
  }
}

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HistoryView', () => {
  it('renders empty state when no history entries', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<HistoryView />)

    expect(await screen.findByText('No history entries found')).toBeInTheDocument()
  })

  it('renders history entries with correct badges, timestamps, previews', async () => {
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'Updated content' }, '2025-01-15T12:00:00Z'),
        makeHistoryEntry(2, 'create_block', { content: 'New block' }, '2025-01-14T10:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    // Op type badges
    expect(await screen.findByText('edit_block')).toBeInTheDocument()
    expect(screen.getByText('create_block')).toBeInTheDocument()

    // Payload previews
    expect(screen.getByText('Updated content')).toBeInTheDocument()
    expect(screen.getByText('New block')).toBeInTheDocument()
  })

  it('checkbox toggles selection on click', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    const checkbox = await screen.findByRole('checkbox', {
      name: /Select operation edit_block #1/,
    })
    expect(checkbox).not.toBeChecked()

    await user.click(checkbox)
    expect(checkbox).toBeChecked()

    // Selection toolbar should appear
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    await user.click(checkbox)
    expect(checkbox).not.toBeChecked()
  })

  it('shift+click selects range', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }, '2025-01-15T12:00:00Z'),
        makeHistoryEntry(2, 'edit_block', { to_text: 'item 2' }, '2025-01-15T11:00:00Z'),
        makeHistoryEntry(3, 'edit_block', { to_text: 'item 3' }, '2025-01-15T10:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    // Wait for items to render
    await screen.findByText('item 1')

    // Click the first item row
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0])

    // Shift+click the third item row
    await user.keyboard('{Shift>}')
    await user.click(items[2])
    await user.keyboard('{/Shift}')

    // All three should be selected
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes[0]).toBeChecked()
    expect(checkboxes[1]).toBeChecked()
    expect(checkboxes[2]).toBeChecked()

    expect(screen.getByText('3 selected')).toBeInTheDocument()
  })

  it('arrow key navigation moves focus', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }),
        makeHistoryEntry(2, 'edit_block', { to_text: 'item 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Press ArrowDown to focus first item (from -1 to 0)
    await user.keyboard('{ArrowDown}')
    const items = screen.getAllByTestId(/^history-item-/)
    expect(items[0]).toHaveClass('ring-2')

    // Press ArrowDown again to move to second item
    await user.keyboard('{ArrowDown}')
    expect(items[0]).not.toHaveClass('ring-2')
    expect(items[1]).toHaveClass('ring-2')

    // Press ArrowUp to go back
    await user.keyboard('{ArrowUp}')
    expect(items[0]).toHaveClass('ring-2')
    expect(items[1]).not.toHaveClass('ring-2')
  })

  it('space toggles checkbox on focused item', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Navigate to first item
    await user.keyboard('{ArrowDown}')

    // Press space to toggle
    await user.keyboard(' ')

    const checkbox = screen.getByRole('checkbox', { name: /Select operation edit_block #1/ })
    expect(checkbox).toBeChecked()

    // Press space again to untoggle
    await user.keyboard(' ')
    expect(checkbox).not.toBeChecked()
  })

  it('enter with selection shows confirmation dialog', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select via clicking the row
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0])

    // Press Enter
    await user.keyboard('{Enter}')

    expect(screen.getByText('Revert 1 operations?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will create 1 new operations that reverse the selected changes. The original operations remain in history.',
      ),
    ).toBeInTheDocument()
  })

  it('confirmation dialog "Revert" calls revertOps with correct ops in reverse chronological order', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'oldest' }, '2025-01-13T10:00:00Z'),
        makeHistoryEntry(2, 'edit_block', { to_text: 'middle' }, '2025-01-14T10:00:00Z'),
        makeHistoryEntry(3, 'edit_block', { to_text: 'newest' }, '2025-01-15T10:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // initial load
      .mockResolvedValueOnce([]) // revertOps
      .mockResolvedValueOnce(emptyPage) // reload after revert

    render(<HistoryView />)

    await screen.findByText('oldest')

    // Select all via Ctrl+A
    await user.keyboard('{Control>}a{/Control}')

    expect(screen.getByText('3 selected')).toBeInTheDocument()

    // Click "Revert selected" button
    await user.click(screen.getByRole('button', { name: /Revert selected/ }))

    // Confirmation dialog appears
    expect(screen.getByText('Revert 3 operations?')).toBeInTheDocument()

    // Click Revert in dialog
    await user.click(screen.getByRole('button', { name: /^Revert$/ }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('revert_ops', {
        ops: [
          { device_id: 'DEVICE01', seq: 3 }, // newest first
          { device_id: 'DEVICE01', seq: 2 },
          { device_id: 'DEVICE01', seq: 1 }, // oldest last
        ],
      })
    })
  })

  it('non-reversible ops (purge_block) have disabled checkbox', async () => {
    const page = {
      items: [
        makeHistoryEntry(1, 'purge_block', { block_id: 'B1' }),
        makeHistoryEntry(2, 'delete_attachment', { attachment_id: 'A1' }),
        makeHistoryEntry(3, 'edit_block', { to_text: 'editable' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('purge_block')

    const checkboxes = screen.getAllByRole('checkbox')
    // purge_block checkbox should be disabled
    expect(checkboxes[0]).toBeDisabled()
    // delete_attachment checkbox should be disabled
    expect(checkboxes[1]).toBeDisabled()
    // edit_block checkbox should be enabled
    expect(checkboxes[2]).not.toBeDisabled()
  })

  it('"Load more" button appears when hasMore=true', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()
  })

  it('loads next page with cursor when Load More is clicked', async () => {
    const user = userEvent.setup()
    const page1 = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'entry 1' })],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    const page2 = {
      items: [makeHistoryEntry(2, 'edit_block', { to_text: 'entry 2' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

    render(<HistoryView />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
        pageId: '__all__',
        opTypeFilter: null,
        cursor: 'cursor_page2',
        limit: 50,
      })
    })

    expect(await screen.findByText('entry 1')).toBeInTheDocument()
    expect(screen.getByText('entry 2')).toBeInTheDocument()
  })

  it('op type filter updates query', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValue(emptyPage)

    render(<HistoryView />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
        pageId: '__all__',
        opTypeFilter: null,
        cursor: null,
        limit: 50,
      })
    })

    // Change filter to 'edit'
    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    await user.selectOptions(select, 'edit')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
        pageId: '__all__',
        opTypeFilter: 'edit',
        cursor: null,
        limit: 50,
      })
    })
  })

  it('has no a11y violations with entries', async () => {
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'accessible item' }),
        makeHistoryEntry(2, 'purge_block', { block_id: 'B1' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    const { container } = render(<HistoryView />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('selection toolbar shows correct count', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }, '2025-01-15T12:00:00Z'),
        makeHistoryEntry(2, 'edit_block', { to_text: 'item 2' }, '2025-01-15T11:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select first item
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0])
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    // Select second item
    await user.click(items[1])
    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })

  it('"Clear selection" button clears all', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select item
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0])

    expect(screen.getByText('1 selected')).toBeInTheDocument()

    // Click Clear selection
    await user.click(screen.getByRole('button', { name: /Clear selection/ }))

    // Toolbar should disappear
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
    expect(screen.queryByText('Clear selection')).not.toBeInTheDocument()
  })

  it('escape key clears selection', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Select item
    const items = screen.getAllByTestId(/^history-item-/)
    await user.click(items[0])
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    // Press Escape
    await user.keyboard('{Escape}')

    // Selection should be cleared
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })

  it('calls list_page_history with correct params on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<HistoryView />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_page_history', {
        pageId: '__all__',
        opTypeFilter: null,
        cursor: null,
        limit: 50,
      })
    })
  })

  it('shows loading skeletons during initial load', () => {
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<HistoryView />)

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
  })

  it('non-reversible ops have opacity-50 class', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'purge_block', { block_id: 'B1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('purge_block')

    const item = screen.getByTestId('history-item-0')
    expect(item).toHaveClass('opacity-50')
  })

  it('handles error from listPageHistory without crashing', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('network failure'))

    render(<HistoryView />)

    // Should render empty state (error silently caught), not crash
    await waitFor(() => {
      expect(screen.getByText('No history entries found')).toBeInTheDocument()
    })
  })

  it('Ctrl+A selects all reversible items but not non-reversible', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' }),
        makeHistoryEntry(2, 'purge_block', { block_id: 'B1' }),
        makeHistoryEntry(3, 'create_block', { content: 'item 3' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('item 1')

    // Ctrl+A to select all
    await user.keyboard('{Control>}a{/Control}')

    expect(screen.getByText('2 selected')).toBeInTheDocument()

    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes[0]).toBeChecked() // edit_block
    expect(checkboxes[1]).not.toBeChecked() // purge_block (disabled)
    expect(checkboxes[2]).toBeChecked() // create_block
  })

  it('clicking a non-reversible row does not select it', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'purge_block', { block_id: 'B1' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryView />)

    await screen.findByText('purge_block')

    const item = screen.getByTestId('history-item-0')
    await user.click(item)

    // Should not show selection toolbar
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })

  it('has no a11y violations with empty state', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const { container } = render(<HistoryView />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
