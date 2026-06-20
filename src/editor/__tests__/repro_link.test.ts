import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { describe, expect, it } from 'vitest'

import { ExternalLink } from '../extensions/external-link'
import { serialize } from '../markdown-serializer'
import type { DocNode } from '../types'

describe('autolink stability under repeated update dispatch', () => {
  it('serialized md is stable across repeated no-op transactions (long url)', () => {
    const editor = new Editor({
      extensions: [Document, Paragraph, Text, History, ExternalLink],
      content: '<p></p>',
    })
    const longUrl = `https://example.com/${'a'.repeat(3000)}`
    editor.commands.insertContent(`${longUrl} `)
    const seen = new Set<string>()
    for (let i = 0; i < 30; i++) {
      // Dispatch a no-op transaction (selection move) to fire `update` like a
      // re-render-driven transaction would in the app.
      const { tr } = editor.state
      editor.view.dispatch(tr.setMeta('probe', i))
      seen.add(serialize(editor.getJSON() as DocNode))
    }
    editor.destroy()
    console.log('DISTINCT_SERIALIZATIONS', seen.size)
    expect(seen.size).toBe(1)
  })
})
