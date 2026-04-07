/**
 * PdfViewerDialog — renders a PDF file in a near-full-screen Radix Dialog
 * using pdf.js to render pages onto <canvas> elements.
 *
 * Features:
 * - Loads PDF via pdfjs-dist getDocument()
 * - Renders pages as <canvas> elements in a scrollable container
 * - Page count indicator ("Page 1 / 5")
 * - Prev/Next page navigation
 * - Cleans up PDF document on close
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ScrollArea } from './ui/scroll-area'

// Set worker path — served from public/
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

export interface PdfViewerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileUrl: string
  filename: string
}

export function PdfViewerDialog({
  open,
  onOpenChange,
  fileUrl,
  filename,
}: PdfViewerDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderTaskRef = useRef<ReturnType<pdfjsLib.PDFPageProxy['render']> | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const currentPageRef = useRef(currentPage)
  currentPageRef.current = currentPage

  /** Render a specific page onto the canvas. */
  const renderPage = useCallback(async (pageNum: number) => {
    const pdfDoc = pdfDocRef.current
    const canvas = canvasRef.current
    if (!pdfDoc || !canvas) return

    // Cancel any in-progress render
    if (renderTaskRef.current) {
      try {
        renderTaskRef.current.cancel()
      } catch {
        // Ignore cancel errors
      }
      renderTaskRef.current = null
    }

    try {
      const page = await pdfDoc.getPage(pageNum)

      // Calculate adaptive scale based on container width
      const containerWidth = containerRef.current?.clientWidth
      let scale = 1.5 // fallback when container is not yet measured
      if (containerWidth && containerWidth > 0) {
        const defaultWidth = page.getViewport({ scale: 1 }).width
        if (defaultWidth > 0) {
          scale = Math.min(3.0, Math.max(0.5, containerWidth / defaultWidth))
        }
      }

      const viewport = page.getViewport({ scale })

      canvas.height = viewport.height
      canvas.width = viewport.width

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const renderTask = page.render({
        canvasContext: ctx,
        viewport,
        canvas: null,
      })
      renderTaskRef.current = renderTask

      await renderTask.promise
      renderTaskRef.current = null
    } catch (err) {
      // Ignore cancelled render tasks
      if (err instanceof Error && err.message.includes('Rendering cancelled')) {
        return
      }
      // Re-throw other errors
      throw err
    }
  }, [])

  /** Load the PDF document when the dialog opens. */
  useEffect(() => {
    if (!open || !fileUrl) return

    let cancelled = false

    async function loadPdf() {
      setLoading(true)
      setError(null)
      setCurrentPage(1)
      setNumPages(0)

      try {
        const loadingTask = pdfjsLib.getDocument(fileUrl)
        const pdfDoc = await loadingTask.promise
        if (cancelled) {
          pdfDoc.destroy()
          return
        }

        pdfDocRef.current = pdfDoc
        setNumPages(pdfDoc.numPages)
        setLoading(false)
        await renderPage(1)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF')
          setLoading(false)
        }
      }
    }

    loadPdf()

    return () => {
      cancelled = true
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel()
        } catch {
          // Ignore
        }
        renderTaskRef.current = null
      }
      if (pdfDocRef.current) {
        pdfDocRef.current.destroy()
        pdfDocRef.current = null
      }
    }
  }, [open, fileUrl, renderPage])

  /** Navigate to a different page. */
  const goToPage = useCallback(
    async (pageNum: number) => {
      if (pageNum < 1 || pageNum > numPages) return
      setCurrentPage(pageNum)
      await renderPage(pageNum)
    },
    [numPages, renderPage],
  )

  const goToPrev = useCallback(() => {
    if (currentPage > 1) goToPage(currentPage - 1)
  }, [currentPage, goToPage])

  const goToNext = useCallback(() => {
    if (currentPage < numPages) goToPage(currentPage + 1)
  }, [currentPage, numPages, goToPage])

  /** Re-render the current page when the container resizes. */
  useEffect(() => {
    const container = containerRef.current
    if (!container || numPages === 0) return

    const observer = new ResizeObserver(() => {
      renderPage(currentPageRef.current)
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [numPages, renderPage])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{filename}</DialogTitle>
          <DialogDescription className="sr-only">PDF viewer for {filename}</DialogDescription>
        </DialogHeader>

        <div ref={containerRef} className="flex-1 min-h-0">
          <ScrollArea className="h-full bg-muted/30 rounded-md">
            <div className="flex items-start justify-center">
              {loading && (
                <div className="flex items-center justify-center p-8" data-testid="pdf-loading">
                  <span className="text-muted-foreground text-sm">Loading PDF...</span>
                </div>
              )}

              {error && (
                <div className="flex items-center justify-center p-8" data-testid="pdf-error">
                  <span className="text-destructive text-sm">Error: {error}</span>
                </div>
              )}

              {!loading && !error && numPages > 0 && (
                <canvas ref={canvasRef} className="max-w-full" data-testid="pdf-canvas" />
              )}
            </div>
          </ScrollArea>
        </div>

        {!loading && !error && numPages > 0 && (
          <div className="flex items-center justify-center gap-4 pt-2" data-testid="pdf-nav">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={goToPrev}
              disabled={currentPage <= 1}
              aria-label={t('pdfViewer.previousPageLabel')}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground" data-testid="pdf-page-indicator">
              Page {currentPage} / {numPages}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={goToNext}
              disabled={currentPage >= numPages}
              aria-label={t('pdfViewer.nextPageLabel')}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
