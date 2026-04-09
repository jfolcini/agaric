/**
 * StaticBlock — renders a non-focused block as a plain div.
 *
 * Clicking focuses the block, which mounts the TipTap editor.
 * This is the "static div for all non-focused blocks" from the roving editor pattern.
 *
 * Inline tokens (block_link, tag_ref) are rendered as styled spans
 * with optional click-to-navigate (block links) and deleted decoration.
 */

import type React from 'react'
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlockAttachments } from '../hooks/useBlockAttachments'
import { openUrl } from '../lib/open-url'
import { getProperties } from '../lib/tauri'
import { cn } from '../lib/utils'
import { AttachmentRenderer } from './AttachmentRenderer'
import { ImageLightbox } from './ImageLightbox'
import { QueryResult } from './QueryResult'
import { renderRichContent } from './RichContentRenderer'
import { Spinner } from './ui/spinner'

// Lazy-load PdfViewerDialog to avoid bundling pdfjs-dist on initial load
const LazyPdfViewerDialog = lazy(() =>
  import('./PdfViewerDialog').then((m) => ({ default: m.PdfViewerDialog })),
)

// Re-export for backward compatibility
export { getAssetUrl } from '../lib/attachment-utils'
export { renderRichContent } from './RichContentRenderer'

export interface StaticBlockProps {
  blockId: string
  content: string
  onFocus: (blockId: string) => void
  /** Called when the user clicks a block-link chip. */
  onNavigate?: ((id: string) => void) | undefined
  /** Resolve a block/page ULID → display title. */
  resolveBlockTitle?: ((id: string) => string) | undefined
  /** Resolve a tag ULID → display name. */
  resolveTagName?: ((id: string) => string) | undefined
  /** Check whether a linked block is active or deleted. */
  resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Check whether a referenced tag is active or deleted. */
  resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Whether this block is part of a multi-selection. */
  isSelected?: boolean | undefined
  /** Ctrl+Click / Shift+Click selection callback. */
  onSelect?: ((blockId: string, mode: 'toggle' | 'range') => void) | undefined
}

function StaticBlockInner({
  blockId,
  content,
  onFocus,
  onNavigate,
  resolveBlockTitle,
  resolveTagName,
  resolveBlockStatus,
  resolveTagStatus,
  isSelected,
  onSelect,
}: StaticBlockProps): React.ReactElement {
  const { t } = useTranslation()
  // Keep callback refs so the expensive useMemo only re-runs when `content` changes.
  // Callbacks don't affect the rendered output — they only affect click behaviour —
  // so they can safely live in refs that are read at call-time.
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const resolveBlockTitleRef = useRef(resolveBlockTitle)
  resolveBlockTitleRef.current = resolveBlockTitle
  const resolveTagNameRef = useRef(resolveTagName)
  resolveTagNameRef.current = resolveTagName
  const resolveBlockStatusRef = useRef(resolveBlockStatus)
  resolveBlockStatusRef.current = resolveBlockStatus
  const resolveTagStatusRef = useRef(resolveTagStatus)
  resolveTagStatusRef.current = resolveTagStatus

  const richContent = useMemo(
    () =>
      content
        ? renderRichContent(content, {
            onNavigate: onNavigate ? (id: string) => onNavigateRef.current?.(id) : undefined,
            resolveBlockTitle: (id) => resolveBlockTitleRef.current?.(id),
            resolveTagName: (id) => resolveTagNameRef.current?.(id),
            resolveBlockStatus: (id) => resolveBlockStatusRef.current?.(id) ?? 'active',
            resolveTagStatus: (id) => resolveTagStatusRef.current?.(id) ?? 'active',
          })
        : null,
    [content, onNavigate],
  )

  const { attachments, loading: attachmentsLoading } = useBlockAttachments(blockId)

  // PDF viewer dialog state
  const [pdfViewerOpen, setPdfViewerOpen] = useState(false)
  const [pdfViewerUrl, setPdfViewerUrl] = useState('')
  const [pdfViewerFilename, setPdfViewerFilename] = useState('')

  // Image lightbox state
  const [lightboxImage, setLightboxImage] = useState<{
    src: string
    alt: string
    fsPath: string
  } | null>(null)

  // Image resize state
  const [imageWidth, setImageWidth] = useState('100')
  const [imageHovered, setImageHovered] = useState(false)

  // Only fetch image_width property when the block has image attachments
  const hasImageAttachments =
    !attachmentsLoading && attachments.some((a) => a.mime_type.startsWith('image/'))

  // Load stored image_width property when image attachments are present
  useEffect(() => {
    if (!hasImageAttachments) return
    let cancelled = false
    getProperties(blockId)
      .then((props) => {
        if (cancelled) return
        const widthProp = props.find((p) => p.key === 'image_width')
        if (widthProp?.value_text) {
          setImageWidth(widthProp.value_text)
        }
      })
      .catch(() => {
        // Ignore — use default width
      })
    return () => {
      cancelled = true
    }
  }, [blockId, hasImageAttachments])

  const hasAttachments = !attachmentsLoading && attachments.length > 0

  const handleLightboxOpen = useCallback((image: { src: string; alt: string; fsPath: string }) => {
    setLightboxImage(image)
  }, [])

  const handlePdfOpen = useCallback((url: string, filename: string) => {
    setPdfViewerUrl(url)
    setPdfViewerFilename(filename)
    setPdfViewerOpen(true)
  }, [])

  // Detect {{query ...}} blocks and render QueryResult instead of the text
  if (content?.startsWith('{{query ') && content.endsWith('}}')) {
    const expression = content.slice(8, -2).trim()
    return (
      <button
        type="button"
        className="block-static w-full min-h-[1.75rem] rounded-md text-left text-sm"
        data-testid="block-static"
        data-block-id={blockId}
        onClick={() => onFocus(blockId)}
      >
        <QueryResult
          expression={expression}
          blockId={blockId}
          onNavigate={onNavigate ? (pageId) => onNavigate(pageId) : undefined}
          resolveBlockTitle={resolveBlockTitle}
        />
      </button>
    )
  }

  return (
    <>
      <button
        type="button"
        className={cn(
          'block-static w-full min-h-[1.75rem] cursor-text rounded-md px-3 py-1 text-left text-sm transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 [@media(pointer:coarse)]:min-h-[2.75rem]',
          isSelected && 'ring-2 ring-primary/50 bg-primary/5',
        )}
        data-testid="block-static"
        data-block-id={blockId}
        aria-label={t('block.editLabel')}
        onClick={(e) => {
          if ((e.ctrlKey || e.metaKey) && onSelect) {
            e.preventDefault()
            onSelect(blockId, 'toggle')
          } else if (e.shiftKey && onSelect) {
            e.preventDefault()
            onSelect(blockId, 'range')
          } else {
            onFocus(blockId)
          }
        }}
      >
        {richContent ?? (
          <span className="block-placeholder text-muted-foreground italic">
            {t('block.emptyPlaceholder')}
          </span>
        )}
      </button>
      {hasAttachments && (
        <AttachmentRenderer
          blockId={blockId}
          attachments={attachments}
          imageWidth={imageWidth}
          imageHovered={imageHovered}
          onImageHoveredChange={setImageHovered}
          onImageWidthChange={setImageWidth}
          onLightboxOpen={handleLightboxOpen}
          onPdfOpen={handlePdfOpen}
        />
      )}
      <Suspense fallback={<Spinner />}>
        <LazyPdfViewerDialog
          open={pdfViewerOpen}
          onOpenChange={setPdfViewerOpen}
          fileUrl={pdfViewerUrl}
          filename={pdfViewerFilename}
        />
      </Suspense>
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          open={!!lightboxImage}
          onOpenChange={(open) => {
            if (!open) setLightboxImage(null)
          }}
          onOpenExternal={() => openUrl(lightboxImage.fsPath)}
        />
      )}
    </>
  )
}

export const StaticBlock = memo(StaticBlockInner)
StaticBlock.displayName = 'StaticBlock'
