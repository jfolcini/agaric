/**
 * Tests for the BlockRefPicker extension.
 */

import { describe, expect, it, vi } from 'vitest'
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
    return { key: opts.pluginKey }
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
    expect(opts.char).toBe('((')
  })

  it('allowSpaces is true', () => {
    const { opts } = buildPlugins()
    expect(opts.allowSpaces).toBe(true)
  })

  it('allowedPrefixes is null', () => {
    const { opts } = buildPlugins()
    expect(opts.allowedPrefixes).toBeNull()
  })

  it('command calls deleteRange with the range', () => {
    const { opts } = buildPlugins()

    const mockDeleteRange = vi.fn(() => chainProxy)
    const mockInsertBlockRef = vi.fn(() => chainProxy)
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      deleteRange: mockDeleteRange,
      insertBlockRef: mockInsertBlockRef,
      run: () => true,
    }
    const mockEditor = { chain: () => chainProxy }

    const range = { from: 10, to: 20 }
    const props = { id: 'BLOCK_1', label: 'Test Block' }

    // biome-ignore lint/complexity/noBannedTypes: test needs direct invocation of captured command
    ;(opts.command as Function)({ editor: mockEditor, range, props })

    expect(mockDeleteRange).toHaveBeenCalledWith(range)
  })

  it('command calls insertBlockRef with item.id', () => {
    const { opts } = buildPlugins()

    const mockDeleteRange = vi.fn(() => chainProxy)
    const mockInsertBlockRef = vi.fn(() => chainProxy)
    const chainProxy: Record<string, unknown> = {
      focus: () => chainProxy,
      deleteRange: mockDeleteRange,
      insertBlockRef: mockInsertBlockRef,
      run: () => true,
    }
    const mockEditor = { chain: () => chainProxy }

    const range = { from: 5, to: 15 }
    const props = { id: 'BLOCK_42', label: 'My Block' }

    // biome-ignore lint/complexity/noBannedTypes: test needs direct invocation of captured command
    ;(opts.command as Function)({ editor: mockEditor, range, props })

    expect(mockInsertBlockRef).toHaveBeenCalledWith('BLOCK_42')
  })

  it('command calls chain().focus().run()', () => {
    const { opts } = buildPlugins()

    const mockRun = vi.fn(() => true)
    const mockDeleteRange = vi.fn(() => chainProxy)
    const mockInsertBlockRef = vi.fn(() => chainProxy)
    const mockFocus = vi.fn(() => chainProxy)
    const chainProxy: Record<string, unknown> = {
      focus: mockFocus,
      deleteRange: mockDeleteRange,
      insertBlockRef: mockInsertBlockRef,
      run: mockRun,
    }
    const mockChain = vi.fn(() => chainProxy)
    const mockEditor = { chain: mockChain }

    const range = { from: 0, to: 10 }
    const props = { id: 'BLOCK_99', label: 'Another Block' }

    // biome-ignore lint/complexity/noBannedTypes: test needs direct invocation of captured command
    ;(opts.command as Function)({ editor: mockEditor, range, props })

    expect(mockChain).toHaveBeenCalled()
    expect(mockFocus).toHaveBeenCalled()
    expect(mockRun).toHaveBeenCalled()
  })
})
