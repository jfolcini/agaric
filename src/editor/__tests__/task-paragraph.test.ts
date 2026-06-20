/**
 * Tests for the #1481 editor wiring of the GFM task-list markdown layer:
 *   - TaskParagraph: declares the `todoState` schema attr so the parsed value
 *     survives `nodeFromJSON` (round-trip through the live editor schema).
 *   - TaskPaste: routes a pasted single-line GFM task into a task paragraph.
 *
 * These guard the live-editor bridge; the markdown serialize/parse logic from
 * #1435 is tested separately and is NOT touched here.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it } from 'vitest'

import { TaskParagraph } from '../extensions/task-paragraph'
import { pastedTaskParagraph, TaskPaste } from '../extensions/task-paste'
import { serialize } from '../markdown-serializer'
import type { DocNode, ParagraphNode } from '../types'

/** Narrow the first top-level block to a ParagraphNode for attr assertions. */
function firstParagraph(json: DocNode): ParagraphNode | undefined {
  return json.content?.[0] as ParagraphNode | undefined
}

describe('TaskParagraph schema attribute (#1481)', () => {
  let editor: Editor | null = null

  afterEach(() => {
    editor?.destroy()
    editor = null
  })

  function build(): Editor {
    return new Editor({
      element: document.createElement('div'),
      extensions: [Document, TaskParagraph, Text, History, TaskPaste],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
  }

  it('preserves todoState through nodeFromJSON (TODO)', () => {
    editor = build()
    const node = editor.schema.nodeFromJSON({
      type: 'paragraph',
      attrs: { todoState: 'TODO' },
      content: [{ type: 'text', text: 'buy milk' }],
    })
    expect(node.attrs['todoState']).toBe('TODO')
  })

  it.each(['TODO', 'DOING', 'DONE', 'CANCELLED'] as const)(
    'round-trips todoState=%s through setContent → getJSON',
    (state) => {
      editor = build()
      editor.commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { todoState: state },
            content: [{ type: 'text', text: 'x' }],
          },
        ],
      })
      const json = editor.getJSON() as DocNode
      expect(firstParagraph(json)?.attrs?.todoState).toBe(state)
    },
  )

  it('defaults todoState to null for a plain paragraph', () => {
    editor = build()
    const node = editor.schema.nodeFromJSON({
      type: 'paragraph',
      content: [{ type: 'text', text: 'plain' }],
    })
    expect(node.attrs['todoState']).toBeNull()
  })

  it('renders data-todo-state only for task paragraphs', () => {
    editor = build()
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { todoState: 'DONE' }, content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    })
    const html = editor.getHTML()
    expect(html).toContain('data-todo-state="DONE"')
    // The plain paragraph must NOT gain a spurious attribute.
    expect(html.match(/data-todo-state/g) ?? []).toHaveLength(1)
  })

  it('serializes a parsed-attr task doc back to its GFM marker', () => {
    editor = build()
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { todoState: 'TODO' },
          content: [{ type: 'text', text: 'task' }],
        },
      ],
    })
    const json = editor.getJSON() as DocNode
    expect(serialize(json)).toBe('- [ ] task')
  })
})

describe('pastedTaskParagraph (#1481)', () => {
  it('parses a GFM TODO line into a task paragraph', () => {
    expect(pastedTaskParagraph('- [ ] buy milk')).toEqual({
      type: 'paragraph',
      attrs: { todoState: 'TODO' },
      content: [{ type: 'text', text: 'buy milk' }],
    })
  })

  it('parses a DONE line', () => {
    expect(pastedTaskParagraph('- [x] done')?.attrs?.todoState).toBe('DONE')
  })

  it('parses DOING and CANCELLED extension markers', () => {
    expect(pastedTaskParagraph('- [/] wip')?.attrs?.todoState).toBe('DOING')
    expect(pastedTaskParagraph('- [-] nope')?.attrs?.todoState).toBe('CANCELLED')
  })

  it('returns null for plain text (no regression)', () => {
    expect(pastedTaskParagraph('just some text')).toBeNull()
  })

  it('returns null for a bullet that is not a task', () => {
    expect(pastedTaskParagraph('- a bullet')).toBeNull()
  })

  it('returns null for multi-line markdown (left to default paste / splitBlock)', () => {
    expect(pastedTaskParagraph('- [ ] one\n- [ ] two')).toBeNull()
    expect(pastedTaskParagraph('# heading\nbody')).toBeNull()
  })

  it('returns null for empty / whitespace text', () => {
    expect(pastedTaskParagraph('')).toBeNull()
    expect(pastedTaskParagraph('   ')).toBeNull()
  })
})

describe('TaskPaste handlePaste (#1481)', () => {
  let editor: Editor | null = null

  afterEach(() => {
    editor?.destroy()
    editor = null
  })

  function build(): Editor {
    return new Editor({
      element: document.createElement('div'),
      extensions: [Document, TaskParagraph, Text, History, TaskPaste],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
  }

  function paste(editor: Editor, text: string): boolean {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    const event = new ClipboardEvent('paste', { clipboardData: data })
    return (
      editor.view.someProp('handlePaste', (fn) =>
        fn(editor.view, event, editor.view.state.selection.content()),
      ) ?? false
    )
  }

  it('pasting "- [ ] task" creates a TODO task block', () => {
    editor = build()
    editor.commands.focus()
    const handled = paste(editor, '- [ ] task')
    expect(handled).toBe(true)
    const json = editor.getJSON() as DocNode
    expect(firstParagraph(json)?.attrs?.todoState).toBe('TODO')
    expect(editor.state.doc.child(0).textContent).toBe('task')
  })

  it('pasting "- [x] done" creates a DONE task block', () => {
    editor = build()
    editor.commands.focus()
    const handled = paste(editor, '- [x] done')
    expect(handled).toBe(true)
    const json = editor.getJSON() as DocNode
    expect(firstParagraph(json)?.attrs?.todoState).toBe('DONE')
  })

  it('does NOT handle a normal text paste (no regression)', () => {
    editor = build()
    editor.commands.focus()
    const handled = paste(editor, 'just plain text')
    expect(handled).toBe(false)
  })

  it('does NOT handle a multi-line markdown paste (left to default + splitBlock)', () => {
    editor = build()
    editor.commands.focus()
    const handled = paste(editor, '- [ ] one\n- [ ] two')
    expect(handled).toBe(false)
  })

  it('does NOT handle a paste over a non-empty selection', () => {
    editor = build()
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'select me' }] }],
    })
    editor.commands.selectAll()
    const handled = paste(editor, '- [ ] task')
    expect(handled).toBe(false)
  })

  it('does NOT wipe existing content on a caret paste into a non-empty block (#1514)', () => {
    editor = build()
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep me' }] }],
    })
    // Collapsed caret at the end of the existing text — not a selection.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    const handled = paste(editor, '- [ ] task')
    // We decline; the default paste inserts the raw marker at the caret.
    expect(handled).toBe(false)
    // The pre-existing text MUST survive (no clobber).
    expect(editor.state.doc.child(0).textContent).toBe('keep me')
    expect(firstParagraph(editor.getJSON() as DocNode)?.attrs?.todoState).toBeFalsy()
  })

  it('does NOT take over a non-empty block when caret is mid-text (#1514)', () => {
    editor = build()
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
    })
    // Caret between "hello" and " world".
    editor.commands.setTextSelection(6)
    const handled = paste(editor, '- [x] done')
    expect(handled).toBe(false)
    expect(editor.state.doc.child(0).textContent).toBe('hello world')
  })

  it('still takes over a genuinely empty block (no regression)', () => {
    editor = build()
    editor.commands.focus()
    const handled = paste(editor, '- [ ] task')
    expect(handled).toBe(true)
    expect(firstParagraph(editor.getJSON() as DocNode)?.attrs?.todoState).toBe('TODO')
    expect(editor.state.doc.child(0).textContent).toBe('task')
  })
})
