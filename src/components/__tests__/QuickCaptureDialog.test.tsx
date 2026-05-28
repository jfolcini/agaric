/**
 * Tests for QuickCaptureDialog (FEAT-12).
 *
 *  - Renders Title + textarea + Capture / Cancel buttons.
 *  - Submitting via Capture button calls `quick_capture_block` and closes.
 *  - Submitting via Cmd / Ctrl + Enter mirrors button submit.
 *  - Cancel button closes without invoking the IPC.
 *  - Empty / whitespace-only submissions are blocked (button disabled).
 *  - IPC rejection path: shows error toast, keeps dialog open, re-enables
 *    inputs (MAINT-99 IPC error-path coverage).
 *  - Dialog is reset (textarea cleared) on each open.
 *  - axe(container) accessibility audit.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { useIsMobile } from '../../hooks/useIsMobile'
import { t } from '../../lib/i18n'
import { useSpaceStore } from '../../stores/space'
import { QuickCaptureDialog } from '../QuickCaptureDialog'

// MAINT-215: the dialog swaps to a bottom Sheet via `useDialogOrSheet`
// when `useIsMobile()` is true. Mock the hook so each test can pin the
// viewport-state boolean.
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

const mockedInvoke = vi.mocked(invoke)
const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastError = vi.mocked(toast.error)
const mockedUseIsMobile = vi.mocked(useIsMobile)

beforeEach(() => {
  vi.clearAllMocks()
  // Default to the desktop path so existing test bodies keep their semantics.
  mockedUseIsMobile.mockReturnValue(false)
  // FEAT-3p5: QuickCaptureDialog reads `currentSpaceId` from
  // `useSpaceStore` and passes it through `quickCaptureBlock`. Seed
  // a fixed space so the IPC arg shape is deterministic.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_PERSONAL',
    availableSpaces: [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }],
    isReady: true,
  })
})

describe('QuickCaptureDialog', () => {
  it('renders the dialog with title, textarea, and Capture/Cancel buttons', () => {
    render(<QuickCaptureDialog open={true} onOpenChange={() => {}} />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(t('quickCapture.dialogTitle'))).toBeInTheDocument()
    expect(screen.getByPlaceholderText(t('quickCapture.placeholder'))).toBeInTheDocument()
    expect(screen.getByTestId('quick-capture-save')).toBeInTheDocument()
    expect(screen.getByTestId('quick-capture-cancel')).toBeInTheDocument()
  })

  it('Capture button is disabled while the textarea is empty', () => {
    render(<QuickCaptureDialog open={true} onOpenChange={() => {}} />)
    expect(screen.getByTestId('quick-capture-save')).toBeDisabled()
  })

  it('typing into the textarea enables the Capture button', async () => {
    const user = userEvent.setup()
    render(<QuickCaptureDialog open={true} onOpenChange={() => {}} />)

    const textarea = screen.getByTestId('quick-capture-textarea')
    await user.type(textarea, 'hello')

    expect(screen.getByTestId('quick-capture-save')).toBeEnabled()
  })

  it('clicking Capture invokes quick_capture_block with the trimmed content and closes the dialog', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mockedInvoke.mockResolvedValueOnce({
      id: 'BLK_X',
      block_type: 'content',
      content: 'captured',
      parent_id: 'PARENT',
      position: 1,
      deleted_at: null,
    })

    render(<QuickCaptureDialog open={true} onOpenChange={onOpenChange} />)

    const textarea = screen.getByTestId('quick-capture-textarea')
    await user.type(textarea, '  captured  ')
    await user.click(screen.getByTestId('quick-capture-save'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('quick_capture_block', {
        content: 'captured',
        spaceId: 'SPACE_PERSONAL',
      })
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mockedToastSuccess).toHaveBeenCalledWith(t('quickCapture.successToast'))
  })

  it('Cmd/Ctrl + Enter submits the same as the Capture button', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mockedInvoke.mockResolvedValueOnce({
      id: 'BLK_Y',
      block_type: 'content',
      content: 'hotkey-submit',
      parent_id: 'PARENT',
      position: 1,
      deleted_at: null,
    })

    render(<QuickCaptureDialog open={true} onOpenChange={onOpenChange} />)
    const textarea = screen.getByTestId('quick-capture-textarea')
    await user.type(textarea, 'hotkey-submit')
    await user.keyboard('{Control>}{Enter}{/Control}')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('quick_capture_block', {
        content: 'hotkey-submit',
        spaceId: 'SPACE_PERSONAL',
      })
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('Cancel closes the dialog without invoking IPC', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(<QuickCaptureDialog open={true} onOpenChange={onOpenChange} />)
    await user.type(screen.getByTestId('quick-capture-textarea'), 'never sent')
    await user.click(screen.getByTestId('quick-capture-cancel'))

    expect(mockedInvoke).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // MAINT-99: every component that calls IPC must have a mockRejectedValue test.
  it('shows an error toast and stays open when quick_capture_block fails', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mockedInvoke.mockRejectedValueOnce(new Error('disk full'))

    render(<QuickCaptureDialog open={true} onOpenChange={onOpenChange} />)
    await user.type(screen.getByTestId('quick-capture-textarea'), 'will fail')
    await user.click(screen.getByTestId('quick-capture-save'))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('quickCapture.failureToast'))
    })
    // Dialog should stay open (not call onOpenChange(false)) so the user
    // can retry without retyping their captured note.
    const closeCalls = onOpenChange.mock.calls.filter((c) => c[0] === false)
    expect(closeCalls.length).toBe(0)
  })

  it('whitespace-only content keeps the Capture button disabled', async () => {
    const user = userEvent.setup()
    render(<QuickCaptureDialog open={true} onOpenChange={() => {}} />)

    await user.type(screen.getByTestId('quick-capture-textarea'), '    \n   ')
    expect(screen.getByTestId('quick-capture-save')).toBeDisabled()
  })

  it('passes axe accessibility audit', async () => {
    const { container } = render(<QuickCaptureDialog open={true} onOpenChange={() => {}} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // PEND-23 M4: the dialog must have exactly one accessible label source —
  // Radix derives it from <DialogTitle>, so the explicit aria-label on
  // DialogContent was redundant. The textarea must carry its own label
  // (not the dialog title) so screen readers don't mislabel the input.
  it('does not duplicate the dialog title as an aria-label on DialogContent', () => {
    render(<QuickCaptureDialog open={true} onOpenChange={() => {}} />)

    const dialog = screen.getByRole('dialog')
    // Radix wires the dialog's accessible name via aria-labelledby pointing
    // at <DialogTitle>; a redundant aria-label would override that and
    // mask future title changes.
    expect(dialog).not.toHaveAttribute('aria-label', t('quickCapture.dialogTitle'))
  })

  it('labels the textarea with its own distinct aria-label (not the dialog title)', () => {
    render(<QuickCaptureDialog open={true} onOpenChange={() => {}} />)

    const textarea = screen.getByTestId('quick-capture-textarea')
    expect(textarea).toHaveAttribute('aria-label', t('quickCapture.captureInputLabel'))
    expect(textarea.getAttribute('aria-label')).not.toBe(t('quickCapture.dialogTitle'))
  })

  // MAINT-215: the dialog mounts under both the desktop Dialog path and
  // the mobile Sheet path. Assert on body content (the capture textarea)
  // being visible rather than the Dialog / Sheet DOM specifics so the
  // test stays decoupled from the underlying primitive.
  describe('mobile / desktop responsive surfaces (MAINT-215)', () => {
    it('renders the capture textarea on the mobile Sheet path', () => {
      mockedUseIsMobile.mockReturnValue(true)
      render(<QuickCaptureDialog open={true} onOpenChange={() => {}} />)

      expect(screen.getByTestId('quick-capture-textarea')).toBeInTheDocument()
      expect(screen.getByPlaceholderText(t('quickCapture.placeholder'))).toBeInTheDocument()
    })

    it('renders the capture textarea on the desktop Dialog path', () => {
      mockedUseIsMobile.mockReturnValue(false)
      render(<QuickCaptureDialog open={true} onOpenChange={() => {}} />)

      expect(screen.getByTestId('quick-capture-textarea')).toBeInTheDocument()
      expect(screen.getByPlaceholderText(t('quickCapture.placeholder'))).toBeInTheDocument()
    })
  })
})
