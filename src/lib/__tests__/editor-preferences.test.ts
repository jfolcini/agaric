import { afterEach, describe, expect, it } from 'vitest'

import { EMOJI_PICKER_ENABLED_KEY, isEmojiPickerEnabled } from '../editor-preferences'

describe('editor-preferences — isEmojiPickerEnabled', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('defaults to enabled when the key is absent', () => {
    expect(isEmojiPickerEnabled()).toBe(true)
  })

  it('is disabled only when explicitly set to false', () => {
    localStorage.setItem(EMOJI_PICKER_ENABLED_KEY, 'false')
    expect(isEmojiPickerEnabled()).toBe(false)
    localStorage.setItem(EMOJI_PICKER_ENABLED_KEY, 'true')
    expect(isEmojiPickerEnabled()).toBe(true)
  })

  it('falls back to enabled on malformed stored data', () => {
    localStorage.setItem(EMOJI_PICKER_ENABLED_KEY, 'not-json')
    expect(isEmojiPickerEnabled()).toBe(true)
  })
})
