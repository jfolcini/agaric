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
