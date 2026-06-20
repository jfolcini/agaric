/**
 * Tests for PairingDialog component.
 *
 * Validates:
 *  - Renders without crashing
 *  - Shows QR code when pairing info is loaded
 *  - Shows 4 word input fields
 *  - Pair button calls confirmPairing with entered words
 *  - Cancel button calls cancelPairing
 *  - Shows paired devices list
 *  - Unpair button calls deletePeerRef
 *  - Paste support distributes words across inputs
 *  - Space auto-advances focus
 *  - Enter submits pairing
 *  - Retry button re-initializes on error
 *  - Countdown timer and session expiry
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
import { useIpcCommand } from '@/hooks/useIpcCommand'
import { announce } from '@/lib/announcer'
import { logger } from '@/lib/logger'

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

// FE-H-12: capture logger.warn so we can assert the doInit() rejection path.
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// FE-H-12: spy-mock useIpcCommand so individual tests can swap in a rejecting
// `executeInit` while leaving the hook's real behavior in place for everything
// else (and for every other test in this file).
vi.mock('@/hooks/useIpcCommand', async () => {
  const actual =
    await vi.importActual<typeof import('@/hooks/useIpcCommand')>('@/hooks/useIpcCommand')
  return {
    ...actual,
    useIpcCommand: vi.fn(actual.useIpcCommand),
  }
})

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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PairingDialog', () => {
  it('renders without crashing when closed', () => {
    render(<PairingDialog open={false} onOpenChange={vi.fn()} />)
    // Should render nothing visible
    expect(screen.queryByText('Pair Device')).not.toBeInTheDocument()
  })

  it('renders dialog when open', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    expect(await screen.findByText('Pair Device')).toBeInTheDocument()
  })

  it('shows QR code when pairing info is loaded (backend SVG)', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // The QR is rendered via dangerouslySetInnerHTML with the backend SVG
    const qr = await screen.findByTestId('pairing-qr-code')
    expect(qr).toBeInTheDocument()
    // Backend SVG should be injected as innerHTML
    expect(qr.innerHTML).toContain('<svg')
    expect(qr.innerHTML).toContain('backend-qr')
  })

  it('shows passphrase when pairing info is loaded', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    expect(await screen.findByText('alpha bravo charlie delta')).toBeInTheDocument()
  })

  it('shows 4 word input fields', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for loading to finish
    await screen.findByText('alpha bravo charlie delta')

    const inputs = screen.getAllByRole('textbox')
    // 4 word inputs
    expect(inputs.length).toBe(4)

    // Check aria-labels
    expect(screen.getByLabelText('Passphrase word 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 2')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 3')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 4')).toBeInTheDocument()
  })

  it('Pair button calls confirmPairing with entered words', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      confirm_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for loading to finish
    await screen.findByText('alpha bravo charlie delta')

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
  })

  it('Pair button is disabled when words are empty', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for loading to finish
    await screen.findByText('alpha bravo charlie delta')

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    expect(pairBtn).toBeDisabled()
  })

  it('Cancel button calls cancelPairing and closes dialog', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={onOpenChange} />)

    // Wait for loading to finish
    await screen.findByText('alpha bravo charlie delta')

    const cancelBtn = screen.getByRole('button', { name: /Cancel/i })
    await user.click(cancelBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows paired devices list', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: mockPeers,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for loading to finish
    await screen.findByText('Paired Devices')

    // Check peer IDs are shown
    expect(await screen.findByText('peer-abc-1234567890')).toBeInTheDocument()
    expect(screen.getByText('peer-def-0987654321')).toBeInTheDocument()

    // "Never synced" for the second peer (inside "Last: Never synced")
    expect(screen.getByText(/Never synced/)).toBeInTheDocument()
  })

  it('shows no paired devices message when empty', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    expect(await screen.findByText('No paired devices yet.')).toBeInTheDocument()
  })

  it('Unpair button calls deletePeerRef after confirmation', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: mockPeers,
      delete_peer_ref: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

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
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') throw new Error('network error')
      if (cmd === 'list_peer_refs') return []
      return undefined
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Error text includes the backend error message
    const errorEl = await screen.findByRole('alert')
    expect(errorEl).toHaveTextContent(/Failed to start pairing:.*network error/i)
  })

  it('shows error with backend message when confirmPairing fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') return mockPairingInfo
      if (cmd === 'list_peer_refs') return []
      if (cmd === 'confirm_pairing') throw new Error('invalid passphrase')
      return undefined
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    await screen.findByText('alpha bravo charlie delta')

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

  it('shows loading state while initializing', async () => {
    // Make start_pairing hang
    mockedInvoke.mockImplementation(
      () => new Promise(() => {}), // never resolves
    )

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      const loadingEl = document.querySelector('.pairing-loading')
      expect(loadingEl).toBeTruthy()
      expect(loadingEl?.textContent).toContain('Starting pairing...')
    })
  })

  it('has no a11y violations when open with pairing info', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for content to load
    await screen.findByText('alpha bravo charlie delta')

    const results = await axe(document.body)
    expect(results).toHaveNoViolations()
  })

  it('calls cancelPairing when dialog closes via onOpenChange(false)', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    const { rerender } = render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for pairing to start
    await screen.findByText('alpha bravo charlie delta')

    // Simulate parent closing the dialog
    rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)

    // cancelPairing should be called by the cleanup effect
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
    })
  })

  it('calls cancelPairing on unmount', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for pairing to start
    await screen.findByText('alpha bravo charlie delta')

    // Unmount the component
    cleanup()

    // cancelPairing should be called by the cleanup effect
    expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
  })

  it('dialog has aria-labelledby pointing to the title', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

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
  // New tests for issues #279, #282, #294, #295
  // -----------------------------------------------------------------------

  it('distributes pasted multi-word text across inputs (#279 paste)', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)
    await screen.findByText('alpha bravo charlie delta')

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
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)
    await screen.findByText('alpha bravo charlie delta')

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
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      confirm_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)
    await screen.findByText('alpha bravo charlie delta')

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

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

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

  it('shows countdown timer and session expired text (#294)', async () => {
    vi.useFakeTimers()

    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

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

    // Pair button should be disabled when expired
    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    expect(pairBtn).toBeDisabled()

    vi.useRealTimers()
  })

  it('word inputs container has responsive grid classes (#295)', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)
    await screen.findByText('alpha bravo charlie delta')

    const grid = document.querySelector('.pairing-word-inputs')
    expect(grid).toBeTruthy()
    expect(grid?.classList.contains('grid-cols-2')).toBe(true)
    expect(grid?.classList.contains('sm:grid-cols-4')).toBe(true)
  })

  it('returns focus to triggerRef on cancel (#288)', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const triggerRef = { current: document.createElement('button') }
    document.body.appendChild(triggerRef.current)
    triggerRef.current.textContent = 'Open Pairing'
    const focusSpy = vi.spyOn(triggerRef.current, 'focus')

    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={onOpenChange} triggerRef={triggerRef} />)

    await screen.findByText('alpha bravo charlie delta')

    const cancelBtn = screen.getByRole('button', { name: /Cancel/i })
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
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      confirm_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={onOpenChange} />)

    await screen.findByText('alpha bravo charlie delta')

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

  it('shows Retry button when session expires and focuses it (#420, #430)', async () => {
    vi.useFakeTimers()

    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

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

    vi.useRealTimers()
  })

  it('dialog body renders the DialogBody primitive so a tall dialog scrolls instead of clipping', async () => {
    // pending/dialog-responsiveness-primitive-2026-05-13: DialogBody owns the
    // scrollable region (flex-1 min-h-0 + ScrollArea); the frame stays
    // overflow-hidden via the DialogContent base so header/footer remain pinned.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing')
        return { passphrase: 'word1 word2 word3 word4', qr_svg: '<svg></svg>' }
      if (cmd === 'list_peer_refs') return []
      return null
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)
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

  it('shows error when listPeerRefs fails during init', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') return mockPairingInfo
      if (cmd === 'list_peer_refs') throw new Error('db connection lost')
      return undefined
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

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

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

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
      if (cmd === 'start_pairing') return mockPairingInfo
      if (cmd === 'list_peer_refs') {
        listCallCount++
        if (listCallCount === 1) return [] // initial load succeeds
        throw new Error('refresh failed') // post-pair refresh fails
      }
      if (cmd === 'confirm_pairing') return undefined
      return undefined
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    await screen.findByText('alpha bravo charlie delta')

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

  it('shows toast error when cancelPairing fails on dialog close', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') return mockPairingInfo
      if (cmd === 'list_peer_refs') return []
      if (cmd === 'cancel_pairing') throw new Error('cancel failed')
      return undefined
    })

    const { rerender } = render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    await screen.findByText('alpha bravo charlie delta')

    // Close the dialog — triggers useEffect cleanup which calls cancelPairing()
    rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to cancel pairing')
    })
  })

  it('moves focus to Retry button when error occurs (#430)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') throw new Error('network error')
      if (cmd === 'list_peer_refs') return []
      return undefined
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

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
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    const { unmount } = render(<PairingDialog open={true} onOpenChange={vi.fn()} />)
    await screen.findByText('alpha bravo charlie delta')

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
  // Countdown SR-only announcer thresholds (60s / 30s / 10s / expired)
  // -----------------------------------------------------------------------
  it('announces countdown only at SR-relevant thresholds', async () => {
    vi.useFakeTimers()
    const announceMock = vi.mocked(announce)
    announceMock.mockClear()

    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

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

    vi.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // Mid-pair close guard — confirm before aborting in-flight pairing
  // -----------------------------------------------------------------------
  it('shows close-guard ConfirmDialog when Esc is pressed mid-pair', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    // Make confirm_pairing hang so the dialog stays in pairLoading state
    let resolveConfirm: (value: unknown) => void = () => {}
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') return mockPairingInfo
      if (cmd === 'list_peer_refs') return []
      if (cmd === 'cancel_pairing') return undefined
      if (cmd === 'confirm_pairing') {
        return new Promise((resolve) => {
          resolveConfirm = resolve
        })
      }
      return undefined
    })

    render(<PairingDialog open={true} onOpenChange={onOpenChange} />)
    await screen.findByText('alpha bravo charlie delta')

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

    // Click "Cancel pairing" — should close the dialog and call cancelPairing.
    await user.click(screen.getByRole('button', { name: /^Cancel pairing$/i }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // Resolve hung promise so test cleanup runs
    resolveConfirm(undefined)
  })

  it('closes immediately without guard when not mid-pair', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    const onOpenChange = vi.fn()
    render(<PairingDialog open={true} onOpenChange={onOpenChange} />)
    await screen.findByText('alpha bravo charlie delta')

    // Press Escape (or any close vector) without an in-flight pairing.
    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    // No close-guard dialog should appear.
    expect(screen.queryByText('Cancel pairing?')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // Pause the countdown while the user is typing the passphrase so
  // a tick boundary doesn't expire the session mid-handshake. Auto-resumes
  // on blur or after 5s of keystroke idleness.
  // -----------------------------------------------------------------------
  it('pauses the countdown while the user is typing in a passphrase input', async () => {
    vi.useFakeTimers()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Flush init promises under fake timers.
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Countdown starts at the full 5:00 window.
    expect(screen.getByText(/Session expires in 5:00/)).toBeInTheDocument()

    const inputs = screen.getAllByRole('textbox')

    // Trigger a keystroke — flips pausedByTyping=true via onTypingStateChange.
    await act(async () => {
      fireEvent.change(inputs[0] as HTMLElement, { target: { value: 'a' } })
    })

    // Advance 2 seconds — the interval fires twice but the pausedRef gate
    // makes both ticks skip setCountdown, so the displayed value is unchanged.
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })

    expect(screen.getByText(/Session expires in 5:00/)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('resumes the countdown when the passphrase input is blurred', async () => {
    vi.useFakeTimers()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    const inputs = screen.getAllByRole('textbox')

    // Pause via typing, confirm it actually paused.
    await act(async () => {
      fireEvent.change(inputs[0] as HTMLElement, { target: { value: 'a' } })
    })
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    expect(screen.getByText(/Session expires in 5:00/)).toBeInTheDocument()

    // Blur — pausedByTyping flips back to false synchronously.
    await act(async () => {
      fireEvent.blur(inputs[0] as HTMLElement)
    })

    // After blur, the next 2s of ticks must decrement the countdown.
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })

    expect(screen.queryByText(/Session expires in 5:00/)).not.toBeInTheDocument()
    expect(screen.getByText(/Session expires in 4:58/)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('auto-resumes the countdown after 5s of idle keystrokes', async () => {
    vi.useFakeTimers()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    const inputs = screen.getAllByRole('textbox')

    // Type once, then go idle — the 5s debounce should fire, flipping
    // pausedByTyping back to false, and subsequent ticks must decrement.
    await act(async () => {
      fireEvent.change(inputs[0] as HTMLElement, { target: { value: 'a' } })
    })

    // Advance 6 seconds: 5s for the debounce + at least one resumed tick.
    await act(async () => {
      vi.advanceTimersByTime(6_000)
    })

    // The countdown must have resumed — it is no longer pinned at 5:00.
    expect(screen.queryByText(/Session expires in 5:00/)).not.toBeInTheDocument()
    // And the paused indicator must be gone.
    expect(screen.queryByText(/Paused while typing/i)).not.toBeInTheDocument()

    vi.useRealTimers()
  })

  it('shows "Paused while typing…" indicator while typing', async () => {
    vi.useFakeTimers()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Indicator absent at rest.
    expect(screen.queryByText(/Paused while typing/i)).not.toBeInTheDocument()

    const inputs = screen.getAllByRole('textbox')

    await act(async () => {
      fireEvent.change(inputs[0] as HTMLElement, { target: { value: 'a' } })
    })

    // Indicator present once typing flips pausedByTyping=true.
    expect(screen.getByText(/Paused while typing/i)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('announces countdown pause and resume so SR users hear the state change', async () => {
    vi.useFakeTimers()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    const announceMock = vi.mocked(announce)
    announceMock.mockClear()

    const inputs = screen.getAllByRole('textbox')

    // Typing → pause announce.
    await act(async () => {
      fireEvent.change(inputs[0] as HTMLElement, { target: { value: 'a' } })
    })
    expect(announceMock).toHaveBeenCalledWith('Pairing countdown paused while typing')

    announceMock.mockClear()

    // Blur → resume announce.
    await act(async () => {
      fireEvent.blur(inputs[0] as HTMLElement)
    })
    expect(announceMock).toHaveBeenCalledWith('Pairing countdown resumed')

    vi.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // FE-H-12: doInit().then(...) chain previously had no .catch, so any
  // rejection bubbled up as an unhandled promise rejection. Assert the new
  // `.catch` handler logs the failure via logger.warn instead.
  // -----------------------------------------------------------------------
  it('FE-H-12: logs warning when doInit rejects', async () => {
    const initError = new Error('init boom')
    const actualIpc =
      await vi.importActual<typeof import('@/hooks/useIpcCommand')>('@/hooks/useIpcCommand')

    // Swap useIpcCommand so the executeInit hook returns a rejecting execute,
    // while every other useIpcCommand call (cancel/pair/unpair) returns a
    // benign no-op execute. Restored in `finally` so subsequent tests in this
    // file see the default (delegate-to-actual) implementation again.
    vi.mocked(useIpcCommand).mockImplementation(((opts: { errorLogMessage: string }) => {
      if (opts.errorLogMessage === 'Failed to initialize pairing') {
        return { execute: () => Promise.reject(initError), loading: false }
      }
      return { execute: () => Promise.resolve(undefined), loading: false }
    }) as unknown as typeof useIpcCommand)

    try {
      render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

      await waitFor(() => {
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          'PairingDialog',
          'init failed',
          undefined,
          initError,
        )
      })
    } finally {
      vi.mocked(useIpcCommand).mockImplementation(actualIpc.useIpcCommand)
    }
  })
})
