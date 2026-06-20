/**
 * Tests PdfViewerDialog (#1452 — prebuilt pdf.js viewer + annotation editor).
 *
 * Validates:
 * - Renders the dialog filename in the title when open
 * - Shows loading state while the PDF loads
 * - Mounts the prebuilt PDFViewer (text + annotation layers) and renders the
 *   page indicator after load
 * - Prev/next navigation drives the viewer's current page
 * - The annotation toolbar appears only when blockId + attachmentId are given
 * - Save bakes annotations via pdfDocument.saveDocument(), writes a NEW
 *   attachment (addAttachmentWithBytes), deletes the original, and notifies
 * - Closes the dialog on close button click
 * - axe() accessibility audit
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { useIsMobile } from '@/hooks/useIsMobile'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))
const mockedUseIsMobile = vi.mocked(useIsMobile)

// Mock the attachment IPC so the save path can be asserted without a backend.
const mockAddAttachmentWithBytes = vi.fn()
const mockDeleteAttachment = vi.fn()
vi.mock('@/lib/tauri', () => ({
  addAttachmentWithBytes: (...args: unknown[]) => mockAddAttachmentWithBytes(...args),
  deleteAttachment: (...args: unknown[]) => mockDeleteAttachment(...args),
}))

const mockNotify = {
  loading: vi.fn(() => 'toast-id'),
  success: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}
vi.mock('@/lib/notify', () => ({ notify: mockNotify }))

// ─── pdfjs-dist core (getDocument + saveDocument) ──────────────────────────
const mockSaveDocument = vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]).buffer))
const mockPdfDoc = { numPages: 5, saveDocument: mockSaveDocument }
const mockGetDocument = vi.fn()
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}))

// ─── pdfjs-dist prebuilt viewer component ──────────────────────────────────
// A tiny EventBus stand-in so the component can register + fire handlers.
class MockEventBus {
  handlers = new Map<string, ((evt: unknown) => void)[]>()
  on(name: string, cb: (evt: unknown) => void): void {
    const list = this.handlers.get(name) ?? []
    list.push(cb)
    this.handlers.set(name, list)
  }
  off(): void {}
  dispatch(name: string, evt: unknown): void {
    for (const cb of this.handlers.get(name) ?? []) cb(evt)
  }
}

let lastViewer: MockPDFViewer | null = null
let lastEventBus: MockEventBus | null = null
class MockPDFViewer {
  setDocument = vi.fn()
  cleanup = vi.fn()
  currentPageNumber = 1
  annotationEditorMode: { mode: number } = { mode: 0 }
  eventBus: MockEventBus
  constructor(opts: { eventBus: MockEventBus }) {
    this.eventBus = opts.eventBus
    // The test needs a handle to the constructed viewer instance to assert
    // against; record it via a static factory hook rather than aliasing `this`.
    MockPDFViewer.onConstruct(this, opts.eventBus)
  }
  static onConstruct: (viewer: MockPDFViewer, bus: MockEventBus) => void = (viewer, bus) => {
    lastViewer = viewer
    lastEventBus = bus
  }
}
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  EventBus: MockEventBus,
  GenericL10n: class {
    constructor(_lang: string) {}
  },
  PDFLinkService: class {
    constructor(_opts: unknown) {}
    setViewer(): void {}
    setDocument(): void {}
  },
  PDFViewer: MockPDFViewer,
}))
vi.mock('pdfjs-dist/web/pdf_viewer.css', () => ({}))

// Import AFTER mocks so the component picks them up.
const { PdfViewerDialog } = await import('@/components/dialogs/PdfViewerDialog')

beforeEach(() => {
  vi.clearAllMocks()
  lastViewer = null
  lastEventBus = null
  mockGetDocument.mockReturnValue({
    promise: Promise.resolve(mockPdfDoc),
    destroy: vi.fn(),
  })
  mockSaveDocument.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
  mockAddAttachmentWithBytes.mockResolvedValue({ id: 'new-att-id' })
  mockDeleteAttachment.mockResolvedValue(undefined)
  mockNotify.loading.mockReturnValue('toast-id')
  mockedUseIsMobile.mockReturnValue(false)
})

describe('PdfViewerDialog', () => {
  it('renders nothing when not open', () => {
    render(
      <PdfViewerDialog
        open={false}
        onOpenChange={vi.fn()}
        fileUrl="blob:test"
        filename="test.pdf"
      />,
    )
    expect(screen.queryByText('test.pdf')).not.toBeInTheDocument()
  })

  it('renders the filename in the title when open', async () => {
    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="blob:report"
        filename="report.pdf"
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('report.pdf')).toBeInTheDocument()
    })
  })

  it('shows loading state while the PDF loads', async () => {
    let resolveDoc: (v: unknown) => void = () => {}
    mockGetDocument.mockReturnValue({
      promise: new Promise((resolve) => {
        resolveDoc = resolve as (v: unknown) => void
      }),
      destroy: vi.fn(),
    })

    render(
      <PdfViewerDialog open={true} onOpenChange={vi.fn()} fileUrl="blob:t" filename="test.pdf" />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('pdf-loading')).toBeInTheDocument()
      expect(screen.getByText('Loading PDF...')).toBeInTheDocument()
    })

    resolveDoc(mockPdfDoc)
  })

  it('mounts the prebuilt PDFViewer and renders the page indicator after load', async () => {
    render(
      <PdfViewerDialog open={true} onOpenChange={vi.fn()} fileUrl="blob:t" filename="test.pdf" />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('pdf-page-indicator')).toBeInTheDocument()
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })
    // The prebuilt viewer container is present (not a bare <canvas>).
    expect(screen.getByTestId('pdf-viewer-container')).toBeInTheDocument()
    expect(lastViewer?.setDocument).toHaveBeenCalledWith(mockPdfDoc)
  })

  it('next button advances the viewer page', async () => {
    const user = userEvent.setup()
    render(
      <PdfViewerDialog open={true} onOpenChange={vi.fn()} fileUrl="blob:t" filename="test.pdf" />,
    )
    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => {
      expect(screen.getByText('Page 2 / 5')).toBeInTheDocument()
    })
    expect(lastViewer?.currentPageNumber).toBe(2)
  })

  it('previous button is disabled on the first page', async () => {
    render(
      <PdfViewerDialog open={true} onOpenChange={vi.fn()} fileUrl="blob:t" filename="test.pdf" />,
    )
    await waitFor(() => {
      expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
  })

  it('shows error state when the PDF fails to load', async () => {
    const rejected = Promise.reject(new Error('Network error'))
    // Pre-attach a no-op catch so a duplicate effect run (React StrictMode)
    // that bails before awaiting doesn't surface an unhandled rejection.
    rejected.catch(() => {})
    mockGetDocument.mockReturnValue({
      promise: rejected,
      destroy: vi.fn(),
    })
    render(
      <PdfViewerDialog open={true} onOpenChange={vi.fn()} fileUrl="blob:bad" filename="bad.pdf" />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('pdf-error')).toBeInTheDocument()
      expect(screen.getByText('Error: Network error')).toBeInTheDocument()
    })
  })

  it('closes the dialog on close button click', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <PdfViewerDialog
        open={true}
        onOpenChange={onOpenChange}
        fileUrl="blob:t"
        filename="test.pdf"
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('test.pdf')).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /close/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // ─── Annotation toolbar (#1452) ──────────────────────────────────────────
  describe('annotation toolbar', () => {
    it('is hidden when blockId / attachmentId are absent (view-only)', async () => {
      render(
        <PdfViewerDialog open={true} onOpenChange={vi.fn()} fileUrl="blob:t" filename="test.pdf" />,
      )
      await waitFor(() => {
        expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('pdf-annotation-toolbar')).not.toBeInTheDocument()
    })

    it('appears when the owning block is known', async () => {
      render(
        <PdfViewerDialog
          open={true}
          onOpenChange={vi.fn()}
          fileUrl="blob:t"
          filename="test.pdf"
          blockId="block-1"
          attachmentId="att-1"
        />,
      )
      await waitFor(() => {
        expect(screen.getByTestId('pdf-annotation-toolbar')).toBeInTheDocument()
      })
      expect(screen.getByTestId('pdf-tool-highlight')).toBeInTheDocument()
      expect(screen.getByTestId('pdf-tool-comment')).toBeInTheDocument()
    })

    it('toggling Highlight sets the viewer annotation editor mode', async () => {
      const user = userEvent.setup()
      render(
        <PdfViewerDialog
          open={true}
          onOpenChange={vi.fn()}
          fileUrl="blob:t"
          filename="test.pdf"
          blockId="block-1"
          attachmentId="att-1"
        />,
      )
      await waitFor(() => {
        expect(screen.getByTestId('pdf-tool-highlight')).toBeInTheDocument()
      })
      await user.click(screen.getByTestId('pdf-tool-highlight'))
      // HIGHLIGHT = 9
      expect(lastViewer?.annotationEditorMode).toEqual({ mode: 9 })
      expect(screen.getByTestId('pdf-tool-highlight')).toHaveAttribute('aria-pressed', 'true')
    })

    it('Save is disabled until an annotation exists', async () => {
      render(
        <PdfViewerDialog
          open={true}
          onOpenChange={vi.fn()}
          fileUrl="blob:t"
          filename="test.pdf"
          blockId="block-1"
          attachmentId="att-1"
        />,
      )
      await waitFor(() => {
        expect(screen.getByTestId('pdf-save')).toBeInTheDocument()
      })
      expect(screen.getByTestId('pdf-save')).toBeDisabled()
    })

    it('Save bakes annotations and creates a new attachment, deleting the old', async () => {
      const user = userEvent.setup()
      const onSaved = vi.fn()
      const onOpenChange = vi.fn()
      render(
        <PdfViewerDialog
          open={true}
          onOpenChange={onOpenChange}
          fileUrl="blob:t"
          filename="report.pdf"
          blockId="block-1"
          attachmentId="att-1"
          onSaved={onSaved}
        />,
      )
      await waitFor(() => {
        expect(screen.getByTestId('pdf-save')).toBeInTheDocument()
      })

      // Simulate the viewer reporting that an annotation now exists.
      lastEventBus?.dispatch('editingstateschanged', { isEmpty: false })

      await waitFor(() => {
        expect(screen.getByTestId('pdf-save')).not.toBeDisabled()
      })
      await user.click(screen.getByTestId('pdf-save'))

      await waitFor(() => {
        expect(mockSaveDocument).toHaveBeenCalled()
      })
      expect(mockAddAttachmentWithBytes).toHaveBeenCalledWith(
        expect.objectContaining({
          blockId: 'block-1',
          filename: 'report (annotated).pdf',
          mimeType: 'application/pdf',
        }),
      )
      expect(mockDeleteAttachment).toHaveBeenCalledWith('att-1')
      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  // ─── Accessibility ───────────────────────────────────────────────────────
  it('has no a11y violations when open', async () => {
    const { container } = render(
      <PdfViewerDialog
        open={true}
        onOpenChange={vi.fn()}
        fileUrl="blob:t"
        filename="report.pdf"
        blockId="block-1"
        attachmentId="att-1"
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('report.pdf')).toBeInTheDocument()
    })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
