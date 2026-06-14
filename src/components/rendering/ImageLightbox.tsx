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

import { ChevronLeft, ChevronRight, ExternalLink, Maximize2, Minus, Plus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { getShortcutKeys } from '@/lib/keyboard-config'
import { cn } from '@/lib/utils'

/**
 * #1104 — append the current keyboard binding (if any) to a label so the
 * icon-only zoom buttons surface their hotkey via the accessible name. Mirrors
 * GraphView's `withShortcut` (UX-356); returns the bare label when no binding
 * is configured to avoid a stray "()". The lightbox shares the graph's `+/-/0`
 * bindings, so it reuses the `graphZoom*` shortcut ids.
 */
function withShortcut(label: string, shortcutId: string): string {
  const keys = getShortcutKeys(shortcutId)
  return keys ? `${label} (${keys})` : label
}

/** Zoom bounds and step for lightbox zoom/pan (#294 item 7). */
const ZOOM_MIN = 1
const ZOOM_MAX = 4
const ZOOM_STEP = 0.25
/** Pixels panned per arrow-key press while zoomed in. */
const PAN_KEY_STEP = 60

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

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

  // Zoom/pan state (#294 item 7). `zoom` is a scale factor (1 = fit); `pan` is
  // the translation in CSS px applied before the scale. Both reset whenever the
  // displayed image or open state changes.
  const imgRef = useRef<HTMLImageElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  // Pointer-drag anchor: pointer + pan position captured at pointerdown.
  const dragOrigin = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const zoomed = zoom > ZOOM_MIN

  // Clamp a pan offset so the (scaled) image can't be dragged entirely off the
  // viewport — at most half the overflow in each axis. Reads the rendered image
  // size, which is unaffected by the CSS transform.
  const clampPan = useCallback((p: { x: number; y: number }, z: number) => {
    const img = imgRef.current
    if (!img || z <= ZOOM_MIN) return { x: 0, y: 0 }
    const maxX = (img.clientWidth * (z - 1)) / 2
    const maxY = (img.clientHeight * (z - 1)) / 2
    return { x: clamp(p.x, -maxX, maxX), y: clamp(p.y, -maxY, maxY) }
  }, [])

  const zoomBy = useCallback((delta: number) => {
    setZoom((z) => clamp(Number((z + delta).toFixed(2)), ZOOM_MIN, ZOOM_MAX))
  }, [])

  const resetZoom = useCallback(() => {
    setZoom(ZOOM_MIN)
    setPan({ x: 0, y: 0 })
  }, [])

  const panBy = useCallback(
    (dx: number, dy: number) => {
      setPan((p) => clampPan({ x: p.x + dx, y: p.y + dy }, zoom))
    },
    [clampPan, zoom],
  )

  // Re-clamp pan whenever the zoom changes (e.g. zooming back out recenters).
  useEffect(() => {
    setPan((p) => clampPan(p, zoom))
  }, [zoom, clampPan])

  // Reset zoom/pan when the displayed image or open state changes.
  useEffect(() => {
    resetZoom()
  }, [safeIndex, open, resetZoom])

  // Keyboard: +/-/0 zoom always; arrows pan when zoomed, else navigate the set.
  // Escape is handled by Radix Dialog. Listener attaches whenever open.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      switch (e.key) {
        case '+':
        case '=':
          e.preventDefault()
          zoomBy(ZOOM_STEP)
          break
        case '-':
        case '_':
          e.preventDefault()
          zoomBy(-ZOOM_STEP)
          break
        case '0':
          e.preventDefault()
          resetZoom()
          break
        case 'ArrowLeft':
          if (zoomed) {
            e.preventDefault()
            panBy(PAN_KEY_STEP, 0)
          } else if (hasMultiple) {
            e.preventDefault()
            goPrev()
          }
          break
        case 'ArrowRight':
          if (zoomed) {
            e.preventDefault()
            panBy(-PAN_KEY_STEP, 0)
          } else if (hasMultiple) {
            e.preventDefault()
            goNext()
          }
          break
        case 'ArrowUp':
          if (zoomed) {
            e.preventDefault()
            panBy(0, PAN_KEY_STEP)
          }
          break
        case 'ArrowDown':
          if (zoomed) {
            e.preventDefault()
            panBy(0, -PAN_KEY_STEP)
          }
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, hasMultiple, zoomed, goPrev, goNext, zoomBy, resetZoom, panBy])

  // Wheel-to-zoom — chrome-free and centred on the current view (#294 item 7).
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
    },
    [zoomBy],
  )

  // Pointer drag-to-pan, active only while zoomed in.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!zoomed) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragOrigin.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
      setDragging(true)
    },
    [zoomed, pan.x, pan.y],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const origin = dragOrigin.current
      if (!origin) return
      setPan(
        clampPan(
          { x: origin.panX + (e.clientX - origin.x), y: origin.panY + (e.clientY - origin.y) },
          zoom,
        ),
      )
    },
    [clampPan, zoom],
  )

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragOrigin.current) return
    dragOrigin.current = null
    setDragging(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [])

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

        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- when zoomed the image is the pan surface (pointer drag) and wheel zoom target; activation stays on the close/nav buttons */}
        <img
          key={current.src}
          ref={imgRef}
          src={current.src}
          alt={current.alt}
          className={cn(
            'max-w-[90vw] max-h-[90vh] object-contain touch-none select-none',
            !reducedMotion && !dragging && 'transition-transform',
            zoomed && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
          )}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          draggable={false}
          data-testid="lightbox-image"
        />

        {zoomed && (
          <span
            className="absolute top-4 left-4 rounded-md bg-black/60 px-2 py-1 text-xs text-white/80"
            data-testid="lightbox-zoom-badge"
            aria-live="polite"
          >
            {t('lightbox.zoom', { percent: Math.round(zoom * 100) })}
          </span>
        )}

        {current.caption && (
          <p
            className="absolute bottom-4 left-1/2 -translate-x-1/2 max-w-[80vw] truncate rounded-md bg-black/60 px-3 py-1.5 text-center text-sm text-white/90"
            data-testid="lightbox-caption"
          >
            {current.caption}
          </p>
        )}

        {/*
         * #1104 — persistent on-screen zoom cluster (bottom-left, mirroring
         * GraphView's bottom-right stack at GraphView.tsx:335-359). Surfaces the
         * otherwise wheel/keyboard-only zoom and advertises the +/-/0 shortcuts
         * via `withShortcut` in each button's accessible name. Wired to the same
         * `zoomBy`/`resetZoom` handlers the wheel/keyboard paths use, so all
         * input paths stay in sync. Disabled at the bounds: ZoomIn at ZOOM_MAX,
         * ZoomOut + Reset when not zoomed in (ZOOM_MIN).
         */}
        <div
          className="absolute bottom-4 left-4 flex flex-col gap-1"
          data-testid="lightbox-zoom-controls"
        >
          <IconButton
            variant="outline"
            disabled={zoom >= ZOOM_MAX}
            onClick={(e) => {
              e.stopPropagation()
              zoomBy(ZOOM_STEP)
            }}
            tooltip={t('lightbox.zoomIn')}
            ariaLabel={withShortcut(t('lightbox.zoomIn'), 'graphZoomIn')}
            data-testid="lightbox-zoom-in"
          >
            <Plus className="h-4 w-4" />
          </IconButton>
          <IconButton
            variant="outline"
            disabled={!zoomed}
            onClick={(e) => {
              e.stopPropagation()
              zoomBy(-ZOOM_STEP)
            }}
            tooltip={t('lightbox.zoomOut')}
            ariaLabel={withShortcut(t('lightbox.zoomOut'), 'graphZoomOut')}
            data-testid="lightbox-zoom-out"
          >
            <Minus className="h-4 w-4" />
          </IconButton>
          <IconButton
            variant="outline"
            disabled={!zoomed}
            onClick={(e) => {
              e.stopPropagation()
              resetZoom()
            }}
            tooltip={t('lightbox.zoomReset')}
            ariaLabel={withShortcut(t('lightbox.zoomReset'), 'graphZoomReset')}
            data-testid="lightbox-zoom-reset"
          >
            <Maximize2 className="h-4 w-4" />
          </IconButton>
        </div>

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

        {onOpenExternal && (
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
