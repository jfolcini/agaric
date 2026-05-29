import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatSize } from '../lib/attachment-utils'
import { logger } from '../lib/logger'
import { notify } from '../lib/notify'
import { readAttachment } from '../lib/tauri'
import { ImageResizeToolbar } from './ImageResizeToolbar'
import { MimeIcon } from './MimeIcon'

interface Attachment {
  id: string
  filename: string
  fs_path: string
  mime_type: string
  size_bytes: number
}

/**
 * Wrap raw attachment bytes in a typed `Blob`.
 *
 * `readAttachment` returns `Uint8Array<ArrayBufferLike>` (the buffer generic
 * TypeScript 5.7+ tracks). `BlobPart` requires `Uint8Array<ArrayBuffer>`, so
 * we re-wrap into a fresh ArrayBuffer-backed view. The copy is negligible
 * relative to the IPC round-trip that produced the bytes.
 */
function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type: mimeType })
}

export interface AttachmentRendererProps {
  blockId: string
  attachments: Attachment[]
  imageWidth: string
  imageHovered: boolean
  onImageHoveredChange: (hovered: boolean) => void
  onImageWidthChange: (width: string) => void
  onLightboxOpen: (image: { src: string; alt: string; fsPath: string }) => void
  onPdfOpen: (url: string, filename: string) => void
}

/**
 * Renders a single image attachment from raw bytes (PEND-76 F2).
 *
 * The asset protocol is disabled, so we fetch the file's bytes over IPC via
 * `readAttachment`, wrap them in a `Blob`, and render the resulting
 * `blob:` object URL. The URL is revoked on unmount AND whenever the
 * attachment id changes so we never leak object URLs.
 */
function AttachmentImage({
  att,
  imageWidth,
  imageHovered,
  blockId,
  onImageHoveredChange,
  onImageWidthChange,
  onLightboxOpen,
}: {
  att: Attachment
  imageWidth: string
  imageHovered: boolean
  blockId: string
  onImageHoveredChange: (hovered: boolean) => void
  onImageWidthChange: (width: string) => void
  onLightboxOpen: (image: { src: string; alt: string; fsPath: string }) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    setUrl(null)
    setError(false)

    readAttachment(att.id)
      .then((bytes) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(bytesToBlob(bytes, att.mime_type))
        setUrl(objectUrl)
      })
      .catch((err) => {
        if (cancelled) return
        logger.warn('AttachmentRenderer', 'read attachment bytes failed', { id: att.id }, err)
        setError(true)
      })

    // Revoke on unmount AND whenever the attachment id changes (effect re-runs).
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [att.id, att.mime_type])

  if (error) {
    return (
      <span className="text-xs text-destructive" data-testid="attachment-image-error">
        {t('attachment.imageLoadFailed')}
      </span>
    )
  }

  if (!url) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="attachment-image-loading">
        {t('attachment.loadingImage')}
      </span>
    )
  }

  return (
    <div
      className="relative inline-block"
      style={{ maxWidth: `${imageWidth}%` }}
      data-testid="image-resize-wrapper"
      role="group"
      aria-label={t('attachment.toggleResizeToolbar')}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- image container needs keyboard focus to expose the inner resize toolbar
      tabIndex={0}
      onPointerEnter={() => onImageHoveredChange(true)}
      onPointerLeave={() => onImageHoveredChange(false)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onImageHoveredChange(!imageHovered)
        }
      }}
      onFocus={() => onImageHoveredChange(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          onImageHoveredChange(false)
        }
      }}
    >
      {imageHovered && (
        <ImageResizeToolbar
          blockId={blockId}
          currentWidth={imageWidth}
          onWidthChange={onImageWidthChange}
        />
      )}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- image open action is supplementary */}
      <img
        src={url}
        alt={att.filename}
        loading="lazy"
        className="rounded-md cursor-pointer hover:opacity-90 transition-opacity"
        style={{ maxWidth: '100%', maxHeight: '400px', objectFit: 'contain' }}
        onClick={(e) => {
          e.stopPropagation()
          onLightboxOpen({ src: url, alt: att.filename, fsPath: att.fs_path })
        }}
      />
    </div>
  )
}

export function AttachmentRenderer({
  blockId,
  attachments,
  imageWidth,
  imageHovered,
  onImageHoveredChange,
  onImageWidthChange,
  onLightboxOpen,
  onPdfOpen,
}: AttachmentRendererProps): React.ReactElement | null {
  const { t } = useTranslation()
  if (attachments.length === 0) return null

  return (
    <div className="mt-1 flex flex-wrap gap-2 px-3 pb-1" data-testid="attachment-section">
      {attachments.map((att) => {
        if (att.mime_type.startsWith('image/')) {
          return (
            <AttachmentImage
              key={att.id}
              att={att}
              blockId={blockId}
              imageWidth={imageWidth}
              imageHovered={imageHovered}
              onImageHoveredChange={onImageHoveredChange}
              onImageWidthChange={onImageWidthChange}
              onLightboxOpen={onLightboxOpen}
            />
          )
        }
        return (
          <button
            key={att.id}
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 active:bg-accent/70 hover:text-foreground"
            aria-label={t('attachment.openFile', { filename: att.filename })}
            onClick={async (e) => {
              e.stopPropagation()
              if (att.mime_type === 'application/pdf') {
                // Asset protocol is disabled — read the bytes over IPC and hand
                // the PDF viewer a blob URL it can fetch via pdfjs getDocument().
                try {
                  const bytes = await readAttachment(att.id)
                  const url = URL.createObjectURL(bytesToBlob(bytes, att.mime_type))
                  onPdfOpen(url, att.filename)
                } catch (err) {
                  logger.warn('AttachmentRenderer', 'read pdf bytes failed', { id: att.id }, err)
                  notify.error(t('attachments.loadFailed'))
                }
              } else {
                // Non-image, non-PDF: `fs_path` is backend-relative (the
                // backend owns storage), so it can't be opened externally.
                // Read the bytes over IPC and trigger a browser download.
                try {
                  const bytes = await readAttachment(att.id)
                  const url = URL.createObjectURL(bytesToBlob(bytes, att.mime_type))
                  const anchor = document.createElement('a')
                  anchor.href = url
                  anchor.download = att.filename
                  document.body.appendChild(anchor)
                  anchor.click()
                  anchor.remove()
                  URL.revokeObjectURL(url)
                } catch (err) {
                  logger.warn(
                    'AttachmentRenderer',
                    'download attachment failed',
                    { id: att.id },
                    err,
                  )
                  notify.error(t('attachments.loadFailed'))
                }
              }
            }}
          >
            <MimeIcon mimeType={att.mime_type} />
            <span className="truncate max-w-[200px]">{att.filename}</span>
            <span className="shrink-0 opacity-70">{formatSize(att.size_bytes)}</span>
          </button>
        )
      })}
    </div>
  )
}
