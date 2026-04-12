/**
 * Tests for the ExternalLink extension (F-40):
 * - isValidHttpUrl pure function
 * - Paste-to-link behavior (bare URL -> linked text when selection is empty)
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalLink, isValidHttpUrl } from '../extensions/external-link'

// -- isValidHttpUrl -----------------------------------------------------------

describe('isValidHttpUrl', () => {
  it('accepts https URLs', () => {
    expect(isValidHttpUrl('https://example.com')).toBe(true)
  })

  it('accepts http URLs', () => {
    expect(isValidHttpUrl('http://example.com')).toBe(true)
  })

  it('accepts URLs with path, query, and hash', () => {
    expect(isValidHttpUrl('https://example.com/path?q=1#hash')).toBe(true)
  })

  it('rejects ftp protocol', () => {
    expect(isValidHttpUrl('ftp://example.com')).toBe(false)
  })

  it('rejects javascript protocol', () => {
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects plain text that is not a URL', () => {
    expect(isValidHttpUrl('not a url')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidHttpUrl('')).toBe(false)
  })

  it('rejects URL without protocol', () => {
    expect(isValidHttpUrl('example.com')).toBe(false)
  })

  it('handles leading/trailing whitespace (trims before validation)', () => {
    expect(isValidHttpUrl('  https://example.com  ')).toBe(true)
  })
})

// -- Paste behavior -----------------------------------------------------------

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, ExternalLink],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    },
  })
}

/**
 * Helper: simulate a paste event via the ProseMirror view's handlePaste.
 *
 * jsdom doesn't support real clipboard events well, so we build a
 * minimal ClipboardEvent with the text/plain data and invoke each
 * plugin's handlePaste prop directly.
 */
function simulatePaste(editor: Editor, text: string): boolean {
  // jsdom doesn't have DataTransfer — use a minimal mock clipboardData.
  const mockClipboardData = { getData: (type: string) => (type === 'text/plain' ? text : '') }
  const event = { clipboardData: mockClipboardData } as unknown as ClipboardEvent

  const plugins = editor.view.state.plugins
  for (const plugin of plugins) {
    const handlePaste = plugin.props.handlePaste
    if (handlePaste) {
      const result = handlePaste.call(
        plugin,
        editor.view,
        event,
        editor.view.state.doc.resolve(0).parent.slice(0),
      )
      if (result) return true
    }
  }
  return false
}

describe('ExternalLink paste-to-link (F-40)', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  it('registers the externalLinkPaste plugin', () => {
    editor = createEditor()
    const pluginKeys = editor.view.state.plugins.map((p) => (p as unknown as { key: string }).key)
    expect(pluginKeys.some((k) => k.includes('externalLinkPaste'))).toBe(true)
  })

  it('pasting a URL with empty selection inserts linked text', () => {
    editor = createEditor()
    // Cursor is in the empty paragraph (selection is empty)
    const handled = simulatePaste(editor, 'https://example.com')
    expect(handled).toBe(true)

    // The doc should now contain a text node with the link mark
    const doc = editor.state.doc
    const paragraph = doc.child(0)
    expect(paragraph.childCount).toBe(1)

    const textNode = paragraph.child(0)
    expect(textNode.text).toBe('https://example.com')

    const linkMark = textNode.marks.find((m) => m.type.name === 'link')
    expect(linkMark).toBeDefined()
    expect(linkMark?.attrs.href).toBe('https://example.com')
  })

  it('pasting non-URL text with empty selection does not create a link', () => {
    editor = createEditor()
    const handled = simulatePaste(editor, 'just some text')
    expect(handled).toBe(false)
  })

  it('pasting a URL with leading/trailing whitespace still creates a link', () => {
    editor = createEditor()
    const handled = simulatePaste(editor, '  https://example.com/path  ')
    expect(handled).toBe(true)

    const doc = editor.state.doc
    const paragraph = doc.child(0)
    const textNode = paragraph.child(0)
    // The inserted text should be the trimmed URL
    expect(textNode.text).toBe('https://example.com/path')

    const linkMark = textNode.marks.find((m) => m.type.name === 'link')
    expect(linkMark).toBeDefined()
    expect(linkMark?.attrs.href).toBe('https://example.com/path')
  })

  it('pasting a URL with non-empty selection returns false (delegates to linkOnPaste)', () => {
    editor = createEditor()
    // Insert some text first, then select it
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'select me' }],
        },
      ],
    })
    editor.commands.selectAll()

    const handled = simulatePaste(editor, 'https://example.com')
    expect(handled).toBe(false)
  })
})
