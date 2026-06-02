import { describe, expect, it } from 'vitest'

import { EMOJI, EMOJI_GROUPS, groupedEmoji, searchEmoji } from '../emoji-data'

describe('emoji-data', () => {
  it('every entry has a non-empty char, name, and keyword array', () => {
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

  it('matches by shortcode', () => {
    expect(searchEmoji('joy')[0]?.char).toBe('\u{1F602}')
    expect(searchEmoji('rocket')[0]?.char).toBe('\u{1F680}')
    expect(searchEmoji('check')[0]?.char).toBe('\u{2705}')
  })

  it('matches by alias keyword', () => {
    const thumbs = searchEmoji('thumbsup')
    expect(thumbs[0]?.char).toBe('\u{1F44D}')
    // `like` is an alias of thumbsup.
    expect(searchEmoji('like').some((e) => e.char === '\u{1F44D}')).toBe(true)
    // `idea` is an alias of bulb.
    expect(searchEmoji('idea').some((e) => e.char === '\u{1F4A1}')).toBe(true)
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
  })

  describe('groupedEmoji', () => {
    it('partitions every emoji into exactly one group, losing none', () => {
      const buckets = groupedEmoji()
      const flattened = buckets.flatMap((b) => b.emoji)
      expect(flattened).toHaveLength(EMOJI.length)
      // Same multiset of chars as the flat list (order within groups preserved).
      expect(flattened.map((e) => e.name)).toEqual(EMOJI.map((e) => e.name))
    })

    it('only emits known groups, in declared order, with no empties', () => {
      const buckets = groupedEmoji()
      for (const b of buckets) {
        expect(EMOJI_GROUPS).toContain(b.group)
        expect(b.emoji.length).toBeGreaterThan(0)
      }
      const order = buckets.map((b) => b.group)
      // Emitted order is a subsequence of the canonical EMOJI_GROUPS order.
      const canonicalIdx = order.map((g) => EMOJI_GROUPS.indexOf(g))
      expect(canonicalIdx).toEqual([...canonicalIdx].sort((a, z) => a - z))
    })

    it('places boundary emoji at the head of their group', () => {
      const buckets = groupedEmoji()
      const smileys = buckets.find((b) => b.group === 'Smileys & Emotion')
      expect(smileys?.emoji[0]?.name).toBe('grinning')
      const gestures = buckets.find((b) => b.group === 'Gestures & Body')
      expect(gestures?.emoji[0]?.name).toBe('thumbsup')
    })
  })
})
