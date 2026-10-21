/**
 * What a switch between block mode and page mode (#5691) carries over: the
 * caret, as a block and a position in that block's own document (block mode's
 * editor holds one block's content as its document, page mode's `pageBlock`
 * holds the same nodes), and the place the page is scrolled to, as the block
 * at the top of the app's scroller. A block is the place, not the scroll
 * offset: the two modes draw a block at different heights. No TipTap here:
 * `usePageMode` imports it statically.
 */

export interface BlockCaret {
  blockId: string
  /** The caret's position in the block's own document. */
  pos: number
}

export interface ScrollPlace {
  blockId: string
  /** How far below the scroller's top the block starts. */
  top: number
}

/** What page mode opens on after a switch: block mode's caret and the block at the top. */
export interface PageModeOpening {
  cursor: BlockCaret | null
  place: ScrollPlace | null
}

/** Both modes' rows of the page: page mode's blocks, block mode's tree rows. */
const ROWS = '.page-editor [data-page-block-id], .page-editor li[data-block-id]'

function rowId(row: Element): string | null {
  return row.getAttribute('data-page-block-id') ?? row.getAttribute('data-block-id')
}

const scroller = (): HTMLElement | null => document.getElementById('main-content')

/** The first block of the page not scrolled above the scroller's top; none without one. */
export function scrollPlace(): ScrollPlace | null {
  const at = scroller()?.getBoundingClientRect().top
  if (at === undefined) return null
  for (const row of document.querySelectorAll(ROWS)) {
    const box = row.getBoundingClientRect()
    const blockId = rowId(row)
    if (box.bottom > at && blockId !== null) return { blockId, top: box.top - at }
  }
  return null
}

/** Scroll the page so `place`'s block starts where it did; nothing if it is not drawn. */
export function restoreScrollPlace(place: ScrollPlace): void {
  const box = scroller()
  const row = [...document.querySelectorAll(ROWS)].find((el) => rowId(el) === place.blockId)
  if (box === null || row === undefined) return
  box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - place.top
}
