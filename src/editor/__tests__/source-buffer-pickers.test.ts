/**
 * The *Edit as Markdown* buffer's pickers (#5160 phase 5): the text a choice
 * is written as, and where the `#` and `[[` pickers open. A real TipTap editor
 * with the buffer's extensions and the pickers; an open picker shows as the
 * Suggestion plugin's `.suggestion` decoration over what it matched.
 */

import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'

import { linesContent, SOURCE_BUFFER_EXTENSIONS } from '@/editor/source-buffer'
import { pageLinkText, SourceBufferPickers, tagText } from '@/editor/source-buffer-pickers'

const A = '01J0000000000000000000000A'
const B = '01J0000000000000000000000B'

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function build(rows: Array<[string, string | null]>): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [...SOURCE_BUFFER_EXTENSIONS, SourceBufferPickers],
    content: linesContent({
      text: rows.map(([text]) => text).join('\n'),
      lineIds: rows.map(([, id]) => id),
    }),
  })
  return editor
}

/** Type `text` at the end of line `index` (from 0); what an open picker matched, or null. */
function typeAtEnd(ed: Editor, index: number, text: string): string | null {
  let pos = 1
  for (let i = 0; i < index; i += 1) pos += ed.state.doc.child(i).nodeSize
  pos += ed.state.doc.child(index).content.size
  const tr = ed.state.tr.insertText(text, pos)
  ed.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + text.length)))
  return ed.view.dom.querySelector('.suggestion')?.textContent ?? null
}

describe('tagText', () => {
  it.each([
    ['work', ' ', '', '#work'],
    ['work', '', ' x', '#work'],
    ['deep work', ' ', '', '#[[deep work]]'],
    ['C++', ' ', '', '#[[C++]]'],
    ['v1.2', ' ', '', '#[[v1.2]]'],
    ['42', ' ', '', '#[[42]]'],
    ['work', ' ', 's', '#[[work]]'],
  ])(
    'writes %j between %j and %j as %s, the form that reads back as it',
    (name, before, after, text) => {
      expect(tagText(name, before, after)).toBe(text)
    },
  )
})

describe('pageLinkText', () => {
  it('is a page’s full title, namespace and all, with a label typed after a `|`', () => {
    const page = { id: A, label: 'Leaf', title: 'Area/Leaf' }

    expect(pageLinkText(page, 'Lea')).toBe('[[Area/Leaf]]')
    expect(pageLinkText(page, 'Lea|shown')).toBe('[[Area/Leaf|shown]]')
  })

  it('is an alias for an alias match, and the typed text for Create', () => {
    const alias = { id: A, label: 'Projects (alias: proj)', isAlias: true, aliasText: 'proj' }

    expect(pageLinkText(alias, 'pro')).toBe('[[proj]]')
    expect(pageLinkText({ id: '__create__', label: 'New', isCreate: true }, 'New page|x ')).toBe(
      '[[New page|x]]',
    )
  })
})

describe('where the pickers open', () => {
  it('# opens where a tag starts, as the block editor’s does: not mid-word, not on a number', () => {
    const ed = build([['- a', A]])

    expect(typeAtEnd(ed, 0, ' a#wor')).toBeNull()
    expect(typeAtEnd(ed, 0, ' #42')).toBeNull()
    expect(typeAtEnd(ed, 0, ' #wor')).toBe('#wor')
  })

  it('# does not open in a fenced code block, which a closing fence or a line carrying an id ends', () => {
    const ed = build([
      ['- code', A],
      ['  ```sh', null],
      ['  echo', null],
      ['  ```', null],
      ['  after', null],
      ['- open', B],
      ['  ~~~', null],
      ['  inside', null],
      ['- next', null],
    ])

    expect(typeAtEnd(ed, 2, ' #wor')).toBeNull()
    expect(typeAtEnd(ed, 4, ' #wor')).toBe('#wor')
    expect(typeAtEnd(ed, 7, ' #wor')).toBeNull()
    expect(typeAtEnd(ed, 0, ' #wor')).toBe('#wor')
  })

  it('[[ and (( open after any text and close once their brackets close; #[[ is a tag, not a link', () => {
    const ed = build([['- a', A]])

    expect(typeAtEnd(ed, 0, ' x[[Quick')).toBe('[[Quick')
    expect(typeAtEnd(ed, 0, ']] more')).toBeNull()
    expect(typeAtEnd(ed, 0, ' ((stand')).toBe('((stand')
    expect(typeAtEnd(ed, 0, '))')).toBeNull()
    expect(typeAtEnd(ed, 0, ' #[[multi')).toBeNull()
  })
})
