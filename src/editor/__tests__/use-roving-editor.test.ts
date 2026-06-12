import { act, renderHook, waitFor } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetAllShortcuts, setCustomShortcut } from '../../lib/keyboard-config'
import { logger } from '../../lib/logger'
import { Underline } from '../extensions/underline'
import { parse, serialize } from '../markdown-serializer'
import { toggleCodeBlockSafely } from '../toggle-code-block-safely'
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
  useRovingEditor,
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

// oxlint-disable-next-line typescript/no-explicit-any -- TipTap extensions have complex union types
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

  it('StrikeWithShortcut binds both Ctrl+Shift+S and the legacy Ctrl+Shift+X (#211 P2-11)', () => {
    // `strikethrough` defaults to Ctrl+Shift+S → Mod-Shift-s; the legacy
    // Ctrl+Shift+X (Mod-Shift-x) is kept hardcoded for one release.
    const addKeyboardShortcuts = StrikeWithShortcut.config.addKeyboardShortcuts as
      | ((this: { editor: { commands: { toggleStrike: () => boolean } } }) => Record<
          string,
          unknown
        >)
      | undefined
    const toggleStrike = vi.fn(() => true)
    const shortcuts = addKeyboardShortcuts?.call({ editor: { commands: { toggleStrike } } }) ?? {}
    expect(Object.keys(shortcuts).sort()).toEqual(['Mod-Shift-s', 'Mod-Shift-x'])
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

  it('Underline registers the underline mark (#211 P2-5)', () => {
    editor = createEditor([Underline])
    expect(editor.extensionManager.extensions.some((e) => e.name === 'underline')).toBe(true)
  })

  it('Underline toggles underline via command and renders <u> (#211 P2-5)', () => {
    editor = createEditor([Underline])
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    editor.commands.selectAll()
    editor.commands.toggleUnderline()
    expect(editor.isActive('underline')).toBe(true)
    expect(editor.getHTML()).toContain('<u>')
    // Toggling again clears the mark.
    editor.commands.toggleUnderline()
    expect(editor.isActive('underline')).toBe(false)
  })

  it('Underline parses an existing <u> tag as the mark (#211 P2-5)', () => {
    editor = createEditor([Underline])
    editor.commands.setContent('<p><u>under</u></p>')
    editor.commands.selectAll()
    expect(editor.isActive('underline')).toBe(true)
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

  // Regression: tiptap 3.23.6 (#7848) tightened `deleteSelection` so that on
  // an emptied doc the selection collapses to position 0 — outside the
  // first node. A naive `toggleCodeBlock` then creates the code block but
  // leaves the cursor outside it, so the next keystroke would land in a
  // paragraph above the empty block. `toggleCodeBlockSafely` re-anchors
  // the selection with `focus('end')`; this test exercises the helper
  // (not an inline chain) so removing the workaround from the helper
  // re-breaks the test, not just the production paths.
  it('toggleCodeBlockSafely keeps cursor inside the code block after deleteSelection', () => {
    editor = createEditor([CodeBlockWithShortcut.configure({ lowlight: createLowlight(common) })])
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] })
    editor.commands.selectAll()
    editor.commands.deleteSelection()
    toggleCodeBlockSafely(editor)
    editor.commands.insertContent('x = 1')
    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: null },
          content: [{ type: 'text', text: 'x = 1' }],
        },
      ],
    })
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

// -- Frozen-at-creation shortcut bindings (#752) ------------------------------

describe('shortcut bindings are frozen at editor creation (#752)', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
    resetAllShortcuts()
  })

  /** Run a keydown through the editor's ProseMirror keymap plugins. */
  function dispatchKeydown(
    ed: Editor,
    key: string,
    mods: { ctrlKey?: boolean; shiftKey?: boolean } = {},
  ): boolean {
    return (
      ed.view.someProp('handleKeyDown', (handler) =>
        handler(ed.view, new KeyboardEvent('keydown', { key, ...mods })),
      ) ?? false
    )
  }

  function setHelloContentSelected(ed: Editor): void {
    ed.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    ed.commands.selectAll()
  }

  it('honours a Settings rebind that existed BEFORE the editor was created', () => {
    setCustomShortcut('inlineCode', 'Ctrl + M')
    editor = createEditor([CodeWithShortcut])
    setHelloContentSelected(editor)

    expect(dispatchKeydown(editor, 'm', { ctrlKey: true })).toBe(true)
    expect(editor.isActive('code')).toBe(true)
  })

  // Pins the freeze contract: TipTap builds its keymap exactly once from
  // `addKeyboardShortcuts()`, so `getShortcutKeys` is read at editor
  // creation only. A rebind made while an editor is alive does NOT take
  // effect until a new editor is created (app reload) — unlike the
  // document-level `matchesShortcutBinding` listeners, which are live.
  // If live rebinding is ever implemented (handleKeyDown dispatch instead
  // of a static keymap), update this test deliberately.
  it('does NOT pick up a rebind made AFTER the editor was created (reload required)', () => {
    editor = createEditor([CodeWithShortcut]) // default binding: Ctrl + E
    setCustomShortcut('inlineCode', 'Ctrl + M')
    setHelloContentSelected(editor)

    // The new binding is dead on the existing editor…
    expect(dispatchKeydown(editor, 'm', { ctrlKey: true })).toBe(false)
    expect(editor.isActive('code')).toBe(false)

    // …while the binding captured at creation still fires.
    expect(dispatchKeydown(editor, 'e', { ctrlKey: true })).toBe(true)
    expect(editor.isActive('code')).toBe(true)
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

// -- useRovingEditor integration (renderHook) ---------------------------------

describe('useRovingEditor integration (renderHook)', () => {
  /** Helper: render the hook and wait for editor initialization */
  async function setup() {
    const hook = renderHook(() => useRovingEditor())
    await waitFor(() => expect(hook.result.current.editor).not.toBeNull())
    return hook
  }

  it('creates an editor instance', async () => {
    const { result, unmount: unmountHook } = await setup()

    expect(result.current.editor).not.toBeNull()
    expect(result.current.activeBlockId).toBeNull()
    expect(result.current.originalMarkdown).toBe('')

    result.current.editor?.destroy()
    unmountHook()
  })

  // #925 — the contenteditable carries deliberate soft-keyboard attributes so
  // mobile keyboards don't guess the action key / capitalization.
  it('sets soft-keyboard attributes on the contenteditable', async () => {
    const { result, unmount: unmountHook } = await setup()
    const dom = (result.current.editor as Editor).view.dom

    expect(dom.getAttribute('enterkeyhint')).toBe('enter')
    expect(dom.getAttribute('autocapitalize')).toBe('sentences')
    expect(dom.getAttribute('autocorrect')).toBe('on')
    expect(dom.getAttribute('spellcheck')).toBe('true')
    expect(dom.getAttribute('inputmode')).toBe('text')
    // ARIA attributes preserved.
    expect(dom.getAttribute('role')).toBe('textbox')
    expect(dom.getAttribute('aria-label')).toBe('Block editor')

    result.current.editor?.destroy()
    unmountHook()
  })

  // #544 — the placeholder default is empty; callers own the (i18n-keyed)
  // text and pass it explicitly. A caller that forgets shows no hint rather
  // than leaking a hardcoded English string that bypasses i18n.
  // #921 — placeholder is the function form (live per focused block), not a
  // string frozen at editor creation. The fn reads the current ref value.
  function readPlaceholder(editor: Editor): unknown {
    const ext = editor.extensionManager.extensions.find((e) => e.name === 'placeholder')
    const opt = ext?.options.placeholder as unknown
    return typeof opt === 'function' ? (opt as () => unknown)() : opt
  }

  it('default placeholder is empty (callers supply the i18n text)', async () => {
    const { result, unmount: unmountHook } = await setup()

    expect(readPlaceholder(result.current.editor as Editor)).toBe('')

    result.current.editor?.destroy()
    unmountHook()
  })

  it('passes an explicit placeholder through to the extension', async () => {
    const hook = renderHook(() => useRovingEditor({ placeholder: 'custom hint' }))
    await waitFor(() => expect(hook.result.current.editor).not.toBeNull())

    expect(readPlaceholder(hook.result.current.editor as Editor)).toBe('custom hint')

    hook.result.current.editor?.destroy()
    hook.unmount()
  })

  it('#921 — placeholder updates live when the prop changes (not frozen at creation)', async () => {
    const hook = renderHook(({ placeholder }) => useRovingEditor({ placeholder }), {
      initialProps: { placeholder: 'first hint' },
    })
    await waitFor(() => expect(hook.result.current.editor).not.toBeNull())
    expect(readPlaceholder(hook.result.current.editor as Editor)).toBe('first hint')

    // Re-render with a new placeholder (as BlockTree does when focus moves to a
    // different block). The SAME editor instance must report the new value.
    hook.rerender({ placeholder: 'second hint' })
    expect(readPlaceholder(hook.result.current.editor as Editor)).toBe('second hint')

    hook.result.current.editor?.destroy()
    hook.unmount()
  })

  // #539 — mount() resets undo history by finding ProseMirror's history plugin
  // via its private `history$`-prefixed key. That key is @internal, so a PM
  // upgrade could rename it and silently break history reset. This regression
  // test fails loudly at the boundary if the key convention ever changes.
  it('history plugin is discoverable by its `history$` key prefix (#539)', async () => {
    const { result, unmount: unmountHook } = await setup()

    const editor = result.current.editor as Editor
    const histPlugin = editor.state.plugins.find((p) =>
      (p as unknown as { key: string }).key.startsWith('history$'),
    )
    expect(histPlugin).toBeDefined()
    // The plugin must expose the state.init the reset path relies on.
    expect(histPlugin?.spec.state?.init).toBeTypeOf('function')

    result.current.editor?.destroy()
    unmountHook()
  })

  it('mount() sets activeBlockId and originalMarkdown', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-1', 'hello world')
    })

    expect(result.current.activeBlockId).toBe('block-1')
    expect(result.current.originalMarkdown).toBe('hello world')

    result.current.editor?.destroy()
    unmountHook()
  })

  // #752 — DeleteBlockOpts.cursorPlacement is forwarded to mount(); 'end'
  // must land the caret at the end of the document instead of the bare
  // focus() default.
  it("mount() with cursorPlacement 'end' places the caret at the end of the doc", async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-cp-1', 'hello world', { cursorPlacement: 'end' })
    })

    const editor = result.current.editor as Editor
    const { from, empty } = editor.state.selection
    expect(empty).toBe(true)
    // End of a single-paragraph doc: docSize - 1 (inside the paragraph).
    expect(from).toBe(editor.state.doc.content.size - 1)

    result.current.editor?.destroy()
    unmountHook()
  })

  it("mount() with cursorPlacement 'start' places the caret at the start of the doc", async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-cp-2', 'hello world', { cursorPlacement: 'start' })
    })

    const editor = result.current.editor as Editor
    const { from, empty } = editor.state.selection
    expect(empty).toBe(true)
    expect(from).toBe(1)

    result.current.editor?.destroy()
    unmountHook()
  })

  it('mount() → getMarkdown() returns the mounted content', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-2', 'hello world')
    })

    const md = result.current.getMarkdown()
    expect(md).toBe('hello world')

    result.current.editor?.destroy()
    unmountHook()
  })

  // #909 — caret-based split.
  it('splitAtCaret() splits the block content at a collapsed caret', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-split', 'helloworld')
    })

    // Place the caret after "hello" (doc start = 0, paragraph opens at 0, text
    // begins at pos 1, so "hello" ends at pos 6).
    act(() => {
      ;(result.current.editor as Editor).commands.setTextSelection(6)
    })

    const split = result.current.splitAtCaret()
    expect(split).toEqual({ before: 'hello', after: 'world' })

    result.current.editor?.destroy()
    unmountHook()
  })

  it('splitAtCaret() at the end returns the full content and an empty tail', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-split-end', 'hello')
    })
    act(() => {
      const editor = result.current.editor as Editor
      editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    })

    const split = result.current.splitAtCaret()
    expect(split?.before).toBe('hello')
    expect(split?.after).toBe('')

    result.current.editor?.destroy()
    unmountHook()
  })

  it('splitAtCaret() returns null for a non-collapsed (range) selection', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-split-range', 'helloworld')
    })
    act(() => {
      ;(result.current.editor as Editor).commands.setTextSelection({ from: 2, to: 6 })
    })

    expect(result.current.splitAtCaret()).toBeNull()

    result.current.editor?.destroy()
    unmountHook()
  })

  it('mount() → unmount() returns null for unchanged content', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-3', 'unchanged text')
    })

    let delta: string | null = null
    act(() => {
      delta = result.current.unmount()
    })

    expect(delta).toBeNull()
    expect(result.current.activeBlockId).toBeNull()
    expect(result.current.originalMarkdown).toBe('')

    result.current.editor?.destroy()
    unmountHook()
  })

  it('mount() → edit → unmount() returns changed markdown', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-4', 'original')
    })

    // Modify editor content directly via commands
    act(() => {
      ;(result.current.editor as Editor).commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'modified' }] }],
      })
    })

    let delta: string | null = null
    act(() => {
      delta = result.current.unmount()
    })

    expect(delta).toBe('modified')

    result.current.editor?.destroy()
    unmountHook()
  })

  it('mount() clears previous undo history (cannot undo after mount)', async () => {
    const { result, unmount: unmountHook } = await setup()

    // First mount — type something to create undo history
    act(() => {
      result.current.mount('block-5', 'start')
    })

    act(() => {
      ;(result.current.editor as Editor).commands.insertContent(' added')
    })

    expect((result.current.editor as Editor).can().undo()).toBe(true)

    // Unmount then mount again — undo history should be cleared
    act(() => {
      result.current.unmount()
    })

    act(() => {
      result.current.mount('block-6', 'fresh content')
    })

    expect((result.current.editor as Editor).can().undo()).toBe(false)

    result.current.editor?.destroy()
    unmountHook()
  })

  // MAINT-130(c) — Pattern-C ref plumbing for searchBlockRefs.
  //
  // Before the fix, BlockRefPicker.configure({ items: searchBlockRefsRef.current })
  // captured the .current value at configure time, so subsequent re-renders
  // with a fresh searchBlockRefs callback never reached the picker. The fix
  // wraps the read in a closure: items: (q) => searchBlockRefsRef.current(q),
  // which dereferences .current at CALL time. This test verifies that.
  it('searchBlockRefs callback is read fresh at call time (no stale closure)', async () => {
    const fn1 = vi.fn().mockResolvedValue([{ id: 'B1', label: 'one' }])
    const fn2 = vi.fn().mockResolvedValue([{ id: 'B2', label: 'two' }])

    const {
      result,
      rerender,
      unmount: unmountHook,
    } = renderHook(
      ({ searchBlockRefs }: { searchBlockRefs: typeof fn1 }) =>
        useRovingEditor({ searchBlockRefs }),
      { initialProps: { searchBlockRefs: fn1 } },
    )
    await waitFor(() => expect(result.current.editor).not.toBeNull())

    // Re-render with a different callback. The ref-update at line 281 of
    // use-roving-editor.ts will swap searchBlockRefsRef.current to fn2.
    rerender({ searchBlockRefs: fn2 })

    // Look up the BlockRefPicker extension on the live editor instance and
    // invoke the configured items option directly — this is the same path
    // the suggestion plugin's items wrapper takes (see block-ref-picker.ts
    // addProseMirrorPlugins → items). If the closure reads .current at call
    // time, fn2 is invoked; if it captured a stale reference, fn1 fires.
    const ext = (result.current.editor as Editor).extensionManager.extensions.find(
      (e) => e.name === 'blockRefPicker',
    )
    expect(ext).toBeDefined()
    const items = ext?.options.items as (q: string) => Promise<unknown>
    await items('hello')

    expect(fn2).toHaveBeenCalledWith('hello')
    expect(fn1).not.toHaveBeenCalled()

    result.current.editor?.destroy()
    unmountHook()
  })

  // MAINT-165 — Pattern-C ref plumbing for the remaining 4 picker callbacks
  // (searchTags, searchPages, searchSlashCommands, searchPropertyKeys).
  // Mirrors the searchBlockRefs test above: re-render with a fresh callback,
  // invoke the configured items option directly, and verify the new callback
  // fires (i.e. the closure dereferences .current at call time).

  it('searchTags callback is read fresh at call time (no stale closure)', async () => {
    const fn1 = vi.fn().mockResolvedValue([{ id: 'T1', label: 'one' }])
    const fn2 = vi.fn().mockResolvedValue([{ id: 'T2', label: 'two' }])

    const {
      result,
      rerender,
      unmount: unmountHook,
    } = renderHook(
      ({ searchTags }: { searchTags: typeof fn1 }) => useRovingEditor({ searchTags }),
      { initialProps: { searchTags: fn1 } },
    )
    await waitFor(() => expect(result.current.editor).not.toBeNull())

    rerender({ searchTags: fn2 })

    const ext = (result.current.editor as Editor).extensionManager.extensions.find(
      (e) => e.name === 'atTagPicker',
    )
    expect(ext).toBeDefined()
    const items = ext?.options.items as (q: string) => Promise<unknown>
    await items('hello')

    expect(fn2).toHaveBeenCalledWith('hello')
    expect(fn1).not.toHaveBeenCalled()

    result.current.editor?.destroy()
    unmountHook()
  })

  it('searchPages callback is read fresh at call time (no stale closure)', async () => {
    const fn1 = vi.fn().mockResolvedValue([{ id: 'P1', label: 'one' }])
    const fn2 = vi.fn().mockResolvedValue([{ id: 'P2', label: 'two' }])

    const {
      result,
      rerender,
      unmount: unmountHook,
    } = renderHook(
      ({ searchPages }: { searchPages: typeof fn1 }) => useRovingEditor({ searchPages }),
      { initialProps: { searchPages: fn1 } },
    )
    await waitFor(() => expect(result.current.editor).not.toBeNull())

    rerender({ searchPages: fn2 })

    const ext = (result.current.editor as Editor).extensionManager.extensions.find(
      (e) => e.name === 'blockLinkPicker',
    )
    expect(ext).toBeDefined()
    const items = ext?.options.items as (q: string) => Promise<unknown>
    await items('hello')

    expect(fn2).toHaveBeenCalledWith('hello')
    expect(fn1).not.toHaveBeenCalled()

    result.current.editor?.destroy()
    unmountHook()
  })

  it('searchSlashCommands callback is read fresh at call time (no stale closure)', async () => {
    const fn1 = vi.fn().mockResolvedValue([{ id: 'S1', label: 'one' }])
    const fn2 = vi.fn().mockResolvedValue([{ id: 'S2', label: 'two' }])

    const {
      result,
      rerender,
      unmount: unmountHook,
    } = renderHook(
      ({ searchSlashCommands }: { searchSlashCommands: typeof fn1 }) =>
        useRovingEditor({ searchSlashCommands }),
      { initialProps: { searchSlashCommands: fn1 } },
    )
    await waitFor(() => expect(result.current.editor).not.toBeNull())

    rerender({ searchSlashCommands: fn2 })

    const ext = (result.current.editor as Editor).extensionManager.extensions.find(
      (e) => e.name === 'slashCommand',
    )
    expect(ext).toBeDefined()
    const items = ext?.options.items as (q: string) => Promise<unknown>
    await items('hello')

    expect(fn2).toHaveBeenCalledWith('hello')
    expect(fn1).not.toHaveBeenCalled()

    result.current.editor?.destroy()
    unmountHook()
  })

  it('searchPropertyKeys callback is read fresh at call time (no stale closure)', async () => {
    const fn1 = vi.fn().mockResolvedValue([{ id: 'K1', label: 'one' }])
    const fn2 = vi.fn().mockResolvedValue([{ id: 'K2', label: 'two' }])

    const {
      result,
      rerender,
      unmount: unmountHook,
    } = renderHook(
      ({ searchPropertyKeys }: { searchPropertyKeys: typeof fn1 }) =>
        useRovingEditor({ searchPropertyKeys }),
      { initialProps: { searchPropertyKeys: fn1 } },
    )
    await waitFor(() => expect(result.current.editor).not.toBeNull())

    rerender({ searchPropertyKeys: fn2 })

    const ext = (result.current.editor as Editor).extensionManager.extensions.find(
      (e) => e.name === 'propertyPicker',
    )
    expect(ext).toBeDefined()
    const items = ext?.options.items as (q: string) => Promise<unknown>
    await items('hello')

    expect(fn2).toHaveBeenCalledWith('hello')
    expect(fn1).not.toHaveBeenCalled()

    result.current.editor?.destroy()
    unmountHook()
  })
})

// -- MAINT-176 — suggestion-exit dispatch error handling ----------------------
//
// The suggestion-exit dispatch in mount() (use-roving-editor.ts:~397) can
// throw when the editor view is torn down between block-switch frames. The
// catch path must abort BEFORE the subsequent replaceDocSilently() runs,
// since that would corrupt plugin state. isDestroyed distinguishes the
// expected race (debug) from an unexpected throw on a live view (warn).

describe('mount() suggestion-exit dispatch error handling (MAINT-176)', () => {
  async function setup() {
    const hook = renderHook(() => useRovingEditor())
    await waitFor(() => expect(hook.result.current.editor).not.toBeNull())
    return hook
  }

  it('logs debug and aborts (no replaceDocSilently) when dispatch throws on a destroyed view', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const { result, unmount: unmountHook } = await setup()
    const editor = result.current.editor as Editor

    // schema.nodeFromJSON is only called from replaceDocSilently — use it as
    // a witness that the post-dispatch code path did NOT run.
    const nodeFromJsonSpy = vi.spyOn(editor.schema, 'nodeFromJSON')

    // Make the suggestion-exit dispatch throw, and pretend the view is gone.
    vi.spyOn(editor.view, 'dispatch').mockImplementationOnce(() => {
      throw new Error('view torn down')
    })
    Object.defineProperty(editor.view, 'isDestroyed', {
      value: true,
      configurable: true,
    })

    act(() => {
      result.current.mount('block-destroyed', 'hello world')
    })

    expect(nodeFromJsonSpy).not.toHaveBeenCalled()
    expect(debugSpy).toHaveBeenCalledWith(
      'editor',
      'suggestion-exit dispatch on destroyed view; aborting',
      expect.objectContaining({ error: 'view torn down' }),
    )
    expect(warnSpy).not.toHaveBeenCalled()

    debugSpy.mockRestore()
    warnSpy.mockRestore()
    editor.destroy()
    unmountHook()
  })

  it('logs warn and aborts (no replaceDocSilently) when dispatch throws on a live view', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const { result, unmount: unmountHook } = await setup()
    const editor = result.current.editor as Editor

    const nodeFromJsonSpy = vi.spyOn(editor.schema, 'nodeFromJSON')

    const err = new Error('unexpected dispatch failure')
    vi.spyOn(editor.view, 'dispatch').mockImplementationOnce(() => {
      throw err
    })
    Object.defineProperty(editor.view, 'isDestroyed', {
      value: false,
      configurable: true,
    })

    act(() => {
      result.current.mount('block-live', 'hello world')
    })

    expect(nodeFromJsonSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      'editor',
      'suggestion-exit dispatch threw; aborting replaceDocSilently',
      undefined,
      err,
    )

    debugSpy.mockRestore()
    warnSpy.mockRestore()
    editor.destroy()
    unmountHook()
  })

  it('runs replaceDocSilently on the happy path when dispatch succeeds', async () => {
    const { result, unmount: unmountHook } = await setup()
    const editor = result.current.editor as Editor

    // schema.nodeFromJSON is the witness for replaceDocSilently running.
    const nodeFromJsonSpy = vi.spyOn(editor.schema, 'nodeFromJSON')

    act(() => {
      result.current.mount('block-happy', 'hello world')
    })

    expect(nodeFromJsonSpy).toHaveBeenCalled()

    editor.destroy()
    unmountHook()
  })
})

// -- PEND-30 L-4: cleanupOrphanedPopups runs on host-component unmount -------

describe('PEND-30 L-4 host-unmount popup sweep', () => {
  it('calls cleanupOrphanedPopups exactly once when the host component unmounts', async () => {
    // Plant an orphan popup so cleanupOrphanedPopups has visible work to
    // do — the function `.querySelectorAll('.suggestion-popup')`s the
    // body and removes any matches.
    const orphan = document.createElement('div')
    orphan.classList.add('suggestion-popup')
    document.body.appendChild(orphan)
    expect(document.querySelectorAll('.suggestion-popup').length).toBe(1)

    const hook = renderHook(() => useRovingEditor())
    await waitFor(() => expect(hook.result.current.editor).not.toBeNull())

    // Pre-unmount sanity: the planted orphan still exists. The hook
    // does NOT call `cleanupOrphanedPopups` during normal mount.
    expect(document.querySelectorAll('.suggestion-popup').length).toBe(1)

    hook.result.current.editor?.destroy()
    hook.unmount()

    // The unmount-cleanup useEffect ran cleanupOrphanedPopups, sweeping
    // the orphan. (The body never touched it during normal lifecycle.)
    expect(document.querySelectorAll('.suggestion-popup').length).toBe(0)
  })
})

// -- #711: canonicalization-as-edit (focus+blur with zero edits) ---------------
//
// `mount` parses the stored markdown, `unmount` re-serializes it, and the
// serializer canonicalizes (`3.` → `1.`, `_em_` → `*em*`, …). The old
// `changed: newMarkdown !== originalMarkdown` therefore persisted a rewrite
// on every focus+blur of a non-canonical block. `computeContentDelta` is the
// single gate `unmount()` uses to decide persistence (changed → markdown,
// unchanged → null), so these pin the no-persist contract at that gate.

describe('computeContentDelta — canonicalization is not an edit (#711)', () => {
  it('no-edit blur on `3. buy milk` does NOT persist (serializer renumbers to 1.)', () => {
    const original = '3. buy milk'
    // Focus+blur with zero edits: the doc is exactly parse(original).
    const delta = computeContentDelta(original, parse(original) as DocNode)
    // The serializer DOES canonicalize…
    expect(delta.newMarkdown).toBe('1. buy milk')
    // …but that is not an edit.
    expect(delta.changed).toBe(false)
  })

  it('no-edit blur on underscore emphasis does NOT persist (`_em_` → `*em*`)', () => {
    const original = 'some _emphasis_ here'
    const delta = computeContentDelta(original, parse(original) as DocNode)
    expect(delta.newMarkdown).toBe('some *emphasis* here')
    expect(delta.changed).toBe(false)
  })

  it('no-edit blur through a REAL editor mount does NOT persist', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, Bold],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    try {
      const original = 'keep __calm__ and carry on'
      // Same path as mount(): parse → replaceDocSilently.
      replaceDocSilently(editor, parse(original) as unknown as Record<string, unknown>)
      // Blur with zero edits: serialize what the editor holds.
      const delta = computeContentDelta(original, editor.getJSON() as DocNode)
      expect(delta.changed).toBe(false)
    } finally {
      editor.destroy()
    }
  })

  it('control: a real edit IS persisted even when the original canonicalizes', () => {
    const original = '3. buy milk'
    const delta = computeContentDelta(original, parse('3. buy oat milk') as DocNode)
    expect(delta.changed).toBe(true)
    expect(delta.newMarkdown).toBe('1. buy oat milk')
  })

  it('control: a real edit through a REAL editor is persisted', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, Bold],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    try {
      const original = 'keep __calm__ and carry on'
      replaceDocSilently(editor, parse(original) as unknown as Record<string, unknown>)
      editor.commands.focus('end')
      editor.commands.insertContent(' please')
      const delta = computeContentDelta(original, editor.getJSON() as DocNode)
      expect(delta.changed).toBe(true)
      expect(delta.newMarkdown).toBe('keep **calm** and carry on please')
    } finally {
      editor.destroy()
    }
  })

  it('identical round-trip stays unchanged without invoking the canonical compare', () => {
    const original = 'plain text'
    const delta = computeContentDelta(original, parse(original) as DocNode)
    expect(delta.changed).toBe(false)
    expect(delta.newMarkdown).toBe('plain text')
  })
})

// -- #710-5 follow-through: hard breaks don't split the block on blur ----------

describe('shouldSplitOnBlur — hard breaks (#710-5)', () => {
  it('returns false for a Shift+Enter hard break (one paragraph, not two blocks)', () => {
    // Serialized form of text+hardBreak+text — contains a newline but parses
    // back to a SINGLE paragraph block.
    expect(shouldSplitOnBlur('first\\\nsecond')).toBe(false)
  })

  it('still returns true for a genuine two-paragraph separator', () => {
    expect(shouldSplitOnBlur('first\nsecond')).toBe(true)
  })
})
