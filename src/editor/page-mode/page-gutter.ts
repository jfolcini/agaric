/**
 * Page mode's gutter (#5691): block mode's grip and chevron
 * (`BlockGutterControls`, `BlockCollapseControl`), where block mode's control
 * lane sits, left of the checkbox slot and on the first line, the chevron
 * nearer the text, as plain DOM with block mode's classes, labels and glyphs.
 *
 * A block with blocks under it draws its chevron in its node view, outside its
 * editable text (`PageGutter`); the chevron collapses the block
 * (`page-collapse.ts`). The grip is one for the editor (`PageGrip`), outside
 * its editable root: a grip on every block, even an invisible one, slowed
 * each keystroke on a long page on WebKit (`scripts/measure-page-mode-webkit.mjs`).
 * It sits on the block under the pointer, and hides as the pointer leaves the
 * editor and the grip, or as the document or what is collapsed changes, which
 * can move the block. It drags its block (`page-drag.ts`), and a click on it
 * opens the block's menu (`PageBlockMenu`). It is no tab stop: with no pointer
 * it has no block, and the menu key and Shift+F10 open the menu at the
 * cursor's. A press on either keeps the editor's focus and caret, as block
 * mode's chevron does (#1498).
 */

import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

import { GUTTER_BUTTON_LOOK } from '@/components/editor/BlockGutterControls'
import {
  COLLAPSE_TOGGLE_BASE,
  COLLAPSE_TOGGLE_HIDDEN_AT_REST,
} from '@/components/editor/BlockInlineControls'
import { chevronToggleVariants } from '@/components/ui/chevron-toggle'
import { type Fold, hiddenBlocks } from '@/editor/page-mode/page-collapse'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** The attribute the grip carries. */
const GRIP = 'data-page-grip'

/** The attribute of the block the grip is on, whose chevron stays shown (`index.css`). */
const GRIP_ON = 'data-page-grip-on'

/**
 * The event a click on a grip sends the editor's root, for the block menu (`PageBlockMenu`): this
 * one, or the touch toolbar's block-menu button (`page-toolbar.tsx`).
 */
export const GRIP_MENU = 'page-grip-menu'

export interface GripMenuDetail {
  blockId: string
  grip: HTMLElement
}

interface Glyph {
  name: string
  shapes: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>
}

// Lucide's `GripVertical`, `ChevronRight` and `Play`, which block mode's grip
// and chevron (`ChevronToggle`) draw as React components; a test holds these
// to what those draw (`page-gutter.test.tsx`).
const GRIP_GLYPH: Glyph = {
  name: 'grip-vertical',
  shapes: [
    ['circle', { cx: '9', cy: '12', r: '1' }],
    ['circle', { cx: '9', cy: '5', r: '1' }],
    ['circle', { cx: '9', cy: '19', r: '1' }],
    ['circle', { cx: '15', cy: '12', r: '1' }],
    ['circle', { cx: '15', cy: '5', r: '1' }],
    ['circle', { cx: '15', cy: '19', r: '1' }],
  ],
}
const CHEVRON_GLYPH: Glyph = { name: 'chevron-right', shapes: [['path', { d: 'm9 18 6-6-6-6' }]] }
const CARET_GLYPH: Glyph = {
  name: 'play',
  shapes: [
    [
      'path',
      {
        d: 'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z',
      },
    ],
  ],
}

const SVG = 'http://www.w3.org/2000/svg'

/** `glyph` as lucide draws it: a 24-unit, 2-unit stroke icon in the text's colour. */
function icon(
  glyph: Glyph,
  className: string,
  data: Readonly<Record<string, string>> = {},
): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  for (const [name, value] of Object.entries({
    width: '24',
    height: '24',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: `lucide lucide-${glyph.name} ${className}`,
    'aria-hidden': 'true',
    ...data,
  })) {
    svg.setAttribute(name, value)
  }
  for (const [tag, attributes] of glyph.shapes) {
    const shape = document.createElementNS(SVG, tag)
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value)
    svg.append(shape)
  }
  return svg
}

/** A block's chevron, the first thing in its node view: none for a block with no blocks under it. */
export class PageGutter {
  /** The chevron's frame; none while the block has no blocks under it. */
  element: HTMLElement | null = null
  private shown: Fold | null = null
  private readonly block: HTMLElement
  private readonly onFold: () => void

  /** `onFold` collapses or expands `block`. */
  constructor(block: HTMLElement, onFold: () => void) {
    this.block = block
    this.onFold = onFold
  }

  /**
   * Draw the chevron for `fold`. Folding redraws the same button, so a
   * keyboard user's focus stays on it.
   */
  show(fold: Fold | null): void {
    if (fold === this.shown) return
    this.shown = fold
    if (fold === null) {
      this.element?.remove()
      this.element = null
      return
    }
    if (this.element === null) {
      this.element = document.createElement('div')
      this.element.className = 'page-block-gutter'
      this.element.contentEditable = 'false'
      // Keeps the editor focused, its caret where it was, and no text selection starting.
      this.element.addEventListener('mousedown', (event) => event.preventDefault())
      const chevron = document.createElement('button')
      chevron.type = 'button'
      chevron.setAttribute('data-testid', 'collapse-toggle')
      chevron.setAttribute('aria-keyshortcuts', t('block.collapseKeyshortcuts'))
      chevron.addEventListener('click', () => this.onFold())
      this.element.append(chevron)
      this.block.prepend(this.element)
    }
    drawChevron(this.element.firstElementChild as HTMLButtonElement, fold === 'collapsed')
  }
}

/** The editor's one grip, placed on the block under the pointer. */
export class PageGrip {
  /** Its frame, a sibling of the editor's root, on which a press starts a drag. */
  readonly element = document.createElement('div')
  private readonly button = document.createElement('button')
  private readonly view: EditorView
  private block: HTMLElement | null = null
  private pointedAt: EventTarget | null = null
  private frame: number | null = null
  private held = false

  constructor(view: EditorView) {
    this.view = view
    const { element, button } = this
    element.className = 'page-grip'
    element.hidden = true
    // Outside the editor: a press keeps its focus and caret, and no text selection starts.
    element.addEventListener('mousedown', (event) => event.preventDefault())
    element.addEventListener('pointerleave', this.leave)
    button.type = 'button'
    button.tabIndex = -1
    button.className = cn(GUTTER_BUTTON_LOOK, 'drag-handle cursor-grab hover:text-foreground')
    button.setAttribute('aria-label', t('block.reorder'))
    button.setAttribute('aria-haspopup', 'menu')
    button.title = t('pageMode.gripTip')
    button.setAttribute('data-testid', 'drag-handle')
    button.toggleAttribute(GRIP, true)
    button.append(icon(GRIP_GLYPH, 'size-[1em]'))
    button.addEventListener('click', this.click)
    element.append(button)
    view.dom.addEventListener('pointermove', this.move)
    view.dom.addEventListener('pointerleave', this.leave)
    // Ahead of ProseMirror's own, which a press already handled leaves alone.
    view.dom.addEventListener('mousedown', this.pressLane, true)
  }

  /** The block it is on; none while it is hidden. */
  get blockId(): string | null {
    return this.block?.getAttribute('data-page-block-id') ?? null
  }

  /** While a drag lasts it hides and stays put; after, it shows again once the pointer moves. */
  hold(held: boolean): void {
    this.held = held
    if (held) this.hide()
  }

  /** The block may have moved: hide until the pointer moves, rather than measure on every key. */
  update(view: EditorView, previous: EditorState): void {
    if (view.state.doc !== previous.doc || hiddenBlocks(view.state) !== hiddenBlocks(previous)) {
      this.hide()
    }
  }

  destroy(): void {
    this.hide()
    this.view.dom.removeEventListener('pointermove', this.move)
    this.view.dom.removeEventListener('pointerleave', this.leave)
    this.view.dom.removeEventListener('mousedown', this.pressLane, true)
    this.element.remove()
  }

  /** Read where the pointer is once a frame, however often it moves. */
  private readonly move = (event: PointerEvent): void => {
    this.pointedAt = event.target
    this.frame ??= requestAnimationFrame(this.follow)
  }

  private readonly follow = (): void => {
    this.frame = null
    if (this.held) return
    const { pointedAt } = this
    const block =
      pointedAt instanceof Element ? pointedAt.closest<HTMLElement>('[data-page-block-id]') : null
    if (block === null) this.hide()
    else this.place(block)
  }

  /** The pointer left the editor or the grip, for anything but the other. */
  private readonly leave = (event: PointerEvent): void => {
    const to = event.relatedTarget
    if (to instanceof Node && (this.view.dom.contains(to) || this.element.contains(to))) return
    this.hide()
  }

  /** A press in a block's lane beside the grip keeps the caret, as one on its gutter does. */
  private readonly pressLane = (event: MouseEvent): void => {
    const { target } = event
    if (
      target instanceof Element &&
      target.hasAttribute('data-page-block') &&
      event.clientX < target.getBoundingClientRect().left
    ) {
      event.preventDefault()
    }
  }

  /**
   * Put it at `block`'s top left corner, in the frame the editor's root sits in
   * (`PageModeEditor` positions it), so it scrolls with the block; its classes
   * move it left of there, into the block's gutter (`index.css`). Measured on
   * every move, on its block too: a window resize moves the block with no
   * change to the document.
   */
  private place(block: HTMLElement): void {
    const { element, view } = this
    if (block !== this.block) {
      if (element.parentElement !== view.dom.parentElement) view.dom.after(element)
      this.block?.removeAttribute(GRIP_ON)
      this.block = block
      block.setAttribute(GRIP_ON, '')
      element.toggleAttribute(
        'data-chevron',
        block.querySelector(':scope > .page-block-gutter') !== null,
      )
      element.hidden = false
    }
    // The editor is mounted: the pointer is on it.
    const at = block.getBoundingClientRect()
    const origin = (view.dom.parentElement as HTMLElement).getBoundingClientRect()
    element.style.top = `${at.top - origin.top}px`
    element.style.left = `${at.left - origin.left}px`
  }

  private hide(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.block?.removeAttribute(GRIP_ON)
    this.block = null
    this.element.hidden = true
  }

  private readonly click = (): void => {
    const blockId = this.blockId
    if (blockId === null) return
    this.view.dom.dispatchEvent(
      new CustomEvent<GripMenuDetail>(GRIP_MENU, { detail: { blockId, grip: this.button } }),
    )
  }
}

function drawChevron(chevron: HTMLButtonElement, collapsed: boolean): void {
  chevron.className = cn(
    COLLAPSE_TOGGLE_BASE,
    collapsed ? 'text-foreground' : COLLAPSE_TOGGLE_HIDDEN_AT_REST,
    'max-sm:flex max-sm:items-center max-sm:justify-center',
  )
  chevron.setAttribute('data-collapsed', String(collapsed))
  chevron.setAttribute(
    'aria-label',
    collapsed ? t('block.expandChildren') : t('block.collapseChildren'),
  )
  chevron.setAttribute('aria-expanded', String(!collapsed))
  chevron.title = collapsed ? t('block.expandTip') : t('block.collapseTip')
  const size = chevronToggleVariants({ size: 'lg' })
  const slot = { 'data-slot': 'chevron-toggle' }
  chevron.replaceChildren(
    collapsed
      ? icon(CARET_GLYPH, cn(size, 'fill-current scale-[0.8]'), { ...slot, 'data-solid': 'true' })
      : icon(CHEVRON_GLYPH, cn(size, 'rotate-90'), slot),
  )
}
