/**
 * A keydown ends ProseMirror's post-focus window (`input.lastFocus`), so a key
 * that moves the caret to the document's start is not undone as a Chrome reset.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it } from 'vitest'

import { KeyEndsFocusReset } from '@/editor/extensions/key-ends-focus-reset'

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

/** An editor whose view was focused just now. */
function justFocused(): { dom: HTMLElement; input: { lastFocus: number } } {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, KeyEndsFocusReset],
    content: '<p>hello world</p>',
  })
  const { view } = editor
  const input = (view as unknown as { input: { lastFocus: number } }).input
  input.lastFocus = Date.now()
  return { dom: view.dom, input }
}

describe('KeyEndsFocusReset', () => {
  it('a keydown in the editor ends the focus window', () => {
    const { dom, input } = justFocused()
    dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true, bubbles: true }))
    expect(input.lastFocus).toBe(0)
  })

  it('a keyup leaves the focus window open', () => {
    const { dom, input } = justFocused()
    const focusedAt = input.lastFocus
    dom.dispatchEvent(new KeyboardEvent('keyup', { key: 'Home', ctrlKey: true, bubbles: true }))
    expect(input.lastFocus).toBe(focusedAt)
  })
})
