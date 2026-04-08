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
