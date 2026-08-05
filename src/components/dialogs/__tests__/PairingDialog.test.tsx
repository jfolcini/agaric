/**
 * Tests for PairingDialog component.
 *
 * #3463 — the dialog's first state is a role choice (host vs. joiner);
 * opening it fires zero backend commands, and the host/joiner UI is
 * mutually exclusive. Most tests below therefore select a role
 * (`selectHostRole` / `selectJoinerRole`) before asserting on
 * role-specific UI.
 *
 * Validates:
 *  - Opening the dialog fires no backend command; role choice is exclusive
 *  - Only the host path calls startPairing; only the joiner path calls confirmPairing
 *  - Shows QR code / passphrase when the host starts a session
 *  - Shows 4 word input fields on the joiner path
 *  - Pair button calls confirmPairing with entered words
 *  - Cancel (joiner) / Back (host) close/exit without an unstarted cancelPairing call
 *  - Shows paired devices list
 *  - Unpair button calls deletePeerRef
 *  - Paste support distributes words across inputs
 *  - Space auto-advances focus
 *  - Enter submits pairing
 *  - Retry button re-initializes on error
 *  - Countdown timer and session expiry (host)
 *  - Responsive grid classes
 *  - Error messages include backend text
 */

import { invoke } from '@tauri-apps/api/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PairingDialog } from '@/components/dialogs/PairingDialog'
import { useIsMobile } from '@/hooks/useIsMobile'
import { announce } from '@/lib/announcer'

// The dialog swaps to a bottom Sheet via `useDialogOrSheet` (#2665) when
// `useIsMobile()` is true. Mock the hook so each test can pin the
// viewport-state boolean.
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

// Mock react-qr-code — no longer used by the component, but keep mock to avoid import errors
vi.mock('react-qr-code', () => ({
  default: ({ value, ...props }: { value: string; [key: string]: unknown }) => (
    <div data-testid="pairing-qr-code-legacy" data-value={value} {...props} />
  ),
}))

// Capture announce() calls from the SR threshold effect
vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
}))

// Suppress the component's internal logger.warn/error calls (e.g. a failed
// cancelPairing-on-close) so test output stays clean. Nothing in this file
// asserts on the logger directly.
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// #1076: the component now also calls `useSyncStore.getState().setPeers`
// to mirror the dialog's local peer list into the shared store. The mock
// must expose `getState` in addition to the selector-call form. Hoisted
// so the same state object is reachable from the (also-hoisted) factory.
const { mockSyncStoreState } = vi.hoisted(() => ({
  mockSyncStoreState: {
    state: 'idle',
    error: null,
    peers: [],
    lastSyncedAt: null,
    opsReceived: 0,
    opsSent: 0,
    setState: vi.fn(),
    setPeers: vi.fn(),
    updateLastSynced: vi.fn(),
    incrementOpsReceived: vi.fn(),
    incrementOpsSent: vi.fn(),
    reset: vi.fn(),
  },
}))

vi.mock('@/stores/sync', () => {
  const useSyncStore = (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockSyncStoreState)
  useSyncStore.getState = () => mockSyncStoreState
  return { useSyncStore }
})

const mockedInvoke = vi.mocked(invoke)
const mockedUseIsMobile = vi.mocked(useIsMobile)

const mockPairingInfo = {
  passphrase: 'alpha bravo charlie delta',
  qr_svg: '<svg data-testid="backend-qr"><rect/></svg>',
}

const mockPeers = [
  {
    peer_id: 'peer-abc-1234567890',
    last_hash: 'hash1',
    last_sent_hash: null,
    synced_at: Date.now() - 5 * 60 * 1000,
    reset_count: 0,
    last_reset_at: null,
    cert_hash: null,
    device_name: null,
  },
  {
    peer_id: 'peer-def-0987654321',
    last_hash: null,
    last_sent_hash: null,
    synced_at: null,
    reset_count: 2,
    last_reset_at: 1735689600000, // 2025-01-01T00:00:00Z
    cert_hash: null,
    device_name: null,
  },
]

function mockInvokeByCommand(commands: Record<string, unknown>) {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd in commands) return commands[cmd]
    return undefined
  })
}

// #3463 — the dialog's first state is a role choice. These two helpers
// click past it; tests that assert on host-only or joiner-only UI use the
// matching one. Deliberately NOT clicked automatically on render, so every
// test that reaches a role screen visibly opts in — makes it obvious in
// each test body which device's flow is under test.
async function selectHostRole(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Show code on this device/i }))
}

async function selectJoinerRole(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Enter code from other device/i }))
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default to the desktop path so existing test bodies keep their semantics.
  mockedUseIsMobile.mockReturnValue(false)
})

describe('PairingDialog', () => {
  it('renders without crashing when closed', () => {
    render(<PairingDialog open={false} onOpenChange={vi.fn()} />)
    // Should render nothing visible
    expect(screen.queryByText('Pair Device')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // #3463 — role split: the dialog's first state, and the constraints that
  // make "both roles at once" (the original bug) unrepresentable.
  // -----------------------------------------------------------------------
  describe('#3463 role split', () => {
    it('renders the role chooser on open and fires no backend command at all', async () => {
      render(<PairingDialog open onOpenChange={vi.fn()} />)

      expect(await screen.findByText('Pair Device')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Show code on this device/i })).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: /Enter code from other device/i }),
      ).toBeInTheDocument()

      // Opening must have zero backend side effects.
      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('choosing the host role calls startPairing exactly once', async () => {
      const user = userEvent.setup()
      mockInvokeByCommand({ start_pairing: mockPairingInfo, list_peer_refs: [] })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await selectHostRole(user)
      await screen.findByText('alpha bravo charlie delta')

      const startPairingCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'start_pairing')
      expect(startPairingCalls).toHaveLength(1)
    })

    it('role choice is exclusive: the joiner path never reaches the QR display without going Back', async () => {
      const user = userEvent.setup()
      mockInvokeByCommand({ list_peer_refs: [] })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await selectJoinerRole(user)

      // Entry form is visible; host-only QR UI and the chooser's own
      // buttons are not — role is a single value, not two booleans, so
      // there is no state combination that shows both.
      expect(await screen.findByLabelText('Passphrase word 1')).toBeInTheDocument()
      expect(screen.queryByTestId('pairing-qr-code')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /Show code on this device/i }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /Enter code from other device/i }),
      ).not.toBeInTheDocument()

      // Going back is the ONLY way to reach the host view from here.
      await user.click(screen.getByRole('button', { name: /^Back$/i }))
      expect(
        await screen.findByRole('button', { name: /Show code on this device/i }),
      ).toBeInTheDocument()
      expect(screen.queryByLabelText('Passphrase word 1')).not.toBeInTheDocument()
    })

    it('has no a11y violations on the role chooser', async () => {
      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('Pair Device')

      const results = await axe(document.body)
      expect(results).toHaveNoViolations()
    })
  })

  it('shows QR code when the host starts a session (backend SVG)', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    // The QR is rendered via dangerouslySetInnerHTML with the backend SVG
    const qr = await screen.findByTestId('pairing-qr-code')
    expect(qr).toBeInTheDocument()
    // Backend SVG should be injected as innerHTML
    expect(qr.innerHTML).toContain('<svg')
    expect(qr.innerHTML).toContain('backend-qr')
  })

  it('shows passphrase when the host starts a session', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    expect(await screen.findByText('alpha bravo charlie delta')).toBeInTheDocument()
  })

  it('shows 4 word input fields on the joiner path', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)

    await screen.findByLabelText('Passphrase word 1')

    const inputs = screen.getAllByRole('textbox')
    // 4 word inputs
    expect(inputs.length).toBe(4)

    // Check aria-labels
    expect(screen.getByLabelText('Passphrase word 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 2')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 3')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 4')).toBeInTheDocument()
  })

  it('(#3463) joiner path submits the typed passphrase via confirmPairing; startPairing is never called', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
      confirm_pairing: undefined,
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const inputs = screen.getAllByRole('textbox')
    await user.type(inputs[0] as HTMLElement, 'echo')
    await user.type(inputs[1] as HTMLElement, 'foxtrot')
    await user.type(inputs[2] as HTMLElement, 'golf')
    await user.type(inputs[3] as HTMLElement, 'hotel')

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    await user.click(pairBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('confirm_pairing', {
        passphrase: 'echo foxtrot golf hotel',
        remoteDeviceId: '',
      })
    })
    // `start_pairing` is not stubbed above — if the joiner path ever called
    // it, the strict IPC stub (#3225) would reject it and this assertion
    // would fail via the resulting error banner / unexpected call record.
    expect(mockedInvoke).not.toHaveBeenCalledWith('start_pairing')
  })

  it('Pair button is disabled when words are empty', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    expect(pairBtn).toBeDisabled()
  })

  // -----------------------------------------------------------------------
  // #3463 — replaces the old single "Cancel button calls cancelPairing and
  // closes dialog" test. That test encoded the pre-fix assumption that
  // there is only one Cancel affordance and it always has a session to
  // cancel — true only because host and joiner UI used to render together.
  // Now: Cancel lives on the joiner screen, which never starts a session
  // (so cancelPairing must NOT fire); Back lives on the host screen, which
  // does (so it must).
  // -----------------------------------------------------------------------
  it('Cancel button on the joiner path closes the dialog without calling cancelPairing (no session was ever started)', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mockInvokeByCommand({ list_peer_refs: [] })

    render(<PairingDialog open onOpenChange={onOpenChange} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const cancelBtn = screen.getByRole('button', { name: /^Cancel$/i })
    await user.click(cancelBtn)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mockedInvoke).not.toHaveBeenCalledWith('cancel_pairing')
  })

  it('Back button on the host path cancels the started session and returns to the chooser', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)
    await screen.findByText('alpha bravo charlie delta')

    await user.click(screen.getByRole('button', { name: /^Back$/i }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
    })
    expect(
      await screen.findByRole('button', { name: /Show code on this device/i }),
    ).toBeInTheDocument()
  })

  it('shows paired devices list', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: mockPeers,
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    // Wait for loading to finish
    await screen.findByText('Paired Devices')

    // Check peer IDs are shown
    expect(await screen.findByText('peer-abc-1234567890')).toBeInTheDocument()
    expect(screen.getByText('peer-def-0987654321')).toBeInTheDocument()

    // "Never synced" for the second peer (inside "Last: Never synced")
    expect(screen.getByText(/Never synced/)).toBeInTheDocument()
  })

  it('shows no paired devices message when empty', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    expect(await screen.findByText('No paired devices yet.')).toBeInTheDocument()
  })

  it('Unpair button calls deletePeerRef after confirmation', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: mockPeers,
      delete_peer_ref: undefined,
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    // Wait for peers to show
    await screen.findByText('peer-abc-1234567890')

    // Click first Unpair button
    const unpairBtns = screen.getAllByRole('button', { name: /Unpair/i })
    await user.click(unpairBtns[0] as HTMLElement)

    // Confirmation dialog appears
    expect(screen.getByText('Unpair device?')).toBeInTheDocument()

    // Confirm
    const yesBtn = screen.getByRole('button', { name: /Yes, unpair/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_peer_ref', {
        peerId: 'peer-abc-1234567890',
      })
    })

    // Peer should be removed from list
    await waitFor(() => {
      expect(screen.queryByText('peer-abc-1234567890')).not.toBeInTheDocument()
    })
  })

  it('shows error with backend message when startPairing fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') throw new Error('network error')
      if (cmd === 'list_peer_refs') return []
      return undefined
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    // Error text includes the backend error message
    const errorEl = await screen.findByRole('alert')
    expect(errorEl).toHaveTextContent(/Failed to start pairing:.*network error/i)
  })

  it('shows error with backend message when confirmPairing fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_peer_refs') return []
      if (cmd === 'confirm_pairing') throw new Error('invalid passphrase')
      return undefined
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const inputs = screen.getAllByRole('textbox')
    await user.type(inputs[0] as HTMLElement, 'echo')
    await user.type(inputs[1] as HTMLElement, 'foxtrot')
    await user.type(inputs[2] as HTMLElement, 'golf')
    await user.type(inputs[3] as HTMLElement, 'hotel')

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    await user.click(pairBtn)

    const errorEl = await screen.findByRole('alert')
    expect(errorEl).toHaveTextContent(/Pairing failed:.*invalid passphrase/i)
  })

  it('shows loading state while the host is initializing', async () => {
    const user = userEvent.setup()
    // Make start_pairing hang
    mockedInvoke.mockImplementation(() => new Promise(() => {})) // never resolves

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /Show code on this device/i }))

    await waitFor(() => {
      const loadingEl = document.querySelector('.pairing-loading')
      expect(loadingEl).toBeTruthy()
      expect(loadingEl?.textContent).toContain('Starting pairing...')
      // #2852 — a shaped LoadingSkeleton placeholder replaces the bare
      // centered spinner; the "starting" label text is preserved.
      expect(loadingEl?.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
      expect(loadingEl?.querySelector('[data-slot="spinner"]')).toBeFalsy()
    })
  })

  it('has no a11y violations on the host path with pairing info', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    // Wait for content to load
    await screen.findByText('alpha bravo charlie delta')

    const results = await axe(document.body)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations on the joiner path', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const results = await axe(document.body)
    expect(results).toHaveNoViolations()
  })

  it('calls cancelPairing when the dialog closes via onOpenChange(false) on the host path', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    const { rerender } = render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    // Wait for pairing to start
    await screen.findByText('alpha bravo charlie delta')

    // Simulate parent closing the dialog
    rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)

    // cancelPairing should be called by the cleanup effect
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
    })
  })

  it('calls cancelPairing on unmount on the host path', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    // Wait for pairing to start
    await screen.findByText('alpha bravo charlie delta')

    // Unmount the component
    cleanup()

    // cancelPairing should be called by the cleanup effect
    expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
  })

  it('does not call cancelPairing on unmount on the joiner path (no session was ever started)', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    cleanup()

    expect(mockedInvoke).not.toHaveBeenCalledWith('cancel_pairing')
  })

  it('dialog has aria-labelledby pointing to the title', async () => {
    render(<PairingDialog open onOpenChange={vi.fn()} />)

    await screen.findByText('Pair Device')

    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()

    // Radix Dialog auto-links aria-labelledby to DialogTitle
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    const titleEl = document.getElementById(labelledBy as string)
    expect(titleEl?.textContent).toBe('Pair Device')
  })

  // -----------------------------------------------------------------------
  // New tests for issues #279, #282, #294, #295 — all on the joiner path
  // (word inputs) unless noted, since that's where the entry form lives.
  // -----------------------------------------------------------------------

  it('distributes pasted multi-word text across inputs (#279 paste)', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[]

    // Simulate pasting "echo foxtrot golf hotel" into the first input
    // userEvent.paste triggers onChange with the full text
    await user.click(inputs[0] as HTMLElement)
    await user.paste('echo foxtrot golf hotel')

    await waitFor(() => {
      expect(inputs[0] as HTMLElement).toHaveValue('echo')
      expect(inputs[1] as HTMLElement).toHaveValue('foxtrot')
      expect(inputs[2] as HTMLElement).toHaveValue('golf')
      expect(inputs[3] as HTMLElement).toHaveValue('hotel')
    })
  })

  it('Space key auto-advances focus to next input (#279 space)', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const inputs = screen.getAllByRole('textbox')

    // Type a word in the first input
    await user.click(inputs[0] as HTMLElement)
    await user.type(inputs[0] as HTMLElement, 'echo', { skipClick: true })

    // Fire Space keydown directly on the focused input
    fireEvent.keyDown(inputs[0] as HTMLElement, { key: ' ' })

    // Focus should be on the second input
    await waitFor(() => {
      expect(document.activeElement).toBe(inputs[1] as HTMLElement)
    })
  })

  it('Enter key submits when all words filled (#279 enter)', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
      confirm_pairing: undefined,
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const inputs = screen.getAllByRole('textbox')
    await user.type(inputs[0] as HTMLElement, 'echo')
    await user.type(inputs[1] as HTMLElement, 'foxtrot')
    await user.type(inputs[2] as HTMLElement, 'golf')
    await user.type(inputs[3] as HTMLElement, 'hotel')

    // Press Enter on the last input
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('confirm_pairing', {
        passphrase: 'echo foxtrot golf hotel',
        remoteDeviceId: '',
      })
    })
  })

  it('shows Retry button on error and clicking it calls startPairing again (#282)', async () => {
    const user = userEvent.setup()
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') {
        callCount++
        if (callCount === 1) throw new Error('network error')
        return mockPairingInfo
      }
      if (cmd === 'list_peer_refs') return []
      if (cmd === 'cancel_pairing') return undefined
      return undefined
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    // Wait for error to appear
    const errorEl = await screen.findByRole('alert')
    expect(errorEl).toHaveTextContent(/network error/i)

    // Retry button should be visible
    const retryBtn = screen.getByRole('button', { name: /Retry/i })
    expect(retryBtn).toBeInTheDocument()

    // Click retry — should call startPairing again
    await user.click(retryBtn)

    await waitFor(() => {
      expect(callCount).toBe(2)
    })

    // After successful retry, pairing info should be shown
    await waitFor(() => {
      expect(screen.getByText('alpha bravo charlie delta')).toBeInTheDocument()
    })
  })

  it('shows countdown timer and session expired text on the host path (#294)', async () => {
    vi.useFakeTimers()
    try {
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        cancel_pairing: undefined,
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      // fireEvent, not userEvent — userEvent's internal artificial delays
      // (even with `advanceTimers` wired to the fake clock) deadlock against
      // vi.useFakeTimers() here: awaiting `user.click()` never resolves, and
      // every test after this one in file order then hangs to its own 20s
      // timeout because fake timers are still active (bit us during
      // development). fireEvent dispatches synchronously with no internal
      // timer of its own, so it doesn't have this problem.
      fireEvent.click(screen.getByRole('button', { name: /Show code on this device/i }))

      // Wait for pairing info to load — use real microtasks for promises
      await act(async () => {
        // Flush pending microtasks (promises from init)
        await vi.runAllTimersAsync()
      })

      // After loading, countdown should appear (starts at 5:00)
      expect(screen.getByText(/Session expires in 5:00/)).toBeInTheDocument()

      // Advance 10 seconds
      await act(async () => {
        vi.advanceTimersByTime(10_000)
      })

      expect(screen.getByText(/Session expires in 4:50/)).toBeInTheDocument()

      // Advance to expiry (remaining ~290 seconds)
      await act(async () => {
        vi.advanceTimersByTime(290_000)
      })

      // Should show "Session expired"
      expect(screen.getByText('Session expired')).toBeInTheDocument()

      // #3463 — the host screen never renders a Pair button (only the
      // joiner's entry form does, and the joiner has no local countdown to
      // expire — see the "isExpired={false} on the joiner" note in
      // PairingDialog.tsx). The old combined-screen test asserted a
      // Pair-button-disabled-on-expiry here; that assertion no longer applies
      // to any screen this component renders.
      expect(screen.queryByRole('button', { name: /^Pair$/i })).not.toBeInTheDocument()
    } finally {
      // Always restore real timers, even on assertion failure — leaving fake
      // timers active leaks into every later test in this file and makes
      // them hang until their own 20s timeout (bit us during development).
      vi.useRealTimers()
    }
  })

  it('word inputs container has responsive grid classes (#295)', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const grid = document.querySelector('.pairing-word-inputs')
    expect(grid).toBeTruthy()
    expect(grid?.classList.contains('grid-cols-2')).toBe(true)
    expect(grid?.classList.contains('sm:grid-cols-4')).toBe(true)
  })

  it('returns focus to triggerRef on cancel (#288)', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const triggerRef = { current: document.createElement('button') }
    document.body.append(triggerRef.current)
    triggerRef.current.textContent = 'Open Pairing'
    const focusSpy = vi.spyOn(triggerRef.current, 'focus')

    mockInvokeByCommand({
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={onOpenChange} triggerRef={triggerRef} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const cancelBtn = screen.getByRole('button', { name: /^Cancel$/i })
    await user.click(cancelBtn)

    await waitFor(() => {
      expect(focusSpy).toHaveBeenCalledTimes(1)
    })

    document.body.removeChild(triggerRef.current)
  })

  it('shows success toast after pairing (#436)', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mockInvokeByCommand({
      list_peer_refs: [],
      confirm_pairing: undefined,
    })

    render(<PairingDialog open onOpenChange={onOpenChange} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const inputs = screen.getAllByRole('textbox')
    await user.type(inputs[0] as HTMLElement, 'echo')
    await user.type(inputs[1] as HTMLElement, 'foxtrot')
    await user.type(inputs[2] as HTMLElement, 'golf')
    await user.type(inputs[3] as HTMLElement, 'hotel')

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    await user.click(pairBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Device paired successfully')
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows Retry button when the host session expires and focuses it (#420, #430)', async () => {
    vi.useFakeTimers()
    try {
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        cancel_pairing: undefined,
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      // fireEvent, not userEvent — see the (#294) test above for why
      // userEvent.click() deadlocks under fake timers here.
      fireEvent.click(screen.getByRole('button', { name: /Show code on this device/i }))

      // Wait for pairing info to load
      await act(async () => {
        await vi.runAllTimersAsync()
      })

      expect(screen.getByText('alpha bravo charlie delta')).toBeInTheDocument()

      // Advance past the full 300-second timeout
      await act(async () => {
        vi.advanceTimersByTime(301_000)
      })

      // #420: Retry button should appear in the expiry section
      expect(screen.getByText('Session expired')).toBeInTheDocument()
      const retryBtn = screen.getByRole('button', { name: /Retry/i })
      expect(retryBtn).toBeInTheDocument()

      // #430: Focus should have moved to the Retry button
      expect(document.activeElement).toBe(retryBtn)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dialog body renders the DialogBody primitive so a tall dialog scrolls instead of clipping', async () => {
    // DialogBody owns the
    // scrollable region (flex-1 min-h-0 + ScrollArea); the frame stays
    // overflow-hidden via the DialogContent base so header/footer remain pinned.
    // The role chooser alone (no backend mocks needed) already exercises
    // this — Body wraps the chooser content the same as it wraps the
    // host/joiner content.
    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await waitFor(() => {
      const dialog = document.querySelector('.pairing-dialog')
      expect(dialog).toBeInTheDocument()
      const body = dialog?.querySelector('[data-slot="dialog-body"]')
      expect(body).toBeInTheDocument()
      expect(body?.className).toContain('flex-1')
      expect(body?.className).toContain('min-h-0')
    })
  })

  // -----------------------------------------------------------------------
  // Error path tests for all invoke calls (#T-6)
  // -----------------------------------------------------------------------

  it('shows error when listPeerRefs fails during host init', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') return mockPairingInfo
      if (cmd === 'list_peer_refs') throw new Error('db connection lost')
      return undefined
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    const errorEl = await screen.findByRole('alert')
    expect(errorEl).toHaveTextContent(/Failed to start pairing:.*db connection lost/i)
  })

  it('shows error when deletePeerRef fails during unpair', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') return mockPairingInfo
      if (cmd === 'list_peer_refs') return mockPeers
      if (cmd === 'delete_peer_ref') throw new Error('peer not found')
      return undefined
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)
    await screen.findByText('peer-abc-1234567890')

    const unpairBtns = screen.getAllByRole('button', { name: /Unpair/i })
    await user.click(unpairBtns[0] as HTMLElement)

    // Confirmation dialog appears
    expect(screen.getByText('Unpair device?')).toBeInTheDocument()

    const yesBtn = screen.getByRole('button', { name: /Yes, unpair/i })
    await user.click(yesBtn)

    const errorEl = await screen.findByRole('alert')
    expect(errorEl).toHaveTextContent(/Failed to unpair device:.*peer not found/i)

    // Peer should still be in the list (not removed on failure)
    expect(screen.getByText('peer-abc-1234567890')).toBeInTheDocument()
  })

  it('shows error when listPeerRefs fails after successful confirmPairing', async () => {
    const user = userEvent.setup()
    let listCallCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_peer_refs') {
        listCallCount++
        if (listCallCount === 1) return [] // initial (joiner) load succeeds
        throw new Error('refresh failed') // post-pair refresh fails
      }
      if (cmd === 'confirm_pairing') return undefined
      return undefined
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const inputs = screen.getAllByRole('textbox')
    await user.type(inputs[0] as HTMLElement, 'echo')
    await user.type(inputs[1] as HTMLElement, 'foxtrot')
    await user.type(inputs[2] as HTMLElement, 'golf')
    await user.type(inputs[3] as HTMLElement, 'hotel')

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    await user.click(pairBtn)

    const errorEl = await screen.findByRole('alert')
    expect(errorEl).toHaveTextContent(/Pairing failed:.*refresh failed/i)
  })

  it('shows toast error when cancelPairing fails on host dialog close', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') return mockPairingInfo
      if (cmd === 'list_peer_refs') return []
      if (cmd === 'cancel_pairing') throw new Error('cancel failed')
      return undefined
    })

    const { rerender } = render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)
    await screen.findByText('alpha bravo charlie delta')

    // Close the dialog — triggers useEffect cleanup which calls cancelPairing()
    rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to cancel pairing')
    })
  })

  it('moves focus to Retry button when startPairing errors (#430)', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') throw new Error('network error')
      if (cmd === 'list_peer_refs') return []
      return undefined
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectHostRole(user)

    // Wait for error to appear
    const errorEl = await screen.findByRole('alert')
    expect(errorEl).toHaveTextContent(/network error/i)

    const retryBtn = screen.getByRole('button', { name: /Retry/i })
    expect(document.activeElement).toBe(retryBtn)
  })

  // ------------------------------------------------------------------------
  // Paste-focus setTimeout must be cleared on unmount so the
  // scheduled callback never runs against a detached DOM.
  // ------------------------------------------------------------------------
  it('does not throw if unmounted between paste-focus setTimeout and fire (#)', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
    })

    const { unmount } = render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[]

    // Switch to fake timers only AFTER async init has completed. This
    // prevents waitFor/findBy deadlocks under fake timers.
    vi.useFakeTimers()
    try {
      // Trigger the paste code path — simulate multi-word change on the
      // first input. This schedules the focus setTimeout.
      fireEvent.change(inputs[0] as HTMLElement, {
        target: { value: 'echo foxtrot golf hotel' },
      })

      // Unmount before the 0ms timer fires.
      unmount()

      // Advancing timers after unmount must not throw — the cleanup effect
      // cleared the pending handle, so the focus callback is never invoked
      // on a detached DOM node.
      expect(() => vi.advanceTimersByTime(10)).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  // -----------------------------------------------------------------------
  // Countdown SR-only announcer thresholds (60s / 30s / 10s / expired) —
  // host path (only screen with a countdown).
  // -----------------------------------------------------------------------
  it('announces countdown only at SR-relevant thresholds', async () => {
    vi.useFakeTimers()
    try {
      const announceMock = vi.mocked(announce)
      announceMock.mockClear()

      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        cancel_pairing: undefined,
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      // fireEvent, not userEvent — see the (#294) test above for why
      // userEvent.click() deadlocks under fake timers here.
      fireEvent.click(screen.getByRole('button', { name: /Show code on this device/i }))

      // Flush init promises
      await act(async () => {
        await vi.runAllTimersAsync()
      })

      // Advance from 300 → 60 (240 seconds) — should announce "1 minute"
      await act(async () => {
        vi.advanceTimersByTime(240_000)
      })
      expect(announceMock).toHaveBeenCalledWith('Pairing session expires in 1 minute')

      // Advance to 30s mark
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })
      expect(announceMock).toHaveBeenCalledWith('Pairing session expires in 30 seconds')

      // Advance to 10s mark
      await act(async () => {
        vi.advanceTimersByTime(20_000)
      })
      expect(announceMock).toHaveBeenCalledWith('Pairing session expires in 10 seconds')

      // Advance to expiry
      await act(async () => {
        vi.advanceTimersByTime(10_000)
      })
      expect(announceMock).toHaveBeenCalledWith('Pairing session expired')

      // The threshold effect must not fire on every tick — there are exactly
      // 4 announcement points across the 5-minute countdown.
      expect(announceMock).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  // -----------------------------------------------------------------------
  // Mid-pair close guard — confirm before aborting an in-flight pairing.
  // `pairLoading` is only ever true during the joiner's `confirmPairing`
  // call (the host never calls it), so this scenario only exists on the
  // joiner path.
  // -----------------------------------------------------------------------
  it('shows close-guard ConfirmDialog when Esc is pressed mid-pair', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    // Make confirm_pairing hang so the dialog stays in pairLoading state
    let resolveConfirm: (value: unknown) => void = () => {}
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_peer_refs') return []
      if (cmd === 'confirm_pairing') {
        return new Promise((resolve) => {
          resolveConfirm = resolve
        })
      }
      return undefined
    })

    render(<PairingDialog open onOpenChange={onOpenChange} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const inputs = screen.getAllByRole('textbox')
    await user.type(inputs[0] as HTMLElement, 'echo')
    await user.type(inputs[1] as HTMLElement, 'foxtrot')
    await user.type(inputs[2] as HTMLElement, 'golf')
    await user.type(inputs[3] as HTMLElement, 'hotel')

    // Click Pair, then while it hangs, attempt to close via Esc
    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    await user.click(pairBtn)

    // Wait for confirm_pairing to be in flight
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('confirm_pairing', expect.any(Object))
    })

    // Press Escape on the dialog — should NOT close immediately, instead
    // should show the close-guard ConfirmDialog.
    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.getByText('Cancel pairing?')).toBeInTheDocument()
    })

    // Parent onOpenChange must not have been called yet — the guard intercepted.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    // Confirm guard exposes both keep-pairing and cancel-pairing actions.
    expect(screen.getByRole('button', { name: /Keep pairing/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Cancel pairing$/i })).toBeInTheDocument()

    // Click "Cancel pairing" — should close the dialog. #3463: the joiner
    // never started a session (never called startPairing), so — unlike the
    // pre-fix version of this test — cancelPairing must NOT be called here.
    await user.click(screen.getByRole('button', { name: /^Cancel pairing$/i }))

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('cancel_pairing')

    // Resolve hung promise so test cleanup runs
    resolveConfirm(undefined)
  })

  it('closes immediately without guard when not mid-pair', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
    })

    const onOpenChange = vi.fn()
    render(<PairingDialog open onOpenChange={onOpenChange} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    // Press Escape (or any close vector) without an in-flight pairing.
    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    // No close-guard dialog should appear.
    expect(screen.queryByText('Cancel pairing?')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // #3463 — the countdown-pause-while-typing mechanism (handleTypingState-
  // Change / pausedByTyping) used to be exercised by pausing the SAME
  // dialog's countdown while typing in the SAME dialog's passphrase
  // inputs. That scenario is now impossible to reproduce through the UI:
  // the countdown only ever renders on the host screen, and the passphrase
  // inputs only ever render on the joiner screen, and those two screens
  // are mutually exclusive by construction (that mutual exclusion is this
  // fix). The five tests that used to cover pause / resume / auto-resume /
  // the "Paused while typing…" indicator / the pause-resume SR announcements
  // have been removed and replaced with a single test asserting the
  // (now effectively dead) wiring is harmless on the joiner screen. See the
  // PR description for the full justification.
  // -----------------------------------------------------------------------
  it('typing in the joiner passphrase field is harmless (no countdown exists on the joiner screen to pause)', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      list_peer_refs: [],
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const inputs = screen.getAllByRole('textbox')
    expect(() =>
      fireEvent.change(inputs[0] as HTMLElement, { target: { value: 'a' } }),
    ).not.toThrow()

    expect(screen.queryByText(/Session expires in/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Paused while typing/i)).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // #2058: error/recovery copy must come from i18n (t()), not hardcoded
  // English literals. Assert each setError() path resolves through its
  // translation key (the resolved English matches the key template).
  // -----------------------------------------------------------------------
  describe('#2058 i18n recovery path', () => {
    it('surfaces pairing.startFailed (interpolated) on startPairing failure', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing') throw new Error('network error')
        if (cmd === 'list_peer_refs') return []
        return undefined
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await selectHostRole(user)

      const errorEl = await screen.findByRole('alert')
      // matches t('pairing.startFailed', { message: 'network error' })
      expect(errorEl).toHaveTextContent('Failed to start pairing: network error')
    })

    it('surfaces pairing.pairFailed (interpolated) on confirmPairing failure', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_peer_refs') return []
        if (cmd === 'confirm_pairing') throw new Error('invalid passphrase')
        return undefined
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await selectJoinerRole(user)
      await screen.findByLabelText('Passphrase word 1')

      const inputs = screen.getAllByRole('textbox')
      await user.type(inputs[0] as HTMLElement, 'echo')
      await user.type(inputs[1] as HTMLElement, 'foxtrot')
      await user.type(inputs[2] as HTMLElement, 'golf')
      await user.type(inputs[3] as HTMLElement, 'hotel')
      await user.click(screen.getByRole('button', { name: /^Pair$/i }))

      const errorEl = await screen.findByRole('alert')
      // matches t('pairing.pairFailed', { message: 'invalid passphrase' })
      expect(errorEl).toHaveTextContent('Pairing failed: invalid passphrase')
    })

    it('surfaces pairing.unpairFailed (interpolated) on deletePeerRef failure', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing') return mockPairingInfo
        if (cmd === 'list_peer_refs') return mockPeers
        if (cmd === 'delete_peer_ref') throw new Error('peer not found')
        return undefined
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await selectHostRole(user)
      await screen.findByText('peer-abc-1234567890')

      await user.click(screen.getAllByRole('button', { name: /Unpair/i })[0] as HTMLElement)
      await user.click(screen.getByRole('button', { name: /Yes, unpair/i }))

      const errorEl = await screen.findByRole('alert')
      // matches t('pairing.unpairFailed', { message: 'peer not found' })
      expect(errorEl).toHaveTextContent('Failed to unpair device: peer not found')
    })

    it('renders the Retry button from pairing.retryButton (not a hardcoded literal)', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing') throw new Error('network error')
        if (cmd === 'list_peer_refs') return []
        return undefined
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await selectHostRole(user)

      await screen.findByRole('alert')
      const retryBtn = screen.getByRole('button', { name: /Retry/i })
      // t('pairing.retryButton') === 'Retry'
      expect(retryBtn).toHaveTextContent('Retry')
    })
  })

  // -----------------------------------------------------------------------
  // #2665 — the dialog mounts under both the desktop Dialog path and the
  // mobile Sheet path via useDialogOrSheet('dialog'). Pairing is a
  // phone-first flow, so this matters more here than for most dialogs.
  // Assert on body content (title + word inputs) being visible rather than
  // the Dialog / Sheet DOM specifics so the test stays decoupled from the
  // underlying primitive.
  // -----------------------------------------------------------------------
  describe('mobile / desktop responsive surfaces', () => {
    it('renders the host pairing view on the mobile Sheet path', async () => {
      const user = userEvent.setup()
      mockedUseIsMobile.mockReturnValue(true)
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)

      expect(await screen.findByText('Pair Device')).toBeInTheDocument()
      await selectHostRole(user)
      expect(await screen.findByText('alpha bravo charlie delta')).toBeInTheDocument()
    })

    it('renders the host pairing view on the desktop Dialog path', async () => {
      const user = userEvent.setup()
      mockedUseIsMobile.mockReturnValue(false)
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)

      expect(await screen.findByText('Pair Device')).toBeInTheDocument()
      await selectHostRole(user)
      expect(await screen.findByText('alpha bravo charlie delta')).toBeInTheDocument()
    })
  })
})
