import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('../../lib/open-url', () => ({ openUrl: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}))

vi.mock('../../lib/tauri', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...mod,
    setProperty: vi.fn(() => Promise.resolve({})),
  }
})

import { AttachmentRenderer } from '../AttachmentRenderer'

function makeAttachment(
  overrides: Partial<{
    id: string
    filename: string
    fs_path: string
    mime_type: string
    size_bytes: number
  }> = {},
) {
  return {
    id: 'att-1',
    filename: 'photo.png',
    fs_path: '/path/to/photo.png',
    mime_type: 'image/png',
    size_bytes: 1024,
    ...overrides,
  }
}

describe('AttachmentRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
  })

  it('returns null when attachments array is empty', () => {
    const { container } = render(
      <AttachmentRenderer
        blockId="B1"
        attachments={[]}
        imageWidth="100"
        imageHovered={false}
        onImageHoveredChange={vi.fn()}
        onImageWidthChange={vi.fn()}
        onLightboxOpen={vi.fn()}
        onPdfOpen={vi.fn()}
      />,
    )
    expect(container.querySelector('[data-testid="attachment-section"]')).not.toBeInTheDocument()
  })

  it('renders image attachment with correct width when Tauri is available', () => {
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
    const { container } = render(
      <AttachmentRenderer
        blockId="B1"
        attachments={[makeAttachment()]}
        imageWidth="50"
        imageHovered={false}
        onImageHoveredChange={vi.fn()}
        onImageWidthChange={vi.fn()}
        onLightboxOpen={vi.fn()}
        onPdfOpen={vi.fn()}
      />,
    )
    const img = container.querySelector('img')
    expect(img).toBeInTheDocument()
    expect(img?.getAttribute('alt')).toBe('photo.png')
    const wrapper = container.querySelector('[data-testid="image-resize-wrapper"]') as HTMLElement
    expect(wrapper.style.maxWidth).toBe('50%')
  })

  it('shows image resize toolbar when imageHovered is true', () => {
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
    render(
      <AttachmentRenderer
        blockId="B1"
        attachments={[makeAttachment()]}
        imageWidth="100"
        imageHovered={true}
        onImageHoveredChange={vi.fn()}
        onImageWidthChange={vi.fn()}
        onLightboxOpen={vi.fn()}
        onPdfOpen={vi.fn()}
      />,
    )
    expect(screen.getByTestId('image-resize-toolbar')).toBeInTheDocument()
  })

  it('hides image resize toolbar when imageHovered is false', () => {
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
    render(
      <AttachmentRenderer
        blockId="B1"
        attachments={[makeAttachment()]}
        imageWidth="100"
        imageHovered={false}
        onImageHoveredChange={vi.fn()}
        onImageWidthChange={vi.fn()}
        onLightboxOpen={vi.fn()}
        onPdfOpen={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('image-resize-toolbar')).not.toBeInTheDocument()
  })

  it('calls onImageHoveredChange on mouse enter/leave', () => {
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
    const onHoveredChange = vi.fn()
    const { container } = render(
      <AttachmentRenderer
        blockId="B1"
        attachments={[makeAttachment()]}
        imageWidth="100"
        imageHovered={false}
        onImageHoveredChange={onHoveredChange}
        onImageWidthChange={vi.fn()}
        onLightboxOpen={vi.fn()}
        onPdfOpen={vi.fn()}
      />,
    )
    const wrapper = container.querySelector('[data-testid="image-resize-wrapper"]') as Element
    fireEvent.pointerEnter(wrapper)
    expect(onHoveredChange).toHaveBeenCalledWith(true)
    fireEvent.pointerLeave(wrapper)
    expect(onHoveredChange).toHaveBeenCalledWith(false)
  })

  it('renders non-image attachments as file chips', () => {
    render(
      <AttachmentRenderer
        blockId="B1"
        attachments={[
          makeAttachment({
            id: 'att-pdf',
            filename: 'document.pdf',
            mime_type: 'application/pdf',
            size_bytes: 2048,
          }),
        ]}
        imageWidth="100"
        imageHovered={false}
        onImageHoveredChange={vi.fn()}
        onImageWidthChange={vi.fn()}
        onLightboxOpen={vi.fn()}
        onPdfOpen={vi.fn()}
      />,
    )
    expect(screen.getByText('document.pdf')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open file document.pdf' })).toBeInTheDocument()
  })

  it('PDF attachment click triggers onPdfOpen when Tauri available', () => {
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
    const onPdfOpen = vi.fn()
    render(
      <AttachmentRenderer
        blockId="B1"
        attachments={[
          makeAttachment({
            id: 'att-pdf',
            filename: 'report.pdf',
            mime_type: 'application/pdf',
            fs_path: '/path/to/report.pdf',
            size_bytes: 4096,
          }),
        ]}
        imageWidth="100"
        imageHovered={false}
        onImageHoveredChange={vi.fn()}
        onImageWidthChange={vi.fn()}
        onLightboxOpen={vi.fn()}
        onPdfOpen={onPdfOpen}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open file report.pdf' }))
    expect(onPdfOpen).toHaveBeenCalledWith(expect.stringContaining('report.pdf'), 'report.pdf')
  })

  it('image click triggers onLightboxOpen', () => {
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
    const onLightboxOpen = vi.fn()
    const { container } = render(
      <AttachmentRenderer
        blockId="B1"
        attachments={[makeAttachment()]}
        imageWidth="100"
        imageHovered={false}
        onImageHoveredChange={vi.fn()}
        onImageWidthChange={vi.fn()}
        onLightboxOpen={onLightboxOpen}
        onPdfOpen={vi.fn()}
      />,
    )
    const img = container.querySelector('img') as HTMLElement
    fireEvent.click(img)
    expect(onLightboxOpen).toHaveBeenCalledWith({
      src: expect.stringContaining('photo.png'),
      alt: 'photo.png',
      fsPath: '/path/to/photo.png',
    })
  })

  it('does not render image when Tauri is not available', () => {
    const { container } = render(
      <AttachmentRenderer
        blockId="B1"
        attachments={[makeAttachment()]}
        imageWidth="100"
        imageHovered={false}
        onImageHoveredChange={vi.fn()}
        onImageWidthChange={vi.fn()}
        onLightboxOpen={vi.fn()}
        onPdfOpen={vi.fn()}
      />,
    )
    expect(container.querySelector('img')).not.toBeInTheDocument()
  })

  it('has no a11y violations with file attachments', async () => {
    const { container } = render(
      <AttachmentRenderer
        blockId="B1"
        attachments={[
          makeAttachment({
            id: 'att-pdf',
            filename: 'report.pdf',
            mime_type: 'application/pdf',
            size_bytes: 2048,
          }),
        ]}
        imageWidth="100"
        imageHovered={false}
        onImageHoveredChange={vi.fn()}
        onImageWidthChange={vi.fn()}
        onLightboxOpen={vi.fn()}
        onPdfOpen={vi.fn()}
      />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with image attachment (Tauri available)', async () => {
    ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
    const { container } = render(
      <AttachmentRenderer
        blockId="B1"
        attachments={[makeAttachment()]}
        imageWidth="100"
        imageHovered={false}
        onImageHoveredChange={vi.fn()}
        onImageWidthChange={vi.fn()}
        onLightboxOpen={vi.fn()}
        onPdfOpen={vi.fn()}
      />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
