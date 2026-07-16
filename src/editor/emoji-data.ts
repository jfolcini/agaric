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
 *
 * #2671 — the generated blob is ~150 KB and every picker surface is reachable
 * from the editor's first paint (the `:` trigger is an always-registered
 * TipTap extension), so a plain `import` here would put that payload — plus
 * three module-scope-built derived structures — on the critical path for
 * every cold start, even for users who never open an emoji surface. Instead
 * `loadEmojiDataset()` pulls the generated module in via a dynamic `import()`
 * on first use and memoizes the result (module load + derived-structure build
 * happen at most once); every export below is async and awaits it. Callers
 * that need the same resolved dataset repeatedly in one render (the
 * browse-grid picker) should hold the resolved value themselves rather than
 * re-invoking these — `loadEmojiDataset()` is cheap to re-call (it returns
 * the cached promise), but there is no reason to re-await it per keystroke.
 */

import { matchSorter } from 'match-sorter'

import type { GeneratedEmoji, GeneratedEmojiGroup } from '@/editor/emoji-data.generated'

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
 * is data-driven rather than hand-declared so it can never drift from the
 * generated dataset.
 */
export type EmojiGroup = string

export interface EmojiGroupBucket {
  readonly group: EmojiGroup
  readonly emoji: readonly EmojiEntry[]
}

/** The full dataset, built once from the generated blob and cached (#2671). */
export interface EmojiDataset {
  readonly groups: readonly EmojiGroup[]
  /** The categorized buckets (the browse-grid render structure). */
  readonly grouped: readonly EmojiGroupBucket[]
  /** Flat list (render order = group order), shared by search + the inline picker. */
  readonly flat: readonly EmojiEntry[]
  /**
   * Exact-shortcode → emoji lookup. Keyed on the canonical `name` (lowercased)
   * ONLY — NOT keywords — so the `:smile:` closing-colon input rule (#281) is
   * a deterministic 1:1 replacement (a keyword like "happy" maps to many
   * emoji and must stay typeahead-only).
   */
  readonly byShortcode: ReadonlyMap<string, string>
}

function toEntry(e: GeneratedEmoji): EmojiEntry {
  return e.s
    ? { char: e.c, name: e.n, keywords: e.k ?? [], skin: true }
    : { char: e.c, name: e.n, keywords: e.k ?? [] }
}

function buildDataset(raw: readonly GeneratedEmojiGroup[]): EmojiDataset {
  const grouped: readonly EmojiGroupBucket[] = raw.map((g) => ({
    group: g.group,
    emoji: g.emoji.map(toEntry),
  }))
  const flat: readonly EmojiEntry[] = grouped.flatMap((g) => g.emoji)
  const groups: readonly EmojiGroup[] = raw.map((g) => g.group)
  const byShortcode: ReadonlyMap<string, string> = new Map(
    flat.map((e) => [e.name.toLowerCase(), e.char]),
  )
  return { groups, grouped, flat, byShortcode }
}

let datasetPromise: Promise<EmojiDataset> | null = null
/** Set synchronously the instant `datasetPromise` resolves — see `peekEmojiDataset`. */
let resolvedDataset: EmojiDataset | null = null

/**
 * Load (and memoize) the full emoji dataset. The first call triggers a
 * dynamic `import()` of `emoji-data.generated.ts` and builds the derived
 * grouped/flat/shortcode structures; every subsequent call — concurrent or
 * later — returns the SAME cached promise, so the ~150 KB blob is fetched and
 * processed at most once per session, on first use rather than at module
 * load (#2671).
 */
export function loadEmojiDataset(): Promise<EmojiDataset> {
  datasetPromise ??= import('@/editor/emoji-data.generated').then(({ EMOJI_DATA }) => {
    const dataset = buildDataset(EMOJI_DATA)
    resolvedDataset = dataset
    return dataset
  })
  return datasetPromise
}

/**
 * Synchronous peek at an already-resolved dataset, or `null` if
 * `loadEmojiDataset()` hasn't settled yet. For the rare caller that cannot
 * await (the `:shortcode:` closing-colon `InputRule` handler, which ProseMirror
 * requires to run synchronously) — see `emoji-picker.ts`.
 */
export function peekEmojiDataset(): EmojiDataset | null {
  return resolvedDataset
}

/**
 * Pure, synchronous match-sorter filter over an already-resolved flat list.
 * Exported so a caller that holds a resolved `EmojiDataset` in state (the
 * browse-grid `<EmojiPicker>`, which loads it once via `loadEmojiDataset()`
 * on mount) can re-filter per keystroke WITHOUT re-awaiting the async
 * `searchEmoji()` wrapper below (which does the same work, just re-entering
 * through the dataset promise each call).
 */
export function matchEmojiQuery(
  flat: readonly EmojiEntry[],
  query: string,
  limit: number,
): EmojiEntry[] {
  const q = query.replace(/^:/, '').trim()
  if (q === '') return flat.slice(0, limit)
  return matchSorter(flat as EmojiEntry[], q, {
    keys: ['name', 'keywords'],
  }).slice(0, limit)
}

/**
 * Fuzzy-search the full emoji set by shortcode + aliases. Mirrors the
 * match-sorter usage in the other pickers (`slash-commands`, tag search).
 * A leading `:` (if the caller passes the raw trigger text) is stripped.
 */
export async function searchEmoji(query: string, limit = 24): Promise<EmojiEntry[]> {
  const { flat } = await loadEmojiDataset()
  return matchEmojiQuery(flat, query, limit)
}

/**
 * The categorized buckets for the browse-grid (#286). Every emoji appears in
 * exactly one bucket and no group is empty (the generator omits empties).
 */
export async function groupedEmoji(): Promise<readonly EmojiGroupBucket[]> {
  const { grouped } = await loadEmojiDataset()
  return grouped
}

/** Return the native emoji for an exact shortcode `name`, or null if unknown. */
export async function emojiByShortcode(name: string): Promise<string | null> {
  const { byShortcode } = await loadEmojiDataset()
  return byShortcode.get(name.toLowerCase()) ?? null
}
