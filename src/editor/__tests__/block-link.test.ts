/**
 * Tests for the BlockLink extension.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it } from 'vitest'

import { BlockLink } from '../extensions/block-link'

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

describe('BlockLink broken link recovery', () => {
  /** Helper: invoke the NodeView factory and return the DOM + view object. */
  function createNodeView(options: {
    id: string
    resolveStatus?: (id: string) => 'active' | 'deleted'
    editor?: unknown
    getPos?: () => number
  }) {
    const ext = BlockLink.configure({
      resolveTitle: (id) => `Title:${id}`,
      resolveStatus: options.resolveStatus,
    })

    // The addNodeView config is a function that returns the NodeView factory.
    const factory = (ext.config.addNodeView as (...args: unknown[]) => unknown)?.call(ext)
    const fakeNode = { type: { name: 'block_link' }, attrs: { id: options.id }, nodeSize: 1 }
    const view = (factory as (...args: unknown[]) => { dom: unknown })({
      node: fakeNode,
      editor: options.editor ?? {},
      getPos: options.getPos ?? (() => 0),
    })
    return { dom: view.dom as HTMLSpanElement, view }
  }
  it('does not set title tooltip on active links', () => {
    const { dom } = createNodeView({
      id: 'ACTIVE01',
      resolveStatus: () => 'active',
    })

    expect(dom.getAttribute('title')).toBeNull()
    expect(dom.classList.contains('block-link-deleted')).toBe(false)
  })
})
