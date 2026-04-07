/**
 * Tests for HistoryPanel component.
 *
 * Validates:
 *  - Renders "Select a block" when blockId is null
 *  - Renders empty state when no history entries
 *  - Renders history entries with op_type badge, timestamp, payload preview
 *  - Restore action calls editBlock with to_text from payload
 *  - Cursor-based pagination (Load more)
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { HistoryPanel } from '../HistoryPanel'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const mockedInvoke = vi.mocked(invoke)

function makeHistoryEntry(
  seq: number,
  opType: string,
  payload: Record<string, unknown>,
  createdAt = '2025-01-15T12:00:00Z',
) {
  return {
    device_id: 'DEVICE01',
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

describe('HistoryPanel', () => {
  it('renders null blockId state', () => {
    render(<HistoryPanel blockId={null} />)

    expect(screen.getByText('Select a block to see history')).toBeInTheDocument()
  })

  it('renders empty state when no history entries', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<HistoryPanel blockId="BLOCK001" />)

    expect(await screen.findByText('No history for this block')).toBeInTheDocument()
  })

  it('shows loading skeleton while fetching history', async () => {
    // Never-resolving promise to keep loading state
    mockedInvoke.mockImplementation(() => new Promise(() => {}))

    const { container } = render(<HistoryPanel blockId="BLOCK001" />)

    // ListViewState shows skeleton when loading with empty items
    await waitFor(() => {
      expect(container.querySelector('.history-panel-loading')).toBeInTheDocument()
    })
  })

  it('calls get_block_history with correct params on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<HistoryPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_block_history', {
        blockId: 'BLOCK001',
        cursor: null,
        limit: 50,
      })
    })
  })

  it('renders history entries with op_type badge and timestamp', async () => {
    const page = {
      items: [
        makeHistoryEntry(1, 'edit_block', { to_text: 'Updated content' }, '2025-01-15T12:00:00Z'),
        makeHistoryEntry(2, 'create_block', { block_type: 'content' }, '2025-01-14T10:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryPanel blockId="BLOCK001" />)

    // Op type badges
    expect(await screen.findByText('edit_block')).toBeInTheDocument()
    expect(screen.getByText('create_block')).toBeInTheDocument()

    // Payload preview for edit_block
    expect(screen.getByText('Updated content')).toBeInTheDocument()
  })

  it('truncates long payload previews to 100 chars', async () => {
    const longText = 'A'.repeat(150)
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: longText })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryPanel blockId="BLOCK001" />)

    const expected = `${'A'.repeat(100)}...`
    expect(await screen.findByText(expected)).toBeInTheDocument()
  })

  it('shows Restore button for edit_block entries and calls editBlock', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // get_block_history
      .mockResolvedValueOnce({ id: 'BLOCK001', block_type: 'content', content: 'Old content' }) // edit_block

    render(<HistoryPanel blockId="BLOCK001" />)

    const restoreBtn = await screen.findByRole('button', { name: /Restore/i })
    await user.click(restoreBtn)

    // Confirmation dialog opens — click confirm
    const confirmBtn = await screen.findByRole('button', { name: /^Restore$/ })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'BLOCK001',
        toText: 'Old content',
      })
    })
  })

  it('does not show Restore button for non-edit_block entries', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'create_block', { block_type: 'content' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryPanel blockId="BLOCK001" />)

    await screen.findByText('create_block')
    expect(screen.queryByRole('button', { name: /Restore/i })).not.toBeInTheDocument()
  })

  it('shows Load More button when has_more is true', async () => {
    const page1 = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'item 1' })],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(page1)

    render(<HistoryPanel blockId="BLOCK001" />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()
    // Verify shared LoadMoreButton is used (aria-busy attribute)
    expect(loadMoreBtn).toHaveAttribute('aria-busy', 'false')
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

    render(<HistoryPanel blockId="BLOCK001" />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_block_history', {
        blockId: 'BLOCK001',
        cursor: 'cursor_page2',
        limit: 50,
      })
    })

    expect(await screen.findByText('entry 1')).toBeInTheDocument()
    expect(screen.getByText('entry 2')).toBeInTheDocument()
  })

  it('reloads when blockId changes', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    const { rerender } = render(<HistoryPanel blockId="BLOCK_A" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_block_history', {
        blockId: 'BLOCK_A',
        cursor: null,
        limit: 50,
      })
    })

    rerender(<HistoryPanel blockId="BLOCK_B" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_block_history', {
        blockId: 'BLOCK_B',
        cursor: null,
        limit: 50,
      })
    })
  })

  it('has no a11y violations with entries', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'accessible' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    const { container } = render(<HistoryPanel blockId="BLOCK001" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with null blockId', async () => {
    const { container } = render(<HistoryPanel blockId={null} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('handles error from getBlockHistory without crashing', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('network failure'))

    render(<HistoryPanel blockId="BLOCK001" />)

    // Should render empty state (error caught), not crash
    await waitFor(() => {
      expect(screen.getByText('No history for this block')).toBeInTheDocument()
    })

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load history')
    })
  })

  it('handles malformed JSON payload gracefully', async () => {
    const page = {
      items: [
        {
          device_id: 'DEVICE01',
          seq: 1,
          op_type: 'edit_block',
          payload: '{invalid json!!!',
          created_at: '2025-01-15T12:00:00Z',
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryPanel blockId="BLOCK001" />)

    // Should still render the entry (op_type badge) without crashing
    expect(await screen.findByText('edit_block')).toBeInTheDocument()
    // No Restore button since payload preview returns null for invalid JSON
    expect(screen.queryByRole('button', { name: /Restore/i })).not.toBeInTheDocument()
  })

  it('handles payload without to_text field', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { some_other_field: 'value' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryPanel blockId="BLOCK001" />)

    // Should render entry but no Restore button (no to_text to restore)
    expect(await screen.findByText('edit_block')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Restore/i })).not.toBeInTheDocument()
  })

  it('restore with malformed payload does not crash', async () => {
    const user = userEvent.setup()
    // Craft an entry where payload has to_text (so Restore shows) but we'll mock editBlock to reject
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'some content' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // get_block_history
      .mockRejectedValueOnce(new Error('edit failed')) // edit_block

    render(<HistoryPanel blockId="BLOCK001" />)

    const restoreBtn = await screen.findByRole('button', { name: /Restore/i })
    await user.click(restoreBtn)

    // Confirmation dialog opens — click confirm
    const confirmBtn = await screen.findByRole('button', { name: /^Restore$/ })
    await user.click(confirmBtn)

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to revert')
    })
  })

  it('shows success toast after successful restore', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // get_block_history
      .mockResolvedValueOnce({ id: 'BLOCK001', block_type: 'content', content: 'Old content' }) // edit_block

    render(<HistoryPanel blockId="BLOCK001" />)

    const restoreBtn = await screen.findByRole('button', { name: /Restore/i })
    await user.click(restoreBtn)

    // Confirmation dialog opens — click confirm
    const confirmBtn = await screen.findByRole('button', { name: /^Restore$/ })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Reverted successfully')
    })
  })

  // UX #175: Restore button disabled during operation
  it('disables Restore button during restore operation', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // get_block_history
      .mockReturnValueOnce(new Promise(() => {})) // edit_block — never resolves

    render(<HistoryPanel blockId="BLOCK001" />)

    const restoreBtn = await screen.findByRole('button', { name: /Restore/i })
    await user.click(restoreBtn)

    // Confirmation dialog opens — click confirm
    const confirmBtn = await screen.findByRole('button', { name: /^Restore$/ })
    await user.click(confirmBtn)

    // Button should be disabled while restoring
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Restore/i })).toBeDisabled()
    })
  })

  // -- Confirmation dialog tests ------------------------------------------------

  it('confirmation dialog opens when Restore is clicked', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryPanel blockId="BLOCK001" />)

    const restoreBtn = await screen.findByRole('button', { name: /Restore/i })
    await user.click(restoreBtn)

    // Dialog should be visible
    expect(screen.getByText('Restore to this version?')).toBeInTheDocument()
    expect(
      screen.getByText(/This will replace the current block content with the version from/),
    ).toBeInTheDocument()
    expect(screen.getByText(/You can undo this change/)).toBeInTheDocument()
  })

  it('confirmation dialog completes the restore on confirm', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // get_block_history
      .mockResolvedValueOnce({ id: 'BLOCK001', block_type: 'content', content: 'Old content' }) // edit_block

    render(<HistoryPanel blockId="BLOCK001" />)

    const restoreBtn = await screen.findByRole('button', { name: /Restore/i })
    await user.click(restoreBtn)

    // Click confirm in dialog
    const confirmBtn = await screen.findByRole('button', { name: /^Restore$/ })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'BLOCK001',
        toText: 'Old content',
      })
    })

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Reverted successfully')
    })
  })

  it('confirmation dialog cancels without restoring', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryPanel blockId="BLOCK001" />)

    const restoreBtn = await screen.findByRole('button', { name: /Restore/i })
    await user.click(restoreBtn)

    // Dialog should be visible
    expect(screen.getByText('Restore to this version?')).toBeInTheDocument()

    // Click Cancel
    await user.click(screen.getByRole('button', { name: /Cancel/ }))

    // Dialog should be closed
    await waitFor(() => {
      expect(screen.queryByText('Restore to this version?')).not.toBeInTheDocument()
    })

    // editBlock should NOT have been called (only get_block_history)
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
  })

  // -- Device ID display --------------------------------------------------------

  it('shows device_id for each entry', async () => {
    const page = {
      items: [makeHistoryEntry(1, 'edit_block', { to_text: 'content' }, '2025-01-15T12:00:00Z')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<HistoryPanel blockId="BLOCK001" />)

    await screen.findByText('edit_block')

    // device_id 'DEVICE01' truncated to 8 chars = 'DEVICE01'
    expect(screen.getByText('dev:DEVICE01')).toBeInTheDocument()
  })
})
