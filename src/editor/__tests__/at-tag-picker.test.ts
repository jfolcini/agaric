/**
 * Tests for the AtTagPicker extension.
 */

import { describe, expect, it } from 'vitest'
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
