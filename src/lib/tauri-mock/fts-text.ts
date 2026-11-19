/**
 * The mock's stand-in for `fts_blocks.stripped` and the index's MATCH, which
 * the backlink filters and unlinked references read (`handlers/links.ts`).
 */

import { isEscapableChar } from '@/editor/markdown-parse/parser'
import { linkTokenRe } from '@/lib/tauri-mock/handlers/shared'
import { blocks } from '@/lib/tauri-mock/seed'

// ---------------------------------------------------------------------------
// #3938 — the `fts_blocks.stripped` stand-in
//
// The backend does NOT index `blocks.content`. Every FTS5 candidate set is a
// trigram scan over `fts_blocks.stripped`, the column
// `strip_for_fts_with_maps` writes
// (`src-tauri/agaric-store/src/fts/strip.rs`). Until #3938 this mock
// ran `matchesSearchFolded` (`@/lib/fold-for-search`) over the RAW content,
// which was wrong in both directions at once:
//
//  - it FOLDED DIACRITICS (NFKD-decompose, strip `U+0300..U+036F`, `ß`→`ss`),
//    which the trigram index does not do at all — migration `0006`'s
//    `tokenize = 'trigram case_sensitive 0'` folds CASE and nothing else. So
//    `naive` matched `naïve` here and matched nothing on the backend;
//  - it read text the index never sees: markup delimiters are still present in
//    raw content (a query containing `**` matched here, never there), while
//    the tag / page NAMES that `#[ULID]` / `[[ULID]]` resolve to are present
//    only in the index (a query for a linked page's title matched there,
//    never here).
//
// The steps below are `strip_for_fts_with_maps`'s own, in its order.
// ---------------------------------------------------------------------------

/**
 * `MARKUP_RE` — the four inline-formatting delimiters in one alternation, in
 * the backend's order (`strip.rs`). Bold precedes italic so leftmost-first
 * alternation prefers the longer delimiter at a given position. Code never
 * reaches it: {@link maskShownSpans} takes every backtick first.
 *
 * Spelled `[^\n]` where the backend spells `.`, which is NOT pedantry: Rust's
 * `.` excludes `\n` alone, while JS's excludes every LINE TERMINATOR — `\n`,
 * `\r`, U+2028 and U+2029. A `.` here would leave `**a\rb**` unstripped in the
 * mock and stripped on the backend, and CRLF-pasted content is not exotic.
 * `[^\n]` is byte-for-byte Rust's `.`, so the two agree on all four.
 */
const FTS_MARKUP_RE = /\*\*([^\n]+?)\*\*|\*([^\n]+?)\*|~~([^\n]+?)~~|==([^\n]+?)==/g

/** `TAG_REF_RE` — `#[ULID]` (`src-tauri/agaric-store/src/cache/mod.rs`). */
const FTS_TAG_REF_RE = /#\[([0-9A-Z]{26})\]/g

// `PAGE_LINK_RE` — `[[ULID]]` (`src-tauri/agaric-store/src/cache/mod.rs`)
// — is NOT declared here. `link-scan.ts` is its single owner in this tree
// (#3332) and {@link linkTokenRe} hands out a fresh `g`-flagged copy; a
// private one would fork the link grammar away from the conformance snapshot's
// derivation, which is the failure that guard exists to prevent. The backend
// shares one regex between `cache` and `fts::strip` for the same reason.

/**
 * `strip_inline_markup` (`strip.rs`): apply {@link FTS_MARKUP_RE} until
 * the result stops changing, which is what preserves the nested case
 * (`**bold *italic***` ⇒ `bold italic`). Every replacement strictly shrinks the
 * string — the captured group is always shorter than its delimiters — so the
 * loop terminates.
 */
function stripInlineMarkup(content: string): string {
  let current = content
  for (;;) {
    const next = current.replace(FTS_MARKUP_RE, (...args: unknown[]): string => {
      // Exactly one of the four groups matched; return its inner text.
      for (let i = 1; i <= 4; i++) {
        const group = args[i]
        if (typeof group === 'string') return group
      }
      return ''
    })
    if (next === current) return current
    current = next
  }
}

/**
 * `load_ref_maps`' two maps (`strip.rs`), resolved per lookup instead
 * of pre-loaded: the name a `#[ULID]` / `[[ULID]]` token resolves to, or `''`
 * when the target is missing, tombstoned, of the wrong `block_type`, or has no
 * content — every one of which is a row the SQL's
 * `block_type = ? AND deleted_at IS NULL` + `filter_map(content)` drops from
 * the map, so `unwrap_or_default()` substitutes the empty string.
 */
function ftsRefName(ulid: string, blockType: 'tag' | 'page'): string {
  const target = blocks.get(ulid)
  if (!target) return ''
  if (target['deleted_at'] != null) return ''
  if (target['block_type'] !== blockType) return ''
  return (target['content'] as string | null) ?? ''
}

/** `FTS_MAX_INDEXED_BYTES` (`strip.rs`) — 128 KiB of UTF-8, per block. */
const FTS_MAX_INDEXED_BYTES = 128 * 1024

/**
 * `cap_indexed_text` (`strip.rs`): truncate to at most
 * {@link FTS_MAX_INDEXED_BYTES} UTF-8 bytes, on a char boundary.
 *
 * Rust's `is_char_boundary(end)` is exactly "byte `end` is not a UTF-8
 * continuation byte", which is what the walk-back tests.
 */
function capIndexedText(s: string): string {
  // A UTF-8 encoding is at most 3 bytes per UTF-16 code unit (an astral pair
  // is 4 bytes for 2 units), so this skips the encode for every realistic
  // block without ever skipping one that could exceed the cap.
  if (s.length * 3 <= FTS_MAX_INDEXED_BYTES) return s
  const bytes = new TextEncoder().encode(s)
  if (bytes.length <= FTS_MAX_INDEXED_BYTES) return s
  let end = FTS_MAX_INDEXED_BYTES
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end))
}

/**
 * `load_block_ref_titles` (`strip.rs`), resolved per lookup: the first line of
 * the block a `((ULID))` names, the text its chip shows — whole, without a
 * trailing `\r`, and kept while the target is soft-deleted (#6277 B3). `''`
 * when the target is missing or has no content.
 */
function ftsBlockRefTitle(ulid: string): string {
  const content = blocks.get(ulid)?.['content'] as string | null | undefined
  return content?.split('\n')[0]?.replace(/\r$/, '') ?? ''
}

/** `PIECE_OPEN` / `PIECE_CLOSE` (`strip.rs`): `\uE002<index>\uE003` stands for
 *  `pieces[index]` while the markup and reference passes run. */
const PIECE_OPEN = '\uE002'
const PIECE_RE = /\uE002(\d+)\uE003/g

/** `BLOCK_REF_RE` (`cache/mod.rs`), sticky so it matches at the scan position. */
const BLOCK_REF_AT_RE = /\(\(([0-9A-Z]{26})\)\)/y

/** `piece` (`strip.rs`): store `shown` and return its placeholder. */
function piece(pieces: string[], shown: string): string {
  pieces.push(shown)
  return `${PIECE_OPEN}${pieces.length - 1}\uE003`
}

/** `code_span` (`strip.rs`): the code a backtick run at `at` opens and the
 *  index after it. The next run of exactly as many backticks closes it, on the
 *  same line for a code span and on any later line for a fence of three or
 *  more; with none, the rest of the line is literal, backticks included. */
function codeSpan(src: string, at: number): [string, number] {
  const runAt = (i: number): number => {
    let n = 0
    while (src[i + n] === '`') n++
    return n
  }
  const open = runAt(at)
  const lineEnd = src.indexOf('\n', at)
  const end = lineEnd === -1 ? src.length : lineEnd
  const limit = open >= 3 ? src.length : end
  let i = at + open
  for (
    let found = src.indexOf('`', i);
    found !== -1 && found < limit;
    found = src.indexOf('`', i)
  ) {
    const close = runAt(found)
    if (close === open) return [src.slice(at + open, found), found + close]
    i = found + close
  }
  return [src.slice(at, end), end]
}

/** `tilde_fence` (`strip.rs`): the code a tilde fence opening the line at
 *  `at` holds and the index after it, as `parseCodeBlock` reads it. A run of
 *  three or more `~` closes on a line holding only a run at least as long,
 *  plus whitespace, or runs to the end; `null` for a run too short. */
function tildeFence(src: string, at: number): [string, number] | null {
  let open = 0
  while (src[at + open] === '~') open++
  if (open < 3) return null
  const firstBreak = src.indexOf('\n', at)
  let lineStart = firstBreak === -1 ? src.length + 1 : firstBreak + 1
  while (lineStart <= src.length) {
    const nextBreak = src.indexOf('\n', lineStart)
    const lineEnd = nextBreak === -1 ? src.length : nextBreak
    const line = src.slice(lineStart, lineEnd)
    let run = 0
    while (line[run] === '~') run++
    if (run >= open && line.slice(run).trim() === '') {
      return [src.slice(at + open, lineStart), lineEnd]
    }
    lineStart = lineEnd + 1
  }
  return [src.slice(at + open), src.length]
}

/** The span at `at` whose shown text no later pass may touch, and the index
 *  after it: code, a backslash escape, a `((ULID))` as its target's first line,
 *  or a placeholder opener already in the text. */
function shownSpanAt(src: string, at: number): [string, number] | null {
  const ch = src[at]
  if (ch === '~' && (at === 0 || src[at - 1] === '\n')) return tildeFence(src, at)
  if (ch === '`') return codeSpan(src, at)
  if (ch === '\\') {
    const next = src[at + 1]
    return next !== undefined && isEscapableChar(next) ? [next, at + 2] : null
  }
  if (ch === '(') {
    BLOCK_REF_AT_RE.lastIndex = at
    const ref = BLOCK_REF_AT_RE.exec(src)
    return ref ? [ftsBlockRefTitle(ref[1] as string), at + ref[0].length] : null
  }
  return ch === PIECE_OPEN ? [PIECE_OPEN, at + 1] : null
}

/** `mask_shown_spans` (`strip.rs`): `content` with each {@link shownSpanAt}
 *  span replaced by a placeholder, scanned left to right. An escaped pipe is a
 *  bare `|`, so a table cell's `[[ULID\|label]]` reads as its link. */
function maskShownSpans(content: string, pieces: string[]): string {
  let out = ''
  let at = 0
  while (at < content.length) {
    if (content.startsWith('\\|', at)) {
      out += '|'
      at += 2
      continue
    }
    const span = shownSpanAt(content, at)
    if (span) {
      out += piece(pieces, span[0])
      at = span[1]
    } else {
      out += content[at]
      at++
    }
  }
  return out
}

/**
 * `strip_for_fts_with_maps` (`src-tauri/agaric-store/src/fts/strip.rs`) — the
 * text a block contributes to `fts_blocks.stripped`, and therefore the ONLY
 * text any FTS5 candidate set in this file may match against: the text the
 * editor shows (#6277 B3).
 *
 * Its steps, in the backend's order:
 *
 *  1. mask code (raw), backslash escapes (decoded, as the editor's
 *     `isEscapableChar` reads them) and `((ULID))` block refs (the target's
 *     first line) behind placeholders ({@link maskShownSpans});
 *  2. strip inline markup to a fixed point ({@link stripInlineMarkup});
 *  3. resolve `#[ULID]` tag references to the tag's name;
 *  4. resolve `[[ULID]]` page links to the page's title, or `[[ULID|label]]` to its label;
 *  5. put the masked text back, NFC-normalise, then cap the indexed bytes
 *     ({@link capIndexedText}).
 */
export function stripForFts(content: string | null | undefined): string {
  const pieces: string[] = []
  let result = stripInlineMarkup(maskShownSpans(content ?? '', pieces))
  result = result.replace(FTS_TAG_REF_RE, (_match, ulid: string) =>
    piece(pieces, ftsRefName(ulid, 'tag')),
  )
  // A labelled link indexes its label, the text the reader sees (#5160 D9).
  result = result.replace(
    linkTokenRe(),
    (_match, ulid: string, label?: string) => label || piece(pieces, ftsRefName(ulid, 'page')),
  )
  result = result.replace(PIECE_RE, (_match, index: string) => pieces[Number(index)] ?? '')
  return capIndexedText(result.normalize('NFC'))
}

/**
 * The trigram tokenizer's fold — `tokenize = 'trigram case_sensitive 0'`
 * (migration `0006_fts5_trigram.sql`), i.e. CASE only.
 *
 * Emphatically NOT `foldForSearch` (`@/lib/fold-for-search`), which is the
 * interactive-filter fold: NFKD + combining-mark stripping + `ß`⇒`ss`. That
 * one is right for a client-side list filter and wrong for anything claiming
 * to stand in for the index, which does not fold diacritics — `naive` does not
 * match `naïve` in `fts_blocks`, and #3938 is that the mock said it did.
 *
 * NFC on both sides because the indexed text is NFC (`strip_for_fts`'s last
 * step) and the query is NFC (`sanitize_fts_query`, the pair to it —
 * `agaric-store/src/fts/search/sanitizer.rs`).
 *
 * `toLowerCase()` is CLOSE TO, not equal to, the tokenizer's fold. FTS5 folds
 * with `sqlite3Fts5UnicodeFold`, a SIMPLE 1:1 codepoint map with no context
 * rule; `toLowerCase()` is the Unicode DEFAULT case conversion, which can
 * change length and reads context. Two counterexamples, both measured against
 * a real `tokenize = 'trigram case_sensitive 0'` table rather than reasoned:
 *
 *  - content `İstanbul`, query `i` + U+0307 + `stanbul` — matches here
 *    (`'İ'.toLowerCase()` EXPANDS to `i` + combining dot) and not in the index
 *    (`U+0130` folds to itself there). An over-match;
 *  - content `ΣΟΦΟΣ`, query `σοφοσ` — matches in the index (every `Σ` folds
 *    to `σ`) and not here (the Final_Sigma context rule lowercases the
 *    trailing `Σ` to `ς`). An under-match.
 *
 * Both need a Turkish dotted capital or a word-final Greek sigma to reach, so
 * they are left as named divergences rather than paid for with a fold table.
 * The DIACRITIC claim above is exact, and was measured the same way: `naive`
 * / `naïve`, `strasse` / `Straße` and `istanbul` / `İstanbul` are all misses
 * in the real index, as they are here.
 */
export function foldForFtsIndex(s: string): string {
  return s.normalize('NFC').toLowerCase()
}

/**
 * The mock's FTS5 MATCH: does `stripped` contain `query` after the index's own
 * fold?
 *
 * Still a whole-query SUBSTRING test rather than a real trigram scan over
 * `sanitize_fts_query`'s quoted token list, so the two known query-SIDE
 * divergences are unchanged by #3938 and still apply: the backend AND-joins
 * whitespace-separated tokens (this requires them adjacent and in order), and
 * it drops sub-trigram tokens, rejecting a query that is exclusively them
 * where this happily matches ({@link matchesSearchText} takes them out first;
 * the other callers do not). What #3938 changed is the HAYSTACK and the FOLD
 * — see {@link stripForFts} and {@link foldForFtsIndex}.
 *
 * An empty needle admits every row. The `Contains` filter of
 * `list_backlinks_grouped` does NOT (`handlers/links.ts`), so that branch IS
 * reachable — and the backend
 * returns an EMPTY set there instead (`src-tauri/agaric-store/src/backlink/filters.rs:382`, `:957`, on
 * `query.trim().is_empty()`). Note `trim()`: a whitespace-only query is
 * blank to the backend and a three-space substring test here. Both gaps are
 * query-side, predate the #4022 seam, and are named at that call site.
 */
export function matchesFtsIndex(stripped: string, query: string): boolean {
  if (query === '') return true
  return foldForFtsIndex(stripped).includes(foldForFtsIndex(query))
}

/** The phrases of a query that is nothing but `"…"` phrases, else `null`. */
function quotedPhrases(query: string): string[] | null {
  if (!/^\s*(?:"[^"]*"\s*)+$/.test(query)) return null
  return Array.from(query.matchAll(/"([^"]*)"/g), (m) => m[1] ?? '')
}

/**
 * `parse_query`'s split (`agaric-store/src/fts/search/sanitizer.rs`, #6752):
 * the terms under the trigram floor, each a required substring of the indexed
 * text, and what is left for the index. A query with no short term keeps
 * its one whole-query phrase, so nothing else about the MATCH model moves.
 * Operators are not modelled, here as in {@link matchesFtsIndex}.
 */
function splitShortTerms(query: string): { phrases: string[]; shortTerms: string[] } {
  const isShort = (term: string) => term !== '' && Array.from(term).length < 3
  const quoted = quotedPhrases(query)
  if (quoted) {
    return {
      phrases: quoted.filter((phrase) => !isShort(phrase.trim())),
      shortTerms: quoted.map((phrase) => phrase.trim()).filter(isShort),
    }
  }
  const words = query.trim().split(/\s+/)
  // An OR anywhere keeps the query whole: the backend leaves its short terms out.
  const shortTerms = words.some((word) => word.toUpperCase() === 'OR') ? [] : words.filter(isShort)
  if (shortTerms.length === 0) return { phrases: [query], shortTerms }
  // Each longer word on its own, as the backend AND-joins them: with the short
  // words taken out, the rest is no longer one substring of the content.
  return { phrases: words.filter((word) => !isShort(word)), shortTerms }
}

/** `add_shown_text_contains`: the indexed text holds every short term, in any case. */
function holdsShortTerms(stripped: string, shortTerms: string[]): boolean {
  const folded = foldForFtsIndex(stripped)
  return shortTerms.every((term) => folded.includes(foldForFtsIndex(term)))
}

/** A row's answer to `parse_query`'s split: its phrases in the index, its short terms in the text. */
export function matchesSearchText(stripped: string, query: string): boolean {
  const { phrases, shortTerms } = splitShortTerms(query)
  return (
    phrases.every((phrase) => matchesFtsIndex(stripped, phrase)) &&
    holdsShortTerms(stripped, shortTerms)
  )
}
