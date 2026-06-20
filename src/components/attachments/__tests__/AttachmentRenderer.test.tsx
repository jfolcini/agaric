import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// PEND-76 F2 — rendering now reads raw bytes over IPC and wraps them in a
// blob URL. Mock the wrapper so each test controls the returned bytes.
vi.mock('@/lib/tauri', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/tauri')>()
  return {
    ...mod,
    readAttachment: vi.fn(),
    setProperty: vi.fn(() => Promise.resolve({})),
  }
})

import { AttachmentRenderer } from '@/components/attachments/AttachmentRenderer'
import { readAttachment, setProperty } from '@/lib/tauri'

const mockedReadAttachment = vi.mocked(readAttachment)
const mockedSetProperty = vi.mocked(setProperty)

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
    fs_path: 'attachments/att-1',
    mime_type: 'image/png',
    size_bytes: 1024,
    ...overrides,
  }
}

/**
 * Controllable IntersectionObserver mock (#758 item 5).
 *
 * The shared test-setup.ts stub is a no-op that never reports intersection.
 * AttachmentImage now viewport-gates its IPC byte read, so images would
 * never load under the no-op stub. Default `autoEnter = true` reports
 * intersection synchronously on observe() (existing tests behave as
 * before); the viewport-gate tests flip it off and call `enterAll()`.
 */
type IOCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = []
  static autoEnter = true
  callback: IOCallback
  rootMargin: string
  observed: Set<Element> = new Set()

  constructor(callback: IOCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.rootMargin = typeof options?.rootMargin === 'string' ? options.rootMargin : '0px'
    MockIntersectionObserver.instances.push(this)
  }

  observe(el: Element): void {
    this.observed.add(el)
    if (MockIntersectionObserver.autoEnter) this.fireFor([el])
  }
  unobserve(el: Element): void {
    this.observed.delete(el)
  }
  disconnect(): void {
    this.observed.clear()
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  fireFor(targets: Element[]): void {
    const entries = targets.map(
      (target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry,
    )
    this.callback(entries, this as unknown as IntersectionObserver)
  }

  /** Report `isIntersecting: true` for every observed element. */
  enterAll(): void {
    this.fireFor(Array.from(this.observed))
  }
}

const baseProps = {
  blockId: 'B1',
  imageWidth: '100',
  imageHovered: false,
  imageAlignment: 'center' as const,
  imageCaption: '',
  onImageHoveredChange: vi.fn(),
  onImageWidthChange: vi.fn(),
  onImageAlignmentChange: vi.fn(),
  onImageCaptionChange: vi.fn(),
  onLightboxOpen: vi.fn(),
  onPdfOpen: vi.fn(),
}

describe('AttachmentRenderer', () => {
  let createSpy: ReturnType<typeof vi.spyOn>
  let revokeSpy: ReturnType<typeof vi.spyOn>
  let urlCounter: number

  beforeEach(() => {
    vi.clearAllMocks()
    urlCounter = 0
    createSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation(() => `blob:mock/${++urlCounter}`)
    revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    mockedReadAttachment.mockResolvedValue(new Uint8Array([137, 80, 78, 71]))
    // #758 item 5: the image byte read is viewport-gated. Auto-report
    // intersection so the pre-existing tests see images load immediately.
    MockIntersectionObserver.instances = []
    MockIntersectionObserver.autoEnter = true
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  afterEach(() => {
    createSpy.mockRestore()
    revokeSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('returns null when attachments array is empty', () => {
    const { container } = render(<AttachmentRenderer {...baseProps} attachments={[]} />)
    expect(container.querySelector('[data-testid="attachment-section"]')).not.toBeInTheDocument()
  })

  it('renders an image from bytes returned by read_attachment', async () => {
    const { container } = render(
      <AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} imageWidth="50" />,
    )

    // Loading state first, then the image after the bytes resolve.
    const img = await screen.findByRole('img')
    expect(img).toBeInTheDocument()
    expect(img.getAttribute('alt')).toBe('photo.png')
    expect(img.getAttribute('src')).toMatch(/^blob:/)
    expect(mockedReadAttachment).toHaveBeenCalledWith('att-1')
    expect(createSpy).toHaveBeenCalledTimes(1)

    const wrapper = container.querySelector('[data-testid="image-resize-wrapper"]') as HTMLElement
    expect(wrapper.style.maxWidth).toBe('50%')
  })

  it('revokes the object URL on unmount', async () => {
    const { unmount } = render(
      <AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} />,
    )
    await screen.findByRole('img')
    expect(revokeSpy).not.toHaveBeenCalled()

    unmount()
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock/1')
  })

  it('revokes and recreates the object URL when the attachment id changes', async () => {
    const { rerender } = render(
      <AttachmentRenderer {...baseProps} attachments={[makeAttachment({ id: 'att-1' })]} />,
    )
    await screen.findByRole('img')
    expect(createSpy).toHaveBeenCalledTimes(1)

    rerender(<AttachmentRenderer {...baseProps} attachments={[makeAttachment({ id: 'att-2' })]} />)
    await waitFor(() => expect(mockedReadAttachment).toHaveBeenCalledWith('att-2'))
    // Previous URL revoked, new one created.
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock/1')
    expect(createSpy).toHaveBeenCalledTimes(2)
  })

  it('shows an error state when reading bytes fails', async () => {
    mockedReadAttachment.mockRejectedValueOnce(new Error('boom'))
    render(<AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} />)
    expect(await screen.findByTestId('attachment-image-error')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('shows the image resize toolbar when imageHovered is true', async () => {
    render(<AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} imageHovered />)
    await screen.findByRole('img')
    expect(screen.getByTestId('image-resize-toolbar')).toBeInTheDocument()
  })

  // ---- FIL-008 (#218 item 6): resize-hint badge ----

  it('renders a faint resize-hint badge on images (discoverability cue)', async () => {
    render(<AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} />)
    await screen.findByRole('img')
    const hint = screen.getByTestId('image-resize-hint')
    expect(hint).toBeInTheDocument()
    // Decorative cue: hidden from the a11y tree (the focusable group + toolbar
    // carry the real semantics) and never intercepts the image/lightbox click.
    expect(hint.getAttribute('aria-hidden')).toBe('true')
    expect(hint.getAttribute('title')).toBe('Resize image — hover or focus to open the toolbar')
    expect(hint.className).toContain('pointer-events-none')
  })

  it('hides the resize-hint badge once the resize toolbar is open', async () => {
    render(<AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} imageHovered />)
    await screen.findByRole('img')
    // The toolbar already communicates resizability — no redundant badge.
    expect(screen.getByTestId('image-resize-toolbar')).toBeInTheDocument()
    expect(screen.queryByTestId('image-resize-hint')).not.toBeInTheDocument()
  })

  it('does not render a resize-hint badge for non-image attachments', () => {
    render(
      <AttachmentRenderer
        {...baseProps}
        attachments={[
          makeAttachment({
            id: 'att-pdf',
            filename: 'document.pdf',
            mime_type: 'application/pdf',
            size_bytes: 2048,
          }),
        ]}
      />,
    )
    expect(screen.queryByTestId('image-resize-hint')).not.toBeInTheDocument()
  })

  it('image click triggers onLightboxOpen with the blob URL and the image set', async () => {
    const onLightboxOpen = vi.fn()
    render(
      <AttachmentRenderer
        {...baseProps}
        attachments={[makeAttachment()]}
        onLightboxOpen={onLightboxOpen}
      />,
    )
    const img = await screen.findByRole('img')
    fireEvent.click(img)
    expect(onLightboxOpen).toHaveBeenCalledWith(
      {
        src: expect.stringMatching(/^blob:/),
        alt: 'photo.png',
        fsPath: 'attachments/att-1',
      },
      [
        {
          src: expect.stringMatching(/^blob:/),
          alt: 'photo.png',
          fsPath: 'attachments/att-1',
        },
      ],
    )
  })

  it('caps inline image height at min(400px, 60vh) with auto width (#212 item 1)', async () => {
    render(<AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} />)
    const img = await screen.findByRole('img')
    // jsdom's CSSOM drops the CSS `min()` function from computed style, so assert
    // against the raw inline style attribute instead of toHaveStyle().
    const style = img.getAttribute('style') ?? ''
    expect(style).toContain('max-height: min(400px, 60vh)')
    expect(style).toContain('width: auto')
    expect(style).toContain('max-width: 100%')
  })

  it('opens the lightbox with the full ordered image set, clicked image first (#212 item 2)', async () => {
    const onLightboxOpen = vi.fn()
    const atts = [
      makeAttachment({ id: 'a', filename: 'a.png', fs_path: 'attachments/a' }),
      makeAttachment({ id: 'b', filename: 'b.png', fs_path: 'attachments/b' }),
      makeAttachment({ id: 'c', filename: 'c.png', fs_path: 'attachments/c' }),
    ]
    render(<AttachmentRenderer {...baseProps} attachments={atts} onLightboxOpen={onLightboxOpen} />)

    // All three images must load (and register their blob URLs) first.
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3))

    const buttons = screen.getAllByRole('button', { name: /Open image .* in full screen/ })
    const secondButton = buttons[1]
    if (!secondButton) throw new Error('expected three image buttons')
    await userEvent.click(secondButton)

    expect(onLightboxOpen).toHaveBeenCalledOnce()
    const call = onLightboxOpen.mock.calls[0]
    if (!call) throw new Error('expected onLightboxOpen to have been called')
    const [clicked, images] = call
    expect(clicked.alt).toBe('b.png')
    expect((images as { alt: string }[]).map((i) => i.alt)).toEqual(['a.png', 'b.png', 'c.png'])
  })

  it('renders non-image attachments as file chips (no IPC read)', () => {
    render(
      <AttachmentRenderer
        {...baseProps}
        attachments={[
          makeAttachment({
            id: 'att-pdf',
            filename: 'document.pdf',
            mime_type: 'application/pdf',
            size_bytes: 2048,
          }),
        ]}
      />,
    )
    expect(screen.getByText('document.pdf')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open file document.pdf' })).toBeInTheDocument()
    // Non-image chips don't eagerly read bytes — only on click.
    expect(mockedReadAttachment).not.toHaveBeenCalled()
  })

  it('PDF chip click reads bytes and opens the viewer with a blob URL', async () => {
    const onPdfOpen = vi.fn()
    render(
      <AttachmentRenderer
        {...baseProps}
        attachments={[
          makeAttachment({
            id: 'att-pdf',
            filename: 'report.pdf',
            mime_type: 'application/pdf',
            size_bytes: 4096,
          }),
        ]}
        onPdfOpen={onPdfOpen}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open file report.pdf' }))
    await waitFor(() => expect(onPdfOpen).toHaveBeenCalled())
    expect(mockedReadAttachment).toHaveBeenCalledWith('att-pdf')
    // #1452 — the attachment id is forwarded so the viewer can persist an
    // annotated copy and delete the original on save.
    expect(onPdfOpen).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), 'report.pdf', 'att-pdf')
  })

  it('non-PDF file chip click reads the bytes over IPC (download), not openUrl', async () => {
    // fs_path is backend-relative now, so the chip downloads the bytes via a
    // blob instead of trying to open a relative path externally.
    mockedReadAttachment.mockResolvedValue(new Uint8Array([1, 2, 3]))
    render(
      <AttachmentRenderer
        {...baseProps}
        attachments={[
          makeAttachment({
            id: 'att-zip',
            filename: 'bundle.zip',
            fs_path: 'attachments/att-zip',
            mime_type: 'application/zip',
            size_bytes: 4096,
          }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open file bundle.zip' }))
    await waitFor(() => expect(mockedReadAttachment).toHaveBeenCalledWith('att-zip'))
    // A blob URL is created from the bytes to drive the download.
    expect(createSpy).toHaveBeenCalled()
  })

  it('has no a11y violations with file attachments', async () => {
    const { container } = render(
      <AttachmentRenderer
        {...baseProps}
        attachments={[
          makeAttachment({
            id: 'att-pdf',
            filename: 'report.pdf',
            mime_type: 'application/pdf',
            size_bytes: 2048,
          }),
        ]}
      />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with a rendered image', async () => {
    const { container } = render(
      <AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} />,
    )
    await screen.findByRole('img')
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('image-resize wrapper exposes aria-label, role=group, and tabindex (UX-5)', async () => {
    const { container } = render(
      <AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} />,
    )
    await screen.findByRole('img')
    const wrapper = container.querySelector('[data-testid="image-resize-wrapper"]') as HTMLElement
    expect(wrapper.getAttribute('role')).toBe('group')
    expect(wrapper.getAttribute('aria-label')).toBe('Toggle resize toolbar')
    expect(wrapper.getAttribute('tabindex')).toBe('0')
  })

  // ---- #294 item 6: inline drag-to-resize ----

  /**
   * jsdom has no layout engine, so wire up the minimum the resize math reads:
   * the image row's content width (clientWidth, padding resolves to 0 without a
   * stylesheet) and pointer-capture no-ops on the handle.
   */
  function primeResize(handle: HTMLElement, container: HTMLElement, rowWidth: number): void {
    const section = container.querySelector('[data-testid="attachment-section"]') as HTMLElement
    Object.defineProperty(section, 'clientWidth', { configurable: true, value: rowWidth })
    ;(handle as unknown as { setPointerCapture: () => void }).setPointerCapture = vi.fn()
    ;(handle as unknown as { releasePointerCapture: () => void }).releasePointerCapture = vi.fn()
  }

  it('renders a pointer-only, aria-hidden resize handle on images (#294 item 6)', async () => {
    render(<AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} />)
    await screen.findByRole('img')
    const handle = screen.getByTestId('image-resize-handle')
    expect(handle.getAttribute('aria-hidden')).toBe('true')
    expect(handle.getAttribute('title')).toBe('Drag to resize image')
  })

  it('does not render a resize handle for non-image attachments', () => {
    render(
      <AttachmentRenderer
        {...baseProps}
        attachments={[
          makeAttachment({ id: 'att-pdf', filename: 'doc.pdf', mime_type: 'application/pdf' }),
        ]}
      />,
    )
    expect(screen.queryByTestId('image-resize-handle')).not.toBeInTheDocument()
  })

  it('left-aligned: the right handle tracks the right edge (x=100 of 200 → 50%)', async () => {
    const onImageWidthChange = vi.fn()
    const { container } = render(
      <AttachmentRenderer
        {...baseProps}
        imageAlignment="left"
        imageWidth="100"
        onImageWidthChange={onImageWidthChange}
        attachments={[makeAttachment()]}
      />,
    )
    await screen.findByRole('img')
    const handle = screen.getByTestId('image-resize-handle')
    primeResize(handle, container, 200)

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 })
    expect(screen.getByTestId('image-resize-live')).toHaveTextContent('50%')

    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 })
    expect(onImageWidthChange).toHaveBeenCalledWith('50')
    expect(mockedSetProperty).toHaveBeenCalledWith({
      blockId: 'B1',
      key: 'image_width',
      valueText: '50',
    })
    // Live readout is gone once the drag ends.
    expect(screen.queryByTestId('image-resize-live')).not.toBeInTheDocument()
  })

  it('center-aligned (default): width grows symmetrically (x=150 of 200 → 50%)', async () => {
    const onImageWidthChange = vi.fn()
    const { container } = render(
      <AttachmentRenderer
        {...baseProps}
        imageAlignment="center"
        imageWidth="100"
        onImageWidthChange={onImageWidthChange}
        attachments={[makeAttachment()]}
      />,
    )
    await screen.findByRole('img')
    const handle = screen.getByTestId('image-resize-handle')
    primeResize(handle, container, 200)

    // Centre is at x=100; the right edge at x=150 means a 50px half-width → 50%.
    fireEvent.pointerDown(handle, { clientX: 150, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
    expect(screen.getByTestId('image-resize-live')).toHaveTextContent('50%')
    fireEvent.pointerUp(handle, { clientX: 150, pointerId: 1 })
    expect(onImageWidthChange).toHaveBeenCalledWith('50')
  })

  it('right-aligned: the handle moves to the left edge (x=50 of 200 → 75%)', async () => {
    const onImageWidthChange = vi.fn()
    const { container } = render(
      <AttachmentRenderer
        {...baseProps}
        imageAlignment="right"
        imageWidth="100"
        onImageWidthChange={onImageWidthChange}
        attachments={[makeAttachment()]}
      />,
    )
    await screen.findByRole('img')
    const handle = screen.getByTestId('image-resize-handle')
    // Right alignment places the handle on the left corner.
    expect(handle.className).toContain('left-1')
    primeResize(handle, container, 200)

    // Right edge pinned at x=200; left edge at x=50 → 150px width → 75%.
    fireEvent.pointerDown(handle, { clientX: 50, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 50, pointerId: 1 })
    expect(onImageWidthChange).toHaveBeenCalledWith('75')
  })

  it('snaps a near-edge drag to the closest preset (70% → 75%)', async () => {
    const onImageWidthChange = vi.fn()
    const { container } = render(
      <AttachmentRenderer
        {...baseProps}
        imageAlignment="left"
        imageWidth="100"
        onImageWidthChange={onImageWidthChange}
        attachments={[makeAttachment()]}
      />,
    )
    await screen.findByRole('img')
    const handle = screen.getByTestId('image-resize-handle')
    primeResize(handle, container, 200)

    fireEvent.pointerDown(handle, { clientX: 140, pointerId: 1 }) // 70%
    fireEvent.pointerUp(handle, { clientX: 140, pointerId: 1 })
    expect(onImageWidthChange).toHaveBeenCalledWith('75')
  })

  it('does not persist when the drag snaps back to the current width', async () => {
    const onImageWidthChange = vi.fn()
    const { container } = render(
      <AttachmentRenderer
        {...baseProps}
        imageAlignment="left"
        imageWidth="50"
        onImageWidthChange={onImageWidthChange}
        attachments={[makeAttachment()]}
      />,
    )
    await screen.findByRole('img')
    const handle = screen.getByTestId('image-resize-handle')
    primeResize(handle, container, 200)

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 }) // 50% — unchanged
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 })
    expect(onImageWidthChange).not.toHaveBeenCalled()
    expect(mockedSetProperty).not.toHaveBeenCalled()
  })

  // ---- #212 item 3: captions / alt-text ----

  it('uses the filename as alt when there is no caption', async () => {
    render(<AttachmentRenderer {...baseProps} imageCaption="" attachments={[makeAttachment()]} />)
    const img = await screen.findByRole('img')
    expect(img.getAttribute('alt')).toBe('photo.png')
  })

  it('renders the caption as a low-chrome input and uses it as the image alt (#212 item 3)', async () => {
    render(
      <AttachmentRenderer
        {...baseProps}
        imageCaption="A red bicycle"
        attachments={[makeAttachment()]}
      />,
    )
    const img = await screen.findByRole('img')
    // Caption doubles as alt text (filename fallback only when empty).
    expect(img.getAttribute('alt')).toBe('A red bicycle')

    const caption = screen.getByTestId('image-caption-input') as HTMLInputElement
    expect(caption.value).toBe('A red bicycle')
    expect(caption.getAttribute('placeholder')).toBe('Add a caption…')
  })

  it('persists image_caption on blur and reports the change to the parent', async () => {
    const onImageCaptionChange = vi.fn()
    render(
      <AttachmentRenderer
        {...baseProps}
        imageCaption=""
        onImageCaptionChange={onImageCaptionChange}
        attachments={[makeAttachment()]}
      />,
    )
    await screen.findByRole('img')
    const caption = screen.getByTestId('image-caption-input') as HTMLInputElement

    fireEvent.change(caption, { target: { value: 'Sunset over the bay' } })
    expect(caption.value).toBe('Sunset over the bay')
    fireEvent.blur(caption)

    expect(onImageCaptionChange).toHaveBeenCalledWith('Sunset over the bay')
    expect(mockedSetProperty).toHaveBeenCalledWith({
      blockId: 'B1',
      key: 'image_caption',
      valueText: 'Sunset over the bay',
    })
  })

  it('does not persist the caption when it is unchanged on blur', async () => {
    render(
      <AttachmentRenderer {...baseProps} imageCaption="kept" attachments={[makeAttachment()]} />,
    )
    await screen.findByRole('img')
    const caption = screen.getByTestId('image-caption-input') as HTMLInputElement
    fireEvent.blur(caption)
    expect(mockedSetProperty).not.toHaveBeenCalled()
  })

  it('forwards the caption into the lightbox image set (#212 item 3)', async () => {
    const onLightboxOpen = vi.fn()
    render(
      <AttachmentRenderer
        {...baseProps}
        imageCaption="A caption"
        onLightboxOpen={onLightboxOpen}
        attachments={[makeAttachment()]}
      />,
    )
    const img = await screen.findByRole('img')
    fireEvent.click(img)
    const call = onLightboxOpen.mock.calls[0]
    if (!call) throw new Error('expected onLightboxOpen to have been called')
    const [clicked, images] = call
    expect(clicked.caption).toBe('A caption')
    expect((images as { caption?: string }[])[0]?.caption).toBe('A caption')
  })

  // ---- #212 item 4: alignment ----

  it('defaults the image row to center alignment', async () => {
    const { container } = render(
      <AttachmentRenderer
        {...baseProps}
        imageAlignment="center"
        attachments={[makeAttachment()]}
      />,
    )
    await screen.findByRole('img')
    const row = container.querySelector('[data-testid="attachment-section"]') as HTMLElement
    expect(row.getAttribute('data-alignment')).toBe('center')
    expect(row.style.justifyContent).toBe('center')
  })

  it('applies the stored alignment to the image row (#212 item 4)', async () => {
    const { container } = render(
      <AttachmentRenderer {...baseProps} imageAlignment="right" attachments={[makeAttachment()]} />,
    )
    await screen.findByRole('img')
    const row = container.querySelector('[data-testid="attachment-section"]') as HTMLElement
    expect(row.getAttribute('data-alignment')).toBe('right')
    expect(row.style.justifyContent).toBe('flex-end')
  })

  it('setting alignment via the toolbar persists image_alignment and re-renders (#212 item 4)', async () => {
    const onImageAlignmentChange = vi.fn()
    const { container, rerender } = render(
      <AttachmentRenderer
        {...baseProps}
        imageHovered
        imageAlignment="center"
        onImageAlignmentChange={onImageAlignmentChange}
        attachments={[makeAttachment()]}
      />,
    )
    await screen.findByRole('img')

    await userEvent.click(screen.getByTestId('image-align-left'))
    expect(onImageAlignmentChange).toHaveBeenCalledWith('left')
    expect(mockedSetProperty).toHaveBeenCalledWith({
      blockId: 'B1',
      key: 'image_alignment',
      valueText: 'left',
    })

    // Parent state flows back down → the row reflects the new alignment.
    rerender(
      <AttachmentRenderer
        {...baseProps}
        imageHovered
        imageAlignment="left"
        onImageAlignmentChange={onImageAlignmentChange}
        attachments={[makeAttachment()]}
      />,
    )
    const row = container.querySelector('[data-testid="attachment-section"]') as HTMLElement
    expect(row.style.justifyContent).toBe('flex-start')
  })

  // ---- #758 item 5: viewport-gated byte read ----

  describe('viewport-gated image loading (#758 item 5)', () => {
    it('does not read attachment bytes before the placeholder enters the viewport', () => {
      MockIntersectionObserver.autoEnter = false

      render(<AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} />)

      // Placeholder is shown and observed, but no IPC read has fired.
      expect(screen.getByTestId('attachment-image-loading')).toBeInTheDocument()
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
      expect(mockedReadAttachment).not.toHaveBeenCalled()

      const observed = MockIntersectionObserver.instances.flatMap((o) => Array.from(o.observed))
      expect(observed).toHaveLength(1)
      expect(observed[0]).toBe(screen.getByTestId('attachment-image-loading'))
    })

    it('starts the byte read once the placeholder enters the viewport', async () => {
      MockIntersectionObserver.autoEnter = false

      render(<AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} />)
      expect(mockedReadAttachment).not.toHaveBeenCalled()

      act(() => {
        for (const observer of MockIntersectionObserver.instances) observer.enterAll()
      })

      const img = await screen.findByRole('img')
      expect(img.getAttribute('src')).toMatch(/^blob:/)
      expect(mockedReadAttachment).toHaveBeenCalledWith('att-1')
      expect(mockedReadAttachment).toHaveBeenCalledTimes(1)
    })

    it('has no a11y violations in the gated placeholder state', async () => {
      MockIntersectionObserver.autoEnter = false

      const { container } = render(
        <AttachmentRenderer {...baseProps} attachments={[makeAttachment()]} />,
      )
      expect(screen.getByTestId('attachment-image-loading')).toBeInTheDocument()

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with a caption present', async () => {
    const { container } = render(
      <AttachmentRenderer
        {...baseProps}
        imageCaption="A caption"
        attachments={[makeAttachment()]}
      />,
    )
    await screen.findByRole('img')
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
