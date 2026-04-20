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
import { logger } from '../lib/logger'
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: onNavigate captured via ref — see comment above
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
    [content],
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
      .catch((err) => {
        logger.warn('StaticBlock', 'image width property fetch failed', undefined, err)
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

  // Keyboard handler for the outer role="button" div: a native <button> fires
  // its onClick on Enter *and* Space automatically, but a div with role="button"
  // does not — it only fires on mouse click. We replicate that native behaviour
  // manually here.
  //
  // The `e.target === e.currentTarget` guard prevents the outer focus handler
  // from hijacking Enter/Space when focus is on a nested real <button>
  // (QueryResult's chevron toggle, edit-query pencil, etc). A keydown on an
  // inner button bubbles up; without this guard Enter on the chevron would
  // both toggle the chevron AND refocus the whole block into the editor.
  const handleOuterKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      // preventDefault is load-bearing for Space (suppresses page scroll on a
      // role=button) and harmless for Enter (the block isn't inside a form,
      // so there's nothing to submit).
      e.preventDefault()
      if ((e.ctrlKey || e.metaKey) && onSelect) {
        onSelect(blockId, 'toggle')
      } else if (e.shiftKey && onSelect) {
        onSelect(blockId, 'range')
      } else {
        onFocus(blockId)
      }
    },
    [blockId, onFocus, onSelect],
  )

  const handleOuterClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.ctrlKey || e.metaKey) && onSelect) {
        e.preventDefault()
        onSelect(blockId, 'toggle')
      } else if (e.shiftKey && onSelect) {
        e.preventDefault()
        onSelect(blockId, 'range')
      } else {
        onFocus(blockId)
      }
    },
    [blockId, onFocus, onSelect],
  )

  // Capture-phase handler used for query blocks. QueryResult's inner
  // subtree is densely interactive (chevron toggle, edit-pencil, result
  // items that navigate to their parent page, PageLink badges) and those
  // inner handlers call `stopPropagation()`. That left no reliable
  // bubble-phase click path for "click anywhere on the query block to
  // re-enter edit mode" — a plain `.click()` on the block-static element
  // would always land on a result item and never reach this wrapper.
  //
  // Running in the capture phase lets us eagerly focus the block for any
  // non-interactive target (result item content, empty header area, card
  // background), while still yielding the click to explicit `<button>` /
  // `<a>` / `role="link"` elements when those are the actual target.
  const handleQueryBlockClickCapture = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      // Let the chevron toggle, edit-query pencil, and PageLink badge
      // handle their own clicks.
      if (target.closest('button, a, [role="link"]')) return
      // Otherwise treat the click as "focus this block" (or select, with
      // modifier keys) and suppress the downstream item-level navigation
      // that would otherwise send us away to a result's parent page.
      e.preventDefault()
      e.stopPropagation()
      if ((e.ctrlKey || e.metaKey) && onSelect) onSelect(blockId, 'toggle')
      else if (e.shiftKey && onSelect) onSelect(blockId, 'range')
      else onFocus(blockId)
    },
    [blockId, onFocus, onSelect],
  )

  // Detect {{query ...}} blocks and render QueryResult instead of the text
  if (content?.startsWith('{{query ') && content.endsWith('}}')) {
    const expression = content.slice(8, -2).trim()
    return (
      // biome-ignore lint/a11y/useSemanticElements: outer must be a div so inner QueryResult <button>s (chevron, edit pencil) are valid HTML — nested <button> is invalid DOM. See TEST-4c.
      <div
        role="button"
        tabIndex={0}
        className="block-static w-full min-h-[1.75rem] rounded-md text-left text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden [@media(pointer:coarse)]:min-h-[2.75rem]"
        data-testid="block-static"
        data-block-id={blockId}
        aria-label={t('block.editLabel')}
        onClickCapture={handleQueryBlockClickCapture}
        onKeyDown={handleOuterKeyDown}
      >
        <QueryResult
          expression={expression}
          blockId={blockId}
          onNavigate={onNavigate ? (pageId) => onNavigate(pageId) : undefined}
          resolveBlockTitle={resolveBlockTitle}
        />
      </div>
    )
  }

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: outer must be a div so nested interactive children (QueryResult buttons, attachment open buttons) are valid HTML — native <button> cannot contain a <button> descendant. Keyboard semantics are replicated via handleOuterKeyDown. See TEST-4c. */}
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'block-static w-full min-h-[1.75rem] cursor-text rounded-md px-3 py-1 text-left text-sm transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden [@media(pointer:coarse)]:min-h-[2.75rem]',
          isSelected && 'ring-2 ring-primary/50 bg-primary/5',
        )}
        data-testid="block-static"
        data-block-id={blockId}
        aria-label={t('block.editLabel')}
        onClick={handleOuterClick}
        onKeyDown={handleOuterKeyDown}
      >
        {richContent ?? (
          <span className="block-placeholder text-muted-foreground italic">
            {t('block.emptyPlaceholder')}
          </span>
        )}
      </div>
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
