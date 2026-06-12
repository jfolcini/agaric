/**
 * Integration tests for the QueryHint TipTap extension (#907).
 *
 * Builds a real TipTap Editor in jsdom and drives keystrokes through the
 * ProseMirror view to assert the load-bearing invariants:
 *   - a ghost-text decoration (`.query-hint`, NOT a `.suggestion-popup`)
 *     appears when the caret sits where a key/operator is expected;
 *   - Tab accepts the hint (mutates the doc);
 *   - Enter is NEVER consumed by this plugin — its `handleKeyDown` returns
 *     false for Enter, so the block-save flow upstream still runs.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'

import { QueryHint } from '../extensions/query-hint'

function createEditor(text: string): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, QueryHint],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  })
  // Park the caret at the end of the text.
  const end = editor.state.doc.content.size - 1
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)))
  return editor
}

/**
 * Invoke ONLY the QueryHint plugin's own `handleKeyDown` for a synthetic key.
 *
 * We target this plugin's handler specifically (not `view.someProp`, which
 * aggregates every plugin's handler) because the load-bearing claim is that
 * *this* plugin never consumes Enter. Whether some other extension handles
 * Enter is irrelevant — and in the real editor Enter is owned by the
 * block-save flow, which this plugin must leave untouched.
 */
function pressKey(editor: Editor, key: string, mods: Partial<KeyboardEvent> = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...mods })
  const plugin = editor.view.state.plugins.find(
    (p) => (p.spec.key as { key?: string } | undefined)?.key?.startsWith('queryHint') ?? false,
  )
  const handler = plugin?.props?.handleKeyDown
  if (!handler) throw new Error('QueryHint plugin handleKeyDown not found')
  return handler.call(plugin, editor.view, event) === true
}

describe('QueryHint plugin', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  it('renders ghost text as .query-hint and NOT a .suggestion-popup', () => {
    editor = createEditor('{{query ta')
    const hint = editor.view.dom.querySelector('.query-hint')
    expect(hint).not.toBeNull()
    expect(hint?.textContent).toBe('g:')
    // The structural Enter-eating element must never be produced here.
    expect(editor.view.dom.querySelector('.suggestion-popup')).toBeNull()
    expect(document.querySelector('.suggestion-popup')).toBeNull()
  })

  it('accepts the hint on Tab (mutates the doc)', () => {
    editor = createEditor('{{query ta')
    const handled = pressKey(editor, 'Tab')
    expect(handled).toBe(true)
    expect(editor.state.doc.textContent).toBe('{{query tag:')
  })

  it('does NOT consume Enter — handleKeyDown returns false so save runs', () => {
    editor = createEditor('{{query tag:work}}')
    // Caret at end; a hint may or may not be active, but Enter must fall through.
    const handled = pressKey(editor, 'Enter')
    expect(handled).toBe(false)
  })

  it('does NOT consume Enter even while a hint IS active', () => {
    editor = createEditor('{{query ta')
    // Confirm a hint is active first.
    expect(editor.view.dom.querySelector('.query-hint')).not.toBeNull()
    const handled = pressKey(editor, 'Enter')
    expect(handled).toBe(false)
    // The document is untouched by the Enter press.
    expect(editor.state.doc.textContent).toBe('{{query ta')
  })

  it('does not claim Tab when no hint is active (lets outline indent run)', () => {
    editor = createEditor('plain text no query')
    expect(editor.view.dom.querySelector('.query-hint')).toBeNull()
    expect(pressKey(editor, 'Tab')).toBe(false)
  })

  it('does not claim Shift+Tab / modifier-Tab', () => {
    editor = createEditor('{{query ta')
    expect(editor.view.dom.querySelector('.query-hint')).not.toBeNull()
    expect(pressKey(editor, 'Tab', { shiftKey: true })).toBe(false)
  })

  it('closes the hint when the caret leaves the query token (blur-equivalent)', () => {
    editor = createEditor('{{query ta later')
    // Caret is at end (after "later"), outside the unterminated key word.
    expect(editor.view.dom.querySelector('.query-hint')).toBeNull()
  })
})
