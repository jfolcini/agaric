/**
 * Tests for the BlockLinkPicker extension.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockLink } from '../extensions/block-link'
import { BlockLinkPicker } from '../extensions/block-link-picker'

/** Helper: create a chainProxy mock that tracks deleteRange and insertContentAt calls. */
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

describe('BlockLinkPicker', () => {
  it('creates an extension with the correct name', () => {
    const ext = BlockLinkPicker.configure({ items: () => [] })
    expect(ext.name).toBe('blockLinkPicker')
  })

  it('has default items option', () => {
    const ext = BlockLinkPicker.configure({})
    expect(ext.options.items).toBeDefined()
  })

  it('has onCreate undefined by default', () => {
    const ext = BlockLinkPicker.configure({})
    expect(ext.options.onCreate).toBeUndefined()
  })

  it('accepts a custom onCreate option', () => {
    const onCreate = async (label: string) => `ULID_${label}`
    const ext = BlockLinkPicker.configure({ items: () => [], onCreate })
    expect(ext.options.onCreate).toBe(onCreate)
  })
})

describe('BlockLinkPicker input rule (H-13)', () => {
  it('registers an input rule via addInputRules', () => {
    // Configure the extension with mock options
    const ext = BlockLinkPicker.configure({
      items: () => [],
      onCreate: async (label: string) => `ULID_${label}`,
    })
    // The extension config should have addInputRules defined
    expect(ext.config.addInputRules).toBeDefined()
  })

  it('input rule regex matches [[text]] pattern', () => {
    const regex = /\[\[([^\]]+)\]\]$/
    const match = '[[My Page]]'.match(regex)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe('My Page')
  })

  it('input rule regex matches [[text]] at end of string', () => {
    const regex = /\[\[([^\]]+)\]\]$/
    const match = 'hello [[world]]'.match(regex)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe('world')
  })

  it('input rule regex does not match incomplete [[text', () => {
    const regex = /\[\[([^\]]+)\]\]$/
    expect('[[text'.match(regex)).toBeNull()
  })

  it('input rule regex does not match empty [[ ]]', () => {
    const regex = /\[\[([^\]]+)\]\]$/
    // The regex requires at least one non-] character, so [[]] does not match
    expect('[[]]'.match(regex)).toBeNull()
  })

  it('input rule regex captures text with spaces', () => {
    const regex = /\[\[([^\]]+)\]\]$/
    const match = '[[My Long Page Title]]'.match(regex)
    expect(match?.[1]).toBe('My Long Page Title')
  })

  it('input rule regex captures text with special characters', () => {
    const regex = /\[\[([^\]]+)\]\]$/
    const match = '[[Page (2024)]]'.match(regex)
    expect(match?.[1]).toBe('Page (2024)')
  })

  it('accepts items callback that returns a Promise', async () => {
    const mockItems = vi.fn().mockResolvedValue([{ id: 'P1', label: 'Test Page' }])
    const ext = BlockLinkPicker.configure({ items: mockItems })
    const result = await ext.options.items('test')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ id: 'P1', label: 'Test Page' })
  })
})

describe('BlockLinkPicker input rule uses insertContentAt (race-condition fix)', () => {
  it('calls insertContentAt with captured position on exact match', async () => {
    // Track the calls to verify position-anchored insertion
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
      .mockResolvedValue([{ id: 'ULID_1', label: 'My Page', isCreate: false }])

    const ext = BlockLinkPicker.configure({ items: mockItems })

    // Simulate calling the input rule handler directly
    const inputRules = ext.config.addInputRules
    expect(inputRules).toBeDefined()

    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const rules = (inputRules as Function).call({
      options: ext.options,
      editor: mockEditor,
    })
    expect(rules).toHaveLength(1)
    const rule = rules[0]

    // Build a minimal mock for state.tr and the match/range
    const deleteCalls: Array<{ from: number; to: number }> = []
    const mockState = {
      tr: { delete: (from: number, to: number) => deleteCalls.push({ from, to }) },
    }
    const mockRange = { from: 5, to: 16 } // [[My Page]] occupies positions 5-16
    const mockMatch = ['[[My Page]]', 'My Page']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    // The synchronous delete should have fired immediately
    expect(deleteCalls).toEqual([{ from: 5, to: 16 }])

    // Wait for the async resolveAndInsert to complete
    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    // The insertion must target the captured position (5), not wherever the
    // cursor may have drifted to.
    expect(insertContentAtCalls).toEqual([
      { pos: 5, content: { type: 'block_link', attrs: { id: 'ULID_1' } } },
    ])
  })

  it('calls insertContentAt with captured position on create', async () => {
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
    const mockOnCreate = vi.fn().mockResolvedValue('NEW_ULID')

    const ext = BlockLinkPicker.configure({ items: mockItems, onCreate: mockOnCreate })
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
    const mockRange = { from: 10, to: 25 }
    const mockMatch = ['[[New Page]]', 'New Page']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    expect(insertContentAtCalls).toEqual([
      { pos: 10, content: { type: 'block_link', attrs: { id: 'NEW_ULID' } } },
    ])
  })

  it('falls back to plain text at captured position when no match and no onCreate', async () => {
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

    const ext = BlockLinkPicker.configure({ items: mockItems })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const rules = (ext.config.addInputRules as Function).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    const mockRange = { from: 3, to: 18 }
    const mockMatch = ['[[No Such Page]]', 'No Such Page']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    // Plain text re-inserted at the captured position
    expect(insertContentAtCalls).toEqual([{ pos: 3, content: 'No Such Page' }])
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

    const ext = BlockLinkPicker.configure({ items: mockItems })
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const rules = (ext.config.addInputRules as Function).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    const mockRange = { from: 7, to: 20 }
    const mockMatch = ['[[Broken]]', 'Broken']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    // On error, plain text re-inserted at the captured position
    expect(insertContentAtCalls).toEqual([{ pos: 7, content: 'Broken' }])
  })
})

describe('resolveBlockLinkFromSelection command', () => {
  /** Helper: get the command function from the extension config. */
  function getCommand(ext: ReturnType<typeof BlockLinkPicker.configure>) {
    const addCommands = ext.config.addCommands
    expect(addCommands).toBeDefined()
    // biome-ignore lint/complexity/noBannedTypes: test needs .call() on TipTap config method
    const commands = (addCommands as Function).call({ options: ext.options })
    return commands.resolveBlockLinkFromSelection
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

    const ext = BlockLinkPicker.configure({ items: vi.fn().mockResolvedValue([]) })
    const command = getCommand(ext)

    const result = command()({ editor: mockEditor })
    expect(result).toBe(false)
    expect(insertContentAtCalls).toHaveLength(0)
  })

  it('resolves exact match and inserts block_link', async () => {
    const { chainProxy, deleteRangeCalls, insertContentAtCalls } = createChainProxy()
    const mockEditor = {
      chain: () => chainProxy,
      state: {
        selection: { from: 5, to: 15 },
        doc: { textBetween: () => 'My Page' },
      },
    } as unknown

    const mockItems = vi
      .fn()
      .mockResolvedValue([{ id: 'ULID123', label: 'My Page', isCreate: false }])
    const ext = BlockLinkPicker.configure({ items: mockItems })
    const command = getCommand(ext)

    const result = command()({ editor: mockEditor })
    expect(result).toBe(true)
    expect(deleteRangeCalls).toEqual([{ from: 5, to: 15 }])

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    expect(insertContentAtCalls).toEqual([
      { pos: 5, content: { type: 'block_link', attrs: { id: 'ULID123' } } },
    ])
  })

  it('creates page when no match found', async () => {
    const { chainProxy, insertContentAtCalls } = createChainProxy()
    const mockEditor = {
      chain: () => chainProxy,
      state: {
        selection: { from: 3, to: 11 },
        doc: { textBetween: () => 'New Page' },
      },
    } as unknown

    const mockItems = vi.fn().mockResolvedValue([])
    const mockOnCreate = vi.fn().mockResolvedValue('NEW_ULID')
    const ext = BlockLinkPicker.configure({ items: mockItems, onCreate: mockOnCreate })
    const command = getCommand(ext)

    const result = command()({ editor: mockEditor })
    expect(result).toBe(true)

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    expect(mockOnCreate).toHaveBeenCalledWith('New Page')
    expect(insertContentAtCalls).toEqual([
      { pos: 3, content: { type: 'block_link', attrs: { id: 'NEW_ULID' } } },
    ])
  })

  it('falls back to plain text on error', async () => {
    const { chainProxy, insertContentAtCalls } = createChainProxy()
    const mockEditor = {
      chain: () => chainProxy,
      state: {
        selection: { from: 2, to: 12 },
        doc: { textBetween: () => 'Error Page' },
      },
    } as unknown

    const mockItems = vi.fn().mockRejectedValue(new Error('network error'))
    const ext = BlockLinkPicker.configure({ items: mockItems })
    const command = getCommand(ext)

    const result = command()({ editor: mockEditor })
    expect(result).toBe(true)

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    expect(insertContentAtCalls).toEqual([{ pos: 2, content: 'Error Page' }])
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

    const ext = BlockLinkPicker.configure({ items: vi.fn().mockResolvedValue([]) })
    const command = getCommand(ext)

    const result = command()({ editor: mockEditor })
    expect(result).toBe(false)
    expect(insertContentAtCalls).toHaveLength(0)
  })

  it('prefers alias match over create', async () => {
    const { chainProxy, insertContentAtCalls } = createChainProxy()
    const mockEditor = {
      chain: () => chainProxy,
      state: {
        selection: { from: 0, to: 10 },
        doc: { textBetween: () => 'alias name' },
      },
    } as unknown

    const mockItems = vi
      .fn()
      .mockResolvedValue([{ id: 'ALIAS_ID', label: 'Real Name', isAlias: true, isCreate: false }])
    const mockOnCreate = vi.fn().mockResolvedValue('SHOULD_NOT_USE')
    const ext = BlockLinkPicker.configure({ items: mockItems, onCreate: mockOnCreate })
    const command = getCommand(ext)

    const result = command()({ editor: mockEditor })
    expect(result).toBe(true)

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    expect(mockOnCreate).not.toHaveBeenCalled()
    expect(insertContentAtCalls).toEqual([
      { pos: 0, content: { type: 'block_link', attrs: { id: 'ALIAS_ID' } } },
    ])
  })
})

// ── Suggestion plugin `command` — UX-232 trailing-space behaviour ────────
//
// After the user picks an item from the [[ suggestion popup, the chain must
// be: deleteRange(range) → insertBlockLink(id) → insertContent(' ') → run().
// The trailing space keeps the cursor on the same visual line, separated
// from the chip by exactly one character.

describe('BlockLinkPicker suggestion command chain (UX-232)', () => {
  it('captured command invokes the correct chain (mock @tiptap/suggestion)', async () => {
    // Re-import with a mocked @tiptap/suggestion so we can capture the
    // `command` option that BlockLinkPicker passes to Suggestion(...).
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
    const mod = await import('../extensions/block-link-picker')
    const ext = mod.BlockLinkPicker.configure({ items: () => [] })
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
      insertBlockLink: (id: string) => {
        calls.push(`insertBlockLink:${id}`)
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
      range: { from: 1, to: 3 },
      props: { id: 'ULID_PICK', label: 'Pick Me', isCreate: false },
    })

    expect(calls).toEqual([
      'focus',
      'deleteRange:1-3',
      'insertBlockLink:ULID_PICK',
      'insertContent:" "',
      'run',
    ])

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })

  it('isCreate path invokes insertContent(" ") after onCreate resolves', async () => {
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
    const mod = await import('../extensions/block-link-picker')
    const onCreate = vi.fn().mockResolvedValue('CREATED_ULID')
    const ext = mod.BlockLinkPicker.configure({ items: () => [], onCreate })
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
      insertBlockLink: (id: string) => {
        calls.push(`insertBlockLink:${id}`)
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
      range: { from: 5, to: 10 },
      props: { id: 'PLACEHOLDER', label: 'Create me', isCreate: true },
    })

    await vi.waitFor(() => expect(onCreate).toHaveBeenCalled())
    await vi.waitFor(() => expect(calls).toContain('run'))

    expect(calls).toEqual([
      'focus',
      'deleteRange:5-10',
      'insertBlockLink:CREATED_ULID',
      'insertContent:" "',
      'run',
    ])

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })
})

// ── Integration: real editor doc state after the picker chain (UX-232) ──
//
// These tests drive the exact chain that block-link-picker.command runs
// through a real TipTap Editor (BlockLink + Document + Paragraph + Text,
// no Suggestion plugin needed) and assert on the resulting doc shape:
//   - the chip is followed by a single ' ' text node
//   - selection.from === doc.content.size (cursor at paragraph end)
//   - doc has exactly one paragraph (no stray hard_break / paragraph split)

describe('BlockLinkPicker real-editor chain result (UX-232)', () => {
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
        BlockLink.configure({ resolveTitle: (id) => `Title:${id}` }),
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

  it('inserts block_link chip followed by a single space; cursor at end', () => {
    editor = buildEditor('[[foo')
    // `[[foo` occupies positions 1..6 inside the paragraph (0 is the
    // paragraph start token). The suggestion range on selection is this
    // span — mirror the real command's chain.
    editor.chain().focus().deleteRange({ from: 1, to: 6 }).insertBlockLink('ULID_OK').run()
    // Apply the trailing space the UX-232 fix appends:
    editor.chain().focus().insertContent(' ').run()

    const doc = editor.state.doc
    // Exactly one paragraph — no paragraph split or hard_break leaked in.
    expect(doc.childCount).toBe(1)
    const paragraph = doc.child(0)
    expect(paragraph.type.name).toBe('paragraph')

    // Paragraph children: [block_link, text(' ')] — exact count.
    expect(paragraph.childCount).toBe(2)
    expect(paragraph.child(0).type.name).toBe('block_link')
    expect(paragraph.child(0).attrs['id']).toBe('ULID_OK')
    expect(paragraph.child(1).type.name).toBe('text')
    expect(paragraph.child(1).text).toBe(' ')

    // No hard_break anywhere in the doc.
    let hardBreakCount = 0
    doc.descendants((n) => {
      if (n.type.name === 'hard_break') hardBreakCount += 1
    })
    expect(hardBreakCount).toBe(0)

    // Cursor sits at the end of the paragraph content (right after the
    // inserted space), not on a new line/block. In ProseMirror terms:
    //   - $from.parent is the paragraph
    //   - $from.parentOffset equals paragraph.content.size
    //   - selection.from === doc.content.size - 1 (doc.content.size
    //     counts the paragraph's closing token, so end-of-paragraph is
    //     one less).
    const $from = editor.state.selection.$from
    expect($from.parent.type.name).toBe('paragraph')
    expect($from.parentOffset).toBe(paragraph.content.size)
    expect(editor.state.selection.from).toBe(doc.content.size - 1)
    expect(editor.state.selection.empty).toBe(true)
  })

  it('full suggestion-command chain (deleteRange + insertBlockLink + insertContent(" ")) — single atomic run()', () => {
    editor = buildEditor('[[bar')
    editor
      .chain()
      .focus()
      .deleteRange({ from: 1, to: 6 })
      .insertBlockLink('ULID_BAR')
      .insertContent(' ')
      .run()

    const doc = editor.state.doc
    expect(doc.childCount).toBe(1)
    const paragraph = doc.child(0)
    expect(paragraph.childCount).toBe(2)
    expect(paragraph.child(0).type.name).toBe('block_link')
    expect(paragraph.child(1).text).toBe(' ')
    const $from = editor.state.selection.$from
    expect($from.parent.type.name).toBe('paragraph')
    expect($from.parentOffset).toBe(paragraph.content.size)
    expect(editor.state.selection.from).toBe(doc.content.size - 1)
  })
})
