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
import { useState } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { strictInvokeFallback } from '@/__tests__/helpers/invoke'
import { PairingDialog } from '@/components/dialogs/PairingDialog'
import { useIsMobile } from '@/hooks/useIsMobile'
import { announce } from '@/lib/announcer'
import { PAIRING_MUTATION_TIMEOUT_MS, resetPairingMutationQueue } from '@/lib/pairing-mutations'

// The dialog swaps to a bottom Sheet via `useDialogOrSheet` (#2665) when
// `useIsMobile()` is true. Mock the hook so each test can pin the
// viewport-state boolean.
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

// #3852 / PR #4034 note 4 — the dialog mounts `useOsNetworkBlock`, which
// subscribes through `useTauriEventListener`. Stub `listen` so a test can drive
// the `sync:network_blocked` payload the daemon really sends and assert on what
// the user is shown. Inert for every other test in this file: no other hook here
// listens, and the subscription is gated on `__TAURI_INTERNALS__`, which only
// the #3852 block below defines.
const { mockListen } = vi.hoisted(() => ({
  mockListen: vi.fn().mockResolvedValue(vi.fn()),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

// #4037 — a stand-in scanner whose payload each test sets, so the QR-payload
// compatibility tests can hand `handleQrScan` an exact byte string. The real
// component needs a camera; nothing else in this file enters scan mode, so the
// mock is inert everywhere except the compatibility suite at the end.
const { scannedPayload } = vi.hoisted(() => ({ scannedPayload: { current: '' } }))

vi.mock('@/components/peers/QrScanner', () => ({
  QrScanner: ({ onScan }: { onScan: (data: string) => void }) => (
    <button type="button" data-testid="mock-qr-scan" onClick={() => onScan(scannedPayload.current)}>
      Mock Scan
    </button>
  ),
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
    streamed_at: null,
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
    streamed_at: null,
    synced_at: null,
    reset_count: 2,
    last_reset_at: 1735689600000, // 2025-01-01T00:00:00Z
    cert_hash: null,
    device_name: null,
  },
]

// #4035 (review note 4) — commands every mounted dialog issues on its own,
// answered here so no individual test has to know about them. Without this,
// `get_os_network_block_status` resolves `undefined` for any test that did not
// name it, `unwrap` throws on the non-`Result`, and the rejection surfaces as a
// `logger.warn` from a suite that has nothing to do with #4035. Explicit keys
// in a call below still win — that is how the block-in-progress tests answer
// `blocked: true`.
const AMBIENT_INVOKES: Record<string, unknown> = {
  get_os_network_block_status: { blocked: false, reason_key: null },
}

function mockInvokeByCommand(commands: Record<string, unknown>) {
  const answers = { ...AMBIENT_INVOKES, ...commands }
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd in answers) return answers[cmd]
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

// Deliberately does NOT use `vi.runAllTimersAsync()` for these flushes
// (unlike the single initial flush in e.g. the host countdown test): by the
// second/third flush a repeating `setInterval` (the host countdown, then the
// joiner's poll + wait countdown) is already active and never clears itself
// within the flush, so `runAllTimersAsync` — which exhausts the timer queue
// until it's empty — spins until Vitest's "10000 timers" infinite-loop guard
// aborts it. `flushMicrotasks` only drains the native Promise microtask queue
// (invoke() calls are plain resolved Promises, not fake-timer-driven), which
// is all that's needed to let confirmPairing/listPeerRefs settle without
// touching any interval.
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

// Reaches the joiner's waiting state via `fireEvent` under FAKE timers, for
// tests that go on to advance the poll/countdown intervals. This is NOT
// interchangeable with `enterWaitingState` below: `setInterval` handles
// created while real timers are active stay bound to the real clock even
// after a later `vi.useFakeTimers()` call — advancing fake time then does
// nothing to them. The interval must be created while fake timers are
// already active, which means the interactions that create it (role switch,
// word entry, Pair click) must also happen under fake timers — hence
// `fireEvent` (synchronous) instead of `userEvent` (which deadlocks against
// `waitFor`/`findBy` under fake timers, per the house rule above the
// paste-focus-unmount test) and `flushMicrotasks()` in place of the
// `findBy*` queries `enterWaitingState` uses.
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

/** How many times `invoke` was called with a given Tauri command name. */
function countInvokes(cmd: string): number {
  return mockedInvoke.mock.calls.filter(([c]) => c === cmd).length
}

beforeEach(async () => {
  // #3715 — drain before clearing the counters, not after.
  //
  // Every test here ends with a live pairing window, so RTL's `cleanup()`
  // unmounts an armed dialog and its cleanup effect dispatches a
  // `cancel_pairing`. That dispatch reaches `invoke` a few microtasks later —
  // it is queued, and the queue is a promise chain — which can be after this
  // hook's `vi.clearAllMocks()`. The stray call is then recorded against a
  // test that never made it (`invoke` records under whatever implementation is
  // current when it is finally called), and any test asserting a count of zero
  // fails intermittently. Draining first lets the leftover land while it still
  // belongs to the previous test, and the clear below wipes it.
  for (let i = 0; i < 20; i++) await Promise.resolve()
  vi.clearAllMocks()
  // Default to the desktop path so existing test bodies keep their semantics.
  mockedUseIsMobile.mockReturnValue(false)
  // #3715 — the mutation queue is a module-level promise tail now, scoped to
  // the DEVICE because the pending-pairing row it serialises is device-global
  // (see `src/lib/pairing-mutations.ts`). That scope is the fix and it is also
  // a leak between tests: several tests below deliberately leave an IPC
  // unanswered, which parks the clear queued behind it, and the next test's
  // `start_pairing` would inherit that wait (until the mutation bound expires
  // — a self-healing suite that takes 15 s per affected test to do it). Same
  // shape as the module-level caches' `_reset*ForTest` helpers.
  resetPairingMutationQueue()
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
    expect(await screen.findByText('peer-abc-123...')).toBeInTheDocument()
    expect(screen.getByText('peer-def-098...')).toBeInTheDocument()

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
    await screen.findByText('peer-abc-123...')

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
      expect(screen.queryByText('peer-abc-123...')).not.toBeInTheDocument()
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
    // Make every invoke call hang until we release it below (rather than
    // `new Promise(() => {})`, which never resolves at all — see #3810).
    //
    // #3904 (review) — this implementation closes over `pendingInvokes` and
    // survives past this test's end, because `vi.clearAllMocks()` (in the
    // shared `beforeEach`) clears calls, not implementations. A later test
    // that forgot its own stub would inherit this one and hang on an
    // unresolvable promise instead of hitting `strictInvokeFallback` and
    // failing by name — the same sticky shape the old
    // `new Promise(() => {})` had (pre-existing, not introduced by the drain
    // added below). The `finally` at the end of this test restores the
    // strict base implementation, so the stickiness is scoped to this
    // test's own body.
    const pendingInvokes: Array<{ cmd: string; resolve: (value: unknown) => void }> = []
    mockedInvoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          pendingInvokes.push({ cmd, resolve })
        }),
    )
    try {
      // #3463 (review): the host session now starts automatically on mount —
      // there is no button to click to reach this loading state, it's the
      // very first thing rendered.
      const { unmount } = render(<PairingDialog open onOpenChange={vi.fn()} />)

      await waitFor(() => {
        const loadingEl = document.querySelector('.pairing-loading')
        expect(loadingEl).toBeTruthy()
        expect(loadingEl?.textContent).toContain('Starting pairing...')
        // #2852 — a shaped LoadingSkeleton placeholder replaces the bare
        // centered spinner; the "starting" label text is preserved.
        expect(loadingEl?.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
        expect(loadingEl?.querySelector('[data-slot="spinner"]')).toBeFalsy()
      })

      // #3810 — drain before the test ends, don't leave `start_pairing`
      // hanging forever. `initHost` arms `backendArmedRef` before dispatching
      // it (#3628), so RTL's global `afterEach(cleanup())` unmounting this
      // still-open dialog queues a `cancel_pairing` BEHIND the still-pending
      // `start_pairing` in the module-level mutation queue
      // (`src/lib/pairing-mutations.ts`). That queued clear is bounded only by
      // the mutation queue's REAL `PAIRING_MUTATION_TIMEOUT_MS` (15s) timer —
      // a `new Promise(() => {})` that's never settled and never unmounted
      // leaves that timer armed past this test's end. This file's own process
      // exits well before 15s in an isolated run, so the queued
      // `cancel_pairing` never actually dispatches — invisible. Under
      // full-suite load, though, wall-clock execution stretches enough that
      // the timer can fire while a LATER, unrelated test in this file is
      // running, dispatching a phantom `cancel_pairing` invoke that inflates
      // *that* test's count by exactly one. That is the mechanism behind
      // #3810's "1 in isolation, 2 (or 3 under heavier load) under full-suite
      // load" — settle, unmount, and drain here, like every other "hangs
      // forever" test in this file already does.
      //
      // A single `forEach` pass over `pendingInvokes` only releases what was
      // ALREADY pending at that instant. `unmount()` enqueues `cancel_pairing`
      // behind the still-in-flight `start_pairing` mutation, and that invoke's
      // resolver isn't pushed onto `pendingInvokes` until the mutation queue
      // advances — a microtask AFTER a one-shot forEach has already run and
      // returned. Left one-shot, that stray promise is the same leak shape
      // this test exists to close, one hop further along: nothing ever
      // resolves it, so it arms its own `PAIRING_MUTATION_TIMEOUT_MS` timer
      // that never clears (review note on #3895). Draining in a loop — until
      // a full microtask flush adds nothing new — releases whatever
      // `unmount()` (or anything it triggers) enqueues, not just the
      // snapshot taken before it ran. Resolving per command, rather than a
      // blanket `undefined`, also keeps `executeLoadPeers`'s `onSuccess`
      // (`peerList.map(...)`) from throwing into a swallowed `logger.warn`.
      //
      // This hand-rolls a drain that `unmountAndDrain` (defined below, in
      // the `#3714/#3715 the queue is device-scoped and bounded` describe
      // block) also provides. Not consolidated: that helper is a single
      // `flushMicrotasks()` pass, scoped inside that describe on the
      // assumption that whatever `unmount()` enqueues settles on its own
      // (those tests supply resolvers up front). This test needs the extra
      // hop this loop exists for — see above — so a single-pass drain would
      // silently under-drain it. If you touch either drain helper, check
      // whether the other one's assumption still holds.
      unmount()
      const MAX_DRAIN_PASSES = 20
      let drainPasses = 0
      while (pendingInvokes.length > 0) {
        drainPasses++
        if (drainPasses > MAX_DRAIN_PASSES) {
          // #3904 (review) — resolve whatever is still pending before
          // throwing. Left unresolved, those promises would re-arm exactly
          // the 15s `PAIRING_MUTATION_TIMEOUT_MS` timer this drain exists to
          // remove: the test is already red at that point, but a red test
          // that also poisons a LATER test in this file (via the stray timer
          // firing mid-run, see the #3810 note above) is harder to diagnose
          // than a red test alone.
          const stillPending = pendingInvokes.splice(0)
          stillPending.forEach(({ resolve }) => resolve(undefined))
          throw new Error(
            `still draining after ${MAX_DRAIN_PASSES} passes — ` +
              `${stillPending.length} invoke(s) still pending ` +
              `(${stillPending.map(({ cmd }) => cmd).join(', ')}); something is ` +
              're-enqueuing faster than this loop can drain it',
          )
        }
        pendingInvokes.splice(0).forEach(({ cmd, resolve }) => {
          if (cmd === 'start_pairing') return resolve(mockPairingInfo)
          if (cmd === 'list_peer_refs') return resolve([])
          return resolve(undefined)
        })
        await flushMicrotasks()
      }
      // Draining `pendingInvokes` to empty is not itself the falsifiable
      // claim: it would look identical if the queued `cancel_pairing` never
      // got dispatched at all (e.g. the cleanup effect stopped calling it) or
      // if it needed one more microtask hop than this loop happened to take —
      // in both cases `pendingInvokes` would still end up empty of *other*
      // things while silently missing the one command this test exists to
      // prove was sent. Assert the actual invariant instead: the cleanup's
      // `cancel_pairing` really was dispatched, and — because the loop above
      // resolves it — settled, inside this test. (Same assertion the
      // sibling fake-timer test, "a start_pairing that never answers
      // surfaces the bound through the error banner (#3715)", uses.)
      expect(countInvokes('cancel_pairing')).toBe(1)
    } finally {
      // #3904 (review) — this test's `mockImplementation` above closes over
      // `pendingInvokes` and would otherwise survive past this test (see the
      // comment on that `mockImplementation` call). Restore the strict base
      // so a later test that forgets its own stub fails loudly by name via
      // `strictInvokeFallback` instead of hanging on this test's leftover
      // promises.
      mockedInvoke.mockImplementation(strictInvokeFallback)
    }
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

    // cancelPairing should be called by the cleanup effect. #3628 — awaited
    // rather than asserted synchronously: the clear now goes through the
    // pairing-mutation queue, so it is dispatched a microtask after the
    // cleanup function runs instead of inside it. (The sibling close test
    // above already had this shape.)
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
    })
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
    await screen.findByText('peer-abc-123...')

    const unpairBtns = screen.getAllByRole('button', { name: /Unpair/i })
    await user.click(unpairBtns[0] as HTMLElement)

    // Confirmation dialog appears
    expect(screen.getByText('Unpair device?')).toBeInTheDocument()

    const yesBtn = screen.getByRole('button', { name: /Yes, unpair/i })
    await user.click(yesBtn)

    const errorEl = await screen.findByRole('alert')
    expect(errorEl).toHaveTextContent(/Failed to unpair device:.*peer not found/i)

    // Peer should still be in the list (not removed on failure)
    expect(screen.getByText('peer-abc-123...')).toBeInTheDocument()
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

    // -------------------------------------------------------------------
    // #3610 (review, finding 1) — a failed explicit-Cancel used to clear
    // `backendArmedRef` optimistically and swallow the rejection into a
    // silent `logger.error`: the marker stayed armed for its full TTL
    // while the user believed Cancel had worked — the same shape #3493
    // fixed above, reached via a DB-write failure instead of a stale gate.
    //
    // Asserts both halves: the failure is surfaced (mirroring the
    // close/unmount path's existing `notify.error(t('pairing.cancelFailed'))`
    // toast), and the ref is NOT cleared — proven behaviourally by showing
    // the close/unmount cleanup effect still attempts its own cancelPairing
    // when the dialog actually closes, which only happens if the ref is
    // still armed.
    // -------------------------------------------------------------------
    it('a failed Cancel on the waiting screen surfaces an error toast and leaves the marker armed for the close/unmount retry (#3610 review)', async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        confirm_pairing: undefined,
      })

      const { rerender } = render(<PairingDialog open onOpenChange={onOpenChange} />)
      await enterWaitingState(user)

      // Exactly one cancel so far — the host session torn down by the role
      // switch. The joiner's own `confirm_pairing` has since armed a marker
      // this explicit Cancel click is about to (attempt to) tear down.
      const cancelsBefore = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'cancel_pairing',
      ).length
      expect(cancelsBefore).toBe(1)

      // The explicit-Cancel's own cancelPairing call fails (e.g. a DB
      // write error).
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'cancel_pairing') throw new Error('db write failed')
        if (cmd === 'list_peer_refs') return []
        return undefined
      })

      await user.click(document.querySelector('.pairing-waiting-cancel-btn') as HTMLElement)

      // The failure is surfaced — no longer swallowed into a silent
      // logger.error with nothing shown to the user.
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to cancel pairing')
      })
      // The dialog still closes — the user's Cancel click is honoured
      // either way, it's just the backend marker that's left dangling.
      expect(onOpenChange).toHaveBeenCalledWith(false)

      const cancelsAfterFailedClick = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'cancel_pairing',
      ).length
      expect(cancelsAfterFailedClick).toBe(2)

      // Simulate the parent actually honouring `onOpenChange(false)` (the
      // mock above only recorded the call; it doesn't flip the `open`
      // prop by itself). Let cancelPairing succeed this time so the
      // retry's own outcome doesn't confound the assertion.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'cancel_pairing') return undefined
        if (cmd === 'list_peer_refs') return []
        return undefined
      })
      rerender(<PairingDialog open={false} onOpenChange={onOpenChange} />)

      // The close/unmount cleanup effect fires its own cancelPairing —
      // the one retry the system would otherwise have lost if the failed
      // click above had cleared the ref anyway.
      await waitFor(() => {
        const cancelsAfterClose = mockedInvoke.mock.calls.filter(
          ([cmd]) => cmd === 'cancel_pairing',
        ).length
        expect(cancelsAfterClose).toBe(3)
      })
    })

    it('resolves to success when a new peer appears in peer_refs, closing the dialog and announcing success', async () => {
      const onOpenChange = vi.fn()
      const newPeer = {
        peer_id: 'peer-new-999',
        last_hash: null,
        last_sent_hash: null,
        streamed_at: null,
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
        streamed_at: null,
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

    // #3469 (review) — `DeviceManagement` mounts `<PairingDialog>`
    // unconditionally, so every piece of its state survives each
    // open/close cycle, and `usePollingQuery`'s `enabled`-flip effect calls
    // `setLoading(false)` but never `setData(null)`. Unpair-then-repair
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
        streamed_at: null,
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
        expect(screen.getByText('peer-first-a...')).toBeInTheDocument()
        fireEvent.click(screen.getAllByRole('button', { name: /Unpair/i })[0] as HTMLElement)
        fireEvent.click(screen.getByRole('button', { name: /Yes, unpair/i }))
        await flushMicrotasks()
        expect(mockedInvoke).toHaveBeenCalledWith('delete_peer_ref', {
          peerId: 'peer-first-attempt-1',
        })
        expect(screen.queryByText('peer-first-a...')).not.toBeInTheDocument()

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
        // #3952 — the message must name BOTH causes. The timeout cannot tell
        // an expired code from a discovery failure, and on a multicast-hostile
        // network the second is the common one and gets no other hint (the
        // `MdnsDisabled` banner needs a socket that failed to open, not one
        // whose packets were dropped). Asserting only "no response" would let
        // the single-cause wording back in, so both halves are pinned.
        const timeoutAlert = screen.getByRole('alert')
        expect(timeoutAlert).toHaveTextContent('No response from the other device')
        expect(timeoutAlert).toHaveTextContent(/pairing code expired/i)
        expect(timeoutAlert).toHaveTextContent(/could not find each other/i)
        // Pin the DEFECT, not the hedge: the old string asserted a single
        // cause. Rejecting /may have expired/ would also redden a legitimate
        // future rewording that names both ("the code may have expired, or
        // the two devices could not find each other"), so reject the whole
        // old sentence instead. The three positive assertions above carry
        // the real guarantee.
        expect(timeoutAlert).not.toHaveTextContent(
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

  // -----------------------------------------------------------------------
  // #3615 / #3620 — one invariant, four gaps: cancel only what you armed,
  // and only when you know the clear succeeded.
  //
  // `backendArmedRef` means "this device holds backend-side pairing state a
  // `cancel_pairing` would tear down". Every gap below is that ref
  // disagreeing with reality: armed after the pair completed (#3615), a
  // close that disarms a live window with no confirmation (#3620.1), a
  // re-arm racing an in-flight clear (#3620.2), and a clear recorded as
  // done before it landed (#3620.3).
  // -----------------------------------------------------------------------
  describe('#3615/#3620 cancel only what you armed', () => {
    const newPeer = {
      peer_id: 'peer-new-999',
      last_hash: null,
      last_sent_hash: null,
      streamed_at: null,
      synced_at: null,
      reset_count: 0,
      last_reset_at: null,
      cert_hash: null,
      device_name: null,
    }

    // -------------------------------------------------------------------
    // #3615 — a SYMMETRIC pair. The joiner arm has held since #3610 (its
    // poll-success effect disarms the ref); the host arm is the gap: the
    // host had no success detection at all, so a completed pair left the
    // ref armed and closing the dialog fired a `cancel_pairing` that owned
    // nothing — racing whatever arms the marker next. Fixing only one arm
    // of a symmetric pair is what created this bug; both are asserted.
    // -------------------------------------------------------------------
    it('joiner: a completed pair disarms the marker, so closing afterwards fires no cancel_pairing (#3615)', async () => {
      const onOpenChange = vi.fn()
      let peerRows: (typeof newPeer)[] = []
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing') return mockPairingInfo
        if (cmd === 'list_peer_refs') return peerRows
        return undefined
      })

      vi.useFakeTimers()
      try {
        const { rerender } = render(<PairingDialog open onOpenChange={onOpenChange} />)
        await enterWaitingStateFake()

        // The pair completes: the peer this device was waiting for is
        // pinned and shows up in `list_peer_refs`.
        peerRows = [newPeer]
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000)
        })
        expect(toast.success).toHaveBeenCalledWith('Device paired successfully')

        // One cancel so far: the host session torn down by the role switch.
        const cancelsAfterPair = countInvokes('cancel_pairing')
        expect(cancelsAfterPair).toBe(1)

        rerender(<PairingDialog open={false} onOpenChange={onOpenChange} />)
        await flushMicrotasks()

        // The marker did its job and is no longer this device's to tear
        // down — the close must not fire a cancel that owns nothing.
        expect(countInvokes('cancel_pairing')).toBe(cancelsAfterPair)
      } finally {
        vi.useRealTimers()
      }
    })

    it('host: a completed pair disarms the marker, so closing afterwards fires no cancel_pairing (#3615)', async () => {
      const onOpenChange = vi.fn()
      let peerRows: (typeof newPeer)[] = []
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing') return mockPairingInfo
        if (cmd === 'list_peer_refs') return peerRows
        return undefined
      })

      vi.useFakeTimers()
      try {
        const { rerender } = render(<PairingDialog open onOpenChange={onOpenChange} />)
        await flushMicrotasks()
        expect(screen.getByText('alpha bravo charlie delta')).toBeInTheDocument()
        expect(countInvokes('cancel_pairing')).toBe(0)

        // The pair completes: the joiner's proof matched, this device
        // pinned the peer, and it shows up in `list_peer_refs` — the same
        // and only observable evidence the joiner resolves its wait on.
        peerRows = [newPeer]
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000)
        })
        expect(toast.success).toHaveBeenCalledWith('Device paired successfully')
        expect(vi.mocked(announce)).toHaveBeenCalledWith('Device paired successfully')
        expect(onOpenChange).toHaveBeenCalledWith(false)

        rerender(<PairingDialog open={false} onOpenChange={onOpenChange} />)
        await flushMicrotasks()

        expect(countInvokes('cancel_pairing')).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    // -------------------------------------------------------------------
    // #3620.1 — the host's QR screen is a live pairing window, exactly as
    // the joiner's wait is. Since #3610 an Esc/backdrop close genuinely
    // disarms it, and the joiner then fails the responder's proof check
    // with nothing on the host to say why. Guard it symmetrically.
    // -------------------------------------------------------------------
    it("Esc on the host's live QR screen shows the close guard instead of silently disarming the window (#3620)", async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        cancel_pairing: undefined,
      })

      render(<PairingDialog open onOpenChange={onOpenChange} />)
      await screen.findByText('alpha bravo charlie delta')

      await user.keyboard('{Escape}')

      await waitFor(() => {
        expect(screen.getByText('Cancel pairing?')).toBeInTheDocument()
      })
      // The guard intercepted: nothing closed, and — the point of the fix
      // — the live pairing window is still armed on the backend.
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      expect(countInvokes('cancel_pairing')).toBe(0)

      const results = await axe(document.body)
      expect(results).toHaveNoViolations()

      // Keeping the pairing leaves the QR (and its window) intact.
      await user.click(screen.getByRole('button', { name: /Keep pairing/i }))
      await waitFor(() => {
        expect(screen.queryByText('Cancel pairing?')).not.toBeInTheDocument()
      })
      expect(screen.getByText('alpha bravo charlie delta')).toBeInTheDocument()
      expect(countInvokes('cancel_pairing')).toBe(0)

      // ...and confirming still reaches the real teardown, so the guard is
      // an extra step, not a dead end.
      await user.keyboard('{Escape}')
      await waitFor(() => {
        expect(screen.getByText('Cancel pairing?')).toBeInTheDocument()
      })
      await user.click(screen.getByRole('button', { name: /^Cancel pairing$/i }))
      await waitFor(() => {
        expect(countInvokes('cancel_pairing')).toBe(1)
      })
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    // -------------------------------------------------------------------
    // #3620.2 — the close/unmount cleanup fires its clear UN-AWAITED (a
    // React cleanup function cannot be async). On a fast reopen the DELETE
    // can land AFTER the new `start_pairing` upsert, leaving the user
    // looking at a QR + ticking countdown for a window that has already
    // been deleted. This asserts the ORDERING, not a duration: the reopen
    // must not re-arm until the in-flight clear has resolved.
    // -------------------------------------------------------------------
    it('reopening waits for the in-flight close cleanup before arming a new pairing window (#3620)', async () => {
      let resolveCancel: () => void = () => {}
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing') return mockPairingInfo
        if (cmd === 'list_peer_refs') return []
        if (cmd === 'cancel_pairing') {
          return new Promise((resolve) => {
            resolveCancel = () => resolve(undefined)
          })
        }
        return undefined
      })

      const { rerender } = render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('alpha bravo charlie delta')
      expect(countInvokes('start_pairing')).toBe(1)

      // Close: the cleanup effect fires `cancel_pairing`, which hangs.
      rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)
      await waitFor(() => {
        expect(countInvokes('cancel_pairing')).toBe(1)
      })

      // Reopen while that DELETE is still in flight.
      rerender(<PairingDialog open onOpenChange={vi.fn()} />)
      await flushMicrotasks()
      expect(countInvokes('start_pairing')).toBe(1)

      // Only once the clear has actually landed may a new window be armed.
      resolveCancel()
      await waitFor(() => {
        expect(countInvokes('start_pairing')).toBe(2)
      })
      expect(await screen.findByText('alpha bravo charlie delta')).toBeInTheDocument()
    })

    // -------------------------------------------------------------------
    // #3620.3 — `handleSwitchToJoiner` cleared `backendArmedRef` BEFORE
    // awaiting its cancel, contradicting the invariant
    // `executeCancelPairingExplicit` documents: the ref means "something is
    // armed on the backend", so a clear that never landed must leave it
    // armed. Mirrors the #3610 test for the waiting-screen Cancel: the
    // proof that the ref survived is that the close/unmount cleanup still
    // attempts its own retry.
    // -------------------------------------------------------------------
    it('a failed cancel while switching to the joiner path leaves the marker armed for the close/unmount retry (#3620)', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing') return mockPairingInfo
        if (cmd === 'list_peer_refs') return []
        if (cmd === 'cancel_pairing') throw new Error('db write failed')
        return undefined
      })

      const { rerender } = render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('alpha bravo charlie delta')

      // Switching to the joiner path cancels the host's own session — and
      // that cancel fails (e.g. a DB write error).
      await selectJoinerRole(user)
      await screen.findByLabelText('Passphrase word 1')

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to cancel pairing')
      })
      expect(countInvokes('cancel_pairing')).toBe(1)

      // Let the retry succeed so its own outcome doesn't confound the
      // assertion, then close the dialog for real.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_peer_refs') return []
        return undefined
      })
      rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)

      // The host's window is still armed — the marker the failed switch
      // never actually tore down gets its one retry on close.
      await waitFor(() => {
        expect(countInvokes('cancel_pairing')).toBe(2)
      })
    })

    // -------------------------------------------------------------------
    // #3615 (review) — the host's arm and the host's baseline do NOT land
    // together: `start_pairing` and the peer read race inside `initHost`'s
    // `Promise.all`, and it is `start_pairing` resolving that sets
    // `pairingInfo` and so arms the poll. If the poll may arm inside that
    // window it runs with the PREVIOUS attempt's baseline (or, on first
    // open, the initial empty set) under a wait id that still matches, and
    // its very first result — the device's existing peers — reads as a
    // brand-new pin. That is #3469's false success arriving on the host
    // path, and it also disarms `backendArmedRef`, orphaning the real
    // pairing window it was still holding.
    //
    // Both guards are asserted separately, because either one alone hides
    // the other's absence: `!loading` stops the poll arming at all (the
    // invoke-count assertion), and clearing the baseline to UNKNOWN makes
    // any poll that does slip through fail closed (the toast assertion).
    // -------------------------------------------------------------------
    it('host: a slow init peer read cannot make an already-paired peer look like a fresh pair (#3615)', async () => {
      const onOpenChange = vi.fn()
      const existing = { ...newPeer, peer_id: 'peer-already-paired-000' }
      let listCalls = 0
      let resolveInitList: () => void = () => {}
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing') return mockPairingInfo
        if (cmd === 'list_peer_refs') {
          listCalls += 1
          if (listCalls === 1) {
            // The read that establishes the host's baseline hangs while
            // `start_pairing` — its `Promise.all` partner — resolves at once.
            return new Promise((resolve) => {
              resolveInitList = () => resolve([existing])
            })
          }
          return [existing]
        }
        return undefined
      })

      render(<PairingDialog open onOpenChange={onOpenChange} />)
      await flushMicrotasks()

      // The window is armed and `pairingInfo` is set, but the baseline is
      // still in flight — the poll must not have armed against it.
      expect(countInvokes('list_peer_refs')).toBe(1)
      // ...and nothing has paired, so the dialog must not claim otherwise.
      expect(toast.success).not.toHaveBeenCalled()
      expect(onOpenChange).not.toHaveBeenCalledWith(false)

      // Once the baseline lands the poll arms normally, and the peer that
      // was in that baseline is still not a fresh pair.
      resolveInitList()
      await flushMicrotasks()
      expect(screen.getByText('alpha bravo charlie delta')).toBeInTheDocument()
      expect(toast.success).not.toHaveBeenCalled()
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
    })
  })

  // -----------------------------------------------------------------------
  // #3628 — an arm that is IN FLIGHT is still an arm.
  //
  // `backendArmedRef` used to be set when an arming IPC RESOLVED, which left
  // the round-trip itself unguarded: close the dialog between `start_pairing`
  // being dispatched and its reply landing, and the close cleanup found the
  // ref false, tore nothing down, and then watched the reply arm a
  // device-global pending-pairing marker with no dialog behind it. That
  // marker is what `get_pending_pairing_proof` reads to admit an unpaired
  // device, and it holds the sync daemon awake and announcing for its full
  // 5-minute TTL — a live pairing window for a passphrase the user never even
  // saw, with nothing on screen to cancel.
  //
  // Both tests assert the SAME two-part construction, on the host arm and on
  // the joiner's mirror of it:
  //  1. no `cancel_pairing` while the arm is still in flight — the clear is
  //     queued behind the arm, because a DELETE that overtakes the upsert it
  //     is meant to undo deletes nothing and leaves the arm standing; and
  //  2. exactly one `cancel_pairing`, after the arm lands.
  // Either half alone passes against a half-fix, so both are asserted.
  // -----------------------------------------------------------------------
  describe('#3628 an arm in flight is still an arm', () => {
    it('host: closing while start_pairing is in flight disarms the window that arm creates', async () => {
      let resolveStart: () => void = () => {}
      const mutations: string[] = []
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing' || cmd === 'cancel_pairing') mutations.push(cmd)
        if (cmd === 'start_pairing') {
          return new Promise((resolve) => {
            resolveStart = () => resolve(mockPairingInfo)
          })
        }
        if (cmd === 'list_peer_refs') return []
        return undefined
      })

      const { rerender } = render(<PairingDialog open onOpenChange={vi.fn()} />)
      await flushMicrotasks()

      // The arm is dispatched but unanswered: the dialog is still on its
      // loading skeleton, so nothing has been shown that could be cancelled
      // from the UI. This is the whole window the bug lived in.
      expect(countInvokes('start_pairing')).toBe(1)
      expect(screen.queryByText('alpha bravo charlie delta')).not.toBeInTheDocument()

      // Close inside it — the interleaving #3628 is about. A parent flipping
      // `open` is the documented escape hatch past the close guard, and is
      // how a route change or an app-level dismiss closes this dialog.
      rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)
      await flushMicrotasks()

      // Not yet: `cancel_pairing` deletes the same single row `start_pairing`
      // upserts, so a clear that runs first would delete a row that does not
      // exist and let the arm behind it stand — the bug wearing a different
      // hat.
      expect(countInvokes('cancel_pairing')).toBe(0)

      // The arm lands. The marker is now live on the backend...
      resolveStart()
      await waitFor(() => {
        expect(countInvokes('cancel_pairing')).toBe(1)
      })
      // ...and the close that already happened is what tore it down, in that
      // order.
      expect(mutations).toEqual(['start_pairing', 'cancel_pairing'])
    })

    it('joiner: closing while confirm_pairing is in flight disarms the marker that arm creates', async () => {
      const user = userEvent.setup()
      let resolveConfirm: () => void = () => {}
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing') return mockPairingInfo
        if (cmd === 'list_peer_refs') return []
        if (cmd === 'confirm_pairing') {
          return new Promise((resolve) => {
            resolveConfirm = () => resolve(undefined)
          })
        }
        return undefined
      })

      const { rerender } = render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('alpha bravo charlie delta')

      // Switching to the joiner path tears down this device's host session —
      // that is the one `cancel_pairing` on the clock before the interesting
      // part starts.
      await selectJoinerRole(user)
      await screen.findByLabelText('Passphrase word 1')
      await waitFor(() => {
        expect(countInvokes('cancel_pairing')).toBe(1)
      })

      const inputs = screen.getAllByRole('textbox')
      await user.type(inputs[0] as HTMLElement, 'echo')
      await user.type(inputs[1] as HTMLElement, 'foxtrot')
      await user.type(inputs[2] as HTMLElement, 'golf')
      await user.type(inputs[3] as HTMLElement, 'hotel')
      await user.click(screen.getByRole('button', { name: /^Pair$/i }))

      await waitFor(() => {
        expect(countInvokes('confirm_pairing')).toBe(1)
      })

      // Close while `confirm_pairing` is unanswered — the joiner's mirror of
      // the host window above.
      rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)
      await flushMicrotasks()
      expect(countInvokes('cancel_pairing')).toBe(1)

      resolveConfirm()
      await waitFor(() => {
        expect(countInvokes('cancel_pairing')).toBe(2)
      })
    })
  })

  // -----------------------------------------------------------------------
  // #3714/#3715 — the queue's scope and its bound.
  //
  // Every other test in this file passes `onOpenChange={vi.fn()}`, so `open`
  // never flips and the close/unmount cleanup effect never runs: production's
  // SECOND clear — the one that makes the fire-and-forget teardown safe — is
  // invisible to them (#3714). And every test drove one component instance,
  // where a per-instance queue is indistinguishable from a device-scoped one
  // (#3715).
  // -----------------------------------------------------------------------
  describe('#3714/#3715 the queue is device-scoped and bounded', () => {
    /**
     * Unmount and let the close/unmount cleanup's `cancel_pairing` be
     * DISPATCHED inside the test that armed it.
     *
     * Every test here ends with a live pairing window, so RTL's `afterEach`
     * `cleanup()` fires that clear — and `pairingMutations.cancel()` reaches
     * `invoke` a microtask later, which can be after the NEXT test's
     * `vi.clearAllMocks()`. The stray call is then counted against a test that
     * never made it (it is the current `mockImplementation` that records it),
     * which is a real flake: it passed in isolation and failed in the full
     * suite. Draining it here keeps each test's counts its own.
     *
     * This is a single `flushMicrotasks()` pass, not a loop — it relies on
     * every test in this describe supplying its resolvers up front, so
     * whatever `unmount()` enqueues settles inside that one flush. The
     * "shows loading state while the host is initializing" test above
     * hand-rolls a *looping* drain instead, because there nothing
     * is resolved until after `unmount()`, so the mutation queue can need
     * more than one hop to surface `cancel_pairing` on `pendingInvokes`. Not
     * consolidated into one helper — if you change either drain, check
     * whether the other site's assumption (single-flush vs. needs-a-loop)
     * still holds.
     */
    async function unmountAndDrain(unmount: () => void) {
      unmount()
      await flushMicrotasks()
    }

    /**
     * Holds `open` in state the way `DeviceManagement` does, so
     * `onOpenChange(false)` genuinely closes the dialog instead of being
     * swallowed by a spy. Without this the cleanup effect never fires and
     * only the first of the two clears is observable (#3714).
     */
    function PairingDialogHarness() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen pairing
          </button>
          <PairingDialog open={open} onOpenChange={setOpen} />
        </>
      )
    }

    it('an explicit Cancel of an armed window lands BOTH clears, in order, and a reopen arms only behind them (#3714)', async () => {
      const user = userEvent.setup()
      const mutations: string[] = []
      const pendingCancels: Array<() => void> = []
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing' || cmd === 'cancel_pairing') mutations.push(cmd)
        if (cmd === 'start_pairing') return mockPairingInfo
        if (cmd === 'list_peer_refs') return []
        if (cmd === 'cancel_pairing') {
          return new Promise((resolve) => {
            pendingCancels.push(() => resolve(undefined))
          })
        }
        return undefined
      })

      const { unmount } = render(<PairingDialogHarness />)
      await screen.findByText('alpha bravo charlie delta')
      expect(countInvokes('start_pairing')).toBe(1)

      // Cancel the live host window through the close guard — the explicit
      // Cancel path, which since #3628 dispatches its clear and closes
      // without waiting for it.
      await user.keyboard('{Escape}')
      await screen.findByText('Cancel pairing?')
      await user.click(screen.getByRole('button', { name: /^Cancel pairing$/i }))

      await waitFor(() => {
        expect(countInvokes('cancel_pairing')).toBe(1)
      })
      // The close really happened — that is what makes the cleanup effect
      // run, and it is exactly what `onOpenChange={vi.fn()}` hides.
      expect(screen.queryByText('alpha bravo charlie delta')).not.toBeInTheDocument()

      // The cleanup's clear is BEHIND the explicit one, not alongside it: it
      // has been dispatched into the queue, and the queue is still holding it
      // because the first clear has not answered.
      await flushMicrotasks()
      expect(countInvokes('cancel_pairing')).toBe(1)

      pendingCancels[0]?.()
      await waitFor(() => {
        expect(countInvokes('cancel_pairing')).toBe(2)
      })

      // Reopen while the second clear is still in flight. Its arm must not
      // overtake it — a `start_pairing` that lands first has its row deleted
      // by the clear behind it, which is #3620 with a passphrase on screen.
      await user.click(screen.getByRole('button', { name: /Reopen pairing/i }))
      await flushMicrotasks()
      expect(countInvokes('start_pairing')).toBe(1)

      pendingCancels[1]?.()
      await waitFor(() => {
        expect(countInvokes('start_pairing')).toBe(2)
      })
      expect(mutations).toEqual([
        'start_pairing',
        'cancel_pairing',
        'cancel_pairing',
        'start_pairing',
      ])
      expect(await screen.findByText('alpha bravo charlie delta')).toBeInTheDocument()

      await unmountAndDrain(unmount)
    })

    it('a remount cannot arm a window ahead of the previous instance’s in-flight clear (#3715)', async () => {
      const mutations: string[] = []
      let resolveCancel: () => void = () => {}
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'start_pairing' || cmd === 'cancel_pairing') mutations.push(cmd)
        if (cmd === 'start_pairing') return mockPairingInfo
        if (cmd === 'list_peer_refs') return []
        if (cmd === 'cancel_pairing') {
          return new Promise((resolve) => {
            resolveCancel = () => resolve(undefined)
          })
        }
        return undefined
      })

      const first = render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('alpha bravo charlie delta')
      expect(countInvokes('start_pairing')).toBe(1)

      // A real unmount, not a `rerender` to `open={false}`: the queue used to
      // live on the component instance, and an unmount is where a
      // per-instance queue and a device-scoped one stop agreeing.
      first.unmount()
      await waitFor(() => {
        expect(countInvokes('cancel_pairing')).toBe(1)
      })

      // A brand-new instance — empty queue, if the queue were its own.
      const second = render(<PairingDialog open onOpenChange={vi.fn()} />)
      await flushMicrotasks()
      expect(countInvokes('start_pairing')).toBe(1)

      resolveCancel()
      await waitFor(() => {
        expect(countInvokes('start_pairing')).toBe(2)
      })
      expect(mutations).toEqual(['start_pairing', 'cancel_pairing', 'start_pairing'])
      expect(await screen.findByText('alpha bravo charlie delta')).toBeInTheDocument()

      await unmountAndDrain(second.unmount)
    })

    it('a start_pairing that never answers surfaces the bound through the error banner (#3715)', async () => {
      vi.useFakeTimers()
      try {
        mockedInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'start_pairing') return new Promise(() => {})
          if (cmd === 'list_peer_refs') return []
          return undefined
        })

        const { unmount } = render(<PairingDialog open onOpenChange={vi.fn()} />)
        await flushMicrotasks()
        expect(countInvokes('start_pairing')).toBe(1)
        // Before the bound: the dialog is on its loading skeleton with
        // nothing to tell the user, which is where it used to stay forever.
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()

        await act(async () => {
          await vi.advanceTimersByTimeAsync(PAIRING_MUTATION_TIMEOUT_MS)
        })
        await flushMicrotasks()

        expect(screen.getByRole('alert')).toHaveTextContent(
          'Failed to start pairing: the device stopped responding',
        )

        // The arm is still an arm even though it never answered, so the
        // unmount still tears it down — and draining it here keeps the stray
        // call out of the next test (see `unmountAndDrain`).
        await unmountAndDrain(unmount)
        expect(countInvokes('cancel_pairing')).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a wedged start_pairing cannot hold the close’s clear hostage (#3715)', async () => {
      vi.useFakeTimers()
      try {
        const mutations: string[] = []
        mockedInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'start_pairing' || cmd === 'cancel_pairing') mutations.push(cmd)
          if (cmd === 'start_pairing') return new Promise(() => {})
          if (cmd === 'list_peer_refs') return []
          return undefined
        })

        const { rerender } = render(<PairingDialog open onOpenChange={vi.fn()} />)
        await flushMicrotasks()
        expect(countInvokes('start_pairing')).toBe(1)

        // Close inside the unanswered arm. The clear is correctly queued
        // behind it — a DELETE that overtook the upsert would delete a row
        // that does not exist yet and let the late arm stand (#3628).
        rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)
        await flushMicrotasks()
        expect(countInvokes('cancel_pairing')).toBe(0)

        // ...but "behind it" must not mean "forever". The arm's bound expires,
        // the queue drops it, and the clear the close needs runs — instead of
        // the marker outliving the dialog for its full 5-minute TTL with no UI
        // behind it.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PAIRING_MUTATION_TIMEOUT_MS)
        })
        await flushMicrotasks()

        expect(countInvokes('cancel_pairing')).toBe(1)
        expect(mutations).toEqual(['start_pairing', 'cancel_pairing'])
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
    // The focus move lives in a passive effect keyed on `retryBtnRef`
    // (`if ((error || isExpired) && retryBtnRef.current) retryBtnRef.current.focus()`
    // in `PairingDialog.tsx`), and React schedules those asynchronously.
    // `findByRole('alert')` above resolves
    // as soon as the alert is in the DOM, which can be one poll BEFORE that
    // effect flushes — so asserting focus synchronously here is a race, and it
    // loses on a loaded CI runner. When it loses, `activeElement` is still Radix's
    // default (the dialog's close button), which reads like a focus-management
    // regression rather than a test-timing one. `waitFor` removes the race
    // without weakening the assertion: the wrong element still fails.
    //
    // The sibling assertion in "shows Retry button when the host session
    // expires and focuses it (#420, #430)" does NOT need this — it drives
    // fake timers inside `await act(...)`, which flushes effects before it
    // returns.
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
    // selectJoinerRole already cancelled it once when switching roles, so at
    // least one cancel_pairing has fired before this click.
    //
    // The absolute count is deliberately NOT pinned. How many session
    // start/cancel cycles the setup performs is timing-dependent: this read
    // `toBe(1)` and failed as 2 in full-suite runs while passing in isolation.
    // What the test actually means to assert is the DELTA around each action
    // below — the guard click adds none, and confirm_pairing landing adds
    // exactly one — so both are expressed relative to this baseline.
    const cancelCallsBeforeGuardClick = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'cancel_pairing',
    ).length
    expect(cancelCallsBeforeGuardClick).toBeGreaterThanOrEqual(1)

    await user.click(screen.getByRole('button', { name: /^Cancel pairing$/i }))

    // The dialog closes on the click, NOT on the backend answering. #3628 —
    // this device armed its marker the moment `confirm_pairing` was
    // dispatched, so the Cancel now does have a real teardown to perform;
    // making the close wait for it would hold the dialog open for as long as
    // the (here permanently) hung IPC.
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    // ...and that teardown has not fired yet, because it is queued behind
    // the arm it is meant to undo: a DELETE that overtook the upsert would
    // delete nothing and leave the marker armed for its full TTL.
    const cancelCallsAfterGuardClick = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'cancel_pairing',
    ).length
    expect(cancelCallsAfterGuardClick).toBe(cancelCallsBeforeGuardClick)

    // Once `confirm_pairing` answers, the marker it armed is torn down —
    // where before #3628 the guard's Cancel was a pure UI act and the marker
    // survived. (Two clears land: the explicit Cancel's, and the
    // close/unmount cleanup's unconditional retry behind it — the mock
    // `onOpenChange` above never flips `open`, so only the former runs here.)
    resolveConfirm(undefined)
    await waitFor(() => {
      const cancelCallsAfterConfirmLands = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'cancel_pairing',
      ).length
      expect(cancelCallsAfterConfirmLands).toBe(cancelCallsBeforeGuardClick + 1)
    })
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

  // #3628 (review) — the close guard asks "could a joiner be attempting
  // against something read off this screen?". `backendArmedRef` cannot
  // answer that any more: it is armed at dispatch and is never cleared when
  // `start_pairing` rejects, so keying the guard on it would pop "Cancel
  // pairing?" over a "Failed to start pairing" banner, where no passphrase
  // was ever rendered. The guard keys on the passphrase being on screen; the
  // backend clear stays keyed on the ref, because that arm may well be real.
  it('closes a failed host start without the guard, and still clears the backend', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') throw new Error('network error')
      if (cmd === 'list_peer_refs') return []
      return undefined
    })

    const onOpenChange = vi.fn()
    render(<PairingDialog open onOpenChange={onOpenChange} />)
    await selectHostRole(user)

    const errorEl = await screen.findByRole('alert')
    expect(errorEl).toHaveTextContent(/Failed to start pairing/i)

    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(screen.queryByText('Cancel pairing?')).not.toBeInTheDocument()

    // The dispatch may still have armed a window on the backend even though
    // the reply was an error, so the close disarms it rather than assuming.
    await waitFor(() => {
      const clears = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'cancel_pairing')
      expect(clears.length).toBeGreaterThan(0)
    })
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
      await screen.findByText('peer-abc-123...')

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

  // -----------------------------------------------------------------------
  // #3852 / PR #4034 note 4 — the OS-network-block banner is TRANSLATED.
  //
  // The daemon sends a key (`reason_key`), never prose, so the string on
  // screen has to come out of the i18n catalog. These tests drive the real
  // payload through the real hook into the real component and assert on the
  // rendered text; the i18n bundle is the production one (`src/test-setup.ts`
  // imports `@/lib/i18n`), so a catalog entry that went missing would render
  // the bare key and redden here.
  // -----------------------------------------------------------------------
  describe('#3852 OS network-block banner', () => {
    /** Deliver a payload through the registered `sync:network_blocked` handler. */
    async function emitNetworkBlock(payload: unknown) {
      const call = mockListen.mock.calls.find((c) => c[0] === 'sync:network_blocked')
      const handler = call?.[1] as ((e: { payload: unknown }) => void) | undefined
      expect(handler, 'the dialog must subscribe to sync:network_blocked').toBeTypeOf('function')
      await act(async () => {
        handler?.({ payload })
        await Promise.resolve()
      })
    }

    let hadTauriInternals = false

    beforeEach(() => {
      mockListen.mockResolvedValue(vi.fn())
      hadTauriInternals = '__TAURI_INTERNALS__' in window
      if (!hadTauriInternals) {
        Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
      }
      // `get_os_network_block_status` answers "not blocked" through
      // `AMBIENT_INVOKES`, so these event-driven tests keep asserting on the
      // event alone.
      mockInvokeByCommand({ start_pairing: mockPairingInfo, list_peer_refs: [] })
    })

    afterEach(() => {
      if (!hadTauriInternals) {
        Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
      }
    })

    it('renders the translated catalog string, not the daemon’s key and not English prose', async () => {
      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('Pair Device')
      await waitFor(() => {
        expect(mockListen).toHaveBeenCalledWith('sync:network_blocked', expect.any(Function))
      })

      await emitNetworkBlock({ blocked: true, reason_key: 'pairing.osNetworkBlocked' })

      const banner = await screen.findByTestId('pairing-network-blocked')
      // t('pairing.osNetworkBlocked') — the catalog entry, verbatim.
      expect(banner).toHaveTextContent(
        'This device paused the app’s network access. Keep the screen on and this app open while pairing.',
      )
      // The key itself must never reach the screen: i18next renders a missing
      // key as the key, which is the failure this assertion exists to catch.
      expect(banner).not.toHaveTextContent('pairing.osNetworkBlocked')
    })

    it('clears the banner when the OS restores access', async () => {
      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('Pair Device')
      await waitFor(() => {
        expect(mockListen).toHaveBeenCalledWith('sync:network_blocked', expect.any(Function))
      })

      await emitNetworkBlock({ blocked: true, reason_key: 'pairing.osNetworkBlocked' })
      expect(await screen.findByTestId('pairing-network-blocked')).toBeInTheDocument()

      await emitNetworkBlock({ blocked: false, reason_key: null })
      await waitFor(() => {
        expect(screen.queryByTestId('pairing-network-blocked')).not.toBeInTheDocument()
      })
    })

    /**
     * The close-and-reopen case, pinned because #4035 was originally written up
     * as being about it. It is not: a second dialog session on a still-live
     * block already showed the banner before this issue. `DeviceManagement`
     * mounts this dialog unconditionally and `if (!open) return null` sits
     * after every hook, so a close unmounts nothing; the subscription is gated
     * on `__TAURI_INTERNALS__` rather than on `open`, so it survives, and so
     * does the hook's `status`.
     *
     * The counts are what make that claim rather than merely illustrate it: the
     * reopen issues no second `listen` and no second status query, and no event
     * is emitted for it, so continuity of the listener is the only thing left
     * that can explain the banner. Verified directly too — with the status
     * query deleted from the hook entirely (i.e. `main`), everything here
     * except the two count assertions still passes.
     */
    it('keeps the banner across a close and reopen, with no second listener or query', async () => {
      const { rerender } = render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('Pair Device')
      await waitFor(() => {
        expect(mockListen).toHaveBeenCalledWith('sync:network_blocked', expect.any(Function))
      })
      await waitFor(() => expect(countInvokes('get_os_network_block_status')).toBe(1))

      await emitNetworkBlock({ blocked: true, reason_key: 'pairing.osNetworkBlocked' })
      expect(await screen.findByTestId('pairing-network-blocked')).toBeInTheDocument()

      rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)
      expect(screen.queryByTestId('pairing-network-blocked')).not.toBeInTheDocument()

      rerender(<PairingDialog open onOpenChange={vi.fn()} />)
      expect(await screen.findByTestId('pairing-network-blocked')).toBeInTheDocument()

      expect(countInvokes('get_os_network_block_status')).toBe(1)
      expect(
        mockListen.mock.calls.filter(([name]) => name === 'sync:network_blocked'),
      ).toHaveLength(1)
    })

    // ---------------------------------------------------------------------
    // #4035 — a block ALREADY IN PROGRESS when this UI started listening.
    //
    // The daemon spent the one event for that block before anything here was
    // subscribed — the user is on this screen *because* the network already
    // stopped working — and its dedup means the next event is the recovery.
    // So these tests emit NOTHING: everything on screen has to arrive through
    // the status query. Before #4035 the banner never appeared here and the
    // user was shown a clean pairing UI on a device whose network was cut.
    // ---------------------------------------------------------------------
    it('shows the translated banner for a block already in progress, with no event at all', async () => {
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        get_os_network_block_status: {
          blocked: true,
          reason_key: 'pairing.osNetworkBlocked',
        },
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('Pair Device')

      const banner = await screen.findByTestId('pairing-network-blocked')
      expect(banner).toHaveTextContent(
        'This device paused the app’s network access. Keep the screen on and this app open while pairing.',
      )
      expect(banner).not.toHaveTextContent('pairing.osNetworkBlocked')
    })

    it('a recovery event still clears a banner the status query raised', async () => {
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        get_os_network_block_status: {
          blocked: true,
          reason_key: 'pairing.osNetworkBlocked',
        },
      })

      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('Pair Device')
      expect(await screen.findByTestId('pairing-network-blocked')).toBeInTheDocument()

      await emitNetworkBlock({ blocked: false, reason_key: null })
      await waitFor(() => {
        expect(screen.queryByTestId('pairing-network-blocked')).not.toBeInTheDocument()
      })
    })

    it('the query-raised banner is accessible', async () => {
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        get_os_network_block_status: {
          blocked: true,
          reason_key: 'pairing.osNetworkBlocked',
        },
      })

      const { container } = render(<PairingDialog open onOpenChange={vi.fn()} />)
      await screen.findByText('Pair Device')
      await screen.findByTestId('pairing-network-blocked')

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // #4037 — the pairing QR payload gained `endpoint_id` and an `addrs` array
  // alongside `v` and `passphrase`, and the version tag went to 2.
  //
  // The scanner is the compatibility boundary and it is crossed in both
  // directions by real device pairs: a phone on an older build scans a v2 code
  // off a freshly-updated desktop, and a freshly-updated phone scans a v1 code
  // off a desktop that has not updated (or off any device with no bound
  // endpoint to advertise, which still emits the v1 shape by design).
  //
  // The parser survives both because it reads `passphrase` and ignores
  // everything else — it does not check `v`, which is exactly what makes the
  // new fields additive. That was true before this change and is untested;
  // these pin it, because the next person to "tighten" the parser by
  // validating `v` would break every joiner that is one release behind.
  describe('QR payload compatibility (#4037)', () => {
    async function scan(user: ReturnType<typeof userEvent.setup>, payload: string) {
      scannedPayload.current = payload
      render(<PairingDialog open onOpenChange={vi.fn()} />)
      await selectJoinerRole(user)
      await user.click(await screen.findByRole('button', { name: /Scan QR Code/i }))
      await user.click(await screen.findByTestId('mock-qr-scan'))
      await user.click(await screen.findByRole('button', { name: /Type Passphrase/i }))
    }

    function expectWordsFilled() {
      expect(screen.getByLabelText('Passphrase word 1')).toHaveValue('alpha')
      expect(screen.getByLabelText('Passphrase word 2')).toHaveValue('bravo')
      expect(screen.getByLabelText('Passphrase word 3')).toHaveValue('charlie')
      expect(screen.getByLabelText('Passphrase word 4')).toHaveValue('delta')
    }

    beforeEach(() => {
      mockInvokeByCommand({
        start_pairing: mockPairingInfo,
        list_peer_refs: [],
        cancel_pairing: undefined,
      })
    })

    // v2 → older joiner. The extra keys must not derail the passphrase.
    it('reads the passphrase out of a v2 payload carrying an endpoint and addresses', async () => {
      const user = userEvent.setup()
      await scan(
        user,
        JSON.stringify({
          v: 2,
          passphrase: 'alpha bravo charlie delta',
          endpoint_id: '8n7prc4b3ns4c9m4tvbjjqp62aiiff5v5rss3f2mmn2yg7q7bg9a',
          addrs: ['192.168.1.42:59553', '10.0.0.7:59553'],
        }),
      )
      expectWordsFilled()
    })

    // v1 → newer joiner. Nothing may become required.
    it('reads the passphrase out of a v1 payload with no endpoint or addresses', async () => {
      const user = userEvent.setup()
      await scan(user, JSON.stringify({ v: 1, passphrase: 'alpha bravo charlie delta' }))
      expectWordsFilled()
    })

    // The third shape the parser has always accepted, and the one with no `v`
    // at all — so "the parser does not depend on the version tag" is asserted
    // rather than assumed.
    it('still accepts a bare passphrase string that is not JSON', async () => {
      const user = userEvent.setup()
      await scan(user, 'alpha bravo charlie delta')
      expectWordsFilled()
    })

    it('the scan view is accessible', async () => {
      const user = userEvent.setup()
      scannedPayload.current = ''
      const { container } = render(<PairingDialog open onOpenChange={vi.fn()} />)
      await selectJoinerRole(user)
      await user.click(await screen.findByRole('button', { name: /Scan QR Code/i }))
      await screen.findByTestId('mock-qr-scan')

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
