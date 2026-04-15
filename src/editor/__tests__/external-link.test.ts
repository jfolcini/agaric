/**
 * Tests for the ExternalLink extension (F-40):
 * - isValidHttpUrl pure function
 * - Paste-to-link behavior (bare URL -> linked text when selection is empty)
 * - Link metadata prefetch on paste (UX-165)
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalLink, isValidHttpUrl } from '../extensions/external-link'

// ── Mocks ────────────────────────────────────────────────────────────────

const mockFetchLinkMetadata = vi.fn().mockResolvedValue({})

vi.mock('@/lib/tauri', () => ({
  fetchLinkMetadata: (...args: unknown[]) => mockFetchLinkMetadata(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}))

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
    expect(linkMark?.attrs['href']).toBe('https://example.com')
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
    expect(linkMark?.attrs['href']).toBe('https://example.com/path')
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

  it('cursor after paste does not carry the link mark (B-69)', () => {
    editor = createEditor()
    simulatePaste(editor, 'https://example.com')

    // The stored marks on the state should NOT include the link mark
    const storedMarks = editor.state.storedMarks
    const hasLinkMark = storedMarks?.some((m) => m.type.name === 'link') ?? false
    expect(hasLinkMark).toBe(false)
  })

  it('text typed after pasting a URL does not get the link mark (B-69)', () => {
    editor = createEditor()
    simulatePaste(editor, 'https://example.com')

    // Simulate typing a character after the pasted link
    const { tr } = editor.state
    const textNode = editor.state.schema.text(' hello')
    const insertPos = editor.state.selection.from
    editor.view.dispatch(tr.insert(insertPos, textNode))

    // Get the paragraph content
    const paragraph = editor.state.doc.child(0)
    // The last text node should NOT have a link mark
    const lastChild = paragraph.child(paragraph.childCount - 1)
    const hasLink = lastChild.marks.some((m) => m.type.name === 'link')
    expect(hasLink).toBe(false)
  })

  it('triggers metadata prefetch after pasting a URL (UX-165)', () => {
    editor = createEditor()
    simulatePaste(editor, 'https://example.com')
    expect(mockFetchLinkMetadata).toHaveBeenCalledWith('https://example.com')
  })

  it('does not trigger metadata prefetch for non-URL paste', () => {
    editor = createEditor()
    mockFetchLinkMetadata.mockClear()
    simulatePaste(editor, 'just some text')
    expect(mockFetchLinkMetadata).not.toHaveBeenCalled()
  })
})

describe('ExternalLink Ctrl+K shortcut (B-70)', () => {
  type ShortcutContext = { editor: unknown; options: unknown }
  type ShortcutMap = Record<string, (() => boolean) | undefined>

  function callAddKeyboardShortcuts(
    dom: HTMLElement,
    selection: { from: number; to: number },
  ): ShortcutMap {
    const addKb = ExternalLink.config.addKeyboardShortcuts as
      | ((this: ShortcutContext) => ShortcutMap)
      | undefined
    expect(addKb).toBeDefined()
    return (addKb as (this: ShortcutContext) => ShortcutMap).call({
      editor: { view: { dom }, state: { selection } },
      options: ExternalLink.options,
    })
  }

  it('addKeyboardShortcuts returns Mod-k handler', () => {
    expect(ExternalLink.config.addKeyboardShortcuts).toBeDefined()
    const shortcuts = callAddKeyboardShortcuts(document.createElement('div'), { from: 0, to: 0 })
    expect(shortcuts).toBeDefined()
    expect(shortcuts['Mod-k']).toBeDefined()
    expect(typeof shortcuts['Mod-k']).toBe('function')
  })

  it('Mod-k handler dispatches open-link-popover CustomEvent with bubbles', () => {
    const mockDom = document.createElement('div')
    const events: Event[] = []
    mockDom.addEventListener('open-link-popover', (e) => events.push(e))

    const shortcuts = callAddKeyboardShortcuts(mockDom, { from: 5, to: 10 })
    const handler = shortcuts['Mod-k']
    expect(handler).toBeDefined()

    const result = (handler as () => boolean)()
    expect(result).toBe(true)
    expect(events).toHaveLength(1)
    expect((events[0] as CustomEvent).bubbles).toBe(true)
    expect((events[0] as CustomEvent).detail).toEqual({ from: 5, to: 10 })
  })
})

describe('ExternalLink mark exit after setLink (UX-177)', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  /** Helper — the link mark is always registered via ExternalLink extension. */
  function getLinkMarkType(ed: Editor) {
    const mt = ed.schema.marks['link']
    expect(mt).toBeDefined()
    return mt as import('@tiptap/pm/model').MarkType
  }

  it('stored marks do not include link after setLink + removeStoredMark', () => {
    editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'click here' }],
        },
      ],
    })
    editor.commands.selectAll()

    // Apply link (simulating what LinkEditPopover does)
    editor.chain().focus().setLink({ href: 'https://example.com' }).run()

    // Remove stored marks (the UX-177 fix)
    const linkMarkType = getLinkMarkType(editor)
    editor.view.dispatch(editor.state.tr.removeStoredMark(linkMarkType))

    // Verify stored marks do not include link
    const storedMarks = editor.state.storedMarks
    const hasLinkMark = storedMarks?.some((m) => m.type.name === 'link') ?? false
    expect(hasLinkMark).toBe(false)
  })

  it('text typed after setLink + removeStoredMark is not linked (UX-177)', () => {
    editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'click here' }],
        },
      ],
    })
    editor.commands.selectAll()

    // Apply link
    editor.chain().focus().setLink({ href: 'https://example.com' }).run()

    // Remove stored marks (UX-177 fix)
    const linkMarkType = getLinkMarkType(editor)
    editor.view.dispatch(editor.state.tr.removeStoredMark(linkMarkType))

    // Move cursor to end of the link
    const endPos = editor.state.doc.content.size - 1
    editor.commands.setTextSelection(endPos)

    // Re-remove stored marks at new position (simulating what happens after popover close)
    editor.view.dispatch(editor.state.tr.removeStoredMark(linkMarkType))

    // Insert text after the link
    const textNode = editor.state.schema.text(' unlinked')
    editor.view.dispatch(editor.state.tr.insert(endPos, textNode))

    // The inserted text should NOT have the link mark
    const paragraph = editor.state.doc.child(0)
    const lastChild = paragraph.child(paragraph.childCount - 1)
    const hasLink = lastChild.marks.some((m) => m.type.name === 'link')
    expect(hasLink).toBe(false)
  })
})
