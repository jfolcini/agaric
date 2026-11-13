/**
 * A PDF highlight or pinned comment as a block (#6629). Saving the reader
 * writes each new one into the annotated copy and adds a child of the block
 * that owns the PDF: its text is the highlighted passage or the comment, and
 * three properties, all text, point at its place in the file:
 *
 * - `pdf_attachment`, the id of the attachment holding the annotation;
 * - `pdf_page`, its page, from 1;
 * - `pdf_boxes`, its boxes in PDF units (`[x1, y1, x2, y2]`, origin at the
 *   page's bottom left), as compact JSON: the bytes at an attachment id never
 *   change, so these never drift, and they do not depend on the zoom. A
 *   comment has one, the box it is pinned in.
 *
 * A save stores the annotated copy under a new id and deletes the original, so
 * it points every such block, in every space, at the copy first.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist'

import { serialize } from '@/editor/markdown-serializer'
import { unwrap } from '@/lib/app-error'
import { type BlockRow, commands, type CreateBlockSpec, type PageResponse } from '@/lib/bindings'
import { PAGINATION_MAX, paginationLimit } from '@/lib/safe-limit'
import { requireActiveScope } from '@/lib/space-scope'

export const PDF_ATTACHMENT_KEY = 'pdf_attachment'
export const PDF_PAGE_KEY = 'pdf_page'
const PDF_BOXES_KEY = 'pdf_boxes'

/** pdf.js's `AnnotationEditorType`: a pinned comment and a highlight. */
const FREETEXT = 3
const HIGHLIGHT = 9

export interface PdfAnnotation {
  /** A highlight's passage, or a comment's words. */
  text: string
  /** From 1. */
  page: number
  boxes: number[][]
}

/** The part of an annotation pdf.js serializes into the file. */
interface SerializedAnnotation {
  annotationType: number
  /** The annotation the file already holds; absent on a new one. */
  id?: string | null
  pageIndex: number
  /** The annotation's box, `[x1, y1, x2, y2]`. */
  rect?: ArrayLike<number>
  /** A highlight's: eight numbers a box, top edge first; `null` on a free-hand one. */
  quadPoints?: ArrayLike<number> | null
  /** A comment's words. */
  value?: string
}

const oneLine = (text: string): string => text.replaceAll(/\s+/g, ' ').trim()

/** PDF units to two decimals: far below what a page shows, and short to store. */
const round = (value: number): number => Math.round(value * 100) / 100

/** Each box of a highlight's quad points as `[x1, y1, x2, y2]`. */
function boxesOf(quadPoints: ArrayLike<number>): number[][] {
  const at = (i: number): number => round(quadPoints[i] ?? 0)
  const boxes: number[][] = []
  // pdf.js writes a box's corners top left, top right, bottom left, bottom right.
  for (let i = 0; i + 7 < quadPoints.length; i += 8) {
    boxes.push([at(i), at(i + 5), at(i + 2), at(i + 1)])
  }
  return boxes
}

/**
 * The selected text of a highlight editor. pdf.js keeps it private and gives
 * it to the highlight only as its accessible name.
 */
function passageOf(editor: unknown): string {
  const div = (editor as { div?: HTMLElement | null } | undefined)?.div
  return oneLine(div?.getAttribute('aria-label') ?? '')
}

/**
 * The highlights and comments a save adds to the file, in the order they were
 * made: pdf.js's own serialization of its editors, the one `saveDocument()`
 * writes. One the file already holds is left out, and so is a free-hand
 * highlight, which covers no text.
 */
export function newAnnotations(
  storage: Pick<PDFDocumentProxy['annotationStorage'], 'serializable' | 'getRawValue'>,
): PdfAnnotation[] {
  const annotations: PdfAnnotation[] = []
  const map = storage.serializable.map as Map<string, SerializedAnnotation> | null
  for (const [key, data] of map ?? []) {
    if (data.id != null) continue
    let text = ''
    let boxes: number[][] = []
    if (data.annotationType === HIGHLIGHT && data.quadPoints != null) {
      text = passageOf(storage.getRawValue(key))
      boxes = boxesOf(data.quadPoints)
    } else if (data.annotationType === FREETEXT && data.rect) {
      text = oneLine(data.value ?? '')
      boxes = [Array.from(data.rect, round)]
    }
    if (text === '') continue
    annotations.push({ text, page: data.pageIndex + 1, boxes })
  }
  return annotations
}

/** One block per annotation, appended under `ownerId`, pointing at attachment `attachmentId`. */
export function annotationBlockSpecs(
  ownerId: string,
  attachmentId: string,
  annotations: readonly PdfAnnotation[],
): CreateBlockSpec[] {
  return annotations.map(({ text, page, boxes }) => ({
    blockType: 'content',
    // As typed text: a `*` or `#` in it stays a character.
    content: serialize({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    }),
    parentId: ownerId,
    position: null,
    properties: {
      [PDF_ATTACHMENT_KEY]: attachmentId,
      [PDF_PAGE_KEY]: String(page),
      [PDF_BOXES_KEY]: JSON.stringify(boxes),
    },
  }))
}

/**
 * Point every live block whose `pdf_attachment` is `from` at `to`, in each of
 * `spaceIds`: a block follows its file to whatever page or space it was moved.
 * Throws on the first refused read or write.
 */
export async function repointAnnotationBlocks(
  spaceIds: readonly string[],
  from: string,
  to: string,
): Promise<void> {
  const ids: string[] = []
  for (const spaceId of spaceIds) {
    let cursor: string | null = null
    do {
      const page: PageResponse<BlockRow> = unwrap(
        await commands.queryByProperty(
          {
            key: PDF_ATTACHMENT_KEY,
            valueText: from,
            valueDate: null,
            operator: null,
            cursor,
            limit: paginationLimit(PAGINATION_MAX),
            excludeParentId: null,
            contentNonEmpty: null,
            blockType: null,
            valueTextIn: null,
            valueDateRange: null,
            excludeTodoStates: null,
          },
          requireActiveScope(spaceId),
        ),
      )
      ids.push(...page.items.map((block) => block.id))
      cursor = page.has_more ? page.next_cursor : null
    } while (cursor !== null)
  }
  // Not undoable: undoing one would point the block at the deleted original.
  for (const id of ids) {
    unwrap(
      await commands.setProperty(id, PDF_ATTACHMENT_KEY, {
        value_text: to,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      }),
    )
  }
}

/** Where a block's annotation is, from its properties; `null` on a block that is none. */
export function pdfSourceOf(
  properties: ReadonlyArray<{ key: string; value: string }> | undefined,
): { attachmentId: string; page: number } | null {
  const attachmentId = properties?.find(({ key }) => key === PDF_ATTACHMENT_KEY)?.value
  if (!attachmentId) return null
  const page = Number(properties?.find(({ key }) => key === PDF_PAGE_KEY)?.value)
  return { attachmentId, page: Number.isInteger(page) && page > 0 ? page : 1 }
}
