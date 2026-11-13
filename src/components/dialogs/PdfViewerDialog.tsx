/**
 * PdfViewerDialog — renders a PDF file in a near-full-screen Radix Dialog
 * using pdf.js's PREBUILT viewer component (`pdfjs-dist/web/pdf_viewer`),
 * which gives us a text layer + annotation-editor layer for free (#1452).
 *
 * Features:
 * - Loads PDF via pdfjs-dist getDocument() and drives the prebuilt
 *   `PDFViewer` component (text selection, scrolling, all pages).
 * - Annotation editor: highlight (select text → highlight) and pinned
 *   text comments (FreeText), via pdf.js's built-in `AnnotationEditorLayer`.
 *   Ink/freehand is deferred (#1452 phase 3).
 * - Persist: on Save, `pdfDocument.saveDocument()` bakes the annotations
 *   into the PDF bytes; those bytes are written as a NEW attachment (new
 *   ULID) on the same block, each new highlight becomes a child block of it
 *   pointing at the copy (`pdf-highlights.ts`, #6629), the block's
 *   `attachment:<id>` links and the older highlight blocks move to the copy,
 *   and the original attachment is deleted. We never mutate attachment bytes
 *   in place — a rewritten file changes its blake3 hash and would break sync
 *   (see #1452).
 * - Opens on `initialPage` when given: a highlight block's source chip.
 * - Page count indicator via `t('pdfViewer.pageIndicator')`, prev/next nav.
 * - Cleans up the PDF document + viewer on close.
 *
 * The full pdf.js HTML app (`web/viewer.mjs` / `viewer.html`) is NOT shipped
 * in this pdfjs build — only the component library (`web/pdf_viewer.mjs`) is.
 * So we mount the `PDFViewer` component ourselves and provide its toolbar.
 */

import { ChevronLeft, ChevronRight, Highlighter, MessageSquarePlus, Save } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
// Type-only imports are erased at build time, so they do NOT trigger the
// component module's top-level `globalThis.pdfjsLib` destructure. The runtime
// module is loaded lazily inside `loadPdf`, AFTER `globalThis.pdfjsLib` is set.
import type { PDFViewer as PDFViewerType } from 'pdfjs-dist/web/pdf_viewer.mjs'

import 'pdfjs-dist/web/pdf_viewer.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StoreApi } from 'zustand'

import { Button } from '@/components/ui/button'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { unwrap } from '@/lib/app-error'
import { attachmentRef } from '@/lib/attachment-ref'
import { commands } from '@/lib/bindings'
import { recordGraphStructureChange } from '@/lib/graph-structure-events'
import { isEditableTarget } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import {
  highlightBlockSpecs,
  newHighlights,
  type PdfHighlight,
  repointHighlightBlocks,
} from '@/lib/pdf-highlights'
import { getPageStore, type PageBlockState, usePageBlockStoreApi } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

// Set worker path — served from public/
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

/**
 * The prebuilt viewer component (`web/pdf_viewer.mjs`) is the "external" build
 * flavour: its module body destructures `globalThis.pdfjsLib` at evaluation
 * time. We must publish the core API onto that global BEFORE the component
 * module is first imported. Doing it here (module scope, before any dynamic
 * import of the viewer) guarantees ordering, and keeps the (large) viewer +
 * its CSS out of the initial bundle — it's only pulled in when a PDF opens.
 */
;(globalThis as { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib

/** Lazily-resolved prebuilt viewer module (memoized after first load). */
let viewerModulePromise: Promise<typeof import('pdfjs-dist/web/pdf_viewer.mjs')> | null = null
function loadViewerModule(): Promise<typeof import('pdfjs-dist/web/pdf_viewer.mjs')> {
  // Re-assert the global on every call — cheap, and defends against a test
  // resetting module state between renders.
  ;(globalThis as { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib
  viewerModulePromise ??= import('pdfjs-dist/web/pdf_viewer.mjs')
  return viewerModulePromise
}

/**
 * pdf.js AnnotationEditorType enum values (mirrored from the core build so we
 * don't depend on it being re-exported from the component module). These are
 * stable across the v6 line: NONE disables the editor, HIGHLIGHT turns text
 * selection into highlights, FREETEXT places a pinned text comment.
 */
const EDITOR_MODE = {
  NONE: 0,
  FREETEXT: 3,
  HIGHLIGHT: 9,
} as const

/**
 * pdf.js's own highlight palette (`highlightEditorColors` in its app options,
 * which the component build does not export). With none, adding a highlight
 * throws in pdf.js (`getNonHCMColorName`).
 */
const HIGHLIGHT_COLORS =
  'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F,' +
  'yellow_HCM=#FFFFCC,green_HCM=#53FFBC,blue_HCM=#80EBFF,pink_HCM=#F6B8FF,red_HCM=#C50043'

type EditorTool = 'highlight' | 'comment' | null

/** Derive an annotated-copy filename: `report.pdf` → `report (annotated).pdf`. */
function annotatedFilename(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return `${filename} (annotated)`
  return `${filename.slice(0, dot)} (annotated)${filename.slice(dot)}`
}

/**
 * The mounted store of page `pageId`, the reader's own when that is its page.
 * The reader also opens from a highlight block's chip, which can sit on another
 * page than the PDF's owner; a page that is not open has no store and no undo.
 */
function openStoreOf(
  pageStore: StoreApi<PageBlockState>,
  pageId: string | null | undefined,
): StoreApi<PageBlockState> | undefined {
  if (pageId == null) return undefined
  return pageStore.getState().rootParentId === pageId ? pageStore : getPageStore(pageId)
}

/**
 * Point the owning block's `attachment:<from>` links at `to`; `false` when the
 * edit was refused. The text is the backend's, because page mode saves past
 * the page store; the edit goes through the store of the owner's page, so the
 * editor showing the block takes the new text, page mode's document among
 * them, and the undo entry is that page's.
 */
async function repointBlockLinks(
  pageStore: StoreApi<PageBlockState>,
  blockId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const { content, page_id } = unwrap(await commands.getBlock(blockId))
  if (!content?.includes(attachmentRef(from))) return true
  const repointed = content.replaceAll(attachmentRef(from), attachmentRef(to))
  const ownerStore = openStoreOf(pageStore, page_id)
  if (ownerStore) return ownerStore.getState().edit(blockId, repointed, { merge: false })
  unwrap(await commands.editBlock(blockId, repointed, null))
  return true
}

/**
 * Add a block for each new highlight under `ownerId`, pointing at the copy that
 * holds them, as one undo entry of the owner's page. A refusal is toasted: the
 * highlights are in the file all the same.
 */
async function addHighlightBlocks(
  pageStore: StoreApi<PageBlockState>,
  ownerId: string,
  attachmentId: string,
  highlights: readonly PdfHighlight[],
  failed: string,
): Promise<void> {
  if (highlights.length === 0) return
  try {
    const specs = highlightBlockSpecs(ownerId, attachmentId, highlights)
    const { blocks, op_refs } = unwrap(await commands.createBlocksBatch(specs))
    const pageId = blocks[0]?.page_id
    const ownerStore = openStoreOf(pageStore, pageId)
    if (pageId != null && ownerStore) {
      useUndoStore.getState().onNewAction(pageId, op_refs, undefined, { merge: false })
      if (ownerStore !== pageStore) void ownerStore.getState().load()
    }
    recordGraphStructureChange()
  } catch (err) {
    logger.warn('PdfViewerDialog', 'adding the highlight blocks failed', { ownerId }, err)
    notify.error(failed)
  }
}

export interface PdfViewerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileUrl: string
  filename: string
  /**
   * Block that owns the attachment — required to persist an annotated copy.
   * When absent (e.g. a preview with no backing block), the annotation
   * toolbar is hidden and the dialog is view-only.
   */
  blockId?: string | undefined
  /** ULID of the attachment being viewed — deleted after a successful save. */
  attachmentId?: string | undefined
  /** The page to open on, from 1; past the last page opens on the last. */
  initialPage?: number | undefined
  /**
   * Called after a new annotated attachment is created, and the old one
   * deleted unless the block's links could not be moved off it. Lets the host
   * refresh its attachment list (e.g. invalidate the BatchAttachments cache)
   * and close the dialog.
   */
  onSaved?: ((newAttachmentId: string) => void) | undefined
}

export function PdfViewerDialog({
  open,
  onOpenChange,
  fileUrl,
  filename,
  blockId,
  attachmentId,
  initialPage = 1,
  onSaved,
}: PdfViewerDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const pageStore = usePageBlockStoreApi()
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Which annotation tool is active (null = view/select only).
  const [activeTool, setActiveTool] = useState<EditorTool>(null)
  // True once at least one annotation has been added (drives Save enablement).
  const [hasAnnotations, setHasAnnotations] = useState(false)
  const [saving, setSaving] = useState(false)

  // Annotation persistence is only possible when we know the owning block.
  const canAnnotate = !!blockId && !!attachmentId

  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)
  // pdfjs v6 removed PDFDocumentProxy.destroy(); teardown is via the loading
  // task. Hold it so cleanup can release the worker transport + document.
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null)
  // The prebuilt PDFViewer + its event bus / link service.
  const viewerRef = useRef<PDFViewerType | null>(null)
  const eventBusRef = useRef<unknown>(null)
  const linkServiceRef = useRef<unknown>(null)
  // The scroll container the PDFViewer renders pages into.
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Inner element the viewer appends page divs to.
  const viewerElRef = useRef<HTMLDivElement | null>(null)

  /** Tear down the viewer + document + loading task. Safe to call repeatedly. */
  const teardown = useCallback(() => {
    if (viewerRef.current) {
      try {
        viewerRef.current.cleanup()
      } catch (err) {
        logger.warn('PdfViewerDialog', 'viewer cleanup threw', undefined, err)
      }
      viewerRef.current = null
    }
    eventBusRef.current = null
    linkServiceRef.current = null
    if (loadingTaskRef.current) {
      void loadingTaskRef.current.destroy()
      loadingTaskRef.current = null
    }
    pdfDocRef.current = null
  }, [])

  /** Load the PDF document into the prebuilt viewer when the dialog opens. */
  useEffect(() => {
    if (!open || !fileUrl) return

    let cancelled = false

    /**
     * Wait for the (portaled) viewer container + its `.pdfViewer` child to be
     * committed. The dialog renders inside a Radix portal, so on the render
     * where `open` flips true the container ref can briefly be null; retry on
     * microtasks for a few frames rather than bailing.
     */
    async function awaitContainer(): Promise<[HTMLDivElement, HTMLDivElement] | null> {
      for (let attempt = 0; attempt < 50; attempt++) {
        const container = containerRef.current
        const viewerEl = viewerElRef.current
        if (container && viewerEl) return [container, viewerEl]
        if (cancelled) return null
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      return null
    }

    async function loadPdf() {
      setLoading(true)
      setError(null)
      setCurrentPage(1)
      setNumPages(0)
      setActiveTool(null)
      setHasAnnotations(false)

      try {
        const refs = await awaitContainer()
        if (cancelled) return
        if (!refs) {
          setError('Failed to initialize PDF viewer')
          setLoading(false)
          return
        }
        const [container, viewerEl] = refs

        const { EventBus, GenericL10n, PDFLinkService, PDFViewer } = await loadViewerModule()
        if (cancelled) return

        const eventBus = new EventBus()
        const linkService = new PDFLinkService({ eventBus })
        // English whatever the app language: with no pdf.js locale files
        // vendored, `GenericL10n` only ever has its built-in en-US strings.
        const l10n = new GenericL10n('en-US')

        const viewer = new PDFViewer({
          container,
          viewer: viewerEl,
          eventBus,
          linkService,
          l10n,
          // ENABLE the text layer (1) so users can select text to highlight.
          textLayerMode: 1,
          // Mount the annotation-editor layer but start in NONE mode (view/
          // select only). The toolbar toggles HIGHLIGHT / FREETEXT.
          annotationEditorMode: EDITOR_MODE.NONE,
          annotationEditorHighlightColors: HIGHLIGHT_COLORS,
        })
        linkService.setViewer(viewer)

        eventBusRef.current = eventBus
        linkServiceRef.current = linkService
        viewerRef.current = viewer

        // The prebuilt PDFViewer does NOT pick a scale on its own: until
        // `currentScaleValue` is set it leaves `--total-scale-factor` unset and
        // renders zero pages. Set it on `pagesinit` (fired once the page
        // structure is laid out) so pages actually paint to fit the dialog
        // width. Without this the viewer mounts but stays blank (#1452).
        eventBus.on('pagesinit', () => {
          if (cancelled) return
          try {
            viewer.currentScaleValue = 'page-width'
            if (initialPage > 1) {
              viewer.currentPageNumber = Math.min(initialPage, pdfDocRef.current?.numPages ?? 1)
            }
          } catch (err) {
            logger.warn('PdfViewerDialog', 'set scale on pagesinit failed', undefined, err)
          }
        })
        // Keep the page indicator in sync with scroll position.
        eventBus.on('pagechanging', (evt: { pageNumber: number }) => {
          if (!cancelled) setCurrentPage(evt.pageNumber)
        })
        // Editor state, under `details`: `isEmpty` flips false once an annotation exists.
        eventBus.on('editingstateschanged', (evt: { details: { isEmpty: boolean } }) => {
          if (!cancelled) setHasAnnotations(!evt.details.isEmpty)
        })
        // The viewer reports the active editor mode (e.g. it auto-exits a
        // mode after placing a comment) — mirror it into our toolbar state.
        eventBus.on('annotationeditormodechanged', (evt: { mode: number }) => {
          if (cancelled) return
          if (evt.mode === EDITOR_MODE.HIGHLIGHT) setActiveTool('highlight')
          else if (evt.mode === EDITOR_MODE.FREETEXT) setActiveTool('comment')
          else setActiveTool(null)
        })

        const loadingTask = pdfjsLib.getDocument({ url: fileUrl })
        loadingTaskRef.current = loadingTask
        const pdfDoc = await loadingTask.promise
        if (cancelled) {
          void loadingTask.destroy()
          return
        }

        pdfDocRef.current = pdfDoc
        viewer.setDocument(pdfDoc)
        linkService.setDocument(pdfDoc, null)
        setNumPages(pdfDoc.numPages)
        setLoading(false)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF')
          setLoading(false)
        }
      }
    }

    // Body catches every failure into `setError`, so this cannot reject.
    void loadPdf()

    return () => {
      cancelled = true
      teardown()
    }
  }, [open, fileUrl, initialPage, teardown])

  /** Jump the viewer to a page (1-based). */
  const goToPage = useCallback(
    (pageNum: number) => {
      const viewer = viewerRef.current
      if (!viewer || pageNum < 1 || pageNum > numPages) return
      viewer.currentPageNumber = pageNum
      setCurrentPage(pageNum)
    },
    [numPages],
  )

  const goToPrev = useCallback(() => {
    if (currentPage > 1) goToPage(currentPage - 1)
  }, [currentPage, goToPage])

  const goToNext = useCallback(() => {
    if (currentPage < numPages) goToPage(currentPage + 1)
  }, [currentPage, numPages, goToPage])

  /** Toggle an annotation editor tool on/off. */
  const toggleTool = useCallback(
    (tool: Exclude<EditorTool, null>) => {
      const viewer = viewerRef.current
      if (!viewer) return
      const next: EditorTool = activeTool === tool ? null : tool
      const mode =
        next === 'highlight'
          ? EDITOR_MODE.HIGHLIGHT
          : next === 'comment'
            ? EDITOR_MODE.FREETEXT
            : EDITOR_MODE.NONE
      try {
        viewer.annotationEditorMode = { mode }
        setActiveTool(next)
      } catch (err) {
        logger.warn('PdfViewerDialog', 'set editor mode failed', { mode }, err)
      }
    },
    [activeTool],
  )

  /**
   * Save: bake the current annotations into the PDF binary via
   * `saveDocument()`, write the result as a NEW attachment (new ULID) on the
   * same block, add a block for each new highlight, point the block's links and
   * the older highlight blocks at the copy, then delete the original. This
   * composes existing ops only (AddAttachment + CreateBlock + SetProperty +
   * EditBlock + DeleteAttachment) — no in-place mutation, so the file at a
   * given ULID stays byte-stable for the sync layer (#1452).
   *
   * The highlight blocks are made here, not as each highlight is drawn: until
   * Save a highlight lives only in the reader, and closing it unsaved drops it,
   * so a block made earlier could point at a highlight no file holds.
   */
  const handleSave = useCallback(async () => {
    const pdfDoc = pdfDocRef.current
    if (!pdfDoc || !blockId || !attachmentId) return
    setSaving(true)
    const toastId = notify.loading(t('pdfViewer.saving'))
    try {
      // What the save writes, read before it writes it.
      const highlights = newHighlights(pdfDoc.annotationStorage)
      // Bake annotations into the PDF bytes.
      const bytes = await pdfDoc.saveDocument()
      const row = unwrap(
        await commands.addAttachmentWithBytes(
          blockId,
          annotatedFilename(filename),
          'application/pdf',
          Array.from(new Uint8Array(bytes)),
        ),
      )
      const failed = t('pdfViewer.highlightBlocksFailed')
      await addHighlightBlocks(pageStore, blockId, row.id, highlights, failed)
      // The original goes only once no link in the block and no highlight block
      // names it (#6629). A failed read, edit or delete leaves two copies on the
      // block and every link still opens one — never data loss — so we still
      // report success.
      try {
        if (await repointBlockLinks(pageStore, blockId, attachmentId, row.id)) {
          const spaceId = useSpaceStore.getState().currentSpaceId
          await repointHighlightBlocks(spaceId, attachmentId, row.id)
          unwrap(await commands.deleteAttachment(attachmentId))
        }
      } catch (err) {
        logger.warn(
          'PdfViewerDialog',
          'replacing the original after save failed',
          { attachmentId },
          err,
        )
      }
      // The new blocks and the moved properties: the store's own read shows them,
      // and page mode's document follows the store.
      void pageStore.getState().load()
      notify.dismiss(toastId)
      notify.success(t('pdfViewer.saved'))
      onSaved?.(row.id)
      onOpenChange(false)
    } catch (err) {
      notify.dismiss(toastId)
      logger.warn('PdfViewerDialog', 'save annotated pdf failed', { blockId, attachmentId }, err)
      notify.error(t('pdfViewer.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [blockId, attachmentId, filename, onSaved, onOpenChange, pageStore, t])

  /** Keyboard shortcuts for page navigation while the dialog is open. */
  useEffect(() => {
    if (!open || numPages === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if a modifier key is held (avoids hijacking browser/OS shortcuts)
      if (e.ctrlKey || e.metaKey || e.altKey) return

      // The annotation editor's FreeText field is contenteditable.
      if (isEditableTarget(e.target)) return

      switch (e.key) {
        case 'ArrowLeft':
        case 'PageUp': {
          e.preventDefault()
          goToPrev()
          break
        }
        case 'ArrowRight':
        case 'PageDown': {
          e.preventDefault()
          goToNext()
          break
        }
        case 'Home': {
          e.preventDefault()
          goToPage(1)
          break
        }
        case 'End': {
          e.preventDefault()
          goToPage(numPages)
          break
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, numPages, goToPrev, goToNext, goToPage])

  // On phones < 768 px render as a bottom Sheet so the page
  // navigation controls sit within thumb reach. `'dialog'` kind keeps regular
  // Dialog (not AlertDialog) on desktop.
  const parts = useDialogOrSheet('dialog')
  const { Root, Content, Header, Title, Description } = parts

  // This shell is the one adaptive surface that cannot live off SheetContent's
  // `h-auto` + shared `max-h` cap: the viewer region below is `flex-1 min-h-0`
  // wrapping an `absolute inset-0` container, which contributes no intrinsic
  // height — with an auto-height shell the viewer would resolve to 0 px and the
  // PDF would vanish. So both paths set an explicit height, and the mobile one
  // states it in `dvh` (docs/UX.md — mobile chrome makes `vh` taller than the
  // visible area, which the desktop dialog never sees).
  // `min()` keeps the base 1rem side gutter on windows narrower than the 64rem cap.
  const contentClassName = parts.isMobile
    ? 'h-[90dvh]'
    : 'sm:max-w-[min(64rem,calc(100%-2rem))] h-[90vh] max-h-[90vh]'

  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <Content className={contentClassName}>
        <Header>
          <Title className="truncate pr-6" title={filename}>
            {filename}
          </Title>
          <Description className="sr-only">{t('pdfViewer.description', { filename })}</Description>
        </Header>

        {/* Annotation toolbar — only when the dialog can persist a copy. */}
        {canAnnotate && !loading && !error && numPages > 0 && (
          <div
            className="flex flex-wrap items-center justify-center gap-2 pb-2"
            data-testid="pdf-annotation-toolbar"
          >
            <Button
              variant={activeTool === 'highlight' ? 'default' : 'outline'}
              size="sm"
              onClick={() => toggleTool('highlight')}
              aria-pressed={activeTool === 'highlight'}
              aria-label={t('pdfViewer.highlightLabel')}
              data-testid="pdf-tool-highlight"
            >
              <Highlighter className="h-4 w-4" />
              <span className="ml-1">{t('pdfViewer.highlight')}</span>
            </Button>
            <Button
              variant={activeTool === 'comment' ? 'default' : 'outline'}
              size="sm"
              onClick={() => toggleTool('comment')}
              aria-pressed={activeTool === 'comment'}
              aria-label={t('pdfViewer.commentLabel')}
              data-testid="pdf-tool-comment"
            >
              <MessageSquarePlus className="h-4 w-4" />
              <span className="ml-1">{t('pdfViewer.comment')}</span>
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={!hasAnnotations || saving}
              aria-label={t('pdfViewer.saveLabel')}
              data-testid="pdf-save"
            >
              <Save className="h-4 w-4" />
              <span className="ml-1">{t('pdfViewer.save')}</span>
            </Button>
          </div>
        )}

        {/*
          The prebuilt PDFViewer owns its own scrolling: it needs a
          `position: relative` host with an `absolute` inner scroll container
          that holds a `.pdfViewer` child (per pdf_viewer.css). We therefore do
          NOT wrap it in DialogBody (a Radix ScrollArea, whose `display:table`
          viewport wrapper fights the viewer's absolute layout). `flex-1
          min-h-0` lets it consume the remaining dialog height.
        */}
        <div className="relative flex-1 min-h-0 -mx-6 bg-muted/30 rounded-md">
          {loading && (
            <div
              className="absolute inset-0 flex items-center justify-center p-8"
              data-testid="pdf-loading"
            >
              <span className="text-muted-foreground text-sm">{t('pdfViewer.loading')}</span>
            </div>
          )}

          {error && (
            <div
              className="absolute inset-0 flex items-center justify-center p-8"
              data-testid="pdf-error"
            >
              <span className="text-destructive text-sm">{t('pdfViewer.error', { error })}</span>
            </div>
          )}

          {/*
            The container must stay mounted (not gated on numPages) so the
            viewer has a real element at construction time; we hide it while
            loading/erroring rather than unmounting.
          */}
          <div
            ref={containerRef}
            // `absolute inset-0` is the layout the pdf.js viewer CSS expects of
            // its container (it positions page divs absolutely within).
            className="absolute inset-0 overflow-auto"
            data-testid="pdf-viewer-container"
            style={{ visibility: loading || error ? 'hidden' : 'visible' }}
            aria-label={t('pdfViewer.pageIndicator', { current: currentPage, total: numPages })}
          >
            <div ref={viewerElRef} className="pdfViewer" />
          </div>
        </div>

        {!loading && !error && numPages > 0 && (
          <div
            className="flex flex-wrap items-center justify-center gap-4 pt-2"
            data-testid="pdf-nav"
          >
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
              {t('pdfViewer.pageIndicator', { current: currentPage, total: numPages })}
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
      </Content>
    </Root>
  )
}
