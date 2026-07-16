/**
 * Real-editor tests for the HTML-paste insertion paths.
 *
 * Unlike `html-paste.test.ts` (which mocks the view + converter to pin the
 * #2033 destroyed-view guards), these tests run `convertAndInsert` and the
 * `handlePaste` prop against a REAL TipTap editor with the production schema
 * pieces (TaskParagraph / Bold / CodeBlockLowlight), pinning two contracts:
 *
 *   1. A single formatted inline run pastes INLINE at the caret — real marks
 *      spliced into the current textblock, never a new paragraph. The module
 *      contract ("single inline run → inserted inline at the caret … no new
 *      block created") regressed via `replaceSelectionWith(paragraphNode)`,
 *      which splits the parent textblock into three paragraphs; on blur the
 *      multi-paragraph doc hits shouldSplitOnBlur → splitBlock and the user's
 *      one sentence is permanently persisted as three blocks.
 *
 *   2. Inside a code block the handler must NOT claim the paste at all
 *      (`$from.parent.type.spec.code` guard, matching math.ts / query-hint.ts):
 *      claiming it either split the fence in two (single-inline payloads) or
 *      routed content to sibling blocks outside the fence (multi-block
 *      payloads). Returning false lets ProseMirror's default code-context
 *      paste insert the text/plain payload verbatim.
 */

import { Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import Document from '@tiptap/extension-document'
import Text from '@tiptap/extension-text'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it } from 'vitest'

import { convertAndInsert, HtmlPaste } from '@/editor/extensions/html-paste'
import { TaskParagraph } from '@/editor/extensions/task-paragraph'
import type { DocNode, ParagraphNode } from '@/editor/types'

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
      Bold,
      CodeBlockLowlight.configure({ lowlight }),
      HtmlPaste,
    ],
    content,
  })
}

function paragraphDoc(text: string): object {
  return {
    type: 'doc',
    content: [
      text.length > 0
        ? { type: 'paragraph', content: [{ type: 'text', text }] }
        : { type: 'paragraph' },
    ],
  }
}

function codeBlockDoc(code: string): object {
  return {
    type: 'doc',
    content: [
      code.length > 0
        ? { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: code }] }
        : { type: 'codeBlock', attrs: { language: 'js' } },
    ],
  }
}

/** Fire the handlePaste chain with both text/html and text/plain payloads. */
function paste(ed: Editor, html: string, plain: string): boolean {
  const data = new DataTransfer()
  data.setData('text/html', html)
  data.setData('text/plain', plain)
  const event = new ClipboardEvent('paste', { clipboardData: data })
  return (
    ed.view.someProp('handlePaste', (fn) =>
      fn(ed.view, event, ed.view.state.selection.content()),
    ) ?? false
  )
}

/** Bold-marked runs of the first paragraph, e.g. ['bold']. */
function boldRuns(json: DocNode): string[] {
  const para = json.content?.[0] as ParagraphNode | undefined
  return (para?.content ?? [])
    .filter((n) => 'marks' in n && n.marks?.some((m) => m.type === 'bold'))
    .map((n) => ('text' in n ? (n.text ?? '') : ''))
}

describe('insertInlineMarkdown — single inline run pastes INLINE (no block split)', () => {
  it('splices a formatted fragment into the middle of existing text', async () => {
    editor = build(paragraphDoc('hello world'))
    // Caret between 'hello' and ' world' (text starts at pos 1).
    editor.commands.setTextSelection(6)

    await convertAndInsert(editor.view, '<p><strong>bold</strong> word</p>', 'bold word', null)

    // ONE paragraph — the block must not be split into three.
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.child(0).textContent).toBe('hellobold word world')
    // The formatting landed as a real mark.
    expect(boldRuns(editor.getJSON() as DocNode)).toEqual(['bold'])
  })

  it('appends inline at end-of-text instead of creating a second block', async () => {
    editor = build(paragraphDoc('hello '))
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)

    await convertAndInsert(editor.view, '<p><strong>bold</strong> word</p>', 'bold word', null)

    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.child(0).textContent).toBe('hello bold word')
    expect(boldRuns(editor.getJSON() as DocNode)).toEqual(['bold'])
  })

  it('fills an empty paragraph without creating a sibling (documented behavior)', async () => {
    editor = build(paragraphDoc(''))
    editor.commands.focus()

    await convertAndInsert(editor.view, '<p><strong>bold</strong> word</p>', 'bold word', null)

    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.child(0).textContent).toBe('bold word')
    expect(boldRuns(editor.getJSON() as DocNode)).toEqual(['bold'])
  })

  it('preserves the task attr when pasting into a task block mid-text', async () => {
    editor = build({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { todoState: 'TODO' },
          content: [{ type: 'text', text: 'hello world' }],
        },
      ],
    })
    editor.commands.setTextSelection(6)

    await convertAndInsert(editor.view, '<strong>BOLD</strong>', 'BOLD', null)

    // The tail must not be severed into a separate non-task block.
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.child(0).textContent).toBe('helloBOLD world')
    expect(editor.state.doc.child(0).attrs['todoState']).toBe('TODO')
  })
})

describe('handlePaste — code-block context guard', () => {
  it('does NOT claim a single-inline HTML paste inside a code block', () => {
    editor = build(codeBlockDoc('const x = 1'))
    // Caret after 'const ' (code text starts at pos 1).
    editor.commands.setTextSelection(7)

    const handled = paste(editor, '<p><strong>bold</strong> word</p>', 'bold word')

    // Falls through to ProseMirror's default code-context paste, which inserts
    // the text/plain payload into the fence.
    expect(handled).toBe(false)
    // The handler must not have torn the fence apart.
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.child(0).type.name).toBe('codeBlock')
  })

  it('does NOT claim a multi-block HTML paste inside a code block', () => {
    editor = build(codeBlockDoc('const x = 1'))
    editor.commands.setTextSelection(7)

    const handled = paste(editor, '<p>one</p><p>two</p>', 'one\ntwo')

    expect(handled).toBe(false)
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.child(0).type.name).toBe('codeBlock')
    expect(editor.state.doc.child(0).textContent).toBe('const x = 1')
  })

  it('still claims an HTML paste in a plain paragraph (no regression)', () => {
    editor = build(paragraphDoc('hello'))
    editor.commands.setTextSelection(6)

    const handled = paste(editor, '<p><strong>bold</strong> word</p>', 'bold word')

    expect(handled).toBe(true)
  })
})
