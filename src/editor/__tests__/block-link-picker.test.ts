/**
 * Tests for the BlockLinkPicker extension.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BlockLink } from '@/editor/extensions/block-link'
import {
  BlockLinkPicker,
  blockLinkNode,
  parseTypedLink,
  pickedLinkLabel,
} from '@/editor/extensions/block-link-picker'
import type { PickerItem } from '@/editor/SuggestionList'

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

// ── prefix-alias disambiguation in the input rule ─────────────
//
// Pre- the exact-match check was `label === text || item.isAlias`,
// which auto-resolved any item carrying `isAlias: true` regardless of
// whether the typed text was a prefix or the full alias. With prefix
// matching now in `searchPages`, that fallback would auto-resolve
// `[[my]]` to the first prefix-alias hit (e.g. `my-favourite-page`).
// The fix narrows the alias branch to `aliasText === text` so only a
// fully-typed alias triggers resolution.

describe('BlockLinkPicker input rule — alias disambiguation', () => {
  it('[[my-alias]] input rule resolves to alias target', async () => {
    const insertContentAtCalls: Array<{ pos: number; content: unknown }> = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      insertContent: (_c: unknown) => chainProxy,
      insertContentAt: (pos: number, content: unknown) => {
        insertContentAtCalls.push({ pos, content })
        return chainProxy
      },
      run: () => true,
    }
    const mockEditor = {
      chain: () => chainProxy,
      state: { doc: { content: { size: 1000 } } },
    } as unknown

    // The picker returns the alias-prefix item. `aliasText === text`
    // (case-insensitive), so the input rule's exact-match branch fires.
    const mockItems = vi.fn().mockResolvedValue([
      {
        id: 'PAGE',
        label: 'WGM (alias: my-alias)',
        isAlias: true,
        aliasText: 'my-alias',
      },
    ])
    const ext = BlockLinkPicker.configure({ items: mockItems })

    const rules = (
      ext.config.addInputRules as unknown as (
        ...args: unknown[]
      ) => [
        { handler: (...a: unknown[]) => unknown },
        ...{ handler: (...a: unknown[]) => unknown }[],
      ]
    ).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    rule.handler({
      state: mockState,
      range: { from: 1, to: 14 },
      match: ['[[my-alias]]', 'my-alias'],
    })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    // Resolved as a block_link to the alias's target page.
    expect(insertContentAtCalls).toEqual([
      { pos: 1, content: { type: 'block_link', attrs: { id: 'PAGE' } } },
    ])
  })

  it('[[my]] input rule does NOT resolve to a prefix-alias hit', async () => {
    // Regression guard against the dropped `|| item.isAlias` short-
    // circuit. With prefix matching, the picker returns alias items
    // for `my` (prefixes like `my-alias`, `my-favourite`) — none of
    // which equal the typed text `my`, so the input rule must fall
    // through to plain-text re-insert (no `onCreate` configured).
    const insertContentAtCalls: Array<{ pos: number; content: unknown }> = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      insertContent: (_c: unknown) => chainProxy,
      insertContentAt: (pos: number, content: unknown) => {
        insertContentAtCalls.push({ pos, content })
        return chainProxy
      },
      run: () => true,
    }
    const mockEditor = {
      chain: () => chainProxy,
      state: { doc: { content: { size: 1000 } } },
    } as unknown

    const mockItems = vi.fn().mockResolvedValue([
      {
        id: 'PAGE_PREFIX',
        label: 'WGM (alias: my-alias)',
        isAlias: true,
        aliasText: 'my-alias',
      },
    ])
    const ext = BlockLinkPicker.configure({ items: mockItems })

    const rules = (
      ext.config.addInputRules as unknown as (
        ...args: unknown[]
      ) => [
        { handler: (...a: unknown[]) => unknown },
        ...{ handler: (...a: unknown[]) => unknown }[],
      ]
    ).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    rule.handler({
      state: mockState,
      range: { from: 5, to: 11 },
      match: ['[[my]]', 'my'],
    })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    // What was typed re-inserted at the captured position — NOT a
    // block_link to the prefix-alias hit.
    expect(insertContentAtCalls).toEqual([{ pos: 5, content: '[[my]]' }])
  })
})

// #5160 N4 — two pages differing only by case, neither spelled as typed: the
// name is ambiguous, so the typed `[[FOO]]` stays exactly as typed (brackets
// included), as paste, import and Source keep it.
describe('BlockLinkPicker input rule — ambiguous name', () => {
  it('re-inserts the typed [[FOO]] when two pages tie by case', async () => {
    const insertContentAtCalls: Array<{ pos: number; content: unknown }> = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      insertContent: (_c: unknown) => chainProxy,
      insertContentAt: (pos: number, content: unknown) => {
        insertContentAtCalls.push({ pos, content })
        return chainProxy
      },
      run: () => true,
    }
    const mockEditor = {
      chain: () => chainProxy,
      state: { doc: { content: { size: 1000 } } },
    } as unknown
    const onCreate = vi.fn()
    const mockItems = vi.fn().mockResolvedValue([
      { id: 'PAGE_UPPER', label: 'Foo', title: 'Foo' },
      { id: 'PAGE_LOWER', label: 'foo', title: 'foo' },
    ])
    const ext = BlockLinkPicker.configure({ items: mockItems, onCreate })
    const rules = (
      ext.config.addInputRules as unknown as (
        ...args: unknown[]
      ) => [
        { handler: (...a: unknown[]) => unknown },
        ...{ handler: (...a: unknown[]) => unknown }[],
      ]
    ).call({ options: ext.options, editor: mockEditor })

    rules[0].handler({
      state: { tr: { delete: vi.fn() } },
      range: { from: 5, to: 12 },
      match: ['[[FOO]]', 'FOO'],
    })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))
    expect(insertContentAtCalls).toEqual([{ pos: 5, content: '[[FOO]]' }])
    expect(onCreate).not.toHaveBeenCalled()
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
    const mockEditor = {
      chain: () => chainProxy,
      state: { doc: { content: { size: 1000 } } },
    } as unknown

    const mockItems = vi
      .fn()
      .mockResolvedValue([{ id: 'ULID_1', label: 'My Page', isCreate: false }])

    const ext = BlockLinkPicker.configure({ items: mockItems })

    // Simulate calling the input rule handler directly
    const inputRules = ext.config.addInputRules
    expect(inputRules).toBeDefined()

    const rules = (
      inputRules as unknown as (
        ...args: unknown[]
      ) => [
        { handler: (...a: unknown[]) => unknown },
        ...{ handler: (...a: unknown[]) => unknown }[],
      ]
    ).call({
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
    const mockEditor = {
      chain: () => chainProxy,
      state: { doc: { content: { size: 1000 } } },
    } as unknown

    const mockItems = vi.fn().mockResolvedValue([])
    const mockOnCreate = vi.fn().mockResolvedValue('NEW_ULID')

    const ext = BlockLinkPicker.configure({ items: mockItems, onCreate: mockOnCreate })
    const rules = (
      ext.config.addInputRules as unknown as (
        ...args: unknown[]
      ) => [
        { handler: (...a: unknown[]) => unknown },
        ...{ handler: (...a: unknown[]) => unknown }[],
      ]
    ).call({
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
    const mockEditor = {
      chain: () => chainProxy,
      state: { doc: { content: { size: 1000 } } },
    } as unknown

    const mockItems = vi.fn().mockResolvedValue([])

    const ext = BlockLinkPicker.configure({ items: mockItems })
    const rules = (
      ext.config.addInputRules as unknown as (
        ...args: unknown[]
      ) => [
        { handler: (...a: unknown[]) => unknown },
        ...{ handler: (...a: unknown[]) => unknown }[],
      ]
    ).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    const mockRange = { from: 3, to: 18 }
    const mockMatch = ['[[No Such Page]]', 'No Such Page']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    // What was typed re-inserted at the captured position
    expect(insertContentAtCalls).toEqual([{ pos: 3, content: '[[No Such Page]]' }])
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
    const mockEditor = {
      chain: () => chainProxy,
      state: { doc: { content: { size: 1000 } } },
    } as unknown

    const mockItems = vi.fn().mockRejectedValue(new Error('network error'))

    const ext = BlockLinkPicker.configure({ items: mockItems })
    const rules = (
      ext.config.addInputRules as unknown as (
        ...args: unknown[]
      ) => [
        { handler: (...a: unknown[]) => unknown },
        ...{ handler: (...a: unknown[]) => unknown }[],
      ]
    ).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    const mockRange = { from: 7, to: 25 }
    const mockMatch = ['[[Broken|label]]', 'Broken|label']

    rule.handler({ state: mockState, range: mockRange, match: mockMatch })

    await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

    // On error, what was typed, label included, re-inserted at the captured position
    expect(insertContentAtCalls).toEqual([{ pos: 7, content: '[[Broken|label]]' }])
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

describe('BlockLinkPicker stale-insertPos guard ()', () => {
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
      .mockResolvedValue([{ id: 'ULID_1', label: 'My Page', isCreate: false }])
    const ext = BlockLinkPicker.configure({ items: mockItems })

    const rules = (
      ext.config.addInputRules as unknown as (
        ...args: unknown[]
      ) => [
        { handler: (...a: unknown[]) => unknown },
        ...{ handler: (...a: unknown[]) => unknown }[],
      ]
    ).call({
      options: ext.options,
      editor: mockEditor,
    })
    const rule = rules[0]

    const mockState = { tr: { delete: vi.fn() } }
    rule.handler({
      state: mockState,
      range: { from: 10, to: 22 },
      match: ['[[My Page]]', 'My Page'],
    })

    // Wait for the async resolve to land on the cursor-fallback path.
    await vi.waitFor(() => expect(insertContentCalls.length).toBeGreaterThan(0))

    // What was typed inserted at the current cursor (insertContent),
    // NOT the inline node at the stale offset.
    expect(insertContentCalls).toEqual(['[[My Page]]'])
    expect(insertContentAtCalls).toEqual([])
  })

  it('an ambiguous [[FOO]] racing a stale offset comes back with its brackets', async () => {
    const insertContentCalls: unknown[] = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      insertContent: (content: unknown) => {
        insertContentCalls.push(content)
        return chainProxy
      },
      insertContentAt: () => chainProxy,
      run: () => true,
    }
    const mockEditor = {
      chain: () => chainProxy,
      state: { doc: { content: { size: 5 } } },
    } as unknown
    const ext = BlockLinkPicker.configure({
      items: vi.fn().mockResolvedValue([
        { id: 'PAGE_UPPER', label: 'Foo', title: 'Foo' },
        { id: 'PAGE_LOWER', label: 'foo', title: 'foo' },
      ]),
    })
    const rules = (
      ext.config.addInputRules as unknown as (
        ...args: unknown[]
      ) => [{ handler: (...a: unknown[]) => unknown }]
    ).call({ options: ext.options, editor: mockEditor })

    rules[0].handler({
      state: { tr: { delete: vi.fn() } },
      range: { from: 10, to: 17 },
      match: ['[[FOO]]', 'FOO'],
    })

    await vi.waitFor(() => expect(insertContentCalls.length).toBeGreaterThan(0))
    expect(insertContentCalls).toEqual(['[[FOO]]'])
  })
})

describe('resolveBlockLinkFromSelection command', () => {
  /** Helper: get the command function from the extension config. */
  function getCommand(ext: ReturnType<typeof BlockLinkPicker.configure>) {
    const addCommands = ext.config.addCommands
    expect(addCommands).toBeDefined()
    const commands = (
      addCommands as unknown as (...args: unknown[]) => {
        resolveBlockLinkFromSelection: () => (...a: unknown[]) => unknown
      }
    ).call({ options: ext.options })
    return commands.resolveBlockLinkFromSelection
  }

  it('returns false when selection is collapsed (no selection)', () => {
    const { chainProxy, insertContentAtCalls } = createChainProxy()
    const mockEditor = {
      chain: () => chainProxy,
      state: {
        selection: { from: 5, to: 5 },
        doc: { textBetween: () => '', content: { size: 1000 } },
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
        doc: { textBetween: () => 'My Page', content: { size: 1000 } },
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

  // The selection is prose, not link syntax: a `#` or `|` in it is part of
  // the name, never an anchor to drop or a label to split off.
  it('names the page with the whole selection, `#` and `|` included', async () => {
    for (const selected of ['Issue #42', 'Plan|see']) {
      const { chainProxy, insertContentAtCalls } = createChainProxy()
      const mockEditor = {
        chain: () => chainProxy,
        state: {
          selection: { from: 3, to: 3 + selected.length },
          doc: { textBetween: () => selected, content: { size: 1000 } },
        },
      } as unknown
      const mockOnCreate = vi.fn().mockResolvedValue('NEW_ULID')
      const ext = BlockLinkPicker.configure({
        items: vi.fn().mockResolvedValue([]),
        onCreate: mockOnCreate,
      })

      expect(getCommand(ext)()({ editor: mockEditor })).toBe(true)
      await vi.waitFor(() => expect(insertContentAtCalls.length).toBeGreaterThan(0))

      expect(mockOnCreate).toHaveBeenCalledWith(selected)
      expect(insertContentAtCalls).toEqual([
        { pos: 3, content: { type: 'block_link', attrs: { id: 'NEW_ULID' } } },
      ])
    }
  })

  it('creates page when no match found', async () => {
    const { chainProxy, insertContentAtCalls } = createChainProxy()
    const mockEditor = {
      chain: () => chainProxy,
      state: {
        selection: { from: 3, to: 11 },
        doc: { textBetween: () => 'New Page', content: { size: 1000 } },
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
        doc: { textBetween: () => 'Error Page', content: { size: 1000 } },
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
        doc: { textBetween: () => '   ', content: { size: 1000 } },
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
        doc: { textBetween: () => 'alias name', content: { size: 1000 } },
      },
    } as unknown

    // The alias-resolution path now keys on `aliasText === text`
    // rather than the old `isAlias` short-circuit. The picker item must
    // carry the matched alias text so the selection-resolve path can
    // recognise it as an exact match.
    const mockItems = vi.fn().mockResolvedValue([
      {
        id: 'ALIAS_ID',
        label: 'Real Name',
        isAlias: true,
        aliasText: 'alias name',
        isCreate: false,
      },
    ])
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

// ── Suggestion plugin `command` — insertion behaviour ─────────────
//
// After the user picks an item from the [[ suggestion popup, the chain must
// be: deleteRange(range) → insertBlockLink(id) → run(). #4708: no trailing
// space, so a comma typed next lands directly against the chip.

describe('BlockLinkPicker suggestion command chain', () => {
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
    const mod = await import('@/editor/extensions/block-link-picker')
    const ext = mod.BlockLinkPicker.configure({ items: () => [] })
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

    expect(calls).toEqual(['focus', 'deleteRange:1-3', 'insertBlockLink:ULID_PICK', 'run'])

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
    const mod = await import('@/editor/extensions/block-link-picker')
    const onCreate = vi.fn().mockResolvedValue('CREATED_ULID')
    const ext = mod.BlockLinkPicker.configure({ items: () => [], onCreate })
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
      state: { doc: { textBetween: () => '[[Create me' } },
      on: vi.fn(),
      off: vi.fn(),
      isDestroyed: false,
    }

    capturedCommand?.({
      editor: mockEditor,
      range: { from: 5, to: 10 },
      props: { id: 'PLACEHOLDER', label: 'Create me', isCreate: true },
    })

    // The trigger range is deleted SYNCHRONOUSLY — before the create IPC
    // resolves — so the Suggestion match breaks, the popup closes, and a
    // second Enter/click cannot double-fire the create.
    expect(calls).toEqual(['focus', 'deleteRange:5-10', 'run'])

    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith('Create me'))
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(3))

    // The token — and only the token — lands at the captured (tracked) position.
    expect(calls.slice(3)).toEqual([
      'focus',
      `insertContentAt:5:${JSON.stringify({ type: 'block_link', attrs: { id: 'CREATED_ULID' } })}`,
      'run',
    ])

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })
})

// ── Integration: real editor doc state after the picker chain ──
//
// These tests drive the exact chain that block-link-picker.command runs
// through a real TipTap Editor (BlockLink + Document + Paragraph + Text,
// no Suggestion plugin needed) and assert on the resulting doc shape:
//   - the chip is the paragraph's only child (no trailing ' ' text node)
//   - selection.from === doc.content.size (cursor at paragraph end)
//   - doc has exactly one paragraph (no stray hard_break / paragraph split)

describe('BlockLinkPicker real-editor chain result', () => {
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

  it('inserts a bare block_link chip; cursor at end', () => {
    editor = buildEditor('[[foo')
    // `[[foo` occupies positions 1..6 inside the paragraph (0 is the
    // paragraph start token). The suggestion range on selection is this
    // span — mirror the real command's chain.
    editor.chain().focus().deleteRange({ from: 1, to: 6 }).insertBlockLink('ULID_OK').run()

    const doc = editor.state.doc
    // Exactly one paragraph — no paragraph split or hard_break leaked in.
    expect(doc.childCount).toBe(1)
    const paragraph = doc.child(0)
    expect(paragraph.type.name).toBe('paragraph')

    // Paragraph children: [block_link] — exact count.
    expect(paragraph.childCount).toBe(1)
    expect(paragraph.child(0).type.name).toBe('block_link')
    expect(paragraph.child(0).attrs['id']).toBe('ULID_OK')

    // No hard_break anywhere in the doc.
    let hardBreakCount = 0
    doc.descendants((n) => {
      if (n.type.name === 'hard_break') hardBreakCount += 1
    })
    expect(hardBreakCount).toBe(0)

    // Cursor sits at the end of the paragraph content (right after the
    // chip), not on a new line/block. In ProseMirror terms:
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

  it('full suggestion-command chain (deleteRange + insertBlockLink) — single atomic run()', () => {
    editor = buildEditor('[[bar')
    editor.chain().focus().deleteRange({ from: 1, to: 6 }).insertBlockLink('ULID_BAR').run()

    const doc = editor.state.doc
    expect(doc.childCount).toBe(1)
    const paragraph = doc.child(0)
    expect(paragraph.childCount).toBe(1)
    expect(paragraph.child(0).type.name).toBe('block_link')
    const $from = editor.state.selection.$from
    expect($from.parent.type.name).toBe('paragraph')
    expect($from.parentOffset).toBe(paragraph.content.size)
    expect(editor.state.selection.from).toBe(doc.content.size - 1)
  })
})

// ── #5160 D9 / D10 / N6: labels and anchors in a typed [[…]] ────────────────

describe('parseTypedLink and blockLinkNode (#5160 D9, D10)', () => {
  it('splits the label off the first pipe and the base off the first hash', () => {
    expect(parseTypedLink('Page')).toEqual({ base: 'Page', label: undefined })
    expect(parseTypedLink(' Page | a|b ')).toEqual({ base: 'Page', label: 'a|b' })
    expect(parseTypedLink('Page|')).toEqual({ base: 'Page', label: undefined })
    expect(parseTypedLink('A#B|see')).toEqual({ base: 'A', label: 'see' })
    expect(parseTypedLink('#heading')).toBeNull()
    expect(parseTypedLink('   ')).toBeNull()
  })

  it('stores the label unless it is empty or the title', () => {
    expect(blockLinkNode('ID', 'plan', 'Plan')).toEqual({
      type: 'block_link',
      attrs: { id: 'ID', label: 'plan' },
    })
    expect(blockLinkNode('ID', 'Plan', 'Plan')).toEqual({
      type: 'block_link',
      attrs: { id: 'ID' },
    })
    expect(blockLinkNode('ID', undefined, 'Plan')).toEqual({
      type: 'block_link',
      attrs: { id: 'ID' },
    })
  })

  // A `]` would end the stored `[[ULID|label]]` token early, and every reader
  // would then see text: the link, its backlink and the chip would be lost.
  it('drops a ] from the label, and a label left empty is none', () => {
    expect(blockLinkNode('ID', 'a]b', 'Plan')).toEqual({
      type: 'block_link',
      attrs: { id: 'ID', label: 'ab' },
    })
    expect(blockLinkNode('ID', ' ] ', 'Plan')).toEqual({
      type: 'block_link',
      attrs: { id: 'ID' },
    })
  })
})

describe('BlockLinkPicker input rule — labels and anchors (#5160 D9, N6)', () => {
  type OnCreate = (label: string) => Promise<string>
  function run(match: [string, string], items: PickerItem[], onCreate?: OnCreate) {
    const insertContentAtCalls: Array<{ pos: number; content: unknown }> = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      insertContent: (_c: unknown) => chainProxy,
      insertContentAt: (pos: number, content: unknown) => {
        insertContentAtCalls.push({ pos, content })
        return chainProxy
      },
      run: () => true,
    }
    const mockEditor = { chain: () => chainProxy, state: { doc: { content: { size: 1000 } } } }
    const mockItems = vi.fn(async (query: string): Promise<PickerItem[]> =>
      items.filter((item) =>
        (item.title ?? item.label).toLowerCase().includes(query.toLowerCase()),
      ),
    )
    const ext = BlockLinkPicker.configure({ items: mockItems, onCreate })
    const rules = (
      ext.config.addInputRules as unknown as (
        ...args: unknown[]
      ) => [{ handler: (...a: unknown[]) => unknown }]
    ).call({ options: ext.options, editor: mockEditor })
    rules[0].handler({ state: { tr: { delete: vi.fn() } }, range: { from: 1, to: 20 }, match })
    return { insertContentAtCalls, mockItems }
  }

  it('[[Page|label]] links the page and stores the label', async () => {
    const { insertContentAtCalls } = run(
      ['[[Plan|the plan]]', 'Plan|the plan'],
      [{ id: 'PLAN', label: 'Plan', title: 'Plan' }],
    )
    await vi.waitFor(() => expect(insertContentAtCalls.length).toBe(1))
    expect(insertContentAtCalls[0]).toEqual({
      pos: 1,
      content: { type: 'block_link', attrs: { id: 'PLAN', label: 'the plan' } },
    })
  })

  it('[[Page|Page]] drops the label that equals the title, case folded to the real title', async () => {
    const { insertContentAtCalls } = run(
      ['[[plan|Plan]]', 'plan|Plan'],
      [{ id: 'PLAN', label: 'Plan', title: 'Plan' }],
    )
    await vi.waitFor(() => expect(insertContentAtCalls.length).toBe(1))
    expect(insertContentAtCalls[0]?.content).toEqual({ type: 'block_link', attrs: { id: 'PLAN' } })
  })

  it('[[New|label]] creates the base page, not one titled with the label', async () => {
    const onCreate = vi.fn<OnCreate>().mockResolvedValue('NEW')
    const { insertContentAtCalls } = run(['[[New|label]]', 'New|label'], [], onCreate)
    await vi.waitFor(() => expect(insertContentAtCalls.length).toBe(1))
    expect(onCreate).toHaveBeenCalledWith('New')
    expect(insertContentAtCalls[0]?.content).toEqual({
      type: 'block_link',
      attrs: { id: 'NEW', label: 'label' },
    })
  })

  it('[[Page#Heading]] never creates Page#Heading: it links Page, creating it when absent (N6)', async () => {
    const onCreate = vi.fn<OnCreate>().mockResolvedValue('PAGE')
    const { insertContentAtCalls, mockItems } = run(
      ['[[Page#Heading]]', 'Page#Heading'],
      [],
      onCreate,
    )
    await vi.waitFor(() => expect(insertContentAtCalls.length).toBe(1))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith('Page')
    expect(mockItems).toHaveBeenCalledWith('Page#Heading')
    expect(mockItems).toHaveBeenCalledWith('Page')
    expect(insertContentAtCalls[0]?.content).toEqual({ type: 'block_link', attrs: { id: 'PAGE' } })
  })

  it('[[Page#Heading]] links the existing Page and drops the anchor', async () => {
    const onCreate = vi.fn<OnCreate>()
    const { insertContentAtCalls } = run(
      ['[[Page#Heading|see]]', 'Page#Heading|see'],
      [{ id: 'PAGE', label: 'Page', title: 'Page' }],
      onCreate,
    )
    await vi.waitFor(() => expect(insertContentAtCalls.length).toBe(1))
    expect(onCreate).not.toHaveBeenCalled()
    expect(insertContentAtCalls[0]?.content).toEqual({
      type: 'block_link',
      attrs: { id: 'PAGE', label: 'see' },
    })
  })

  it('[[C# Notes]] links the page titled with the whole text first (D10)', async () => {
    const onCreate = vi.fn<OnCreate>()
    const { insertContentAtCalls } = run(
      ['[[C# Notes]]', 'C# Notes'],
      [
        { id: 'C', label: 'C', title: 'C' },
        { id: 'CSHARP', label: 'C# Notes', title: 'C# Notes' },
      ],
      onCreate,
    )
    await vi.waitFor(() => expect(insertContentAtCalls.length).toBe(1))
    expect(onCreate).not.toHaveBeenCalled()
    expect(insertContentAtCalls[0]?.content).toEqual({
      type: 'block_link',
      attrs: { id: 'CSHARP' },
    })
  })

  it('[[A | B]] links the page titled with the whole text before the first-pipe split (D10)', async () => {
    const onCreate = vi.fn<OnCreate>()
    const pages = [
      { id: 'A', label: 'A', title: 'A' },
      { id: 'AB', label: 'A | B', title: 'A | B' },
    ]
    for (const [body, content] of [
      ['A | B', { type: 'block_link', attrs: { id: 'AB' } }],
      ['a | b|see', { type: 'block_link', attrs: { id: 'AB', label: 'see' } }],
      ['A | B#Heading|x', { type: 'block_link', attrs: { id: 'AB', label: 'x' } }],
    ] as const) {
      const { insertContentAtCalls } = run([`[[${body}]]`, body], pages, onCreate)
      await vi.waitFor(() => expect(insertContentAtCalls.length).toBe(1))
      expect(insertContentAtCalls[0]?.content).toEqual(content)
    }
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('[[X | y]] stays text when its whole title ties by case, creating nothing (D10)', async () => {
    const onCreate = vi.fn<OnCreate>()
    const { insertContentAtCalls } = run(
      ['[[X | y|see]]', 'X | y|see'],
      [
        { id: 'XY', label: 'X | Y', title: 'X | Y' },
        { id: 'XY2', label: 'x | y', title: 'x | y' },
        { id: 'X', label: 'X', title: 'X' },
      ],
      onCreate,
    )
    await vi.waitFor(() => expect(insertContentAtCalls.length).toBe(1))
    expect(insertContentAtCalls[0]?.content).toBe('[[X | y|see]]')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('[[#heading]] names no page and is left alone', () => {
    const onCreate = vi.fn<OnCreate>()
    const deleteSpy = vi.fn()
    const ext = BlockLinkPicker.configure({ items: () => [], onCreate })
    const rules = (
      ext.config.addInputRules as unknown as (
        ...args: unknown[]
      ) => [{ handler: (...a: unknown[]) => unknown }]
    ).call({ options: ext.options, editor: {} })
    rules[0].handler({
      state: { tr: { delete: deleteSpy } },
      range: { from: 1, to: 12 },
      match: ['[[#heading]]', '#heading'],
    })
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(onCreate).not.toHaveBeenCalled()
  })
})

describe('pickedLinkLabel (#5160 D9, D10)', () => {
  const page = (title: string): PickerItem => ({ id: 'ID', label: title, title })

  it('keeps no label when the picked title is the whole typed text', () => {
    expect(pickedLinkLabel(page('A | B'), 'A | B')).toBeUndefined()
    expect(pickedLinkLabel(page('A | B'), 'a | b')).toBeUndefined()
  })

  it('keeps the text after the longest prefix the picked title names', () => {
    expect(pickedLinkLabel(page('A | B'), 'A | B|see')).toBe('see')
    expect(pickedLinkLabel(page('A'), 'A | B')).toBe('B')
  })

  it('keeps the text after the first `|` when the title names no prefix, unless it is the title', () => {
    expect(pickedLinkLabel(page('Apple'), 'A|see')).toBe('see')
    expect(pickedLinkLabel(page('Apple'), 'A|Apple')).toBeUndefined()
  })

  it('reads a prefix whose name is the title and an anchor, as the input rule does', () => {
    expect(pickedLinkLabel(page('A | B'), 'A | B#h|see')).toBe('see')
    expect(pickedLinkLabel(page('A'), 'A#h|see')).toBe('see')
    expect(pickedLinkLabel(page('A | B'), 'A | B#h|x|see')).toBe('x|see')
  })

  it('reads the prefix an alias match names as the picker does', () => {
    const aliased: PickerItem = { id: 'ID', label: 'Roadmap', isAlias: true, aliasText: 'a | b' }
    expect(pickedLinkLabel(aliased, 'A | B|go')).toBe('go')
  })
})

describe('BlockLinkPicker suggestion command — a picked title holding a `|` (#5160 D10)', () => {
  it('picking `A | B` after typing `[[A | B` stores no label', async () => {
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
    const mod = await import('@/editor/extensions/block-link-picker')
    const ext = mod.BlockLinkPicker.configure({ items: () => [] })
    ;(ext.config.addProseMirrorPlugins as (...args: unknown[]) => unknown).call({
      editor: {} as unknown,
      options: ext.options,
    })
    const inserted: Array<[string, string | undefined]> = []
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      deleteRange: () => chainProxy,
      insertBlockLink: (id: string, label?: string) => {
        inserted.push([id, label])
        return chainProxy
      },
      run: () => true,
    }
    for (const typed of ['[[A | B', '[[A | B|see']) {
      capturedCommand?.({
        editor: { chain: () => chainProxy, state: { doc: { textBetween: () => typed } } },
        range: { from: 1, to: 9 },
        props: { id: 'AB', label: 'A | B', title: 'A | B', isCreate: false },
      })
    }
    expect(inserted).toEqual([
      ['AB', undefined],
      ['AB', 'see'],
    ])

    vi.doUnmock('@tiptap/suggestion')
    vi.resetModules()
  })
})
