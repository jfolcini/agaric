/**
 * Tests for PdfViewerDialog component.
 *
 * Validates:
 *  - Renders dialog with filename in title when open
 *  - Shows loading state while PDF loads
 *  - Renders page count after load
 *  - Prev/next navigation updates current page
 *  - Closes dialog on close button click
 *  - axe() accessibility audit
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { useIsMobile } from '@/hooks/useIsMobile'
import { logger } from '@/lib/logger'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// MAINT-215: PdfViewerDialog now picks a Dialog (desktop) or Sheet
// (mobile < 768 px) shell via useDialogOrSheet. Default to desktop for
// every pre-existing test; the viewport-switch describe overrides it.
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))
const mockedUseIsMobile = vi.mocked(useIsMobile)

// Mock pdfjs-dist before importing the component
const mockRenderPromise = Promise.resolve()
const mockRender = vi.fn(() => ({
  promise: mockRenderPromise,
  cancel: vi.fn(),
}))
const mockGetPage = vi.fn(() =>
  Promise.resolve({
    getViewport: vi.fn(() => ({ width: 600, height: 800 })),
    render: mockRender,
  }),
)
const mockDestroy = vi.fn()
const mockPdfDoc = {
  numPages: 5,
  getPage: mockGetPage,
  destroy: mockDestroy,
}

// pdfjs v6: getDocument returns a loading task that owns destroy() (the
// document proxy no longer exposes it). The component tears down via the
// loading task, so the mock task must carry destroy.
const mockGetDocument = vi.fn(() => ({
  promise: Promise.resolve(mockPdfDoc),
  destroy: mockDestroy,
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: mockGetDocument as never,
}))

const { PdfViewerDialog } = await import('../PdfViewerDialog')

describe('PdfViewerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(mockPdfDoc),
      destroy: mockDestroy,
    })
    mockGetPage.mockReturnValue(
      Promise.resolve({
        getViewport: vi.fn(() => ({ width: 600, height: 800 })),
        render: mockRender,
      }),
    )
    mockRender.mockReturnValue({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    })
    // MAINT-215: reset to desktop so cross-test mobile overrides never leak.
    mockedUseIsMobile.mockReturnValue(false)
  })

  it('renders nothing when not open', () => {
    render(
      <PdfViewerDialog
        open={false}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )
    expect(screen.queryByText('test.pdf')).not.toBeInTheDocument()
  })

  it('renders dialog with filename in title when open', async () => {
    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/report.pdf"
        filename="report.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('report.pdf')).toBeInTheDocument()
    })
  })

  it('shows loading state while PDF loads', async () => {
    // Make getDocument hang (never resolve)
    let resolveDoc: (value: unknown) => void = () => {}
    mockGetDocument.mockReturnValue({
      promise: new Promise((resolve) => {
        resolveDoc = resolve as (value: unknown) => void
      }),
      destroy: mockDestroy,
    })

    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('pdf-loading')).toBeInTheDocument()
      expect(screen.getByText('Loading PDF...')).toBeInTheDocument()
    })

    // Clean up by resolving the promise
    await act(async () => {
      resolveDoc(mockPdfDoc)
    })
  })

  it('renders page count after load', async () => {
    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('pdf-page-indicator')).toBeInTheDocument()
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })
  })

  it('prev/next navigation updates current page', async () => {
    const user = userEvent.setup()

    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })

    // Navigate to next page
    const nextBtn = screen.getByRole('button', { name: 'Next page' })
    await user.click(nextBtn)

    await waitFor(() => {
      expect(screen.getByText('Page 2 / 5')).toBeInTheDocument()
    })

    // Navigate to previous page
    const prevBtn = screen.getByRole('button', { name: 'Previous page' })
    await user.click(prevBtn)

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })
  })

  it('previous button is disabled on first page', async () => {
    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })

    const prevBtn = screen.getByRole('button', { name: 'Previous page' })
    expect(prevBtn).toBeDisabled()
  })

  it('next button is disabled on last page', async () => {
    userEvent.setup()
    // Use a 1-page PDF
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve({ ...mockPdfDoc, numPages: 1 }),
      destroy: mockDestroy,
    })

    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 1')).toBeInTheDocument()
    })

    const nextBtn = screen.getByRole('button', { name: 'Next page' })
    expect(nextBtn).toBeDisabled()
  })

  it('closes dialog on close button click', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={onOpenChange}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('test.pdf')).toBeInTheDocument()
    })

    const closeButton = screen.getByRole('button', { name: /close/i })
    await user.click(closeButton)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows error state when PDF fails to load', async () => {
    mockGetDocument.mockReturnValue({
      promise: Promise.reject(new Error('Network error')),
      destroy: mockDestroy,
    })

    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/bad.pdf"
        filename="bad.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('pdf-error')).toBeInTheDocument()
      expect(screen.getByText('Error: Network error')).toBeInTheDocument()
    })
  })

  it('calls getDocument with the provided fileUrl', async () => {
    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="asset://localhost/path/to/doc.pdf"
        filename="doc.pdf"
      />,
    )

    await waitFor(() => {
      expect(mockGetDocument).toHaveBeenCalledWith({ url: 'asset://localhost/path/to/doc.pdf' })
    })
  })

  it('has no a11y violations when open with loaded PDF', async () => {
    const { container } = render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('pdf navigation buttons use Button component for touch sizing', async () => {
    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })

    const prevBtn = screen.getByRole('button', { name: 'Previous page' })
    const nextBtn = screen.getByRole('button', { name: 'Next page' })

    expect(prevBtn).toBeInTheDocument()
    expect(nextBtn).toBeInTheDocument()
  })

  it('ArrowRight advances to the next page (UX-280)', async () => {
    const user = userEvent.setup()

    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })

    await user.keyboard('{ArrowRight}')

    await waitFor(() => {
      expect(screen.getByText('Page 2 / 5')).toBeInTheDocument()
    })
  })

  it('ArrowLeft goes back to the previous page (UX-280)', async () => {
    const user = userEvent.setup()

    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })

    await user.keyboard('{ArrowRight}')
    await waitFor(() => {
      expect(screen.getByText('Page 2 / 5')).toBeInTheDocument()
    })

    await user.keyboard('{ArrowLeft}')
    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })
  })

  it('PageDown advances to the next page (UX-280)', async () => {
    const user = userEvent.setup()

    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })

    await user.keyboard('{PageDown}')

    await waitFor(() => {
      expect(screen.getByText('Page 2 / 5')).toBeInTheDocument()
    })
  })

  it('PageUp goes back to the previous page (UX-280)', async () => {
    const user = userEvent.setup()

    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })

    await user.keyboard('{PageDown}')
    await waitFor(() => {
      expect(screen.getByText('Page 2 / 5')).toBeInTheDocument()
    })

    await user.keyboard('{PageUp}')
    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })
  })

  it('End jumps to the last page; Home returns to the first (UX-280)', async () => {
    const user = userEvent.setup()

    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })

    await user.keyboard('{End}')
    await waitFor(() => {
      expect(screen.getByText('Page 5 / 5')).toBeInTheDocument()
    })

    await user.keyboard('{Home}')
    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })
  })

  it('does not navigate when dialog is closed (UX-280)', async () => {
    const user = userEvent.setup()

    const { rerender } = render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })

    rerender(
      <PdfViewerDialog
        open={false}
        onOpenChange={vi.fn()}
        fileUrl="http://example.com/test.pdf"
        filename="test.pdf"
      />,
    )

    // Listener should be unregistered — keypress must not throw or change state
    await user.keyboard('{ArrowRight}')
    expect(screen.queryByText('Page 2 / 5')).not.toBeInTheDocument()
  })

  it('FE-H-14: logs warning when cleanup-time cancel throws', async () => {
    const cancelError = new Error('cleanup cancel failed')
    const cancelMock = vi.fn(() => {
      throw cancelError
    })

    // The global test-setup stubs canvas.getContext to return null, which makes
    // renderPage() bail before calling page.render(). Override locally so the
    // render task is actually parked in renderTaskRef and the cleanup-cancel
    // path runs on unmount.
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() =>
      ({}) as unknown) as typeof HTMLCanvasElement.prototype.getContext

    try {
      // The initial loadPdf renderPage(1) bails (canvas not yet committed),
      // so the first observable mockRender call comes from the Next click,
      // which we make hang and park a task in renderTaskRef whose cancel()
      // throws. Unmounting fires the loadPdf useEffect cleanup which calls
      // cancel() and hits the catch.
      mockRender.mockImplementation(() => ({
        promise: new Promise<void>(() => {}),
        cancel: cancelMock,
      }))

      const user = userEvent.setup()

      const { unmount } = render(
        <PdfViewerDialog
          open={true}
          onOpenChange={vi.fn()}
          fileUrl="http://example.com/test.pdf"
          filename="test.pdf"
        />,
      )

      await waitFor(() => {
        expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
      })

      // Click Next to start a render that hangs and parks a task whose cancel() throws.
      const nextBtn = screen.getByRole('button', { name: 'Next page' })
      await user.click(nextBtn)

      await waitFor(() => {
        expect(mockRender).toHaveBeenCalled()
      })

      // Unmount triggers the loadPdf useEffect cleanup which calls cancel() on
      // the parked task; cancel() throws and the catch logs a warning.
      unmount()

      await waitFor(() => {
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          'PdfViewerDialog',
          'cleanup cancel threw',
          undefined,
          cancelError,
        )
      })
      expect(cancelMock).toHaveBeenCalled()
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })

  it('FE-H-11: logs warning when render-task cancel throws', async () => {
    const cancelError = new Error('cancel failed')
    const cancelMock = vi.fn(() => {
      throw cancelError
    })

    // The global test-setup stubs canvas.getContext to return null, which makes
    // renderPage() bail before calling page.render(). Override locally so the
    // render task is actually parked in renderTaskRef and the cancel path runs.
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() =>
      ({}) as unknown) as typeof HTMLCanvasElement.prototype.getContext

    try {
      // The first navigation render hangs and parks a task in renderTaskRef whose
      // cancel() throws; the next navigation triggers the catch on the cancel path.
      let renderCallCount = 0
      mockRender.mockImplementation(() => {
        renderCallCount++
        if (renderCallCount === 1) {
          return {
            promise: new Promise<void>(() => {}),
            cancel: cancelMock,
          }
        }
        return {
          promise: Promise.resolve(),
          cancel: vi.fn(),
        }
      })

      const user = userEvent.setup()

      render(
        <PdfViewerDialog
          open={true}
          onOpenChange={vi.fn()}
          fileUrl="http://example.com/test.pdf"
          filename="test.pdf"
        />,
      )

      await waitFor(() => {
        expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
      })

      const nextBtn = screen.getByRole('button', { name: 'Next page' })
      // First click: starts the (hanging) render that parks a task in renderTaskRef.
      await user.click(nextBtn)
      // Second click: next renderPage tries to cancel the parked task, which throws.
      await user.click(nextBtn)

      await waitFor(() => {
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          'PdfViewerDialog',
          'render task cancel threw',
          undefined,
          cancelError,
        )
      })
      expect(cancelMock).toHaveBeenCalled()
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })

  // ─── #758 item 3: nav/keyboard/resize render failures route to setError ──
  //
  // renderPage rethrows non-cancellation errors. Previously goToPage, the
  // keyboard shortcuts, and the ResizeObserver callback never caught that
  // rethrow → unhandled rejection + a stale canvas behind an
  // already-advanced page indicator. They now route to the error state.
  describe('page render failures (#758 item 3)', () => {
    function failPageTwo(): void {
      mockGetPage.mockImplementation(
        (pageNum?: unknown) =>
          (pageNum === 2
            ? Promise.reject(new Error('render boom'))
            : Promise.resolve({
                getViewport: vi.fn(() => ({ width: 600, height: 800 })),
                render: mockRender,
              })) as never,
      )
    }

    it('routes a failed render on Next-button navigation to the error state', async () => {
      failPageTwo()
      const user = userEvent.setup()

      render(
        <PdfViewerDialog
          open={true}
          onOpenChange={vi.fn()}
          fileUrl="http://example.com/test.pdf"
          filename="test.pdf"
        />,
      )

      await waitFor(() => {
        expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: 'Next page' }))

      await waitFor(() => {
        expect(screen.getByTestId('pdf-error')).toBeInTheDocument()
      })
      expect(screen.getByText('Error: render boom')).toBeInTheDocument()
      // The stale canvas is gone — no half-rendered page behind the error.
      expect(screen.queryByTestId('pdf-canvas')).not.toBeInTheDocument()
    })

    it('routes a failed render on keyboard navigation to the error state', async () => {
      failPageTwo()
      const user = userEvent.setup()

      render(
        <PdfViewerDialog
          open={true}
          onOpenChange={vi.fn()}
          fileUrl="http://example.com/test.pdf"
          filename="test.pdf"
        />,
      )

      await waitFor(() => {
        expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
      })

      await user.keyboard('{ArrowRight}')

      await waitFor(() => {
        expect(screen.getByTestId('pdf-error')).toBeInTheDocument()
      })
      expect(screen.getByText('Error: render boom')).toBeInTheDocument()
    })

    it('routes a failed resize-triggered render to the error state', async () => {
      // Controllable ResizeObserver (the shared test-setup stub is a no-op).
      type ROCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void
      class MockResizeObserver {
        static instances: MockResizeObserver[] = []
        callback: ROCallback
        constructor(callback: ROCallback) {
          this.callback = callback
          MockResizeObserver.instances.push(this)
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
        fire(): void {
          this.callback([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver)
        }
      }
      vi.stubGlobal('ResizeObserver', MockResizeObserver)

      try {
        render(
          <PdfViewerDialog
            open={true}
            onOpenChange={vi.fn()}
            fileUrl="http://example.com/test.pdf"
            filename="test.pdf"
          />,
        )

        await waitFor(() => {
          expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
        })

        // Any getPage call from here on fails — the resize re-render of the
        // current page hits the catch and surfaces the error.
        mockGetPage.mockReturnValue(Promise.reject(new Error('resize boom')) as never)
        act(() => {
          for (const observer of MockResizeObserver.instances) observer.fire()
        })

        await waitFor(() => {
          expect(screen.getByTestId('pdf-error')).toBeInTheDocument()
        })
        expect(screen.getByText('Error: resize boom')).toBeInTheDocument()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('has no a11y violations in the nav-failure error state', async () => {
      failPageTwo()
      const user = userEvent.setup()

      const { container } = render(
        <PdfViewerDialog
          open={true}
          onOpenChange={vi.fn()}
          fileUrl="http://example.com/test.pdf"
          filename="test.pdf"
        />,
      )

      await waitFor(() => {
        expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
      })
      await user.click(screen.getByRole('button', { name: 'Next page' }))
      await waitFor(() => {
        expect(screen.getByTestId('pdf-error')).toBeInTheDocument()
      })

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ─── #758 item 3: HiDPI canvas backing store ────────────────────────────
  describe('devicePixelRatio rendering (#758 item 3)', () => {
    it('scales the canvas backing store by devicePixelRatio capped at 2', async () => {
      const originalDpr = window.devicePixelRatio
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 })
      // test-setup stubs getContext → null which bails renderPage before the
      // canvas sizing; return a truthy context so the sizing path runs.
      const originalGetContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = (() =>
        ({}) as unknown) as typeof HTMLCanvasElement.prototype.getContext

      try {
        const user = userEvent.setup()

        render(
          <PdfViewerDialog
            open={true}
            onOpenChange={vi.fn()}
            fileUrl="http://example.com/test.pdf"
            filename="test.pdf"
          />,
        )

        await waitFor(() => {
          expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
        })

        // Navigate so renderPage runs with the canvas committed (the
        // ResizeObserver that drives the first render is a no-op in jsdom).
        await user.click(screen.getByRole('button', { name: 'Next page' }))

        await waitFor(() => {
          expect(mockRender).toHaveBeenCalled()
        })

        const canvas = screen.getByTestId('pdf-canvas') as HTMLCanvasElement
        // Mock viewport is 600×800 at any scale; dpr 3 is capped at 2.
        expect(canvas.width).toBe(1200)
        expect(canvas.height).toBe(1600)
        // CSS width stays at the layout scale so the page isn't zoomed;
        // height stays auto so the intrinsic aspect ratio holds even when
        // `max-w-full` clamps the width below style.width.
        expect(canvas.style.width).toBe('600px')
        expect(canvas.style.height).toBe('auto')
        // pdfjs renders through a device-scale transform.
        expect(mockRender).toHaveBeenCalledWith(
          expect.objectContaining({ transform: [2, 0, 0, 2, 0, 0] }),
        )
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext
        Object.defineProperty(window, 'devicePixelRatio', {
          configurable: true,
          value: originalDpr,
        })
      }
    })

    it('renders 1:1 with no transform when devicePixelRatio is 1', async () => {
      const originalDpr = window.devicePixelRatio
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
      const originalGetContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = (() =>
        ({}) as unknown) as typeof HTMLCanvasElement.prototype.getContext

      try {
        const user = userEvent.setup()

        render(
          <PdfViewerDialog
            open={true}
            onOpenChange={vi.fn()}
            fileUrl="http://example.com/test.pdf"
            filename="test.pdf"
          />,
        )

        await waitFor(() => {
          expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
        })

        await user.click(screen.getByRole('button', { name: 'Next page' }))

        await waitFor(() => {
          expect(mockRender).toHaveBeenCalled()
        })

        const canvas = screen.getByTestId('pdf-canvas') as HTMLCanvasElement
        expect(canvas.width).toBe(600)
        expect(canvas.height).toBe(800)
        const renderArgs = (mockRender.mock.calls.at(-1) as unknown[] | undefined)?.[0] as
          | Record<string, unknown>
          | undefined
        expect(renderArgs).toBeDefined()
        expect(renderArgs).not.toHaveProperty('transform')
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext
        Object.defineProperty(window, 'devicePixelRatio', {
          configurable: true,
          value: originalDpr,
        })
      }
    })
  })

  // ─── MAINT-215: useDialogOrSheet('dialog') viewport switch ─────────────
  //
  // On phones < 768 px the outer shell renders as a bottom Sheet so the
  // page-navigation controls sit within thumb reach. The pdfjs renderer,
  // canvas, and keyboard shortcuts are unchanged — assert the dialog body
  // (filename in the header) renders under both viewports.
  describe('viewport switch (MAINT-215)', () => {
    it('renders the PDF viewer body on mobile (Sheet path)', async () => {
      mockedUseIsMobile.mockReturnValue(true)

      render(
        <PdfViewerDialog
          open={true}
          onOpenChange={vi.fn()}
          fileUrl="http://example.com/test.pdf"
          filename="report.pdf"
        />,
      )

      expect(await screen.findByRole('dialog')).toBeInTheDocument()
      expect(screen.getByText('report.pdf')).toBeInTheDocument()
    })

    it('renders the PDF viewer body on desktop (Dialog path)', async () => {
      mockedUseIsMobile.mockReturnValue(false)

      render(
        <PdfViewerDialog
          open={true}
          onOpenChange={vi.fn()}
          fileUrl="http://example.com/test.pdf"
          filename="report.pdf"
        />,
      )

      expect(await screen.findByRole('dialog')).toBeInTheDocument()
      expect(screen.getByText('report.pdf')).toBeInTheDocument()
    })
  })
})
