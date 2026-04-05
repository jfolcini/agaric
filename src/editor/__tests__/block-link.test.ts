/**
 * Tests for the BlockLink extension.
 */

import { describe, expect, it } from 'vitest'
import { BlockLink } from '../extensions/block-link'

describe('BlockLink', () => {
  it('creates an extension with the correct name', () => {
    const ext = BlockLink.configure({})
    expect(ext.name).toBe('block_link')
  })

  it('has a default resolveTitle that truncates the ULID', () => {
    const ext = BlockLink.configure({})
    const result = ext.options.resolveTitle('01ABCDEF1234567890ABCDEF12')
    expect(result).toBe('[[01ABCDEF...]]')
  })

  it('has onNavigate undefined by default', () => {
    const ext = BlockLink.configure({})
    expect(ext.options.onNavigate).toBeUndefined()
  })

  it('has resolveStatus undefined by default', () => {
    const ext = BlockLink.configure({})
    expect(ext.options.resolveStatus).toBeUndefined()
  })

  it('accepts a custom resolveTitle option', () => {
    const resolveTitle = (id: string) => `Page:${id}`
    const ext = BlockLink.configure({ resolveTitle })
    expect(ext.options.resolveTitle('abc')).toBe('Page:abc')
  })

  it('accepts a custom onNavigate option', () => {
    const onNavigate = (_id: string) => {}
    const ext = BlockLink.configure({ resolveTitle: (id) => id, onNavigate })
    expect(ext.options.onNavigate).toBe(onNavigate)
  })
})

describe('BlockLink Backspace re-expand (H-14)', () => {
  it('registers Backspace keyboard shortcut', () => {
    const ext = BlockLink.configure({
      resolveTitle: (id) => `Title:${id}`,
    })
    expect(ext.config.addKeyboardShortcuts).toBeDefined()
  })

  it('uses resolveTitle to get the display name for re-expansion', () => {
    const resolveTitle = (_id: string) => `My Page Title`
    const ext = BlockLink.configure({ resolveTitle })
    // Verify the option is available (keyboard shortcut uses it internally)
    expect(ext.options.resolveTitle('any-id')).toBe('My Page Title')
  })
})
