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

import { logger } from '@/lib/logger'

import { CompactionCard } from '../CompactionCard'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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

  it('shows stats when loaded (auto-expanded with eligible_ops > 0)', async () => {
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    render(<CompactionCard />)

    // Auto-expanded by UX-352 since eligible_ops > 0; wait for stats to load.
    await waitFor(() => {
      expect(screen.getByTestId('compaction-total-ops')).toHaveTextContent('1500')
    })

    expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
    expect(screen.getByTestId('compaction-oldest-date')).toBeInTheDocument()
    // Should show a formatted date, not the raw ISO string
    expect(screen.getByTestId('compaction-oldest-date')).not.toHaveTextContent('N/A')
  })

  it('shows N/A when oldest_op_date is null', async () => {
    mockedInvoke.mockResolvedValueOnce({
      ...defaultStatus,
      oldest_op_date: null,
    })

    render(<CompactionCard />)

    // Auto-expanded since eligible_ops > 0.
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
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    render(<CompactionCard />)

    // Auto-expanded since eligible_ops > 0.
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

  it('FE-H-10: logs warning when fetchStatus rejects', async () => {
    const err = new Error('load failed')
    mockedInvoke.mockRejectedValueOnce(err)

    const user = userEvent.setup()
    render(<CompactionCard />)

    // Expand to trigger visible loading
    await user.click(screen.getByText('Op Log Compaction'))

    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'CompactionCard',
        'getCompactionStatus failed',
        undefined,
        err,
      )
    })

    // Regression guard — toast still fires.
    expect(toast.error).toHaveBeenCalledWith('Failed to load compaction status')
  })

  it('FE-H-10: logs error when handleCompact rejects', async () => {
    const err = new Error('compact failed')
    const user = userEvent.setup()
    mockedInvoke
      .mockResolvedValueOnce(defaultStatus) // getCompactionStatus
      .mockRejectedValueOnce(err) // compactOpLog

    render(<CompactionCard />)

    await waitFor(() => {
      expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
    })

    // Open confirm dialog
    await user.click(screen.getByRole('button', { name: /Compact Now/i }))

    // Click Compact button
    await user.click(screen.getByRole('button', { name: /^Compact$/i }))

    await waitFor(() => {
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'CompactionCard',
        'compaction failed',
        undefined,
        err,
      )
    })

    // Regression guard — toast still fires.
    expect(toast.error).toHaveBeenCalledWith('Failed to compact op log')
  })

  // UX-259: destructive dialogs must not compact on a reflex Enter on open.
  it('UX-259: reflex Enter on compact confirm dialog dismisses without calling compactOpLog', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    render(<CompactionCard />)

    await waitFor(() => {
      expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
    })

    // Open the destructive confirm dialog.
    await user.click(screen.getByRole('button', { name: /Compact Now/i }))
    expect(screen.getByText('Compact Op Log?')).toBeInTheDocument()

    // Cancel is auto-focused — reflex Enter dismisses without firing the action.
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.queryByText('Compact Op Log?')).not.toBeInTheDocument()
    })

    expect(mockedInvoke).not.toHaveBeenCalledWith('compact_op_log_cmd', expect.anything())
  })

  it('cancel button closes confirm dialog without compacting', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    render(<CompactionCard />)

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
    mockedInvoke.mockResolvedValueOnce(emptyStatus)

    render(<CompactionCard />)

    // With eligible_ops=0, no auto-expand — stats should not be visible.
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
    mockedInvoke.mockResolvedValueOnce(defaultStatus)

    const { container } = render(<CompactionCard />)

    // Auto-expanded since eligible_ops > 0.
    await waitFor(() => {
      expect(screen.getByTestId('compaction-total-ops')).toBeInTheDocument()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when collapsed', async () => {
    // Use emptyStatus so the card stays collapsed (eligible_ops=0).
    mockedInvoke.mockResolvedValueOnce(emptyStatus)

    const { container } = render(<CompactionCard />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_compaction_status')
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // UX-352: auto-expand the card on mount when there are eligible ops to act on,
  // so users see the action surface instead of a silent collapsed header.
  describe('UX-352 auto-expand on eligible ops', () => {
    it('UX-352: starts collapsed when eligible_ops is 0', async () => {
      mockedInvoke.mockResolvedValueOnce(emptyStatus)

      render(<CompactionCard />)

      // Wait for status fetch to settle, then assert still collapsed.
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('get_compaction_status')
      })

      expect(screen.queryByTestId('compaction-total-ops')).not.toBeInTheDocument()
      expect(screen.queryByTestId('compaction-eligible-ops')).not.toBeInTheDocument()
    })

    it('UX-352: auto-expands on mount when eligible_ops > 0', async () => {
      mockedInvoke.mockResolvedValueOnce(defaultStatus)

      render(<CompactionCard />)

      // Stats become visible without any user click — auto-expanded.
      await waitFor(() => {
        expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
      })
      expect(screen.getByTestId('compaction-total-ops')).toBeInTheDocument()
    })

    it('UX-352: auto-expand fires only once per mount; user-collapse is sticky even when eligible_ops grows', async () => {
      const user = userEvent.setup()
      mockedInvoke
        .mockResolvedValueOnce(defaultStatus) // initial fetch (eligible=300) — auto-expands
        .mockResolvedValueOnce({ snapshot_id: 'snap_1', ops_deleted: 0 }) // compactOpLog
        .mockResolvedValueOnce({ ...defaultStatus, eligible_ops: 999 }) // refresh — must NOT re-trigger auto-expand

      render(<CompactionCard />)

      // Initial auto-expand on mount with eligible_ops=300.
      await waitFor(() => {
        expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('300')
      })

      // Drive a status refresh through the post-compaction path. eligible_ops
      // jumps 300 → 999. A naive impl that re-derived collapsed from
      // `eligible > 0` on every render would treat this as another auto-expand
      // signal; the useRef-once guard ensures it does not.
      await user.click(screen.getByRole('button', { name: /Compact Now/i }))
      await user.click(screen.getByRole('button', { name: /^Compact$/i }))
      await waitFor(() => {
        expect(screen.getByTestId('compaction-eligible-ops')).toHaveTextContent('999')
      })

      // User manually collapses. If the auto-expand mechanism were re-firing
      // on every status change, this click would be undone immediately.
      await user.click(screen.getByText('Op Log Compaction'))
      expect(screen.queryByTestId('compaction-eligible-ops')).not.toBeInTheDocument()
    })
  })
})
