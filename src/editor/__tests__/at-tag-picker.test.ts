/**
 * Tests for the AtTagPicker extension.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AtTagPicker } from '../extensions/at-tag-picker'
import { TagRef } from '../extensions/tag-ref'

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

describe('AtTagPicker input rule (T-2)', () => {
  it('input rule regex matches #[tagname] pattern', () => {
    const regex = /#\[([^\]]+)\]$/
    const match = '#[myTag]'.match(regex)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe('myTag')
  })

  it('input rule regex matches #[multi word tag] pattern', () => {
    const regex = /#\[([^\]]+)\]$/
    const match = '#[my cool tag]'.match(regex)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe('my cool tag')
  })

  it('input rule regex does not match # without brackets', () => {
    const regex = /#\[([^\]]+)\]$/
    expect('#heading'.match(regex)).toBeNull()
  })

  it('input rule regex does not match empty brackets', () => {
    const regex = /#\[([^\]]+)\]$/
    // The regex requires at least one non-] character, so #[] does not match
    expect('#[]'.match(regex)).toBeNull()
  })

  it('registers input rules via addInputRules', () => {
    const ext = AtTagPicker.configure({
      items: () => [],
      onCreate: async (name: string) => `ULID_${name}`,
    })
    expect(ext.config.addInputRules).toBeDefined()
  })

  it('input rule calls insertContentAt with exact match', async () => {
    const insertContentAtCalls: Array<{ pos: number; content: unknown }> = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      insertContentAt: (pos: number, content: unknown) => {
        insertContentAtCalls.push({ pos, content })
        return chainProxy
      },
      run: () => true,
    }
    const mockEditor = { chain: () => chainProxy } as unknown

    const mockItems = vi
      .fn()
      .mockResolvedValue([{ id: 'TAG_ULID_1', label: 'myTag', isCreate: false }])

    const ext = AtTagPicker.configure({ items: mockItems })

    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const rules = (ext.config.addInputRules as Function).call({
      options: ext.options,
      editor: mockEditor,
    })
    expect(rules).toHaveLength(1)
    const rule = rules[0]

    const deleteCalls: Array<{ from: number; to: number }> = []
    const mockState = {
      tr: { delete: (from: number, to: number) => deleteCalls.push({ from, to }) },
    }
    const mockRange = { from: 5, to: 13 } // #[myTag] occupies positions 5-13
    const mockMatch = ['#[myTag]', 'myTag']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    expect(deleteCalls).toEqual([{ from: 5, to: 13 }])

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    expect(insertContentAtCalls).toEqual([
      { pos: 5, content: { type: 'tag_ref', attrs: { id: 'TAG_ULID_1' } } },
    ])
  })

  it('input rule creates tag when no exact match', async () => {
    const insertContentAtCalls: Array<{ pos: number; content: unknown }> = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      insertContentAt: (pos: number, content: unknown) => {
        insertContentAtCalls.push({ pos, content })
        return chainProxy
      },
      run: () => true,
    }
    const mockEditor = { chain: () => chainProxy } as unknown

    const mockItems = vi.fn().mockResolvedValue([])
    const mockOnCreate = vi.fn().mockResolvedValue('NEW_TAG_ULID')

    const ext = AtTagPicker.configure({ items: mockItems, onCreate: mockOnCreate })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const rules = (ext.config.addInputRules as Function).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const deleteCalls: Array<{ from: number; to: number }> = []
    const mockState = {
      tr: { delete: (from: number, to: number) => deleteCalls.push({ from, to }) },
    }
    const mockRange = { from: 10, to: 22 }
    const mockMatch = ['#[New Tag]', 'New Tag']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    expect(mockOnCreate).toHaveBeenCalledWith('New Tag')
    expect(insertContentAtCalls).toEqual([
      { pos: 10, content: { type: 'tag_ref', attrs: { id: 'NEW_TAG_ULID' } } },
    ])
  })

  it('falls back to plain text when no match and no onCreate', async () => {
    const insertContentAtCalls: Array<{ pos: number; content: unknown }> = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      insertContentAt: (pos: number, content: unknown) => {
        insertContentAtCalls.push({ pos, content })
        return chainProxy
      },
      run: () => true,
    }
    const mockEditor = { chain: () => chainProxy } as unknown

    const mockItems = vi.fn().mockResolvedValue([])

    const ext = AtTagPicker.configure({ items: mockItems })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const rules = (ext.config.addInputRules as Function).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    const mockRange = { from: 3, to: 14 }
    const mockMatch = ['#[orphan]', 'orphan']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))
    expect(insertContentAtCalls).toEqual([{ pos: 3, content: 'orphan' }])
  })

  it('falls back to plain text at captured position on error', async () => {
    const insertContentAtCalls: Array<{ pos: number; content: unknown }> = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      insertContentAt: (pos: number, content: unknown) => {
        insertContentAtCalls.push({ pos, content })
        return chainProxy
      },
      run: () => true,
    }
    const mockEditor = { chain: () => chainProxy } as unknown

    const mockItems = vi.fn().mockRejectedValue(new Error('network error'))

    const ext = AtTagPicker.configure({ items: mockItems })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const rules = (ext.config.addInputRules as Function).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    const mockRange = { from: 7, to: 18 }
    const mockMatch = ['#[broken]', 'broken']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))
    expect(insertContentAtCalls).toEqual([{ pos: 7, content: 'broken' }])
  })
})

// ── Suggestion plugin `command` — UX-232 trailing-space behaviour ────────
//
// After picking a tag from the @ suggestion popup, the chain must end with
// .insertContent(' ').run() so the cursor sits one space past the chip.

describe('AtTagPicker suggestion plugin configuration', () => {
  // Regression guard for TEST-1fh query-blocks failures. Typing
  // `{{query property:context=@office}}` previously triggered the at-tag
  // picker because `allowedPrefixes: null` let `@` fire after any character.
  // Enter then created a `Create 'office}}'` tag instead of saving the
  // block. Pinning the prefix set here ensures the picker only opens when
  // `@` is preceded by whitespace (or starts a block), matching the
  // Suggestion plugin's own default.
  it('restricts trigger to whitespace/start-of-block prefixes', async () => {
    let capturedOptions: Record<string, unknown> | undefined
    vi.resetModules()
    vi.doMock('@tiptap/suggestion', () => ({
      Suggestion: (opts: Record<string, unknown>) => {
        capturedOptions = opts
        return { key: opts['pluginKey'] }
      },
    }))
    const mod = await import('../extensions/at-tag-picker')
    const ext = mod.AtTagPicker.configure({ items: () => [] })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    ;(ext.config.addProseMirrorPlugins as Function).call({
      editor: {} as unknown,
      options: ext.options,
    })
    expect(capturedOptions).toBeDefined()
    expect(capturedOptions?.['char']).toBe('@')
    // Space, NBSP (ProseMirror normalises a trailing ASCII space to U+00A0
    // when it's the last character in a paragraph), and newline are all
    // valid prefixes that let the picker open mid-block. `\0` is appended
    // by TipTap internally so empty/start-of-block prefixes also match.
    expect(capturedOptions?.['allowedPrefixes']).toEqual([' ', '\u00A0', '\n'])
    expect(capturedOptions?.['allowSpaces']).toBe(true)

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })
})

describe('AtTagPicker suggestion command chain (UX-232)', () => {
  it('non-create path chains deleteRange → insertTagRef → insertContent(" ") → run', async () => {
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
    const mod = await import('../extensions/at-tag-picker')
    const ext = mod.AtTagPicker.configure({ items: () => [] })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    ;(ext.config.addProseMirrorPlugins as Function).call({
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

    expect(calls).toEqual([
      'focus',
      'deleteRange:2-7',
      'insertTagRef:TAG_ULID',
      'insertContent:" "',
      'run',
    ])

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })

  it('isCreate path chains insertContent(" ") after onCreate resolves', async () => {
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
    const mod = await import('../extensions/at-tag-picker')
    const onCreate = vi.fn().mockResolvedValue('NEW_TAG_ULID')
    const ext = mod.AtTagPicker.configure({ items: () => [], onCreate })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    ;(ext.config.addProseMirrorPlugins as Function).call({
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
      range: { from: 9, to: 14 },
      props: { id: 'PLACEHOLDER', label: 'newTag', isCreate: true },
    })

    await vi.waitFor(() => expect(onCreate).toHaveBeenCalled())
    await vi.waitFor(() => expect(calls).toContain('run'))

    expect(calls).toEqual([
      'focus',
      'deleteRange:9-14',
      'insertTagRef:NEW_TAG_ULID',
      'insertContent:" "',
      'run',
    ])

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })
})

// ── Integration: real editor doc state after the picker chain (UX-232) ──

describe('AtTagPicker real-editor chain result (UX-232)', () => {
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

  it('chain produces [tag_ref, " "]; cursor at end; single paragraph; no hard_break', () => {
    editor = buildEditor('@foo')
    editor
      .chain()
      .focus()
      .deleteRange({ from: 1, to: 5 })
      .insertTagRef('ULID_TAG')
      .insertContent(' ')
      .run()

    const doc = editor.state.doc
    // Exactly one paragraph.
    expect(doc.childCount).toBe(1)
    const paragraph = doc.child(0)
    expect(paragraph.type.name).toBe('paragraph')

    // [tag_ref, text(' ')] — exact count.
    expect(paragraph.childCount).toBe(2)
    expect(paragraph.child(0).type.name).toBe('tag_ref')
    expect(paragraph.child(0).attrs['id']).toBe('ULID_TAG')
    expect(paragraph.child(1).type.name).toBe('text')
    expect(paragraph.child(1).text).toBe(' ')

    let hardBreakCount = 0
    doc.descendants((n) => {
      if (n.type.name === 'hard_break') hardBreakCount += 1
    })
    expect(hardBreakCount).toBe(0)

    // Cursor sits at the end of the paragraph content (right after the
    // inserted space), not on a new line. $from.parentOffset must equal
    // paragraph.content.size; selection.from is doc.content.size - 1
    // (doc.content.size includes the paragraph's closing token).
    const $from = editor.state.selection.$from
    expect($from.parent.type.name).toBe('paragraph')
    expect($from.parentOffset).toBe(paragraph.content.size)
    expect(editor.state.selection.from).toBe(doc.content.size - 1)
    expect(editor.state.selection.empty).toBe(true)
  })
})
