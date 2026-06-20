/**
 * Tests for BootGate component.
 *
 * startup-latency-backend Phase 2: the boot store's `invoke('list_blocks')`
 * handshake was removed; `boot()` now transitions `booting → ready`
 * synchronously. The `error` state surface is preserved (it can be
 * driven externally via `useBootStore.setState({ state: 'error', ... })`)
 * but no production path produces it today. Tests below split into:
 *  - happy path (mount → ready render)
 *  - externally-driven error render (Failed-to-start UI + a11y + retry +
 *    diagnostics)
 *
 * The old invoke-rejection error-path block was dropped because there is
 * no longer any async work inside `boot()` that could reject.
 */

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
  RefreshCw: (props: { className?: string }) => (
    <svg data-testid="refresh-cw-icon" className={props.className} />
  ),
}))

import { BootGate } from '@/components/pages/BootGate'
import { useBootStore } from '@/stores/boot'

/** No-op boot function to prevent the useEffect from transitioning state. */
const noopBoot = vi.fn(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  useBootStore.setState({ state: 'booting', error: null })
})

describe('BootGate', () => {
  it('calls boot() on mount and transitions to ready', async () => {
    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    // Phase-2 invariant: boot() is synchronous (no IPC). On mount the
    // effect fires, state goes booting → ready, children render.
    await waitFor(() => {
      expect(screen.getByText('App content')).toBeInTheDocument()
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

  it('renders Show details button in error state', () => {
    useBootStore.setState({ state: 'error', error: 'DB connection failed', boot: noopBoot })

    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    expect(screen.getByTestId('boot-show-details')).toBeInTheDocument()
    expect(screen.getByTestId('boot-show-details')).toHaveTextContent('Show details')
    // Diagnostics panel is hidden by default.
    expect(screen.queryByTestId('boot-diagnostics')).not.toBeInTheDocument()
  })

  it('clicking Show details expands a <pre> with the error text', async () => {
    const user = userEvent.setup()
    useBootStore.setState({ state: 'error', error: 'DB connection failed', boot: noopBoot })

    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    await user.click(screen.getByTestId('boot-show-details'))

    const panel = screen.getByTestId('boot-diagnostics')
    expect(panel).toBeInTheDocument()
    const pre = panel.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('Error: DB connection failed')
    // Diagnostic surface uses `ScrollArea` (not bare
    // `overflow-x-auto`) per AGENTS.md "ScrollArea for any scrollable
    // container". The viewport wraps the <pre> so long User-Agent
    // strings can scroll horizontally without leaking overflow into
    // the parent layout.
    expect(panel.querySelector('[data-slot="scroll-area-viewport"]')).not.toBeNull()
    expect(panel.querySelector('[data-slot="scroll-area-viewport"] pre')).toBe(pre)
    // Toggle label flips to Hide.
    expect(screen.getByTestId('boot-show-details')).toHaveTextContent('Hide details')
  })

  it('Copy diagnostics button calls navigator.clipboard.writeText', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    useBootStore.setState({ state: 'error', error: 'DB connection failed', boot: noopBoot })

    render(
      <BootGate>
        <p>App content</p>
      </BootGate>,
    )

    await user.click(screen.getByTestId('boot-show-details'))
    await user.click(screen.getByTestId('boot-copy-diagnostics'))

    expect(writeText).toHaveBeenCalledTimes(1)
    const payload = writeText.mock.calls[0]?.[0] ?? ''
    expect(payload).toContain('Error: DB connection failed')
    expect(payload).toContain('User-Agent:')
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
