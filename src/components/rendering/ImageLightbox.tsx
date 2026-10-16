/**
 * ImageLightbox — fullscreen image viewer using Radix Dialog.
 *
 * Displays an image centered on a dark overlay.
 * Closes on Escape, click outside, or the top-right close button
 * (provided by DialogContent via CloseButtonIcon).
 *
 * When the surrounding block contains more than one image (#212 item 2),
 * on-screen Prev/Next buttons and a counter appear, and ArrowLeft/ArrowRight
 * cycle through the set. Navigation clamps at the ends (no wrap); the Prev/Next
 * button is disabled at the corresponding boundary. A single image shows no
 * navigation chrome.
 *
 * Optionally calls `onOpenExternal` to open the current image in an external app.
 */

import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ZoomControls } from '@/components/rendering/ZoomControls'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useZoomPan } from '@/hooks/useZoomPan'
import { shouldReduceMotion } from '@/lib/preferences'
import { cn } from '@/lib/utils'

export interface LightboxImage {
  src: string
  alt: string
  /** Optional caption shown under the image (#212 item 3). */
  caption?: string | undefined
}

export interface ImageLightboxProps {
  /** All images in the current block/page, in render order. */
  images: LightboxImage[]
  /** Index into `images` of the currently displayed image. */
  index: number
  /** Called with the new index when the user navigates (clamped by caller-safe internals). */
  onIndexChange: (index: number) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Optional callback to open the current image externally (e.g. in the OS viewer). */
  onOpenExternal?: (() => void) | undefined
}

export function ImageLightbox({
  images,
  index,
  onIndexChange,
  open,
  onOpenChange,
  onOpenExternal,
}: ImageLightboxProps): React.ReactElement | null {
  const { t } = useTranslation()
  // Respect reduced-motion: skip the cross-fade transition.
  const reducedMotion = shouldReduceMotion()

  const count = images.length
  // Guard against a stale/out-of-range index (e.g. attachment list changed).
  const safeIndex = count === 0 ? 0 : Math.min(Math.max(index, 0), count - 1)
  const current = images[safeIndex]
  const hasMultiple = count > 1
  const canPrev = hasMultiple && safeIndex > 0
  const canNext = hasMultiple && safeIndex < count - 1

  const goPrev = useCallback(() => {
    if (safeIndex > 0) onIndexChange(safeIndex - 1)
  }, [safeIndex, onIndexChange])

  const goNext = useCallback(() => {
    if (safeIndex < count - 1) onIndexChange(safeIndex + 1)
  }, [safeIndex, count, onIndexChange])

  // Broken-source guard: when the <img> fails to load (deleted/moved
  // attachment, revoked blob URL, unreachable fsPath) we swap in a labelled
  // in-dialog fallback instead of leaving the user on a broken-image glyph over
  // a black overlay. Reset whenever the displayed image / open state changes.
  const [imgError, setImgError] = useState(false)
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- a new image or a fresh open gets a fresh load attempt; see #4407
    setImgError(false)
  }, [safeIndex, open])

  // Zoom/pan (#294 item 7): zoom 1 is the fitted image. Arrows navigate the set
  // while not zoomed in, and pan it once zoomed.
  const onUnzoomedArrow = useCallback(
    (key: 'ArrowLeft' | 'ArrowRight') => {
      if (!hasMultiple) return false
      if (key === 'ArrowLeft') goPrev()
      else goNext()
      return true
    },
    [hasMultiple, goPrev, goNext],
  )
  const zoomPan = useZoomPan({ active: open, resetKey: safeIndex, onUnzoomedArrow })
  const { zoom, zoomed, dragging, setNode, surfaceProps } = zoomPan

  if (!current) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'bg-black/80 border-0 shadow-none rounded-none p-0',
          'max-w-[90vw] sm:max-w-[90vw] max-h-[90vh]',
          'flex items-center justify-center',
          '[&>[data-slot=dialog-close]]:text-white [&>[data-slot=dialog-close]]:hover:text-white/80',
        )}
        // #1104 — direct initial focus to the dialog container rather than the
        // first focusable control (the new zoom cluster). IconButton embeds a
        // Radix tooltip that opens on focus; an open tooltip is a DismissableLayer
        // that swallows Escape, so auto-focusing a zoom button would break the
        // lightbox's Escape-to-close. Focusing the content keeps the focus trap
        // intact while letting Escape reach the Dialog's own dismiss handler.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus()
        }}
      >
        <DialogTitle className="sr-only">{current.alt}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('lightbox.description', { filename: current.alt })}
        </DialogDescription>

        {imgError ? (
          <div
            className="flex max-w-[90vw] flex-col items-center gap-2 px-6 py-10 text-center text-white/80"
            data-testid="lightbox-image-error"
          >
            <p className="text-sm font-medium">{current.alt}</p>
            <p className="text-sm text-white/70">{t('lightbox.loadError')}</p>
            {onOpenExternal && (
              <button
                type="button"
                className={cn(
                  'mt-2 inline-flex items-center gap-1.5',
                  'rounded-md bg-black/60 px-3 py-1.5 text-xs text-white/80',
                  'transition-colors hover:bg-black/80 hover:text-white',
                  'focus-ring-visible',
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenExternal()
                }}
                data-testid="lightbox-error-open-external"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                {t('lightbox.openExternal')}
              </button>
            )}
          </div>
        ) : (
          <img
            key={current.src}
            ref={setNode}
            src={current.src}
            alt={current.alt}
            className={cn(
              'max-w-[90vw] max-h-[90vh] object-contain touch-none select-none',
              !reducedMotion && !dragging && 'transition-transform',
              zoomed && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
            )}
            {...surfaceProps}
            onError={() => setImgError(true)}
            draggable={false}
            data-testid="lightbox-image"
          />
        )}

        {!imgError && zoomed && (
          <span
            className="absolute top-4 left-4 rounded-md bg-black/60 px-2 py-1 text-xs text-white/80"
            data-testid="lightbox-zoom-badge"
            aria-live="polite"
          >
            {t('lightbox.zoom', { percent: Math.round(zoom * 100) })}
          </span>
        )}

        {!imgError && current.caption && (
          <p
            className="absolute bottom-4 left-1/2 -translate-x-1/2 max-w-[80vw] truncate rounded-md bg-black/60 px-3 py-1.5 text-center text-sm text-white/90"
            data-testid="lightbox-caption"
          >
            {current.caption}
          </p>
        )}

        {/* #1104 — on-screen zoom cluster, hidden when there is no image to act on. */}
        {!imgError && (
          <ZoomControls
            zoomPan={zoomPan}
            resetLabel={t('lightbox.zoomReset')}
            testIdPrefix="lightbox"
            className="absolute bottom-4 left-4 flex flex-col gap-1"
          />
        )}

        {!imgError && hasMultiple && (
          <>
            <button
              type="button"
              disabled={!canPrev}
              aria-label={t('lightbox.previous')}
              className={cn(
                'absolute top-1/2 left-4 -translate-y-1/2 inline-flex items-center justify-center',
                'rounded-full bg-black/60 p-2 text-white/80',
                'transition-colors hover:bg-black/80 hover:text-white',
                'focus-ring-visible',
                'disabled:opacity-30 disabled:pointer-events-none',
              )}
              onClick={(e) => {
                e.stopPropagation()
                goPrev()
              }}
              data-testid="lightbox-prev"
            >
              <ChevronLeft className="h-6 w-6" aria-hidden="true" />
            </button>

            <button
              type="button"
              disabled={!canNext}
              aria-label={t('lightbox.next')}
              className={cn(
                'absolute top-1/2 right-4 -translate-y-1/2 inline-flex items-center justify-center',
                'rounded-full bg-black/60 p-2 text-white/80',
                'transition-colors hover:bg-black/80 hover:text-white',
                'focus-ring-visible',
                'disabled:opacity-30 disabled:pointer-events-none',
              )}
              onClick={(e) => {
                e.stopPropagation()
                goNext()
              }}
              data-testid="lightbox-next"
            >
              <ChevronRight className="h-6 w-6" aria-hidden="true" />
            </button>

            <span
              className="absolute top-4 left-1/2 -translate-x-1/2 rounded-md bg-black/60 px-2 py-1 text-xs text-white/80"
              data-testid="lightbox-counter"
              aria-live="polite"
            >
              {t('lightbox.counter', { current: safeIndex + 1, total: count })}
            </span>
          </>
        )}

        {!imgError && onOpenExternal && (
          <button
            type="button"
            className={cn(
              'absolute bottom-4 right-4 inline-flex items-center gap-1.5',
              'rounded-md bg-black/60 px-3 py-1.5 text-xs text-white/80',
              'transition-colors hover:bg-black/80 hover:text-white',
              'focus-ring-visible',
            )}
            onClick={(e) => {
              e.stopPropagation()
              onOpenExternal()
            }}
            data-testid="lightbox-open-external"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            {t('lightbox.openExternal')}
          </button>
        )}
      </DialogContent>
    </Dialog>
  )
}
