import { describe, expect, it } from 'vitest'

import { emojiByShortcode, EMOJI, EMOJI_GROUPS, groupedEmoji, searchEmoji } from '../emoji-data'

describe('emoji-data', () => {
  it('ships the full categorized Unicode set (~1900 emoji, 9 CLDR groups)', () => {
    // Build-time generated from emojibase-data; far larger than the retired
    // hand-curated ~120 set, but a stable lower bound guards a broken regen.
    expect(EMOJI.length).toBeGreaterThan(1500)
    expect(EMOJI_GROUPS).toContain('Smileys & Emotion')
    expect(EMOJI_GROUPS).toContain('Flags')
    expect(EMOJI_GROUPS.length).toBe(9)
  })

  // #281 — `:shortcode:` closing-colon auto-replace lookup.
  it('emojiByShortcode resolves an exact shortcode (case-insensitive) and null otherwise', () => {
    const joy = EMOJI.find((e) => e.name === 'joy')
    expect(joy).toBeDefined()
    expect(emojiByShortcode('joy')).toBe(joy?.char)
    // Case-insensitive — users may type `:JOY:`.
    expect(emojiByShortcode('JOY')).toBe(joy?.char)
    // Unknown shortcode → null (so the input rule leaves the text untouched).
    expect(emojiByShortcode('definitely_not_an_emoji_xyz')).toBeNull()
    // Keywords are NOT matched (deterministic 1:1 replacement only).
    expect(emojiByShortcode('')).toBeNull()
  })

  it('every entry has a non-empty char, a clean shortcode name, and a keyword array', () => {
    for (const e of EMOJI) {
      expect(e.char.length).toBeGreaterThan(0)
      expect(e.name).toMatch(/^[a-z0-9_]+$/)
      expect(Array.isArray(e.keywords)).toBe(true)
    }
  })

  it('shortcodes are unique', () => {
    const names = EMOJI.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('flags a subset of emoji as skin-tone capable', () => {
    const tonable = EMOJI.filter((e) => e.skin)
    expect(tonable.length).toBeGreaterThan(50)
    // thumbsup is tonable; a smiley is not.
    expect(EMOJI.find((e) => e.name === 'thumbsup')?.skin).toBe(true)
    expect(EMOJI.find((e) => e.name === 'grinning')?.skin).toBeUndefined()
  })

  it('matches by shortcode (exact name ranks first)', () => {
    expect(searchEmoji('joy')[0]?.char).toBe('\u{1F602}')
    expect(searchEmoji('rocket')[0]?.char).toBe('\u{1F680}')
    expect(searchEmoji('grinning')[0]?.char).toBe('\u{1F600}')
    expect(searchEmoji('thumbsup')[0]?.char).toBe('\u{1F44D}\u{FE0F}')
  })

  it('matches by alias keyword', () => {
    // `idea` is a keyword of 💡 bulb.
    expect(searchEmoji('idea').some((e) => e.name === 'bulb')).toBe(true)
  })

  it('strips a leading colon from the query', () => {
    expect(searchEmoji(':joy')[0]?.char).toBe('\u{1F602}')
  })

  it('returns a bounded default list for an empty query', () => {
    const all = searchEmoji('')
    expect(all.length).toBeGreaterThan(0)
    expect(all.length).toBeLessThanOrEqual(24)
  })

  it('returns nothing for a query with no match', () => {
    expect(searchEmoji('zzzznotanemoji')).toEqual([])
  })

  it('respects the limit argument', () => {
    expect(searchEmoji('', 5)).toHaveLength(5)
    expect(searchEmoji('face', 10).length).toBeLessThanOrEqual(10)
  })

  describe('groupedEmoji', () => {
    it('partitions every emoji into exactly one group, losing none', () => {
      const buckets = groupedEmoji()
      const flattened = buckets.flatMap((b) => b.emoji)
      expect(flattened).toHaveLength(EMOJI.length)
      // Same sequence of chars as the flat list (order preserved).
      expect(flattened.map((e) => e.name)).toEqual(EMOJI.map((e) => e.name))
    })

    it('only emits known groups, in declared order, with no empties', () => {
      const buckets = groupedEmoji()
      for (const b of buckets) {
        expect(EMOJI_GROUPS).toContain(b.group)
        expect(b.emoji.length).toBeGreaterThan(0)
      }
      const order = buckets.map((b) => b.group)
      const canonicalIdx = order.map((g) => EMOJI_GROUPS.indexOf(g))
      expect(canonicalIdx).toEqual([...canonicalIdx].toSorted((a, z) => a - z))
    })

    it('leads with the Smileys & Emotion group', () => {
      const buckets = groupedEmoji()
      expect(buckets[0]?.group).toBe('Smileys & Emotion')
      expect(buckets[0]?.emoji[0]?.name).toBe('grinning')
    })
  })
})
