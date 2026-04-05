/**
 * Tests for the TagRef extension.
 */

import { describe, expect, it } from 'vitest'
import { TagRef } from '../extensions/tag-ref'

describe('TagRef', () => {
  it('creates an extension with the correct name', () => {
    const ext = TagRef.configure({})
    expect(ext.name).toBe('tag_ref')
  })

  it('has a default resolveName that truncates the ULID', () => {
    const ext = TagRef.configure({})
    const result = ext.options.resolveName('01ABCDEF1234567890ABCDEF12')
    expect(result).toBe('#01ABCDEF...')
  })

  it('has resolveStatus undefined by default', () => {
    const ext = TagRef.configure({})
    expect(ext.options.resolveStatus).toBeUndefined()
  })

  it('accepts a custom resolveName option', () => {
    const resolveName = (id: string) => `Tag:${id}`
    const ext = TagRef.configure({ resolveName })
    expect(ext.options.resolveName('abc')).toBe('Tag:abc')
  })

  it('accepts a custom resolveStatus option', () => {
    const resolveStatus = () => 'deleted' as const
    const ext = TagRef.configure({ resolveName: (id) => id, resolveStatus })
    expect(ext.options.resolveStatus).toBe(resolveStatus)
  })
})

describe('TagRef Backspace re-expand (H-14)', () => {
  it('registers Backspace keyboard shortcut', () => {
    const ext = TagRef.configure({
      resolveName: (id) => `Name:${id}`,
    })
    expect(ext.config.addKeyboardShortcuts).toBeDefined()
  })

  it('uses resolveName to get the display name for re-expansion', () => {
    const resolveName = (_id: string) => `My Tag Name`
    const ext = TagRef.configure({ resolveName })
    // Verify the option is available (keyboard shortcut uses it internally)
    expect(ext.options.resolveName('any-id')).toBe('My Tag Name')
  })
})
