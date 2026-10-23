/**
 * Page mode's gutter (#5691): block mode's chevron in the node view of a block
 * with blocks under it, outside its text and with block mode's labels, which
 * collapses the block; and the editor's one grip, outside its root however
 * many blocks the page has, placed on the block under the pointer and hidden
 * as the pointer leaves or the document changes. A press on either keeps the
 * editor's caret, and a block's chevron follows the blocks moved under it. The
 * grip's menu is `PageBlockMenu.test.tsx`'s, its drag `page-drag.test.ts`'s
 * and Playwright's (`e2e/page-mode-gutter.spec.ts`), which also has where it
 * sits.
 */

import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import {
  BlockGutterControls,
  GUTTER_BUTTON_BASE,
  GUTTER_BUTTON_LOOK,
} from '@/components/editor/BlockGutterControls'
import { BlockCollapseControl } from '@/components/editor/BlockInlineControls'
import { blockId, caret, press, type Row } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { blockEl, mountNodeViews } from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { GRIP_MENU, type GripMenuDetail } from '@/editor/page-mode/page-gutter'
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

/** The one grip drawn anywhere in `container`. */
function grip(container: HTMLElement): HTMLElement {
  const found = container.querySelectorAll('[data-page-grip]')
  expect(found).toHaveLength(1)
  return found[0] as HTMLElement
}

/** The grip's frame, which is what shows, hides and is placed. */
const frame = (container: HTMLElement): HTMLElement =>
  grip(container).closest('.page-grip') as HTMLElement

function chevron(container: HTMLElement, id: string): HTMLElement | null {
  return blockEl(container, id).querySelector(
    ':scope > .page-block-gutter > [data-testid="collapse-toggle"]',
  )
}

/** Block `id`'s text. */
const textOf = (container: HTMLElement, id: string): Element =>
  blockEl(container, id).querySelector('.page-block-content p') as Element

/** The pointer over `el`, once the grip has had its frame to follow it. */
async function point(el: Element): Promise<void> {
  fireEvent.pointerMove(el)
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
}

/** Block `id` drawn `top` pixels down, as jsdom lays nothing out. */
function placeAt(container: HTMLElement, id: string, top: number): void {
  vi.spyOn(blockEl(container, id), 'getBoundingClientRect').mockReturnValue(
    new DOMRect(40, top, 600, 32),
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

describe('the chevron', () => {
  it('is drawn on a block with blocks under it, first, outside its text, and no gutter on the others, with no a11y violations', async () => {
    const { container } = mount(TREE)

    const gutter = blockEl(container, A).querySelector(':scope > .page-block-gutter')
    expect((gutter as HTMLElement).contentEditable).toBe('false')
    expect(blockEl(container, A).firstElementChild).toBe(gutter)
    const fold = chevron(container, A)
    expect(fold).toHaveAttribute('aria-expanded', 'true')
    expect(fold).toHaveAttribute('aria-label', t('block.collapseChildren'))
    expect(fold).toHaveAttribute('aria-keyshortcuts', t('block.collapseKeyshortcuts'))
    expect(fold).toHaveAttribute('title', t('block.collapseTip'))
    expect(blockEl(container, A).querySelector('.page-block-content')?.contains(fold)).toBe(false)
    for (const id of [B, C]) {
      expect(blockEl(container, id).querySelector('.page-block-gutter')).toBeNull()
    }
    expect(await axe(container)).toHaveNoViolations()
  })

  it('collapses the block, hiding the blocks under it, says so with a solid caret, and expands it again', async () => {
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

  it('draws block mode’s chevron, its classes and glyph, expanded and collapsed', () => {
    const { container } = mount(TREE)

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

  it('a block gains its chevron as a block moves under it, and loses its gutter as that block moves out', () => {
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
    expect(blockEl(container, A).querySelector('.page-block-gutter')).toBeNull()
  })
})

describe('the grip', () => {
  it('is one for the editor, outside its root, however many blocks the page has, named as block mode’s and no tab stop, with no a11y violations', async () => {
    const rows: Row[] = Array.from({ length: 40 }, (_, i) => [blockId(i + 1), 0, `block ${i}`])
    const { container, editor } = mount(rows)

    await point(textOf(container, blockId(1)))
    await point(textOf(container, blockId(40)))

    const handle = grip(container)
    expect(editor.view.dom.contains(handle)).toBe(false)
    expect(handle).toHaveAttribute('data-testid', 'drag-handle')
    expect(handle).toHaveAttribute('aria-label', t('block.reorder'))
    expect(handle).toHaveAttribute('aria-haspopup', 'menu')
    expect(handle).toHaveAttribute('title', t('pageMode.gripTip'))
    expect(handle).toHaveAttribute('tabindex', '-1')
    expect(frame(container)).toHaveAttribute('data-editor-portal')
    expect(frame(container)).toBeVisible()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('goes to the block under the pointer, beside its chevron if it has one, and acts on that block', async () => {
    const { container, editor } = mount(TREE)
    const menus: string[] = []
    editor.view.dom.addEventListener(GRIP_MENU, (event) => {
      menus.push((event as CustomEvent<GripMenuDetail>).detail.blockId)
    })
    placeAt(container, A, 0)
    placeAt(container, C, 64)

    await point(textOf(container, C))
    expect(frame(container).style.top).toBe('64px')
    expect(frame(container)).not.toHaveAttribute('data-chevron')
    fireEvent.click(grip(container))

    await point(textOf(container, A))
    expect(frame(container).style.top).toBe('0px')
    expect(frame(container)).toHaveAttribute('data-chevron')
    fireEvent.click(grip(container))

    expect(menus).toEqual([C, A])
  })

  it('stays as the pointer moves from the editor onto it and back, and hides as the pointer leaves both', async () => {
    const { container, editor } = mount(TREE)
    await point(textOf(container, A))

    fireEvent.pointerLeave(editor.view.dom, { relatedTarget: grip(container) })
    fireEvent.pointerLeave(frame(container), { relatedTarget: editor.view.dom })
    expect(frame(container)).toBeVisible()

    fireEvent.pointerLeave(frame(container), { relatedTarget: document.body })
    expect(frame(container)).not.toBeVisible()

    await point(textOf(container, A))
    fireEvent.pointerLeave(editor.view.dom, { relatedTarget: document.body })
    expect(frame(container)).not.toBeVisible()
  })

  it('hides as the document changes, which can move its block, until the pointer moves again', async () => {
    const { container, editor } = mount(TREE)
    await point(textOf(container, C))

    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('z', 3))
    })
    expect(frame(container)).not.toBeVisible()

    await point(textOf(container, C))
    expect(frame(container)).toBeVisible()
  })

  it('hides as a block is collapsed or expanded, which moves the blocks after it', async () => {
    const { container } = mount(TREE)
    await point(textOf(container, C))

    act(() => {
      fireEvent.click(chevron(container, A) as HTMLElement)
    })

    expect(frame(container)).not.toBeVisible()
  })

  it('draws block mode’s grip: its glyph, and its classes but the ones that reveal it with its row', async () => {
    const { container } = mount(TREE)
    await point(textOf(container, A))
    const blockGrip = render(<BlockGutterControls blockId={A} />).container.querySelector(
      '[data-testid="drag-handle"]',
    )
    const reveal = GUTTER_BUTTON_BASE.split(' ').filter(
      (name) => !GUTTER_BUTTON_LOOK.split(' ').includes(name),
    )

    const pageGrip = grip(container)
    expect(reveal).toContain('opacity-0')
    expect(classes(pageGrip)).toEqual(classes(blockGrip).filter((name) => !reveal.includes(name)))
    expect(pageGrip.getAttribute('type')).toBe(blockGrip?.getAttribute('type'))
    expect(drawing(pageGrip.querySelector('svg'))).toEqual(drawing(blockGrip?.querySelector('svg')))
  })

  it('a press on the grip or a chevron keeps the editor’s focus and caret', async () => {
    const { container } = mount(TREE)
    await point(textOf(container, A))

    expect(fireEvent.mouseDown(grip(container))).toBe(false)
    expect(fireEvent.mouseDown(chevron(container, A) as HTMLElement)).toBe(false)
  })
})
