/**
 * #6562: a click on a block's static render is read as a point in the block's
 * text and mapped into the editor's document after the mount. Each case
 * renders the content the way `StaticBlock` does, takes a DOM point in that
 * render, and inserts a marker where the mapped position is, so the expected
 * Markdown shows where the caret would be.
 */

// axe-exempt: the static render is only a mapping's input; StaticBlock's and RichContentRenderer's tests audit it.

import { render } from '@testing-library/react'
import { Editor, type JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderRichContent } from '@/components/RichContentRenderer'
import { TooltipProvider } from '@/components/ui/tooltip'
import { posAtTextPoint, type TextPoint, textPointAt, textPointAtLine } from '@/editor/click-caret'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { contentExtensions } from '@/editor/use-roving-editor'

const TAG = '01CRZ3NDEKTSV4RRFFQ69G5FAV'
const TABLE = '| A | B |\n| --- | --- |\n| one | two |'

let editor: Editor | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
})

function staticRender(content: string): HTMLElement {
  const { container } = render(
    <TooltipProvider>
      {renderRichContent(content, {
        interactive: true,
        resolveTagName: () => 'work',
        resolveBlockTitle: () => 'Docs',
      })}
    </TooltipProvider>,
  )
  return container
}

/** The DOM point `offset` characters into the first text node holding `text` in full. */
function inText(root: Node, text: string, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.textContent === text) return { node, offset }
  }
  throw new Error(`no text node is ${JSON.stringify(text)}`)
}

/** An editor with the roving editor's content schema, holding `content`. */
function editorWith(content: string): Editor {
  const groups = contentExtensions({
    resolveTagName: () => 'work',
    resolveBlockTitle: () => 'Docs',
    resolveBlockStatus: () => 'active',
    resolveTagStatus: () => 'active',
    onNavigate: () => {},
    onTagClick: () => {},
    searchTags: () => [],
    onCreateTag: (name) => Promise.resolve(name),
    searchPages: () => [],
    onCreatePage: (label) => Promise.resolve(label),
    searchBlockRefs: () => [],
    listInputRules: true,
  })
  return new Editor({
    element: document.createElement('div'),
    extensions: [Document, ...Object.values(groups).flat()],
    content: parse(content) as unknown as JSONContent,
  })
}

/** `content` with `Q` inserted where `point` maps in the editor's document. */
function markAt(content: string, point: TextPoint | null): string {
  editor = editorWith(content)
  expect(point).not.toBeNull()
  const pos = posAtTextPoint(editor.state.doc, point as TextPoint)
  expect(pos).not.toBeNull()
  editor.view.dispatch(editor.state.tr.insertText('Q', pos as number))
  return serialize(editor.getJSON() as unknown as DocNode)
}

function clickIn(content: string, text: string, offset: number): string {
  const root = staticRender(content)
  return markAt(content, textPointAt(root, content, inText(root, text, offset)))
}

describe('a click on the static render maps into the editor document (#6562)', () => {
  it('inside a bold run and an italic one', () => {
    const content = 'plain **bold** and *it*'
    expect(clickIn(content, 'bold', 2)).toBe('plain **boQld** and *it*')
    expect(clickIn(content, 'it', 1)).toBe('plain **bold** and *iQt*')
  })

  it('on either side of a chip, and on its label', () => {
    const content = `say #[${TAG}] then`
    expect(clickIn(content, ' then', 0)).toBe(`say #[${TAG}]Q then`)
    expect(clickIn(content, 'say ', 4)).toBe(`say Q#[${TAG}] then`)
    expect(clickIn(content, ' then', 3)).toBe(`say #[${TAG}] thQen`)
    expect(clickIn(content, 'work', 2)).toBe(`say #[${TAG}]Q then`)
    expect(clickIn(content, 'work', 0)).toBe(`say Q#[${TAG}] then`)
  })

  it('right of a chip that ends the block', () => {
    const content = `see #[${TAG}]`
    expect(clickIn(content, 'work', 4)).toBe(`see #[${TAG}]Q`)
  })

  it('in the second of two paragraphs, and on the space the render puts between them', () => {
    const content = 'first para\n\nsecond para'
    expect(clickIn(content, 'second para', 0)).toBe('first para\n\nQsecond para')
    expect(clickIn(content, 'second para', 3)).toBe('first para\n\nsecQond para')
    expect(clickIn(content, ' ', 0)).toBe('first paraQ\n\nsecond para')
    expect(clickIn(content, ' ', 1)).toBe('first para\n\nQsecond para')
  })

  it('after a link, and in a later paragraph that opens with a chip', () => {
    expect(clickIn('see [docs](https://x.y) now', ' now', 2)).toBe('see [docs](https://x.y) nQow')
    const content = `intro\n\n#[${TAG}] some text`
    expect(clickIn(content, ' some text', 3)).toBe(`intro\n\n#[${TAG}] soQme text`)
  })

  it('at the start of a table cell and the end of the one before it', () => {
    expect(clickIn(TABLE, 'two', 0)).toBe('| A | B |\n| --- | --- |\n| one | Qtwo |')
    expect(clickIn(TABLE, 'one', 3)).toBe('| A | B |\n| --- | --- |\n| oneQ | two |')
    expect(clickIn(TABLE, 'B', 1)).toBe('| A | BQ |\n| --- | --- |\n| one | two |')
  })

  it('in a code block whose highlighting splits its text over several nodes', () => {
    const content = '```js\nconst x = 1\n```'
    const root = document.createElement('pre')
    root.innerHTML = '<code><span class="hljs-keyword">const</span> x = 1</code>'
    expect(markAt(content, textPointAt(root, content, inText(root, ' x = 1', 3)))).toBe(
      '```js\nconst x Q= 1\n```',
    )
  })

  it('after a diagram, whose render shows none of its source', () => {
    const content = 'first\n\n```mermaid\ngraph A\n```\n\nlast'
    const root = document.createElement('div')
    root.innerHTML =
      '<span>first</span><span> </span><div><span>A</span></div><span> </span><span>last</span>'
    expect(markAt(content, textPointAt(root, content, inText(root, 'last', 1)))).toBe(
      serialize(parse(content.replace('last', 'lQast'))),
    )
  })

  it('before all the text at its start, and past it at its end', () => {
    const content = 'plain **bold**'
    const root = staticRender(content)
    expect(textPointAt(root, content, { node: root, offset: 0 })).toEqual({
      textOffset: 0,
      bias: 'after',
    })
    expect(textPointAt(root, content, { node: root, offset: root.childNodes.length })).toEqual({
      textOffset: 10,
      bias: 'after',
    })
  })

  it('reads no point from a render that shows none of the text', () => {
    const root = document.createElement('div')
    root.textContent = 'something else'
    expect(textPointAt(root, 'plain text', { node: root.firstChild as Node, offset: 2 })).toBeNull()
  })

  it('clamps a point past the end of the text to the end of the last textblock', () => {
    editor = editorWith(`hello\n\nbye #[${TAG}]`)
    const end = editor.state.doc.content.size - 1
    expect(posAtTextPoint(editor.state.doc, { textOffset: 99, bias: 'before' })).toBe(end)
    expect(posAtTextPoint(editor.state.doc, { textOffset: 9, bias: 'after' })).toBe(end)
    expect(posAtTextPoint(editor.state.doc, { textOffset: 9, bias: 'before' })).toBe(end - 1)
  })
})

describe('Arrow Up / Down read their landing on a line of the static render (#6537)', () => {
  /** jsdom lays nothing out: two lines of text, a box from x 100 to 300, and the probed points. */
  function laidOut(root: HTMLElement): { x: number; y: number }[] {
    const probed: { x: number; y: number }[] = []
    const text = root.firstChild as Text
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 200, 20))
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [new DOMRect(100, 0, 200, 10), new DOMRect(100, 10, 50, 10)],
    })
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: (x: number, y: number) => {
        probed.push({ x, y })
        return { offsetNode: text, offset: 3 }
      },
    })
    return probed
  }

  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(Range.prototype, 'getClientRects')
    Reflect.deleteProperty(document, 'caretPositionFromPoint')
  })

  it('probes the middle of the first or last line, with x held inside the render', () => {
    const root = document.createElement('div')
    root.textContent = 'plain text'
    document.body.append(root)
    const probed = laidOut(root)

    expect(textPointAtLine(root, 'plain text', 40, 'first')).toEqual({
      textOffset: 3,
      bias: 'before',
    })
    expect(textPointAtLine(root, 'plain text', 180, 'last')).toEqual({
      textOffset: 3,
      bias: 'before',
    })
    expect(probed).toEqual([
      { x: 101, y: 5 },
      { x: 180, y: 15 },
    ])
    root.remove()
  })

  it('reads no point from a render with no text', () => {
    const root = document.createElement('div')
    root.append(document.createElement('span'))
    expect(textPointAtLine(root, '', 40, 'first')).toBeNull()
  })
})
