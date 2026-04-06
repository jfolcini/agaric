/**
 * Tests for the BlockLinkPicker extension.
 */

import { describe, expect, it, vi } from 'vitest'
import { BlockLinkPicker } from '../extensions/block-link-picker'

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
