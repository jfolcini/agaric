import { File, FileText, Image as ImageIcon } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { formatSize, getAssetUrl } from '../lib/attachment-utils'
import { openUrl } from '../lib/open-url'
import { ImageResizeToolbar } from './ImageResizeToolbar'

/** Return the appropriate Lucide icon for a MIME type (used in attachment chips). */
function AttachmentMimeIcon({ mimeType }: { mimeType: string }): React.ReactElement {
  if (mimeType.startsWith('image/')) {
    return <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  }
  if (mimeType.startsWith('text/')) {
    return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  }
  return <File className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
}

export interface AttachmentRendererProps {
  blockId: string
  attachments: Array<{
    id: string
    filename: string
    fs_path: string
    mime_type: string
    size_bytes: number
  }>
  imageWidth: string
  imageHovered: boolean
  onImageHoveredChange: (hovered: boolean) => void
  onImageWidthChange: (width: string) => void
  onLightboxOpen: (image: { src: string; alt: string; fsPath: string }) => void
  onPdfOpen: (url: string, filename: string) => void
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
          const url = getAssetUrl(att.fs_path)
          if (!url) return null
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: focusable image container reveals an inner toolbar with its own buttons; using role="button" here would create a nested-interactive a11y violation
            // biome-ignore lint/a11y/useSemanticElements: <fieldset>/<legend> are form-control semantics, not appropriate for an image wrapper; role="group" is the correct ARIA primitive here
            <div
              key={att.id}
              className="relative inline-block"
              style={{ maxWidth: `${imageWidth}%` }}
              data-testid="image-resize-wrapper"
              role="group"
              aria-label={t('attachment.toggleResizeToolbar')}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: image container needs keyboard focus to expose the inner resize toolbar
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
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: image open action is supplementary */}
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
        return (
          <button
            key={att.id}
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 active:bg-accent/70 hover:text-foreground"
            aria-label={t('attachment.openFile', { filename: att.filename })}
            onClick={(e) => {
              e.stopPropagation()
              if (att.mime_type === 'application/pdf') {
                const url = getAssetUrl(att.fs_path)
                if (url) {
                  onPdfOpen(url, att.filename)
                } else {
                  openUrl(att.fs_path)
                }
              } else {
                openUrl(att.fs_path)
              }
            }}
          >
            <AttachmentMimeIcon mimeType={att.mime_type} />
            <span className="truncate max-w-[200px]">{att.filename}</span>
            <span className="shrink-0 opacity-70">{formatSize(att.size_bytes)}</span>
          </button>
        )
      })}
    </div>
  )
}
