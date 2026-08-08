/**
 * Tests for PairingDialog component.
 *
 * #3463 — the dialog opens directly on the host path (this device's own
 * code); there is no upfront role question. Opening it DOES fire a backend
 * command (`start_pairing`, once) because the host session starts
 * immediately. Switching to the joiner path (via the "Have a code from the
 * other device?" affordance on the host screen) is what DECLARES the joiner
 * role, and cancels the host's own session first. The host/joiner UI stays
 * mutually exclusive throughout. Most tests below use the
 * `selectHostRole` / `selectJoinerRole` helpers before asserting on
 * role-specific UI — `selectHostRole` is now a no-op (host is the default),
 * kept so existing call sites read the same way; `selectJoinerRole` clicks
 * the switch-to-joiner affordance.
 *
 * Validates:
 *  - Opening the dialog starts a host session exactly once; role choice is exclusive
 *  - Switching to the joiner path cancels the host session (#3463)
 *  - Only the host path calls startPairing; only the joiner path calls confirmPairing
 *  - Shows QR code / passphrase when the host starts a session
 *  - Shows 4 word input fields on the joiner path
 *  - Pair button calls confirmPairing with entered words
 *  - Cancel (joiner) closes without an extra cancelPairing call
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
// #3495 — `setState` must mirror the real reducer (`src/stores/sync.ts`:
// `set({ state, error: error ?? null })`), not be a bare no-op. A no-op
// can't exercise the stale-error-in-the-store regression at all: the
// component's `call` (PairingDialog.tsx) calls `syncSetState('idle')`
// synchronously right after `confirm_pairing` resolves, and it's THAT call
// clearing the store's `error` that keeps a stale rejection from failing a
// fresh wait. A no-op mock would silently pass tests regardless of whether
// the component actually clears the error.
const { mockSyncStoreState } = vi.hoisted(() => {
  const state = {
    state: 'idle',
    error: null as string | null,
    peers: [],
    lastSyncedAt: null,
    opsReceived: 0,
    opsSent: 0,
    setState: vi.fn((newState: string, error?: string | null) => {
      state.state = newState
      state.error = error ?? null
    }),
    setPeers: vi.fn(),
    updateLastSynced: vi.fn(),
    incrementOpsReceived: vi.fn(),
    incrementOpsSent: vi.fn(),
    reset: vi.fn(),
  }
  return { mockSyncStoreState: state }
})

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

// #3463 — the dialog opens directly on the host path; there is no upfront
// role question left to click past. `selectHostRole` is kept as a no-op so
// existing call sites don't need touching. `selectJoinerRole` clicks the
// affordance on the host screen that switches roles — choosing to enter a
// code is what DECLARES the joiner role. Both remain `async` so call sites
// stay `await selectXRole(user)` regardless of which one is used.
async function selectHostRole(_user: ReturnType<typeof userEvent.setup>) {
  // no-op: host is the default entry state, nothing to select.
}

async function selectJoinerRole(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole('button', { name: /Have a code from the other device\?/i }),
  )
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
    it('opening the dialog starts a host session exactly once', async () => {
      mockInvokeByCommand({ start_pairing: mockPairingInfo, list_peer_refs: [] })

      render(<PairingDialog open onOpenChange={vi.fn()} />)

      expect(await screen.findByText('Pair Device')).toBeInTheDocument()
      // Host screen renders immediately — no upfront role question.
      expect(await screen.findByText('alpha bravo charlie delta')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: /Have a code from the other device\?/i }),
      ).toBeInTheDocument()

      // #3463: unlike the old chooser (zero backend effects on open), the
      // host session now starts immediately — but only once.
      const startPairingCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'start_pairing')
      expect(startPairingCalls).toHaveLength(1)
    })

    it('role choice is exclusive: switching to the joiner path hides all host UI, and switching back hides all joiner UI', async () => {
      const user = userEvent.setup()
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        cancel_pairing: undefined,
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('alpha bravo charlie delta')

      await selectJoinerRole(user)

      // Entry form is visible; host-only QR UI is not — role is a single
      // value, not two booleans, so there is no state combination that
      // shows both.
      expect(await screen.findByLabelText('Passphrase word 1')).toBeInTheDocument()
      expect(screen.queryByTestId('pairing-qr-code')).not.toBeInTheDocument()
      expect(screen.queryByText('alpha bravo charlie delta')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /Have a code from the other device\?/i }),
      ).not.toBeInTheDocument()

      // Switching back to host is the only way to reach the QR view again
      // — and it is reachable, because the switch is reversible by design.
      await user.click(screen.getByRole('button', { name: /Show my code instead/i }))
      expect(await screen.findByText('alpha bravo charlie delta')).toBeInTheDocument()
      expect(screen.queryByLabelText('Passphrase word 1')).not.toBeInTheDocument()
    })

    // #3463: the required regression coverage for this change. Without this,
    // a device could simultaneously offer its own code (host) and enter
    // another's (joiner) — the exact #3463 shape wearing a different hat.
    // Switching to the joiner path must cancel the host's own session so it
    // stops offering a code it is no longer showing.
    it('switching to the joiner path cancels the host session', async () => {
      const user = userEvent.setup()
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        cancel_pairing: undefined,
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('alpha bravo charlie delta')
      expect(mockedInvoke).not.toHaveBeenCalledWith('cancel_pairing')

      await selectJoinerRole(user)
      await screen.findByLabelText('Passphrase word 1')

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
      })
      const cancelCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'cancel_pairing')
      expect(cancelCalls).toHaveLength(1)
    })

    it('has no a11y violations on the default host screen', async () => {
      mockInvokeByCommand({ start_pairing: mockPairingInfo, list_peer_refs: [] })
      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('alpha bravo charlie delta')

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

  it('(#3463) joiner path submits the typed passphrase via confirmPairing; startPairing fires once on open, never again on submit', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
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
    // #3463 (review): unlike the old chooser, opening the dialog now DOES
    // fire `start_pairing` once (the host session begins immediately — see
    // "opening the dialog starts a host session exactly once"). What must
    // still hold is that submitting the joiner form never calls it AGAIN —
    // confirming the passphrase goes through confirm_pairing only, it must
    // not re-trigger a host session.
    const startPairingCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'start_pairing')
    expect(startPairingCalls).toHaveLength(1)
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
  // #3463 (review) — replaces the old single "Cancel button calls
  // cancelPairing and closes dialog" test, and revises it again: opening
  // the dialog now starts a host session immediately (implicit-role
  // default), so by the time a user reaches the joiner screen via
  // selectJoinerRole, cancel_pairing has ALREADY fired once — that's the
  // required "switching to joiner cancels the host session" behavior,
  // covered by its own test below ("switching to the joiner path cancels
  // the host session"). What Cancel on the joiner screen itself must NOT do
  // is fire a SECOND cancel_pairing call: there is no live session left to
  // cancel at that point, only the dialog to close. The old "Back button"
  // test that used to live here (asserting a `/^Back$/i` button that no
  // longer exists) is superseded by the same required test.
  // -----------------------------------------------------------------------
  it('Cancel button on the joiner path closes the dialog without calling cancelPairing again (the host session was already cancelled by the role switch)', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open onOpenChange={onOpenChange} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    const cancelCallsAfterSwitch = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'cancel_pairing',
    ).length
    expect(cancelCallsAfterSwitch).toBe(1)

    const cancelBtn = screen.getByRole('button', { name: /^Cancel$/i })
    await user.click(cancelBtn)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    const cancelCallsAfterClick = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'cancel_pairing',
    ).length
    expect(cancelCallsAfterClick).toBe(1)
  })

  it('shows paired devices list on the default host screen without any role selection (#3463 review)', async () => {
    // #3463 (review): PairingPeersList used to live inside a
    // `role !== 'chooser'` branch, so it was gated behind the chooser.
    // With the chooser removed, it must be reachable on the default
    // (host) screen with zero clicks — deliberately not calling
    // `selectHostRole` here to prove that.
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: mockPeers,
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)

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
    // Make start_pairing hang
    mockedInvoke.mockImplementation(() => new Promise(() => {})) // never resolves

    // #3463 (review): the host session now starts automatically on mount —
    // there is no button to click to reach this loading state, it's the
    // very first thing rendered.
    render(<PairingDialog open onOpenChange={vi.fn()} />)

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

  it('does not call cancelPairing again on unmount on the joiner path (the host session was already cancelled by the role switch)', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open onOpenChange={vi.fn()} />)
    await selectJoinerRole(user)
    await screen.findByLabelText('Passphrase word 1')

    // #3463 (review): opening the dialog starts a host session, and
    // switching to the joiner cancels it — so by this point cancel_pairing
    // has ALREADY fired once. The unmount cleanup effect only owns the
    // *host's* session; on the joiner screen there is no live session left
    // for it to cancel a second time.
    const cancelCallsBeforeUnmount = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'cancel_pairing',
    ).length
    expect(cancelCallsBeforeUnmount).toBe(1)

    cleanup()

    const cancelCallsAfterUnmount = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'cancel_pairing',
    ).length
    expect(cancelCallsAfterUnmount).toBe(1)
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

      // #3463 (review): the host session now starts automatically on mount
      // — there is no button to click to reach it, so this test no longer
      // needs the fireEvent click that used to select the host role. The
      // fireEvent-vs-userEvent deadlock note above is now moot for this
      // specific click, but fireEvent is kept elsewhere in this test (the
      // countdown assertions) as the established fake-timer-safe pattern.
      render(<PairingDialog open onOpenChange={vi.fn()} />)

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

  // #3469 — `confirm_pairing` only arms this device's local proof; it does
  // NOT validate the passphrase against the peer, so the dialog cannot
  // claim success (or close) the instant it resolves. It must stay open in
  // an honest waiting state until the peer is actually observed. See the
  // dedicated `#3469 waiting/success/failure/timeout` describe block below
  // for the full resolution-path coverage (success/failure/timeout).
  it('stays open in a waiting state after submitting, and does not claim success (#436, #3463 review, #3469)', async () => {
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

    // #3469: the dialog enters the waiting state — it does NOT close and
    // does NOT toast a success claim it cannot back up.
    expect(await screen.findByTestId('pairing-waiting-state')).toBeInTheDocument()
    expect(screen.queryByLabelText('Passphrase word 1')).not.toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalledWith('Device paired successfully')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('shows Retry button when the host session expires and focuses it (#420, #430)', async () => {
    vi.useFakeTimers()
    try {
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        cancel_pairing: undefined,
      })

      // #3463 (review): the host session now starts automatically on
      // mount — no click needed to reach it.
      render(<PairingDialog open onOpenChange={vi.fn()} />)

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
    // #3463 (review): the default host screen alone (no backend mocks
    // needed — an unstubbed invoke resolves undefined, treated as success)
    // already exercises this — Body wraps the host content the same as it
    // wraps the joiner content.
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

  // #3469 — `executePair`'s `call` no longer fetches `list_peer_refs`
  // inline (that used to be the immediate post-confirm refresh this test
  // was written against). It now only calls `confirm_pairing`, then hands
  // off to the background poll for the TOFU-pin signal — so a transient
  // `list_peer_refs` failure DURING that poll must not surface as an error
  // banner or abort the wait; `usePollingQuery` swallows it and retries on
  // the next tick, with the TTL as the ultimate backstop (see the
  // `#3469 waiting/success/failure/timeout` describe block for that path).
  it('a transient listPeerRefs polling failure while waiting does not surface an error or leave the waiting state', async () => {
    const user = userEvent.setup()
    let listCallCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_peer_refs') {
        listCallCount++
        // First two calls are the host-mount/joiner-switch refreshes; the
        // third is the authoritative baseline snapshot taken the instant
        // the proof is armed. All three failing is the worst case — the
        // wait still starts, with an explicitly unknown baseline.
        if (listCallCount <= 3) throw new Error('transient db error')
        return []
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

    expect(await screen.findByTestId('pairing-waiting-state')).toBeInTheDocument()
    // #3495 — `toBeGreaterThanOrEqual(3)` was vacuous: that condition is
    // already true the instant `findByTestId` above resolves (per the
    // comment on `listCallCount <= 3`), so it never forced a later poll
    // tick to actually happen. Capture a baseline here and require the
    // count to move PAST it, which does force the wait to span a real
    // poll tick.
    const baselineListCallCount = listCallCount
    await waitFor(() => expect(listCallCount).toBeGreaterThan(baselineListCallCount))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('pairing-waiting-state')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // #3469 — the four resolution paths out of the waiting state: render/
  // announce, success (peer appears in peer_refs), failure (responder
  // rejects the proof), and timeout (TTL elapses with neither signal).
  // -----------------------------------------------------------------------
  describe('#3469 waiting/success/failure/timeout', () => {
    // Reaches the waiting state with userEvent under REAL timers — safe for
    // tests that don't need to control the poll/countdown intervals
    // afterward, since userEvent + fake timers can deadlock (house rule
    // above the paste-focus-unmount test).
    async function enterWaitingState(user: ReturnType<typeof userEvent.setup>) {
      await selectJoinerRole(user)
      await screen.findByLabelText('Passphrase word 1')

      const inputs = screen.getAllByRole('textbox')
      await user.type(inputs[0] as HTMLElement, 'echo')
      await user.type(inputs[1] as HTMLElement, 'foxtrot')
      await user.type(inputs[2] as HTMLElement, 'golf')
      await user.type(inputs[3] as HTMLElement, 'hotel')
      await user.click(screen.getByRole('button', { name: /^Pair$/i }))

      expect(await screen.findByTestId('pairing-waiting-state')).toBeInTheDocument()
    }

    // Reaches the waiting state via `fireEvent` under FAKE timers, for
    // tests that go on to advance the poll/countdown intervals. This is
    // NOT interchangeable with `enterWaitingState` above: `setInterval`
    // handles created while real timers are active stay bound to the real
    // clock even after a later `vi.useFakeTimers()` call — advancing fake
    // time then does nothing to them. The interval must be created while
    // fake timers are already active, which means the interactions that
    // create it (role switch, word entry, Pair click) must also happen
    // under fake timers — hence `fireEvent` (synchronous) instead of
    // `userEvent` (which deadlocks against `waitFor`/`findBy` under fake
    // timers, per the house rule above the paste-focus-unmount test) and
    // `flushMicrotasks()` in place of the `findBy*` queries
    // `enterWaitingState` uses.
    //
    // Deliberately does NOT use `vi.runAllTimersAsync()` for these
    // flushes (unlike the single initial flush in e.g. the host countdown
    // test): by the second/third flush a repeating `setInterval` (the
    // host countdown, then the joiner's poll + wait countdown) is already
    // active and never clears itself within the flush, so
    // `runAllTimersAsync` — which exhausts the timer queue until it's
    // empty — spins until Vitest's "10000 timers" infinite-loop guard
    // aborts it. `flushMicrotasks` only drains the native Promise
    // microtask queue (invoke() calls are plain resolved Promises, not
    // fake-timer-driven), which is all that's needed to let
    // confirmPairing/listPeerRefs settle without touching any interval.
    async function flushMicrotasks() {
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await Promise.resolve()
        })
      }
    }

    async function enterWaitingStateFake() {
      // Flush the host-mount init promises (start_pairing + list_peer_refs)
      // fired by the dialog-open effect.
      await flushMicrotasks()

      fireEvent.click(screen.getByRole('button', { name: /Have a code from the other device\?/i }))
      // Flush the joiner-switch's cancelPairing + listPeerRefs refresh.
      await flushMicrotasks()

      const inputs = screen.getAllByRole('textbox')
      fireEvent.change(inputs[0] as HTMLElement, { target: { value: 'echo' } })
      fireEvent.change(inputs[1] as HTMLElement, { target: { value: 'foxtrot' } })
      fireEvent.change(inputs[2] as HTMLElement, { target: { value: 'golf' } })
      fireEvent.change(inputs[3] as HTMLElement, { target: { value: 'hotel' } })

      fireEvent.click(screen.getByRole('button', { name: /^Pair$/i }))
      // Flush confirmPairing + the poll's immediate enable-triggered fetch.
      await flushMicrotasks()

      expect(screen.getByTestId('pairing-waiting-state')).toBeInTheDocument()
    }

    it('renders the waiting state with countdown, announces it, and has no a11y violations', async () => {
      const user = userEvent.setup()
      mockInvokeByCommand({ list_peer_refs: [], confirm_pairing: undefined })

      const { container } = render(<PairingDialog open onOpenChange={vi.fn()} />)
      await enterWaitingState(user)

      expect(screen.getByText('Waiting for the other device…')).toBeInTheDocument()
      expect(
        screen.getByText(
          'This device armed its side of the pairing handshake. It will confirm automatically once the other device connects.',
        ),
      ).toBeInTheDocument()
      expect(screen.getByText(/Session expires in 5:00/)).toBeInTheDocument()
      expect(vi.mocked(announce)).toHaveBeenCalledWith(
        'Waiting for the other device to confirm pairing',
      )
      // The entry form (and its "type the passphrase" affordances) must be
      // gone — there is nothing left to type while waiting.
      expect(screen.queryByLabelText('Passphrase word 1')).not.toBeInTheDocument()

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    // -------------------------------------------------------------------
    // #3493 — the CALL SITE for `cancel_pairing_inner`'s marker clear.
    //
    // The backend can only disarm the pending-pairing row if the frontend
    // actually invokes `cancel_pairing`, and the joiner's Cancel used to be
    // gated on `sessionStartedRef` — false for a joiner, which never calls
    // `startPairing`. So the waiting screen's Cancel was a pure UI act: the
    // dialog closed while the marker stayed armed for the rest of its
    // 5-minute TTL, still able to admit an unpaired device. Asserting the
    // backend clear alone would leave that half uncovered.
    // -------------------------------------------------------------------
    it('Cancel on the waiting screen invokes cancel_pairing so the armed pending-pairing marker is disarmed (#3493)', async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        confirm_pairing: undefined,
        cancel_pairing: undefined,
      })

      render(<PairingDialog open onOpenChange={onOpenChange} />)
      await enterWaitingState(user)

      // Exactly one cancel so far — the host session torn down by the role
      // switch. The joiner's own `confirm_pairing` has since armed a marker.
      const cancelsBefore = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'cancel_pairing',
      ).length
      expect(cancelsBefore).toBe(1)

      await user.click(document.querySelector('.pairing-waiting-cancel-btn') as HTMLElement)

      await waitFor(() => {
        const cancelsAfter = mockedInvoke.mock.calls.filter(
          ([cmd]) => cmd === 'cancel_pairing',
        ).length
        expect(cancelsAfter).toBe(2)
      })
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('resolves to success when a new peer appears in peer_refs, closing the dialog and announcing success', async () => {
      const onOpenChange = vi.fn()
      const newPeer = {
        peer_id: 'peer-new-999',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
      }
      let listCallCount = 0
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_peer_refs') {
          listCallCount++
          // Calls 1-4 are the host-mount refresh, the joiner-switch
          // refresh, the confirm-time baseline snapshot, and the immediate
          // poll fired the instant waiting begins — all still empty. The
          // peer only appears once we advance to the next 2s poll tick
          // below, so this test genuinely exercises the polling loop and
          // not just the initial fetch.
          if (listCallCount <= 4) return []
          return [newPeer]
        }
        if (cmd === 'confirm_pairing') return undefined
        return undefined
      })

      vi.useFakeTimers()
      try {
        const { container } = render(<PairingDialog open onOpenChange={onOpenChange} />)
        await enterWaitingStateFake()

        // Advance one poll interval tick (PAIRING_PEER_POLL_INTERVAL_MS =
        // 2000ms in the component). advanceTimersByTimeAsync awaits the
        // poll's internal `await queryFn()` promise between fake-timer
        // firings — the plain sync advanceTimersByTime used for the
        // purely-synchronous countdown ticks elsewhere in this file would
        // not wait for that promise to settle.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000)
        })

        expect(onOpenChange).toHaveBeenCalledWith(false)
        expect(toast.success).toHaveBeenCalledWith('Device paired successfully')
        expect(vi.mocked(announce)).toHaveBeenCalledWith('Device paired successfully')
        expect(screen.queryByTestId('pairing-waiting-state')).not.toBeInTheDocument()

        // axe-core's internal engine relies on real timers/promises — it
        // hangs indefinitely under fake timers (observed: 20s test
        // timeout). Switch back before running it.
        vi.useRealTimers()
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      } finally {
        vi.useRealTimers()
      }
    })

    // #3469 (review) — the success signal is "a peer id appeared that was
    // NOT in the baseline snapshot". If that baseline is taken from the
    // dialog's `peers` React state, it is empty whenever the peer load that
    // fills it failed — and then every ALREADY-paired peer on the device
    // looks brand new to the first successful poll, producing exactly the
    // false "Device paired successfully" this issue exists to remove. The
    // baseline must be authoritative as of the moment the proof was armed,
    // and when it cannot be read it must fail CLOSED (adopt the first poll
    // as the baseline) rather than claim someone else's peer as this
    // attempt's outcome.
    it('does not claim success from pre-existing peers when the confirm-time peer snapshot fails', async () => {
      const onOpenChange = vi.fn()
      const existingPeer = {
        peer_id: 'peer-already-paired-1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
      }
      let listCallCount = 0
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_peer_refs') {
          listCallCount++
          // Every read up to and including the confirm-time baseline
          // snapshot fails transiently, so the dialog reaches the waiting
          // state with NO trustworthy knowledge of which peers it already
          // had. From then on the reads recover and report the device's
          // pre-existing peer.
          if (listCallCount <= 3) throw new Error('transient db error')
          return [existingPeer]
        }
        if (cmd === 'confirm_pairing') return undefined
        return undefined
      })

      vi.useFakeTimers()
      try {
        render(<PairingDialog open onOpenChange={onOpenChange} />)
        await enterWaitingStateFake()

        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000)
        })

        expect(toast.success).not.toHaveBeenCalledWith('Device paired successfully')
        expect(vi.mocked(announce)).not.toHaveBeenCalledWith('Device paired successfully')
        expect(onOpenChange).not.toHaveBeenCalledWith(false)
        expect(screen.getByTestId('pairing-waiting-state')).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })

    // #3469 (review) — `DeviceManagement` mounts this dialog unconditionally
    // (DeviceManagement.tsx:412), so every piece of its state survives each
    // open/close cycle, and `usePollingQuery` never clears its `data` when
    // `enabled` flips false (usePollingQuery.ts:100-105). Unpair-then-repair
    // — the routine sync-troubleshooting path — walks straight into the gap
    // between those two facts: at the instant the second wait begins, the
    // poll still holds the FIRST attempt's peer list, while the fresh
    // confirm-time baseline is correctly empty again because that peer was
    // just deleted. Judged against each other, the old peer reads as "one
    // that appeared after this attempt started" — instant false success,
    // dialog closed, and the device the user just unpaired resurrected into
    // the sidebar/StatusPanel. The baseline is not at fault; what was
    // missing is that a poll result must be scoped to the wait it is being
    // judged against, which is what the wait id stamped on it provides.
    it('does not claim success from a previous attempt poll result when one mounted dialog pairs, unpairs, then pairs again', async () => {
      const onOpenChange = vi.fn()
      const pairedPeer = {
        peer_id: 'peer-first-attempt-1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
      }
      // Authoritative peer table: `list_peer_refs` reads it and
      // `delete_peer_ref` empties it, so the second attempt's confirm-time
      // baseline is genuinely empty exactly as it is after a real unpair.
      let peerRows: (typeof pairedPeer)[] = []
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing') return mockPairingInfo
        if (cmd === 'list_peer_refs') return peerRows
        if (cmd === 'confirm_pairing') return undefined
        if (cmd === 'delete_peer_ref') {
          peerRows = []
          return undefined
        }
        return undefined
      })

      vi.useFakeTimers()
      try {
        const { rerender } = render(<PairingDialog open onOpenChange={onOpenChange} />)

        // 1. Pair for real. The resolving poll leaves the hook holding
        //    `[pairedPeer]`, which nothing ever clears.
        await enterWaitingStateFake()
        peerRows = [pairedPeer]
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000)
        })
        expect(toast.success).toHaveBeenCalledWith('Device paired successfully')
        expect(onOpenChange).toHaveBeenCalledWith(false)

        // 2. The close/reopen the parent drives. Same mount throughout —
        //    this is the whole point of the test, so assert the dialog came
        //    back rather than assuming it did.
        rerender(<PairingDialog open={false} onOpenChange={onOpenChange} />)
        await flushMicrotasks()
        rerender(<PairingDialog open onOpenChange={onOpenChange} />)
        await flushMicrotasks()
        expect(screen.getByText('alpha bravo charlie delta')).toBeInTheDocument()

        // 3. Unpair the device through the dialog's own list.
        expect(screen.getByText('peer-first-attempt-1')).toBeInTheDocument()
        fireEvent.click(screen.getAllByRole('button', { name: /Unpair/i })[0] as HTMLElement)
        fireEvent.click(screen.getByRole('button', { name: /Yes, unpair/i }))
        await flushMicrotasks()
        expect(mockedInvoke).toHaveBeenCalledWith('delete_peer_ref', {
          peerId: 'peer-first-attempt-1',
        })
        expect(screen.queryByText('peer-first-attempt-1')).not.toBeInTheDocument()

        // 4. Pair again on that same mount. Everything below must be
        //    attributable to THIS attempt, so clear the first one's traces.
        onOpenChange.mockClear()
        vi.mocked(toast.success).mockClear()
        vi.mocked(announce).mockClear()
        mockSyncStoreState.setPeers.mockClear()

        fireEvent.click(
          screen.getByRole('button', { name: /Have a code from the other device\?/i }),
        )
        await flushMicrotasks()
        const inputs = screen.getAllByRole('textbox')
        fireEvent.change(inputs[0] as HTMLElement, { target: { value: 'echo' } })
        fireEvent.change(inputs[1] as HTMLElement, { target: { value: 'foxtrot' } })
        fireEvent.change(inputs[2] as HTMLElement, { target: { value: 'golf' } })
        fireEvent.change(inputs[3] as HTMLElement, { target: { value: 'hotel' } })
        fireEvent.click(screen.getByRole('button', { name: /^Pair$/i }))
        await flushMicrotasks()

        // Nothing has been observed since this wait began, so it must still
        // be running. Without the wait id this assertion is already lost
        // here: the success effect resolves on the commit that flips into
        // 'waiting', before this attempt's own first fetch has resolved.
        expect(toast.success).not.toHaveBeenCalled()
        expect(vi.mocked(announce)).not.toHaveBeenCalledWith('Device paired successfully')
        expect(onOpenChange).not.toHaveBeenCalled()
        expect(screen.getByTestId('pairing-waiting-state')).toBeInTheDocument()
        // ...and the device just unpaired must not be pushed back into the
        // shared store the sidebar/StatusPanel read from (#1076 mirror).
        expect(mockSyncStoreState.setPeers).not.toHaveBeenCalledWith(
          expect.arrayContaining([expect.objectContaining({ peerId: 'peer-first-attempt-1' })]),
        )

        // Still waiting a full poll tick later: the empty result that does
        // belong to this attempt reports nothing new, which is the truth.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000)
        })
        expect(screen.getByTestId('pairing-waiting-state')).toBeInTheDocument()
        expect(toast.success).not.toHaveBeenCalled()
        expect(onOpenChange).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('surfaces the proof-rejection failure with a retype path back to the entry form', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_peer_refs') return []
        if (cmd === 'confirm_pairing') return undefined
        return undefined
      })

      let container!: HTMLElement
      vi.useFakeTimers()
      try {
        ;({ container } = render(<PairingDialog open onOpenChange={vi.fn()} />))
        await enterWaitingStateFake()

        try {
          // Simulate the responder's wire-level rejection
          // ("pairing passphrase proof required") landing via the shared
          // sync store's `error` field — the same signal path the
          // component reads (`useSyncEvents.ts` → `sync:error` Tauri
          // event → `useSyncStore`) instead of a dedicated listener. The
          // mock store here is a plain object, not a real subscription,
          // so the component only observes this mutation on its NEXT
          // render — force one via a poll/countdown tick.
          mockSyncStoreState.error = 'pairing passphrase proof required'

          await act(async () => {
            await vi.advanceTimersByTimeAsync(2000)
          })

          expect(screen.queryByTestId('pairing-waiting-state')).not.toBeInTheDocument()
          expect(screen.getByLabelText('Passphrase word 1')).toBeInTheDocument()
          expect(screen.getByRole('alert')).toHaveTextContent(
            'The passphrase did not match. Check it and try again.',
          )
          expect(vi.mocked(announce)).toHaveBeenCalledWith('Pairing passphrase did not match')
        } finally {
          mockSyncStoreState.error = null
        }
      } finally {
        vi.useRealTimers()
      }

      // axe-core hangs indefinitely under fake timers — run it only after
      // real timers are restored (see the success test above for details).
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    // #3495 — a rejection string already sitting in the shared sync store
    // from an EARLIER, unrelated `sync:error` event must not be mistaken
    // for THIS attempt's rejection and immediately fail a fresh wait. The
    // protection is `syncSetState('idle')` in `executePair`'s `call`
    // (PairingDialog.tsx), which clears the store's error before waiting
    // begins; there used to be a second, dead-code guard
    // (`waitErrorBaselineRef`, removed by #3495) that could never fire
    // because of it.
    it('a stale rejection already sitting in the sync store does not immediately fail a fresh wait', async () => {
      const user = userEvent.setup()
      mockInvokeByCommand({ list_peer_refs: [], confirm_pairing: undefined })

      try {
        // A leftover rejection from BEFORE this attempt even starts.
        mockSyncStoreState.error = 'pairing passphrase proof required'

        render(<PairingDialog open onOpenChange={vi.fn()} />)
        await enterWaitingState(user)

        // Still waiting — not kicked straight back to the entry form by
        // the stale error.
        expect(screen.getByTestId('pairing-waiting-state')).toBeInTheDocument()
        expect(screen.queryByLabelText('Passphrase word 1')).not.toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        // `syncSetState('idle')` in `call` is what neutralises the stale
        // error — confirm it actually ran.
        expect(mockSyncStoreState.error).toBeNull()
      } finally {
        mockSyncStoreState.error = null
      }
    })

    it('surfaces a timeout with a retry path when the TTL elapses with no success or rejection', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_peer_refs') return []
        if (cmd === 'confirm_pairing') return undefined
        return undefined
      })

      let container!: HTMLElement
      vi.useFakeTimers()
      try {
        ;({ container } = render(<PairingDialog open onOpenChange={vi.fn()} />))
        await enterWaitingStateFake()
        expect(screen.getByText(/Session expires in 5:00/)).toBeInTheDocument()

        // Advance past the full 300s pending-pairing TTL
        // (PAIRING_TIMEOUT_SECONDS in the component — no distinct
        // joiner-side binding is exposed to the frontend; see the
        // constant's comment). Mirrors the host-side "session expires"
        // test's 301_000ms advance exactly.
        await act(async () => {
          vi.advanceTimersByTime(301_000)
        })

        // Timeout returns the dialog to the entry phase with a retry
        // affordance — the passphrase form and Pair button are reachable
        // again, not a dead end.
        expect(screen.queryByTestId('pairing-waiting-state')).not.toBeInTheDocument()
        expect(screen.getByLabelText('Passphrase word 1')).toBeInTheDocument()
        expect(screen.getByRole('alert')).toHaveTextContent(
          'No response from the other device. The pairing code may have expired.',
        )
        expect(vi.mocked(announce)).toHaveBeenCalledWith(
          'Pairing timed out waiting for the other device',
        )
        expect(screen.getByRole('button', { name: /^Pair$/i })).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }

      // axe-core hangs indefinitely under fake timers — run it only after
      // real timers are restored (see the success test above for details).
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    // #3496 — the issue's stated cause ("polling leaks on parent unmount")
    // is misleading: `usePollingQuery` cleans up correctly on a genuine
    // unmount. The real defect is that a parent-driven `open={false}` does
    // NOT unmount this component — `if (!open) return null` sits after
    // every hook, and `joinerPhase` is untouched by the close (only
    // `handleCancel`, the success effect, and the open effect reset it) —
    // so without gating the poll on `open` too, `list_peer_refs` keeps
    // firing every `PAIRING_PEER_POLL_INTERVAL_MS` indefinitely on a
    // closed dialog.
    it('list_peer_refs polling stops once `open` flips to false, even though `joinerPhase` stays "waiting"', async () => {
      let listCallCount = 0
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_peer_refs') {
          listCallCount++
          return []
        }
        if (cmd === 'confirm_pairing') return undefined
        return undefined
      })

      vi.useFakeTimers()
      try {
        const { rerender } = render(<PairingDialog open onOpenChange={vi.fn()} />)
        await enterWaitingStateFake()
        // Sanity: polling is genuinely active before the close, so a flat
        // "unchanged count" assertion below can't pass vacuously because
        // nothing was ever polling in the first place.
        expect(listCallCount).toBeGreaterThan(0)

        // Parent-driven close WITHOUT unmounting — the documented
        // "intentional escape hatch" (see `handleAttemptClose`'s comment
        // in PairingDialog.tsx).
        rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)
        const countAtClose = listCallCount

        // Advance well past one poll boundary
        // (PAIRING_PEER_POLL_INTERVAL_MS = 2000ms).
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2500)
        })

        expect(listCallCount).toBe(countAtClose)
      } finally {
        vi.useRealTimers()
      }
    })

    // The poll is only half of #3496. The wait countdown runs on the same
    // `joinerPhase === 'waiting'` condition, and its timeout arm calls
    // `announce(...)` — so an ungated countdown does not merely burn a
    // timer, it speaks to a screen reader about a dialog that is no longer
    // on screen, up to PAIRING_TIMEOUT_SECONDS after the user closed it.
    it('the wait countdown stops on a parent-driven close, so no timeout is announced to a closed dialog', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_peer_refs') return []
        if (cmd === 'confirm_pairing') return undefined
        return undefined
      })

      vi.useFakeTimers()
      try {
        const { rerender } = render(<PairingDialog open onOpenChange={vi.fn()} />)
        await enterWaitingStateFake()

        // Sanity: the countdown is genuinely running before the close, so
        // the assertion below cannot pass because nothing was ever ticking.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1500)
        })
        expect(vi.mocked(announce)).toHaveBeenCalled()
        vi.mocked(announce).mockClear()

        rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)

        // Past the full PAIRING_TIMEOUT_SECONDS (300s) window.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(301_000)
        })

        expect(vi.mocked(announce)).not.toHaveBeenCalledWith(expect.stringContaining('timed out'))
      } finally {
        vi.useRealTimers()
      }
    })
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
    // The focus move lives in a passive effect (`PairingDialog.tsx:747-751`), and
    // React schedules those asynchronously. `findByRole('alert')` above resolves
    // as soon as the alert is in the DOM, which can be one poll BEFORE that
    // effect flushes — so asserting focus synchronously here is a race, and it
    // loses on a loaded CI runner. When it loses, `activeElement` is still Radix's
    // default (the dialog's close button), which reads like a focus-management
    // regression rather than a test-timing one. `waitFor` removes the race
    // without weakening the assertion: the wrong element still fails.
    //
    // The sibling assertion at ~line 961 does NOT need this — it drives fake
    // timers inside `await act(...)`, which flushes effects before it returns.
    await waitFor(() => expect(document.activeElement).toBe(retryBtn))
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

      // #3463 (review): the host session now starts automatically on
      // mount — no click needed to reach it.
      render(<PairingDialog open onOpenChange={vi.fn()} />)

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

    // #3463 (review): opening the dialog started a host session, and
    // selectJoinerRole already cancelled it once when switching roles —
    // before this click, cancel_pairing has already fired exactly once.
    // Click "Cancel pairing" — should close the dialog, and must NOT fire
    // cancel_pairing a SECOND time: the joiner has no live session of its
    // own left for this guard action to cancel.
    const cancelCallsBeforeGuardClick = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'cancel_pairing',
    ).length
    expect(cancelCallsBeforeGuardClick).toBe(1)

    await user.click(screen.getByRole('button', { name: /^Cancel pairing$/i }))

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    const cancelCallsAfterGuardClick = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'cancel_pairing',
    ).length
    expect(cancelCallsAfterGuardClick).toBe(1)

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
  // #3463 (review) — the countdown-pause-while-typing mechanism (#294:
  // handleTypingStateChange / pausedByTyping / onTypingStateChange, plus
  // its `pairing.countdownPaused` and `announce.pairingCountdownPaused`/
  // `pairingCountdownResumed` i18n strings) was only ever reachable by
  // pausing the SAME dialog's countdown while typing in the SAME dialog's
  // passphrase inputs. The implicit-role split makes that permanently
  // unreachable through the UI: the countdown only ever renders on the
  // host screen, and the passphrase inputs only ever render on the joiner
  // screen, and those two screens are mutually exclusive by construction
  // (that mutual exclusion is this fix). Per review, the dead state,
  // effects, indicator markup, SR announcements, and orphaned i18n strings
  // have all been deleted (PairingDialog.tsx, PairingQrDisplay.tsx,
  // PairingEntryForm.tsx, src/lib/i18n/sync.ts, src/lib/i18n/common.ts) —
  // this is not "effectively dead" wiring left in place, the wiring itself
  // is gone. This test now guards a plain regression: typing in the joiner
  // form must not throw, and no countdown/pause text can ever render there.
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
