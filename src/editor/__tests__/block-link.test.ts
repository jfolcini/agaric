/**
 * Tests for the BlockLink extension.
 */

import { Editor, type JSONContent } from '@tiptap/core'
import CodeBlock from '@tiptap/extension-code-block'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { Slice } from '@tiptap/pm/model'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BlockLink } from '@/editor/extensions/block-link'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { t } from '@/lib/i18n'
import { setPageDragData } from '@/lib/page-drag'

describe('BlockLink', () => {
  it('creates an extension with the correct name', () => {
    const ext = BlockLink.configure({})
    expect(ext.name).toBe('block_link')
  })

  it('has a default resolveTitle that truncates the ULID', () => {
    const ext = BlockLink.configure({})
    const result = ext.options.resolveTitle('01ABCDEF1234567890ABCDEF12')
    expect(result).toBe('[[01ABCDEF...]]')
  })

  it('has onNavigate undefined by default', () => {
    const ext = BlockLink.configure({})
    expect(ext.options.onNavigate).toBeUndefined()
  })

  it('has resolveStatus undefined by default', () => {
    const ext = BlockLink.configure({})
    expect(ext.options.resolveStatus).toBeUndefined()
  })

  it('accepts a custom resolveTitle option', () => {
    const resolveTitle = (id: string) => `Page:${id}`
    const ext = BlockLink.configure({ resolveTitle })
    expect(ext.options.resolveTitle('abc')).toBe('Page:abc')
  })

  it('accepts a custom onNavigate option', () => {
    const onNavigate = (_id: string) => {}
    const ext = BlockLink.configure({ resolveTitle: (id) => id, onNavigate })
    expect(ext.options.onNavigate).toBe(onNavigate)
  })
})

describe('BlockLink Backspace deletes the chip cleanly (#1739)', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  function createEditor(content: Record<string, unknown>): Editor {
    return new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        BlockLink.configure({ resolveTitle: (id: string) => `[[${id}]]` }),
      ],
      content,
    })
  }

  it('registers a Backspace keyboard shortcut', () => {
    const ext = BlockLink.configure({ resolveTitle: (id) => `Title:${id}` })
    expect(ext.config.addKeyboardShortcuts).toBeDefined()
  })

  it('removes the whole chip and leaves NO inert [[title text behind', () => {
    editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'block_link', attrs: { id: 'ROADMAP' } }],
        },
      ],
    })

    // Sanity: chip is mounted before Backspace.
    expect(editor.view.dom.querySelector('[data-type="block-link"]')).not.toBeNull()

    // Place the caret immediately after the chip, then fire Backspace.
    editor.commands.setTextSelection(editor.state.doc.content.size)
    const handled = editor.view.someProp('handleKeyDown', (f) =>
      f(editor.view, new KeyboardEvent('keydown', { key: 'Backspace' })),
    )

    expect(handled).toBe(true)
    // Chip is gone...
    expect(editor.view.dom.querySelector('[data-type="block-link"]')).toBeNull()
    // ...and no block_link node remains in the doc...
    let hasBlockLink = false
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'block_link') hasBlockLink = true
    })
    expect(hasBlockLink).toBe(false)
    // ...and crucially, no inert "[[title" text (with dangling bracket) remains.
    expect(editor.getText()).toBe('')
  })

  it('does nothing when the caret is not immediately after a chip', () => {
    editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })

    editor.commands.setTextSelection(editor.state.doc.content.size)
    const handled = editor.view.someProp('handleKeyDown', (f) =>
      f(editor.view, new KeyboardEvent('keydown', { key: 'Backspace' })),
    )

    // Our chip handler does not claim the key (returns false); ProseMirror's
    // someProp resolves to undefined when no registered handler returns true.
    expect(handled).toBeFalsy()
  })
})

describe('BlockLink broken link removal (#5736)', () => {
  const DEAD = '01DEAD00000000000000000000'
  const LIVE = '01L1VE00000000000000000000'
  let editor: Editor
  const onNavigate = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    editor.destroy()
  })

  function build(content: JSONContent[]): Editor {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        History,
        BlockLink.configure({
          resolveTitle: (id) => `Title:${id}`,
          resolveStatus: (id) => (id === DEAD ? 'deleted' : 'active'),
          onNavigate,
        }),
      ],
      content: { type: 'doc', content: [{ type: 'paragraph', content }] },
    })
    return editor
  }

  const chip = (id: string) => editor.view.dom.querySelector(`[data-id="${id}"]`) as HTMLElement

  const markdown = () => serialize(editor.getJSON() as DocNode)

  it('a broken chip is struck through and carries the removal tooltip and name; a live one does not', () => {
    build([
      { type: 'block_link', attrs: { id: DEAD } },
      { type: 'block_link', attrs: { id: LIVE } },
    ])
    expect(chip(DEAD).classList.contains('block-link-deleted')).toBe(true)
    expect(chip(DEAD).getAttribute('title')).toBe(t('editor.brokenLinkTooltip'))
    expect(chip(DEAD).getAttribute('role')).toBe('button')
    expect(chip(DEAD).getAttribute('aria-label')).toBe(
      `Title:${DEAD} ${t('editor.brokenLinkRemoveAction')}`,
    )
    expect(chip(LIVE).classList.contains('block-link-deleted')).toBe(false)
    expect(chip(LIVE).getAttribute('title')).toBeNull()
    expect(chip(LIVE).hasAttribute('role')).toBe(false)
    expect(chip(LIVE).hasAttribute('aria-label')).toBe(false)
  })

  it('a labelled broken chip is named by its label', () => {
    build([{ type: 'block_link', attrs: { id: DEAD, label: 'the plan' } }])
    expect(chip(DEAD).getAttribute('aria-label')).toBe(
      `the plan ${t('editor.brokenLinkRemoveAction')}`,
    )
  })

  it('a removal right after typing beside the chip is an undo step of its own', () => {
    build([
      { type: 'text', text: 'a ' },
      { type: 'block_link', attrs: { id: DEAD } },
    ])
    editor.view.dispatch(editor.state.tr.insertText('x', 3))
    chip(DEAD).click()
    expect(markdown()).toBe('a x')
    editor.commands.undo()
    expect(markdown()).toBe(`a x[[${DEAD}]]`)
  })

  it('a click removes exactly that chip, toasts, and undo puts it back', () => {
    build([
      { type: 'text', text: 'a ' },
      { type: 'block_link', attrs: { id: DEAD } },
      { type: 'text', text: ' b ' },
      { type: 'block_link', attrs: { id: LIVE } },
    ])
    chip(DEAD).click()
    expect(markdown()).toBe(`a  b [[${LIVE}]]`)
    expect(toast.success).toHaveBeenCalledExactlyOnceWith(t('editor.brokenLinkRemoved'))
    expect(onNavigate).not.toHaveBeenCalled()
    editor.commands.undo()
    expect(markdown()).toBe(`a [[${DEAD}]] b [[${LIVE}]]`)
  })

  it('a labelled broken chip leaves its label as text', () => {
    build([
      { type: 'text', text: 'see ' },
      { type: 'block_link', attrs: { id: DEAD, label: 'the plan' } },
    ])
    chip(DEAD).click()
    expect(markdown()).toBe('see the plan')
  })

  it('a live chip still navigates and leaves the content alone', () => {
    build([{ type: 'block_link', attrs: { id: LIVE } }])
    chip(LIVE).click()
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(LIVE)
    expect(markdown()).toBe(`[[${LIVE}]]`)
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('BlockLink label (#5160 D9)', () => {
  const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  let editor: Editor

  afterEach(() => {
    editor.destroy()
  })

  /** The attrs of the first paragraph's inline nodes, as `getJSON` reports them. */
  function inlineAttrs(): Array<Record<string, unknown>> {
    const inline = (editor.getJSON().content?.[0]?.content ?? []) as Array<{
      attrs?: Record<string, unknown>
    }>
    return inline.map((node) => node.attrs ?? {})
  }

  function build(content: JSONContent[]): Editor {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        BlockLink.configure({ resolveTitle: () => 'Quarterly Plan' }),
      ],
      content: { type: 'doc', content: [{ type: 'paragraph', content }] },
    })
    return editor
  }

  it('the chip shows the label in place of the title, with the title as its tooltip', () => {
    build([{ type: 'block_link', attrs: { id: ID, label: 'the plan' } }])
    const chip = editor.view.dom.querySelector('[data-testid="block-link-chip"]')
    expect(chip?.textContent).toBe('the plan')
    expect(chip?.getAttribute('title')).toBe('Quarterly Plan')
    expect(chip?.getAttribute('data-label')).toBe('the plan')
  })

  it('an unlabelled chip shows the title and carries no data-label', () => {
    build([{ type: 'block_link', attrs: { id: ID } }])
    const chip = editor.view.dom.querySelector('[data-testid="block-link-chip"]')
    expect(chip?.textContent).toBe('Quarterly Plan')
    expect(chip?.hasAttribute('data-label')).toBe(false)
  })

  it('insertBlockLink stores a label only when given one', () => {
    build([])
    editor.commands.insertBlockLink(ID, 'the plan')
    editor.commands.insertBlockLink(ID)
    expect(inlineAttrs()).toEqual([
      { id: ID, label: 'the plan' },
      { id: ID, label: null },
    ])
  })

  it('setBlockLinkLabel trims, drops an empty or title-equal label, and needs a selected chip', () => {
    build([{ type: 'block_link', attrs: { id: ID } }])
    const labelOf = () => inlineAttrs()[0]?.['label']
    expect(editor.commands.setBlockLinkLabel('x')).toBe(false)
    expect(labelOf()).toBeNull()

    // Re-selected before each call: the node the update replaces the chip
    // with is what the popover selects too (`LinkEditPopover`).
    const set = (label: string) => {
      editor.commands.setNodeSelection(1)
      return editor.commands.setBlockLinkLabel(label)
    }
    expect(set('  the plan  ')).toBe(true)
    expect(labelOf()).toBe('the plan')
    expect(set('Quarterly Plan')).toBe(true)
    expect(labelOf()).toBeNull()
    set('again')
    expect(labelOf()).toBe('again')
    expect(set('   ')).toBe(true)
    expect(labelOf()).toBeNull()
  })

  it('insertBlockLink drops a ] from the label, so a picked link stays a link', () => {
    build([])
    editor.commands.insertBlockLink(ID, 'see [1]')
    editor.commands.insertBlockLink(ID, ' ] ')
    const stored = serialize(editor.getJSON() as DocNode)
    expect(stored).toBe(`[[${ID}|see [1]][[${ID}]]`)
    expect(parse(stored).content?.[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'block_link', attrs: { id: ID, label: 'see [1' } },
        { type: 'block_link', attrs: { id: ID } },
      ],
    })
  })

  it('setBlockLinkLabel drops a ], which would end the stored token and leave it text', () => {
    build([{ type: 'block_link', attrs: { id: ID } }])
    editor.commands.setNodeSelection(1)
    editor.commands.setBlockLinkLabel('[WIP] spec')
    const stored = serialize(editor.getJSON() as DocNode)
    expect(stored).toBe(`[[${ID}|[WIP spec]]`)
    expect(parse(stored).content?.[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'block_link', attrs: { id: ID, label: '[WIP spec' } }],
    })
  })
})

describe('BlockLink takes a page dropped on the editor (#5691)', () => {
  const PAGE = '01HZ00000000000000000PAGE1'
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  /** Run the editor's drop props as ProseMirror's drop does, the pointer over `pos`. */
  function drop(data: DataTransfer, pos: number, markdown = 'see here'): boolean {
    editor = new Editor({
      extensions: [Document, Paragraph, Text, CodeBlock, BlockLink],
      content: parse(markdown) as unknown as JSONContent,
    })
    const at = vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos, inside: -1 })
    // happy-dom's DragEvent drops the data and point it is built with.
    const event = { dataTransfer: data, clientX: 10, clientY: 20 } as unknown as DragEvent
    const taken =
      editor.view.someProp('handleDrop', (handle) =>
        handle(editor.view, event, Slice.empty, false),
      ) ?? false
    if (taken) expect(at).toHaveBeenCalledWith({ left: 10, top: 20 })
    return taken
  }

  it('links the page where it is dropped', () => {
    const data = new DataTransfer()
    setPageDragData(data, PAGE)

    expect(drop(data, 5)).toBe(true)
    expect(serialize(editor.getJSON() as DocNode)).toBe(`see [[${PAGE}]]here`)
  })

  it('takes a drop on a code block and changes nothing', () => {
    const data = new DataTransfer()
    setPageDragData(data, PAGE)
    const code = '```\nlet a = 1\n```'

    expect(drop(data, 4, code)).toBe(true)
    expect(serialize(editor.getJSON() as DocNode)).toBe(code)
  })

  it('leaves a drop of anything else to ProseMirror', () => {
    const data = new DataTransfer()
    data.setData('text/plain', 'hello')

    expect(drop(data, 5)).toBe(false)
    expect(serialize(editor.getJSON() as DocNode)).toBe('see here')
  })
})
