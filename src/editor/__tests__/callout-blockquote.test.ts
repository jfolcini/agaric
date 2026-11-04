/**
 * Tests for the CalloutBlockquote extension (#258): the `calloutType`
 * attribute must survive parse → render so callouts round-trip through the
 * editor instead of being downgraded to plain blockquotes.
 */

import type { Content } from '@tiptap/core'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it } from 'vitest'

import { CalloutBlockquote } from '@/editor/extensions/callout-blockquote'

function makeEditor(content?: Content): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, CalloutBlockquote],
    content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
  })
}

describe('CalloutBlockquote', () => {
  let editor: Editor
  afterEach(() => editor?.destroy())

  it('registers as the blockquote node', () => {
    editor = makeEditor()
    expect(editor.extensionManager.extensions.some((e) => e.name === 'blockquote')).toBe(true)
  })

  it('parses data-callout-type from HTML into the calloutType attribute', () => {
    editor = makeEditor('<blockquote data-callout-type="info"><p>hi</p></blockquote>')
    const quote = editor.getJSON().content?.[0]
    expect(quote?.type).toBe('blockquote')
    expect(quote?.attrs?.['calloutType']).toBe('info')
  })

  it('renders calloutType back to a data-callout-type attribute', () => {
    editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          attrs: { calloutType: 'warning' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'careful' }] }],
        },
      ],
    })
    expect(editor.getHTML()).toContain('data-callout-type="warning"')
    // …and round-trips through getJSON.
    expect(editor.getJSON().content?.[0]?.attrs?.['calloutType']).toBe('warning')
  })

  it('omits the attribute for a plain blockquote (no callout type)', () => {
    editor = makeEditor('<blockquote><p>plain</p></blockquote>')
    expect(editor.getHTML()).not.toContain('data-callout-type')
    expect(editor.getJSON().content?.[0]?.attrs?.['calloutType'] ?? null).toBeNull()
  })

  it('keeps calloutFold through render and getJSON (#6033)', () => {
    editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          attrs: { calloutType: 'faq', calloutFold: '-' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Why?' }] }],
        },
      ],
    })
    expect(editor.getHTML()).toContain('data-callout-fold="-"')
    expect(editor.getJSON().content?.[0]?.attrs?.['calloutFold']).toBe('-')
  })

  it('reads a `+` or `-` fold from HTML and drops any other value (#6033)', () => {
    editor = makeEditor(
      '<blockquote data-callout-type="faq" data-callout-fold="+"><p>a</p></blockquote>',
    )
    expect(editor.getJSON().content?.[0]?.attrs?.['calloutFold']).toBe('+')
    editor.destroy()
    editor = makeEditor(
      '<blockquote data-callout-type="faq" data-callout-fold="x"><p>a</p></blockquote>',
    )
    expect(editor.getJSON().content?.[0]?.attrs?.['calloutFold']).toBeNull()
  })

  it('names the style an alias maps to for the editor CSS, keeping the type (#6033)', () => {
    editor = makeEditor('<blockquote data-callout-type="faq"><p>a</p></blockquote>')
    expect(editor.getHTML()).toContain('data-callout-type="faq"')
    expect(editor.getHTML()).toContain('data-callout-style="warning"')
  })
})
