/**
 * PdfSourceChip — a highlight block's way back to its place (#6629): the PDF's
 * name and the highlight's page, opening the reader on that page. Drawn under
 * the block's text by `BlockMetadataRow`, in block mode and in page mode. The
 * reader opens with the PDF's owning block, so it annotates and saves as it
 * does from the owner's file chip.
 */

import { useQuery } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
import type React from 'react'
import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Spinner } from '@/components/ui/spinner'
import { useBatchAttachments } from '@/hooks/useBatchAttachments'
import { unwrap } from '@/lib/app-error'
import { bytesToBlob } from '@/lib/attachment-utils'
import { commands } from '@/lib/bindings'
import { readAttachment } from '@/lib/ipc-helpers'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { queryClient } from '@/lib/query-client'

// pdfjs-dist loads only once a reader opens (#2035).
const LazyPdfViewerDialog = lazy(() =>
  import('@/components/dialogs/PdfViewerDialog').then((m) => ({ default: m.PdfViewerDialog })),
)

interface OpenReader {
  url: string
  filename: string
  ownerId: string
}

export interface PdfSourceChipProps {
  attachmentId: string
  /** From 1. */
  page: number
}

export function PdfSourceChip({ attachmentId, page }: PdfSourceChipProps): React.ReactElement {
  const { t } = useTranslation()
  const batchAttachments = useBatchAttachments()
  // One read for every chip of the PDF, again on each mount, so a renamed file
  // shows its new name. A file that is gone leaves the page alone in the label.
  const { data: meta } = useQuery(
    {
      queryKey: ['attachment-meta', attachmentId],
      queryFn: async () => unwrap(await commands.readAttachmentMeta(attachmentId)),
      staleTime: 0,
    },
    queryClient,
  )
  const [reader, setReader] = useState<OpenReader | null>(null)

  const text = meta
    ? t('pdfViewer.source', { filename: meta.filename, page })
    : t('pdfViewer.sourceUnknown', { page })
  const label = meta
    ? t('pdfViewer.sourceLabel', { filename: meta.filename, page })
    : t('pdfViewer.sourceUnknownLabel', { page })

  const open = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    try {
      const current = unwrap(await commands.readAttachmentMeta(attachmentId))
      const bytes = await readAttachment(attachmentId)
      const url = URL.createObjectURL(bytesToBlob(bytes, current.mime_type))
      setReader({ url, filename: current.filename, ownerId: current.block_id })
    } catch (err) {
      logger.warn('PdfSourceChip', 'opening the PDF of a highlight failed', { attachmentId }, err)
      notify.error(t('attachments.loadFailed'))
    }
  }

  return (
    <>
      <button
        type="button"
        className="pdf-source-chip touch-hit-area focus-ring-visible flex min-w-0 items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-xs font-medium leading-none select-none cursor-pointer bg-muted text-muted-foreground hover:bg-accent max-sm:px-2.5"
        aria-label={label}
        title={label}
        // #1498: keep the editor focused, its caret where it was, through the click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={open}
      >
        <FileText className="size-[calc(var(--agaric-font-size,1rem)*0.75)] flex-shrink-0" />
        <span className="max-w-64 truncate">{text}</span>
      </button>
      {reader && (
        <Suspense fallback={<Spinner />}>
          <LazyPdfViewerDialog
            open
            onOpenChange={(next) => {
              if (next) return
              URL.revokeObjectURL(reader.url)
              setReader(null)
            }}
            fileUrl={reader.url}
            filename={reader.filename}
            blockId={reader.ownerId}
            attachmentId={attachmentId}
            initialPage={page}
            onSaved={() => batchAttachments?.invalidate(reader.ownerId)}
          />
        </Suspense>
      )}
    </>
  )
}
