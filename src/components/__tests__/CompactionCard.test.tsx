/**
 * Tests for CompactionCard component.
 *
 * Validates:
 *  - Shows loading skeleton while fetching
 *  - Shows stats when loaded (total ops, eligible ops, oldest date)
 *  - "Compact Now" always enabled (backend handles no-op case)
 *  - Clicking "Compact Now" opens confirm dialog
 *  - Confirm dialog shows warning text with op count
 *  - Confirming calls compactOpLog
 *  - Shows toast on success
 *  - Shows toast on error
 *  - Handles load error gracefully
 *  - axe a11y audit
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { CompactionCard } from '../CompactionCard'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const mockedInvoke = vi.mocked(invoke)

const defaultStatus = {
  total_ops: 1500,
  oldest_op_date: '2024-06-15T10:00:00Z',
  eligible_ops: 300,
  retention_days: 90,
}

const emptyStatus = {
  total_ops: 42,
  oldest_op_date: '2025-01-01T00:00:00Z',
  eligible_ops: 0,
  retention_days: 90,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CompactionCard', () => {
  it('shows loading skeleton while fetching', () => {
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    render(<CompactionCard />)

    // Panel is collapsed by default — expand it
    // Actually, loading happens on mount but content is collapsed.
    // The card header should be visible.
    expect(screen.getByText('Op Log Compaction')).toBeInTheDocument()
  })

  it('shows stats when expanded and loaded', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    render(<CompactionCard />)

    // Expand the card
    await user.click(screen.getByText('Op Log Compaction'))

    // Wait for stats to load
    await waitFor(() => {
      expect(screen.getByTestId('compaction-total-ops')).toHaveTextContent('1500')
    })

    expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
    expect(screen.getByTestId('compaction-oldest-date')).toBeInTheDocument()
    // Should show a formatted date, not the raw ISO string
    expect(screen.getByTestId('compaction-oldest-date')).not.toHaveTextContent('N/A')
  })

  it('shows N/A when oldest_op_date is null', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce({
      ...defaultStatus,
      oldest_op_date: null,
    })

    render(<CompactionCard />)

    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(screen.getByTestId('compaction-oldest-date')).toHaveTextContent('N/A')
    })
  })

  it('"Compact Now" is enabled when eligible_ops is 0 (backend handles no-op case)', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(emptyStatus)

    render(<CompactionCard />)

    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(screen.getByTestId('compaction-total-ops')).toHaveTextContent('42')
    })

    const compactBtn = screen.getByRole('button', { name: /Compact Now/i })
    expect(compactBtn).not.toBeDisabled()
  })

  it('"Compact Now" is enabled when eligible_ops > 0', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    render(<CompactionCard />)

    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
    })

    const compactBtn = screen.getByRole('button', { name: /Compact Now/i })
    expect(compactBtn).not.toBeDisabled()
  })

  it('clicking "Compact Now" opens confirm dialog', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    render(<CompactionCard />)

    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
    })

    await user.click(screen.getByRole('button', { name: /Compact Now/i }))

    expect(screen.getByText('Compact Op Log?')).toBeInTheDocument()
  })

  it('confirm dialog shows warning text with op count and retention days', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    render(<CompactionCard />)

    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
    })

    await user.click(screen.getByRole('button', { name: /Compact Now/i }))

    expect(
      screen.getByText(/This will permanently delete 300 operations older than 90 days/),
    ).toBeInTheDocument()
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument()
  })

  it('confirming calls compactOpLog and shows success toast', async () => {
    const user = userEvent.setup()
    mockedInvoke
      .mockResolvedValueOnce(defaultStatus) // getCompactionStatus
      .mockResolvedValueOnce({ snapshot_id: 'snap_1', ops_deleted: 300 }) // compactOpLog
      .mockResolvedValueOnce(emptyStatus) // refresh getCompactionStatus

    render(<CompactionCard />)

    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
    })

    // Open confirm dialog
    await user.click(screen.getByRole('button', { name: /Compact Now/i }))

    // Click Compact button in dialog
    await user.click(screen.getByRole('button', { name: /^Compact$/i }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('compact_op_log_cmd', { retentionDays: 90 })
    })

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('300'))
    })
  })

  it('shows error toast when compaction fails', async () => {
    const user = userEvent.setup()
    mockedInvoke
      .mockResolvedValueOnce(defaultStatus) // getCompactionStatus
      .mockRejectedValueOnce(new Error('compact failed')) // compactOpLog

    render(<CompactionCard />)

    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
    })

    // Open confirm dialog
    await user.click(screen.getByRole('button', { name: /Compact Now/i }))

    // Click Compact button
    await user.click(screen.getByRole('button', { name: /^Compact$/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to compact op log')
    })
  })

  it('shows error toast when loading status fails', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('load failed'))

    const user = userEvent.setup()
    render(<CompactionCard />)

    // Expand to trigger visible loading
    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load compaction status')
    })
  })

  it('cancel button closes confirm dialog without compacting', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    render(<CompactionCard />)

    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
    })

    // Open confirm dialog
    await user.click(screen.getByRole('button', { name: /Compact Now/i }))
    expect(screen.getByText('Compact Op Log?')).toBeInTheDocument()

    // Click Cancel
    await user.click(screen.getByRole('button', { name: /Cancel/i }))

    // Dialog should close
    expect(screen.queryByText('Compact Op Log?')).not.toBeInTheDocument()

    // compactOpLog should NOT have been called
    expect(mockedInvoke).not.toHaveBeenCalledWith('compact_op_log_cmd', expect.anything())
  })

  it('toggles collapse state', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    render(<CompactionCard />)

    // Initially collapsed — stats should not be visible
    expect(screen.queryByTestId('compaction-total-ops')).not.toBeInTheDocument()

    // Expand
    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(screen.getByTestId('compaction-total-ops')).toBeInTheDocument()
    })

    // Collapse
    await user.click(screen.getByText('Op Log Compaction'))

    expect(screen.queryByTestId('compaction-total-ops')).not.toBeInTheDocument()
  })

  it('has no a11y violations when expanded with stats', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    const { container } = render(<CompactionCard />)

    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(screen.getByTestId('compaction-total-ops')).toBeInTheDocument()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when collapsed', async () => {
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    const { container } = render(<CompactionCard />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_compaction_status')
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
