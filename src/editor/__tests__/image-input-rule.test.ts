/**
 * Tests the image input-rule src validation (#1587).
 *
 * The `![alt](src)` input rule must gate `src` like the link rule gates on
 * `isValidHttpUrl`: a valid http(s) URL or a legitimate local image scheme
 * (`data:`/`blob:`/`asset:`/`tauri:`) or a relative path mints an image node,
 * but a garbage/hostile-scheme src (e.g. `javascript:`) no-ops the rule, leaving
 * the literal `![alt](src)` text. Covers the exported `isValidImageSrc`
 * predicate plus the rule firing through a real editor.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it } from 'vitest'

import { Image, isValidImageSrc } from '../extensions/image'

// The real Image node view renders `GatedImage` (i18n + policy hooks), which is
// irrelevant to the input-rule logic under test. Drop the React node view so the
// editor can mount the node in happy-dom without those dependencies; the input
// rule and `type.create` are untouched. (`addNodeView` returning null = no node
// view; we can't set the key to `undefined` under exactOptionalPropertyTypes.)
const ImageNoView = Image.extend({ addNodeView: () => null })

/** Mount a minimal editor with the image node + its input rule. */
function makeEditor(): Editor {
  return new Editor({
    extensions: [Document, Paragraph, Text, History, ImageNoView],
    content: '<p></p>',
  })
}

/**
 * Type `![alt](src)` so the image input rule fires. The rule's regex is anchored
 * with `$` and fires on the just-typed terminating `)`; ProseMirror runs input
 * rules from the `handleTextInput` view prop, NOT from a generic `insertContent`
 * transaction. So we seed the literal run up to before `)`, then drive the final
 * `)` through `handleTextInput` (the real typing path) at the cursor position.
 */
function typeImageRun(editor: Editor, alt: string, src: string): void {
  const prefix = `![${alt}](${src}`
  editor.chain().focus().insertContent(prefix).run()
  const { from } = editor.state.selection
  // Mirrors ProseMirror's input-rule entry point for a single typed char. The
  // inputRules plugin matches against the doc text + this char and, on match,
  // dispatches the replacement (returns true). On no-match it returns false and
  // the char would be inserted normally by the browser — replicate that so the
  // literal `)` is present for the no-op assertions.
  const handled = editor.view.someProp('handleTextInput', (f) =>
    // 5th arg is ProseMirror's `deflt` fallback (() => Transaction) the
    // inputRules plugin ignores; supply the real default (insert the char) so
    // the call type-checks and is semantically correct.
    f(editor.view, from, from, ')', () => editor.state.tr.insertText(')', from)),
  )
  if (!handled) editor.commands.insertContent(')')
}

/** Whether the editor doc contains at least one image node. */
function hasImageNode(editor: Editor): boolean {
  let found = false
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') found = true
  })
  return found
}

/** The src attr of the first image node, or null if there is none. */
function firstImageSrc(editor: Editor): string | null {
  let src: string | null = null
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image' && src === null) {
      src = (node.attrs['src'] as string | undefined) ?? ''
    }
  })
  return src
}

const editors: Editor[] = []
afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy()
})

function freshEditor(): Editor {
  const e = makeEditor()
  editors.push(e)
  return e
}

describe('isValidImageSrc (#1587)', () => {
  it('accepts http and https URLs', () => {
    expect(isValidImageSrc('http://example.com/c.png')).toBe(true)
    expect(isValidImageSrc('https://example.com/c.png')).toBe(true)
  })

  it('accepts http(s) with path/query/hash', () => {
    expect(isValidImageSrc('https://x.com/a/b.png?w=1#frag')).toBe(true)
  })

  it('accepts the data: scheme (inline/pasted images)', () => {
    expect(isValidImageSrc('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
  })

  it('accepts the blob: scheme (object URLs)', () => {
    expect(isValidImageSrc('blob:https://x.com/2b7c-1')).toBe(true)
  })

  it('accepts the asset: and tauri: schemes (in-app attachments)', () => {
    expect(isValidImageSrc('asset://localhost/img.png')).toBe(true)
    expect(isValidImageSrc('tauri://localhost/img.png')).toBe(true)
  })

  it('accepts scheme-less relative paths (local attachment srcs)', () => {
    expect(isValidImageSrc('c.png')).toBe(true)
    expect(isValidImageSrc('./img/x.png')).toBe(true)
    expect(isValidImageSrc('/abs/path/x.png')).toBe(true)
  })

  it('is case-insensitive on accepted schemes', () => {
    expect(isValidImageSrc('DATA:image/png;base64,AAA')).toBe(true)
    expect(isValidImageSrc('HTTPS://x.com/c.png')).toBe(true)
  })

  it('rejects the javascript: scheme', () => {
    expect(isValidImageSrc('javascript:alert(1)')).toBe(false)
  })

  it('rejects other unknown explicit schemes (ftp:, vbscript:, file:)', () => {
    expect(isValidImageSrc('ftp://example.com/c.png')).toBe(false)
    expect(isValidImageSrc('vbscript:msgbox(1)')).toBe(false)
    expect(isValidImageSrc('file:///etc/passwd')).toBe(false)
  })

  it('rejects an empty / whitespace-only src', () => {
    expect(isValidImageSrc('')).toBe(false)
    expect(isValidImageSrc('   ')).toBe(false)
  })
})

describe('image input rule src gating (#1587)', () => {
  it('creates an image node for a valid https src', () => {
    const editor = freshEditor()
    typeImageRun(editor, 'cat', 'https://x.com/c.png')
    expect(hasImageNode(editor)).toBe(true)
    expect(firstImageSrc(editor)).toBe('https://x.com/c.png')
  })

  it('creates an image node for a legitimate non-http scheme (data:)', () => {
    const editor = freshEditor()
    typeImageRun(editor, 'inline', 'data:image/png;base64,iVBORw0KGgo=')
    expect(hasImageNode(editor)).toBe(true)
    expect(firstImageSrc(editor)).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('creates an image node for a relative attachment path', () => {
    const editor = freshEditor()
    typeImageRun(editor, 'att', 'attachments/c.png')
    expect(hasImageNode(editor)).toBe(true)
    expect(firstImageSrc(editor)).toBe('attachments/c.png')
  })

  it('does NOT create an image node for a javascript: src (rule no-ops)', () => {
    const editor = freshEditor()
    typeImageRun(editor, 'x', 'javascript:alert(1)')
    expect(hasImageNode(editor)).toBe(false)
    // The literal text remains instead of an image atom.
    expect(editor.state.doc.textContent).toContain('javascript:alert(1)')
  })

  it('does NOT create an image node for an ftp: src', () => {
    const editor = freshEditor()
    typeImageRun(editor, 'x', 'ftp://example.com/c.png')
    expect(hasImageNode(editor)).toBe(false)
  })
})
