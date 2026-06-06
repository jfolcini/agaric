/**
 * StaticBlock — renders a non-focused block as a plain div.
 *
 * Clicking focuses the block, which mounts the TipTap editor.
 * This is the "static div for all non-focused blocks" from the roving editor pattern.
 *
 * Inline tokens (block_link, tag_ref) are rendered as styled spans
 * with optional click-to-navigate (block links) and deleted decoration.
 */

import { Paperclip } from 'lucide-react'
import type React from 'react'
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useBatchAttachments } from '../hooks/useBatchAttachments'
import { useTagClickHandler } from '../hooks/useRichContentCallbacks'
import { logger } from '../lib/logger'
import { openUrl } from '../lib/open-url'
import { getProperty } from '../lib/tauri'
import { cn } from '../lib/utils'
import { useResolveStore } from '../stores/resolve'
import { AttachmentRenderer } from './AttachmentRenderer'
import { ImageLightbox } from './ImageLightbox'
import { DEFAULT_IMAGE_ALIGNMENT, type ImageAlignment } from './ImageResizeToolbar'
import { QueryResult } from './QueryResult'
import { renderRichContent } from './RichContentRenderer'
import { Spinner } from './ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

// Lazy-load PdfViewerDialog to avoid bundling pdfjs-dist on initial load
const LazyPdfViewerDialog = lazy(() =>
  import('./PdfViewerDialog').then((m) => ({ default: m.PdfViewerDialog })),
)

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
  const onTagClick = useTagClickHandler()
  const onTagClickRef = useRef(onTagClick)
  onTagClickRef.current = onTagClick

  // The resolve callbacks are wired through stable refs (so the memo's
  // identity doesn't churn even when the consumer passes a fresh closure
  // each render), but they read a mutable cache. Subscribe to `version`
  // (bumped by preload / set / clearAllForSpace) so the memo recomputes
  // once the space-switch preload lands — otherwise inline page-link
  // chips stay stuck on the `[[ULID]]` fallback after a switch.
  //
  // `onNavigate` is the only prop that ALSO affects the produced output
  // (it gates a `undefined` vs wrapper-fn branch), so it's listed
  // explicitly. The other resolve props feed unconditional wrappers and
  // are intentionally captured via refs — listing them would invalidate
  // the memo on every parent render and defeat the optimization.
  const resolveVersion = useResolveStore((s) => s.version)
  const richContent = useMemo(
    () =>
      content
        ? renderRichContent(content, {
            interactive: true,
            onNavigate: onNavigate ? (id: string) => onNavigateRef.current?.(id) : undefined,
            onTagClick: (id: string) => onTagClickRef.current(id),
            resolveBlockTitle: (id) => resolveBlockTitleRef.current?.(id),
            resolveTagName: (id) => resolveTagNameRef.current?.(id),
            resolveBlockStatus: (id) => resolveBlockStatusRef.current?.(id) ?? 'active',
            resolveTagStatus: (id) => resolveTagStatusRef.current?.(id) ?? 'active',
          })
        : null,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resolve* callbacks captured via refs (intentional perf optimization — see comment above); resolveVersion drives recomputation on cache updates
    [content, onNavigate, resolveVersion],
  )

  // MAINT-131 StaticBlock half: read from the BatchAttachmentsProvider
  // mounted at the BlockTree level so we don't fire one
  // `listAttachments` IPC per static block on every page render. Outside
  // a provider (e.g. unit tests, isolated rendering) the hook returns
  // `null` and we fall back to "no attachments" — matches the previous
  // pre-fetch state of `useBlockAttachments`.
  const batchAttachments = useBatchAttachments()
  const attachments = batchAttachments?.get(blockId) ?? []
  const attachmentsLoading = batchAttachments?.loading ?? false

  // PDF viewer dialog state
  const [pdfViewerOpen, setPdfViewerOpen] = useState(false)
  const [pdfViewerUrl, setPdfViewerUrl] = useState('')
  const [pdfViewerFilename, setPdfViewerFilename] = useState('')

  // Image lightbox state. `images` is the full ordered set of image
  // attachments in this block (#212 item 2 — enables prev/next nav); `index`
  // points at the currently displayed one.
  const [lightboxState, setLightboxState] = useState<{
    images: { src: string; alt: string; fsPath: string; caption?: string | undefined }[]
    index: number
  } | null>(null)

  // Image resize / alignment / caption state (#212 items 3 & 4). Alignment and
  // caption ride the same per-block property mechanism as `image_width`
  // (setProperty/getProperty) — no schema migration.
  const [imageWidth, setImageWidth] = useState('100')
  const [imageAlignment, setImageAlignment] = useState<ImageAlignment>(DEFAULT_IMAGE_ALIGNMENT)
  const [imageCaption, setImageCaption] = useState('')
  const [imageHovered, setImageHovered] = useState(false)

  // Only fetch image properties when the block has image attachments
  const hasImageAttachments =
    !attachmentsLoading && attachments.some((a) => a.mime_type.startsWith('image/'))

  // Load stored image_width / image_alignment / image_caption properties when
  // image attachments are present. PEND-35 Tier 2.4c — single-key PK lookups
  // instead of fetching the whole property vocabulary just to read a few rows.
  useEffect(() => {
    if (!hasImageAttachments) return
    let cancelled = false
    getProperty(blockId, 'image_width')
      .then((widthProp) => {
        if (cancelled) return
        if (widthProp?.value_text) {
          setImageWidth(widthProp.value_text)
        }
      })
      .catch((err) => {
        logger.warn('StaticBlock', 'image width property fetch failed', undefined, err)
      })
    getProperty(blockId, 'image_alignment')
      .then((alignProp) => {
        if (cancelled) return
        const v = alignProp?.value_text
        if (v === 'left' || v === 'center' || v === 'right') {
          setImageAlignment(v)
        }
      })
      .catch((err) => {
        logger.warn('StaticBlock', 'image alignment property fetch failed', undefined, err)
      })
    getProperty(blockId, 'image_caption')
      .then((captionProp) => {
        if (cancelled) return
        if (captionProp?.value_text != null) {
          setImageCaption(captionProp.value_text)
        }
      })
      .catch((err) => {
        logger.warn('StaticBlock', 'image caption property fetch failed', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [blockId, hasImageAttachments])

  const hasAttachments = !attachmentsLoading && attachments.length > 0

  const handleLightboxOpen = useCallback(
    (
      image: { src: string; alt: string; fsPath: string; caption?: string | undefined },
      images: { src: string; alt: string; fsPath: string; caption?: string | undefined }[],
    ) => {
      const index = Math.max(
        0,
        images.findIndex((img) => img.src === image.src),
      )
      setLightboxState({ images, index })
    },
    [],
  )

  const handleLightboxIndexChange = useCallback((index: number) => {
    setLightboxState((prev) => (prev ? { ...prev, index } : prev))
  }, [])

  const handlePdfOpen = useCallback((url: string, filename: string) => {
    // PEND-76 F2 — the PDF url is now a `blob:` object URL (asset protocol is
    // disabled). Revoke any previously-opened blob URL before replacing it so
    // we don't leak across successive opens.
    setPdfViewerUrl((prev) => {
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return url
    })
    setPdfViewerFilename(filename)
    setPdfViewerOpen(true)
  }, [])

  // Revoke the PDF blob URL once the viewer closes (and on unmount) so the
  // object URL created in AttachmentRenderer doesn't leak.
  useEffect(() => {
    if (pdfViewerOpen) return
    if (!pdfViewerUrl.startsWith('blob:')) return
    URL.revokeObjectURL(pdfViewerUrl)
    setPdfViewerUrl('')
  }, [pdfViewerOpen, pdfViewerUrl])

  // MAINT-162: the outer wrapper is a passive container — no role, no
  // tabIndex, no keyboard handler. Inner controls (rich-content link/tag
  // chips, attachment buttons, QueryResult chevron) keep their own focus
  // and keyboard handling. Click on a non-interactive area still focuses
  // the block via handleOuterClick / handleQueryBlockClickCapture so the
  // roving editor can mount.
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
      // MAINT-162: passive container — no role/tabIndex; the inner subtree
      // owns keyboard + focus. Click capture forwards bare-card clicks to
      // onFocus while yielding to inner button/link targets.
      <div
        className="block-static w-full min-h-[1.75rem] rounded-md text-left text-sm [@media(pointer:coarse)]:min-h-[2.75rem]"
        data-testid="block-static"
        data-block-id={blockId}
        onClickCapture={handleQueryBlockClickCapture}
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
      {/* MAINT-162: passive container — no role/tabIndex/aria-label/onKeyDown.
          The wrapper accepts mouse clicks (which mount the roving TipTap
          editor via onFocus) but is not in the tab order. Inner rich-content
          chips (block-link, tag-ref, external-link) and any attachment
          buttons retain their own role/tabIndex/keyboard handling. The two
          a11y suppressions below are the cost of a passive surface that
          converts pointer clicks into editor-mount via onFocus: keyboard
          users reach the same outcome by tabbing to an inner chip/button. */}
      {/* Both suppressions must sit on the single line directly above the
          <div>: oxlint-disable-next-line only affects the immediately
          following line, so stacking them on separate lines left the first
          one disabling the second comment instead of the element. Passive
          container — keyboard activation routes through inner focusable
          controls; see MAINT-162 comment above. */}
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div
        className={cn(
          'block-static w-full min-h-[1.75rem] cursor-text rounded-md px-3 py-1 text-left text-sm transition-colors hover:bg-accent/50 [@media(pointer:coarse)]:min-h-[2.75rem]',
          isSelected && 'ring-2 ring-primary/50 bg-primary/5',
        )}
        data-testid="block-static"
        data-block-id={blockId}
        onClick={handleOuterClick}
      >
        {richContent ?? (
          <span className="block-placeholder text-muted-foreground italic">
            {t('block.emptyPlaceholder')}
          </span>
        )}
        {!content?.trim() && !hasAttachments && !attachmentsLoading && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-hidden="true"
                className="pointer-events-none float-right ml-2 opacity-0 transition-opacity group-hover:opacity-40 group-focus-within:opacity-40 [@media(pointer:coarse)]:hidden"
              >
                <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {t('block.attachHint')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {hasAttachments && (
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
      )}
      <Suspense fallback={<Spinner />}>
        <LazyPdfViewerDialog
          open={pdfViewerOpen}
          onOpenChange={setPdfViewerOpen}
          fileUrl={pdfViewerUrl}
          filename={pdfViewerFilename}
        />
      </Suspense>
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

export const StaticBlock = memo(StaticBlockInner)
StaticBlock.displayName = 'StaticBlock'
