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
})
