/**
 * StaticBlockAttachments — the attachment render concern of StaticBlock.
 *
 * Renders a block's attachments (images, files) plus the two lazy overlays
 * they can open: the PDF viewer dialog and the image lightbox. Owns the
 * viewer/lightbox open state and the image width/alignment/caption
 * properties so StaticBlock stays a thin dispatcher.
 *
 * Only mounted when the block actually has attachments (StaticBlock gates on
 * `hasAttachments`), so `attachments` here is always a non-empty, settled
 * list.
 */

import type React from 'react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'

import type { AttachmentRendererProps } from '@/components/attachments/AttachmentRenderer'
import { AttachmentRenderer } from '@/components/attachments/AttachmentRenderer'
import { ImageLightbox } from '@/components/rendering/ImageLightbox'
import { Spinner } from '@/components/ui/spinner'
import { useBatchAttachments } from '@/hooks/useBatchAttachments'
import { openUrl } from '@/lib/open-url'

import { useImageProperties } from './useImageProperties'

// Lazy-load PdfViewerDialog to avoid bundling pdfjs-dist on initial load
const LazyPdfViewerDialog = lazy(() =>
  import('@/components/dialogs/PdfViewerDialog').then((m) => ({ default: m.PdfViewerDialog })),
)

interface LightboxImage {
  src: string
  alt: string
  fsPath: string
  caption?: string | undefined
}

export interface StaticBlockAttachmentsProps {
  blockId: string
  /** The block's attachments — always non-empty (StaticBlock gates on hasAttachments). */
  attachments: AttachmentRendererProps['attachments']
}

export function StaticBlockAttachments({
  blockId,
  attachments,
}: StaticBlockAttachmentsProps): React.ReactElement {
  // StaticBlock only mounts this component once attachments have settled
  // (`!attachmentsLoading && attachments.length > 0`), so an image test here
  // matches the prior `hasImageAttachments` gate.
  const hasImageAttachments = attachments.some((a) => a.mime_type.startsWith('image/'))

  const {
    imageWidth,
    imageAlignment,
    imageCaption,
    setImageWidth,
    setImageAlignment,
    setImageCaption,
  } = useImageProperties(blockId, hasImageAttachments)
  const [imageHovered, setImageHovered] = useState(false)

  // PDF viewer dialog state
  const [pdfViewerOpen, setPdfViewerOpen] = useState(false)
  const [pdfViewerUrl, setPdfViewerUrl] = useState('')
  const [pdfViewerFilename, setPdfViewerFilename] = useState('')
  // ULID of the attachment being viewed — lets the viewer persist an
  // annotated copy and delete the original on save (#1452).
  const [pdfViewerAttachmentId, setPdfViewerAttachmentId] = useState('')

  // Image lightbox state. `images` is the full ordered set of image
  // attachments in this block (#212 item 2 — enables prev/next nav); `index`
  // points at the currently displayed one.
  const [lightboxState, setLightboxState] = useState<{
    images: LightboxImage[]
    index: number
  } | null>(null)

  const batchAttachments = useBatchAttachments()

  const handleLightboxOpen = useCallback((image: LightboxImage, images: LightboxImage[]) => {
    const index = Math.max(
      0,
      images.findIndex((img) => img.src === image.src),
    )
    setLightboxState({ images, index })
  }, [])

  const handleLightboxIndexChange = useCallback((index: number) => {
    setLightboxState((prev) => (prev ? { ...prev, index } : prev))
  }, [])

  const handlePdfOpen = useCallback((url: string, filename: string, attachmentId: string) => {
    // The PDF url is now a `blob:` object URL (asset protocol is
    // disabled). Revoke any previously-opened blob URL before replacing it so
    // we don't leak across successive opens.
    setPdfViewerUrl((prev) => {
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return url
    })
    setPdfViewerFilename(filename)
    setPdfViewerAttachmentId(attachmentId)
    setPdfViewerOpen(true)
  }, [])

  // #1452 — after the viewer bakes annotations into a new attachment and
  // deletes the original, refresh the block's attachment list so the new copy
  // shows up (and the old one disappears) without a full reload.
  const handlePdfSaved = useCallback(() => {
    batchAttachments?.invalidate(blockId)
  }, [batchAttachments, blockId])

  // Revoke the PDF blob URL once the viewer closes (and on unmount) so the
  // object URL created in AttachmentRenderer doesn't leak.
  useEffect(() => {
    if (pdfViewerOpen) return
    if (!pdfViewerUrl.startsWith('blob:')) return
    URL.revokeObjectURL(pdfViewerUrl)
    setPdfViewerUrl('')
  }, [pdfViewerOpen, pdfViewerUrl])

  return (
    <>
      <AttachmentRenderer
        blockId={blockId}
        attachments={attachments}
        imageWidth={imageWidth}
        imageHovered={imageHovered}
        imageAlignment={imageAlignment}
        imageCaption={imageCaption}
        onImageHoveredChange={setImageHovered}
        onImageWidthChange={setImageWidth}
        onImageAlignmentChange={setImageAlignment}
        onImageCaptionChange={setImageCaption}
        onLightboxOpen={handleLightboxOpen}
        onPdfOpen={handlePdfOpen}
      />
      {/* Gate the lazy dialog on `pdfViewerOpen` so React.lazy only triggers
          the dynamic import (pulling in the ~450KB pdfjs-dist chunk + its
          module-scope side effects) when the user actually opens a PDF — not on
          every static-block render. The dialog tears down its document/viewer on
          close, so unmounting here loses no state we need to keep (#2035). */}
      {pdfViewerOpen && (
        <Suspense fallback={<Spinner />}>
          <LazyPdfViewerDialog
            open={pdfViewerOpen}
            onOpenChange={setPdfViewerOpen}
            fileUrl={pdfViewerUrl}
            filename={pdfViewerFilename}
            blockId={blockId}
            attachmentId={pdfViewerAttachmentId}
            onSaved={handlePdfSaved}
          />
        </Suspense>
      )}
      {lightboxState && (
        <ImageLightbox
          images={lightboxState.images.map((img) => ({
            src: img.src,
            alt: img.alt,
            caption: img.caption,
          }))}
          index={lightboxState.index}
          onIndexChange={handleLightboxIndexChange}
          open={!!lightboxState}
          onOpenChange={(open) => {
            if (!open) setLightboxState(null)
          }}
          onOpenExternal={() => {
            const current = lightboxState.images[lightboxState.index]
            if (current) openUrl(current.fsPath)
          }}
        />
      )}
    </>
  )
}
