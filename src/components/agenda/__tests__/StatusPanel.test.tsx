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

import {
  type CommandReturns,
  mockInvokeCommands,
  type TypedInvokeHandlers,
} from '@/__tests__/helpers/invoke'
import { StatusPanel } from '@/components/agenda/StatusPanel'

// Mock DeviceManagement to prevent its own IPC calls from interfering
vi.mock('@/components/peers/DeviceManagement', () => ({
  DeviceManagement: () => <div data-testid="device-management">Device ID: mock-device</div>,
}))

// Controllable sync store state for tests that need non-default values.
const { mockSyncStoreState, mockSetState } = vi.hoisted(() => ({
  mockSetState: vi.fn(),
  mockSyncStoreState: {
    state: 'idle' as string,
    error: null as string | null,
    peers: [] as Array<{ peer_id?: string; peerId?: string }>,
    lastSyncedAt: null as string | null,
    opsReceived: 0,
    opsSent: 0,
    setState: undefined as unknown as ReturnType<typeof vi.fn>,
  },
}))
mockSyncStoreState.setState = mockSetState

vi.mock('@/stores/sync', () => ({
  useSyncStore: (selector: (s: typeof mockSyncStoreState) => unknown) =>
    selector(mockSyncStoreState),
}))

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(handlers: Readonly<TypedInvokeHandlers>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

/**
 * What `get_status` actually resolves with.
 *
 * #4668 — this fixture used to carry four fields. `StatusInfo` has thirty-odd,
 * all of them required: the panel's `?? 0` defaults for `fg_high_water`,
 * `bg_high_water` and `bg_dropped` can never fire against the real backend,
 * and the tests that pinned them were pinning a response nothing sends. The
 * counters below are zeroed so every assertion that read a defaulted `0` still
 * reads `0`; `retry_queue_pending` is genuinely nullable, so it stays `null`
 * and keeps `BoundedStalenessNotice`'s live `?? 0` branch covered.
 */
const mockStatus: CommandReturns['get_status'] = {
  foreground_queue_depth: 3,
  background_queue_depth: 7,
  total_ops_dispatched: 42,
  total_background_dispatched: 15,
  fg_high_water: 0,
  bg_high_water: 0,
  fg_errors: 0,
  bg_errors: 0,
  fg_apply_dropped: 0,
  fg_apply_dropped_persisted: 0,
  bg_dropped: 0,
  bg_dropped_global: 0,
  bg_deduped: 0,
  fg_full_waits: 0,
  bg_full_waits: 0,
  retry_queue_persist_errors: 0,
  retry_queue_giveup_total: 0,
  last_materialize_at: null,
  time_since_last_materialize_secs: null,
  total_ops_in_log: null,
  sync_peer_failure_counts: [],
  retry_queue_pending: null,
  retry_persist_apply_op: 0,
  retry_persist_cache: 0,
  retry_persist_cache_global: 0,
  retry_persist_capped: 0,
  sql_only_fallback_count: 0,
  descendant_fanout_dropped: 0,
  snapshot_fallback_count: 0,
  snapshot_fallback_last: null,
  audit_ingest_deferred: 0,
  audit_ingest_stalls: 0,
  audit_ingest_out_of_order: 0,
  audit_ingest_last_stall: null,
}

/**
 * What `start_sync` resolves with: `SyncSessionInfo`. The retry test used to
 * let the catch-all hand it a `StatusInfo` (#4668).
 */
const mockSyncSession: CommandReturns['start_sync'] = {
  state: 'idle',
  local_device_id: 'LOCAL',
  remote_device_id: 'REMOTE',
  ops_received: 0,
  ops_sent: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset sync store to defaults
  mockSyncStoreState.state = 'idle'
  mockSyncStoreState.error = null
  mockSyncStoreState.peers = []
  mockSyncStoreState.lastSyncedAt = null
  mockSyncStoreState.opsReceived = 0
  mockSyncStoreState.opsSent = 0
  mockSetState.mockClear()
})

describe('StatusPanel', () => {
  it('calls get_status on mount', async () => {
    stubInvoke({ get_status: () => mockStatus })

    render(<StatusPanel />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_status')
    })
  })

  it('renders all 4 metrics', async () => {
    stubInvoke({ get_status: () => mockStatus })

    render(<StatusPanel />)

    expect(await screen.findByText('3')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByText('57')).toBeInTheDocument() // total_ops_dispatched (42) + total_background_dispatched (15)
    expect(screen.getByText('15')).toBeInTheDocument()

    // Labels
    expect(screen.getByText('Foreground Queue')).toBeInTheDocument()
    expect(screen.getByText('Background Queue')).toBeInTheDocument()
    expect(screen.getByText('Ops Processed')).toBeInTheDocument()
    expect(screen.getByText('Background Dispatched')).toBeInTheDocument()
  })

  it('renders the panel title', async () => {
    stubInvoke({ get_status: () => mockStatus })

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
      stubInvoke({ get_status: () => mockStatus })

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
      stubInvoke({ get_status: () => mockStatus })

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
      const updatedStatus: CommandReturns['get_status'] = {
        ...mockStatus,
        foreground_queue_depth: 10,
        background_queue_depth: 20,
        total_ops_dispatched: 100,
        total_background_dispatched: 50,
      }
      // The mount load and the first poll must answer DIFFERENTLY, which the
      // positional `…Once` queue this replaced expressed by call order alone.
      // Keyed on the command, the order is explicit instead.
      let polls = 0
      stubInvoke({
        get_status: () => (polls++ === 0 ? mockStatus : updatedStatus),
      })

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
      expect(screen.getByText('150')).toBeInTheDocument() // 100 + 50
      expect(screen.getByText('50')).toBeInTheDocument()
    })
  })

  it('has no a11y violations', async () => {
    stubInvoke({ get_status: () => mockStatus })

    const { container } = render(<StatusPanel />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('handles error from getStatus without crashing', async () => {
    stubInvoke({ get_status: () => Promise.reject(new Error('network failure')) })

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

    // Initial load succeeds, the poll that follows fails. Keyed on call order
    // inside the handler rather than on the positional `…Once` queue.
    let polls = 0
    stubInvoke({
      get_status: () => (polls++ === 0 ? mockStatus : Promise.reject(new Error('poll failed'))),
    })

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

  // #3382: the panel used to carry `fg_panics` / `bg_panics` alongside the
  // error counts. Those counters were deleted — `panic = "abort"` in the
  // release profile guarantees they read zero in a shipped build — so a panic
  // that a debug build can still observe now surfaces as an error here.
  describe('error section', () => {
    it('renders when error counts are non-zero', async () => {
      stubInvoke({
        get_status: () => ({
          ...mockStatus,
          fg_errors: 2,
          bg_errors: 3,
          fg_high_water: 0,
          bg_high_water: 0,
        }),
      })

      render(<StatusPanel />)

      expect(
        await screen.findByText('2 foreground errors, 3 background errors'),
      ).toBeInTheDocument()
    })

    it('renders singular form for count of 1', async () => {
      stubInvoke({
        get_status: () => ({
          ...mockStatus,
          fg_errors: 1,
          bg_errors: 1,
          fg_high_water: 0,
          bg_high_water: 0,
        }),
      })

      render(<StatusPanel />)

      expect(await screen.findByText('1 foreground error, 1 background error')).toBeInTheDocument()
    })

    it('is hidden when all error counts are zero', async () => {
      stubInvoke({
        get_status: () => ({
          ...mockStatus,
          fg_errors: 0,
          bg_errors: 0,
          fg_high_water: 0,
          bg_high_water: 0,
        }),
      })

      render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      expect(screen.queryByText(/foreground error/)).not.toBeInTheDocument()
      expect(screen.queryByText(/background error/)).not.toBeInTheDocument()
    })

    it('is hidden for the base status, whose error counters are zero', async () => {
      // #4668 — this case used to omit the error fields entirely and lean on
      // the component's `?? 0`. `StatusInfo` requires them, so the backend
      // always sends a number; zero is the shape it sends when nothing failed.
      stubInvoke({ get_status: () => mockStatus })

      render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      expect(screen.queryByText(/foreground error/)).not.toBeInTheDocument()
    })

    it('shows cache staleness warning when bgErrors > 0', async () => {
      stubInvoke({
        get_status: () => ({
          ...mockStatus,
          fg_errors: 0,
          bg_errors: 3,
          fg_high_water: 0,
          bg_high_water: 0,
        }),
      })

      render(<StatusPanel />)

      expect(await screen.findByText('3 background errors')).toBeInTheDocument()
      expect(
        screen.getByText('Cache data may be stale. Restart the app to retry.'),
      ).toBeInTheDocument()
    })
  })

  describe('bounded-staleness notice (#2471)', () => {
    it('renders when a background rebuild dropped and retry rows are pending', async () => {
      stubInvoke({
        get_status: () => ({
          ...mockStatus,
          bg_dropped: 4,
          retry_queue_pending: 2,
        }),
      })

      render(<StatusPanel />)

      expect(
        await screen.findByText(
          '2 background cache rebuilds pending — search, agenda, and counts may be briefly stale.',
        ),
      ).toBeInTheDocument()
      expect(screen.getByTestId('status-panel-stale')).toBeInTheDocument()
    })

    it('renders the singular form for a single pending rebuild', async () => {
      stubInvoke({
        get_status: () => ({
          ...mockStatus,
          bg_dropped: 1,
          retry_queue_pending: 1,
        }),
      })

      render(<StatusPanel />)

      expect(
        await screen.findByText(
          '1 background cache rebuild pending — search, agenda, and counts may be briefly stale.',
        ),
      ).toBeInTheDocument()
    })

    it('is hidden when a drop occurred but the retry queue has drained', async () => {
      // bg_dropped is monotonic since boot; once the queue drains the notice
      // must clear rather than stay lit on the stale counter.
      stubInvoke({
        get_status: () => ({
          ...mockStatus,
          bg_dropped: 4,
          retry_queue_pending: 0,
        }),
      })

      render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      expect(screen.queryByTestId('status-panel-stale')).not.toBeInTheDocument()
    })

    it('is hidden when rows are pending but no background drop occurred', async () => {
      stubInvoke({
        get_status: () => ({
          ...mockStatus,
          bg_dropped: 0,
          retry_queue_pending: 5,
        }),
      })

      render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      expect(screen.queryByTestId('status-panel-stale')).not.toBeInTheDocument()
    })

    // The base fixture drops nothing (`bg_dropped: 0`) and reports a null
    // `retry_queue_pending` — the one nullable field of the pair, so this
    // still covers `BoundedStalenessNotice`'s `?? 0` on a real backend shape.
    it('is hidden when nothing dropped and the pending count is null', async () => {
      stubInvoke({ get_status: () => mockStatus })

      render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      expect(screen.queryByTestId('status-panel-stale')).not.toBeInTheDocument()
    })
  })

  describe('high-water marks', () => {
    it('displays peak values under queue depth cards', async () => {
      stubInvoke({
        get_status: () => ({
          ...mockStatus,
          fg_high_water: 15,
          bg_high_water: 22,
          fg_errors: 0,
          bg_errors: 0,
        }),
      })

      render(<StatusPanel />)

      expect(await screen.findByText(/Peak: 15/)).toBeInTheDocument()
      expect(screen.getByText(/Peak: 22/)).toBeInTheDocument()
    })

    // #4668 — was "when high-water fields are undefined". They are required
    // on `StatusInfo`; a quiet queue reports zero, which is what this pins.
    it('shows Peak: 0 when the high-water marks are zero', async () => {
      stubInvoke({ get_status: () => mockStatus })

      render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      const peaks = screen.getAllByText(/Peak: 0/)
      expect(peaks).toHaveLength(2)
    })
  })

  describe('health color classes', () => {
    it('applies green accent when queue depth is 0', async () => {
      stubInvoke({
        get_status: () => ({
          ...mockStatus,
          foreground_queue_depth: 0,
          background_queue_depth: 0,
          total_ops_dispatched: 5,
          total_background_dispatched: 3,
          fg_high_water: 0,
          bg_high_water: 0,
          fg_errors: 0,
          bg_errors: 0,
        }),
      })

      const { container } = render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      const metricCards = container.querySelectorAll('.status-metric')
      expect(metricCards[0]?.className).toContain('border-status-done')
      expect(metricCards[0]?.className).toContain('text-status-done-foreground')
      expect(metricCards[1]?.className).toContain('border-status-done')
      expect(metricCards[1]?.className).toContain('text-status-done-foreground')
    })

    it('applies no health accent for queue depth 1-10', async () => {
      // mockStatus has fg=3, bg=7 — both in the 1-10 range
      stubInvoke({ get_status: () => mockStatus })

      const { container } = render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      const metricCards = container.querySelectorAll('.status-metric')
      expect(metricCards[0]?.className).not.toContain('border-status-done')
      expect(metricCards[0]?.className).not.toContain('border-status-pending')
      expect(metricCards[1]?.className).not.toContain('border-status-done')
      expect(metricCards[1]?.className).not.toContain('border-status-pending')
    })

    it('applies amber accent when queue depth exceeds 10', async () => {
      stubInvoke({
        get_status: () => ({
          ...mockStatus,
          foreground_queue_depth: 15,
          background_queue_depth: 25,
          total_ops_dispatched: 5,
          total_background_dispatched: 3,
          fg_high_water: 15,
          bg_high_water: 25,
          fg_errors: 0,
          bg_errors: 0,
        }),
      })

      const { container } = render(<StatusPanel />)

      await screen.findByText('Foreground Queue')
      const metricCards = container.querySelectorAll('.status-metric')
      expect(metricCards[0]?.className).toContain('border-status-pending')
      expect(metricCards[0]?.className).toContain('text-status-pending-foreground')
      expect(metricCards[1]?.className).toContain('border-status-pending')
      expect(metricCards[1]?.className).toContain('text-status-pending-foreground')
    })
  })

  describe('tooltips', () => {
    it('shows tooltip content when hovering a metric label', async () => {
      const user = userEvent.setup()
      stubInvoke({ get_status: () => mockStatus })

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
      stubInvoke({ get_status: () => mockStatus })

      const { container } = render(<StatusPanel />)

      await screen.findByText('Foreground Queue')

      // All 4 labels should be wrapped in tooltip trigger spans with cursor-help
      const tooltipTriggers = container.querySelectorAll('.cursor-help')
      expect(tooltipTriggers).toHaveLength(4)
      expect(tooltipTriggers[0]?.textContent).toBe('Foreground Queue')
      expect(tooltipTriggers[1]?.textContent).toBe('Background Queue')
      expect(tooltipTriggers[2]?.textContent).toBe('Ops Processed')
      expect(tooltipTriggers[3]?.textContent).toBe('Background Dispatched')
    })
  })

  describe('tooltip keyboard accessibility', () => {
    it('tooltip triggers have tabIndex={0} for keyboard access', async () => {
      stubInvoke({ get_status: () => mockStatus })

      const { container } = render(<StatusPanel />)

      await screen.findByText('Foreground Queue')

      const tooltipTriggers = container.querySelectorAll('.cursor-help')
      expect(tooltipTriggers).toHaveLength(4)
      for (const trigger of tooltipTriggers) {
        expect(trigger.getAttribute('tabindex')).toBe('0')
      }
    })
  })

  describe('Last Synced display', () => {
    it('shows relative time when lastSyncedAt is set', async () => {
      stubInvoke({ get_status: () => mockStatus })
      mockSyncStoreState.peers = [{ peer_id: 'peer-1' }]
      mockSyncStoreState.lastSyncedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()

      render(<StatusPanel />)

      await screen.findByText('Foreground Queue')

      // formatRelativeTime (i18n) resolves sidebar.minutesAgo -> "5m ago"
      const lastSyncedEl = document.querySelector('.sync-last-synced')
      expect(lastSyncedEl?.textContent).toBe('5m ago')
    })

    it('shows "--" when lastSyncedAt is null', async () => {
      stubInvoke({ get_status: () => mockStatus })
      mockSyncStoreState.peers = [{ peer_id: 'peer-1' }]
      mockSyncStoreState.lastSyncedAt = null

      render(<StatusPanel />)

      await screen.findByText('Foreground Queue')

      const lastSyncedEl = document.querySelector('.sync-last-synced')
      expect(lastSyncedEl?.textContent).toBe('--')
    })
  })

  describe('sync section', () => {
    it('shows "Not configured" when sync has no peers', async () => {
      // Default mock has peers: [] — should show "Not configured"
      stubInvoke({ get_status: () => mockStatus })
      render(<StatusPanel />)
      await screen.findByText('Materializer Status')
      expect(screen.getByText('Not configured')).toBeInTheDocument()
    })

    it('shows sync state indicator when peers exist', async () => {
      mockSyncStoreState.peers = [{ peer_id: 'P1' }]
      mockSyncStoreState.state = 'idle'
      stubInvoke({ get_status: () => mockStatus })
      render(<StatusPanel />)
      await screen.findByText('Materializer Status')
      expect(screen.getByText('Idle')).toBeInTheDocument()
    })

    // #1076: the full Sync panel (state dot, error, peer count, ops
    // metrics) was permanently unreachable dead UI because store `peers`
    // was always `[]`. With the store now wired to the backend, peers
    // existing must swap the "Not configured" placeholder for the panel.
    it('renders the full Sync panel (not "Not configured") when peers exist (#1076)', async () => {
      mockSyncStoreState.peers = [{ peer_id: 'P1' }]
      mockSyncStoreState.state = 'idle'
      stubInvoke({ get_status: () => mockStatus })
      const { container } = render(<StatusPanel />)
      await screen.findByText('Materializer Status')

      expect(screen.queryByTestId('sync-panel-not-configured')).not.toBeInTheDocument()
      expect(container.querySelector('.sync-panel-details')).toBeInTheDocument()
      expect(container.querySelector('.sync-state-dot')).toBeInTheDocument()

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('shows sync error message when error is set', async () => {
      mockSyncStoreState.peers = [{ peer_id: 'P1' }]
      mockSyncStoreState.state = 'error'
      mockSyncStoreState.error = 'Connection lost'
      stubInvoke({ get_status: () => mockStatus })
      render(<StatusPanel />)
      await screen.findByText('Materializer Status')
      expect(screen.getByText('Connection lost')).toBeInTheDocument()
      // The sync error must be a live region so screen readers announce it.
      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent('Connection lost')
      expect(alert).toHaveClass('sync-panel-error')
    })

    // #2059 — the sync-error state must offer a recovery affordance
    // (a "Sync now" / Retry button), matching DeviceManagement.
    describe('error-state retry affordance (#2059)', () => {
      it('renders a Sync now retry button when sync state is error', async () => {
        mockSyncStoreState.peers = [{ peerId: 'P1' }]
        mockSyncStoreState.state = 'error'
        mockSyncStoreState.error = 'Connection lost'
        stubInvoke({ get_status: () => mockStatus })
        render(<StatusPanel />)
        await screen.findByText('Materializer Status')

        const retry = screen.getByTestId('sync-panel-retry')
        expect(retry).toBeInTheDocument()
        expect(retry).toHaveTextContent('Sync now')
        expect(retry).toHaveAccessibleName('Retry sync with all paired devices')
      })

      it('does not render the retry button in non-error states', async () => {
        mockSyncStoreState.peers = [{ peerId: 'P1' }]
        mockSyncStoreState.state = 'idle'
        stubInvoke({ get_status: () => mockStatus })
        render(<StatusPanel />)
        await screen.findByText('Materializer Status')
        expect(screen.queryByTestId('sync-panel-retry')).not.toBeInTheDocument()
      })

      it('re-syncs every paired peer and flips sync state on click', async () => {
        const user = userEvent.setup()
        mockSyncStoreState.peers = [{ peerId: 'P1' }, { peerId: 'P2' }]
        mockSyncStoreState.state = 'error'
        mockSyncStoreState.error = 'Connection lost'
        // get_status (polling) + start_sync (per peer) all succeed. The
        // catch-all this replaced handed `start_sync` a `StatusInfo`; it
        // returns `SyncSessionInfo` (#4668).
        stubInvoke({ get_status: () => mockStatus, start_sync: () => mockSyncSession })
        render(<StatusPanel />)
        await screen.findByText('Materializer Status')

        await user.click(screen.getByTestId('sync-panel-retry'))

        await waitFor(() => {
          expect(mockedInvoke).toHaveBeenCalledWith(
            'start_sync',
            expect.objectContaining({ peerId: 'P1' }),
          )
          expect(mockedInvoke).toHaveBeenCalledWith(
            'start_sync',
            expect.objectContaining({ peerId: 'P2' }),
          )
        })

        // Flips to syncing for the run, then back to idle on success.
        expect(mockSetState).toHaveBeenCalledWith('syncing')
        await waitFor(() => {
          expect(mockSetState).toHaveBeenCalledWith('idle', null)
        })
      })

      it('has no a11y violations in the sync-error state', async () => {
        mockSyncStoreState.peers = [{ peerId: 'P1' }]
        mockSyncStoreState.state = 'error'
        mockSyncStoreState.error = 'Connection lost'
        stubInvoke({ get_status: () => mockStatus })
        const { container } = render(<StatusPanel />)
        await screen.findByText('Materializer Status')
        await screen.findByTestId('sync-panel-retry')

        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })

    it('shows sync metrics (peers count, ops received/sent)', async () => {
      mockSyncStoreState.peers = [{ peer_id: 'P1' }, { peer_id: 'P2' }]
      mockSyncStoreState.state = 'syncing'
      mockSyncStoreState.opsReceived = 99
      mockSyncStoreState.opsSent = 17
      stubInvoke({ get_status: () => mockStatus })
      render(<StatusPanel />)
      await screen.findByText('Materializer Status')
      expect(screen.getByText('Peers')).toBeInTheDocument()
      const peerCount = document.querySelector('.sync-peer-count')
      expect(peerCount?.textContent).toBe('2')
      const opsReceived = document.querySelector('.sync-ops-received')
      expect(opsReceived?.textContent).toBe('99')
      const opsSent = document.querySelector('.sync-ops-sent')
      expect(opsSent?.textContent).toBe('17')
    })

    it('shows "Syncing..." state label during active sync', async () => {
      mockSyncStoreState.peers = [{ peer_id: 'P1' }]
      mockSyncStoreState.state = 'syncing'
      stubInvoke({ get_status: () => mockStatus })
      render(<StatusPanel />)
      await screen.findByText('Materializer Status')
      expect(screen.getByText('Syncing...')).toBeInTheDocument()
    })

    // Sub-fix 2: each sync state renders a distinct lucide
    // icon next to the dot so colour-blind users (and anyone glancing
    // at the panel) can tell the states apart beyond colour. The icon
    // is decorative — the text label carries the canonical state.
    //
    // #1076: the `discovering` / `pairing` icon cases were removed with
    // those (dead, never-written) SyncState members.
    describe('per-state icon', () => {
      it('renders a CheckCircle-style icon for the idle state', async () => {
        mockSyncStoreState.peers = [{ peer_id: 'P1' }]
        mockSyncStoreState.state = 'idle'
        stubInvoke({ get_status: () => mockStatus })
        render(<StatusPanel />)
        await screen.findByText('Idle')
        expect(screen.getByTestId('sync-state-icon-idle')).toBeInTheDocument()
      })

      it('renders an AlertCircle-style icon for the error state', async () => {
        mockSyncStoreState.peers = [{ peer_id: 'P1' }]
        mockSyncStoreState.state = 'error'
        mockSyncStoreState.error = 'boom'
        stubInvoke({ get_status: () => mockStatus })
        render(<StatusPanel />)
        await screen.findByText('Error')
        expect(screen.getByTestId('sync-state-icon-error')).toBeInTheDocument()
      })

      it('renders a spinning RefreshCw icon for the syncing state', async () => {
        mockSyncStoreState.peers = [{ peer_id: 'P1' }]
        mockSyncStoreState.state = 'syncing'
        stubInvoke({ get_status: () => mockStatus })
        render(<StatusPanel />)
        await screen.findByText('Syncing...')
        const icon = screen.getByTestId('sync-state-icon-syncing')
        expect(icon).toBeInTheDocument()
        expect(icon.getAttribute('class') ?? '').toContain('animate-spin')
      })
    })

    it('shows tooltip on sync metric label hover', async () => {
      mockSyncStoreState.peers = [{ peer_id: 'P1' }]
      mockSyncStoreState.state = 'idle'
      stubInvoke({ get_status: () => mockStatus })
      const user = userEvent.setup()
      render(<StatusPanel />)
      await screen.findByText('Materializer Status')
      // Hover over "Ops Received" metric label
      const label = screen.getByText('Ops Received')
      await user.hover(label)
      await waitFor(() => {
        const matches = screen.getAllByText(/sync messages received from peers/i)
        expect(matches.length).toBeGreaterThanOrEqual(1)
      })
    })
  })
})
