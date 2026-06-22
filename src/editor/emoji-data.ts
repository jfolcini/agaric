/**
 * Emoji dataset + fuzzy search, shared by the inline `:` typeahead (#281) and
 * the browse-grid `<EmojiPicker>` dialog (#286).
 *
 * The data is the full categorized Unicode set (~1900 emoji, 9 CLDR groups),
 * generated at build time from `emojibase-data` into `emoji-data.generated.ts`
 * — a devDependency only, so nothing extra ships at runtime. Regenerate with
 * `npm run gen:emoji`. This module adapts that compact blob (`c`/`n`/`k`/`s`
 * keys) into the `EmojiEntry` shape the pickers consume and exposes one
 * `searchEmoji` matcher (match-sorter) so both surfaces rank identically.
 */

import { matchSorter } from 'match-sorter'

import { EMOJI_DATA } from './emoji-data.generated'

export interface EmojiEntry {
  /** The native Unicode emoji to insert. */
  readonly char: string
  /** Canonical shortcode (primary match key). */
  readonly name: string
  /** Additional aliases / synonyms for fuzzy search. */
  readonly keywords: readonly string[]
  /** Whether the base accepts a Fitzpatrick skin-tone modifier (#286). */
  readonly skin?: boolean
}

/**
 * Display group names, in render order — the nine standard CLDR categories the
 * generator emits (the "Component" group of bare modifiers is excluded). This
 * is data-driven rather than hand-declared so it can never drift from `EMOJI`.
 */
export type EmojiGroup = string
export const EMOJI_GROUPS: readonly EmojiGroup[] = EMOJI_DATA.map((g) => g.group)

export interface EmojiGroupBucket {
  readonly group: EmojiGroup
  readonly emoji: readonly EmojiEntry[]
}

function toEntry(e: (typeof EMOJI_DATA)[number]['emoji'][number]): EmojiEntry {
  return e.s
    ? { char: e.c, name: e.n, keywords: e.k ?? [], skin: true }
    : { char: e.c, name: e.n, keywords: e.k ?? [] }
}

/** The categorized buckets (the browse-grid render structure), built once. */
const GROUPED: readonly EmojiGroupBucket[] = EMOJI_DATA.map((g) => ({
  group: g.group,
  emoji: g.emoji.map(toEntry),
}))

/** Flat list (render order = group order), shared by search + the inline picker. */
export const EMOJI: readonly EmojiEntry[] = GROUPED.flatMap((g) => g.emoji)

/**
 * Fuzzy-search the full emoji set by shortcode + aliases. Mirrors the
 * match-sorter usage in the other pickers (`slash-commands`, tag search).
 * A leading `:` (if the caller passes the raw trigger text) is stripped.
 */
export function searchEmoji(query: string, limit = 24): EmojiEntry[] {
  const q = query.replace(/^:/, '').trim()
  if (q === '') return EMOJI.slice(0, limit)
  return matchSorter(EMOJI as EmojiEntry[], q, {
    keys: ['name', 'keywords'],
  }).slice(0, limit)
}

/**
 * The categorized buckets for the browse-grid (#286). Returns the prebuilt,
 * in-order grouping — every emoji appears in exactly one bucket and no group
 * is empty (the generator omits empties).
 */
export function groupedEmoji(): readonly EmojiGroupBucket[] {
  return GROUPED
}

/**
 * Exact-shortcode → emoji lookup, built once. Keyed on the canonical `name`
 * (lowercased) ONLY — NOT keywords — so the `:smile:` closing-colon input rule
 * (#281) is a deterministic 1:1 replacement (a keyword like "happy" maps to
 * many emoji and must stay typeahead-only).
 */
const BY_SHORTCODE: ReadonlyMap<string, string> = new Map(
  EMOJI.map((e) => [e.name.toLowerCase(), e.char]),
)

/** Return the native emoji for an exact shortcode `name`, or null if unknown. */
export function emojiByShortcode(name: string): string | null {
  return BY_SHORTCODE.get(name.toLowerCase()) ?? null
}
