import { describe, expect, it } from 'vitest'

import { applySkinTone, SKIN_TONES, supportsSkinTone } from '../emoji-skin-tone'

describe('emoji-skin-tone', () => {
  it('exposes default plus five Fitzpatrick tones', () => {
    expect(SKIN_TONES).toHaveLength(6)
    expect(SKIN_TONES[0]?.id).toBe('default')
    expect(SKIN_TONES[0]?.modifier).toBe('')
    // The five non-default modifiers are the U+1F3FB–U+1F3FF range.
    const modifiers = SKIN_TONES.slice(1).map((t) => t.modifier)
    expect(modifiers).toEqual(['\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'])
  })

  it('flags hand/body emoji as tonable and others as not', () => {
    expect(supportsSkinTone('\u{1F44D}')).toBe(true) // thumbsup
    expect(supportsSkinTone('\u{1F44B}')).toBe(true) // wave
    expect(supportsSkinTone('\u{1F600}')).toBe(false) // grinning face
    expect(supportsSkinTone('\u{2705}')).toBe(false) // check mark
  })

  it('appends the modifier to a tonable base', () => {
    expect(applySkinTone('\u{1F44D}', 'medium')).toBe('\u{1F44D}\u{1F3FD}')
    expect(applySkinTone('\u{1F44D}', 'dark')).toBe('\u{1F44D}\u{1F3FF}')
  })

  it('strips a trailing variation selector before applying the modifier', () => {
    // raised_hand is stored as 🖐️ (base + FE0F); toned form drops FE0F.
    expect(applySkinTone('\u{1F590}\u{FE0F}', 'light')).toBe('\u{1F590}\u{1F3FB}')
  })

  it('returns the base unchanged for the default tone', () => {
    expect(applySkinTone('\u{1F44D}', 'default')).toBe('\u{1F44D}')
  })

  it('returns the base unchanged for non-tonable emoji', () => {
    expect(applySkinTone('\u{1F600}', 'dark')).toBe('\u{1F600}')
    expect(applySkinTone('\u{2705}', 'medium')).toBe('\u{2705}')
  })
})
