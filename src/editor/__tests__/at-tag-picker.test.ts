/**
 * Tests for the AtTagPicker extension.
 */

import { describe, expect, it, vi } from 'vitest'
import { AtTagPicker } from '../extensions/at-tag-picker'

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
