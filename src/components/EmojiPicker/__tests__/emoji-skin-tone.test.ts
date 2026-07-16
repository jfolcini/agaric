import { describe, expect, it } from 'vitest'

import {
  applySkinTone,
  computeTonableBases,
  SKIN_TONES,
  supportsSkinTone,
} from '@/components/EmojiPicker/emoji-skin-tone'

// #2671 — `supportsSkinTone`/`applySkinTone` no longer read a module-scope
// constant built from a statically-imported dataset; the tonable-base set is
// computed once by the caller (from the lazily-loaded dataset) and passed in.
// A small hand-built fixture stands in for the real dataset here — these
// tests are about the tone-application logic, not dataset content (that's
// covered by `emoji-data.test.ts`).
const FIXTURE_TONABLE = computeTonableBases([
  { char: '\u{1F44D}', name: 'thumbsup', keywords: [], skin: true }, // thumbsup
  { char: '\u{1F44B}', name: 'wave', keywords: [], skin: true }, // wave
  { char: '\u{1F590}\u{FE0F}', name: 'raised_hand', keywords: [], skin: true }, // raised_hand
  { char: '\u{1F600}', name: 'grinning', keywords: [] }, // grinning face — not tonable
  { char: '\u{2705}', name: 'check_mark', keywords: [] }, // check mark — not tonable
])

describe('emoji-skin-tone', () => {
  it('exposes default plus five Fitzpatrick tones', () => {
    expect(SKIN_TONES).toHaveLength(6)
    expect(SKIN_TONES[0]?.id).toBe('default')
    expect(SKIN_TONES[0]?.modifier).toBe('')
    // The five non-default modifiers are the U+1F3FB–U+1F3FF range.
    const modifiers = SKIN_TONES.slice(1).map((t) => t.modifier)
    expect(modifiers).toEqual(['\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'])
  })

  describe('computeTonableBases', () => {
    it('includes only entries flagged skin-tone-capable, variation-selector-stripped', () => {
      expect(FIXTURE_TONABLE.has('\u{1F44D}')).toBe(true) // thumbsup
      expect(FIXTURE_TONABLE.has('\u{1F590}')).toBe(true) // raised_hand, FE0F stripped
      expect(FIXTURE_TONABLE.has('\u{1F600}')).toBe(false) // grinning — not flagged
      expect(FIXTURE_TONABLE.has('\u{2705}')).toBe(false) // check mark — not flagged
    })
  })

  it('flags hand/body emoji as tonable and others as not', () => {
    expect(supportsSkinTone('\u{1F44D}', FIXTURE_TONABLE)).toBe(true) // thumbsup
    expect(supportsSkinTone('\u{1F44B}', FIXTURE_TONABLE)).toBe(true) // wave
    expect(supportsSkinTone('\u{1F600}', FIXTURE_TONABLE)).toBe(false) // grinning face
    expect(supportsSkinTone('\u{2705}', FIXTURE_TONABLE)).toBe(false) // check mark
  })

  it('treats an empty tonable set as "nothing is tonable" (the pre-load state)', () => {
    const empty = computeTonableBases([])
    expect(supportsSkinTone('\u{1F44D}', empty)).toBe(false)
    expect(applySkinTone('\u{1F44D}', 'dark', empty)).toBe('\u{1F44D}')
  })

  it('appends the modifier to a tonable base', () => {
    expect(applySkinTone('\u{1F44D}', 'medium', FIXTURE_TONABLE)).toBe('\u{1F44D}\u{1F3FD}')
    expect(applySkinTone('\u{1F44D}', 'dark', FIXTURE_TONABLE)).toBe('\u{1F44D}\u{1F3FF}')
  })

  it('strips a trailing variation selector before applying the modifier', () => {
    // raised_hand is stored as 🖐️ (base + FE0F); toned form drops FE0F.
    expect(applySkinTone('\u{1F590}\u{FE0F}', 'light', FIXTURE_TONABLE)).toBe('\u{1F590}\u{1F3FB}')
  })

  it('returns the base unchanged for the default tone', () => {
    expect(applySkinTone('\u{1F44D}', 'default', FIXTURE_TONABLE)).toBe('\u{1F44D}')
  })

  it('returns the base unchanged for non-tonable emoji', () => {
    expect(applySkinTone('\u{1F600}', 'dark', FIXTURE_TONABLE)).toBe('\u{1F600}')
    expect(applySkinTone('\u{2705}', 'medium', FIXTURE_TONABLE)).toBe('\u{2705}')
  })
})
