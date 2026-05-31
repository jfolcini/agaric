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
import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '../lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

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
  // Respect reduced-motion: skip the cross-fade transition (matches the
  // codebase's inline matchMedia convention — see QuickAccessBar).
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

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

  // ArrowLeft/ArrowRight navigation while the lightbox is open. Escape is
  // handled by Radix Dialog. Listener is only attached when open + multiple.
  useEffect(() => {
    if (!open || !hasMultiple) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, hasMultiple, goPrev, goNext])

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
      >
        <DialogTitle className="sr-only">{current.alt}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('lightbox.description', { filename: current.alt })}
        </DialogDescription>

        <img
          key={current.src}
          src={current.src}
          alt={current.alt}
          className={cn(
            'max-w-[90vw] max-h-[90vh] object-contain',
            !reducedMotion && 'transition-opacity',
          )}
          data-testid="lightbox-image"
        />

        {current.caption && (
          <p
            className="absolute bottom-4 left-1/2 -translate-x-1/2 max-w-[80vw] truncate rounded-md bg-black/60 px-3 py-1.5 text-center text-sm text-white/90"
            data-testid="lightbox-caption"
          >
            {current.caption}
          </p>
        )}

        {hasMultiple && (
          <>
            <button
              type="button"
              disabled={!canPrev}
              aria-label={t('lightbox.previous')}
              className={cn(
                'absolute top-1/2 left-4 -translate-y-1/2 inline-flex items-center justify-center',
                'rounded-full bg-black/60 p-2 text-white/80',
                'transition-colors hover:bg-black/80 hover:text-white',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
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
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
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

        {onOpenExternal && (
          <button
            type="button"
            className={cn(
              'absolute bottom-4 right-4 inline-flex items-center gap-1.5',
              'rounded-md bg-black/60 px-3 py-1.5 text-xs text-white/80',
              'transition-colors hover:bg-black/80 hover:text-white',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
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
