/**
 * The controls gate on a long page (#5691): its observer watches only the
 * waiting blocks within two screens of the viewport, picked again on a scroll
 * or a resize, so the work a frame does for it stays with the screen, not the
 * page's length. jsdom lays nothing out: here each block's box is its place
 * among the blocks shown, `HEIGHT` apart, and the scroller is `SCREEN` tall.
 *
 * Equivalent mutant, accepted: `this.frame = 0` on the editor's destroy
 * dropped. With the scroll listener and the resize observer gone nothing asks
 * for a frame again; the reset is what lets a test see either left behind.
 */

import { act, fireEvent, render } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { EditorContent } from '@tiptap/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MockIntersectionObserver,
  stubAnimationFrames,
} from '@/__tests__/helpers/viewport-observer-mocks'
import {
  blockId,
  idMinter,
  openPage,
  PAGE,
  type Row,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import {
  blockEl,
  FakeTasks,
  findIn,
  listSource,
  mountNodeViews,
} from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { HIDDEN_CLASS } from '@/editor/page-mode/page-collapse'
import { PageLists } from '@/editor/page-mode/page-lists'
import { createPageBlockStore, PageBlockContext } from '@/stores/page-blocks'

const HEIGHT = 40
const SCREEN = 400
const MARKER = '[data-testid="task-marker"]'

/** How far the page is scrolled: every block's box moves up by it. */
let scrollTop = 0

function box(top: number, height: number): DOMRect {
  return DOMRect.fromRect({ x: 0, y: top, width: 600, height })
}

function laidOut(this: Element): DOMRect {
  if (this.getAttribute('data-testid') === 'scroller') return box(0, SCREEN)
  if (!this.hasAttribute('data-page-block') || this.classList.contains(HIDDEN_CLASS)) {
    return box(0, 0)
  }
  let shown = 0
  for (let el = this.previousElementSibling; el !== null; el = el.previousElementSibling) {
    if (!el.classList.contains(HIDDEN_CLASS)) shown += 1
  }
  return box(shown * HEIGHT - scrollTop, HEIGHT)
}

/** A `ResizeObserver` whose callback fires when a test says an element it watches resized. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observed = new Set<Element>()
  readonly callback: () => void

  constructor(callback: () => void) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }

  observe(el: Element): void {
    this.observed.add(el)
  }

  unobserve(el: Element): void {
    this.observed.delete(el)
  }

  disconnect(): void {
    this.observed.clear()
  }
}

function resize(el: Element): void {
  act(() => {
    for (const resized of FakeResizeObserver.instances) {
      if (resized.observed.has(el)) resized.callback()
    }
  })
}

const rowsOf = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => [blockId(i), 0, `block ${i}`])

/** The ids of the blocks `from` to `to`, both included. */
const idsFrom = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => blockId(from + i))

let frames: ReturnType<typeof stubAnimationFrames>
let teardown: (() => void) | null = null

beforeEach(() => {
  scrollTop = 0
  MockIntersectionObserver.instances = []
  FakeResizeObserver.instances = []
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  frames = stubAnimationFrames()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(laidOut)
})

afterEach(() => {
  teardown?.()
  teardown = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function observer(): MockIntersectionObserver {
  expect(MockIntersectionObserver.instances).toHaveLength(1)
  return MockIntersectionObserver.instances[0] as MockIntersectionObserver
}

/** The ids the observer watches, in the page's order. */
function watched(): string[] {
  return [...observer().observed]
    .map((el) => el.getAttribute('data-page-block-id') as string)
    .toSorted()
}

function runFrame(): void {
  act(() => frames.runFrame())
}

function mount(count: number, tasks = new FakeTasks()) {
  const mounted = mountNodeViews(rowsOf(count), tasks)
  teardown = () => {
    mounted.unmount()
    mounted.editor.destroy()
  }
  runFrame()
  return mounted
}

function scrollTo(scroller: Element | Window, top: number): void {
  scrollTop = top
  fireEvent.scroll(scroller)
  runFrame()
}

describe('the controls gate on a long page', () => {
  it('watches the waiting blocks within two screens of the viewport, however long the page', () => {
    // From two screens above the scroller's top to two below its bottom: 0px to 1200px. The
    // caret's block, the first, shows its controls at once.
    mount(300)
    expect(watched()).toEqual(idsFrom(1, 30))
    teardown?.()
    MockIntersectionObserver.instances = []

    mount(600)
    expect(watched()).toEqual(idsFrom(1, 30))
  })

  it('watches the blocks near where the page scrolls to, and mounts a block’s controls once near', async () => {
    const tasks = new FakeTasks()
    tasks.setBlock(blockId(200), { todo_state: 'TODO' })
    const { container, getByTestId } = mount(300, tasks)

    scrollTo(getByTestId('scroller'), 200 * HEIGHT)
    expect(watched()).toEqual(idsFrom(179, 230))

    const block = blockEl(container, blockId(200))
    act(() => observer().trigger([{ target: block, isIntersecting: true }]))
    expect(await findIn(block, MARKER)).toBeInstanceOf(HTMLElement)
    expect(watched()).toEqual(idsFrom(179, 230).filter((id) => id !== blockId(200)))
  })

  it('watches no block a collapsed block hides, before the viewport or among its blocks', () => {
    const { container, getByTestId } = mount(500)
    for (let i = 100; i < 400; i += 1) blockEl(container, blockId(i)).classList.add(HIDDEN_CLASS)

    // 150 blocks shown above the viewport: the 50 after the hidden ones.
    scrollTo(getByTestId('scroller'), 150 * HEIGHT)
    expect(watched()).toEqual(idsFrom(429, 480))

    // The viewport just past the hidden ones: the last shown before them, and the first after.
    scrollTo(getByTestId('scroller'), 100 * HEIGHT)
    expect(watched()).toEqual([...idsFrom(79, 99), ...idsFrom(400, 430)])
  })

  it('picks again when the blocks or the scroller change size, with no scroll', () => {
    const { editor, getByTestId } = mount(300)

    // As a collapse above the viewport takes 100 blocks' height out.
    scrollTop = 100 * HEIGHT
    resize(editor.view.dom)
    runFrame()
    expect(watched()).toEqual(idsFrom(79, 130))

    scrollTop = 200 * HEIGHT
    resize(getByTestId('scroller'))
    runFrame()
    expect(watched()).toEqual(idsFrom(179, 230))
  })

  it('once the editor is gone, neither a scroll nor a resize asks for a frame', () => {
    const { editor, getByTestId, unmount } = mount(300)
    const scroller = getByTestId('scroller')
    const dom = editor.view.dom
    fireEvent.scroll(scroller)
    expect(frames.pending()).toBe(1)

    unmount()
    editor.destroy()
    teardown = null
    expect(frames.pending()).toBe(0)

    fireEvent.scroll(scroller)
    resize(dom)
    resize(scroller)
    expect(frames.pending()).toBe(0)
  })

  it('on a page the window scrolls, measures from the viewport', () => {
    const editor: Editor = openPage(
      rowsOf(300),
      idMinter(),
      undefined,
      listSource(new PageLists({}, [])),
      new FakeTasks(),
    )
    const store = createPageBlockStore(PAGE)
    const view = render(
      <PageBlockContext.Provider value={store}>
        <EditorContent editor={editor} />
      </PageBlockContext.Provider>,
    )
    teardown = () => {
      view.unmount()
      editor.destroy()
    }
    runFrame()
    // jsdom's viewport is 768px tall: from 1536px above its top to 1536px below its bottom.
    expect(window.innerHeight).toBe(768)
    expect(watched()).toEqual(idsFrom(1, 57))

    scrollTo(window, 100 * HEIGHT)
    expect(watched()).toEqual(idsFrom(61, 157))

    scrollTop = 0
    resize(document.documentElement)
    runFrame()
    expect(watched()).toEqual(idsFrom(1, 57))
  })
})
