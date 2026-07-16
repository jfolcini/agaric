import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  emojiByShortcode,
  groupedEmoji,
  loadEmojiDataset,
  searchEmoji,
  type EmojiDataset,
  type EmojiEntry,
} from '../emoji-data'

// #2671 — the dataset is lazy-loaded via a memoized dynamic `import()` rather
// than a static top-level import. Every read goes through one of the async
// accessors below (or a resolved `EmojiDataset` fetched once per test file).
async function allEmoji(): Promise<readonly EmojiEntry[]> {
  const { flat } = await loadEmojiDataset()
  return flat
}

async function emojiGroupNames(): Promise<readonly string[]> {
  const { groups } = await loadEmojiDataset()
  return groups
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('emoji-data', () => {
  it('ships the full categorized Unicode set (~1900 emoji, 9 CLDR groups)', async () => {
    // Build-time generated from emojibase-data; far larger than the retired
    // hand-curated ~120 set, but a stable lower bound guards a broken regen.
    const emoji = await allEmoji()
    const groups = await emojiGroupNames()
    expect(emoji.length).toBeGreaterThan(1500)
    expect(groups).toContain('Smileys & Emotion')
    expect(groups).toContain('Flags')
    expect(groups.length).toBe(9)
  })

  // #281 — `:shortcode:` closing-colon auto-replace lookup.
  it('emojiByShortcode resolves an exact shortcode (case-insensitive) and null otherwise', async () => {
    const emoji = await allEmoji()
    const joy = emoji.find((e) => e.name === 'joy')
    expect(joy).toBeDefined()
    expect(await emojiByShortcode('joy')).toBe(joy?.char)
    // Case-insensitive — users may type `:JOY:`.
    expect(await emojiByShortcode('JOY')).toBe(joy?.char)
    // Unknown shortcode → null (so the input rule leaves the text untouched).
    expect(await emojiByShortcode('definitely_not_an_emoji_xyz')).toBeNull()
    // Keywords are NOT matched (deterministic 1:1 replacement only).
    expect(await emojiByShortcode('')).toBeNull()
  })

  it('every entry has a non-empty char, a clean shortcode name, and a keyword array', async () => {
    const emoji = await allEmoji()
    for (const e of emoji) {
      expect(e.char.length).toBeGreaterThan(0)
      expect(e.name).toMatch(/^[a-z0-9_]+$/)
      expect(Array.isArray(e.keywords)).toBe(true)
    }
  })

  it('shortcodes are unique', async () => {
    const emoji = await allEmoji()
    const names = emoji.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('flags a subset of emoji as skin-tone capable', async () => {
    const emoji = await allEmoji()
    const tonable = emoji.filter((e) => e.skin)
    expect(tonable.length).toBeGreaterThan(50)
    // thumbsup is tonable; a smiley is not.
    expect(emoji.find((e) => e.name === 'thumbsup')?.skin).toBe(true)
    expect(emoji.find((e) => e.name === 'grinning')?.skin).toBeUndefined()
  })

  it('matches by shortcode (exact name ranks first)', async () => {
    expect((await searchEmoji('joy'))[0]?.char).toBe('\u{1F602}')
    expect((await searchEmoji('rocket'))[0]?.char).toBe('\u{1F680}')
    expect((await searchEmoji('grinning'))[0]?.char).toBe('\u{1F600}')
    expect((await searchEmoji('thumbsup'))[0]?.char).toBe('\u{1F44D}\u{FE0F}')
  })

  it('matches by alias keyword', async () => {
    // `idea` is a keyword of 💡 bulb.
    expect((await searchEmoji('idea')).some((e) => e.name === 'bulb')).toBe(true)
  })

  it('strips a leading colon from the query', async () => {
    expect((await searchEmoji(':joy'))[0]?.char).toBe('\u{1F602}')
  })

  it('returns a bounded default list for an empty query', async () => {
    const all = await searchEmoji('')
    expect(all.length).toBeGreaterThan(0)
    expect(all.length).toBeLessThanOrEqual(24)
  })

  it('returns nothing for a query with no match', async () => {
    expect(await searchEmoji('zzzznotanemoji')).toEqual([])
  })

  it('respects the limit argument', async () => {
    expect(await searchEmoji('', 5)).toHaveLength(5)
    expect((await searchEmoji('face', 10)).length).toBeLessThanOrEqual(10)
  })

  describe('groupedEmoji', () => {
    it('partitions every emoji into exactly one group, losing none', async () => {
      const buckets = await groupedEmoji()
      const emoji = await allEmoji()
      const flattened = buckets.flatMap((b) => b.emoji)
      expect(flattened).toHaveLength(emoji.length)
      // Same sequence of chars as the flat list (order preserved).
      expect(flattened.map((e) => e.name)).toEqual(emoji.map((e) => e.name))
    })

    it('only emits known groups, in declared order, with no empties', async () => {
      const buckets = await groupedEmoji()
      const groups = await emojiGroupNames()
      for (const b of buckets) {
        expect(groups).toContain(b.group)
        expect(b.emoji.length).toBeGreaterThan(0)
      }
      const order = buckets.map((b) => b.group)
      const canonicalIdx = order.map((g) => groups.indexOf(g))
      expect(canonicalIdx).toEqual([...canonicalIdx].toSorted((a, z) => a - z))
    })

    it('leads with the Smileys & Emotion group', async () => {
      const buckets = await groupedEmoji()
      expect(buckets[0]?.group).toBe('Smileys & Emotion')
      expect(buckets[0]?.emoji[0]?.name).toBe('grinning')
    })
  })

  // #2671 — the dataset is fetched via a dynamic `import()` on first use and
  // memoized, NOT statically imported at module scope. These tests pin that
  // contract directly (isolated module registry per test so the module-level
  // `datasetPromise` cache doesn't leak across them).
  describe('lazy loading (#2671)', () => {
    afterEach(() => {
      vi.doUnmock('../emoji-data.generated')
      vi.resetModules()
    })

    it('has not resolved a dataset before any loader is called', async () => {
      vi.resetModules()
      const mod = await import('../emoji-data')
      expect(mod.peekEmojiDataset()).toBeNull()
    })

    it('loadEmojiDataset memoizes: concurrent + sequential calls share one import', async () => {
      vi.resetModules()
      const importSpy = vi.fn()
      // A tiny fixture, not the real ~1900-entry blob — this test is about
      // the memoization contract (one import, one build), not dataset
      // content (covered by the rest of this file against the real module).
      vi.doMock('../emoji-data.generated', () => {
        importSpy()
        return {
          EMOJI_DATA: [
            { group: 'Test', emoji: [{ c: '\u{1F600}', n: 'fixture_emoji', k: ['fixture'] }] },
          ],
        }
      })
      const mod = await import('../emoji-data')

      // Two concurrent calls before either resolves...
      const [a, b] = await Promise.all([mod.loadEmojiDataset(), mod.loadEmojiDataset()])
      // ...and a third call after resolution — all three share the same
      // underlying dynamic import (memoized), not one per call.
      const c = await mod.loadEmojiDataset()

      expect(importSpy).toHaveBeenCalledTimes(1)
      expect(a).toBe(b)
      expect(b).toBe(c)
      expect(a.flat[0]?.name).toBe('fixture_emoji')
    })

    it('peekEmojiDataset synchronously reflects the resolved dataset once loadEmojiDataset settles', async () => {
      vi.resetModules()
      const mod = await import('../emoji-data')
      expect(mod.peekEmojiDataset()).toBeNull()
      const resolved: EmojiDataset = await mod.loadEmojiDataset()
      expect(mod.peekEmojiDataset()).toBe(resolved)
    })
  })
})
