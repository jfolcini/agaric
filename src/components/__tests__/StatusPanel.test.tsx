/**
 * Tests for StatusPanel component.
 *
 * Validates:
 *  - Calls get_status on mount
 *  - Renders all 4 metrics
 *  - Polls every 5 seconds (uses fake timers)
 *  - Cleans up interval on unmount
 *  - a11y compliance
 *  - Error/panic section renders when counts > 0 and hides when all zero
 *  - High-water marks displayed under queue depth cards
 *  - Health color classes applied based on queue depth (green/default/amber)
 *  - Tooltip triggers present for all metric labels; content appears on hover
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  describe('error/panic section', () => {
    it('renders when error and panic counts are non-zero', async () => {
      mockedInvoke.mockResolvedValue({
        ...mockStatus,
        fg_errors: 2,
        bg_errors: 0,
        fg_panics: 1,
        bg_panics: 3,
        fg_high_water: 0,
        bg_high_water: 0,
      })

      render(<StatusPanel />)

      expect(
        await screen.findByText('2 foreground errors, 1 foreground panic, 3 background panics'),
      ).toBeInTheDocument()
    })

    it('renders singular form for count of 1', async () => {
      mockedInvoke.mockResolvedValue({
        ...mockStatus,
        fg_errors: 1,
        bg_errors: 0,
        fg_panics: 0,
        bg_panics: 1,
        fg_high_water: 0,
        bg_high_water: 0,
      })

      render(<StatusPanel />)

      expect(await screen.findByText('1 foreground error, 1 background panic')).toBeInTheDocument()
    })

    it('is hidden when all error and panic counts are zero', async () => {
      mockedInvoke.mockResolvedValue({
        ...mockStatus,
        fg_errors: 0,
        bg_errors: 0,
        fg_panics: 0,
        bg_panics: 0,
        fg_high_water: 0,
        bg_high_water: 0,
      })

      render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      expect(screen.queryByText(/foreground error/)).not.toBeInTheDocument()
      expect(screen.queryByText(/background error/)).not.toBeInTheDocument()
      expect(screen.queryByText(/foreground panic/)).not.toBeInTheDocument()
      expect(screen.queryByText(/background panic/)).not.toBeInTheDocument()
    })

    it('is hidden when error fields are undefined (legacy mock)', async () => {
      // mockStatus has no error/panic fields — component defaults to 0
      mockedInvoke.mockResolvedValue(mockStatus)

      render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      expect(screen.queryByText(/foreground error/)).not.toBeInTheDocument()
    })
  })

  describe('high-water marks', () => {
    it('displays peak values under queue depth cards', async () => {
      mockedInvoke.mockResolvedValue({
        ...mockStatus,
        fg_high_water: 15,
        bg_high_water: 22,
        fg_errors: 0,
        bg_errors: 0,
        fg_panics: 0,
        bg_panics: 0,
      })

      render(<StatusPanel />)

      expect(await screen.findByText(/Peak: 15/)).toBeInTheDocument()
      expect(screen.getByText(/Peak: 22/)).toBeInTheDocument()
    })

    it('shows Peak: 0 when high-water fields are undefined', async () => {
      mockedInvoke.mockResolvedValue(mockStatus)

      render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      const peaks = screen.getAllByText(/Peak: 0/)
      expect(peaks).toHaveLength(2)
    })
  })

  describe('health color classes', () => {
    it('applies green accent when queue depth is 0', async () => {
      mockedInvoke.mockResolvedValue({
        foreground_queue_depth: 0,
        background_queue_depth: 0,
        total_ops_dispatched: 5,
        total_background_dispatched: 3,
        fg_high_water: 0,
        bg_high_water: 0,
        fg_errors: 0,
        bg_errors: 0,
        fg_panics: 0,
        bg_panics: 0,
      })

      const { container } = render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      const metricCards = container.querySelectorAll('.status-metric')
      expect(metricCards[0].className).toContain('border-emerald-200')
      expect(metricCards[0].className).toContain('text-emerald-600')
      expect(metricCards[1].className).toContain('border-emerald-200')
      expect(metricCards[1].className).toContain('text-emerald-600')
    })

    it('applies no health accent for queue depth 1-10', async () => {
      // mockStatus has fg=3, bg=7 — both in the 1-10 range
      mockedInvoke.mockResolvedValue(mockStatus)

      const { container } = render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      const metricCards = container.querySelectorAll('.status-metric')
      expect(metricCards[0].className).not.toContain('border-emerald')
      expect(metricCards[0].className).not.toContain('border-amber')
      expect(metricCards[1].className).not.toContain('border-emerald')
      expect(metricCards[1].className).not.toContain('border-amber')
    })

    it('applies amber accent when queue depth exceeds 10', async () => {
      mockedInvoke.mockResolvedValue({
        foreground_queue_depth: 15,
        background_queue_depth: 25,
        total_ops_dispatched: 5,
        total_background_dispatched: 3,
        fg_high_water: 15,
        bg_high_water: 25,
        fg_errors: 0,
        bg_errors: 0,
        fg_panics: 0,
        bg_panics: 0,
      })

      const { container } = render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      const metricCards = container.querySelectorAll('.status-metric')
      expect(metricCards[0].className).toContain('border-amber-200')
      expect(metricCards[0].className).toContain('text-amber-600')
      expect(metricCards[1].className).toContain('border-amber-200')
      expect(metricCards[1].className).toContain('text-amber-600')
    })
  })

  describe('tooltips', () => {
    it('shows tooltip content when hovering a metric label', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(mockStatus)

      render(<StatusPanel />)

      const fgLabel = await screen.findByText('Foreground Queue')
      await user.hover(fgLabel)

      await waitFor(() => {
        const matches = screen.getAllByText(
          'Operations waiting to be applied to the database. Should stay near zero.',
        )
        expect(matches.length).toBeGreaterThanOrEqual(1)
      })
    })

    it('has tooltip triggers for all four metric labels', async () => {
      mockedInvoke.mockResolvedValue(mockStatus)

      const { container } = render(<StatusPanel />)

      await screen.findByText('Foreground Queue')

      // All 4 labels should be wrapped in tooltip trigger spans with cursor-help
      const tooltipTriggers = container.querySelectorAll('.cursor-help')
      expect(tooltipTriggers).toHaveLength(4)
      expect(tooltipTriggers[0].textContent).toBe('Foreground Queue')
      expect(tooltipTriggers[1].textContent).toBe('Background Queue')
      expect(tooltipTriggers[2].textContent).toBe('Ops Dispatched')
      expect(tooltipTriggers[3].textContent).toBe('Background Dispatched')
    })
  })
})
