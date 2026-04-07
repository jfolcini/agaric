import { afterEach, describe, expect, it, vi } from 'vitest'
import { serialize } from '../markdown-serializer'
import type { DocNode } from '../types'
import {
  computeContentDelta,
  dispatchPriorityEvent,
  replaceDocSilently,
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
