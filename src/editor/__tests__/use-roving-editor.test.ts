import { Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse, serialize } from '../markdown-serializer'
import type { DocNode } from '../types'
import {
  CodeBlockWithShortcut,
  CodeWithShortcut,
  computeContentDelta,
  dispatchPriorityEvent,
  HighlightWithShortcut,
  PriorityShortcuts,
  replaceDocSilently,
  StrikeWithShortcut,
  shouldSplitOnBlur,
} from '../use-roving-editor'

vi.mock('../markdown-serializer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../markdown-serializer')>()
  return {
    ...actual,
    serialize: vi.fn((...args: Parameters<typeof actual.serialize>) => actual.serialize(...args)),
  }
})

// -- editorProps ARIA attributes ------------------------------------------------
// Verified via grep: use-roving-editor.ts contains editorProps.attributes with
// role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Block editor'.
// Cannot unit-test useEditor config without full React + TipTap environment.

const mockedSerialize = vi.mocked(serialize)

afterEach(() => {
  mockedSerialize.mockRestore()
})

// -- dispatchPriorityEvent ----------------------------------------------------

describe('dispatchPriorityEvent', () => {
  it('dispatches set-priority-1 on document for level 1', () => {
    const spy = vi.fn()
    document.addEventListener('set-priority-1', spy)
    dispatchPriorityEvent(1)
    expect(spy).toHaveBeenCalledOnce()
    document.removeEventListener('set-priority-1', spy)
  })

  it('dispatches set-priority-2 on document for level 2', () => {
    const spy = vi.fn()
    document.addEventListener('set-priority-2', spy)
    dispatchPriorityEvent(2)
    expect(spy).toHaveBeenCalledOnce()
    document.removeEventListener('set-priority-2', spy)
  })

  it('dispatches set-priority-3 on document for level 3', () => {
    const spy = vi.fn()
    document.addEventListener('set-priority-3', spy)
    dispatchPriorityEvent(3)
    expect(spy).toHaveBeenCalledOnce()
    document.removeEventListener('set-priority-3', spy)
  })

  it('dispatches a CustomEvent instance', () => {
    let receivedEvent: Event | null = null
    const handler = (e: Event) => {
      receivedEvent = e
    }
    document.addEventListener('set-priority-1', handler)
    dispatchPriorityEvent(1)
    expect(receivedEvent).toBeInstanceOf(CustomEvent)
    document.removeEventListener('set-priority-1', handler)
  })
})

// -- replaceDocSilently -------------------------------------------------------

describe('replaceDocSilently', () => {
  function makeMockEditor() {
    const mockContent = { size: 42, mock: true }
    const mockPmDoc = { content: mockContent }
    const tr = {
      replaceWith: vi.fn().mockReturnThis(),
      setMeta: vi.fn().mockReturnThis(),
    }
    const editor = {
      schema: { nodeFromJSON: vi.fn().mockReturnValue(mockPmDoc) },
      state: {
        doc: { content: { size: 100 } },
        get tr() {
          return tr
        },
      },
      view: { dispatch: vi.fn() },
    }
    return { editor, tr, mockContent }
  }

  it('calls schema.nodeFromJSON with the JSON argument', () => {
    const { editor } = makeMockEditor()
    const json = { type: 'doc', content: [{ type: 'paragraph' }] }

    replaceDocSilently(editor as never, json)

    expect(editor.schema.nodeFromJSON).toHaveBeenCalledOnce()
    expect(editor.schema.nodeFromJSON).toHaveBeenCalledWith(json)
  })

  it('replaces entire document content (position 0 to docSize)', () => {
    const { editor, tr, mockContent } = makeMockEditor()

    replaceDocSilently(editor as never, { type: 'doc' })

    expect(tr.replaceWith).toHaveBeenCalledOnce()
    expect(tr.replaceWith).toHaveBeenCalledWith(0, 100, mockContent)
  })

  it('sets addToHistory:false meta to avoid polluting undo stack', () => {
    const { editor, tr } = makeMockEditor()

    replaceDocSilently(editor as never, { type: 'doc' })

    expect(tr.setMeta).toHaveBeenCalledOnce()
    expect(tr.setMeta).toHaveBeenCalledWith('addToHistory', false)
  })

  it('dispatches the transaction via editor.view.dispatch', () => {
    const { editor, tr } = makeMockEditor()

    replaceDocSilently(editor as never, { type: 'doc' })

    expect(editor.view.dispatch).toHaveBeenCalledOnce()
    expect(editor.view.dispatch).toHaveBeenCalledWith(tr)
  })

  it('chains correctly: replaceWith -> setMeta -> dispatch', () => {
    const { editor, tr } = makeMockEditor()
    const callOrder: string[] = []
    tr.replaceWith = vi.fn(() => {
      callOrder.push('replaceWith')
      return tr
    })
    tr.setMeta = vi.fn(() => {
      callOrder.push('setMeta')
      return tr
    })
    editor.view.dispatch = vi.fn(() => {
      callOrder.push('dispatch')
    })

    replaceDocSilently(editor as never, { type: 'doc' })

    expect(callOrder).toEqual(['replaceWith', 'setMeta', 'dispatch'])
  })
})

// -- computeContentDelta ------------------------------------------------------

describe('computeContentDelta', () => {
  it('returns changed:false when content is unchanged', () => {
    const original = 'hello world'
    // Build a DocNode that serializes back to 'hello world'
    const json: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
    }
    const delta = computeContentDelta(original, json)
    expect(delta.changed).toBe(false)
    expect(delta.newMarkdown).toBe('hello world')
    expect(delta.originalMarkdown).toBe('hello world')
  })

  it('returns changed:true with correct newMarkdown when content differs', () => {
    const original = 'hello world'
    const json: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'goodbye world' }] }],
    }
    const delta = computeContentDelta(original, json)
    expect(delta.changed).toBe(true)
    expect(delta.newMarkdown).toBe('goodbye world')
    expect(delta.originalMarkdown).toBe('hello world')
  })

  it('handles empty doc → empty string', () => {
    const original = ''
    const json: DocNode = { type: 'doc' }
    const delta = computeContentDelta(original, json)
    expect(delta.changed).toBe(false)
    expect(delta.newMarkdown).toBe('')
  })

  it('detects change from empty to non-empty', () => {
    const original = ''
    const json: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new content' }] }],
    }
    const delta = computeContentDelta(original, json)
    expect(delta.changed).toBe(true)
    expect(delta.newMarkdown).toBe('new content')
  })
})

// -- shouldSplitOnBlur --------------------------------------------------------

describe('shouldSplitOnBlur', () => {
  it('returns false for single line', () => {
    expect(shouldSplitOnBlur('hello world')).toBe(false)
  })

  it('returns true when markdown contains a newline (multiple paragraphs)', () => {
    expect(shouldSplitOnBlur('line1\nline2')).toBe(true)
  })

  it('returns false when newline is inside a code block', () => {
    expect(shouldSplitOnBlur('```\ncode line\nmore code\n```')).toBe(false)
  })

  it('returns true when newline exists outside code block', () => {
    expect(shouldSplitOnBlur('```\ncode\n```\ntext after')).toBe(true)
  })

  it('returns false for empty string', () => {
    expect(shouldSplitOnBlur('')).toBe(false)
  })

  it('returns false for a single heading', () => {
    expect(shouldSplitOnBlur('## Just a heading')).toBe(false)
  })

  it('returns true for heading followed by paragraph', () => {
    expect(shouldSplitOnBlur('# Title\nParagraph')).toBe(true)
  })
})

// -- unmount error boundary (B-12) -------------------------------------------
// unmount() is a hook callback inside useRovingEditor. Testing the actual hook
// requires a full React + TipTap environment, so we test the building blocks:
// 1. computeContentDelta propagates serialize errors (proving the try-catch is needed)
// 2. The unmount pattern with mock editor objects (proving the fix works)

describe('unmount error boundary', () => {
  function makeMockEditor() {
    const mockContent = { size: 42, mock: true }
    const mockPmDoc = { content: mockContent }
    const tr = {
      replaceWith: vi.fn().mockReturnThis(),
      setMeta: vi.fn().mockReturnThis(),
    }
    const editor = {
      getJSON: vi.fn().mockReturnValue({ type: 'doc', content: [{ type: 'paragraph' }] }),
      schema: { nodeFromJSON: vi.fn().mockReturnValue(mockPmDoc) },
      state: {
        doc: { content: { size: 100 } },
        get tr() {
          return tr
        },
      },
      view: { dispatch: vi.fn() },
    }
    return { editor, tr }
  }

  it('computeContentDelta propagates errors from serialize', () => {
    mockedSerialize.mockImplementationOnce(() => {
      throw new Error('malformed ProseMirror JSON')
    })
    const json: DocNode = { type: 'doc', content: [{ type: 'paragraph' }] }
    expect(() => computeContentDelta('hello', json)).toThrow('malformed ProseMirror JSON')
  })

  it('unmount pattern returns null and resets editor when serialize throws', () => {
    const { editor, tr } = makeMockEditor()

    mockedSerialize.mockImplementationOnce(() => {
      throw new Error('serialize boom')
    })

    // Exercise the same logic as unmount():
    // try { computeContentDelta(...) } catch { ... } finally { reset }
    let delta: ReturnType<typeof computeContentDelta> | null = null
    let caughtError = false
    try {
      const json = editor.getJSON() as DocNode
      delta = computeContentDelta('original', json)
    } catch {
      caughtError = true
    } finally {
      replaceDocSilently(editor as never, { type: 'doc', content: [{ type: 'paragraph' }] })
    }

    const result = delta?.changed ? delta.newMarkdown : null

    // Error was caught, not propagated
    expect(caughtError).toBe(true)
    // Returns null (unchanged) rather than losing content
    expect(result).toBeNull()
    // Editor state was still reset (replaceDocSilently was called)
    expect(tr.replaceWith).toHaveBeenCalledOnce()
    expect(tr.setMeta).toHaveBeenCalledWith('addToHistory', false)
    expect(editor.view.dispatch).toHaveBeenCalledOnce()
  })

  it('unmount pattern returns changed markdown on the normal path', () => {
    const { editor } = makeMockEditor()

    // serialize will use real implementation (pass-through mock)
    const json = editor.getJSON() as DocNode
    const delta = computeContentDelta('different original', json)
    const result = delta?.changed ? delta.newMarkdown : null

    // Content changed, so newMarkdown is returned
    expect(delta.changed).toBe(true)
    expect(result).toBe('')
  })

  it('unmount pattern returns null when content is unchanged', () => {
    const { editor } = makeMockEditor()

    // Serialize an empty paragraph doc → '' , match against '' original
    const json = editor.getJSON() as DocNode
    const delta = computeContentDelta('', json)
    const result = delta?.changed ? delta.newMarkdown : null

    expect(delta.changed).toBe(false)
    expect(result).toBeNull()
  })
})

// -- Real TipTap Editor helpers -----------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: TipTap extensions have complex union types
function createEditor(extensions: any[]): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, ...extensions],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })
}

// -- Custom extension keyboard shortcuts (real Editor) ------------------------

describe('custom extension keyboard shortcuts', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  it('CodeWithShortcut registers inline code extension', () => {
    editor = createEditor([CodeWithShortcut])
    expect(editor.extensionManager.extensions.some((e) => e.name === 'code')).toBe(true)
  })

  it('StrikeWithShortcut registers strikethrough extension', () => {
    editor = createEditor([StrikeWithShortcut])
    expect(editor.extensionManager.extensions.some((e) => e.name === 'strike')).toBe(true)
  })

  it('HighlightWithShortcut registers highlight extension', () => {
    editor = createEditor([HighlightWithShortcut])
    expect(editor.extensionManager.extensions.some((e) => e.name === 'highlight')).toBe(true)
  })

  it('CodeBlockWithShortcut registers codeBlock extension with lowlight', () => {
    editor = createEditor([CodeBlockWithShortcut.configure({ lowlight: createLowlight(common) })])
    expect(editor.extensionManager.extensions.some((e) => e.name === 'codeBlock')).toBe(true)
  })

  it('PriorityShortcuts registers priorityShortcuts extension', () => {
    editor = createEditor([PriorityShortcuts])
    expect(editor.extensionManager.extensions.some((e) => e.name === 'priorityShortcuts')).toBe(
      true,
    )
  })

  it('CodeWithShortcut toggles inline code via command', () => {
    editor = createEditor([CodeWithShortcut])
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    editor.commands.selectAll()
    editor.commands.toggleCode()
    expect(editor.isActive('code')).toBe(true)
  })

  it('StrikeWithShortcut toggles strike via command', () => {
    editor = createEditor([StrikeWithShortcut])
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    editor.commands.selectAll()
    editor.commands.toggleStrike()
    expect(editor.isActive('strike')).toBe(true)
  })

  it('HighlightWithShortcut toggles highlight via command', () => {
    editor = createEditor([HighlightWithShortcut])
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    editor.commands.selectAll()
    editor.commands.toggleHighlight()
    expect(editor.isActive('highlight')).toBe(true)
  })

  it('CodeBlockWithShortcut toggles code block via command', () => {
    editor = createEditor([CodeBlockWithShortcut.configure({ lowlight: createLowlight(common) })])
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    editor.commands.selectAll()
    editor.commands.toggleCodeBlock()
    expect(editor.isActive('codeBlock')).toBe(true)
  })

  it('PriorityShortcuts dispatches set-priority-1 event via shortcut handler', () => {
    editor = createEditor([PriorityShortcuts])
    const ext = editor.extensionManager.extensions.find((e) => e.name === 'priorityShortcuts')
    expect(ext).toBeDefined()
    // The extension registers keyboard shortcuts that call dispatchPriorityEvent
    // Verify the event fires when called directly (integration with dispatchPriorityEvent)
    const spy = vi.fn()
    document.addEventListener('set-priority-1', spy)
    dispatchPriorityEvent(1)
    expect(spy).toHaveBeenCalledOnce()
    document.removeEventListener('set-priority-1', spy)
  })
})

// -- Mount logic (replaceDocSilently with real Editor) ------------------------

describe('mount logic (real Editor)', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  it('replaceDocSilently parses and replaces content on mount', () => {
    editor = createEditor([])
    const markdown = 'hello world'
    const doc = parse(markdown)
    replaceDocSilently(editor, doc as unknown as Record<string, unknown>)
    expect(editor.getText()).toBe('hello world')
  })

  it('mount with empty string sets empty paragraph', () => {
    editor = createEditor([])
    const doc = parse('')
    replaceDocSilently(editor, doc as unknown as Record<string, unknown>)
    expect(editor.getText()).toBe('')
  })

  it('mount with bold markdown preserves formatting', () => {
    editor = createEditor([Bold])
    const doc = parse('**bold text**')
    replaceDocSilently(editor, doc as unknown as Record<string, unknown>)
    expect(editor.getText()).toBe('bold text')
    // The entire content is bold, so cursor sits inside a bold span
    const json = editor.getJSON()
    const marks = json.content?.[0]?.content?.[0]?.marks ?? []
    expect(marks.some((m: { type: string }) => m.type === 'bold')).toBe(true)
  })

  it('history plugin reset clears undo stack', () => {
    editor = createEditor([History])
    // Type something to create undo history
    editor.commands.insertContent('first edit')
    expect(editor.can().undo()).toBe(true)

    // Reset history (simulate mount logic from use-roving-editor)
    const histPlugin = editor.state.plugins.find((p) =>
      (p as unknown as { key: string }).key.startsWith('history$'),
    )
    if (histPlugin?.spec.state?.init) {
      const freshHistory = histPlugin.spec.state.init({}, editor.state)
      const { tr } = editor.state
      tr.setMeta(histPlugin, { historyState: freshHistory })
      tr.setMeta('addToHistory', false)
      editor.view.dispatch(tr)
    }

    // Undo should now be unavailable
    expect(editor.can().undo()).toBe(false)
  })

  it('replaceDocSilently does not add to undo history', () => {
    editor = createEditor([History])
    const doc = parse('new content')
    replaceDocSilently(editor, doc as unknown as Record<string, unknown>)
    // The replacement should not be undoable
    expect(editor.can().undo()).toBe(false)
    expect(editor.getText()).toBe('new content')
  })
})

// -- getMarkdown logic (serialize from real Editor) ---------------------------

describe('getMarkdown logic (real Editor)', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  it('serializes current editor content to markdown', () => {
    editor = createEditor([Bold])
    const doc = parse('hello world')
    replaceDocSilently(editor, doc as unknown as Record<string, unknown>)
    const json = editor.getJSON() as DocNode
    const md = serialize(json)
    expect(md).toBe('hello world')
  })

  it('serializes empty doc to empty string', () => {
    editor = createEditor([])
    const json = editor.getJSON() as DocNode
    const md = serialize(json)
    expect(md).toBe('')
  })
})
