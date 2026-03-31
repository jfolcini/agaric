/**
 * Tests for StatusPanel component.
 *
 * Validates:
 *  - Calls get_status on mount
 *  - Renders all 4 metrics
 *  - Polls every 5 seconds (uses fake timers)
 *  - Cleans up interval on unmount
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { StatusPanel } from '../StatusPanel'

const mockedInvoke = vi.mocked(invoke)

const mockStatus = {
  foreground_queue_depth: 3,
  background_queue_depth: 7,
  total_ops_dispatched: 42,
  total_background_dispatched: 15,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('StatusPanel', () => {
  it('calls get_status on mount', async () => {
    mockedInvoke.mockResolvedValue(mockStatus)

    render(<StatusPanel />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_status')
    })
  })

  it('renders all 4 metrics', async () => {
    mockedInvoke.mockResolvedValue(mockStatus)

    render(<StatusPanel />)

    expect(await screen.findByText('3')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('15')).toBeInTheDocument()

    // Labels
    expect(screen.getByText('Foreground Queue')).toBeInTheDocument()
    expect(screen.getByText('Background Queue')).toBeInTheDocument()
    expect(screen.getByText('Ops Dispatched')).toBeInTheDocument()
    expect(screen.getByText('Background Dispatched')).toBeInTheDocument()
  })

  it('renders the panel title', async () => {
    mockedInvoke.mockResolvedValue(mockStatus)

    render(<StatusPanel />)

    expect(await screen.findByText('Materializer Status')).toBeInTheDocument()
  })

  describe('polling with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('polls every 5 seconds', async () => {
      mockedInvoke.mockResolvedValue(mockStatus)

      await act(async () => {
        render(<StatusPanel />)
      })

      // Initial call
      expect(mockedInvoke).toHaveBeenCalledTimes(1)

      // Advance 5 seconds — should trigger second call
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(mockedInvoke).toHaveBeenCalledTimes(2)

      // Advance another 5 seconds
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(mockedInvoke).toHaveBeenCalledTimes(3)
    })

    it('cleans up interval on unmount', async () => {
      mockedInvoke.mockResolvedValue(mockStatus)

      let unmountFn: (() => void) | undefined
      await act(async () => {
        const { unmount } = render(<StatusPanel />)
        unmountFn = unmount
      })

      expect(mockedInvoke).toHaveBeenCalledTimes(1)

      unmountFn?.()

      // Advance time — should NOT trigger more calls
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })

      expect(mockedInvoke).toHaveBeenCalledTimes(1)
    })

    it('updates metrics when polled data changes', async () => {
      const updatedStatus = {
        foreground_queue_depth: 10,
        background_queue_depth: 20,
        total_ops_dispatched: 100,
        total_background_dispatched: 50,
      }
      mockedInvoke.mockResolvedValueOnce(mockStatus).mockResolvedValueOnce(updatedStatus)

      await act(async () => {
        render(<StatusPanel />)
      })

      // Initial values
      expect(screen.getByText('3')).toBeInTheDocument()

      // Advance timer to trigger poll
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      // Updated values
      expect(screen.getByText('10')).toBeInTheDocument()
      expect(screen.getByText('20')).toBeInTheDocument()
      expect(screen.getByText('100')).toBeInTheDocument()
      expect(screen.getByText('50')).toBeInTheDocument()
    })
  })

  it('has no a11y violations', async () => {
    mockedInvoke.mockResolvedValue(mockStatus)

    const { container } = render(<StatusPanel />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('handles error from getStatus without crashing', async () => {
    mockedInvoke.mockRejectedValue(new Error('network failure'))

    render(<StatusPanel />)

    // Should show error message
    await waitFor(() => {
      expect(screen.getByText('Failed to load status')).toBeInTheDocument()
    })
    // Metrics should not render since status is still null
    expect(screen.queryByText('Foreground Queue')).not.toBeInTheDocument()
  })

  it('shows error alongside status when poll fails after initial success', async () => {
    vi.useFakeTimers()

    mockedInvoke
      .mockResolvedValueOnce(mockStatus) // initial load succeeds
      .mockRejectedValueOnce(new Error('poll failed')) // second poll fails

    await act(async () => {
      render(<StatusPanel />)
    })

    // Status metrics should be visible
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('Foreground Queue')).toBeInTheDocument()

    // No error initially
    expect(screen.queryByText('Failed to load status')).not.toBeInTheDocument()

    // Advance to trigger poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    // Error should now be visible alongside the status metrics
    expect(screen.getByText('Failed to load status')).toBeInTheDocument()
    expect(screen.getByText('Foreground Queue')).toBeInTheDocument()

    vi.useRealTimers()
  })
})
