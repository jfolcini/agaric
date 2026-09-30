/**
 * Tests for the AtTagPicker extension.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AtTagPicker } from '@/editor/extensions/at-tag-picker'
import { TagRef } from '@/editor/extensions/tag-ref'
import type { PickerItem } from '@/editor/SuggestionList'

describe('AtTagPicker', () => {
  it('creates an extension with the correct name', () => {
    const ext = AtTagPicker.configure({ items: () => [] })
    expect(ext.name).toBe('atTagPicker')
  })

  it('has default items option', () => {
    const ext = AtTagPicker.configure({})
    expect(ext.options.items).toBeDefined()
  })
})

// ── ──────────────────────────────────────────────────────────────
//
// `insertContentAt(insertPos, ...)` clamps silently rather than throwing
// when `insertPos` is past the doc's end. The user can edit (or clear) the
// doc between the picker capturing `insertPos` and the async resolve
// landing — so the existing try/catch fallback never fires on that path.
// The picker must validate `insertPos <= doc.content.size` before calling
// `insertContentAt`, and fall back to plain text at the current cursor
// when the offset is stale.

describe('AtTagPicker stale-insertPos guard ()', () => {
  it('falls back to plain text at cursor when insertPos > doc.content.size', async () => {
    const insertContentCalls: unknown[] = []
    const insertContentAtCalls: Array<{ pos: number; content: unknown }> = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      insertContent: (content: unknown) => {
        insertContentCalls.push(content)
        return chainProxy
      },
      insertContentAt: (pos: number, content: unknown) => {
        insertContentAtCalls.push({ pos, content })
        return chainProxy
      },
      run: () => true,
    }
    // Simulate the doc shrinking after the picker captured insertPos: the
    // captured offset (10) is greater than the live doc.content.size (5).
    const mockEditor = {
      chain: () => chainProxy,
      state: { doc: { content: { size: 5 } } },
    } as unknown

    const mockItems = vi
      .fn()
      .mockResolvedValue([{ id: 'TAG_ULID_1', label: 'myTag', isCreate: false }])
    const ext = AtTagPicker.configure({ items: mockItems })

    const rules = (
      ext.config.addInputRules as unknown as (
        ...args: unknown[]
      ) => [{ handler: (...a: unknown[]) => unknown }]
    ).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { insertText: vi.fn() } }
    rule.handler({
      state: mockState,
      range: { from: 10, to: 16 },
      match: Object.assign(['#myTag '], {
        data: { name: 'myTag', typed: '#myTag', terminator: ' ' },
      }),
    })

    // Wait for the async resolve to land on the cursor-fallback path.
    await vi.waitFor(() => expect(insertContentCalls.length).toBeGreaterThan(0))

    // Plain text inserted at the current cursor (insertContent),
    // NOT the inline node at the stale offset.
    expect(insertContentCalls).toEqual(['#myTag'])
    expect(insertContentAtCalls).toEqual([])
  })
})

// ── Suggestion plugin `command` — insertion behaviour ─────────────
//
// #4708: after picking a tag from the @ suggestion popup, the chain inserts
// the chip and NOTHING else — no trailing space for the user to backspace.

describe('AtTagPicker suggestion plugin configuration', () => {
  // Regression guard for query-blocks failures. Typing
  // `{{query property:context=@office}}` previously triggered the at-tag
  // picker because `allowedPrefixes: null` let `@` fire after any character.
  // Enter then created a `Create 'office}}'` tag instead of saving the
  // block. Pinning the prefix set here ensures the picker only opens when
  // `@` is preceded by whitespace (or starts a block), matching the
  // Suggestion plugin's own default.
  it('restricts @ to whitespace/start-of-block prefixes and leaves # to the tag rule', async () => {
    const captured: Array<Record<string, unknown>> = []
    vi.resetModules()
    vi.doMock('@tiptap/suggestion', () => ({
      Suggestion: (opts: Record<string, unknown>) => {
        captured.push(opts)
        return { key: opts['pluginKey'] }
      },
    }))
    const mod = await import('@/editor/extensions/at-tag-picker')
    const ext = mod.AtTagPicker.configure({ items: () => [] })
    ;(ext.config.addProseMirrorPlugins as (...args: unknown[]) => unknown).call({
      editor: {} as unknown,
      options: ext.options,
    })
    expect(captured.map((opts) => opts['char'])).toEqual(['@', '#'])
    // Space, NBSP (ProseMirror normalises a trailing ASCII space to U+00A0
    // when it's the last character in a paragraph), and newline are all
    // valid prefixes that let the picker open mid-block. `\0` is appended
    // by TipTap internally so empty/start-of-block prefixes also match.
    expect(captured[0]?.['allowedPrefixes']).toEqual([' ', '\u00A0', '\n'])
    // `#` opens exactly where a space would make a tag, which its `allow`
    // decides (hash-tag.test.ts pins where that is).
    expect(captured[1]?.['allowedPrefixes']).toBeNull()
    // `@multi word` searches with spaces; `#` ends at one, where the typed
    // tag takes over.
    expect(captured[0]?.['allowSpaces']).toBe(true)
    expect(captured[0]?.['allow']).toBeUndefined()
    expect(captured[1]?.['allowSpaces']).toBe(false)
    expect(captured[1]?.['allow']).toBeTypeOf('function')

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })
})

describe('AtTagPicker suggestion command chain', () => {
  it('non-create path chains deleteRange → insertTagRef → run, with no trailing space', async () => {
    let capturedCommand:
      | ((ctx: { editor: unknown; range: { from: number; to: number }; props: unknown }) => void)
      | undefined
    vi.resetModules()
    vi.doMock('@tiptap/suggestion', () => ({
      Suggestion: (opts: Record<string, unknown>) => {
        capturedCommand = opts['command'] as typeof capturedCommand
        return { key: opts['pluginKey'] }
      },
    }))
    const mod = await import('@/editor/extensions/at-tag-picker')
    const ext = mod.AtTagPicker.configure({ items: () => [] })
    ;(ext.config.addProseMirrorPlugins as (...args: unknown[]) => unknown).call({
      editor: {} as unknown,
      options: ext.options,
    })
    expect(capturedCommand).toBeDefined()

    const calls: string[] = []
    const chainProxy: Record<string, unknown> = {
      focus: () => {
        calls.push('focus')
        return chainProxy
      },
      deleteRange: (r: { from: number; to: number }) => {
        calls.push(`deleteRange:${r.from}-${r.to}`)
        return chainProxy
      },
      insertTagRef: (id: string) => {
        calls.push(`insertTagRef:${id}`)
        return chainProxy
      },
      insertContent: (c: unknown) => {
        calls.push(`insertContent:${JSON.stringify(c)}`)
        return chainProxy
      },
      run: () => {
        calls.push('run')
        return true
      },
    }
    const mockEditor = { chain: () => chainProxy }

    capturedCommand?.({
      editor: mockEditor,
      range: { from: 2, to: 7 },
      props: { id: 'TAG_ULID', label: 'myTag', isCreate: false },
    })

    expect(calls).toEqual(['focus', 'deleteRange:2-7', 'insertTagRef:TAG_ULID', 'run'])

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })

  it('isCreate path deletes the trigger synchronously, then inserts the token after onCreate resolves', async () => {
    let capturedCommand:
      | ((ctx: { editor: unknown; range: { from: number; to: number }; props: unknown }) => void)
      | undefined
    vi.resetModules()
    vi.doMock('@tiptap/suggestion', () => ({
      Suggestion: (opts: Record<string, unknown>) => {
        capturedCommand = opts['command'] as typeof capturedCommand
        return { key: opts['pluginKey'] }
      },
    }))
    const mod = await import('@/editor/extensions/at-tag-picker')
    const onCreate = vi.fn().mockResolvedValue('NEW_TAG_ULID')
    const ext = mod.AtTagPicker.configure({ items: () => [], onCreate })
    ;(ext.config.addProseMirrorPlugins as (...args: unknown[]) => unknown).call({
      editor: {} as unknown,
      options: ext.options,
    })

    const calls: string[] = []
    const chainProxy: Record<string, unknown> = {
      focus: () => {
        calls.push('focus')
        return chainProxy
      },
      deleteRange: (r: { from: number; to: number }) => {
        calls.push(`deleteRange:${r.from}-${r.to}`)
        return chainProxy
      },
      insertContentAt: (pos: number, content: unknown) => {
        calls.push(`insertContentAt:${pos}:${JSON.stringify(content)}`)
        return chainProxy
      },
      run: () => {
        calls.push('run')
        return true
      },
    }
    const mockEditor = {
      chain: () => chainProxy,
      state: { doc: { textBetween: () => '@newTag' } },
      on: vi.fn(),
      off: vi.fn(),
      isDestroyed: false,
    }

    capturedCommand?.({
      editor: mockEditor,
      range: { from: 9, to: 14 },
      props: { id: 'PLACEHOLDER', label: 'newTag', isCreate: true },
    })

    // The trigger range is deleted SYNCHRONOUSLY — before the create IPC
    // resolves — so the Suggestion match breaks, the popup closes, and a
    // second Enter/click cannot double-fire the create.
    expect(calls).toEqual(['focus', 'deleteRange:9-14', 'run'])

    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith('newTag'))
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(3))

    // The token — and only the token — lands at the captured (tracked) position.
    expect(calls.slice(3)).toEqual([
      'focus',
      `insertContentAt:9:${JSON.stringify({ type: 'tag_ref', attrs: { id: 'NEW_TAG_ULID' } })}`,
      'run',
    ])

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })
})

// ── Integration: real editor doc state after the picker chain ──

describe('AtTagPicker real-editor chain result', () => {
  let editor: Editor | undefined

  afterEach(() => {
    editor?.destroy()
    editor = undefined
  })

  function buildEditor(initialText: string): Editor {
    return new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        TagRef.configure({ resolveName: (id) => `Tag:${id}` }),
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: initialText ? [{ type: 'text', text: initialText }] : [],
          },
        ],
      },
    })
  }

  it('chain produces [tag_ref]; cursor at end; single paragraph; no hard_break', () => {
    editor = buildEditor('@foo')
    editor.chain().focus().deleteRange({ from: 1, to: 5 }).insertTagRef('ULID_TAG').run()

    const doc = editor.state.doc
    // Exactly one paragraph.
    expect(doc.childCount).toBe(1)
    const paragraph = doc.child(0)
    expect(paragraph.type.name).toBe('paragraph')

    // [tag_ref] — exact count.
    expect(paragraph.childCount).toBe(1)
    expect(paragraph.child(0).type.name).toBe('tag_ref')
    expect(paragraph.child(0).attrs['id']).toBe('ULID_TAG')

    let hardBreakCount = 0
    doc.descendants((n) => {
      if (n.type.name === 'hard_break') hardBreakCount += 1
    })
    expect(hardBreakCount).toBe(0)

    // Cursor sits at the end of the paragraph content (right after the
    // chip), not on a new line. $from.parentOffset must equal
    // paragraph.content.size; selection.from is doc.content.size - 1
    // (doc.content.size includes the paragraph's closing token).
    const $from = editor.state.selection.$from
    expect($from.parent.type.name).toBe('paragraph')
    expect($from.parentOffset).toBe(paragraph.content.size)
    expect(editor.state.selection.from).toBe(doc.content.size - 1)
    expect(editor.state.selection.empty).toBe(true)
  })
})

// ── #2998: toolbar @ button opens the picker ──────────────────────────
//
// The toolbar "insert tag" button (see `lib/toolbar-config.ts` →
// `createRefsAndBlocks`) inserts the `@` trigger (prepending a space when the
// caret is not already after whitespace, since the picker's
// `allowedPrefixes: [' ', '\u00A0', '\n']` gate would otherwise ignore a
// mid-word `@`). It must OPEN the floating tag menu — the same search/create
// popup that TYPING `@` opens — not merely type the glyph. The TipTap
// Suggestion plugin re-detects a trigger match on any transaction (including a
// programmatic `insertContent`), so inserting the trigger with a valid prefix
// drives the picker's `items` lookup. This pins that behaviour so the button
// can never silently regress to "types a bare character".

describe('AtTagPicker toolbar-trigger integration (#2998)', () => {
  let editor: Editor | undefined

  afterEach(() => {
    editor?.destroy()
    editor = undefined
  })

  function buildEditor(items: (query: string) => PickerItem[], initialText: string): Editor {
    return new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        TagRef.configure({ resolveName: (id) => `Tag:${id}` }),
        AtTagPicker.configure({ items }),
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: initialText ? [{ type: 'text', text: initialText }] : [],
          },
        ],
      },
    })
  }

  // Replicates the toolbar button action: prepend a space when the previous
  // char is not already a valid picker prefix, then insert `@`.
  function clickInsertTagButton(ed: Editor): void {
    const { from } = ed.state.selection
    const prev = from > 0 ? ed.state.doc.textBetween(from - 1, from) : ''
    const needsSpace = prev !== '' && prev !== ' ' && prev !== '\u00A0' && prev !== '\n'
    ed.chain()
      .focus()
      .insertContent(needsSpace ? ' @' : '@')
      .run()
  }

  it('opens the picker (drives the items lookup) when clicked mid-word', async () => {
    const items = vi.fn((_query: string) => [{ id: 'T1', label: 'work', isCreate: false }])
    editor = buildEditor(items, 'foo')
    editor.commands.focus('end')

    clickInsertTagButton(editor)

    // The suggestion plugin fired the picker's items lookup → the floating
    // search/create menu is open, exactly as typing `@` would do.
    await vi.waitFor(() => expect(items).toHaveBeenCalled())
  })

  it('opens the picker when clicked at the start of an empty block', async () => {
    const items = vi.fn((_query: string) => [{ id: 'T2', label: 'home', isCreate: false }])
    editor = buildEditor(items, '')
    editor.commands.focus('start')

    clickInsertTagButton(editor)

    await vi.waitFor(() => expect(items).toHaveBeenCalled())
  })
})
