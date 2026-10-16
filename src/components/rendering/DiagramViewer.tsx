/**
 * DiagramViewer — the Expand button and full-screen zoomable view for a
 * rendered diagram or display equation (#5638).
 *
 * `children` is the content at its natural size. The view opens fitted to the
 * screen (never enlarged past 100%), on the app's own surface so a
 * light-theme diagram is not shown on black, and offers Copy source plus,
 * when `svg` is given, Download SVG.
 *
 * Place it inside a `relative group/diagram` box: the button sits in its
 * top-right corner and shows on hover there.
 *
 * The button stops its click so a static block does not enter edit mode, and
 * the dialog stops the clicks and touches that would otherwise bubble through
 * the React tree to the block row (edit mode, swipe, long-press, drag).
 */

import { Copy, Download, Expand } from 'lucide-react'
import { useCallback, useLayoutEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ZoomControls } from '@/components/rendering/ZoomControls'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { useZoomPan } from '@/hooks/useZoomPan'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'

/** Space kept between the fitted content and the screen edge, in CSS px. */
const FIT_MARGIN = 32

const stop = (e: React.SyntheticEvent) => e.stopPropagation()
const STOP_BUBBLING = {
  onClick: stop,
  onContextMenu: stop,
  onTouchStart: stop,
  onTouchMove: stop,
  onTouchEnd: stop,
}

export interface DiagramViewerProps {
  /** Accessible name of the content, used as the dialog title. */
  title: string
  /** Text copied by the Copy button. */
  source: string
  copyLabel: string
  /** Natural-size SVG markup; adds Download SVG. */
  svg?: string | undefined
  children: React.ReactNode
}

export function DiagramViewer({
  title,
  source,
  copyLabel,
  svg,
  children,
}: DiagramViewerProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const [fit, setFit] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!viewport || !content) return
    // oxlint-disable-next-line react/set-state-in-effect -- the fit depends on the laid-out sizes of the screen and the content
    setFit(
      Math.min(
        1,
        (viewport.clientWidth - FIT_MARGIN) / (content.offsetWidth || 1),
        (viewport.clientHeight - FIT_MARGIN) / (content.offsetHeight || 1),
      ),
    )
  }, [viewport, content])

  const zoomPan = useZoomPan({ active: open, minZoom: fit ?? 1, resetKey: fit, wheel: 'pan' })
  const { zoom, dragging, zoomed, setNode, setGestureNode } = zoomPan
  const setSurface = useCallback(
    (node: HTMLDivElement | null) => {
      setContent(node)
      setNode(node)
    },
    [setNode],
  )
  // The whole screen takes gestures: the fitted diagram can be a thin strip.
  const setGestureArea = useCallback(
    (node: HTMLDivElement | null) => {
      setViewport(node)
      setGestureNode(node)
    },
    [setGestureNode],
  )
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    // Re-measure on the next open: the screen may have changed size meanwhile.
    if (!next) setFit(null)
  }

  const copy = () => {
    writeText(source)
      .then(() => notify.success(t('diagramViewer.copied')))
      .catch((err: unknown) => {
        logger.warn('DiagramViewer', 'copy source failed', undefined, err)
        notify.error(t('diagramViewer.copyFailed'))
      })
  }

  const download = () => {
    if (!svg) return
    // Loaded on demand: the export module is heavy and only this button needs it.
    import('@/lib/export-graph')
      .then(({ downloadBlob }) =>
        downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'diagram.svg'),
      )
      .catch((err: unknown) => {
        logger.warn('DiagramViewer', 'download SVG failed', undefined, err)
        notify.error(t('diagramViewer.downloadFailed'))
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <IconButton
          variant="outline"
          size="icon-sm"
          tooltip={t('diagramViewer.expand')}
          ariaLabel={t('diagramViewer.expand')}
          className="absolute top-2 right-2 bg-background [@media(pointer:fine)]:opacity-0 group-hover/diagram:opacity-100 focus-visible:opacity-100"
          onClick={stop}
          data-testid="diagram-expand"
        >
          <Expand className="h-4 w-4" />
        </IconButton>
      </DialogTrigger>
      <DialogContent
        // Keeps a mounted editor from saving and unmounting when focus moves in.
        data-editor-portal=""
        className="h-dvh max-h-none w-screen max-w-none gap-0 rounded-none border-0 bg-background p-0 text-foreground sm:max-w-none"
        // Focus the dialog, not its first button: an IconButton's tooltip opens
        // on focus and would swallow Escape (as in ImageLightbox, #1104).
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus()
        }}
        data-testid="diagram-viewer"
        {...STOP_BUBBLING}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{t('diagramViewer.description')}</DialogDescription>

        <div
          ref={setGestureArea}
          {...zoomPan.gestureHandlers}
          className={cn(
            'relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden select-none',
            zoomed && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
          )}
        >
          <div
            ref={setSurface}
            style={zoomPan.style}
            className={cn('shrink-0', fit === null && 'invisible')}
            data-testid="diagram-viewer-surface"
          >
            {children}
          </div>
        </div>

        <div className="absolute top-4 left-4 flex flex-wrap items-center gap-2 pr-16">
          <Button variant="outline" size="sm" onClick={copy} data-testid="diagram-viewer-copy">
            <Copy className="h-4 w-4" aria-hidden="true" />
            {copyLabel}
          </Button>
          {svg && (
            <Button
              variant="outline"
              size="sm"
              onClick={download}
              data-testid="diagram-viewer-download"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {t('diagramViewer.downloadSvg')}
            </Button>
          )}
        </div>

        <div className="absolute bottom-4 left-4 flex flex-col items-start gap-1">
          <span
            className="rounded-md bg-muted px-2 py-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
            aria-live="polite"
            data-testid="diagram-viewer-zoom"
          >
            {t('diagramViewer.zoom', { percent: Math.round(zoom * 100) })}
          </span>
          <ZoomControls
            zoomPan={zoomPan}
            resetLabel={t('diagramViewer.fit')}
            actualSize
            testIdPrefix="diagram-viewer"
            className="flex flex-col gap-1"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
