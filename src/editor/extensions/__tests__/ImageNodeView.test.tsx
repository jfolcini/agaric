/**
 * Tests for the editor's inline-image node view (#1434, #4711, #4712).
 *
 * The node view draws the image for the ONE block the roving editor is mounted
 * on (invariant 4), so it is one of the two surfaces the #4711 collapse toggle
 * has to reach — the static renderer is the other
 * (`RichContentRenderer/marks/__tests__/image.test.tsx`). The toggle's own
 * behaviour and persistence live in `CollapsibleImage.test.tsx`; this file pins
 * the wiring: attrs through to the image, and a working toggle in the node view.
 *
 * It is also the only surface with the #4712 resize handle: each gesture must
 * write the width into the alt as `text|N` exactly once, and the handle must
 * keep its keys and touches from the block's own keyboard and swipe handlers.
 *
 * `@tiptap/react`'s NodeViewWrapper is stubbed to plain DOM — TipTap does not
 * render in the test environment (see components AGENTS.md).
 */

import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Editor } from '@tiptap/core'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { type BlockKeyboardCallbacks, useBlockKeyboard } from '@/editor/use-block-keyboard'
import { EDITOR_PORTAL_SELECTOR } from '@/hooks/useEditorBlur'
import { t } from '@/lib/i18n'

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, ...rest }: { children?: React.ReactNode }) => (
    <span {...rest}>{children}</span>
  ),
}))

const { ImageNodeView } = await import('@/editor/extensions/ImageNodeView')

/** Minimal NodeViewProps stand-in carrying an image node's attrs. */
function makeProps(
  alt: string,
  src: string,
  updateAttributes: (attrs: Record<string, unknown>) => void = vi.fn(),
): React.ComponentProps<typeof ImageNodeView> {
  return { node: { attrs: { alt, src } }, updateAttributes } as unknown as React.ComponentProps<
    typeof ImageNodeView
  >
}

/** How wide the editor lays out whenever a test lays the image out. */
const EDITOR_WIDTH = 700

/**
 * Lays the image out `px` wide in an editor `EDITOR_WIDTH` wide. happy-dom has
 * no layout, and the handle reads both widths through a ResizeObserver, so the
 * stub reports on `observe`.
 */
function layOutImageAt(px: number): void {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(px)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(EDITOR_WIDTH)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe(): void {
        this.callback([], this as unknown as ResizeObserver)
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  )
}

/** The editor's contenteditable root, whose width the handle reads as its maximum. */
function editorRoot(): HTMLElement {
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  return root
}

function renderNodeView(alt: string) {
  const updateAttributes = vi.fn()
  const container = editorRoot()
  document.body.append(container)
  const view = render(<ImageNodeView {...makeProps(alt, '/c.png', updateAttributes)} />, {
    container,
  })
  const handle = () =>
    screen.getByRole('slider', { name: t('editor.image.resize', { name: 'a cat' }) })
  return { ...view, updateAttributes, handle }
}

/**
 * Mounts the node view the way TipTap does: through a React portal into a DOM
 * node inside the editor. React dispatches a portal's events from that node,
 * BELOW the editor's own DOM, so listeners there (the block keyboard handler's
 * capture listener, ProseMirror's mousedown) see an event before any React
 * capture handler in the view would. An inline render hides that ordering.
 */
function renderInEditor(alt: string, wrap = (view: React.ReactNode): React.ReactNode => view) {
  const editorDom = document.createElement('div')
  const root = editorRoot()
  const nodeViewDom = document.createElement('span')
  root.append(nodeViewDom)
  editorDom.append(root)
  document.body.append(editorDom)
  onTestFinished(() => editorDom.remove())
  const updateAttributes = vi.fn()
  render(
    <>
      {wrap(
        createPortal(
          <ImageNodeView {...makeProps(alt, '/c.png', updateAttributes)} />,
          nodeViewDom,
        ),
      )}
    </>,
  )
  return { editorDom, updateAttributes, handle: screen.getByRole('slider') }
}

function imgWidth(): string {
  return (screen.getByTestId('image-rendered') as HTMLImageElement).style.width
}

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ImageNodeView (#1434, #4711)', () => {
  it('renders the image with the src and alt from the node attrs', () => {
    render(<ImageNodeView {...makeProps('a cat', '/c.png')} />)
    const img = screen.getByTestId('image-rendered')
    expect(img.getAttribute('src')).toBe('/c.png')
    expect(img.getAttribute('alt')).toBe('a cat')
  })

  it('collapses the image from inside the node view', async () => {
    const user = userEvent.setup()
    render(<ImageNodeView {...makeProps('a cat', '/c.png')} />)

    await user.click(screen.getByTestId('image-collapse-toggle'))

    expect(screen.queryByTestId('image-rendered')).toBeNull()
    expect(screen.getByTestId('image-collapsed-label').textContent).toBe('a cat')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<ImageNodeView {...makeProps('a cat', '/c.png')} />)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})

describe('ImageNodeView resize (#4712)', () => {
  it('draws the image at the alt’s `|width` and shows the alt without it', () => {
    render(<ImageNodeView {...makeProps('a cat|300', '/c.png')} />)
    const img = screen.getByTestId('image-rendered')
    expect(img.getAttribute('alt')).toBe('a cat')
    expect(imgWidth()).toBe('300px')
    expect(screen.getByRole('slider').getAttribute('aria-label')).toBe(
      t('editor.image.resize', { name: 'a cat' }),
    )
  })

  it('reports the laid-out width as the slider value, within the editor’s width', () => {
    layOutImageAt(612)
    const { handle } = renderNodeView('a cat')
    expect(handle().getAttribute('aria-valuenow')).toBe('612')
    expect(handle().getAttribute('aria-valuemin')).toBe('32')
    expect(handle().getAttribute('aria-valuemax')).toBe(String(EDITOR_WIDTH))
  })

  it('widens and narrows by 10px on the arrow keys, 50px with Shift', async () => {
    layOutImageAt(300)
    const user = userEvent.setup()
    const { handle, updateAttributes } = renderNodeView('a cat|300')
    handle().focus()

    await user.keyboard('{ArrowRight}')
    await user.keyboard('{ArrowLeft}')
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')

    expect(updateAttributes.mock.calls).toEqual([
      [{ alt: 'a cat|310' }],
      [{ alt: 'a cat|290' }],
      [{ alt: 'a cat|350' }],
      [{ alt: 'a cat|250' }],
    ])
  })

  it('resizes a natural-size image from the width it is shown at', async () => {
    layOutImageAt(612)
    const user = userEvent.setup()
    const { handle, updateAttributes } = renderNodeView('a cat')
    handle().focus()

    await user.keyboard('{ArrowUp}')

    expect(updateAttributes).toHaveBeenCalledExactlyOnceWith({ alt: 'a cat|622' })
  })

  it('never narrows below the minimum width', async () => {
    layOutImageAt(36)
    const user = userEvent.setup()
    const { handle, updateAttributes } = renderNodeView('a cat|36')
    handle().focus()

    await user.keyboard('{ArrowDown}')

    expect(updateAttributes).toHaveBeenCalledExactlyOnceWith({ alt: 'a cat|32' })
  })

  it('the stored width is what the image renders at after the commit', async () => {
    layOutImageAt(300)
    const user = userEvent.setup()
    const { handle, updateAttributes, rerender } = renderNodeView('a cat|300')
    handle().focus()
    await user.keyboard('{ArrowRight}')

    const [{ alt }] = updateAttributes.mock.calls[0] as [{ alt: string }]
    rerender(<ImageNodeView {...makeProps(alt, '/c.png')} />)

    expect(imgWidth()).toBe('310px')
    expect(screen.getByTestId('image-rendered').getAttribute('alt')).toBe('a cat')
  })

  it('Home and a double-click return the image to its natural size', async () => {
    const user = userEvent.setup()
    const { handle, updateAttributes } = renderNodeView('a cat|300')

    handle().focus()
    await user.keyboard('{Home}')
    await user.dblClick(handle())

    expect(updateAttributes.mock.calls).toEqual([[{ alt: 'a cat' }], [{ alt: 'a cat' }]])
  })

  it('keeps an Obsidian height-bearing alt’s text when resetting it', async () => {
    const user = userEvent.setup()
    const { handle, updateAttributes } = renderNodeView('a cat|300x200')
    handle().focus()

    await user.keyboard('{Home}')

    expect(updateAttributes).toHaveBeenCalledExactlyOnceWith({ alt: 'a cat' })
  })

  it('writes nothing when a reset leaves the alt as it was', async () => {
    const user = userEvent.setup()
    const { handle, updateAttributes } = renderNodeView('a cat')
    handle().focus()

    await user.keyboard('{Home}')

    expect(updateAttributes).not.toHaveBeenCalled()
  })

  it('previews a drag live and commits it once, on release', () => {
    layOutImageAt(300)
    const { handle, updateAttributes } = renderNodeView('a cat|300')

    fireEvent.pointerDown(handle(), { clientX: 100, pointerId: 1 })
    expect(handle().hasPointerCapture(1)).toBe(true)
    fireEvent.pointerMove(handle(), { clientX: 120, pointerId: 1 })
    fireEvent.pointerMove(handle(), { clientX: 150, pointerId: 1 })

    expect(imgWidth()).toBe('350px')
    expect(updateAttributes).not.toHaveBeenCalled()

    fireEvent.pointerUp(handle(), { clientX: 160, pointerId: 1 })

    expect(updateAttributes).toHaveBeenCalledExactlyOnceWith({ alt: 'a cat|360' })
    // The preview is dropped; the committed alt drives the width from here.
    expect(imgWidth()).toBe('300px')
  })

  it('commits nothing for a press that does not move, or a cancelled drag', () => {
    layOutImageAt(300)
    const { handle, updateAttributes } = renderNodeView('a cat')

    fireEvent.pointerDown(handle(), { clientX: 100, pointerId: 1 })
    fireEvent.pointerUp(handle(), { clientX: 100, pointerId: 1 })

    fireEvent.pointerDown(handle(), { clientX: 100, pointerId: 2 })
    fireEvent.pointerMove(handle(), { clientX: 180, pointerId: 2 })
    expect(imgWidth()).toBe('380px')
    fireEvent.pointerCancel(handle(), { pointerId: 2 })

    expect(updateAttributes).not.toHaveBeenCalled()
    expect(imgWidth()).toBe('')
  })

  it('cancels the press, so its mousedown neither blurs the editor nor drags the image', () => {
    const { handle } = renderNodeView('a cat')
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.pointerDown(handle(), { clientX: 0, pointerId: 1 })).toBe(false)
  })

  it('keeps the editor mounted when focus moves onto any of its controls', () => {
    // `useEditorBlur` ignores a blur whose new focus target sits under this
    // selector; without it, Tab onto the collapse toggle or the handle unmounts
    // the node view and drops focus to the page.
    render(<ImageNodeView {...makeProps('a cat', '/c.png')} />)
    expect(screen.getByTestId('image-node-view').matches(EDITOR_PORTAL_SELECTOR)).toBe(true)
  })

  it('keeps every key but Escape from the block keyboard handler and the page', async () => {
    layOutImageAt(300)
    const user = userEvent.setup()
    const { editorDom, updateAttributes, handle } = renderInEditor('a cat|300')
    // The real block keyboard handler, with the caret at both ends of a
    // non-empty block, where ArrowLeft, ArrowRight, Backspace and Enter all
    // act on the block.
    const blockActions = vi.fn()
    const callbacks = Object.fromEntries(
      [
        'onFocusPrev',
        'onFocusNext',
        'onDeleteBlock',
        'onIndent',
        'onDedent',
        'onFlush',
        'onMergeWithPrev',
        'onEnterSave',
        'onEscapeSave',
      ].map((name) => [name, () => blockActions(name)]),
    ) as unknown as BlockKeyboardCallbacks
    const editor = {
      view: { dom: editorDom.firstElementChild },
      state: { selection: { from: 1, to: 1, empty: true }, doc: { content: { size: 2 } } },
      isEmpty: false,
      isDestroyed: false,
      on: () => {},
      off: () => {},
    } as unknown as Editor
    renderHook(() => useBlockKeyboard(editor, callbacks))
    // The page's own shortcuts listen on the document.
    const pageShortcuts = vi.fn()
    document.addEventListener('keydown', pageShortcuts)
    onTestFinished(() => document.removeEventListener('keydown', pageShortcuts))
    handle.focus()

    await user.keyboard('{ArrowLeft}{ArrowRight}{Home}{Backspace}{Delete}{Enter}')
    expect(blockActions).not.toHaveBeenCalled()
    expect(pageShortcuts).not.toHaveBeenCalled()
    expect(updateAttributes.mock.calls).toEqual([
      [{ alt: 'a cat|290' }],
      [{ alt: 'a cat|310' }],
      [{ alt: 'a cat' }],
    ])

    await user.keyboard('{Escape}')
    expect(blockActions.mock.calls).toEqual([['onEscapeSave']])
  })

  it('claims the keys it acts on, so the page does not scroll, but leaves Tab to move focus', () => {
    const { handle } = renderInEditor('a cat|300')
    // fireEvent returns false when a listener called preventDefault.
    expect(fireEvent.keyDown(handle, { key: 'ArrowRight' })).toBe(false)
    expect(fireEvent.keyDown(handle, { key: 'Home' })).toBe(false)
    expect(fireEvent.keyDown(handle, { key: 'Tab' })).toBe(true)
  })

  it('keeps a touch on the handle from the block row’s swipe gestures', () => {
    const rowTouch = vi.fn()
    const { handle } = renderInEditor('a cat', (view) => (
      <div onTouchStart={rowTouch} onTouchMove={rowTouch} onTouchEnd={rowTouch}>
        {view}
      </div>
    ))

    fireEvent.touchStart(handle, { touches: [{ clientX: 100, clientY: 0 }] })
    fireEvent.touchMove(handle, { touches: [{ clientX: 20, clientY: 0 }] })
    fireEvent.touchEnd(handle)

    expect(rowTouch).not.toHaveBeenCalled()
  })

  it('hides the handle while the image is collapsed', async () => {
    const user = userEvent.setup()
    render(<ImageNodeView {...makeProps('a cat', '/c.png')} />)
    expect(screen.getByRole('slider')).toBeInTheDocument()

    await user.click(screen.getByTestId('image-collapse-toggle'))

    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('puts no handle on a withheld external image', () => {
    render(<ImageNodeView {...makeProps('a cat', 'https://images.example.com/cat.png')} />)
    expect(screen.getByTestId('image-external-blocked')).toBeInTheDocument()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('has no a11y violations with a sized image and its handle', async () => {
    layOutImageAt(300)
    const { container } = render(<ImageNodeView {...makeProps('a cat|300', '/c.png')} />)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
