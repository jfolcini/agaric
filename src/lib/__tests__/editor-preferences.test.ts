import { afterEach, describe, expect, it } from 'vitest'

import {
  EMOJI_PICKER_ENABLED_KEY,
  isEmojiPickerEnabled,
  isMarkdownRevealEnabled,
} from '@/lib/editor-preferences'
import { PREFERENCES, writePreference } from '@/lib/preferences'

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

describe('editor-preferences — isMarkdownRevealEnabled', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('is on for a device that never set it', () => {
    expect(isMarkdownRevealEnabled()).toBe(true)
  })

  it('stays off on a device that turned it off, including one that did before it was on by default', () => {
    // The raw value the Settings switch stored when the default was off.
    localStorage.setItem('agaric-reveal-markdown-syntax', 'false')
    expect(isMarkdownRevealEnabled()).toBe(false)
    writePreference(PREFERENCES.revealMarkdownSyntax, true)
    expect(isMarkdownRevealEnabled()).toBe(true)
    writePreference(PREFERENCES.revealMarkdownSyntax, false)
    expect(isMarkdownRevealEnabled()).toBe(false)
  })
})
