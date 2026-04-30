/**
 * Tests for the BlockRefPicker extension.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockRef } from '../extensions/block-ref'
import { BlockRefPicker } from '../extensions/block-ref-picker'

describe('BlockRefPicker', () => {
  it('creates an extension with the correct name', () => {
    const ext = BlockRefPicker.configure({ items: () => [] })
    expect(ext.name).toBe('blockRefPicker')
  })

  it('has default items option', () => {
    const ext = BlockRefPicker.configure({})
    expect(ext.options.items).toBeDefined()
  })

  it('accepts a custom items callback', () => {
    const items = (_query: string) => [{ id: 'B1', label: 'Block One' }]
    const ext = BlockRefPicker.configure({ items })
    expect(ext.options.items).toBe(items)
  })

  it('items callback returns a Promise', async () => {
    const mockItems = vi.fn().mockResolvedValue([{ id: 'B1', label: 'Test Block' }])
    const ext = BlockRefPicker.configure({ items: mockItems })
    const result = await ext.options.items('test')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ id: 'B1', label: 'Test Block' })
  })
})

// ── Suggestion plugin config tests ───────────────────────────────────────

// Capture the options passed to Suggestion() by mocking the module.
let capturedSuggestionOpts: Record<string, unknown> | undefined

vi.mock('@tiptap/suggestion', () => ({
  Suggestion: (opts: Record<string, unknown>) => {
    capturedSuggestionOpts = opts
    // Return a minimal ProseMirror plugin stub
    return { key: opts['pluginKey'] }
  },
}))

describe('BlockRefPicker suggestion config', () => {
  function buildPlugins() {
    capturedSuggestionOpts = undefined
    const ext = BlockRefPicker.configure({ items: () => [] })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const plugins = (ext.config.addProseMirrorPlugins as Function).call({
      editor: {} as unknown,
      options: ext.options,
    })
    return { plugins, opts: capturedSuggestionOpts as unknown as Record<string, unknown> }
  }

  it('suggestion char is "(("', () => {
    const { opts } = buildPlugins()
    expect(opts['char']).toBe('((')
  })

  it('allowSpaces is true', () => {
    const { opts } = buildPlugins()
    expect(opts['allowSpaces']).toBe(true)
  })

  it('allowedPrefixes is null', () => {
    const { opts } = buildPlugins()
    expect(opts['allowedPrefixes']).toBeNull()
  })

  it('command calls deleteRange with the range', () => {
    const { opts } = buildPlugins()

    const mockDeleteRange = vi.fn(() => chainProxy)
    const mockInsertBlockRef = vi.fn(() => chainProxy)
    const mockInsertContent = vi.fn(() => chainProxy)
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      deleteRange: mockDeleteRange,
      insertBlockRef: mockInsertBlockRef,
      insertContent: mockInsertContent,
      run: () => true,
    }
    const mockEditor = { chain: () => chainProxy }

    const range = { from: 10, to: 20 }
    const props = { id: 'BLOCK_1', label: 'Test Block' }

    // biome-ignore lint/complexity/noBannedTypes: test needs direct invocation of captured command
    ;(opts['command'] as Function)({ editor: mockEditor, range, props })

    expect(mockDeleteRange).toHaveBeenCalledWith(range)
  })

  it('command calls insertBlockRef with item.id', () => {
    const { opts } = buildPlugins()

    const mockDeleteRange = vi.fn(() => chainProxy)
    const mockInsertBlockRef = vi.fn(() => chainProxy)
    const mockInsertContent = vi.fn(() => chainProxy)
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      deleteRange: mockDeleteRange,
      insertBlockRef: mockInsertBlockRef,
      insertContent: mockInsertContent,
      run: () => true,
    }
    const mockEditor = { chain: () => chainProxy }

    const range = { from: 5, to: 15 }
    const props = { id: 'BLOCK_42', label: 'My Block' }

    // biome-ignore lint/complexity/noBannedTypes: test needs direct invocation of captured command
    ;(opts['command'] as Function)({ editor: mockEditor, range, props })

    expect(mockInsertBlockRef).toHaveBeenCalledWith('BLOCK_42')
  })

  it('command calls chain().focus().run()', () => {
    const { opts } = buildPlugins()

    const mockRun = vi.fn(() => true)
    const mockDeleteRange = vi.fn(() => chainProxy)
    const mockInsertBlockRef = vi.fn(() => chainProxy)
    const mockInsertContent = vi.fn(() => chainProxy)
    const mockFocus = vi.fn(() => chainProxy)
    const chainProxy: Record<string, unknown> = {
      focus: mockFocus,
      deleteRange: mockDeleteRange,
      insertBlockRef: mockInsertBlockRef,
      insertContent: mockInsertContent,
      run: mockRun,
    }
    const mockChain = vi.fn(() => chainProxy)
    const mockEditor = { chain: mockChain }

    const range = { from: 0, to: 10 }
    const props = { id: 'BLOCK_99', label: 'Another Block' }

    // biome-ignore lint/complexity/noBannedTypes: test needs direct invocation of captured command
    ;(opts['command'] as Function)({ editor: mockEditor, range, props })

    expect(mockChain).toHaveBeenCalled()
    expect(mockFocus).toHaveBeenCalled()
    expect(mockRun).toHaveBeenCalled()
  })

  // ── UX-232 ─────────────────────────────────────────────────────────────
  it('command appends a single trailing space via insertContent(" ") — exact order', () => {
    const { opts } = buildPlugins()

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
      insertBlockRef: (id: string) => {
        calls.push(`insertBlockRef:${id}`)
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

    const range = { from: 4, to: 8 }
    const props = { id: 'BLK_UX232', label: 'Block UX' }

    // biome-ignore lint/complexity/noBannedTypes: test needs direct invocation of captured command
    ;(opts['command'] as Function)({ editor: mockEditor, range, props })

    expect(calls).toEqual([
      'focus',
      'deleteRange:4-8',
      'insertBlockRef:BLK_UX232',
      'insertContent:" "',
      'run',
    ])
  })
})

// ── Integration: real editor doc state after the picker chain (UX-232) ──

describe('BlockRefPicker real-editor chain result (UX-232)', () => {
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
        BlockRef.configure({ resolveContent: (id) => `Content:${id}` }),
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

  it('chain produces [block_ref, " "]; cursor at end; no hard_break', () => {
    editor = buildEditor('((foo')
    editor
      .chain()
      .focus()
      .deleteRange({ from: 1, to: 6 })
      .insertBlockRef('ULID_REF')
      .insertContent(' ')
      .run()

    const doc = editor.state.doc
    expect(doc.childCount).toBe(1)
    const paragraph = doc.child(0)
    expect(paragraph.type.name).toBe('paragraph')
    expect(paragraph.childCount).toBe(2)
    expect(paragraph.child(0).type.name).toBe('block_ref')
    expect(paragraph.child(0).attrs['id']).toBe('ULID_REF')
    expect(paragraph.child(1).type.name).toBe('text')
    expect(paragraph.child(1).text).toBe(' ')

    let hardBreakCount = 0
    doc.descendants((n) => {
      if (n.type.name === 'hard_break') hardBreakCount += 1
    })
    expect(hardBreakCount).toBe(0)

    // Cursor sits at the end of the paragraph content (after the space),
    // not on a new line. In ProseMirror terms: $from.parent is the
    // paragraph and $from.parentOffset === paragraph.content.size.
    const $from = editor.state.selection.$from
    expect($from.parent.type.name).toBe('paragraph')
    expect($from.parentOffset).toBe(paragraph.content.size)
    expect(editor.state.selection.from).toBe(doc.content.size - 1)
    expect(editor.state.selection.empty).toBe(true)
  })
})

// ── Input rule: ((text)) auto-resolution (MAINT-130(c)) ─────────────────

describe('BlockRefPicker input rule (MAINT-130(c))', () => {
  it('registers an input rule via addInputRules', () => {
    const ext = BlockRefPicker.configure({ items: () => [] })
    expect(ext.config.addInputRules).toBeDefined()
  })

  it('input rule regex matches ((text)) pattern', () => {
    const regex = /\(\(([^)]+)\)\)$/
    const match = '((Some Block))'.match(regex)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe('Some Block')
  })

  it('input rule regex matches ((text)) at end of string', () => {
    const regex = /\(\(([^)]+)\)\)$/
    const match = 'hello ((world))'.match(regex)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe('world')
  })

  it('input rule regex does not match incomplete ((text', () => {
    const regex = /\(\(([^)]+)\)\)$/
    expect('((text'.match(regex)).toBeNull()
  })

  it('input rule regex does not match empty (())', () => {
    const regex = /\(\(([^)]+)\)\)$/
    expect('(())'.match(regex)).toBeNull()
  })

  it('inserts block_ref node at captured position on exact match', async () => {
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
      .mockResolvedValue([{ id: 'BLOCK_ULID_1', label: 'Some Block', isCreate: false }])

    const ext = BlockRefPicker.configure({ items: mockItems })

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
    const mockRange = { from: 5, to: 19 } // ((Some Block)) occupies 14 chars
    const mockMatch = ['((Some Block))', 'Some Block']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    expect(deleteCalls).toEqual([{ from: 5, to: 19 }])

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    expect(insertContentAtCalls).toEqual([
      { pos: 5, content: { type: 'block_ref', attrs: { id: 'BLOCK_ULID_1' } } },
    ])
  })

  it('falls back to plain text at captured position when no match (no onCreate path)', async () => {
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

    const ext = BlockRefPicker.configure({ items: mockItems })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const rules = (ext.config.addInputRules as Function).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    const mockRange = { from: 3, to: 10 }
    const mockMatch = ['((Foo))', 'Foo']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    // Plain text re-inserted at the captured position
    expect(insertContentAtCalls).toEqual([{ pos: 3, content: 'Foo' }])
  })

  it('falls back to plain text when multiple non-exact matches exist', async () => {
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

    // Three near-matches, none exactly equal to "alice" (case-insensitive)
    const mockItems = vi.fn().mockResolvedValue([
      { id: 'B1', label: "Alice's notes", isCreate: false },
      { id: 'B2', label: 'alice meeting', isCreate: false },
      { id: 'B3', label: 'alice 2024-01-01', isCreate: false },
    ])

    const ext = BlockRefPicker.configure({ items: mockItems })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const rules = (ext.config.addInputRules as Function).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    const mockRange = { from: 0, to: 9 }
    const mockMatch = ['((alice))', 'alice']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    // No exact match → plain text fallback (no block_ref node inserted)
    expect(insertContentAtCalls).toEqual([{ pos: 0, content: 'alice' }])
  })

  it('falls back to plain text on items callback error and logs a warning', async () => {
    const { logger } = await import('../../lib/logger')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

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

    const mockItems = vi.fn().mockRejectedValue(new Error('items failed'))

    const ext = BlockRefPicker.configure({ items: mockItems })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const rules = (ext.config.addInputRules as Function).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    const mockRange = { from: 7, to: 18 }
    const mockMatch = ['((Broken))', 'Broken']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    expect(insertContentAtCalls).toEqual([{ pos: 7, content: 'Broken' }])
    expect(warnSpy).toHaveBeenCalledWith(
      'BlockRefPicker',
      expect.stringContaining('input rule'),
      { text: 'Broken' },
      expect.any(Error),
    )

    warnSpy.mockRestore()
  })
})

// ── resolveBlockRefFromSelection command (MAINT-130(c)) ─────────────────

describe('resolveBlockRefFromSelection command (MAINT-130(c))', () => {
  /** Helper: create a chainProxy that tracks deleteRange + insertContentAt calls. */
  function createChainProxy() {
    const deleteRangeCalls: Array<{ from: number; to: number }> = []
    const insertContentAtCalls: Array<{ pos: number; content: unknown }> = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      deleteRange: (range: { from: number; to: number }) => {
        deleteRangeCalls.push(range)
        return chainProxy
      },
      insertContentAt: (pos: number, content: unknown) => {
        insertContentAtCalls.push({ pos, content })
        return chainProxy
      },
      run: () => true,
    }
    return { chainProxy, deleteRangeCalls, insertContentAtCalls }
  }

  /** Helper: get the resolveBlockRefFromSelection command function. */
  function getCommand(ext: ReturnType<typeof BlockRefPicker.configure>) {
    const addCommands = ext.config.addCommands
    expect(addCommands).toBeDefined()
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const commands = (addCommands as Function).call({ options: ext.options })
    return commands.resolveBlockRefFromSelection
  }

  it('returns false when selection is collapsed (no selection)', () => {
    const { chainProxy, insertContentAtCalls } = createChainProxy()
    const mockEditor = {
      chain: () => chainProxy,
      state: {
        selection: { from: 5, to: 5 },
        doc: { textBetween: () => '' },
      },
    } as unknown

    const ext = BlockRefPicker.configure({ items: vi.fn().mockResolvedValue([]) })
    const command = getCommand(ext)

    const result = command()({ editor: mockEditor })
    expect(result).toBe(false)
    expect(insertContentAtCalls).toHaveLength(0)
  })

  it('returns false for whitespace-only selection', () => {
    const { chainProxy, insertContentAtCalls } = createChainProxy()
    const mockEditor = {
      chain: () => chainProxy,
      state: {
        selection: { from: 5, to: 10 },
        doc: { textBetween: () => '   ' },
      },
    } as unknown

    const ext = BlockRefPicker.configure({ items: vi.fn().mockResolvedValue([]) })
    const command = getCommand(ext)

    const result = command()({ editor: mockEditor })
    expect(result).toBe(false)
    expect(insertContentAtCalls).toHaveLength(0)
  })

  it('resolves exact match and inserts block_ref at captured position', async () => {
    const { chainProxy, deleteRangeCalls, insertContentAtCalls } = createChainProxy()
    const mockEditor = {
      chain: () => chainProxy,
      state: {
        selection: { from: 5, to: 15 },
        doc: { textBetween: () => 'Some Block' },
      },
    } as unknown

    const mockItems = vi
      .fn()
      .mockResolvedValue([{ id: 'BLOCK_42', label: 'Some Block', isCreate: false }])
    const ext = BlockRefPicker.configure({ items: mockItems })
    const command = getCommand(ext)

    const result = command()({ editor: mockEditor })
    expect(result).toBe(true)
    expect(deleteRangeCalls).toEqual([{ from: 5, to: 15 }])

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    expect(insertContentAtCalls).toEqual([
      { pos: 5, content: { type: 'block_ref', attrs: { id: 'BLOCK_42' } } },
    ])
  })

  it('falls back to plain text when no exact match is found (no onCreate)', async () => {
    const { chainProxy, insertContentAtCalls } = createChainProxy()
    const mockEditor = {
      chain: () => chainProxy,
      state: {
        selection: { from: 3, to: 11 },
        doc: { textBetween: () => 'New Block' },
      },
    } as unknown

    const mockItems = vi.fn().mockResolvedValue([])
    const ext = BlockRefPicker.configure({ items: mockItems })
    const command = getCommand(ext)

    const result = command()({ editor: mockEditor })
    expect(result).toBe(true)

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    // No node inserted — plain-text fallback at captured position
    expect(insertContentAtCalls).toEqual([{ pos: 3, content: 'New Block' }])
  })

  it('falls back to plain text on items callback error and logs a warning', async () => {
    const { logger } = await import('../../lib/logger')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const { chainProxy, insertContentAtCalls } = createChainProxy()
    const mockEditor = {
      chain: () => chainProxy,
      state: {
        selection: { from: 2, to: 12 },
        doc: { textBetween: () => 'Error Block' },
      },
    } as unknown

    const mockItems = vi.fn().mockRejectedValue(new Error('network error'))
    const ext = BlockRefPicker.configure({ items: mockItems })
    const command = getCommand(ext)

    const result = command()({ editor: mockEditor })
    expect(result).toBe(true)

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    expect(insertContentAtCalls).toEqual([{ pos: 2, content: 'Error Block' }])
    expect(warnSpy).toHaveBeenCalledWith(
      'BlockRefPicker',
      expect.stringContaining('resolveBlockRefFromSelection'),
      { text: 'Error Block' },
      expect.any(Error),
    )

    warnSpy.mockRestore()
  })
})
