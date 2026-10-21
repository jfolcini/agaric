/**
 * A page-mode block's gutter (#5691): block mode's grip and chevron
 * (`BlockGutterControls`, `BlockCollapseControl`), left of the checkbox slot
 * as block mode's control lane, drawn as plain DOM in the block's node view,
 * outside its editable text, with block mode's classes, labels and glyphs.
 * The grip drags the block (`page-drag.ts`), and a click on it, or Enter on it,
 * opens the block menu (`PageBlockMenu`); the chevron collapses the block
 * (`page-collapse.ts`). A press keeps the editor's focus and caret, as block
 * mode's chevron does (#1498).
 */

import { GUTTER_BUTTON_BASE } from '@/components/editor/BlockGutterControls'
import {
  COLLAPSE_TOGGLE_BASE,
  COLLAPSE_TOGGLE_HIDDEN_AT_REST,
} from '@/components/editor/BlockInlineControls'
import { chevronToggleVariants } from '@/components/ui/chevron-toggle'
import type { Fold } from '@/editor/page-mode/page-collapse'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** The attribute a block's grip carries, by which the drag and the block menu find it. */
export const GRIP = 'data-page-grip'

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

export class PageGutter {
  readonly element = document.createElement('div')
  private chevron: HTMLButtonElement | null = null
  private shown: Fold | null = null
  private readonly onFold: () => void

  /** `onFold` collapses or expands the block. */
  constructor(onFold: () => void) {
    this.onFold = onFold
    this.element.className = 'page-block-gutter'
    this.element.contentEditable = 'false'
    // Keeps the editor focused, its caret where it was, and no text selection starting.
    this.element.addEventListener('mousedown', (event) => event.preventDefault())
    const grip = document.createElement('button')
    grip.type = 'button'
    grip.className = cn(GUTTER_BUTTON_BASE, 'drag-handle cursor-grab hover:text-foreground')
    grip.setAttribute('aria-label', t('block.reorder'))
    grip.setAttribute('aria-haspopup', 'menu')
    grip.title = t('pageMode.gripTip')
    grip.setAttribute('data-testid', 'drag-handle')
    grip.toggleAttribute(GRIP, true)
    grip.append(icon(GRIP_GLYPH, 'size-[1em]'))
    this.element.append(grip)
  }

  /**
   * Draw the chevron for `fold`: none for a block with no blocks under it.
   * Folding redraws the same button, so a keyboard user's focus stays on it.
   */
  show(fold: Fold | null): void {
    if (fold === this.shown) return
    this.shown = fold
    if (fold === null) {
      this.chevron?.remove()
      this.chevron = null
      return
    }
    if (this.chevron === null) {
      this.chevron = document.createElement('button')
      this.chevron.type = 'button'
      this.chevron.setAttribute('data-testid', 'collapse-toggle')
      this.chevron.setAttribute('aria-keyshortcuts', t('block.collapseKeyshortcuts'))
      this.chevron.addEventListener('click', () => this.onFold())
      this.element.append(this.chevron)
    }
    drawChevron(this.chevron, fold === 'collapsed')
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
