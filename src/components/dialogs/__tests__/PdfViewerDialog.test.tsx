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
 * - Save moves the owning block's `attachment:` links to the copy before the
 *   original goes, and keeps the original when the block's text cannot be read
 *   or that edit is refused (#6629)
 * - Save adds a child block per new highlight pointing at the copy, and points
 *   the older highlight blocks at it before the original goes (#6629)
 * - `initialPage` opens the reader on that page
 * - Closes the dialog on close button click
 * - axe() accessibility audit
 */

import { act, render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makeBlock } from '@/__tests__/fixtures'
import { deferred } from '@/__tests__/helpers/invoke'
import { useIsMobile } from '@/hooks/useIsMobile'
import { t } from '@/lib/i18n'

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
const mockEditBlock = vi.fn()
const mockGetBlock = vi.fn()
const mockCreateBlocksBatch = vi.fn()
const mockQueryByProperty = vi.fn()
const mockSetProperty = vi.fn()
vi.mock('@/lib/bindings', () => ({
  commands: {
    addAttachmentWithBytes: (...args: unknown[]) => mockAddAttachmentWithBytes(...args),
    deleteAttachment: (...args: unknown[]) => mockDeleteAttachment(...args),
    editBlock: (...args: unknown[]) => mockEditBlock(...args),
    getBlock: (...args: unknown[]) => mockGetBlock(...args),
    createBlocksBatch: (...args: unknown[]) => mockCreateBlocksBatch(...args),
    queryByProperty: (...args: unknown[]) => mockQueryByProperty(...args),
    setProperty: (...args: unknown[]) => mockSetProperty(...args),
  },
}))

/** Wrap a value in the `Result`-shaped IPC envelope `commands.*` returns. */
const ok = <T,>(data: T) => ({ status: 'ok' as const, data })

const mockNotify = {
  loading: vi.fn(() => 'toast-id'),
  success: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}
vi.mock('@/lib/notify', () => ({ notify: mockNotify }))

// ─── pdfjs-dist core (getDocument + saveDocument) ──────────────────────────
const mockSaveDocument = vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]).buffer))
/** pdf.js's storage of the reader's annotations; empty, it serializes without a map. */
const emptyStorage = () => ({
  serializable: { map: null as Map<string, unknown> | null },
  getRawValue: (_key: string): unknown => undefined,
})
const mockPdfDoc = {
  numPages: 5,
  saveDocument: mockSaveDocument,
  annotationStorage: emptyStorage(),
}
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
const { createPageBlockStore, PageBlockContext } = await import('@/stores/page-blocks')
const { useSpaceStore } = await import('@/stores/space')
const { useUndoStore } = await import('@/stores/undo')
const { logger } = await import('@/lib/logger')

/** Render inside a page store, as every host renders the dialog. */
function render(ui: React.ReactElement, store = createPageBlockStore('PAGE_1')) {
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <PageBlockContext.Provider value={store}>{children}</PageBlockContext.Provider>
    ),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  lastViewer = null
  lastEventBus = null
  mockGetDocument.mockReturnValue({
    promise: Promise.resolve(mockPdfDoc),
    destroy: vi.fn(),
  })
  mockSaveDocument.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
  mockAddAttachmentWithBytes.mockResolvedValue(ok({ id: 'new-att-id' }))
  mockDeleteAttachment.mockResolvedValue(ok(null))
  mockGetBlock.mockResolvedValue(ok({ id: 'block-1', content: 'Reading list' }))
  mockPdfDoc.annotationStorage = emptyStorage()
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
      <PdfViewerDialog open onOpenChange={vi.fn()} fileUrl="blob:report" filename="report.pdf" />,
    )
    await waitFor(() => {
      expect(screen.getByText('report.pdf')).toBeInTheDocument()
    })
  })

  // The viewer host is `flex-1 min-h-0` over an `absolute inset-0` child, so it
  // has no intrinsic height: the sheet's `h-auto` + `max-h` cap alone would
  // resolve it to 0 px. Both paths must therefore set an explicit height, and
  // the mobile one must state it in `dvh` (docs/UX.md).
  it('gives the mobile sheet an explicit dvh height, not the auto-height shell', () => {
    mockedUseIsMobile.mockReturnValue(true)
    render(
      <PdfViewerDialog open onOpenChange={vi.fn()} fileUrl="blob:mobile" filename="mobile.pdf" />,
    )

    const viewer = screen.getByRole('dialog')
    // Anchored as a bottom sheet…
    expect(viewer).toHaveClass('bottom-0')
    expect(viewer).toHaveClass('inset-x-0')
    // …with a real height rather than the primitive's `h-auto`.
    expect(viewer).toHaveClass('h-[90dvh]')
    expect(viewer).not.toHaveClass('h-auto')
    // `vh` is forbidden on the mobile path (docs/UX.md).
    expect(viewer).not.toHaveClass('h-[90vh]')
    expect(viewer).not.toHaveClass('max-h-[90vh]')
  })

  it('retains the near-full-screen desktop dialog sizing', () => {
    render(
      <PdfViewerDialog open onOpenChange={vi.fn()} fileUrl="blob:desktop" filename="desktop.pdf" />,
    )

    const viewer = screen.getByRole('dialog')
    expect(viewer).toHaveClass('sm:max-w-[min(64rem,calc(100%-2rem))]', 'h-[90vh]', 'max-h-[90vh]')
    expect(viewer).not.toHaveClass('bottom-0')
    expect(viewer).not.toHaveClass('h-[90dvh]')
  })

  it('shows loading state while the PDF loads', async () => {
    let resolveDoc: (v: unknown) => void = () => {}
    mockGetDocument.mockReturnValue({
      promise: new Promise((resolve) => {
        resolveDoc = resolve as (v: unknown) => void
      }),
      destroy: vi.fn(),
    })

    render(<PdfViewerDialog open onOpenChange={vi.fn()} fileUrl="blob:t" filename="test.pdf" />)

    await waitFor(() => {
      expect(screen.getByTestId('pdf-loading')).toBeInTheDocument()
      expect(screen.getByText('Loading PDF...')).toBeInTheDocument()
    })

    resolveDoc(mockPdfDoc)
  })

  it('mounts the prebuilt PDFViewer and renders the page indicator after load', async () => {
    render(<PdfViewerDialog open onOpenChange={vi.fn()} fileUrl="blob:t" filename="test.pdf" />)

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
    render(<PdfViewerDialog open onOpenChange={vi.fn()} fileUrl="blob:t" filename="test.pdf" />)
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
    render(<PdfViewerDialog open onOpenChange={vi.fn()} fileUrl="blob:t" filename="test.pdf" />)
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
    render(<PdfViewerDialog open onOpenChange={vi.fn()} fileUrl="blob:bad" filename="bad.pdf" />)
    await waitFor(() => {
      expect(screen.getByTestId('pdf-error')).toBeInTheDocument()
      expect(screen.getByText('Error: Network error')).toBeInTheDocument()
    })
  })

  it('closes the dialog on close button click', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <PdfViewerDialog open onOpenChange={onOpenChange} fileUrl="blob:t" filename="test.pdf" />,
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
      render(<PdfViewerDialog open onOpenChange={vi.fn()} fileUrl="blob:t" filename="test.pdf" />)
      await waitFor(() => {
        expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('pdf-annotation-toolbar')).not.toBeInTheDocument()
    })

    it('appears when the owning block is known', async () => {
      render(
        <PdfViewerDialog
          open
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
          open
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
          open
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
          open
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
      lastEventBus?.dispatch('editingstateschanged', { details: { isEmpty: false } })

      await waitFor(() => {
        expect(screen.getByTestId('pdf-save')).not.toBeDisabled()
      })
      await user.click(screen.getByTestId('pdf-save'))

      await waitFor(() => {
        expect(mockSaveDocument).toHaveBeenCalled()
      })
      expect(mockAddAttachmentWithBytes).toHaveBeenCalledWith(
        'block-1',
        'report (annotated).pdf',
        'application/pdf',
        expect.any(Array),
      )
      expect(mockDeleteAttachment).toHaveBeenCalledWith('att-1')
      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  // The owning block's `attachment:<id>` links move to the annotated copy
  // before the original goes, through the page store that shows the block.
  describe("Save moves the block's links to the copy (#6629)", () => {
    const LINKED = '[report.pdf](attachment:att-1), p. 2: ![page](attachment:att-1)'
    const REPOINTED = '[report.pdf](attachment:new-att-id), p. 2: ![page](attachment:new-att-id)'

    /** The dialog inside the owning block's page store, with the block's text `content`. */
    function renderInPage(content: string) {
      const onSaved = vi.fn()
      const store = createPageBlockStore('PAGE_1')
      const block = makeBlock({ id: 'block-1', parent_id: 'PAGE_1', content })
      store.setState({ blocks: [block], blocksById: new Map([[block.id, block]]) })
      mockGetBlock.mockResolvedValue(ok(block))
      render(
        <PdfViewerDialog
          open
          onOpenChange={vi.fn()}
          fileUrl="blob:t"
          filename="report.pdf"
          blockId="block-1"
          attachmentId="att-1"
          onSaved={onSaved}
        />,
        store,
      )
      const text = (): string | null | undefined =>
        store.getState().getBlockById('block-1')?.content
      return { text, onSaved }
    }

    /** Report an annotation as pdf.js does, then press Save. */
    async function annotateAndSave(): Promise<void> {
      await waitFor(() => {
        expect(screen.getByTestId('pdf-save')).toBeInTheDocument()
      })
      act(() => {
        lastEventBus?.dispatch('editingstateschanged', { details: { isEmpty: false } })
      })
      expect(screen.getByTestId('pdf-save')).toBeEnabled()
      await userEvent.setup().click(screen.getByTestId('pdf-save'))
    }

    it('deletes the original only once the block links the copy', async () => {
      const edit = deferred<unknown>()
      mockEditBlock.mockReturnValue(edit.promise)
      const { text, onSaved } = renderInPage(LINKED)
      await annotateAndSave()

      await waitFor(() => {
        expect(text()).toBe(REPOINTED)
      })
      expect(mockDeleteAttachment).not.toHaveBeenCalled()
      edit.resolve(ok({ id: 'block-1', content: REPOINTED, op_refs: [] }))
      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(text()).toBe(REPOINTED)
      expect(mockDeleteAttachment).toHaveBeenCalledWith('att-1')
    })

    it('repoints the text the backend holds, which page mode saves past the store', async () => {
      const saved = `${LINKED} read twice`
      mockEditBlock.mockImplementation((id: string, content: string) =>
        Promise.resolve(ok({ id, content, op_refs: [] })),
      )
      const { text, onSaved } = renderInPage(LINKED)
      mockGetBlock.mockResolvedValue(ok(makeBlock({ id: 'block-1', content: saved })))
      await annotateAndSave()

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(text()).toBe(`${REPOINTED} read twice`)
      expect(mockDeleteAttachment).toHaveBeenCalledWith('att-1')
    })

    it('keeps the original when the edit is rejected, so the link still opens it', async () => {
      mockEditBlock.mockResolvedValue({
        status: 'error',
        error: { kind: 'database', message: 'x' },
      })
      const { text, onSaved } = renderInPage(LINKED)
      await annotateAndSave()

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(text()).toBe(LINKED)
      expect(mockDeleteAttachment).not.toHaveBeenCalled()
    })

    it('keeps the original when the block cannot be read', async () => {
      const { text, onSaved } = renderInPage(LINKED)
      mockGetBlock.mockResolvedValue({ status: 'error', error: { kind: 'database', message: 'x' } })
      await annotateAndSave()

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(text()).toBe(LINKED)
      expect(mockEditBlock).not.toHaveBeenCalled()
      expect(mockDeleteAttachment).not.toHaveBeenCalled()
    })

    it('deletes the original with no edit when the block text does not link it', async () => {
      const { text, onSaved } = renderInPage('Reading list')
      await annotateAndSave()

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(text()).toBe('Reading list')
      expect(mockEditBlock).not.toHaveBeenCalled()
      expect(mockDeleteAttachment).toHaveBeenCalledWith('att-1')
    })

    it('leaves the link and the original alone when the copy is rejected', async () => {
      mockAddAttachmentWithBytes.mockResolvedValue({
        status: 'error',
        error: { kind: 'validation', message: 'x' },
      })
      const { text, onSaved } = renderInPage(LINKED)
      await annotateAndSave()

      await waitFor(() => {
        expect(mockNotify.error).toHaveBeenCalledWith('Failed to save annotated PDF')
      })
      expect(text()).toBe(LINKED)
      expect(mockEditBlock).not.toHaveBeenCalled()
      expect(mockDeleteAttachment).not.toHaveBeenCalled()
      expect(onSaved).not.toHaveBeenCalled()
    })
  })

  // A highlight is in the file only once saved, so Save makes its block: a
  // child of the PDF's owner pointing at the copy. The older highlight blocks
  // move to the copy before the original goes.
  describe('Save turns each new highlight into a block (#6629)', () => {
    /** One box, top edge first, as pdf.js serializes a highlight's quad points. */
    const QUADS = [40, 114, 140, 114, 40, 90, 140, 90]
    const PAGE_TWO_BLOCK = {
      blockType: 'content',
      content: 'Page two',
      parentId: 'block-1',
      position: null,
      properties: {
        pdf_attachment: 'new-att-id',
        pdf_page: '2',
        pdf_boxes: '[[40,90,140,114]]',
      },
    }

    /** The reader holds a new highlight of `passage` on page `pageIndex + 1`. */
    function holdHighlight(passage: string, pageIndex: number): void {
      const div = document.createElement('div')
      div.setAttribute('aria-label', passage)
      mockPdfDoc.annotationStorage = {
        serializable: {
          map: new Map([
            ['editor_0', { annotationType: 9, id: null, pageIndex, quadPoints: QUADS }],
          ]),
        },
        getRawValue: () => ({ div }),
      }
    }

    /** The space holds the blocks `ids` pointing at the original. */
    function highlightBlocks(ids: string[]): void {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
      mockQueryByProperty.mockResolvedValue(
        ok({ items: ids.map((id) => makeBlock({ id })), next_cursor: null, has_more: false }),
      )
    }

    /** The dialog on the owner's PDF, its page store's reads counted. */
    function renderOwner() {
      const store = createPageBlockStore('PAGE_1')
      const load = vi.fn(() => Promise.resolve())
      store.setState({ load })
      const onSaved = vi.fn()
      render(
        <PdfViewerDialog
          open
          onOpenChange={vi.fn()}
          fileUrl="blob:t"
          filename="report.pdf"
          blockId="block-1"
          attachmentId="att-1"
          onSaved={onSaved}
        />,
        store,
      )
      return { onSaved, load }
    }

    async function save(): Promise<void> {
      await waitFor(() => {
        expect(screen.getByTestId('pdf-save')).toBeInTheDocument()
      })
      act(() => {
        lastEventBus?.dispatch('editingstateschanged', { details: { isEmpty: false } })
      })
      await userEvent.setup().click(screen.getByTestId('pdf-save'))
    }

    beforeEach(() => {
      useUndoStore.setState({ pages: new Map() })
      mockCreateBlocksBatch.mockResolvedValue(
        ok({ blocks: [], op_refs: [{ device_id: 'DEV', seq: 7 }] }),
      )
      mockSetProperty.mockImplementation((id: string) =>
        Promise.resolve(ok({ ...makeBlock({ id }), op_refs: [] })),
      )
    })

    afterEach(() => {
      useSpaceStore.setState({ currentSpaceId: null })
    })

    it('adds a child of the owner pointing at the copy, as one undo entry', async () => {
      holdHighlight('Page two', 1)
      const { onSaved, load } = renderOwner()
      await save()

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(mockCreateBlocksBatch).toHaveBeenCalledWith([PAGE_TWO_BLOCK])
      expect(
        useUndoStore
          .getState()
          .pages.get('PAGE_1')
          ?.undoStack.map((e) => e.refs),
      ).toEqual([[{ device_id: 'DEV', seq: 7 }]])
      // Block mode shows the new block from the store's own read.
      expect(load).toHaveBeenCalledTimes(1)
      expect(mockDeleteAttachment).toHaveBeenCalledWith('att-1')
    })

    it('sends no block for a save without a new highlight', async () => {
      const { onSaved } = renderOwner()
      await save()

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(mockCreateBlocksBatch).not.toHaveBeenCalled()
    })

    it('still saves the file and replaces the original when the blocks are refused', async () => {
      holdHighlight('Page two', 1)
      mockCreateBlocksBatch.mockResolvedValue({
        status: 'error',
        error: { kind: 'database', message: 'x' },
      })
      const { onSaved } = renderOwner()
      await save()

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(mockNotify.error).toHaveBeenCalledWith(t('pdfViewer.highlightBlocksFailed'))
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'PdfViewerDialog',
        'adding the highlight blocks failed',
        { ownerId: 'block-1' },
        expect.anything(),
      )
      expect(mockNotify.success).toHaveBeenCalledWith(t('pdfViewer.saved'))
      expect(useUndoStore.getState().pages.get('PAGE_1')).toBeUndefined()
      expect(mockDeleteAttachment).toHaveBeenCalledWith('att-1')
    })

    it('points the older highlight blocks at the copy before the original goes', async () => {
      highlightBlocks(['hl-1', 'hl-2'])
      const second = deferred<unknown>()
      mockSetProperty.mockImplementation((id: string) =>
        id === 'hl-2' ? second.promise : Promise.resolve(ok({ ...makeBlock({ id }), op_refs: [] })),
      )
      const { onSaved } = renderOwner()
      await save()

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledTimes(2)
      })
      expect(mockQueryByProperty).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'pdf_attachment', valueText: 'att-1', cursor: null }),
        { kind: 'active', space_id: 'SPACE_1' },
      )
      expect(mockSetProperty.mock.calls).toEqual([
        ['hl-1', 'pdf_attachment', { value_text: 'new-att-id' }],
        ['hl-2', 'pdf_attachment', { value_text: 'new-att-id' }],
      ])
      expect(mockDeleteAttachment).not.toHaveBeenCalled()
      second.resolve(ok({ ...makeBlock({ id: 'hl-2' }), op_refs: [] }))
      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(mockDeleteAttachment).toHaveBeenCalledWith('att-1')
    })

    it('keeps the original when a highlight block cannot be moved to the copy', async () => {
      highlightBlocks(['hl-1', 'hl-2'])
      mockSetProperty.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'hl-2'
            ? { status: 'error', error: { kind: 'database', message: 'x' } }
            : ok({ ...makeBlock({ id }), op_refs: [] }),
        ),
      )
      const { onSaved } = renderOwner()
      await save()

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledWith('new-att-id')
      })
      expect(mockSetProperty).toHaveBeenCalledTimes(2)
      expect(mockDeleteAttachment).not.toHaveBeenCalled()
    })
  })

  describe('initialPage', () => {
    /** Load the PDF opened on `initialPage`, then lay its pages out as pdf.js does. */
    async function openOn(initialPage: number): Promise<void> {
      render(
        <PdfViewerDialog
          open
          onOpenChange={vi.fn()}
          fileUrl="blob:t"
          filename="report.pdf"
          initialPage={initialPage}
        />,
      )
      await waitFor(() => {
        expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
      })
      act(() => {
        lastEventBus?.dispatch('pagesinit', {})
      })
    }

    it('opens the reader on that page', async () => {
      await openOn(3)
      expect(lastViewer?.currentPageNumber).toBe(3)
    })

    it('opens on the last page for a page past it', async () => {
      await openOn(9)
      expect(lastViewer?.currentPageNumber).toBe(5)
    })
  })

  // ─── Accessibility ───────────────────────────────────────────────────────
  it('has no a11y violations when open', async () => {
    const { container } = render(
      <PdfViewerDialog
        open
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
