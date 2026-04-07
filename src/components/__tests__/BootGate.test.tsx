/**
 * Tests for BootGate component.
 *
 * Validates:
 *  - Calls boot() on mount
 *  - Shows loading spinner in booting state
 *  - Shows recovering spinner
 *  - Shows error state with message and retry button
 *  - Retry button triggers boot again
 *  - Renders children when ready
 *  - a11y compliance (ready & error states)
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// Mock lucide-react icons so we don't pull in the full icon library in tests.
vi.mock('lucide-react', () => ({
  AlertCircle: (props: { className?: string }) => (
    <svg data-testid="alert-circle-icon" className={props.className} />
  ),
  Loader2: (props: { className?: string }) => (
    <svg data-testid="loader-icon" className={props.className} />
  ),
}))

import { useBootStore } from '../../stores/boot'
import { BootGate } from '../BootGate'

const mockedInvoke = vi.mocked(invoke)

/** Reference to the real boot function from the store (before any test overrides it). */
const realBoot = useBootStore.getState().boot

/** No-op boot function to prevent the useEffect from transitioning state. */
const noopBoot = vi.fn(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  useBootStore.setState({ state: 'booting', error: null })
})

describe('BootGate', () => {
  it('calls boot() on mount', async () => {
    // Let boot succeed so the effect completes cleanly.
    mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    // boot() calls invoke('list_blocks', {})
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {})
    })
  })

  it('shows loading state when state is booting', () => {
    // Replace boot with a no-op so the useEffect doesn't transition state.
    useBootStore.setState({ state: 'booting', error: null, boot: noopBoot })

    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    expect(screen.getByText(/Starting Agaric/)).toBeInTheDocument()
    expect(screen.getByTestId('loader-icon')).toBeInTheDocument()
    expect(screen.queryByText('App content')).not.toBeInTheDocument()
  })

  it('shows recovering state when state is recovering', () => {
    // Replace boot with a no-op so state stays 'recovering'.
    useBootStore.setState({ state: 'recovering', error: null, boot: noopBoot })

    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    expect(screen.getByText(/Recovering/)).toBeInTheDocument()
    expect(screen.getByTestId('loader-icon')).toBeInTheDocument()
    expect(screen.queryByText('App content')).not.toBeInTheDocument()
  })

  it('shows error state with message', () => {
    // Replace boot with a no-op so state stays 'error'.
    useBootStore.setState({ state: 'error', error: 'DB connection failed', boot: noopBoot })

    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    expect(screen.getByText('Failed to start')).toBeInTheDocument()
    expect(screen.getByText('DB connection failed')).toBeInTheDocument()
    expect(screen.getByTestId('alert-circle-icon')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
    expect(screen.queryByText('App content')).not.toBeInTheDocument()
  })

  it('retry button calls boot() again', async () => {
    const user = userEvent.setup()
    const bootSpy = vi.fn(async () => {})

    // Start in error state with a spy boot.
    useBootStore.setState({ state: 'error', error: 'Something went wrong', boot: bootSpy })

    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    // boot is called once from useEffect on mount.
    expect(bootSpy).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Retry/i }))

    // Clicking Retry calls boot() again.
    expect(bootSpy).toHaveBeenCalledTimes(2)
  })

  it('renders children when state is ready', () => {
    // Replace boot with a no-op so state stays 'ready'.
    useBootStore.setState({ state: 'ready', error: null, boot: noopBoot })

    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    expect(screen.getByText('App content')).toBeInTheDocument()
    // No loading or error indicators
    expect(screen.queryByTestId('loader-icon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('alert-circle-icon')).not.toBeInTheDocument()
    expect(screen.queryByText('Failed to start')).not.toBeInTheDocument()
  })

  it('has no a11y violations (ready state)', async () => {
    useBootStore.setState({ state: 'ready', error: null, boot: noopBoot })

    const { container } = render(
      <BootGate>
        <main>
          <p>App content</p>
        </main>
      </BootGate>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations (error state)', async () => {
    useBootStore.setState({ state: 'error', error: 'Backend unavailable', boot: noopBoot })

    const { container } = render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('retry button shows spinner and is disabled while retrying', async () => {
    const user = userEvent.setup()
    // boot that never resolves (stays in 'error' state)
    const pendingBoot = vi.fn(() => new Promise<void>(() => {}))

    useBootStore.setState({ state: 'error', error: 'Something went wrong', boot: pendingBoot })

    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    const retryBtn = screen.getByRole('button', { name: /Retry/i })
    expect(retryBtn).not.toBeDisabled()

    await user.click(retryBtn)

    // Button should be disabled and show a spinner
    await waitFor(() => {
      expect(retryBtn).toBeDisabled()
      expect(screen.getByTestId('loader-icon')).toBeInTheDocument()
    })
  })

  it('retry button resets disabled state when state changes from error', async () => {
    const user = userEvent.setup()
    let resolveBootFn: (() => void) | undefined
    const controllableBoot = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveBootFn = resolve
        }),
    )

    useBootStore.setState({ state: 'error', error: 'Something went wrong', boot: controllableBoot })

    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    const retryBtn = screen.getByRole('button', { name: /Retry/i })
    await user.click(retryBtn)

    // Button should now be disabled
    await waitFor(() => {
      expect(retryBtn).toBeDisabled()
    })

    // Simulate state transitioning to booting (which would happen when boot() succeeds)
    useBootStore.setState({ state: 'booting', error: null })

    // Component should now show the booting UI (not the error UI)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument()
      expect(screen.getByText(/Starting Agaric/)).toBeInTheDocument()
    })

    resolveBootFn?.()
  })

  describe('error paths (invoke rejection)', () => {
    beforeEach(() => {
      // Restore the real boot function (other tests may have replaced it with noopBoot).
      useBootStore.setState({ state: 'booting', error: null, boot: realBoot })
    })

    it('renders error state when list_blocks rejects with an Error', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('DB connection failed'))

      render(
        <BootGate>
          <p>App content</p>
        </BootGate>,
      )

      await waitFor(() => {
        expect(screen.getByText('Failed to start')).toBeInTheDocument()
      })
      expect(screen.getByText('DB connection failed')).toBeInTheDocument()
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
      expect(screen.queryByText('App content')).not.toBeInTheDocument()
    })

    it('renders error state when list_blocks rejects with a non-Error value', async () => {
      mockedInvoke.mockRejectedValueOnce('plain string error')

      render(
        <BootGate>
          <p>App content</p>
        </BootGate>,
      )

      await waitFor(() => {
        expect(screen.getByText('Failed to start')).toBeInTheDocument()
      })
      expect(screen.getByText('plain string error')).toBeInTheDocument()
      expect(screen.queryByText('App content')).not.toBeInTheDocument()
    })

    it('displays updated error message when retry also fails', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockRejectedValueOnce(new Error('First failure'))

      render(
        <BootGate>
          <p>App content</p>
        </BootGate>,
      )

      await waitFor(() => {
        expect(screen.getByText('First failure')).toBeInTheDocument()
      })

      mockedInvoke.mockRejectedValueOnce(new Error('Second failure'))
      await user.click(screen.getByRole('button', { name: /Retry/i }))

      await waitFor(() => {
        expect(screen.getByText('Second failure')).toBeInTheDocument()
      })
      expect(screen.queryByText('First failure')).not.toBeInTheDocument()
      expect(screen.queryByText('App content')).not.toBeInTheDocument()
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {})
    })

    it('transitions to ready when retry succeeds after initial failure', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockRejectedValueOnce(new Error('Boot failed'))

      render(
        <BootGate>
          <p>App content</p>
        </BootGate>,
      )

      await waitFor(() => {
        expect(screen.getByText('Boot failed')).toBeInTheDocument()
      })

      mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })
      await user.click(screen.getByRole('button', { name: /Retry/i }))

      await waitFor(() => {
        expect(screen.getByText('App content')).toBeInTheDocument()
      })
      expect(screen.queryByText('Failed to start')).not.toBeInTheDocument()
      expect(screen.queryByText('Boot failed')).not.toBeInTheDocument()
    })

    it('has no a11y violations when invoke rejection produces error state', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('Backend unavailable'))

      const { container } = render(
        <BootGate>
          <p>App content</p>
        </BootGate>,
      )

      await waitFor(() => {
        expect(screen.getByText('Failed to start')).toBeInTheDocument()
      })

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
