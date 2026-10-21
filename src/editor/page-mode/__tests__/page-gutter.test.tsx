/**
 * A page-mode block's gutter in its node view (#5691): block mode's grip on
 * every block, and its chevron on a block with blocks under it, outside the
 * text and with block mode's labels; the chevron collapses the block; a press
 * keeps the editor's caret; and a block's chevron follows the blocks moved
 * under it. The grip's menu is `PageBlockMenu.test.tsx`'s, its drag
 * `page-drag.test.ts`'s, and the keys on a focused grip Playwright's
 * (`e2e/page-mode-gutter.spec.ts`).
 */

import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { BlockGutterControls } from '@/components/editor/BlockGutterControls'
import { BlockCollapseControl } from '@/components/editor/BlockInlineControls'
import { blockId, caret, press, type Row } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { blockEl, mountNodeViews } from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { t } from '@/lib/i18n'

const [A, B, C] = [1, 2, 3].map(blockId) as [string, string, string]

let teardown: (() => void) | null = null

function mount(rows: readonly Row[]) {
  const mounted = mountNodeViews(rows)
  teardown = () => {
    mounted.unmount()
    mounted.editor.destroy()
  }
  return mounted
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined)
})

afterEach(() => {
  teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

function grip(container: HTMLElement, id: string): HTMLElement | null {
  return blockEl(container, id).querySelector(':scope > .page-block-gutter > [data-page-grip]')
}

function chevron(container: HTMLElement, id: string): HTMLElement | null {
  return blockEl(container, id).querySelector(
    ':scope > .page-block-gutter > [data-testid="collapse-toggle"]',
  )
}

/** `el`'s classes, sorted. */
const classes = (el: Element | null): string[] => [...(el?.classList ?? [])].toSorted()

/** An icon's attributes, but the namespace React writes as one, and its shapes'. */
function drawing(svg: Element | null | undefined) {
  const attributes = (el: Element) =>
    [...el.attributes]
      .filter(({ name }) => name !== 'xmlns')
      .map(({ name, value }) => `${name}=${value}`)
      .toSorted()
  if (svg == null) return null
  return {
    svg: attributes(svg),
    shapes: [...svg.children].map((shape) => [shape.tagName.toLowerCase(), attributes(shape)]),
  }
}

/** Block mode's chevron, collapsed or not. */
function blockChevron(collapsed: boolean): Element | null {
  return render(
    <BlockCollapseControl blockId={A} hasChildren isCollapsed={collapsed} isTouch={false} />,
  ).container.querySelector('[data-testid="collapse-toggle"]')
}

const TREE: Row[] = [
  [A, 0, 'a'],
  [B, 1, 'b'],
  [C, 0, 'c'],
]

describe('the gutter', () => {
  it('draws block mode’s grip on every block, outside its text, and its chevron on a block with blocks under it, with no a11y violations', async () => {
    const { container } = mount(TREE)

    for (const id of [A, B, C]) {
      const handle = grip(container, id)
      expect(handle).toHaveAttribute('data-testid', 'drag-handle')
      expect(handle).toHaveAttribute('aria-label', t('block.reorder'))
      expect(handle).toHaveAttribute('aria-haspopup', 'menu')
      expect(handle).toHaveAttribute('title', t('pageMode.gripTip'))
    }
    const gutter = blockEl(container, A).querySelector(':scope > .page-block-gutter')
    expect((gutter as HTMLElement).contentEditable).toBe('false')
    const fold = chevron(container, A)
    expect(fold).toHaveAttribute('aria-expanded', 'true')
    expect(fold).toHaveAttribute('aria-label', t('block.collapseChildren'))
    expect(fold).toHaveAttribute('aria-keyshortcuts', t('block.collapseKeyshortcuts'))
    expect(fold).toHaveAttribute('title', t('block.collapseTip'))
    expect(chevron(container, B)).toBeNull()
    expect(chevron(container, C)).toBeNull()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('the chevron collapses the block, hiding the blocks under it, says so with a solid caret, and expands it again', async () => {
    const { container } = mount(TREE)
    const pressed = chevron(container, A) as HTMLElement
    act(() => pressed.focus())

    act(() => {
      fireEvent.click(pressed)
    })

    expect(blockEl(container, B)).toHaveClass('page-block-hidden')
    expect(chevron(container, B)).toBeNull()
    expect(blockEl(container, C)).not.toHaveClass('page-block-hidden')
    const fold = chevron(container, A)
    // The same button, so a keyboard user who pressed it keeps the focus.
    expect(fold).toBe(pressed)
    expect(fold).toHaveFocus()
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    expect(fold).toHaveAttribute('data-collapsed', 'true')
    expect(fold).toHaveAttribute('aria-label', t('block.expandChildren'))
    expect(fold).toHaveAttribute('title', t('block.expandTip'))
    expect(fold?.querySelector('svg')).toHaveClass('fill-current')
    expect(await axe(container)).toHaveNoViolations()

    act(() => {
      fireEvent.click(fold as HTMLElement)
    })

    expect(blockEl(container, B)).not.toHaveClass('page-block-hidden')
    expect(chevron(container, A)).toHaveAttribute('aria-expanded', 'true')
  })

  it('draws them as block mode does: its grip’s and its chevron’s classes and glyphs, expanded and collapsed', () => {
    const { container } = mount(TREE)
    const blockGrip = render(<BlockGutterControls blockId={A} />).container.querySelector(
      '[data-testid="drag-handle"]',
    )

    const pageGrip = grip(container, A)
    expect(classes(pageGrip)).toEqual(classes(blockGrip))
    expect(pageGrip?.getAttribute('type')).toBe(blockGrip?.getAttribute('type'))
    expect(drawing(pageGrip?.querySelector('svg'))).toEqual(
      drawing(blockGrip?.querySelector('svg')),
    )
    for (const collapsed of [false, true]) {
      const pageChevron = chevron(container, A)
      const expected = blockChevron(collapsed)
      expect(classes(pageChevron)).toEqual(classes(expected))
      expect(pageChevron?.getAttribute('type')).toBe(expected?.getAttribute('type'))
      expect(drawing(pageChevron?.querySelector('svg'))).toEqual(
        drawing(expected?.querySelector('svg')),
      )
      act(() => {
        fireEvent.click(pageChevron as HTMLElement)
      })
    }
  })

  it('a press on the grip or the chevron keeps the editor’s focus and caret', () => {
    const { container } = mount(TREE)

    expect(fireEvent.mouseDown(grip(container, A) as HTMLElement)).toBe(false)
    expect(fireEvent.mouseDown(chevron(container, A) as HTMLElement)).toBe(false)
  })

  it('a change to the block’s text keeps its chevron, and the focus on it', () => {
    const { container, editor } = mount(TREE)
    const fold = chevron(container, A) as HTMLElement
    act(() => fold.focus())

    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('z', 3))
    })

    expect(blockEl(container, A).textContent).toContain('az')
    expect(chevron(container, A)).toBe(fold)
    expect(fold).toHaveFocus()
  })

  it('a block gains its chevron as a block moves under it, and loses it as that block moves out', () => {
    const { container, editor } = mount([
      [A, 0, 'a'],
      [B, 0, 'b'],
    ])
    expect(chevron(container, A)).toBeNull()
    caret(editor, 1, 0)

    act(() => {
      press(editor, 'Tab')
    })
    expect(chevron(container, A)).not.toBeNull()

    act(() => {
      press(editor, 'Tab', { shiftKey: true })
    })
    expect(chevron(container, A)).toBeNull()
  })
})
