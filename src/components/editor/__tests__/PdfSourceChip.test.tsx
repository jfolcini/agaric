/**
 * #6629 — a highlight block's source chip, drawn by `BlockMetadataRow` from
 * the block's `pdf_attachment` and `pdf_page`: it names the PDF and the page,
 * and opens the reader on that page with the PDF's owning block, so the
 * reader can save as it does from the owner's file chip.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import type { PdfViewerDialogProps } from '@/components/dialogs/PdfViewerDialog'
import { BlockMetadataRow } from '@/components/editor/BlockInlineControls'
import { BatchAttachmentsContext } from '@/hooks/useBatchAttachments'
import type { AttachmentRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/notify', () => ({ notify: { error: vi.fn() } }))

// The bytes come over a raw `invoke` with no typed command to stub.
const mockedReadAttachment = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ipc-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-helpers')>()),
  readAttachment: mockedReadAttachment,
}))

// The reader, as the props it opens with: pdf.js does not run in this DOM.
const readerProps = vi.fn()
vi.mock('@/components/dialogs/PdfViewerDialog', () => ({
  PdfViewerDialog: (props: PdfViewerDialogProps) => {
    readerProps(props)
    return (
      <dialog open aria-label="reader">
        <button type="button" onClick={() => props.onSaved?.('ATT_NEWER')}>
          saved
        </button>
        <button type="button" onClick={() => props.onOpenChange(false)}>
          close
        </button>
      </dialog>
    )
  },
}))

const mockedInvoke = vi.mocked(invoke)

const META: AttachmentRow = {
  id: 'ATT_PDF',
  block_id: 'OWNER',
  mime_type: 'application/pdf',
  filename: 'report.pdf',
  size_bytes: 3,
  fs_path: 'attachments/ATT_PDF.pdf',
  created_at: 0,
}

const invalidate = vi.fn()
const batchAttachments = { get: () => [], getCount: () => 0, invalidate }

/** A highlight block's row: its place in its properties, no other metadata. */
function renderHighlightRow() {
  return render(
    <BatchAttachmentsContext.Provider value={batchAttachments}>
      <BlockMetadataRow
        blockId="HIGHLIGHT"
        properties={[
          { key: 'pdf_attachment', value: 'ATT_PDF' },
          { key: 'pdf_page', value: '12' },
          { key: 'pdf_boxes', value: '[[1,2,3,4]]' },
        ]}
        filteredProperties={[]}
        attachmentCount={0}
        showAttachments={false}
        onToggleAttachments={vi.fn()}
        onEditProp={vi.fn()}
        onEditKey={vi.fn()}
      />
    </BatchAttachmentsContext.Provider>,
  )
}

const chipName = t('pdfViewer.sourceLabel', { filename: 'report.pdf', page: 12 })

let revoke: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock/1')
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mockedInvoke.mockImplementation(mockInvokeCommands({ read_attachment_meta: () => META }))
  mockedReadAttachment.mockResolvedValue(new Uint8Array([37, 80, 68]))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PdfSourceChip (#6629)', () => {
  it("names the PDF and the page under a highlight block's text", async () => {
    renderHighlightRow()

    const chip = await screen.findByRole('button', { name: chipName })
    expect(chip).toHaveTextContent(t('pdfViewer.source', { filename: 'report.pdf', page: 12 }))
  })

  it('opens the reader on its page, with the PDF and the block that owns it', async () => {
    const user = userEvent.setup()
    renderHighlightRow()
    await user.click(await screen.findByRole('button', { name: chipName }))

    expect(await screen.findByRole('dialog', { name: 'reader' })).toBeInTheDocument()
    expect(readerProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        open: true,
        fileUrl: 'blob:mock/1',
        filename: 'report.pdf',
        blockId: 'OWNER',
        attachmentId: 'ATT_PDF',
        initialPage: 12,
      }),
    )
    // A save refreshes the owner's attachments; closing frees the PDF's bytes.
    await user.click(screen.getByRole('button', { name: 'saved' }))
    expect(invalidate).toHaveBeenCalledWith('OWNER')
    await user.click(screen.getByRole('button', { name: 'close' }))
    expect(screen.queryByRole('dialog', { name: 'reader' })).not.toBeInTheDocument()
    expect(revoke).toHaveBeenCalledWith('blob:mock/1')
  })

  it('says the file could not be loaded when its bytes cannot be read', async () => {
    const user = userEvent.setup()
    mockedReadAttachment.mockRejectedValue(new Error('gone'))
    renderHighlightRow()
    await user.click(await screen.findByRole('button', { name: chipName }))

    await waitFor(() => {
      expect(vi.mocked(notify.error)).toHaveBeenCalledWith(t('attachments.loadFailed'))
    })
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'PdfSourceChip',
      'opening the PDF of a highlight failed',
      { attachmentId: 'ATT_PDF' },
      expect.any(Error),
    )
    expect(screen.queryByRole('dialog', { name: 'reader' })).not.toBeInTheDocument()
  })

  it('keeps the page in its label when the PDF is gone', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        read_attachment_meta: () => Promise.reject(new Error('not found')),
      }),
    )
    renderHighlightRow()

    const chip = screen.getByRole('button', {
      name: t('pdfViewer.sourceUnknownLabel', { page: 12 }),
    })
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('read_attachment_meta', { attachmentId: 'ATT_PDF' })
    })
    expect(chip).toHaveTextContent(t('pdfViewer.sourceUnknown', { page: 12 }))
  })

  it('draws no chip on a block that is no highlight', () => {
    render(
      <BlockMetadataRow
        blockId="PLAIN"
        properties={[{ key: 'pdf_page', value: '12' }]}
        filteredProperties={[]}
        attachmentCount={0}
        showAttachments={false}
        onToggleAttachments={vi.fn()}
        onEditProp={vi.fn()}
        onEditKey={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('block-metadata-row')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = renderHighlightRow()
    await screen.findByRole('button', { name: chipName })

    expect(await axe(container)).toHaveNoViolations()
  })
})
