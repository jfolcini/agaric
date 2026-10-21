/**
 * Page mode's drag (#5691): a block's grip drags the block with the blocks
 * under it, as block mode's does. Pointer events, as block mode's pointer
 * sensor: a press becomes a drag only past `MOUSE_DRAG_ACTIVATION_DISTANCE`, so
 * a click on the grip still opens its menu. The drop lands before or after the
 * block under the pointer, as the pointer is over its upper or lower half, at
 * the depth its sideways travel asks for, within what keeps the page a tree
 * (`dropTarget`, block mode's `projectDepth`). It edits the document
 * (`dropBlock`), and the save writes the move through the block commands, as
 * it writes Tab's. While it lasts the blocks it carries fade and block mode's
 * drop indicator shows where they would land; Escape, or the window losing
 * focus, cancels it, and the scroller follows the pointer near its edges, as
 * block mode's (`useAutoScrollOnDrag`).
 */

import { Extension } from '@tiptap/core'
import { type EditorState, Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

import {
  MOUSE_DRAG_ACTIVATION_DISTANCE,
  resolveIndentWidth,
} from '@/components/block-tree/use-block-dnd'
import { dropBlock } from '@/editor/page-mode/page-block-actions'
import { hiddenBlocks } from '@/editor/page-mode/page-collapse'
import { blockIndex, depthOf, startOf, subtreeEnd } from '@/editor/page-mode/page-document'
import { GRIP } from '@/editor/page-mode/page-gutter'
import { blockIdOf } from '@/editor/token-ids'
import { MAX_SPEED, SCROLL_ZONE } from '@/hooks/useAutoScrollOnDrag'
import { shouldReduceMotion } from '@/lib/preferences'
import { scrollParentY } from '@/lib/scroll-parent'
import { MAX_BLOCK_DEPTH, projectDepth, type TreeItem } from '@/lib/tree-utils'

/** Where a drag lands: the index of the block it then goes before (the page's length for its end), and its depth. */
export interface Drop {
  slot: number
  depth: number
}

/**
 * Where the block at `from`, with the blocks under it, lands when dropped on
 * the block at `over` (`after`: on its lower half), `dx` pixels right of where
 * the drag started. After a collapsed block is after what it hides; among the
 * dragged blocks, or just past them, is where they are. The depth follows the
 * pointer one level per `indentWidth`, past block mode's dead zone, and is
 * held as block mode's projection holds it: at most one deeper than the block
 * shown before, at least as deep as the block after, so that block stays where
 * it is, and shallow enough for the deepest dragged block to stay within
 * `MAX_BLOCK_DEPTH`. Null where no depth is both: the block after would then
 * move in under the dragged ones.
 */
export function dropTarget(
  state: EditorState,
  from: number,
  over: number,
  after: boolean,
  dx: number,
  indentWidth: number,
): Drop | null {
  const { doc } = state
  const hidden = hiddenBlocks(state)
  const shown = (index: number): boolean => !hidden.has(blockIdOf(doc.child(index)) ?? '')
  const end = subtreeEnd(doc, from)
  let slot = over
  if (after) {
    slot = over + 1
    while (slot < doc.childCount && !shown(slot)) slot += 1
  }
  if (slot > from && slot <= end) slot = from
  let previous = slot - 1
  while (previous >= 0 && ((previous >= from && previous < end) || !shown(previous))) previous -= 1
  const next = slot === from ? end : slot
  const root = depthOf(doc.child(from))
  let height = 0
  for (let i = from + 1; i < end; i += 1) height = Math.max(height, depthOf(doc.child(i)) - root)
  const item = (index: number): TreeItem => ({
    id: blockIdOf(doc.child(index)) ?? '',
    parent_id: null,
    depth: depthOf(doc.child(index)),
  })
  // Only the depth is read: the save gives each block the parent its depth gives it.
  const projection = projectDepth(
    {
      kind: 'normal',
      clonedItems: [],
      projectedIndex: 0,
      previousItem: previous < 0 ? undefined : item(previous),
      nextItem: next < doc.childCount ? item(next) : undefined,
      activeItem: item(from),
      depthCeiling: Math.max(0, MAX_BLOCK_DEPTH - 1 - height),
      rootParentId: null,
    },
    dx,
    indentWidth,
  )
  if (projection.maxDepth < projection.minDepth) return null
  return { slot, depth: projection.depth }
}

/** The block at `index`'s element. */
function blockDom(view: EditorView, index: number): HTMLElement | null {
  const dom = view.nodeDOM(startOf(view.state.doc, index))
  return dom instanceof HTMLElement ? dom : null
}

/** The block level with the pointer, and whether the pointer is over its lower half. */
function pointed(view: EditorView, y: number): { index: number; after: boolean } | null {
  const box = view.dom.getBoundingClientRect()
  const at = view.posAtCoords({
    left: (box.left + box.right) / 2,
    top: Math.min(Math.max(y, box.top + 1), box.bottom - 1),
  })
  if (at === null) return null
  const { doc } = view.state
  const index = Math.min(doc.resolve(at.pos).index(0), doc.childCount - 1)
  const rect = blockDom(view, index)?.getBoundingClientRect()
  if (rect === undefined) return null
  return { index, after: y > rect.top + rect.height / 2 }
}

/** A click the release of a drag makes is the drag's, not the grip's menu's. */
function swallowClick(event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

/** The class the dragged blocks wear (`index.css`). */
const DRAGGING = 'page-block-dragging'

class DragController {
  private readonly view: EditorView
  private press: { id: string; x: number; y: number } | null = null
  private dragging = false
  private pointer = { x: 0, y: 0 }
  private drop: Drop | null = null
  private bar: HTMLElement | null = null
  private faded: HTMLElement[] = []
  private frame: number | null = null
  private indentWidth = 0

  constructor(view: EditorView) {
    this.view = view
    view.dom.addEventListener('pointerdown', this.down)
  }

  private readonly down = (event: PointerEvent): void => {
    if (event.button !== 0 || this.press !== null || !(event.target instanceof Element)) return
    const block = event.target.closest(`[${GRIP}]`)?.closest('[data-page-block-id]')
    const id = block?.getAttribute('data-page-block-id') ?? null
    if (id === null) return
    this.press = { id, x: event.clientX, y: event.clientY }
    window.addEventListener('pointermove', this.move)
    window.addEventListener('pointerup', this.up)
    window.addEventListener('pointercancel', this.end)
    // The window lost the button's release (Alt+Tab with it held): nothing to drop.
    window.addEventListener('blur', this.end)
  }

  private readonly move = (event: PointerEvent): void => {
    const { press } = this
    if (press === null) return
    this.pointer = { x: event.clientX, y: event.clientY }
    if (!this.dragging) {
      const travel = Math.hypot(event.clientX - press.x, event.clientY - press.y)
      if (travel < MOUSE_DRAG_ACTIVATION_DISTANCE) return
      this.start(press.id)
    }
    this.track()
  }

  private start(id: string): void {
    const { doc } = this.view.state
    const from = blockIndex(doc, id)
    if (from === null) {
      this.end()
      return
    }
    this.dragging = true
    this.indentWidth = resolveIndentWidth()
    window.addEventListener('click', swallowClick, { capture: true, once: true })
    window.addEventListener('keydown', this.escape, true)
    const end = subtreeEnd(doc, from)
    for (let index = from; index < end; index += 1) {
      const dom = blockDom(this.view, index)
      if (dom === null) continue
      dom.classList.add(DRAGGING)
      this.faded.push(dom)
    }
    this.bar = document.createElement('div')
    // Block mode's drop indicator (`SortableBlockWrapper`).
    this.bar.className =
      'drop-indicator fixed z-50 pointer-events-none h-[5px] bg-ring rounded-full ring-2 ring-ring/20'
    this.bar.setAttribute('aria-hidden', 'true')
    this.bar.setAttribute('data-testid', 'page-drop-indicator')
    document.body.append(this.bar)
    if (!shouldReduceMotion()) this.frame = requestAnimationFrame(this.scroll)
  }

  /** Work out where the drop lands from the pointer, and show it. */
  private track(): void {
    const { press, bar, view } = this
    const from = press === null ? null : blockIndex(view.state.doc, press.id)
    const over = pointed(view, this.pointer.y)
    if (press === null || bar === null || from === null || over === null) return
    const drop = dropTarget(
      view.state,
      from,
      over.index,
      over.after,
      this.pointer.x - press.x,
      this.indentWidth,
    )
    this.drop = drop
    bar.hidden = drop === null
    if (drop === null) return
    const { doc } = view.state
    const hidden = hiddenBlocks(view.state)
    let edge: number | undefined
    if (drop.slot < doc.childCount) {
      edge = blockDom(view, drop.slot)?.getBoundingClientRect().top
    } else {
      let last = doc.childCount - 1
      while (last > 0 && hidden.has(blockIdOf(doc.child(last)) ?? '')) last -= 1
      edge = blockDom(view, last)?.getBoundingClientRect().bottom
    }
    const box = view.dom.getBoundingClientRect()
    const left =
      box.left +
      Number.parseFloat(getComputedStyle(view.dom).paddingLeft) +
      drop.depth * this.indentWidth
    bar.style.left = `${left}px`
    bar.style.width = `${Math.max(0, box.right - left)}px`
    bar.style.top = `${(edge ?? box.top) - 2.5}px`
  }

  /** Near the scroller's top or bottom edge, scroll it, faster the nearer, as block mode's drag. */
  private readonly scroll = (): void => {
    this.frame = requestAnimationFrame(this.scroll)
    const scroller = scrollParentY(this.view.dom)
    if (scroller === null) return
    const { top, bottom } = scroller.getBoundingClientRect()
    const { y } = this.pointer
    let speed = 0
    if (y - top >= 0 && y - top < SCROLL_ZONE) speed = -((SCROLL_ZONE - (y - top)) / SCROLL_ZONE)
    else if (bottom - y >= 0 && bottom - y < SCROLL_ZONE) {
      speed = (SCROLL_ZONE - (bottom - y)) / SCROLL_ZONE
    }
    if (speed === 0) return
    scroller.scrollTop += speed * MAX_SPEED
    this.track()
  }

  private readonly up = (): void => {
    const { press, drop, dragging, view } = this
    this.end()
    if (press === null || !dragging || drop === null) return
    dropBlock(press.id, drop.slot, drop.depth)(view.state, view.dispatch)
    view.focus()
  }

  private readonly escape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    this.end()
  }

  /** Stop the drag, or the press, dropping nothing. */
  private readonly end = (): void => {
    window.removeEventListener('pointermove', this.move)
    window.removeEventListener('pointerup', this.up)
    window.removeEventListener('pointercancel', this.end)
    window.removeEventListener('blur', this.end)
    window.removeEventListener('keydown', this.escape, true)
    if (this.dragging) {
      // A release with no click after it (off the window) leaves nothing to swallow.
      setTimeout(() => window.removeEventListener('click', swallowClick, true))
    }
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    for (const dom of this.faded) dom.classList.remove(DRAGGING)
    this.bar?.remove()
    this.press = null
    this.dragging = false
    this.drop = null
    this.bar = null
    this.faded = []
    this.frame = null
  }

  destroy(): void {
    this.end()
    this.view.dom.removeEventListener('pointerdown', this.down)
  }
}

/** The drag of a block by its grip (`page-gutter.ts`). */
export const PageDrag = Extension.create({
  name: 'pageDrag',
  addProseMirrorPlugins() {
    return [new Plugin({ view: (view) => new DragController(view) })]
  },
})
