/**
 * A page carried by a native drag (#5691): a recent page drags it
 * (`NewTabTarget`'s `dragsPage`), and the editor takes it as a `[[link]]` where
 * it is dropped. Its plain text is that link as stored, so Edit as Markdown,
 * or an app outside, reads it as the link.
 */

import { blockLinkToken } from '@/editor/markdown-common'

/** The drag type carrying a page's id. */
export const PAGE_DRAG_TYPE = 'application/x-agaric-page'

export function setPageDragData(data: DataTransfer, pageId: string): void {
  data.setData(PAGE_DRAG_TYPE, pageId)
  data.setData('text/plain', blockLinkToken(pageId))
}

/** Whether a drag carries a page: all a `dragover` may read of it. */
export function carriesPage(data: DataTransfer | null): boolean {
  return data?.types.includes(PAGE_DRAG_TYPE) ?? false
}

/** The page a drop carries, or null. */
export function droppedPageId(data: DataTransfer | null): string | null {
  return data?.getData(PAGE_DRAG_TYPE) || null
}

/**
 * Drop `pageId` on whatever is at `(x, y)`, as a native drop there would land,
 * for a drag that is no native one: dnd-kit's pointer sensor, which the
 * bookmarks reorder with, cancels the native drag.
 */
export function dropPageAt(pageId: string, x: number, y: number): void {
  const target = document.elementFromPoint(x, y)
  if (target === null) return
  const dataTransfer = new DataTransfer()
  setPageDragData(dataTransfer, pageId)
  const drop = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    dataTransfer,
  })
  target.dispatchEvent(drop)
}
