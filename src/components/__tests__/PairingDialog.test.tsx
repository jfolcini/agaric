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
import { axe } from 'vitest-axe'
import { PairingDialog } from '../PairingDialog'

// Mock react-qr-code — no longer used by the component, but keep mock to avoid import errors
vi.mock('react-qr-code', () => ({
  default: ({ value, ...props }: { value: string; [key: string]: unknown }) => (
    <div data-testid="pairing-qr-code-legacy" data-value={value} {...props} />
  ),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../stores/sync', () => ({
  useSyncStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
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
    }),
}))

const mockedInvoke = vi.mocked(invoke)

const mockPairingInfo = {
  passphrase: 'alpha bravo charlie delta',
  qr_svg: '<svg data-testid="backend-qr"><rect/></svg>',
  port: 9000,
}

const mockPeers = [
  {
    peer_id: 'peer-abc-1234567890',
    last_hash: 'hash1',
    last_sent_hash: null,
    synced_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
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
    last_reset_at: '2025-01-01T00:00:00Z',
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
    await waitFor(() => {
      const errorEl = document.querySelector('.pairing-error')
      expect(errorEl).toBeTruthy()
      expect(errorEl?.textContent).toContain('Failed to start pairing:')
      expect(errorEl?.textContent).toContain('network error')
    })
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

    await waitFor(() => {
      const errorEl = document.querySelector('.pairing-error')
      expect(errorEl).toBeTruthy()
      expect(errorEl?.textContent).toContain('Pairing failed:')
      expect(errorEl?.textContent).toContain('invalid passphrase')
    })
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

    // Wait for error to appear (query via document to include Portal content)
    await waitFor(() => {
      const errorEl = document.querySelector('.pairing-error p')
      expect(errorEl).toBeTruthy()
      expect(errorEl?.textContent).toContain('network error')
    })

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
      expect(focusSpy).toHaveBeenCalled()
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

  it('dialog body has overflow-y-auto for small screens', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing')
        return { passphrase: 'word1 word2 word3 word4', qr_svg: '<svg></svg>', port: 8080 }
      if (cmd === 'list_peer_refs') return []
      return null
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      const dialog = document.querySelector('.pairing-dialog')
      expect(dialog).toBeInTheDocument()
      const scrollArea = dialog?.querySelector('[data-slot="scroll-area"]')
      expect(scrollArea).toBeInTheDocument()
      expect(scrollArea?.className).toContain('max-h-[calc(100dvh-4rem)]')
    })
  })

  it('moves focus to Retry button when error occurs (#430)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') throw new Error('network error')
      if (cmd === 'list_peer_refs') return []
      return undefined
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for error to appear (use document query for Portal content)
    await waitFor(() => {
      const errorEl = document.querySelector('.pairing-error p')
      expect(errorEl).toBeTruthy()
      expect(errorEl?.textContent).toContain('network error')
    })

    const retryBtn = screen.getByRole('button', { name: /Retry/i })
    expect(document.activeElement).toBe(retryBtn)
  })
})
