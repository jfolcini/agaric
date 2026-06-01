import { MoveHorizontal } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatSize } from '../lib/attachment-utils'
import { logger } from '../lib/logger'
import { notify } from '../lib/notify'
import { readAttachment, setProperty } from '../lib/tauri'
import { type ImageAlignment, ImageResizeToolbar } from './ImageResizeToolbar'
import { MimeIcon } from './MimeIcon'

/** Map an alignment value to the flex justification of the image row. */
const ALIGNMENT_JUSTIFY: Record<ImageAlignment, string> = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
}

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

export interface LightboxImage {
  src: string
  alt: string
  fsPath: string
  /** Optional caption (#212 item 3) — shown under the image in the lightbox. */
  caption?: string | undefined
}

export interface AttachmentRendererProps {
  blockId: string
  attachments: Attachment[]
  imageWidth: string
  imageHovered: boolean
  /** Current alignment for this block's image(s) (#212 item 4). */
  imageAlignment: ImageAlignment
  /** Current caption for this block's image(s) (#212 item 3). */
  imageCaption: string
  onImageHoveredChange: (hovered: boolean) => void
  onImageWidthChange: (width: string) => void
  onImageAlignmentChange: (alignment: ImageAlignment) => void
  onImageCaptionChange: (caption: string) => void
  /**
   * Open the lightbox for `image`. `images` is the full set of loaded image
   * attachments in this block (render order) so the lightbox can offer
   * prev/next navigation (#212 item 2).
   */
  onLightboxOpen: (image: LightboxImage, images: LightboxImage[]) => void
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
  imageAlignment,
  imageCaption,
  blockId,
  onImageHoveredChange,
  onImageWidthChange,
  onImageAlignmentChange,
  onImageCaptionChange,
  onLightboxOpen,
  onUrlChange,
}: {
  att: Attachment
  imageWidth: string
  imageHovered: boolean
  imageAlignment: ImageAlignment
  imageCaption: string
  blockId: string
  onImageHoveredChange: (hovered: boolean) => void
  onImageWidthChange: (width: string) => void
  onImageAlignmentChange: (alignment: ImageAlignment) => void
  onImageCaptionChange: (caption: string) => void
  /** Open the lightbox at this image; receives this image's loaded blob URL. */
  onLightboxOpen: (url: string) => void
  /** Report this image's loaded blob URL (or null) to the parent registry. */
  onUrlChange: (id: string, url: string | null) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  // When a caption exists it doubles as the image's alt text (#212 item 3);
  // otherwise we fall back to the filename.
  const altText = imageCaption.trim() || att.filename

  // Persist the caption on blur. Empty caption clears the property via an
  // empty string (kept simple — no delete needed, the load path treats an
  // empty value as "no caption").
  const handleCaptionBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      const next = e.target.value
      if (next === imageCaption) return
      onImageCaptionChange(next)
      setProperty({
        blockId,
        key: 'image_caption',
        valueText: next,
      }).catch((err) => {
        logger.warn('AttachmentRenderer', 'caption save failed', { blockId }, err)
        // Revert on failure — restore the previous caption.
        onImageCaptionChange(imageCaption)
        notify.error(t('imageCaption.saveFailed'))
      })
    },
    [blockId, imageCaption, onImageCaptionChange, t],
  )

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
        onUrlChange(att.id, objectUrl)
      })
      .catch((err) => {
        if (cancelled) return
        logger.warn('AttachmentRenderer', 'read attachment bytes failed', { id: att.id }, err)
        setError(true)
      })

    // Revoke on unmount AND whenever the attachment id changes (effect re-runs).
    return () => {
      cancelled = true
      onUrlChange(att.id, null)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [att.id, att.mime_type, onUrlChange])

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
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- this focusable group is the disclosure trigger for the inner ImageResizeToolbar: hover/focus reveal it and Enter/Space toggle it. It can't be a <button> because it wraps the <img> and a toolbar of nested buttons (nested interactive content is invalid), so the keyboard/pointer handlers must live on the group.
    <div
      className="group relative inline-block"
      style={{ maxWidth: `${imageWidth}%` }}
      data-testid="image-resize-wrapper"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- focusable disclosure wrapper around an <img> + nested toolbar buttons; <fieldset>/<optgroup> etc. break the inline-block resize layout and add form/list semantics
      role="group"
      aria-label={t('attachment.toggleResizeToolbar')}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- image container needs keyboard focus to expose the inner resize toolbar
      tabIndex={0}
      onPointerEnter={() => onImageHoveredChange(true)}
      onPointerLeave={() => onImageHoveredChange(false)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Only toggle the resize toolbar when the group itself is focused —
        // not when the inner lightbox button bubbles its Enter/Space activation.
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
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
          currentAlignment={imageAlignment}
          onAlignmentChange={onImageAlignmentChange}
        />
      )}
      {/* FIL-008 (#218 item 6): faint resize-affordance hint. Discoverability
          only — it signals the already-working resize toolbar exists. CSS-only
          so it adds no render churn: hidden at rest, fades in on hover/focus
          of the group (desktop). On coarse pointers (no hover) it stays faintly
          visible so touch users get the cue too. Suppressed once the toolbar is
          actually open (`imageHovered`) to avoid two overlapping affordances.
          `pointer-events-none` so it never intercepts the image/lightbox click. */}
      {!imageHovered && (
        <span
          aria-hidden="true"
          data-testid="image-resize-hint"
          title={t('attachment.resizeHint')}
          className="pointer-events-none absolute right-1 top-1 z-[5] rounded bg-popover/80 p-0.5 text-muted-foreground opacity-0 shadow-sm transition-opacity duration-150 group-focus-within:opacity-50 group-hover:opacity-50 [@media(hover:none)]:opacity-50"
        >
          <MoveHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      )}
      <button
        type="button"
        aria-label={t('attachment.openImageFullscreen', { filename: att.filename })}
        className="block cursor-pointer rounded-md border-0 bg-transparent p-0 hover:opacity-90 transition-opacity"
        onClick={(e) => {
          e.stopPropagation()
          onLightboxOpen(url)
        }}
      >
        <img
          src={url}
          alt={altText}
          loading="lazy"
          className="rounded-md"
          // Responsive cap (#212 item 1): never taller than 400px nor 60% of the
          // viewport height, whichever is smaller; width auto-scales to preserve
          // aspect ratio.
          style={{
            maxWidth: '100%',
            maxHeight: 'min(400px, 60vh)',
            height: 'auto',
            width: 'auto',
            objectFit: 'contain',
          }}
        />
      </button>
      {/* Caption line (#212 item 3): low-chrome, placeholder-only until focused
          or filled. Persists `image_caption` on blur and doubles as the image's
          alt text. The input lives inside the focusable group so it shares the
          hover/focus reveal and blur-collapse behaviour. */}
      <input
        type="text"
        defaultValue={imageCaption}
        placeholder={t('imageCaption.placeholder')}
        aria-label={t('imageCaption.label')}
        className="mt-1 w-full border-0 bg-transparent px-0 text-center text-xs text-muted-foreground placeholder:text-muted-foreground/60 focus:outline-none focus-visible:outline-none"
        data-testid="image-caption-input"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Don't let Enter/Space bubble to the group's toolbar toggle; Enter
          // commits the caption by blurring the input.
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        onBlur={handleCaptionBlur}
      />
    </div>
  )
}

export function AttachmentRenderer({
  blockId,
  attachments,
  imageWidth,
  imageHovered,
  imageAlignment,
  imageCaption,
  onImageHoveredChange,
  onImageWidthChange,
  onImageAlignmentChange,
  onImageCaptionChange,
  onLightboxOpen,
  onPdfOpen,
}: AttachmentRendererProps): React.ReactElement | null {
  const { t } = useTranslation()

  // Registry of loaded image blob URLs, keyed by attachment id. Children report
  // their URL as it loads/unloads; we read it (in attachment order) to build the
  // lightbox image set on click so prev/next can cycle the whole block.
  const urlsRef = useRef<Map<string, string>>(new Map())
  const imageAttachments = useMemo(
    () => attachments.filter((att) => att.mime_type.startsWith('image/')),
    [attachments],
  )

  const handleUrlChange = useCallback((id: string, url: string | null) => {
    if (url) urlsRef.current.set(id, url)
    else urlsRef.current.delete(id)
  }, [])

  // Caption (#212 item 3) is a block-level property shared by the block's
  // image(s); a non-empty caption doubles as the alt text (filename fallback).
  const altFor = useCallback(
    (att: Attachment) => imageCaption.trim() || att.filename,
    [imageCaption],
  )
  const captionForLightbox = imageCaption.trim() || undefined

  const buildImageSet = useCallback((): LightboxImage[] => {
    const out: LightboxImage[] = []
    for (const att of imageAttachments) {
      const url = urlsRef.current.get(att.id)
      if (url)
        out.push({ src: url, alt: altFor(att), fsPath: att.fs_path, caption: captionForLightbox })
    }
    return out
  }, [imageAttachments, altFor, captionForLightbox])

  const handleImageClick = useCallback(
    (att: Attachment, url: string) => {
      // Build the full set for prev/next from the registry, but ensure the
      // clicked image is present (its own loaded URL) even if the registry
      // hasn't caught it yet, so the lightbox always opens on the right image.
      const set = buildImageSet()
      if (!set.some((img) => img.src === url)) {
        set.push({ src: url, alt: altFor(att), fsPath: att.fs_path, caption: captionForLightbox })
      }
      onLightboxOpen(
        { src: url, alt: altFor(att), fsPath: att.fs_path, caption: captionForLightbox },
        set,
      )
    },
    [onLightboxOpen, buildImageSet, altFor, captionForLightbox],
  )

  if (attachments.length === 0) return null

  return (
    <div
      className="mt-1 flex flex-wrap gap-2 px-3 pb-1"
      style={{ justifyContent: ALIGNMENT_JUSTIFY[imageAlignment] }}
      data-testid="attachment-section"
      data-alignment={imageAlignment}
    >
      {attachments.map((att) => {
        if (att.mime_type.startsWith('image/')) {
          return (
            <AttachmentImage
              key={att.id}
              att={att}
              blockId={blockId}
              imageWidth={imageWidth}
              imageHovered={imageHovered}
              imageAlignment={imageAlignment}
              imageCaption={imageCaption}
              onImageHoveredChange={onImageHoveredChange}
              onImageWidthChange={onImageWidthChange}
              onImageAlignmentChange={onImageAlignmentChange}
              onImageCaptionChange={onImageCaptionChange}
              onLightboxOpen={(url) => handleImageClick(att, url)}
              onUrlChange={handleUrlChange}
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
