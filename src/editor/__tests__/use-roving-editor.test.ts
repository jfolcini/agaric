import { act, renderHook, waitFor } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import History from '@tiptap/extension-history'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BLOCK_EVENTS } from '../../lib/block-events'
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
    parse: vi.fn((...args: Parameters<typeof actual.parse>) => actual.parse(...args)),
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

  // #1251: the producer now routes through the typed `dispatchBlockEvent`
  // helper, so the emitted name must equal the `BLOCK_EVENTS` constant a
  // listener subscribes to (no hand-matched literal that could silently
  // desync on a rename). Assert producer ↔ constant for each level.
  it.each([
    [1, BLOCK_EVENTS.SET_PRIORITY_1],
    [2, BLOCK_EVENTS.SET_PRIORITY_2],
    [3, BLOCK_EVENTS.SET_PRIORITY_3],
  ] as const)('dispatches the typed BLOCK_EVENTS constant for level %i', (level, eventName) => {
    let receivedType: string | null = null
    const handler = (e: Event) => {
      receivedType = e.type
    }
    document.addEventListener(eventName, handler)
    dispatchPriorityEvent(level)
    expect(receivedType).toBe(eventName)
    document.removeEventListener(eventName, handler)
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

  // #1630 — the blur flush calls shouldSplitOnBlur with the same content more
  // than once (Step 3 early-persist check + Step 5 split decision). The
  // single-entry parse memo must reuse the parse for back-to-back identical
  // strings, parsing once instead of twice, while returning the same result.
  it('parses the same markdown only once across back-to-back calls (#1630)', () => {
    const mockedParse = vi.mocked(parse)
    mockedParse.mockClear()
    // Use content unique to this test so the module-level memo starts cold for
    // it (a string parsed by an earlier test would already be cached).
    const md = '# Memo dedup title\nMemo dedup paragraph'
    expect(shouldSplitOnBlur(md)).toBe(true)
    expect(shouldSplitOnBlur(md)).toBe(true)
    expect(mockedParse).toHaveBeenCalledTimes(1)
  })

  it('skips the parse entirely when given an already-parsed DocNode (#1630)', () => {
    const mockedParse = vi.mocked(parse)
    const doc = parse('# Title\nParagraph')
    mockedParse.mockClear()
    // Different string than the doc to prove the doc (not the string) is used.
    expect(shouldSplitOnBlur('ignored\nstring', doc)).toBe(true)
    expect(shouldSplitOnBlur('a\nb', { type: 'doc', content: [{ type: 'paragraph' }] })).toBe(false)
    expect(mockedParse).not.toHaveBeenCalled()
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
    expect(Object.keys(shortcuts).toSorted()).toEqual(['Mod-Shift-s', 'Mod-Shift-x'])
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

// -- Editor keymap key→action firing (#1172) ----------------------------------
//
// The existing `custom extension keyboard shortcuts` suite above asserts the
// extensions REGISTER and that the toggle commands work, plus that the strike
// keymap exposes both `Mod-Shift-s` and `Mod-Shift-x` (#211 P2-11). What was
// missing: driving the ACTUAL keydown chord through ProseMirror's keymap and
// asserting the resulting action — the key→action contract these tests pin.
//   • priority1/2/3 — Ctrl+Shift+1/2/3 must dispatch the `set-priority-N`
//     CustomEvent on `document` (the priority handler the toolbar listens on).
//   • strikethrough legacy alias — Ctrl+Shift+X must still toggle strike for
//     one release, alongside the primary Ctrl+Shift+S.
describe('editor keymap key→action firing (#1172)', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
    resetAllShortcuts()
  })

  /** Run a keydown through the editor's ProseMirror keymap plugins. */
  function dispatchKeydown(
    ed: Editor,
    key: string,
    mods: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {},
  ): boolean {
    return (
      ed.view.someProp('handleKeyDown', (handler) =>
        handler(ed.view, new KeyboardEvent('keydown', { key, ...mods })),
      ) ?? false
    )
  }

  function setHelloSelected(ed: Editor): void {
    ed.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    ed.commands.selectAll()
  }

  it.each([
    [1, '1'],
    [2, '2'],
    [3, '3'],
  ] as const)('priority%i — Ctrl+Shift+%s dispatches the set-priority-%i event', (level, digit) => {
    editor = createEditor([PriorityShortcuts])
    const spy = vi.fn()
    document.addEventListener(`set-priority-${level}`, spy)
    try {
      const handled = dispatchKeydown(editor, digit, { ctrlKey: true, shiftKey: true })
      expect(handled).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener(`set-priority-${level}`, spy)
    }
  })

  it('priority chord does NOT fire on a bare Ctrl+digit (that is heading/space)', () => {
    editor = createEditor([PriorityShortcuts])
    const spy = vi.fn()
    document.addEventListener('set-priority-1', spy)
    try {
      // Ctrl+1 (no Shift) is the heading / switchSpace chord — the priority
      // keymap (Mod-Shift-1) must not claim it.
      dispatchKeydown(editor, '1', { ctrlKey: true })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('set-priority-1', spy)
    }
  })

  it('strikethrough — primary Ctrl+Shift+S toggles the strike mark', () => {
    editor = createEditor([StrikeWithShortcut])
    setHelloSelected(editor)

    const handled = dispatchKeydown(editor, 's', { ctrlKey: true, shiftKey: true })

    expect(handled).toBe(true)
    expect(editor.isActive('strike')).toBe(true)
  })

  it('strikethrough — legacy Ctrl+Shift+X alias still toggles strike (#211 P2-11)', () => {
    editor = createEditor([StrikeWithShortcut])
    setHelloSelected(editor)

    const handled = dispatchKeydown(editor, 'x', { ctrlKey: true, shiftKey: true })

    expect(handled).toBe(true)
    expect(editor.isActive('strike')).toBe(true)
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

// -- insertLineBreak (Shift+Enter hard break) #1172 ---------------------------
//
// The `insertLineBreak` catalog binding (Shift + Enter, documentation-only /
// `rebindable: false`) is fulfilled by TipTap's HardBreak extension keymap,
// which registers `Shift-Enter` → `setHardBreak()` (and `Mod-Enter` as an
// alias). The block-level handler deliberately ignores Shift+Enter (asserted
// in use-block-keyboard.test) so the keystroke reaches this keymap. Here we
// drive the real keymap through ProseMirror and assert the side effect: a
// `hardBreak` node is inserted at the caret instead of splitting the block.
describe('insertLineBreak — Shift+Enter hard break (#1172)', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

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

  function countHardBreaks(ed: Editor): number {
    let n = 0
    ed.state.doc.descendants((node) => {
      if (node.type.name === 'hardBreak') n += 1
    })
    return n
  }

  it('registers the HardBreak extension', () => {
    editor = createEditor([HardBreak])
    expect(editor.extensionManager.extensions.some((e) => e.name === 'hardBreak')).toBe(true)
  })

  it('Shift+Enter inserts a hardBreak node (does not split the paragraph)', () => {
    editor = createEditor([HardBreak])
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    // Caret at end of the single paragraph.
    editor.commands.focus('end')
    expect(countHardBreaks(editor)).toBe(0)

    const handled = dispatchKeydown(editor, 'Enter', { shiftKey: true })

    expect(handled).toBe(true)
    expect(countHardBreaks(editor)).toBe(1)
    // Still ONE paragraph — a hard break is a soft return, not a block split.
    let paragraphs = 0
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'paragraph') paragraphs += 1
    })
    expect(paragraphs).toBe(1)
  })

  it('Mod+Enter also inserts a hardBreak (HardBreak alias)', () => {
    editor = createEditor([HardBreak])
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    editor.commands.focus('end')

    const handled = dispatchKeydown(editor, 'Enter', { ctrlKey: true })

    expect(handled).toBe(true)
    expect(countHardBreaks(editor)).toBe(1)
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

  // #726 — the extensions array is built once (useMemo with []) and keeps a
  // stable identity across renders. Without this, `useEditor` (deps.length===0
  // path) diffed a fresh array of fresh `.configure()` instances every render,
  // `compareOptions` failed unconditionally, and `setOptions` + view.updateState
  // churned on EVERY BlockTree render. This file is plain `.ts`, so the React
  // Compiler (which only transforms `.tsx`/`.jsx`) does NOT memoize it for us.
  it('#726 — editor identity + extensions array are stable across benign re-renders', async () => {
    const hook = renderHook(({ placeholder }) => useRovingEditor({ placeholder }), {
      initialProps: { placeholder: 'hint' },
    })
    await waitFor(() => expect(hook.result.current.editor).not.toBeNull())

    const editor = hook.result.current.editor as Editor
    const firstExtensions = editor.options.extensions
    // setOptions is what view.updateState churn flows through; on a re-render
    // with unchanged inputs it must NOT be called (compareOptions short-circuits
    // because the memoized extensions array keeps its identity).
    const setOptionsSpy = vi.spyOn(editor, 'setOptions')

    // Several re-renders that change nothing observable about the editor.
    hook.rerender({ placeholder: 'hint' })
    hook.rerender({ placeholder: 'hint' })
    hook.rerender({ placeholder: 'hint' })

    // Same editor instance — never destroyed/recreated.
    expect(hook.result.current.editor).toBe(editor)
    // Same extensions array reference — the memo held.
    expect((hook.result.current.editor as Editor).options.extensions).toBe(firstExtensions)
    // No churn: setOptions never fired across the benign re-renders.
    expect(setOptionsSpy).not.toHaveBeenCalled()

    setOptionsSpy.mockRestore()
    hook.result.current.editor?.destroy()
    hook.unmount()
  })

  // #726 (both halves together) — when the placeholder SOURCE changes (locale
  // switch / template hint moving with focus, as BlockTree drives it), the
  // displayed text must go LIVE on the same editor WITHOUT recreating the editor
  // and WITHOUT `setOptions` churn. The live text rides the ref'd-callback
  // (`placeholder: () => placeholderRef.current`) inside the *stable* memoized
  // extensions array — proving the identity-stability fix did NOT re-freeze the
  // placeholder the way a captured string would have.
  it('#726 — placeholder goes live on placeholder change without editor recreation or setOptions churn', async () => {
    const hook = renderHook(({ placeholder }) => useRovingEditor({ placeholder }), {
      initialProps: { placeholder: 'en hint' },
    })
    await waitFor(() => expect(hook.result.current.editor).not.toBeNull())

    const editor = hook.result.current.editor as Editor
    const firstExtensions = editor.options.extensions
    expect(readPlaceholder(editor)).toBe('en hint')

    const setOptionsSpy = vi.spyOn(editor, 'setOptions')

    // Locale/template source changes — exactly what BlockTree does when focus
    // moves or `t(...)` resolves a different string.
    hook.rerender({ placeholder: 'fr indice' })

    // Live text: the SAME editor now reports the new placeholder.
    expect(readPlaceholder(hook.result.current.editor as Editor)).toBe('fr indice')
    // Same editor instance — the placeholder change did NOT recreate it.
    expect(hook.result.current.editor).toBe(editor)
    // Same extensions array reference — liveness rides the ref, not a rebuild.
    expect((hook.result.current.editor as Editor).options.extensions).toBe(firstExtensions)
    // And no churn: liveness costs zero `setOptions`/`view.updateState` calls.
    expect(setOptionsSpy).not.toHaveBeenCalled()

    setOptionsSpy.mockRestore()
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

  // #1691 — split exactly on an active-mark boundary. The caret sits at the
  // seam between a bold run and a plain run; both halves must round-trip and
  // the bold must survive on the before-half (doc.cut carries spanning marks).
  it('splitAtCaret() at an active-mark boundary keeps the mark on the before-half', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      // "**bold**plain" → bold run "bold", then plain "plain".
      result.current.mount('block-split-mark', '**bold**plain')
    })

    // Caret right after the bold run (text begins at pos 1, "bold" = 4 chars,
    // so the boundary between bold and plain is pos 5).
    act(() => {
      ;(result.current.editor as Editor).commands.setTextSelection(5)
    })

    const split = result.current.splitAtCaret()
    // Before-half is the whole bold run; after-half is the plain run.
    expect(split).toEqual({ before: '**bold**', after: 'plain' })

    result.current.editor?.destroy()
    unmountHook()
  })

  // #1691 — split INSIDE an active mark (not on its boundary). Both halves
  // carry the mark across the seam, so each half re-serializes its own bold
  // wrapper. This is the case where a naive cut could drop the mark on one
  // side; doc.cut preserves it on both.
  it('splitAtCaret() inside an active mark wraps both halves in the mark', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-split-inside-mark', '**bold text**')
    })

    // Caret after "bold" (pos 1 + 4 = 5), still inside the bold span.
    act(() => {
      ;(result.current.editor as Editor).commands.setTextSelection(5)
    })

    const split = result.current.splitAtCaret()
    // Both halves keep the bold mark across the seam.
    expect(split).toEqual({ before: '**bold**', after: '** text**' })

    result.current.editor?.destroy()
    unmountHook()
  })

  // #1691 — split adjacent to an inline atom (tag_ref). Caret BEFORE the atom:
  // the before-half holds the leading text, the after-half holds the atom and
  // the atom must round-trip as `#[ULID]`.
  it('splitAtCaret() before an inline atom keeps the atom whole on the after-half', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      // "hi " + tag_ref(ULID). The atom is a single inline atom node;
      // `#[ULID]` only parses to tag_ref when the id is a real 26-char ULID.
      result.current.mount('block-split-atom-before', 'hi #[01ARZ3NDEKTSV4RRFFQ69G5FAV]')
    })

    // Find the position of the tag_ref atom and place the caret right before it.
    const editor = result.current.editor as Editor
    let atomPos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tag_ref') atomPos = pos
      return true
    })
    expect(atomPos).toBeGreaterThan(0)
    act(() => {
      editor.commands.setTextSelection(atomPos)
    })

    const split = result.current.splitAtCaret()
    expect(split?.before).toBe('hi ')
    expect(split?.after).toBe('#[01ARZ3NDEKTSV4RRFFQ69G5FAV]')

    result.current.editor?.destroy()
    unmountHook()
  })

  // #1691 — split adjacent to an inline atom (tag_ref). Caret AFTER the atom:
  // the before-half holds the atom (round-tripping as `#[ULID]`), the
  // after-half holds the trailing text.
  it('splitAtCaret() after an inline atom keeps the atom whole on the before-half', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-split-atom-after', '#[01ARZ3NDEKTSV4RRFFQ69G5FAV] bye')
    })

    // Position right after the atom: atom occupies one position, so caret = pos+1.
    const editor = result.current.editor as Editor
    let atomPos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tag_ref') atomPos = pos
      return true
    })
    expect(atomPos).toBeGreaterThanOrEqual(0)
    act(() => {
      editor.commands.setTextSelection(atomPos + 1)
    })

    const split = result.current.splitAtCaret()
    expect(split?.before).toBe('#[01ARZ3NDEKTSV4RRFFQ69G5FAV]')
    expect(split?.after).toBe(' bye')

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

  // (c) — Pattern-C ref plumbing for searchBlockRefs.
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

  // Pattern-C ref plumbing for the remaining 4 picker callbacks
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

// -- suggestion-exit dispatch error handling ----------------------
//
// The suggestion-exit dispatch in mount() (use-roving-editor.ts:~397) can
// throw when the editor view is torn down between block-switch frames. The
// catch path must abort BEFORE the subsequent replaceDocSilently() runs,
// since that would corrupt plugin state. isDestroyed distinguishes the
// expected race (debug) from an unexpected throw on a live view (warn).

describe('mount() suggestion-exit dispatch error handling', () => {
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

// -- #727 — roving-editor lifecycle hardening ---------------------------------
//
// (1) mount-abort mis-attribution: a mount aborted by a throwing suggestion-exit
//     dispatch must NOT leave activeBlockId/originalMarkdown pointing at the new
//     block while the document still holds the old block's content.
// (2) unguarded unmount dispatch: a throw from unmount()'s suggestion-exit
//     dispatch must NOT escape unmount() and skip the serialize-with-fallback.

describe('#727 mount-abort mis-attribution', () => {
  async function setup() {
    const hook = renderHook(() => useRovingEditor())
    await waitFor(() => expect(hook.result.current.editor).not.toBeNull())
    return hook
  }

  it('aborted mount keeps the PRIOR block id + original markdown (not the new block)', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const { result, unmount: unmountHook } = await setup()
    const editor = result.current.editor as Editor

    // First mount succeeds → identity is block-A.
    act(() => {
      result.current.mount('block-A', 'alpha content')
    })
    expect(result.current.activeBlockId).toBe('block-A')
    expect(result.current.originalMarkdown).toBe('alpha content')

    // Second mount aborts: suggestion-exit dispatch throws on a destroyed view.
    vi.spyOn(editor.view, 'dispatch').mockImplementationOnce(() => {
      throw new Error('view torn down')
    })
    Object.defineProperty(editor.view, 'isDestroyed', { value: true, configurable: true })

    act(() => {
      result.current.mount('block-B', 'beta content')
    })

    // The aborted mount must NOT have re-attributed identity to block-B —
    // otherwise the next flush serializes block-A's doc under block-B's id.
    expect(result.current.activeBlockId).toBe('block-A')
    expect(result.current.originalMarkdown).toBe('alpha content')

    debugSpy.mockRestore()
    Object.defineProperty(editor.view, 'isDestroyed', { value: false, configurable: true })
    editor.destroy()
    unmountHook()
  })

  it('successful mount DOES commit the new block id + original markdown', async () => {
    const { result, unmount: unmountHook } = await setup()

    act(() => {
      result.current.mount('block-A', 'alpha')
    })
    act(() => {
      result.current.mount('block-B', 'beta')
    })

    expect(result.current.activeBlockId).toBe('block-B')
    expect(result.current.originalMarkdown).toBe('beta')

    result.current.editor?.destroy()
    unmountHook()
  })
})

describe('#727 unmount suggestion-exit dispatch is guarded', () => {
  async function setup() {
    const hook = renderHook(() => useRovingEditor())
    await waitFor(() => expect(hook.result.current.editor).not.toBeNull())
    return hook
  }

  it('a throwing suggestion-exit dispatch does NOT escape unmount — serialize + reset still run', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { result, unmount: unmountHook } = await setup()
    const editor = result.current.editor as Editor

    act(() => {
      result.current.mount('block-1', 'original')
    })
    // Edit so there is content to capture if the serialize path is reached.
    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited' }] }],
      })
    })

    // unmount() dispatches twice: (1) suggestion-exit, (2) replaceDocSilently in
    // the finally. Make ONLY the first throw (on a live view → warn path).
    Object.defineProperty(editor.view, 'isDestroyed', { value: false, configurable: true })
    vi.spyOn(editor.view, 'dispatch').mockImplementationOnce(() => {
      throw new Error('exit dispatch boom')
    })

    let returned: string | null = null
    let threw = false
    act(() => {
      try {
        returned = result.current.unmount()
      } catch {
        threw = true
      }
    })

    // The throw was swallowed — unmount() did NOT propagate it.
    expect(threw).toBe(false)
    // The serialize ran and captured the edit (data-loss protection intact).
    expect(returned).toBe('edited')
    // Refs were reset in the finally despite the earlier throw.
    expect(result.current.activeBlockId).toBeNull()
    expect(result.current.originalMarkdown).toBe('')
    // The live-view throw was logged at warn (not debug).
    expect(warnSpy).toHaveBeenCalledWith(
      'editor',
      'unmount suggestion-exit dispatch threw; continuing to serialize',
      undefined,
      expect.any(Error),
    )

    debugSpy.mockRestore()
    warnSpy.mockRestore()
    editor.destroy()
    unmountHook()
  })

  it('logs debug (not warn) when the throwing view is destroyed, and still resets', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { result, unmount: unmountHook } = await setup()
    const editor = result.current.editor as Editor

    act(() => {
      result.current.mount('block-1', 'original')
    })

    Object.defineProperty(editor.view, 'isDestroyed', { value: true, configurable: true })
    vi.spyOn(editor.view, 'dispatch').mockImplementationOnce(() => {
      throw new Error('view torn down')
    })

    act(() => {
      result.current.unmount()
    })

    expect(debugSpy).toHaveBeenCalledWith(
      'editor',
      'unmount suggestion-exit dispatch on destroyed view; continuing',
      expect.objectContaining({ error: 'view torn down' }),
    )
    expect(warnSpy).not.toHaveBeenCalledWith(
      'editor',
      'unmount suggestion-exit dispatch threw; continuing to serialize',
      undefined,
      expect.anything(),
    )
    expect(result.current.activeBlockId).toBeNull()

    debugSpy.mockRestore()
    warnSpy.mockRestore()
    Object.defineProperty(editor.view, 'isDestroyed', { value: false, configurable: true })
    editor.destroy()
    unmountHook()
  })
})

// -- cleanupOrphanedPopups runs on host-component unmount -------

describe('  host-unmount popup sweep', () => {
  it('calls cleanupOrphanedPopups exactly once when the host component unmounts', async () => {
    // Plant an orphan popup so cleanupOrphanedPopups has visible work to
    // do — the function `.querySelectorAll('.suggestion-popup')`s the
    // body and removes any matches.
    const orphan = document.createElement('div')
    orphan.classList.add('suggestion-popup')
    document.body.append(orphan)
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
