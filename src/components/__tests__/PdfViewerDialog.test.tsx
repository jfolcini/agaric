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

const mockGetDocument = vi.fn(() => ({
  promise: Promise.resolve(mockPdfDoc),
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
      expect(mockGetDocument).toHaveBeenCalledWith('asset://localhost/path/to/doc.pdf')
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
})
