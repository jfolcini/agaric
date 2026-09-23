import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { PageSourceDialog } from '@/components/pages/PageSourceDialog'
import { flushActiveDraft } from '@/lib/active-draft-flush'
import { writeText } from '@/lib/clipboard'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'

vi.mock('@/lib/clipboard', () => ({
  writeText: vi.fn(),
}))

vi.mock('@/lib/active-draft-flush', () => ({
  flushActiveDraft: vi.fn(),
}))

const mockedInvoke = vi.mocked(invoke)
const mockedWriteText = vi.mocked(writeText)
const mockedFlushActiveDraft = vi.mocked(flushActiveDraft)

const PAGE_ID = '01J0000000000000000000PAGE'
const BUFFER = [
  '- - Groceries ^01J0000000000000000000000A',
  '  - 1. milk ^01J0000000000000000000000B',
  '  - 2. [ ] eggs ^01J0000000000000000000000C',
  '- [x] See ((01J0000000000000000000000D)) first ^01J0000000000000000000000E',
  '  priority:: 1',
  '',
].join('\n')

function renderDialog(open = true) {
  return render(<PageSourceDialog pageId={PAGE_ID} open={open} onOpenChange={vi.fn()} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedFlushActiveDraft.mockResolvedValue(undefined)
  mockedWriteText.mockResolvedValue(undefined)
  mockedInvoke.mockImplementation(mockInvokeCommands({ get_page_source: () => BUFFER }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PageSourceDialog', () => {
  it('shows the page source buffer verbatim', async () => {
    renderDialog()

    expect((await screen.findByTestId('page-source-content')).textContent).toBe(BUFFER)
    expect(mockedInvoke).toHaveBeenCalledWith('get_page_source', { pageId: PAGE_ID })
  })

  it('flushes the active draft before reading the source', async () => {
    const order: string[] = []
    mockedFlushActiveDraft.mockImplementation(async () => {
      order.push('flush')
    })
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        get_page_source: () => {
          order.push('get_page_source')
          return BUFFER
        },
      }),
    )

    renderDialog()

    await screen.findByTestId('page-source-content')
    expect(order).toEqual(['flush', 'get_page_source'])
  })

  it('re-reads the source on every open instead of showing the last one', async () => {
    const { rerender } = renderDialog()
    await screen.findByTestId('page-source-content')

    rerender(<PageSourceDialog pageId={PAGE_ID} open={false} onOpenChange={vi.fn()} />)
    mockedInvoke.mockImplementation(mockInvokeCommands({ get_page_source: () => '- fresh ^X\n' }))
    rerender(<PageSourceDialog pageId={PAGE_ID} open onOpenChange={vi.fn()} />)

    expect(screen.queryByTestId('page-source-content')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('page-source-content').textContent).toBe('- fresh ^X\n')
    })
  })

  it('keeps Copy disabled until the source has loaded', () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ get_page_source: () => new Promise<string>(() => {}) }),
    )

    renderDialog()

    expect(screen.getByRole('button', { name: t('pageSource.copy') })).toBeDisabled()
  })

  it('Copy writes the exact buffer to the clipboard and confirms', async () => {
    const user = userEvent.setup()
    renderDialog()
    await screen.findByTestId('page-source-content')

    await user.click(screen.getByRole('button', { name: t('pageSource.copy') }))

    await waitFor(() => {
      expect(mockedWriteText).toHaveBeenCalledWith(BUFFER)
    })
    expect(toast.success).toHaveBeenCalledWith(t('pageHeader.exportCopied'))
  })

  it('a failed clipboard write logs and shows the copy-failed toast', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const clipboardError = new Error('clipboard boom')
    mockedWriteText.mockRejectedValue(clipboardError)
    const user = userEvent.setup()
    renderDialog()
    await screen.findByTestId('page-source-content')

    await user.click(screen.getByRole('button', { name: t('pageSource.copy') }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(t('pageSource.copyFailed'))
    })
    expect(errorSpy).toHaveBeenCalledWith(
      'PageSourceDialog',
      'Failed to copy page source',
      { pageId: PAGE_ID },
      clipboardError,
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a rejected get_page_source shows the load-failed alert and logs', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const backendError = { kind: 'not_found', message: `block '${PAGE_ID}'` }
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ get_page_source: () => Promise.reject(backendError) }),
    )

    renderDialog()

    expect(await screen.findByRole('alert')).toHaveTextContent(t('pageSource.loadFailed'))
    expect(errorSpy).toHaveBeenCalledWith(
      'PageSourceDialog',
      'Failed to load page source',
      { pageId: PAGE_ID },
      backendError,
    )
    expect(screen.queryByTestId('page-source-content')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('pageSource.copy') })).toBeDisabled()
  })

  it('the buffer is a keyboard tab stop, so a long one can be scrolled', async () => {
    const user = userEvent.setup()
    renderDialog()
    const buffer = await screen.findByTestId('page-source-content')

    screen.getByRole('button', { name: t('pageSource.copy') }).focus()
    await user.tab({ shift: true })

    expect(buffer).toHaveFocus()
  })

  it('has no a11y violations with the source loaded', async () => {
    renderDialog()
    await screen.findByTestId('page-source-content')

    await waitFor(async () => {
      expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations()
    })
  })
})
