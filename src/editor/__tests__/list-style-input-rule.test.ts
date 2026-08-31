import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import { BulletList, OrderedList } from '@tiptap/extension-list'
import ListItem from '@tiptap/extension-list-item'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CheckboxInputRule } from '@/editor/extensions/checkbox-input-rule'
import { ListStyleInputRule } from '@/editor/extensions/list-style-input-rule'

describe('ListStyleInputRule extension', () => {
  it('creates without error', () => {
    const ext = ListStyleInputRule.configure({})
    expect(ext).toBeDefined()
  })

  it('has name "listStyleInputRule"', () => {
    const ext = ListStyleInputRule.configure({})
    expect(ext.name).toBe('listStyleInputRule')
  })

  it('has the expected default options', () => {
    const ext = ListStyleInputRule.configure({})
    expect(ext.options.onListStyle).toBeNull()
  })

  it('exposes exactly 2 input rules (bullet unwrap + ordered unwrap)', () => {
    const ext = ListStyleInputRule.configure({ onListStyle: null })
    // biome-ignore lint: mirrors CheckboxInputRule's own test shape
    const rules = ext.config.addInputRules?.call({ options: ext.options } as any)
    expect(rules).toHaveLength(2)
  })
})

// ── Real-editor integration ─────────────────────────────────────────────
//
// BulletList/OrderedList's OWN `- ` / `1. ` input rules stay enabled (see the
// extension's file doc comment for why): they create a transient single-item
// list exactly as they do today. ListStyleInputRule then watches for the
// FIRST character typed into that fresh item and collapses it into a plain
// paragraph, firing `onListStyle`. These tests drive the realistic
// char-by-char typed path (mirrors checkbox-input-rule.test.ts's own
// `typeChars` helper and its rationale for why the bulk `applyInputRules`
// meta path is not equivalent for this shadowed-rule shape).
describe('ListStyleInputRule real-editor integration', () => {
  let editor: Editor | null = null

  afterEach(() => {
    editor?.destroy()
    editor = null
  })

  function buildEditor(
    onListStyle: ((style: 'bullet' | 'ordered') => void) | null,
    onCheckbox: ((state: 'TODO' | 'DONE') => void) | null = null,
    content: Array<Record<string, unknown>> = [{ type: 'paragraph' }],
  ): Editor {
    return new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        History,
        BulletList,
        OrderedList,
        ListItem,
        CheckboxInputRule.configure({ onCheckbox }),
        ListStyleInputRule.configure({ onListStyle }),
      ],
      content: { type: 'doc', content },
    })
  }

  // Same synchronous char-by-char path real keystrokes take —
  // `checkbox-input-rule.test.ts`'s own `typeChars` helper, duplicated here
  // (rather than imported) so this file has no test-to-test coupling.
  function typeChars(ed: Editor, s: string): void {
    const { view } = ed
    for (const ch of s) {
      const { from, to } = view.state.selection
      const handled = view.someProp('handleTextInput', (f) =>
        f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
      )
      if (!handled) {
        view.dispatch(view.state.tr.insertText(ch, from, to))
      }
    }
  }

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('typing "- x" fires onListStyle(bullet) and leaves a plain paragraph holding "x"', async () => {
    const onListStyle = vi.fn()
    editor = buildEditor(onListStyle)
    typeChars(editor, '- x')
    await flush()

    expect(onListStyle).toHaveBeenCalledTimes(1)
    expect(onListStyle).toHaveBeenCalledWith('bullet')
    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
    })
  })

  it('typing "1. x" fires onListStyle(ordered) and leaves a plain paragraph holding "x"', async () => {
    const onListStyle = vi.fn()
    editor = buildEditor(onListStyle)
    typeChars(editor, '1. x')
    await flush()

    expect(onListStyle).toHaveBeenCalledTimes(1)
    expect(onListStyle).toHaveBeenCalledWith('ordered')
    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
    })
  })

  it('the bullet rule fires on the first char and leaves the paragraph a plain (non-list) node', async () => {
    const onListStyle = vi.fn()
    editor = buildEditor(onListStyle)
    typeChars(editor, '- hello')
    await flush()

    expect(onListStyle).toHaveBeenCalledTimes(1)
    expect(editor.state.doc.child(0).type.name).toBe('paragraph')
    expect(editor.state.doc.child(0).textContent).toBe('hello')
  })

  // #1494-shaped regression guard: typing `- [ ] ` must still create a
  // checkbox, not a bullet-styled paragraph holding literal `[ ] ` text. The
  // bullet rule's `[^[]` exclusion is exactly what keeps this working — a
  // leading `[` never matches it, so CheckboxInputRule's own unwrap rule gets
  // first crack at the still-real single-item bulletList.
  it('typing "- [ ] " still fires onCheckbox(TODO), NOT onListStyle', async () => {
    const onListStyle = vi.fn()
    const onCheckbox = vi.fn()
    editor = buildEditor(onListStyle, onCheckbox)
    typeChars(editor, '- [ ] ')
    await flush()

    expect(onCheckbox).toHaveBeenCalledTimes(1)
    expect(onCheckbox).toHaveBeenCalledWith('TODO')
    expect(onListStyle).not.toHaveBeenCalled()
    expect(editor.getJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
  })

  it('typing "- [x] " still fires onCheckbox(DONE), NOT onListStyle', async () => {
    const onListStyle = vi.fn()
    const onCheckbox = vi.fn()
    editor = buildEditor(onListStyle, onCheckbox)
    typeChars(editor, '- [x] ')
    await flush()

    expect(onCheckbox).toHaveBeenCalledWith('DONE')
    expect(onListStyle).not.toHaveBeenCalled()
  })

  it('does not fire outside a fresh single-item list (typing into an existing paragraph)', async () => {
    const onListStyle = vi.fn()
    editor = buildEditor(onListStyle, null, [
      { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
    ])
    editor.commands.focus('end')
    typeChars(editor, ' world')
    await flush()

    expect(onListStyle).not.toHaveBeenCalled()
    expect(editor.state.doc.child(0).textContent).toBe('hello world')
  })

  it('does not fire inside a real MULTI-item bullet list', async () => {
    const onListStyle = vi.fn()
    editor = buildEditor(onListStyle, null, [
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
          },
          { type: 'listItem', content: [{ type: 'paragraph' }] },
        ],
      },
    ])
    editor.commands.focus('end')
    typeChars(editor, 'x')
    await flush()

    expect(onListStyle).not.toHaveBeenCalled()
    expect(editor.state.doc.child(0).type.name).toBe('bulletList')
  })

  it('rule with onListStyle=null still collapses the list without crashing', async () => {
    editor = buildEditor(null)
    typeChars(editor, '- x')
    await flush()

    expect(editor.state.doc.child(0).type.name).toBe('paragraph')
    expect(editor.state.doc.child(0).textContent).toBe('x')
  })
})
