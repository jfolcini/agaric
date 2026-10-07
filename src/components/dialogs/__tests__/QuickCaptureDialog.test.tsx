/**
 * Tests for QuickCaptureDialog.
 *
 *  - Renders Title + textarea + Capture / Cancel buttons.
 *  - Submitting via Capture button calls `quick_capture_block` and closes.
 *  - A capture reloads the open journal page and bumps the graph / calendar
 *    signals; a failed one reloads nothing (#5291).
 *  - Submitting via Cmd / Ctrl + Enter mirrors button submit.
 *  - Cancel button closes without invoking the IPC.
 *  - Empty / whitespace-only submissions are blocked (button disabled).
 *  - IPC rejection path: shows error toast, keeps dialog open, re-enables
 * Inputs (IPC error-path coverage).
 *  - Dialog is reset (textarea cleared) on each open.
 *  - axe(container) accessibility audit.
 */

import { type InvokeArgs, invoke } from '@tauri-apps/api/core'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makeBlockRow } from '@/__tests__/fixtures'
import { type CommandReturns, deferred, stubInvoke } from '@/__tests__/helpers/invoke'
import { QuickCaptureDialog } from '@/components/dialogs/QuickCaptureDialog'
import { useCalendarPageDatesEpoch } from '@/hooks/useCalendarPageDates'
import { useIsMobile } from '@/hooks/useIsMobile'
import { getGraphStructureKey } from '@/lib/graph-structure-events'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { getPageStore, PageBlockStoreProvider } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

// The dialog swaps to a bottom Sheet via `useDialogOrSheet`
// when `useIsMobile()` is true. Mock the hook so each test can pin the
// viewport-state boolean.
vi.mock('@/hooks/useIsMobile', () => ({
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
  // QuickCaptureDialog reads `currentSpaceId` from
  // `useSpaceStore` and passes it through `quickCaptureBlock`. Seed
  // a fixed space so the IPC arg shape is deterministic.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_PERSONAL',
    availableSpaces: [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null }],
    isReady: true,
  })
  // A capture reloads the views it touched, so route IPC through the in-memory
  // backend; a test that needs a failure overrides it.
  seedBlocks()
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

describe('QuickCaptureDialog', () => {
  it('renders the dialog with title, textarea, and Capture/Cancel buttons', () => {
    render(<QuickCaptureDialog open onOpenChange={() => {}} />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(t('quickCapture.dialogTitle'))).toBeInTheDocument()
    expect(screen.getByPlaceholderText(t('quickCapture.placeholder'))).toBeInTheDocument()
    expect(screen.getByTestId('quick-capture-save')).toBeInTheDocument()
    expect(screen.getByTestId('quick-capture-cancel')).toBeInTheDocument()
  })

  it('Capture button is disabled while the textarea is empty', () => {
    render(<QuickCaptureDialog open onOpenChange={() => {}} />)
    expect(screen.getByTestId('quick-capture-save')).toBeDisabled()
  })

  it('typing into the textarea enables the Capture button', async () => {
    const user = userEvent.setup()
    render(<QuickCaptureDialog open onOpenChange={() => {}} />)

    const textarea = screen.getByTestId('quick-capture-textarea')
    await user.type(textarea, 'hello')

    expect(screen.getByTestId('quick-capture-save')).toBeEnabled()
  })

  it('clicking Capture invokes quick_capture_block with the trimmed content and closes the dialog', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(<QuickCaptureDialog open onOpenChange={onOpenChange} />)

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

    render(<QuickCaptureDialog open onOpenChange={onOpenChange} />)
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

    render(<QuickCaptureDialog open onOpenChange={onOpenChange} />)
    await user.type(screen.getByTestId('quick-capture-textarea'), 'never sent')
    await user.click(screen.getByTestId('quick-capture-cancel'))

    expect(mockedInvoke).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // Every component that calls IPC must have a mockRejectedValue test.
  it('shows an error toast and stays open when quick_capture_block fails', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    stubInvoke(mockedInvoke, {
      quick_capture_block: () => Promise.reject(new Error('disk full')),
    })

    render(<QuickCaptureDialog open onOpenChange={onOpenChange} />)
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

  // Item #2281 — the Capture button must render the app-wide in-flight
  // <Spinner/> (not just go disabled) while the quick-capture IPC is pending.
  it('shows an in-flight Spinner in the Capture button while the capture is pending', async () => {
    const user = userEvent.setup()
    const capture = deferred<CommandReturns['quick_capture_block']>()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) =>
      cmd === 'quick_capture_block' ? capture.promise : dispatch(cmd, args),
    )

    render(<QuickCaptureDialog open onOpenChange={() => {}} />)
    await user.type(screen.getByTestId('quick-capture-textarea'), 'pending capture')
    await user.click(screen.getByTestId('quick-capture-save'))

    const saveBtn = screen.getByTestId('quick-capture-save')
    await waitFor(() => {
      expect(saveBtn.querySelector('[data-slot="spinner"]')).not.toBeNull()
    })

    // Settle the pending promise so the component finishes cleanly.
    capture.resolve(
      makeBlockRow({ id: 'BLK_PENDING', content: 'pending capture', parent_id: 'PARENT' }),
    )
  })

  describe('after the capture settles (#5291)', () => {
    const CAPTURED = 'call Bob about the lease'

    async function renderOverLoadedDailyPage() {
      render(
        <>
          <PageBlockStoreProvider pageId={SEED_IDS.PAGE_DAILY}>{null}</PageBlockStoreProvider>
          <QuickCaptureDialog open onOpenChange={() => {}} />
        </>,
      )
      const store = getPageStore(SEED_IDS.PAGE_DAILY)
      if (!store) throw new Error('the daily page store did not register')
      await act(() => store.getState().load())
      return () => store.getState().blocks.map((b) => b.content)
    }

    async function capture(text: string) {
      const user = userEvent.setup()
      await user.type(screen.getByTestId('quick-capture-textarea'), text)
      await user.click(screen.getByTestId('quick-capture-save'))
    }

    it('reloads the open page and bumps the graph and journal-date signals', async () => {
      const dailyContents = await renderOverLoadedDailyPage()
      expect(dailyContents()).not.toContain(CAPTURED)
      const graphKeyBefore = getGraphStructureKey()
      const epoch = renderHook(() => useCalendarPageDatesEpoch())
      const epochBefore = epoch.result.current

      await capture(CAPTURED)

      await waitFor(() => expect(dailyContents()).toContain(CAPTURED))
      await waitFor(() => expect(epoch.result.current).toBe(epochBefore + 1))
      await waitFor(() => expect(getGraphStructureKey()).toBe(graphKeyBefore + 1))
    })

    it('reloads nothing when the capture fails', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
        if (cmd === 'quick_capture_block') throw new Error('disk full')
        return dispatch(cmd, args)
      })
      const dailyContents = await renderOverLoadedDailyPage()
      // Lands in the backend behind the store's back, so only a reload shows it.
      dispatch('create_block', {
        blockType: 'content',
        content: 'written elsewhere',
        parentId: SEED_IDS.PAGE_DAILY,
      })
      const epoch = renderHook(() => useCalendarPageDatesEpoch())
      const epochBefore = epoch.result.current

      await capture(CAPTURED)

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(t('quickCapture.failureToast'))
      })
      await waitFor(() => expect(screen.getByTestId('quick-capture-save')).toBeEnabled())
      expect(dailyContents()).not.toContain('written elsewhere')
      expect(epoch.result.current).toBe(epochBefore)
    })
  })

  it('whitespace-only content keeps the Capture button disabled', async () => {
    const user = userEvent.setup()
    render(<QuickCaptureDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByTestId('quick-capture-textarea'), '    \n   ')
    expect(screen.getByTestId('quick-capture-save')).toBeDisabled()
  })

  it('passes axe accessibility audit', async () => {
    const { container } = render(<QuickCaptureDialog open onOpenChange={() => {}} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // The dialog must have exactly one accessible label source —
  // Radix derives it from <DialogTitle>, so the explicit aria-label on
  // DialogContent was redundant. The textarea must carry its own label
  // (not the dialog title) so screen readers don't mislabel the input.
  it('does not duplicate the dialog title as an aria-label on DialogContent', () => {
    render(<QuickCaptureDialog open onOpenChange={() => {}} />)

    const dialog = screen.getByRole('dialog')
    // Radix wires the dialog's accessible name via aria-labelledby pointing
    // at <DialogTitle>; a redundant aria-label would override that and
    // mask future title changes.
    expect(dialog).not.toHaveAttribute('aria-label', t('quickCapture.dialogTitle'))
  })

  it('labels the textarea with its own distinct aria-label (not the dialog title)', () => {
    render(<QuickCaptureDialog open onOpenChange={() => {}} />)

    const textarea = screen.getByTestId('quick-capture-textarea')
    expect(textarea).toHaveAttribute('aria-label', t('quickCapture.captureInputLabel'))
    expect(textarea.getAttribute('aria-label')).not.toBe(t('quickCapture.dialogTitle'))
  })

  // The dialog mounts under both the desktop Dialog path and
  // the mobile Sheet path. Assert on body content (the capture textarea)
  // being visible rather than the Dialog / Sheet DOM specifics so the
  // test stays decoupled from the underlying primitive.
  describe('mobile / desktop responsive surfaces', () => {
    it('renders the capture textarea on the mobile Sheet path', () => {
      mockedUseIsMobile.mockReturnValue(true)
      render(<QuickCaptureDialog open onOpenChange={() => {}} />)

      expect(screen.getByTestId('quick-capture-textarea')).toBeInTheDocument()
      expect(screen.getByPlaceholderText(t('quickCapture.placeholder'))).toBeInTheDocument()
    })

    it('renders the capture textarea on the desktop Dialog path', () => {
      mockedUseIsMobile.mockReturnValue(false)
      render(<QuickCaptureDialog open onOpenChange={() => {}} />)

      expect(screen.getByTestId('quick-capture-textarea')).toBeInTheDocument()
      expect(screen.getByPlaceholderText(t('quickCapture.placeholder'))).toBeInTheDocument()
    })
  })
})
