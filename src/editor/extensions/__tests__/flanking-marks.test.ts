/**
 * #5160 N9: the typed and pasted `*`, `_`, `**`, `__`, `~~` and `==` shortcuts
 * format only what the parser would read back as formatted, by the same
 * flanking rule, so `5 * 3 = 15 and 2 *` stays text as it is typed.
 */

import { Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Document from '@tiptap/extension-document'
import Highlight from '@tiptap/extension-highlight'
import Italic from '@tiptap/extension-italic'
import Paragraph from '@tiptap/extension-paragraph'
import Strike from '@tiptap/extension-strike'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it } from 'vitest'

import { withFlankingShortcuts } from '@/editor/extensions/flanking-marks'

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

/** An editor holding `after` with the caret before it. */
function createEditor(after = ''): Editor {
  const ed = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      withFlankingShortcuts(Bold, ['**', '__']),
      withFlankingShortcuts(Italic, ['*', '_']),
      withFlankingShortcuts(Strike, ['~~']),
      withFlankingShortcuts(Highlight, ['==']),
    ],
    content: after,
  })
  ed.commands.setTextSelection(1)
  return ed
}

/**
 * Type `typed` at the caret: all but the last char are inserted, and the last
 * goes through `handleTextInput`, the typing path the input rules run on.
 */
function type(ed: Editor, typed: string): void {
  ed.commands.insertContent(typed.slice(0, -1))
  const last = typed.slice(-1)
  const { from } = ed.state.selection
  const handled = ed.view.someProp('handleTextInput', (f) =>
    f(ed.view, from, from, last, () => ed.state.tr.insertText(last, from)),
  )
  if (!handled) ed.commands.insertContent(last)
}

/** The paragraph's text runs, each with the names of its marks. */
function runs(ed: Editor): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = []
  ed.state.doc.child(0).forEach((node) => {
    out.push([node.text ?? '', node.marks.map((m) => m.type.name)])
  })
  return out
}

describe('typed delimiters format only where they flank (#5160 N9)', () => {
  it.each([
    ['5 * 3 = 15 and 2 *'],
    // An opener before a space cannot open; a closer after one cannot close.
    ['see * word*'],
    ['see *word *'],
    ['a ** b **'],
    ['a ~~ b ~~'],
    ['x == y and y =='],
    ['a _ b _'],
    // An intraword `_` neither opens nor closes.
    ['un_break_'],
    // The first `*` of a closing `**` is not an italic closer.
    ['**word*'],
    ['un**break*'],
  ])('%j stays text', (typed) => {
    editor = createEditor()
    type(editor, typed)
    expect(runs(editor)).toEqual([[typed, []]])
  })

  it.each([
    ['*word*', 'italic'],
    ['**word**', 'bold'],
    ['_word_', 'italic'],
    ['__word__', 'bold'],
    ['~~word~~', 'strike'],
    ['==word==', 'highlight'],
  ])('%j still formats', (typed, mark) => {
    editor = createEditor()
    type(editor, `see ${typed}`)
    expect(runs(editor)).toEqual([
      ['see ', []],
      ['word', [mark]],
    ])
  })

  it.each([
    ['un*break*', 'italic'],
    ['un**break**', 'bold'],
    ['un~~break~~', 'strike'],
    ['un==break==', 'highlight'],
  ])('%j formats mid-word, as the parser reads it', (typed, mark) => {
    editor = createEditor()
    type(editor, typed)
    expect(runs(editor)).toEqual([
      ['un', []],
      ['break', [mark]],
    ])
  })

  it('a closer after punctuation needs no letter after it', () => {
    editor = createEditor('text')
    type(editor, '**Note:**')
    expect(runs(editor)).toEqual([['**Note:**text', []]])
  })

  it('a `*` closer before a letter still closes, a `_` one does not', () => {
    editor = createEditor('x')
    type(editor, '*word*')
    expect(runs(editor)).toEqual([
      ['word', ['italic']],
      ['x', []],
    ])

    editor.destroy()
    editor = createEditor('x')
    type(editor, '_word_')
    expect(runs(editor)).toEqual([['_word_x', []]])
  })
})

describe('pasted delimiters format only where they flank (#5160 N9)', () => {
  it('a pasted line of arithmetic stays text', () => {
    editor = createEditor()
    editor.view.pasteText('5 * 3 = 15 and 2 * 4 = 8')
    expect(runs(editor)).toEqual([['5 * 3 = 15 and 2 * 4 = 8', []]])
  })

  it('pasted marks that flank still format, beside ones that do not', () => {
    editor = createEditor()
    editor.view.pasteText('**d** and ==c== for a == b == c')
    expect(runs(editor)).toEqual([
      ['d', ['bold']],
      [' and ', []],
      ['c', ['highlight']],
      [' for a == b == c', []],
    ])
  })

  it('a span that does not flank leaves its closer to open the next', () => {
    editor = createEditor()
    editor.view.pasteText('a == b and ==c==')
    expect(runs(editor)).toEqual([
      ['a == b and ', []],
      ['c', ['highlight']],
    ])
  })

  it('pasted mid-word emphasis formats', () => {
    editor = createEditor()
    editor.view.pasteText('un*break*able')
    expect(runs(editor)).toEqual([
      ['un', []],
      ['break', ['italic']],
      ['able', []],
    ])
  })

  it('an opener is read against the text before the paste', () => {
    // `a*(b)*`: a `*` between a letter and punctuation cannot open.
    editor = createEditor('a')
    editor.commands.setTextSelection(2)
    editor.view.pasteText('*(b)* x')
    expect(runs(editor)).toEqual([['a*(b)* x', []]])
  })
})
