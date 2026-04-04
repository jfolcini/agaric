/**
 * Tests for the PropertyPicker extension.
 */

import { describe, expect, it, vi } from 'vitest'
import { PropertyPicker } from '../extensions/property-picker'

describe('PropertyPicker', () => {
  it('creates an extension with the correct name', () => {
    const ext = PropertyPicker.configure({ items: () => [] })
    expect(ext.name).toBe('propertyPicker')
  })

  it('has default items option', () => {
    const ext = PropertyPicker.configure({})
    expect(ext.options.items).toBeDefined()
  })

  it('has onSelect undefined by default', () => {
    const ext = PropertyPicker.configure({})
    expect(ext.options.onSelect).toBeUndefined()
  })

  it('accepts a custom onSelect option', () => {
    const onSelect = vi.fn()
    const ext = PropertyPicker.configure({ items: () => [], onSelect })
    expect(ext.options.onSelect).toBe(onSelect)
  })

  it('accepts a custom items option', () => {
    const items = vi.fn().mockResolvedValue([{ id: 'status', label: 'status' }])
    const ext = PropertyPicker.configure({ items })
    expect(ext.options.items).toBe(items)
  })

  it('default items returns empty array', () => {
    const ext = PropertyPicker.configure({})
    const result = ext.options.items('test')
    expect(result).toEqual([])
  })
})
