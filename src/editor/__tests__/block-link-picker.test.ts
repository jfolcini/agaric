/**
 * Tests for the BlockLinkPicker extension.
 */

import { describe, expect, it } from 'vitest'
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
