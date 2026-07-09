/**
 * TaskPaste — code-block context guard.
 *
 * The #1481 take-over guard only checked emptiness + `todoState`, never the
 * parent node TYPE, so a GFM task line pasted into an EMPTY code block (size 0,
 * no attrs) passed the guard and `replaceRangeWith` swapped the entire
 * codeBlock node for a task paragraph — the fence (and its language) silently
 * destroyed, the pasted line reinterpreted as a task. The guard must require
 * the caret's parent to be a plain paragraph so a code-context paste falls
 * through to the default handler (raw text into the fence).
 *
 * The happy paths (empty paragraph take-over, #1514 non-empty declines) are
 * pinned in `src/editor/__tests__/task-paragraph.test.ts`; this file builds the
 * editor WITH the production code-block extension, which that suite omits.
 */

import { Editor } from '@tiptap/core'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import Document from '@tiptap/extension-document'
import Text from '@tiptap/extension-text'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it } from 'vitest'

import { TaskParagraph } from '../task-paragraph'
import { TaskPaste } from '../task-paste'

const lowlight = createLowlight(common)

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function build(content: object): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      TaskParagraph,
      Text,
      CodeBlockLowlight.configure({ lowlight }),
      TaskPaste,
    ],
    content,
  })
}

function paste(ed: Editor, text: string): boolean {
  const data = new DataTransfer()
  data.setData('text/plain', text)
  const event = new ClipboardEvent('paste', { clipboardData: data })
  return (
    ed.view.someProp('handlePaste', (fn) =>
      fn(ed.view, event, ed.view.state.selection.content()),
    ) ?? false
  )
}

describe('TaskPaste — code-block context guard', () => {
  it('does NOT replace an EMPTY code block with a task paragraph', () => {
    editor = build({
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'js' } }],
    })
    // Collapsed caret inside the empty code block.
    editor.commands.setTextSelection(1)

    const handled = paste(editor, '- [ ] buy milk')

    // Falls through to the default paste (raw marker text into the fence).
    expect(handled).toBe(false)
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.child(0).type.name).toBe('codeBlock')
    expect(editor.state.doc.child(0).attrs['language']).toBe('js')
  })

  it('does NOT act inside a non-empty code block either', () => {
    editor = build({
      type: 'doc',
      content: [
        { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'x' }] },
      ],
    })
    editor.commands.setTextSelection(2)

    const handled = paste(editor, '- [ ] buy milk')

    expect(handled).toBe(false)
    expect(editor.state.doc.child(0).type.name).toBe('codeBlock')
    expect(editor.state.doc.child(0).textContent).toBe('x')
  })

  it('still takes over a genuinely empty paragraph (no regression)', () => {
    editor = build({ type: 'doc', content: [{ type: 'paragraph' }] })
    editor.commands.focus()

    const handled = paste(editor, '- [ ] buy milk')

    expect(handled).toBe(true)
    expect(editor.state.doc.child(0).type.name).toBe('paragraph')
    expect(editor.state.doc.child(0).attrs['todoState']).toBe('TODO')
    expect(editor.state.doc.child(0).textContent).toBe('buy milk')
  })
})
