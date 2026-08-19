/**
 * Tauri mock handlers -- Full-text and filtered block search.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

import { base64UrlToUtf8, isBase64UrlNoPad, utf8ToBase64Url } from '@/lib/base64url'
import {
  type PageMetaRow,
  type TypedHandlers,
  buildPageMetaRow,
  deriveLinkEdges,
  fbqInSpace,
  fbqPropertyFilterMatches,
  fbqTagFilterMatches,
  linkTokenRe,
  metaRowMatchesExpr,
  rawOpLogLastEditedAt,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { blockTags, blocks, properties } from '@/lib/tauri-mock/seed'

// ---------------------------------------------------------------------------
// #3938 — the `fts_blocks.stripped` stand-in
//
// The backend does NOT index `blocks.content`. Every FTS5 candidate set is a
// trigram scan over `fts_blocks.stripped`, the column
// `strip_for_fts_with_maps` writes
// (`src-tauri/agaric-store/src/fts/strip.rs:114-163`). Until #3938 this mock
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
// The four steps below are `strip_for_fts_with_maps`'s own, in its order.
// ---------------------------------------------------------------------------

/**
 * `MARKUP_RE` — the five inline-formatting delimiters in one alternation, in
 * the backend's order (`strip.rs:44-47`). Bold precedes italic so leftmost-first
 * alternation prefers the longer delimiter at a given position.
 *
 * Spelled `[^\n]` where the backend spells `.`, which is NOT pedantry: Rust's
 * `.` excludes `\n` alone, while JS's excludes every LINE TERMINATOR — `\n`,
 * `\r`, U+2028 and U+2029. A `.` here would leave `**a\rb**` unstripped in the
 * mock and stripped on the backend, and CRLF-pasted content is not exotic.
 * `[^\n]` is byte-for-byte Rust's `.`, so the two agree on all four.
 */
const FTS_MARKUP_RE = /\*\*([^\n]+?)\*\*|\*([^\n]+?)\*|`([^\n]+?)`|~~([^\n]+?)~~|==([^\n]+?)==/g

/** `TAG_REF_RE` — `#[ULID]` (`src-tauri/agaric-store/src/cache/mod.rs:72-73`). */
const FTS_TAG_REF_RE = /#\[([0-9A-Z]{26})\]/g

// `PAGE_LINK_RE` — `[[ULID]]` (`src-tauri/agaric-store/src/cache/mod.rs:75-76`)
// — is NOT declared here. `link-scan.ts` is its single owner in this tree
// (#3332) and {@link linkTokenRe} hands out a fresh `g`-flagged copy; a
// private one would fork the link grammar away from the conformance snapshot's
// derivation, which is the failure that guard exists to prevent. The backend
// shares one regex between `cache` and `fts::strip` for the same reason
// (`strip.rs:85-98`).

/**
 * `strip_inline_markup` (`strip.rs:63-83`): apply {@link FTS_MARKUP_RE} until
 * the result stops changing, which is what preserves the nested case
 * (`**bold *italic***` ⇒ `bold italic`). Every replacement strictly shrinks the
 * string — the captured group is always shorter than its delimiters — so the
 * loop terminates.
 */
function stripInlineMarkup(content: string): string {
  let current = content
  for (;;) {
    const next = current.replace(FTS_MARKUP_RE, (...args: unknown[]): string => {
      // Exactly one of the five groups matched; return its inner text.
      for (let i = 1; i <= 5; i++) {
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
 * `load_ref_maps`' two maps (`strip.rs:210-236`), resolved per lookup instead
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

/** `FTS_MAX_INDEXED_BYTES` (`strip.rs:171`) — 128 KiB of UTF-8, per block. */
const FTS_MAX_INDEXED_BYTES = 128 * 1024

/**
 * `cap_indexed_text` (`strip.rs:179-195`): truncate to at most
 * {@link FTS_MAX_INDEXED_BYTES} UTF-8 bytes, on a char boundary.
 *
 * Modelled rather than declared-and-omitted. Nothing in this tree is within
 * three orders of magnitude of the cap, so the argument for omitting it was
 * that it adds a branch no fixture takes — but that is the argument for
 * omitting the whole of {@link stripForFts}'s reachable-only-by-seam
 * behaviour, and this module already answers it the same way twice
 * (`approximateFtsRank`'s empty-needle and zero-occurrence branches are both
 * unreachable through a handler and both falsified through the export). An
 * omission a doc comment NAMES still diverges silently the day a fixture grows
 * past it; eight lines and a seam test cannot.
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
 * `strip_for_fts_with_maps` (`src-tauri/agaric-store/src/fts/strip.rs:114-163`)
 * — the text a block contributes to `fts_blocks.stripped`, and therefore the
 * ONLY text any FTS5 candidate set in this file may match against.
 *
 * Four steps, in the backend's order:
 *
 *  1. strip inline markup to a fixed point ({@link stripInlineMarkup});
 *  2. resolve `#[ULID]` tag references to the tag's name;
 *  3. resolve `[[ULID]]` page links to the page's title;
 *  4. unescape `\*` `\`` `\~` `\=`, NFC-normalise, then cap the indexed bytes
 *     ({@link capIndexedText}) — `strip.rs:141-162`.
 */
export function stripForFts(content: string | null | undefined): string {
  let result = stripInlineMarkup(content ?? '')
  result = result.replace(FTS_TAG_REF_RE, (_match, ulid: string) => ftsRefName(ulid, 'tag'))
  result = result.replace(linkTokenRe(), (_match, ulid: string) => ftsRefName(ulid, 'page'))
  result = result
    .replaceAll('\\*', '*')
    .replaceAll('\\`', '`')
    .replaceAll('\\~', '~')
    .replaceAll('\\=', '=')
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
 * where this happily matches. What #3938 changed is the HAYSTACK and the FOLD
 * — see {@link stripForFts} and {@link foldForFtsIndex}.
 *
 * An empty needle admits every row. The `search_blocks` arms all test
 * blank-ness before calling in, but the `Contains` filter of
 * `query_backlinks_filtered` does NOT (`handlers/links.ts`), so that branch IS
 * reachable — and the backend
 * returns an EMPTY set there instead (`filters.rs:382`, `:957`, on
 * `query.trim().is_empty()`). Note `trim()`: a whitespace-only query is
 * blank to the backend and a three-space substring test here. Both gaps are
 * query-side, predate the #4022 seam, and are named at that call site.
 */
export function matchesFtsIndex(stripped: string, query: string): boolean {
  if (query === '') return true
  return foldForFtsIndex(stripped).includes(foldForFtsIndex(query))
}

// ---------------------------------------------------------------------------
// #3837 — `run_advanced_query` sort + full-text narrowing.
//
// Mirrors `resolve_sort` in `agaric-store/src/query/engine.rs`: each
// requested `SortKey` maps to a getter over the matched row, applied
// left-to-right in request order, ALWAYS terminating in an `id` tiebreak so
// the order is total. `NULLS LAST` applies uniformly to every term — exactly
// like the engine's `"{expr} {dir} NULLS LAST"` ORDER BY term — which is a
// no-op on the columns that are never actually null (`id`, the coalesced
// `lastEdited`) and only bites on `position` / `priority` / `title`.
// ---------------------------------------------------------------------------

interface MatchedEntry {
  b: Record<string, unknown>
  row: PageMetaRow
  /**
   * Memoized {@link rawOpLogLastEditedAt} for this row — see
   * {@link rawLastEditedOf}. `undefined` means "not computed yet"; `null` is
   * the computed "no op-log activity" answer.
   */
  lastEditedRaw?: string | null
  /**
   * #3938 — memoized {@link stripForFts} of this row's content: the text BOTH
   * the MATCH narrowing and the relevance rank run over. Memoized for the same
   * reason `lastEditedRaw` is (the rank getter runs inside the sort
   * comparator), and shared between the two so they cannot drift onto
   * different haystacks — the coupling `approximateFtsRank`'s zero-occurrence
   * guard depends on.
   */
  strippedFts?: string
}

/**
 * `rawOpLogLastEditedAt(b.id)`, computed AT MOST ONCE per matched row.
 *
 * That function linearly scans `opLog` with a `JSON.parse` per entry. Calling
 * it from inside the sort comparator (which is where the `lastEdited` getter
 * runs) makes a `lastEdited` sort O(N log N · |opLog|) with a parse per entry
 * per comparison — fine for the seed, but `opLog` grows on every edit in a
 * long dev-preview session. Memoizing on the entry restores the old
 * O(N · |opLog|) shape while keeping the engine-faithful value.
 *
 * Lazy rather than computed in the match loop on purpose: a query that does
 * NOT sort by `lastEdited` must not pay for a scan it never reads.
 */
function rawLastEditedOf(m: MatchedEntry): string | null {
  if (m.lastEditedRaw === undefined) {
    m.lastEditedRaw = rawOpLogLastEditedAt(m.b['id'] as string)
  }
  return m.lastEditedRaw
}

/** {@link stripForFts} of `m`'s content, computed AT MOST ONCE per row — see
 *  {@link MatchedEntry.strippedFts}. */
function strippedFtsOf(m: MatchedEntry): string {
  m.strippedFts ??= stripForFts(m.row.content)
  return m.strippedFts
}

type SortValue = string | number | null

/**
 * Mirrors the engine's `CursorKind` (`agaric-store/src/query/engine.rs:123`)
 * — which SQL column/expression a resolved sort term reads, driving how its
 * value is typed into the keyset cursor (#3863). `LastEditedMs` keeps the
 * engine's name though this mock's value is an ISO-8601 STRING, not an
 * epoch-ms integer — the SAME pre-existing, documented representation
 * divergence `SORT_COLUMN_GETTERS.lastEdited` already carries; only the
 * discriminator identity (which term IS the last-edited term) matters for
 * cursor typing here, not the on-wire integer/string distinction.
 *
 * That inherited gap is the ONE place where this mock's cursor VALUES depart
 * from the engine's: all six discriminators are covered, and every emitted
 * value matches the engine's tag except `LastEditedMs` on a row that HAS
 * op-log activity (`Text` here, `Int` there). Its no-activity sentinel does
 * match — see {@link cursorValueFor}, which encodes it as the engine's
 * `Int(0)`.
 *
 * Exported ONLY as a test seam (#3914 review note 4): the round-trip
 * invariant test keys its case table on `Record<CursorKind, …>` so a seventh
 * kind fails to COMPILE until it has a case. Nothing outside this module's
 * tests should name it.
 */
export type CursorKind = 'Id' | 'LastEditedMs' | 'Position' | 'Priority' | 'Title' | 'Rank'

interface ResolvedSortTerm {
  desc: boolean
  get: (m: MatchedEntry) => SortValue
  /** Drives {@link cursorValueFor}'s tagging of this term's cursor value. */
  column: CursorKind
}

/**
 * One component of an encoded keyset cursor. Mirrors the engine's
 * `CursorValue` (`agaric-store/src/query/engine.rs:143`): a tagged union so a
 * NULL sort value round-trips distinctly from a real value of any type.
 */
type CursorValue =
  | { t: 'Text'; v: string }
  | { t: 'Int'; v: number }
  | { t: 'Real'; v: number }
  | { t: 'Null' }

/** Cursor schema version — mirrors `CURSOR_VERSION` (`engine.rs:64`). */
const CURSOR_VERSION = 1

/** The decoded keyset cursor. Mirrors the engine's `QueryCursor` (`engine.rs:167`). */
interface QueryCursorPayload {
  version: number
  values: CursorValue[]
}

/**
 * Approximates `fts.rank` (a `bm25` score; lower = better match). The mock
 * has no FTS5 index to query, so this is a DELIBERATE, DOCUMENTED
 * approximation rather than real bm25 — two divergences worth knowing about:
 *
 *  - Real bm25 folds in corpus-wide inverse document frequency and a
 *    term-frequency saturation curve. This uses a plain
 *    content-length-over-occurrence-count density ratio (more hits and
 *    shorter surrounding content both score lower/better). It produces a
 *    STABLE, non-arbitrary relative order for the mock's relevance sort —
 *    it is not a bm25 stand-in for anything ranking-accuracy sensitive.
 *  - Real ranking runs over `strip_for_fts_with_maps`'s stripped text. Since
 *    #3938 so does this: the caller passes {@link stripForFts}'s output, so
 *    `foldedText.length` is the same document length bm25 sees and a block
 *    linking `[[Foo]]` ranks for a `Foo` query without the literal substring.
 *    The MATCH narrowing rides the same text ({@link matchesFtsIndex}), which
 *    is what keeps the zero-occurrence guard below unreachable — see it. What
 *    remains approximated is the SCORE (density, not bm25) and the QUERY side
 *    (a whole-query substring test, not `sanitize_fts_query`'s token list).
 *
 * Exported ONLY as a test seam (#3914 review note 3): the zero-occurrence
 * branch below is unreachable through `run_advanced_query`, and what makes it
 * unreachable is a COUPLING to {@link matchesFtsIndex} that is load-bearing
 * for keyset monotonicity (see that branch, and the `Rank` case in
 * {@link cursorValueFor}). Asserting the coupling needs both halves callable
 * side by side; a handler-level test cannot reach one of them by construction.
 *
 * A THIRD divergence, on the narrowing rather than the ranking:
 * `sanitize_fts_query` (`agaric-store/src/query/engine.rs`) ERRORS with "no
 * searchable terms (each term must be at least 3 characters)" whenever
 * `fulltext` is `Some` and sanitizes to empty. This mock instead treats
 * `fulltext: ''` as "no term at all" (falling back to the whole structural
 * set in `id DESC`) and happily substring-matches 1- and 2-character terms
 * the backend would reject outright. So a conformance test using a short
 * query pins mock-only behaviour against a backend that throws — the exact
 * failure mode this module exists to prevent. Treat any `fulltext` shorter
 * than 3 characters as untrustworthy here until the rejection is mirrored.
 */
export function approximateFtsRank(stripped: string | null, foldedQuery: string): number {
  const foldedText = foldForFtsIndex(stripped ?? '')
  // The empty-needle case, which {@link matchesFtsIndex} admits every row for
  // — so the two sides must agree and this must return a FINITE length rather
  // than falling through to the zero-occurrence guard below. (Without it,
  // `''.split('')` yields `len - 1` "occurrences", which is not 0 and so would
  // not even reach that guard — it would return a silently wrong density.)
  //
  // #3938 narrowed how this is reached. Under `foldForSearch` a NON-empty
  // needle could fold away entirely (a lone combining mark), so a `fulltext`
  // term reached it through the handler. `foldForFtsIndex` is NFC + lowercase,
  // neither of which deletes a character, so `foldForFtsIndex(q) === ''` iff
  // `q === ''` — and every caller tests blank-ness first. It is now reachable
  // only through this exported seam, like the zero-occurrence guard below, and
  // is falsified there (`search-fts-strip.test.ts`).
  if (foldedQuery === '') return foldedText.length
  const occurrences = foldedText.split(foldedQuery).length - 1
  // No match. Unreachable via the MATCH narrowing in `run_advanced_query`,
  // and #3914 review note 3 is that the reason is now LOAD-BEARING rather
  // than merely tidy, because {@link cursorValueFor} tags a non-finite rank
  // as `Null`:
  //
  //   - `Infinity` sorts FIRST under `Relevance DESC` (`compareSortValue`
  //     treats it as a number and the `desc` flip puts the largest first).
  //   - its `Null` tag sorts LAST in BOTH directions (`compareCursorValue`
  //     applies NULLS-LAST ahead of the flip).
  //
  // So a row that reached here would compare BEFORE the cursor minted from
  // it, `findIndex` would return 0, and every page would re-deliver the whole
  // set — a `while (hasMore)` client that never terminates.
  //
  // What rules it out: `run_advanced_query` narrows with
  // `matchesFtsIndex(strippedFtsOf(entry), fulltext)` and ranks with
  // `approximateFtsRank(strippedFtsOf(entry), foldForFtsIndex(fulltext))` —
  // the SAME `stripForFts` haystack through the SAME `foldForFtsIndex`,
  // against the SAME folded needle. #3938 moved BOTH sides onto the stripped
  // text together for exactly this reason: moving only the narrowing would
  // have made this guard reachable and the keyset non-monotonic.
  // `includes` is true exactly when `split` yields ≥ 2 parts,
  // so a surviving row always has ≥ 1 occurrence. Change either fold (a
  // stripper on one side, a stemmer on the other) and the guard becomes
  // reachable — pinned by the coupling test in `advanced-query-sort.test.ts`,
  // which is why this function is exported.
  if (occurrences === 0) return Number.POSITIVE_INFINITY
  return foldedText.length / occurrences
}

/**
 * Value getters for the closed `SortColumn` set, over a matched `{ b, row }` pair.
 *
 * A `Map`, not an object literal, and looked up only after a `source.type ===
 * 'Column'` check. An object-literal index is unguarded: a name like
 * `constructor`, `valueOf` or `toString` resolves to an inherited
 * `Object.prototype` method, which is truthy, so it would be accepted and
 * pushed as a sort term. The effect is benign here (every row stringifies
 * identically, so the id tiebreak decides the order) but the engine REJECTS
 * such a key at deserialization, and silently accepting what the backend
 * refuses is precisely the mock-vs-engine divergence this module exists to
 * remove. Same hazard, same fix as the agenda group-header lookup in #3851.
 *
 * Only part of this is black-box testable, and the untestable part is the
 * reason the guard exists: for most prototype keys the resulting getter
 * returns a value that compares EQUAL across every row, so the id tiebreak
 * decides and the observable order is identical to having ignored the key.
 * See the note on the `__proto__` case in the sort test file.
 */
const SORT_COLUMN_GETTERS = new Map<string, (m: MatchedEntry) => SortValue>(
  Object.entries({
    // ULID id == creation order (`resolve_sort`'s `SortColumn::Created`).
    created: (m) => m.row.id,
    // #3863 — reads `rawOpLogLastEditedAt`, memoized per row by
    // `rawLastEditedOf` because this getter runs inside the sort comparator.
    // The engine's `LastEdited` sort key is `COALESCE((SELECT MAX(created_at)
    // FROM op_log WHERE block_id = b.id), 0)`
    // (`agaric-store/src/query/engine.rs:229`) — NO other data source. This
    // used to be spelled `m.row.lastModifiedAt`, which then routed through
    // `pageLastModifiedAt`'s mock-only seeded-stamp fallback and made an
    // op-log-free block sort by a dev-preview timestamp the backend cannot
    // see; that fallback is gone (#3884/#3898), so the two spellings now
    // resolve to the same value and only the memo distinguishes them. The
    // engine coalesces to epoch-ms `0` (never actually NULL); `''` is this
    // mock's matching "no op-log activity" sentinel over its ISO-8601 string
    // representation — it sorts before every real ISO-8601 timestamp string,
    // preserving relative order.
    lastEdited: (m) => rawLastEditedOf(m) ?? '',
    position: (m) => m.row.position,
    priority: (m) => m.row.priority,
    // `pc.title` comes from the `pages_cache` row whose `page_id = b.id` — the
    // matched row's OWN page-cache entry, which only exists when the row IS a
    // page. Non-page rows get `null` (NULLS LAST), mirroring the LEFT JOIN.
    title: (m) => (m.row.blockType === 'page' ? m.row.content : null),
  }),
)

/**
 * `SortColumn` name → {@link CursorKind}, mirroring `resolve_sort`'s
 * `SortColumn::*` ⇒ `CursorKind::*` mapping (`engine.rs:216-243`). Keys match
 * {@link SORT_COLUMN_GETTERS} exactly (both are keyed off the same closed
 * `SortColumn` set); a `Map`, not an object literal, for the same
 * prototype-pollution reason documented on `SORT_COLUMN_GETTERS`.
 */
const SORT_COLUMN_CURSOR_KIND = new Map<string, CursorKind>(
  Object.entries({
    created: 'Id',
    lastEdited: 'LastEditedMs',
    position: 'Position',
    priority: 'Priority',
    title: 'Title',
  } satisfies Record<string, CursorKind>),
)

/**
 * Resolve a request's wire `sort: SortKey[]` into ordered comparator terms,
 * mirroring `resolve_sort`: explicit keys first (request order), then the
 * engine's own default (`Relevance` when `fulltext` is present, `id DESC`
 * otherwise) when the request supplied no keys, then an `id DESC` tiebreak
 * appended unless a `Created` key already supplies one. Rejects `Relevance`
 * when there is no `fulltext` term, exactly like the engine.
 */
function resolveSortTerms(
  sort: ReadonlyArray<Record<string, unknown>>,
  hasFulltext: boolean,
  foldedQuery: string,
): ResolvedSortTerm[] {
  const terms: ResolvedSortTerm[] = []
  let hasCreated = false
  for (const key of sort) {
    const desc = (key['desc'] as boolean | undefined) ?? false
    const source = (key['source'] as Record<string, unknown> | undefined) ?? {}
    if (source['type'] === 'Relevance') {
      if (!hasFulltext) {
        throw validationRejection('InvalidSort: `Relevance` requires a `fulltext` term to rank on')
      }
      terms.push({
        desc,
        get: (m) => approximateFtsRank(strippedFtsOf(m), foldedQuery),
        column: 'Rank',
      })
      continue
    }
    // Only a `Column` source carries a `name`. The engine's `SortSource` is a
    // closed tagged union, so a reserved variant that happened to carry a
    // `name` must not be silently treated as a column.
    if (source['type'] !== 'Column') continue
    const name = source['name'] as string | undefined
    const getter = name === undefined ? undefined : SORT_COLUMN_GETTERS.get(name)
    const column = name === undefined ? undefined : SORT_COLUMN_CURSOR_KIND.get(name)
    if (!getter || !column) continue
    if (name === 'created') hasCreated = true
    terms.push({ desc, get: getter, column })
  }
  // Default sort when the request gave none.
  if (terms.length === 0 && hasFulltext) {
    terms.push({
      desc: false,
      get: (m) => approximateFtsRank(strippedFtsOf(m), foldedQuery),
      column: 'Rank',
    })
  }
  if (!hasCreated) {
    terms.push({ desc: true, get: (m) => m.row.id, column: 'Id' })
  }
  return terms
}

/**
 * Read one resolved term's value off `m` and tag it into a {@link
 * CursorValue}, mirroring `EngineRow::cursor_value` (`engine.rs:310-332`).
 *
 * Exported ONLY as a test seam for the `Rank` non-finite guard below: that
 * branch is unreachable through `run_advanced_query` itself (see the guard's
 * comment), so a handler-level test cannot falsify it.
 */
export function cursorValueFor(term: ResolvedSortTerm, m: MatchedEntry): CursorValue {
  const raw = term.get(m)
  // `LastEditedMs`'s getter uses `''` (not `null`) as its "no op-log
  // activity" sentinel (see `SORT_COLUMN_GETTERS.lastEdited`'s doc) — the
  // ONE column where an empty string is the null case rather than a genuine
  // value, so it needs its own check ahead of the general `raw === null`.
  //
  // The sentinel encodes as the engine's `Int(0)`, NOT `Null`:
  // `EngineRow::cursor_value` (`engine.rs:322`) reads the COALESCE'd
  // `last_edited: i64` and can only ever emit `CursorValue::Int` for this
  // column — `Null` is UNREACHABLE there, and `COALESCE(…, 0)` makes `0` the
  // exact value an op-log-free row carries. Emitting a tag the engine cannot
  // produce would be a new divergence of this mock's own making.
  //
  // A row that HAS op-log activity still emits `Text` (an ISO-8601 string)
  // where the engine emits `Int` (epoch-ms). That one is the PRE-EXISTING,
  // documented representation divergence carried by `SORT_COLUMN_GETTERS`
  // (see the `CursorKind` doc); closing it needs the mock's last-edited
  // representation changed to epoch-ms everywhere, not a cursor-local cast.
  // So `CursorKind` coverage is 6/6 on the DISCRIMINATOR set and 5/6 on the
  // emitted VALUES — `LastEditedMs` is faithful only in its sentinel case.
  if (term.column === 'LastEditedMs') {
    return raw === null || raw === '' ? { t: 'Int', v: 0 } : { t: 'Text', v: raw as string }
  }
  if (raw === null) return { t: 'Null' }
  switch (term.column) {
    case 'Position': {
      return { t: 'Int', v: raw as number }
    }
    case 'Rank': {
      // #3888 — `approximateFtsRank` returns `Number.POSITIVE_INFINITY` for a
      // zero-occurrence row, and `JSON.stringify` has no Infinity literal: it
      // emits `null`, producing `{"t":"Real","v":null}` — a payload serde
      // CANNOT deserialize into `CursorValue::Real(f64)`, so the engine would
      // reject the cursor outright rather than merely disagree with it.
      // `Null` is the engine's OWN answer for a row with no rank
      // (`EngineRow::cursor_value`: `self.rank.map_or(CursorValue::Null,
      // CursorValue::Real)`, `engine.rs:322`), so the guard emits a tag the
      // engine can actually produce.
      //
      // Unreachable through this handler — the MATCH narrowing
      // (`matchesFtsIndex`) and `approximateFtsRank` fold the SAME
      // `stripForFts` text with the SAME function, so every surviving row has
      // ≥1 occurrence —
      // hence the guard is falsified against `cursorValueFor` directly.
      //
      // #3914 review note 3 — that unreachability is not a nicety. This tag
      // DISAGREES with `compareSortValue`'s ordering of the raw value under
      // DESC (`Infinity` first, `Null` last), which is the one condition that
      // would break the keyset's monotonicity and make pagination
      // non-terminating. See the zero-occurrence branch in
      // {@link approximateFtsRank} for the full argument and the test that
      // pins the coupling.
      //
      // NOT guarded: an INTEGRAL rank serializes as `2` where serde_json
      // writes an `f64` as `2.0`. That is a byte difference only — serde's
      // `f64` deserializer accepts a JSON integer, and the keyset compares
      // ranks inside `RANK_EPSILON = 1e-9` anyway — so it is pinned by test
      // rather than papered over with hand-built JSON.
      return Number.isFinite(raw as number) ? { t: 'Real', v: raw as number } : { t: 'Null' }
    }
    default: {
      // Id / Priority / Title: this mock represents every one of these as a
      // string (ULID or plain text).
      return { t: 'Text', v: raw as string }
    }
  }
}

/**
 * Encode a keyset cursor from one row's resolved sort-term values, mirroring
 * `QueryCursor::encode` (`engine.rs:175-178`): URL-safe, unpadded base64 of
 * the JSON `{ version, values }` envelope (`base64::URL_SAFE_NO_PAD`, not the
 * standard alphabet `btoa` produces on its own).
 *
 * Goes through `utf8ToBase64Url` (`@/lib/base64url`) rather than a bare
 * `btoa`, because `values` carries USER TEXT — the `Title` term is the raw
 * page title and `Priority` is a user-configurable label. The engine encodes
 * `json.as_bytes()`, i.e. UTF-8; `btoa` maps each string CODE UNIT to a byte,
 * which THROWS `InvalidCharacterError` above U+00FF (an em dash, CJK or emoji
 * title would have escaped the IPC boundary as a raw DOMException, since
 * `dispatch` wraps handlers in no try/catch) and silently emits the Latin-1
 * byte for U+0080–U+00FF (`é` ⇒ `0xE9` where Rust has `0xC3 0xA9`) — the
 * exact cursor-byte divergence this fix exists to close.
 */
function encodeCursor(values: CursorValue[]): string {
  const json = JSON.stringify({ version: CURSOR_VERSION, values } satisfies QueryCursorPayload)
  return utf8ToBase64Url(json)
}

// {@link isBase64UrlNoPad} (`@/lib/base64url`) is the alphabet/length gate
// checked ahead of {@link base64UrlToUtf8} below — moved there once
// `decodeBlocksCursor` (`handlers/blocks.ts`) needed the identical check
// (#3942 review note 5). See its doc comment for what the gate does and does
// not catch (non-canonical trailing bits are deliberately NOT mirrored).

/**
 * Each `CursorValue` tag → the JSON type its `v` payload must carry, mirroring
 * what serde accepts for the engine's `#[serde(tag = "t", content = "v")]`
 * enum (`engine.rs:143`): `Text(String)`, `Int(i64)`, `Real(f64)` and the unit
 * variant `Null`.
 *
 * A `Map`, not an object literal, for the same prototype-pollution reason
 * documented on {@link SORT_COLUMN_GETTERS}: `{"t":"constructor"}` would
 * resolve to an inherited `Object.prototype` member on a literal and be
 * accepted as a known tag.
 */
const CURSOR_VALUE_PAYLOAD = new Map<string, 'text' | 'int' | 'real' | 'unit'>(
  Object.entries({ Text: 'text', Int: 'int', Real: 'real', Null: 'unit' } as const),
)

/**
 * Is `v` a runtime {@link CursorValue}? #3914 review note 1.
 *
 * Without this, `ReadonlyArray<CursorValue>` on {@link compareEntryToCursor}
 * was a type-level claim about a value that came off the wire unchecked, and
 * the two ways it was false were both observable through the IPC boundary: a
 * JSON `null` element CRASHED (`isNullCursorValue` tested only `undefined`,
 * so `null.t` threw a raw `TypeError` past a `dispatch` that has no
 * try/catch), and a mistyped payload (`{"t":"Int","v":"abc"}`) made
 * `a.v - b.v` `NaN`, so `findIndex` never fired and the caller got a silently
 * EMPTY page where serde returns `AppError::Validation`.
 *
 * The tag/payload pairing is what serde checks, so it is what this checks:
 * `Int` must be an INTEGER (serde rejects `1.5` for `i64`) while `Real`
 * accepts a JSON integer too (serde reads `2` into an `f64` — the documented
 * byte difference from serde's own `2.0` output). The unit variant accepts
 * both `{"t":"Null"}` and `{"t":"Null","v":null}`, as adjacent tagging does.
 *
 * Extra keys are NOT policed: over-strictness would be its own divergence,
 * and this mock's job is to stop being MORE permissive than the engine.
 */
function isCursorValue(v: unknown): v is CursorValue {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const tag = (v as Record<string, unknown>)['t']
  if (typeof tag !== 'string') return false
  const payload = CURSOR_VALUE_PAYLOAD.get(tag)
  if (payload === undefined) return false
  const raw = (v as Record<string, unknown>)['v']
  switch (payload) {
    case 'text': {
      return typeof raw === 'string'
    }
    case 'int': {
      return typeof raw === 'number' && Number.isInteger(raw)
    }
    case 'real': {
      return typeof raw === 'number' && Number.isFinite(raw)
    }
    default: {
      return raw === undefined || raw === null
    }
  }
}

/**
 * Decode a keyset cursor produced by {@link encodeCursor}, THROWING a
 * {@link validationRejection} on any malformed input — mirroring
 * `QueryCursor::decode` (`agaric-store/src/query/engine.rs:180-195`), which
 * returns a distinct `AppError::Validation` for each of four failure modes
 * (bad base64, invalid UTF-8, invalid JSON, unsupported version) and
 * propagates it to the caller rather than degrading.
 *
 * #3899 — before this, EVERY failure mode here (including a corrupted,
 * foreign, or version-stale cursor) returned `null` and the handler silently
 * restarted from row 0: a client shipping a stale cursor got an error from
 * the real backend and a silent page-1 restart from the mock — the mock
 * being MORE permissive than the thing it stands in for, the exact
 * divergence class this module exists to remove. `list_pages_with_metadata`
 * (`handlers/pages.ts`) keeps its OWN cursor decode lenient on malformed
 * input by design (its real backend command tolerates it there); this one
 * does not, because ITS real backend command does not either.
 *
 * #3914 review notes 1 + 2 — two changes to what "malformed" means:
 *
 *  - the `values` ELEMENTS are checked ({@link isCursorValue}), not just that
 *    `values` is an array, so a `CursorValue` list serde would reject is
 *    rejected here too instead of reaching the keyset as a `null` that
 *    crashes or a mistyped payload that pages emptily;
 *  - the messages are FIXED strings. Each keeps `QueryCursor::decode`'s own
 *    prefix, because that is what names WHICH of the four modes fired; the
 *    suffix is ours rather than the host's, since the host's message (jsdom's
 *    `atob` vs Node's, and their differing `TextDecoder` wording) matched the
 *    engine's in neither runtime and drifted between them.
 */
function decodeCursor(s: string): QueryCursorPayload {
  if (!isBase64UrlNoPad(s)) {
    throw validationRejection('invalid cursor: invalid base64')
  }
  let json: string
  try {
    // `base64UrlToUtf8`, not `atob`: the inverse of {@link encodeCursor}'s
    // UTF-8 encoding. A bare `atob` reads the UTF-8 bytes of a non-ASCII
    // title back as Latin-1 code units (mojibake), which would silently
    // corrupt the anchor value on resume.
    //
    // `fatal: true` (#3914 review note 1) is what makes the SECOND of the
    // engine's four failure modes real here rather than claimed. A default
    // `TextDecoder` is non-fatal: it substitutes U+FFFD for ill-formed bytes,
    // so a cursor whose bytes are not valid UTF-8 but whose REPLACED form is
    // still parseable JSON was accepted, where `QueryCursor::decode`'s
    // `String::from_utf8` returns `AppError::Validation`. This one call site
    // needs the strict decoder; the module's other consumers are deliberately
    // lenient, which is why it is a per-call option and not the default.
    json = base64UrlToUtf8(s, { fatal: true })
  } catch {
    // The alphabet/length check above already ruled out `atob` throwing, so
    // the only way here is the fatal `TextDecoder` — the engine's SECOND
    // mode, which `String::from_utf8` reports separately from its first.
    throw validationRejection('invalid cursor UTF-8: invalid utf-8 sequence')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw validationRejection('invalid cursor JSON: not valid JSON')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as QueryCursorPayload).values)
  ) {
    throw validationRejection('invalid cursor JSON: missing `values` array')
  }
  // Element shapes, BEFORE the version check — serde deserializes the whole
  // struct (elements included) and only then does `decode` compare versions,
  // so a cursor that is both stale and malformed reports the malformation,
  // exactly as the engine does.
  for (const [i, value] of (parsed as { values: unknown[] }).values.entries()) {
    if (!isCursorValue(value)) {
      throw validationRejection(`invalid cursor JSON: values[${i}] is not a CursorValue`)
    }
  }
  const payload = parsed as QueryCursorPayload
  if (payload.version !== CURSOR_VERSION) {
    throw validationRejection(
      `cursor: unsupported version ${payload.version} (expected ${CURSOR_VERSION})`,
    )
  }
  return payload
}

/**
 * The decoded GROUP-level keyset cursor. Mirrors the engine's `GroupCursor`
 * (`agaric-store/src/query/engine.rs:1241-1247`) — a DIFFERENT shape from
 * {@link QueryCursorPayload}: `count` + `key`, not `values`.
 */
interface GroupCursorPayload {
  version: number
  count: number
  key: string
}

/**
 * Decode a GROUP-level keyset cursor, THROWING a {@link validationRejection}
 * on any malformed input — mirroring `GroupCursor::decode`
 * (`agaric-store/src/query/engine.rs:1255-1270`), which the backend's
 * `run_grouped` calls on its OWN cursor type (`engine.rs:1321-1324`); it does
 * NOT reuse `QueryCursor::decode`, and the two structs are not
 * interchangeable — a well-formed `QueryCursor` payload (`{version,values}`)
 * is not a well-formed `GroupCursor` (`{version,count,key}`) and vice versa.
 *
 * #3917 originally routed this arm through {@link decodeCursor} for its
 * throwing side effect. That rejects bad base64 / invalid UTF-8 / invalid
 * JSON correctly (those three checks don't depend on which struct's fields
 * are present), but its FOURTH check — `values` must be an array of
 * {@link CursorValue}s — validates the WRONG shape for a group cursor: it
 * would reject a real, well-formed `GroupCursor` payload as "missing
 * `values` array" (the engine would happily decode it), and it would accept
 * a `{version,values:[]}` payload as well-formed (the engine's
 * `GroupCursor::decode` would reject it — no `count`/`key` fields, exactly
 * as `serde_json::from_str` fails a struct with required fields missing).
 * This mock's grouped path never MINTS a cursor (`nextCursor` is always
 * `null` — grouped pagination is a stub, #3917's own scope note), so no
 * round-trip through the mock alone can hit this; a hand-built or
 * real-backend-sourced group cursor replayed against the mock is what would.
 */
function decodeGroupCursor(s: string): GroupCursorPayload {
  if (!isBase64UrlNoPad(s)) {
    throw validationRejection('invalid group cursor: invalid base64')
  }
  let json: string
  try {
    json = base64UrlToUtf8(s, { fatal: true })
  } catch {
    throw validationRejection('invalid group cursor UTF-8: invalid utf-8 sequence')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw validationRejection('invalid group cursor JSON: not valid JSON')
  }
  // Field PRESENCE + TYPE — EVERY field, `version` included — before the
  // version COMPARISON below. `GroupCursor` (`engine.rs:1241-1247`) declares
  // `version` first, and serde deserializes the whole struct (every declared
  // field, typed) before `GroupCursor::decode` ever compares `cursor.version`
  // — so a cursor missing `version` entirely fails deserialization itself
  // ("missing field `version`"), not the version-mismatch check downstream.
  // `version` used to be left out of this block and only read from `payload`
  // after it, so `{count,key}` with no `version` (or a `version` of the wrong
  // type) fell through to the mismatch check and reported "unsupported
  // version undefined" — the WRONG one of the two failure modes, and a
  // divergence from `decodeGroupCursor`'s own doc above, which claims this
  // exact ordering.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['version'] !== 'number' ||
    !Number.isInteger((parsed as Record<string, unknown>)['version']) ||
    typeof (parsed as Record<string, unknown>)['count'] !== 'number' ||
    !Number.isInteger((parsed as Record<string, unknown>)['count']) ||
    typeof (parsed as Record<string, unknown>)['key'] !== 'string'
  ) {
    throw validationRejection('invalid group cursor JSON: missing `version`/`count`/`key`')
  }
  const payload = parsed as GroupCursorPayload
  if (payload.version !== CURSOR_VERSION) {
    throw validationRejection(
      `group cursor: unsupported version ${payload.version} (expected ${CURSOR_VERSION})`,
    )
  }
  return payload
}

/**
 * One term's comparison, honouring `NULLS LAST` in BOTH directions — matches
 * the engine's `"{expr} {dir} NULLS LAST"` ORDER BY term, where a NULL value
 * sorts last regardless of ASC/DESC.
 */
function compareSortValue(a: SortValue, b: SortValue, desc: boolean): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  let cmp: number
  if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b
  } else {
    const as = String(a)
    const bs = String(b)
    cmp = as < bs ? -1 : as > bs ? 1 : 0
  }
  return desc ? -cmp : cmp
}

function compareByTerms(terms: ReadonlyArray<ResolvedSortTerm>) {
  return (x: MatchedEntry, y: MatchedEntry): number => {
    for (const term of terms) {
      const cmp = compareSortValue(term.get(x), term.get(y), term.desc)
      if (cmp !== 0) return cmp
    }
    return 0
  }
}

/**
 * Is this cursor slot the NULL case — an explicit `Null` tag, or nothing at
 * all (a cursor shorter than the current request's term list, or — only if
 * {@link decodeCursor}'s element validation is ever bypassed — a JSON `null`)?
 *
 * #3914 review — `null` is handled here as well as rejected in
 * {@link decodeCursor}, on purpose. The rejection is the real fix; this is
 * defence in depth, and it is warranted because the failure it prevents is
 * `null.t` throwing a raw `TypeError` across an IPC boundary that `dispatch`
 * wraps in no try/catch — an uncaught crash where the contract (and this
 * comparison's own doc, "never a crash") promises an `AppError`-shaped
 * rejection. The parameter type admits `null` rather than pretending it
 * cannot arrive, since every value here came off a wire.
 */
function isNullCursorValue(
  v: CursorValue | null | undefined,
): v is null | undefined | { t: 'Null' } {
  return v === null || v === undefined || v.t === 'Null'
}

/**
 * One term's comparison in the {@link CursorValue} domain — the same rule
 * {@link compareSortValue} applies (NULLS LAST in BOTH directions, numeric
 * compare when both sides are numeric, string compare otherwise), but over
 * TAGGED values rather than raw ones.
 *
 * #3914 review — this is the domain the keyset comparison must run in, and
 * the reason is that {@link cursorValueFor} is not injective on the SortValue
 * domain: two of the six kinds encode a value to a tag that does not decode
 * back to what the getter returned.
 *
 *   - `LastEditedMs` maps the getter's `''` sentinel to `Int(0)` (the value
 *     the engine's `COALESCE(…, 0)` actually carries). Decoding that back
 *     gives the NUMBER `0`, and `compareSortValue('', 0, …)` takes the string
 *     branch — `''` against `'0'` — so it returns ±1 and NEVER 0.
 *   - `Rank` maps a non-finite rank to `Null` (the engine's own answer for a
 *     row with no rank, and the only tag that survives `JSON.stringify`).
 *     Decoding gives `null`, and NULLS-LAST puts `Infinity` before it.
 *
 * In both cases a row failed to compare EQUAL to the cursor minted from it,
 * which is exactly the invariant a lexicographic keyset resume needs: ±1 at
 * the boundary means the anchor row is either skipped along with everything
 * tied to it, or re-selected forever. Encoding BOTH sides through
 * `cursorValueFor` removes the inverse requirement altogether — the encode is
 * applied once to each operand instead of being undone on one of them — so
 * the whole class is closed rather than the two known instances.
 *
 * This does NOT change the ORDER `compareByTerms` sorts `matched` into (that
 * still runs on raw sort values), and it does not have to: the two agree on
 * every reachable value. `Id`/`Priority`/`Title` tag to `Text` and compare as
 * the same strings; `Position`/`Rank` tag to `Int`/`Real` and compare
 * numerically; nulls stay NULLS-LAST on both sides. `LastEditedMs` is the one
 * mixed case — `Int(0)` against `Text('2024-…')` compares as `'0'` vs the
 * timestamp — and it agrees too, because `'0'` sorts below every ISO-8601
 * year, just as the raw `''` sentinel does.
 */
function compareCursorValue(
  a: CursorValue | null | undefined,
  b: CursorValue | null | undefined,
  desc: boolean,
): number {
  if (isNullCursorValue(a) && isNullCursorValue(b)) return 0
  if (isNullCursorValue(a)) return 1
  if (isNullCursorValue(b)) return -1
  let cmp: number
  if (a.t !== 'Text' && b.t !== 'Text') {
    cmp = a.v - b.v
  } else {
    const as = String(a.v)
    const bs = String(b.v)
    cmp = as < bs ? -1 : as > bs ? 1 : 0
  }
  return desc ? -cmp : cmp
}

/**
 * #3900 — is matched entry `m` strictly AFTER the cursor's tuple, in the same
 * total order {@link compareByTerms} sorted `matched` with?
 *
 * This IS the engine's OR-of-AND keyset predicate (`keyset_predicate`,
 * `agaric-store/src/query/engine.rs:417-442`: `(t0 ▷ v0) OR (t0 = v0 AND t1 ▷
 * v1) OR …`), just expressed as a single lexicographic comparison instead of
 * an OR-of-AND expansion — the two are equivalent by construction because
 * both compare term-by-term with the SAME per-term rule (`compareSortValue`,
 * NULLS LAST in both directions) that defines `matched`'s own order: the
 * first term that disagrees between `m` and the cursor decides, exactly like
 * the first `AND`-clause in the predicate whose strict comparison holds.
 *
 * Deliberately positional over `terms`/`cursorValues` — it reads
 * `cursorValues[i]` against `terms[i]` with NO lookup of which term the
 * cursor was minted under, mirroring the engine's OWN indexing
 * (`cursor.values[i]` against the CURRENT request's `terms[i]`,
 * `engine.rs:429,434`). The prior mock code instead read the cursor's `id`
 * out of whichever slot the CURRENT sort's `column: 'Id'` term happened to
 * occupy — correct only when the cursor was minted under an IDENTICAL sort,
 * and silently wrong (restarting the query from row 0 rather than resuming)
 * when a caller changed `sort` between pages, since #3900 found this
 * unasserted. Replaying the positional comparison instead means a
 * sort-change between pages now degrades EXACTLY like the engine does — a
 * deterministic, possibly-nonsensical page (comparing a stale term's value
 * against a differently-typed CURRENT column), never a crash, never a silent
 * restart — because both sides now run the identical positional algorithm.
 * `cursorValues[i]` past the end of a shorter cursor (a genuinely
 * shorter-tuple sort change) reads as `undefined`, which {@link
 * compareCursorValue} treats as the NULL case — a safe degrade the engine has
 * no equivalent of (`cursor.values[i]` there is an out-of-bounds panic, not
 * a value a mock should ever try to reproduce). "Safe" means bounded and
 * direction-independent, not lossless: NULLS LAST is applied BEFORE the
 * `desc` flip, so the missing slot is the greatest value in either direction
 * and every row that ties on the terms the cursor DOES carry is dropped from
 * the resumed page, ASC and DESC alike. Rows resolved by an earlier term are
 * unaffected. Pinned by test — see the short-cursor block in
 * `advanced-query-sort.test.ts`.
 *
 * #3914 review — the comparison runs in the {@link CursorValue} domain
 * (`cursorValueFor` applied to the ENTRY, compared against the cursor's own
 * tagged value) rather than decoding the cursor back into a raw
 * {@link SortValue}. `cursorValueFor` is not invertible for two of the six
 * kinds, and decoding through it made a boundary row compare ±1 against the
 * cursor minted from it — see {@link compareCursorValue} for the two cases
 * and why encoding both operands closes the class.
 *
 * Exported ONLY as a test seam (#3914 review note 4), like
 * {@link cursorValueFor}: the round-trip invariant it anchors is per-COLUMN,
 * so a handler test can only falsify the columns its fixture happens to
 * exercise. NOT module API — `cursorValues` is trusted to have come through
 * {@link decodeCursor}'s element validation, and no other caller establishes
 * that.
 */
export function compareEntryToCursor(
  terms: ReadonlyArray<ResolvedSortTerm>,
  m: MatchedEntry,
  cursorValues: ReadonlyArray<CursorValue>,
): number {
  for (const [i, term] of terms.entries()) {
    const cmp = compareCursorValue(cursorValueFor(term, m), cursorValues[i], term.desc)
    if (cmp !== 0) return cmp
  }
  return 0
}

// ---------------------------------------------------------------------------
// #3927 — `search_blocks` structural filtering, arm dispatch and toggles
// ---------------------------------------------------------------------------

/** The `PageResponse<SearchBlockRow>` envelope every `search_blocks` arm
 *  answers with — spelled out so the `TypedHandlers` contract checks each arm's
 *  shape rather than widening to `Record<string, unknown>`. */
interface SearchPageResponse {
  items: unknown[]
  next_cursor: string | null
  has_more: boolean
  total_count: number | null
}

/** `fts::MAX_SEARCH_RESULTS` — the FTS scan ceiling `search_blocks_inner`
 *  rejects a larger explicit `limit` against (`queries.rs:239-245`). */
const SEARCH_MAX_RESULTS = 100

/** `pagination::MAX_PAGE_SIZE` (`agaric-store/src/pagination/mod.rs:55`) — the
 *  upper end of the range `PageRequest::new` accepts, checked BEFORE
 *  {@link SEARCH_MAX_RESULTS} and in a different function, hence the two
 *  distinct refusal messages in {@link searchHandlers.search_blocks}. */
const PAGINATION_MAX_PAGE_SIZE = 200

/** `pagination::DEFAULT_PAGE_SIZE` (`mod.rs:52`) — what an OMITTED `limit`
 *  (serde `None`) falls through to. An omitted limit is not an out-of-range
 *  one: it skips the range check entirely. */
const PAGINATION_DEFAULT_PAGE_SIZE = 50

/** `toggle_filter::REGEX_PRE_FILTER_CAP` — the regex arm's SQL `LIMIT`, applied
 *  to the recency-ordered candidate scan BEFORE the pattern runs, so a match
 *  older than the newest 1000 structurally-filtered blocks is invisible. */
const SEARCH_REGEX_PRE_FILTER_CAP = 1000

/**
 * Every `SearchFilter` field that makes `search_with_toggles`'s `has_filters`
 * true — i.e. that turns a blank query from "the empty page" into "the
 * filtered recency page". The first six are the disjuncts spelled out in
 * `toggle_filter.rs`; the rest are the `SearchFilter` fields
 * `prepare_metadata` folds into the `MetadataPredicates` whose `is_empty()` is
 * the seventh disjunct.
 *
 * `scope` is deliberately absent: the backend always supplies a space, so it
 * is not a USER filter and `has_filters` excludes it. So is every toggle —
 * they select the MODE, not the candidate set.
 */
const SEARCH_STRUCTURAL_FILTER_FIELDS = [
  'parentId',
  'tagIds',
  'includePageGlobs',
  'excludePageGlobs',
  'blockTypeFilter',
  'stateFilter',
  'priorityFilter',
  'excludedStateFilter',
  'excludedPriorityFilter',
  'dueFilter',
  'scheduledFilter',
  'propertyFilters',
  'excludedPropertyFilters',
  'lastEdited',
] as const

/**
 * Does this filter carry at least one structural predicate? Mirrors
 * `search_with_toggles`'s `has_filters` disjunction, including its treatment
 * of "present": a `Vec` field is absent when EMPTY (`!x.is_empty()`), not when
 * null, so `tagIds: []` is no filter at all.
 *
 * `honourBlockType: false` is the PARTITIONED disjunction. The two Rust
 * functions spell `has_filters` almost identically, and the one difference is
 * `block_type_filter`: `search_with_toggles` takes it as a parameter and lists
 * it as a disjunct (`toggle_filter.rs:154-161`), while
 * `search_with_toggles_partitioned` has NO such parameter — the partitioning
 * IS the block-type split — so its disjunction omits it
 * (`toggle_filter.rs:330-336`). A blank query whose only "filter" is
 * `blockTypeFilter` is therefore the FILTERED page on `search_blocks` and the
 * EMPTY page on `search_blocks_partitioned`.
 */
function searchHasStructuralFilter(
  filter: Record<string, unknown>,
  honourBlockType = true,
): boolean {
  return SEARCH_STRUCTURAL_FILTER_FIELDS.some((field) => {
    if (field === 'blockTypeFilter' && !honourBlockType) return false
    const v = filter[field]
    if (v === undefined || v === null) return false
    if (Array.isArray(v)) return v.length > 0
    return true
  })
}

/**
 * The structurally-filtered, live block set every arm draws its candidates
 * from — the mock's stand-in for `apply_structural_filters`'s WHERE clauses.
 * See the `search_blocks` handler docstring for which clauses are modelled.
 *
 * `honourBlockType` defaults to `true` for `search_blocks`. #4065 item 1 —
 * `search_blocks_partitioned` reuses this same structural set (`parentId` /
 * `tagIds` / `scope` → `space_id`) but must pass `false`: its `filter`'s
 * `block_type_filter` is DOCUMENTED as ignored there (`queries.rs:657-663`,
 * "the partitioning IS the block-type split") — the two `pages` /
 * `blocks` scans apply their own `block_type = 'page'` pre-filter (or none)
 * downstream instead, mirroring `fts_fetch_rows`'s per-scan `block_type`
 * argument (`partitioned.rs:165-212`).
 */
function searchStructuralCandidates(
  filter: Record<string, unknown>,
  honourBlockType = true,
): Record<string, unknown>[] {
  const scope = filter['scope'] as { kind?: string; space_id?: string } | undefined
  // An omitted `scope` deserialises to `SpaceScope::default()` = `Global`,
  // which applies NO space filter — not a never-matching empty one.
  const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
  const parentId = (filter['parentId'] as string | null | undefined) ?? null
  const blockTypeFilter = honourBlockType
    ? ((filter['blockTypeFilter'] as string | null | undefined) ?? null)
    : null
  const tagIds = (filter['tagIds'] as string[] | undefined) ?? []
  return [...blocks.values()].filter((b) => {
    if (b['deleted_at']) return false
    if (!fbqInSpace(b, spaceId)) return false
    if (parentId !== null && ((b['parent_id'] as string | null) ?? null) !== parentId) return false
    if (blockTypeFilter !== null && b['block_type'] !== blockTypeFilter) return false
    if (tagIds.length > 0) {
      // ALL semantics, direct edges only (`block_tags`), matching the
      // backend's tag clause.
      const own = blockTags.get(b['id'] as string)
      if (!own || !tagIds.every((t) => own.has(t))) return false
    }
    return true
  })
}

/** `ORDER BY b.id DESC` — ULID prefixes are time-sortable, so this is the
 *  backend's recency order on the two FTS-free arms. */
function byIdDesc(x: Record<string, unknown>, y: Record<string, unknown>): number {
  return (y['id'] as string).localeCompare(x['id'] as string)
}

// ---------------------------------------------------------------------------
// #3943 — `pagination::Cursor`, the keyset every `search_blocks` arm pages on
// ---------------------------------------------------------------------------

/**
 * `CURRENT_CURSOR_VERSION` (`agaric-store/src/pagination/mod.rs:114`). Distinct
 * from {@link CURSOR_VERSION}, the engine's `QueryCursor` version — the two
 * codecs are unrelated and happen to sit at the same number.
 */
const PAGINATION_CURSOR_VERSION = 1

/**
 * The `pagination::Cursor` struct (`pagination/mod.rs:553-564`) as far as
 * `search_blocks` populates it: `id` always, and `rank` on the FTS arm
 * (`Cursor::for_id_and_rank`, `mod.rs:788-796`). The other three slots
 * (`position` / `deleted_at` / `seq`) belong to other queries and are never
 * written here, so they are never READ here either — a cursor carrying them is
 * a foreign one, and `search_blocks` ignores the slots its keyset does not use.
 *
 * One divergence that leaves, named rather than papered over: the backend
 * ignores those slots' VALUES but not their TYPES. `Cursor` is one struct, so
 * `serde_json::from_value` still deserialises `position` / `seq` as
 * `Option<i64>` and `deleted_at` as `Option<String>` and rejects a cursor
 * whose unread slot is the wrong shape (`{"id":"x","seq":"nope"}`). This
 * decoder never looks, so it accepts that cursor. Closing it means modelling
 * three slots no `search_blocks` arm can ever mint.
 */
interface SearchCursor {
  id: string
  rank: number | null
}

/**
 * `Cursor::encode` (`pagination/mod.rs:620-631`): URL-safe unpadded base64 of
 * the struct's JSON with a `version` key injected.
 *
 * The unset slots are OMITTED, not written as `null` — every optional field
 * carries `skip_serializing_if = "Option::is_none"` (`mod.rs:556-563`), and
 * presence IS the keyset, which is precisely what the conformance harness's
 * `cursorShape` (#3893) records: `v1:{id}` for the filter-only arm and
 * `v1:{id,rank}` for the FTS arm. Writing an explicit `"rank":null` would
 * render `v1:{id,rank}` on BOTH and hide the difference.
 */
function encodeSearchCursor(id: string, rank: number | null): string {
  const payload: Record<string, unknown> = { id }
  if (rank !== null) payload['rank'] = rank
  payload['version'] = PAGINATION_CURSOR_VERSION
  return utf8ToBase64Url(JSON.stringify(payload))
}

/** The third reviver argument of ES2025 "JSON.parse source text access". Only
 *  PRIMITIVE values carry a `source`; objects and arrays do not, and neither
 *  does a key that appeared more than once in the same object. */
interface JsonReviverContext {
  source?: string
}

type SourceAwareReviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: JsonReviverContext,
) => unknown

/** `JSON.parse` with the third reviver argument the `ES2023` lib type predates. */
const parseJsonWithSource = JSON.parse as unknown as (
  text: string,
  reviver: SourceAwareReviver,
) => unknown

/**
 * Whether this runtime hands a parsed number's SOURCE TEXT to a `JSON.parse`
 * reviver — ES2025 "JSON.parse source text access", V8 ≥ 11.4 / Chrome ≥ 114.
 *
 * Feature-detected rather than assumed, because the mock's runtime floor is
 * not one engine. It is excluded from shipped builds (`main.tsx` gates the
 * import on `!import.meta.env.PROD`, so it never runs in a Tauri webview) and
 * runs in exactly three places: `vitest` on Node (`package.json` `engines`
 * allows `^22.22.2`), Playwright's Chromium against the `VITE_E2E` preview
 * build, and whatever browser a developer points at `vite dev`. The oldest of
 * those is the constraint, and it is not pinned anywhere — hence detection plus
 * the documented fallback in {@link cursorVersionSlotIsU8}, not a hard
 * dependency.
 */
const JSON_PARSE_EXPOSES_SOURCE: boolean = ((): boolean => {
  let seen: unknown
  try {
    parseJsonWithSource('{"v":1.0}', (key, value, context) => {
      if (key === 'v') seen = context?.source
      return value
    })
  } catch {
    return false
  }
  return seen === '1.0'
})()

/** A JSON number lexeme `serde_json` stores as an INTEGER — no `.`, no
 *  exponent, no sign. Anything else lands in the `f64` arm, where `as_u64()`
 *  is `None`. */
const JSON_INTEGER_LEXEME = /^(?:0|[1-9][0-9]*)$/

/**
 * `Cursor::decode`'s accept test for the `version` slot, as measured against
 * `serde_json` rather than inferred (`pagination/mod.rs:656-667`):
 *
 * ```text
 *      0 -> u8=0    1 -> u8=1    2 -> u8=2    255 -> u8=255
 *    256 -> invalid version field       1.0 / 2.0 / 255.0 / 0.0 -> invalid
 *    1.5 -> invalid                     1e0 / 1e2 / 1E2         -> invalid
 *     -0 -> invalid                     -1                      -> invalid
 *    "1" / null / true / [] / {}                                -> invalid
 * ```
 *
 * So the accepted set is exactly "an integer LEXEME whose value is a `u8`" —
 * `n.as_u64().and_then(|v| u8::try_from(v).ok())` over a `Number` that
 * `serde_json` parsed into its integer (not `f64`) representation.
 *
 * `JSON.parse` erases that distinction: `1`, `1.0`, `1e0` and `-0` all become
 * the same JS number. `source` — the raw lexeme from the reviver — restores it,
 * and is the ONLY reason this can be exact.
 *
 * ## The fallback, stated precisely
 *
 * When `source` is `undefined` (a runtime without
 * {@link JSON_PARSE_EXPOSES_SOURCE}, a non-primitive `version`, or a duplicated
 * `version` key, for all of which the spec supplies no source) this degrades to
 * the VALUE test, which differs from the backend on exactly one family: a
 * lexeme that is not an integer but whose value is a `u8` — `N.0`, `Ne0`, `-0`.
 * Those are refused by the backend as `invalid version field` and are either
 * ACCEPTED here (`1.0`, `1e0`) or refused with the MISMATCH message
 * (`2.0` → `unsupported version 2`, `-0` → `unsupported version 0`). Every
 * other input agrees on both paths. That residue is JSON's, not this decoder's,
 * only on a runtime that withholds the lexeme; where the lexeme is available it
 * is not a residue at all.
 */
export function cursorVersionSlotIsU8(value: unknown, source: string | undefined): boolean {
  if (source !== undefined) return JSON_INTEGER_LEXEME.test(source) && Number(source) <= 255
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
}

/**
 * `Cursor::decode` (`pagination/mod.rs:645-679`), THROWING a
 * {@link validationRejection} on malformed input.
 *
 * `search_blocks_inner` decodes through `PageRequest::new`
 * (`src-tauri/src/commands/queries.rs:228`), which runs BEFORE
 * `search_with_toggles` picks an arm and propagates `AppError::Validation` —
 * so the strictness belongs to the COMMAND, not to one arm. The filter-only arm
 * previously swallowed every failure and silently restarted from row 0, which
 * is the same more-permissive-than-the-backend divergence #3899 removed from
 * {@link decodeCursor}.
 *
 * #4030 item 2 — and "the COMMAND" is now what the code does, not only what
 * this comment said. The single call site is the `search_blocks` handler's
 * prologue, which runs it ONCE for all four arms; it used to be called from
 * inside the two PAGING helpers, so the regex and blank-query arms — which
 * return before either helper runs — accepted a cursor that does not decode,
 * where the backend refuses in `PageRequest::new` before dispatch. The helpers
 * now take the DECODED {@link SearchCursor}, so there is still exactly one
 * decode per request and no arm can grow a lenient copy of it back.
 *
 * Two deliberate differences from {@link decodeCursor}, both because this
 * mirrors a DIFFERENT Rust function:
 *
 *  - a MISSING `version` key decodes as the current version. `Cursor::decode`
 *    treats pre-versioning cursors as version 1 by design (`mod.rs:654-657`);
 *    `QueryCursor::decode` has no such clause;
 *  - `id` is a required `String` and `rank` an optional `f64`, so those are
 *    what serde would reject on — there is no `values` array here.
 */
function decodeSearchCursor(s: string): SearchCursor {
  if (!isBase64UrlNoPad(s)) {
    throw validationRejection('invalid cursor: invalid base64')
  }
  let json: string
  try {
    json = base64UrlToUtf8(s, { fatal: true })
  } catch {
    throw validationRejection('invalid cursor UTF-8: invalid utf-8 sequence')
  }
  let parsed: unknown
  // Every `version` slot the parse walked, with the raw lexeme the reviver was
  // handed for it. Collected for ALL holders and narrowed to the ROOT object
  // below, because a nested `{"a":{"version":2}}` carries a `version` key that
  // is not the one `Cursor::decode` reads — and the reviver visits nested keys
  // BEFORE the root's own when the nested object is declared first, so
  // last-one-wins would pick the wrong slot.
  const versionSlots: { holder: unknown; source: string | undefined }[] = []
  try {
    parsed = JSON_PARSE_EXPOSES_SOURCE
      ? parseJsonWithSource(json, function (key, value, context) {
          if (key === 'version') versionSlots.push({ holder: this, source: context?.source })
          return value
        })
      : JSON.parse(json)
  } catch {
    throw validationRejection('invalid cursor JSON: not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw validationRejection('invalid cursor JSON: not an object')
  }
  const obj = parsed as Record<string, unknown>
  const versionSource = versionSlots.find((slot) => slot.holder === parsed)?.source
  // The version comparison runs BEFORE the field shapes, which is the order
  // `Cursor::decode` reads them in: it pulls `version` off the untyped
  // `serde_json::Value` and rejects a mismatch (`mod.rs:654-670`), and only
  // THEN hands the value to `serde_json::from_value::<Cursor>`
  // (`mod.rs:675-676`). Get this backwards and `{"version":2}` reports a
  // missing `id` on a cursor the backend refuses for its version.
  //
  // #4030 item 3 — a MALFORMED version slot is a DIFFERENT refusal from a
  // version MISMATCH, and the mock used to report the latter for both.
  // `Cursor::decode` matches on the `serde_json::Value` (`mod.rs:658-668`):
  // anything that is not a `Number` fails immediately, and a `Number` that is
  // not a `u8` fails the `as_u64().and_then(|v| u8::try_from(v).ok())` chain —
  // both with `cursor: invalid version field`, before `CURRENT_CURSOR_VERSION`
  // is ever compared. Falling through to the `!==` comparison instead reported
  // `unsupported version 1 (expected 1)` for the STRING `"1"`, which names a
  // guard that did not fire and reads as a contradiction.
  //
  // The accept test is the LEXEME's, not the parsed value's — see
  // {@link cursorVersionSlotIsU8} for the measured `serde_json` table and for
  // what the no-lexeme fallback gives up. `1.0`, `1e0` and `-0` are the whole
  // of the difference, and they are refusals here whenever the runtime hands
  // the reviver a `source`.
  const rawVersion = obj['version']
  if (rawVersion !== undefined && !cursorVersionSlotIsU8(rawVersion, versionSource)) {
    throw validationRejection('cursor: invalid version field')
  }
  // A MISSING `version` decodes as the current one — `Cursor::decode`'s
  // `None => CURRENT_CURSOR_VERSION` arm (`mod.rs:657`), the pre-versioning
  // compatibility clause `QueryCursor::decode` has no equivalent of.
  const version = rawVersion === undefined ? PAGINATION_CURSOR_VERSION : rawVersion
  if (version !== PAGINATION_CURSOR_VERSION) {
    throw validationRejection(
      `cursor: unsupported version ${String(version)} (expected ${PAGINATION_CURSOR_VERSION})`,
    )
  }
  if (typeof obj['id'] !== 'string') {
    throw validationRejection('invalid cursor JSON: missing `id`')
  }
  const rawRank = obj['rank']
  if (rawRank !== undefined && rawRank !== null && !Number.isFinite(rawRank)) {
    throw validationRejection('invalid cursor JSON: `rank` is not a number')
  }
  return { id: obj['id'], rank: typeof rawRank === 'number' ? rawRank : null }
}

/**
 * `fts_fetch_filter_only_page`: the `b.id DESC` keyset with a `limit + 1`
 * overflow probe and an id-keyed `next_cursor` (`Cursor::for_id`, hence the
 * `v1:{id}` shape).
 *
 * `has_more` is READ OFF the cursor rather than computed beside it (#3943):
 * the two answer the same question, and a handler that computes them
 * separately can — and in the FTS arm below, did — report `has_more: true`
 * with `next_cursor: null`, a state no backend produces and no client can act
 * on.
 *
 * Takes the DECODED cursor (#4030 item 2): `PageRequest::new` decodes once, at
 * the command, before any arm is picked — see the `search_blocks` handler.
 */
function searchIdDescPage(
  candidates: Record<string, unknown>[],
  cursor: SearchCursor | null,
  limit: number,
): SearchPageResponse {
  let rows = candidates.toSorted(byIdDesc)
  if (cursor != null) {
    // `b.id < ?` — strictly after the previous page's last (oldest) row.
    const after = cursor.id
    rows = rows.filter((b) => (b['id'] as string) < after)
  }
  const window = rows.slice(0, limit + 1)
  const items = window.slice(0, limit)
  const boundary = window.length > limit ? items.at(-1) : undefined
  const nextCursor = boundary ? encodeSearchCursor(boundary['id'] as string, null) : null
  return {
    items,
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
    total_count: null,
  }
}

/**
 * `search_fts` (`agaric-store/src/fts/search/cursor.rs`): the `(rank, id)`
 * keyset the FTS arm pages on, over `ORDER BY fts.rank, b.id`
 * (`fts/search/fetch.rs:292`).
 *
 * #3943 — before this the arm returned insertion order with a `limit + 1`
 * probe and `next_cursor: null`, so it reported a second page that no client
 * could fetch. Two things were missing and both are here: a total ORDER to
 * resume within, and the `(rank, id)` cursor `search_fts` mints from the
 * boundary row (`cursor.rs`, `Cursor::for_id_and_rank`).
 *
 * The keyset predicate is `fetch.rs:199-201`'s, epsilon included:
 * `rank > cursor_rank + eps OR (|rank - cursor_rank| <= eps AND id > cursor_id)`
 * with `eps = 1e-9 * MAX(1, |cursor_rank|)` — a RELATIVE band (#1598) so the
 * tolerance scales with the rank's magnitude. The mock's ranks are exact
 * doubles that never round-trip through SQLite, so the band absorbs nothing
 * here; it is mirrored because it is what decides which side of the boundary
 * an EQUAL-ranked row falls on, and equal ranks are the common case in a small
 * fixture (two blocks with identical stripped text rank identically on both
 * stacks, and are then separated by `id` alone).
 *
 * A cursor minted by the FILTER-ONLY arm carries no `rank`; `rank ?? 0` is
 * then the same `c.rank.unwrap_or(0.0)` `search_fts` applies (`cursor.rs`),
 * so a caller that swaps arms mid-pagination degrades identically on both
 * stacks instead of crashing on either.
 *
 * Takes the DECODED cursor, like {@link searchIdDescPage} — and `null` from
 * the cursor-less callers, which is every partition of
 * `search_blocks_partitioned` (#4030 item 1: `search_fts_partitioned` passes
 * `None` for the cursor and the command answers `next_cursor: None`, but the
 * ORDER and the `limit + 1` probe are `search_fts`'s own).
 *
 * Takes `{ b, stripped }` PAIRS, not raw blocks (#4065 item 4). Every caller
 * has already run {@link stripForFts} once to build its candidate set (the
 * match-narrowing filter, or the structural scan `search_blocks_partitioned`
 * shares between its two partitions); recomputing it here — as this used to —
 * struck a page-typed `search_blocks_partitioned` candidate a second and
 * third time per request (once per partition it lands in), on top of the
 * once already spent narrowing it. Behaviour-neutral: the rank VALUE is
 * unchanged, only how many times it is computed.
 */
function searchFtsRankedPage(
  candidates: Array<{ b: Record<string, unknown>; stripped: string }>,
  foldedQuery: string,
  cursor: SearchCursor | null,
  limit: number,
): SearchPageResponse {
  let ranked = candidates
    .map(({ b, stripped }) => ({
      b,
      rank: approximateFtsRank(stripped, foldedQuery),
    }))
    .toSorted((x, y) => x.rank - y.rank || (x.b['id'] as string).localeCompare(y.b['id'] as string))
  if (cursor != null) {
    const after = cursor
    const afterRank = after.rank ?? 0
    const eps = 1e-9 * Math.max(1, Math.abs(afterRank))
    ranked = ranked.filter(
      (r) =>
        r.rank > afterRank + eps ||
        (Math.abs(r.rank - afterRank) <= eps && (r.b['id'] as string) > after.id),
    )
  }
  const window = ranked.slice(0, limit + 1)
  const items = window.slice(0, limit)
  const boundary = window.length > limit ? items.at(-1) : undefined
  // `search_fts` mints the cursor from `rows[limit - 1]` — the LAST row of the
  // page it is about to return, not the probe row it discards.
  const nextCursor = boundary ? encodeSearchCursor(boundary.b['id'] as string, boundary.rank) : null
  return {
    items: items.map((r) => r.b),
    next_cursor: nextCursor,
    // Derived, not computed alongside — see `searchIdDescPage`.
    has_more: nextCursor !== null,
    total_count: null,
  }
}

/**
 * Compose the pattern the way the backend does and compile it.
 *
 * `literal` picks the composition: `compose_literal_pattern` ESCAPES the query
 * (so `a.b` stays literal on the toggle path), `regex_mode_query` takes it
 * verbatim. Both then apply the same two wrappers — `(?i)` unless
 * `caseSensitive`, and an ASCII word boundary either side when `wholeWord`.
 *
 * JS `\b` is already the ASCII-only boundary Rust spells `(?-u:\b)` as long as
 * the regex is not compiled with the `u` flag, which is why none is passed.
 *
 * BOTH composers NFC-normalise the pattern first — `compose_literal_pattern`
 * (`toggle_filter.rs:567`) and `regex_mode_query` (`toggle_filter.rs:762`) —
 * and neither normalises the CONTENT they run against, which stays as the user
 * typed it. That asymmetry is the backend's, so it is reproduced rather than
 * repaired: an NFD-stored block still evades an NFC pattern on both stacks.
 */
function buildSearchRegex(
  query: string,
  filter: Record<string, unknown>,
  literal: boolean,
): RegExp | null {
  const nfc = query.normalize('NFC')
  const body = literal ? nfc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : nfc
  const source = filter['wholeWord'] === true ? `\\b(?:${body})\\b` : `(?:${body})`
  const flags = filter['caseSensitive'] === true ? '' : 'i'
  try {
    return new RegExp(source, flags)
  } catch {
    // `build_regex` answers an invalid pattern with `AppError::Validation`
    // (`InvalidRegex`); no conformance step drives that, and the handler's
    // callers treat a throw here as a crash, so a null pattern matches
    // nothing — the same visible result as a compile failure's empty page.
    return null
  }
}

/** The `block_type = 'page'` predicate the partitioned command's PAGES scan
 *  adds to its SQL on every arm (`partitioned.rs:165-212`,
 *  `toggle_filter.rs:377-397`, `:1246-1258`) — the partition split itself. */
function isPageTyped(b: Record<string, unknown>): boolean {
  return b['block_type'] === 'page'
}

/**
 * Package one partition of `search_blocks_partitioned` from its scan's rows.
 *
 * Every non-FTS arm of `search_with_toggles_partitioned` ends in the same
 * three lines, and they are identical across the arms:
 * `has_more = limit_usize > 0 && rows.len() > limit_usize`, then
 * `rows.truncate(limit_usize)` (`toggle_filter.rs:437-443` regex,
 * `:530-539` post-filter, `:1273-1281` filter-only). The `limit > 0` half is
 * the degenerate-ask guard — the caller asked this partition for nothing, so
 * there is nothing to "have more" of — and it is what makes a zero limit LEGAL
 * here where `search_blocks`'s `PageRequest::new` range refuses it.
 *
 * Pass the FULL scan result: the backend fetches `limit + 1` and compares
 * `len() > limit`, which is the same boolean as comparing an untruncated
 * length. `next_cursor` is always `null` — the palette does not paginate
 * (`queries.rs:783-796`).
 */
function searchPartitionOf(rows: Record<string, unknown>[], limit: number): SearchPageResponse {
  return {
    items: rows.slice(0, limit),
    next_cursor: null,
    has_more: limit > 0 && rows.length > limit,
    total_count: null,
  }
}

/**
 * The regex arm's pre-filter window: the newest {@link SEARCH_REGEX_PRE_FILTER_CAP}
 * structurally-filtered rows THAT HAVE CONTENT.
 *
 * #3939 item 2 — the order of those two steps is observable and the mock had
 * it backwards. `regex_mode_query`'s SQL carries `AND b.content IS NOT NULL`
 * in its `WHERE` (`toggle_filter.rs:810-816`) and applies `ORDER BY b.id DESC
 * LIMIT ?cap` (`:866-869`, bound to `REGEX_PRE_FILTER_CAP`, `:119`) AFTER it,
 * so the 1000-row window is 1000 rows WITH content. Capping first and dropping
 * null-content rows afterwards — which is what a `searchRegexMatches` that
 * answers `false` for null content does — selects a SHORTER window whenever
 * null-content rows sit inside it, hiding matches the backend reaches.
 *
 * Shared by both regex callers so the two windows cannot disagree: the
 * `search_blocks` regex arm and each partition of the
 * `search_blocks_partitioned` regex arm (whose pages partition pushes
 * `block_type = 'page'` into the same SQL, hence a window narrowed BEFORE the
 * cap there too — `toggle_filter.rs:377-397`).
 */
function searchRegexPrefilterWindow(
  candidates: Record<string, unknown>[],
): Record<string, unknown>[] {
  return candidates
    .filter((b) => b['content'] != null)
    .toSorted(byIdDesc)
    .slice(0, SEARCH_REGEX_PRE_FILTER_CAP)
}

/** Run a composed pattern against RAW `blocks.content` — the column both the
 *  regex arm and `post_filter_row` match on (NOT `fts_blocks.stripped`).
 *
 *  #3939 item 3 — a NON-ZERO-WIDTH match is required. Both backend sites
 *  collect `re.find_iter(content).filter(|m| m.end() > m.start())` and drop the
 *  row when nothing survives: `post_filter_row` (`toggle_filter.rs:618-641`,
 *  "no non-zero-width match") and `regex_mode_query`'s inline loop
 *  (`toggle_filter.rs:905-919`). `RegExp.prototype.test` has no such filter, so
 *  a nullable pattern (`a*`, `(?:)`, an all-optional group) matched EVERY row
 *  here and NO row there — the mock's most inverted regex answer. Spelled with
 *  `exec` + an explicit width test rather than by rejecting nullable patterns
 *  up front, because the backend's filter is per-MATCH: `x*` still keeps a row
 *  containing `xx` (that match is two wide) while dropping one that has only
 *  the zero-width match at position 0.
 *
 *  The scan is a manual `lastIndex` walk because a zero-width match does not
 *  advance a `g`-flagged regex on its own; the composed patterns are built
 *  without `g` (see {@link buildSearchRegex}), so a fresh sticky copy is made
 *  here instead of mutating the caller's.
 */
function searchRegexMatches(re: RegExp | null, b: Record<string, unknown>): boolean {
  if (re === null) return false
  const content = b['content'] as string | null
  if (content == null) return false
  const scan = new RegExp(re.source, `${re.flags.replace(/[gy]/g, '')}g`)
  for (let m = scan.exec(content); m !== null; m = scan.exec(content)) {
    if (m[0].length > 0) return true
    // Zero-width match: `g` alone would spin forever here, so step past it.
    scan.lastIndex += 1
    if (scan.lastIndex > content.length) break
  }
  return false
}

export const searchHandlers = {
  // #1280 — advanced-query engine. The mock cannot compile a `FilterExpr` tree
  // to SQL, so it INTERPRETS it in TypeScript instead. The GROUPED + AGGREGATE
  // response paths are still SYNTHESISED from the request shape (the mock does
  // not compute real buckets/folds yet):
  //   - `aggregates` requested → echo one `AggregateResult` per spec, with a
  //     deterministic stub value (`count` ⇒ `count`, fold ops ⇒ `value`).
  //   - `groupBy` requested → return a single synthetic group bucket keyed by a
  //     rendered label, carrying the per-group aggregates (same shape) and an
  //     empty `rows` page (the GROUPED contract).
  // The FLAT path (no `groupBy`) now evaluates the `FilterExpr` against every
  // active, in-space block via `metaRowMatchesExpr` (which reuses the
  // conformance-guarded per-primitive matrix), narrows to a `fulltext` MATCH
  // when one is present (#3938 — a case-folded substring test over the
  // block's `fts_blocks.stripped` text, NOT its raw `content`; see
  // `stripForFts` and `approximateFtsRank`'s docs for what that leaves out),
  // and orders the matched blocks via `resolveSortTerms` (#3837 — mirrors
  // `resolve_sort` in `agaric-store/src/query/engine.rs`: explicit `sort`
  // keys in request order, else `Relevance` when `fulltext` is present else
  // `b.id DESC`, always terminating in an `id` tiebreak), keyset-paginated.
  // This lets dev-preview + e2e exercise `AdvancedQueryView` against real
  // seed data instead of an always-empty page.
  run_advanced_query: (args) => {
    const request = ((args as Record<string, unknown>)['request'] ?? {}) as Record<string, unknown>
    const aggSpecs = (request['aggregates'] as Array<Record<string, unknown>> | undefined) ?? []
    const groupBy = request['groupBy'] as Record<string, unknown> | null | undefined
    const cursor = request['cursor'] as string | null | undefined

    // Echo one AggregateResult per requested spec. `count` lands in `count`;
    // every fold operator (sum/avg/min/max) lands a stub `value`.
    const aggregateResults = aggSpecs.map((spec, i) => {
      const op = spec['op'] as string
      if (op === 'count') return { op, value: null, count: i + 1 }
      return { op, value: (i + 1) * 10, count: null }
    })

    if (groupBy != null) {
      // First page only: synthesise one bucket. Cursor pages return an empty
      // tail so load-more terminates deterministically.
      //
      // #3917 — `decodeGroupCursor` still runs on a non-null cursor here even
      // though its DECODED value is discarded (grouped pagination has no
      // real keyset to resume from yet — the FLAT path below is the only one
      // with a live cursor contract). Skipping straight to the empty-tail
      // return let a malformed/foreign/version-stale cursor through
      // silently, diverging from the backend's `run_grouped`, which decodes
      // its OWN `GroupCursor` (`engine.rs:1321-1324`) before doing anything
      // else with it. Uses {@link decodeGroupCursor}, NOT the flat path's
      // {@link decodeCursor} — the two cursor shapes are not interchangeable
      // (`{count,key}` vs `{values}`); see that function's doc for the
      // divergence a same-shape reuse would have left.
      if (cursor != null) {
        decodeGroupCursor(cursor)
        return { rows: [], groups: [], nextCursor: null, hasMore: false, totalCount: null }
      }
      const key = (groupBy['key'] as Record<string, unknown> | undefined) ?? {}
      const renderedKey = (key['type'] as string | undefined) ?? 'group'
      return {
        rows: [],
        groups: [
          {
            key: renderedKey,
            count: 1,
            members: [],
            ...(aggregateResults.length > 0 ? { aggregates: aggregateResults } : {}),
          },
        ],
        nextCursor: null,
        hasMore: false,
        totalCount: 1,
        ...(aggregateResults.length > 0 ? { aggregates: aggregateResults } : {}),
      }
    }

    // FLAT structural path: evaluate the `FilterExpr` against every active,
    // in-space block. An omitted filter defaults to the engine's TRUE
    // expression (`And { children: [] }`), so a filterless query returns the
    // whole space.
    const filterExpr = (request['filter'] as Record<string, unknown> | undefined) ?? {
      type: 'And',
      children: [],
    }
    const spaceId = request['spaceId'] as string
    const limit = Math.min(Number((request['limit'] as number | null | undefined) ?? 50), 100)
    // `fulltext`: an empty string is "no term", same convention as
    // `search_blocks`'s `!query` short-circuit.
    const fulltext = (request['fulltext'] as string | null | undefined) ?? ''
    const hasFulltext = fulltext.length > 0
    const foldedQuery = hasFulltext ? foldForFtsIndex(fulltext) : ''
    const edges = deriveLinkEdges(blocks)
    const matched: MatchedEntry[] = []
    for (const b of blocks.values()) {
      if (b['deleted_at']) continue
      if (!fbqInSpace(b, spaceId)) continue
      // Page-aggregate primitives (child/inbound counts) need the block's own
      // page subtree; non-page blocks have no `page_id === id` descendants, so
      // those counts are 0 — matching the backend's per-row `b.*` evaluation.
      const descendants = Array.from(blocks.values()).filter(
        (d) => d['page_id'] === b['id'] && !d['deleted_at'] && d['id'] !== b['id'],
      )
      const row = buildPageMetaRow(b, descendants, edges)
      // #3888 note 3 — the `LastEdited` FILTER reads the same raw
      // `MAX(op_log.created_at)` the `lastEdited` SORT does (`compile_last_edited`,
      // `agaric-store/src/filters/primitive.rs:1035-1052`). #3863 fixed the sort
      // getter alone, which left this one command's filter and sort reading
      // DIFFERENT data: a seeded, op-log-free block could pass `Rolling{30}` on a
      // stamp the backend cannot see and then sort at the never-edited sentinel in
      // the same response, where the engine would have excluded it outright.
      //
      // The entry is built BEFORE the predicate so the filter and the sort share
      // one `lastEditedRaw` memo (see `rawLastEditedOf`) — the resolver is still
      // lazy, so a query with no `LastEdited` leaf and no `lastEdited` sort pays
      // for no op-log scan at all. That memo is the ONLY reason this override
      // still exists: `row.lastModifiedAt` (what `DEFAULT_LAST_EDITED_SOURCE`
      // and therefore `list_pages_with_metadata` read) is the same raw op-log
      // MAX since the seeded fallback was deleted in favour of real seeded
      // `op_log` rows (#3898 / #3884), so both arms of both commands are on
      // one engine-faithful source.
      const entry: MatchedEntry = { b, row }
      if (!metaRowMatchesExpr(row, filterExpr, () => rawLastEditedOf(entry))) continue
      // Full-text narrowing: the engine INTERSECTS `fts_blocks MATCH ?` with
      // the structural predicate (`FROM fts_blocks fts JOIN blocks b …`). The
      // mock approximates the MATCH with a case-folded substring test over the
      // row's `fts_blocks.stripped` text ({@link stripForFts}, #3938) — the
      // SAME memo the relevance rank reads, which is what keeps the two
      // coupled. See `approximateFtsRank`'s docs for what remains approximated
      // (the score, and the FTS5 query grammar).
      if (hasFulltext && !matchesFtsIndex(strippedFtsOf(entry), fulltext)) continue
      matched.push(entry)
    }
    // #3837 — honour the request's `sort`, defaulting to relevance-first when
    // `fulltext` is present and to the `b.id DESC` recency keyset otherwise
    // (mirrors `resolve_sort` — see the comment above the handler).
    const sortKeys = (request['sort'] as Array<Record<string, unknown>> | undefined) ?? []
    const sortTerms = resolveSortTerms(sortKeys, hasFulltext, foldedQuery)
    matched.sort(compareByTerms(sortTerms))

    // #3863 — the cursor carries the FULL resolved sort-term tuple
    // (`{ version, values }`, one tagged `CursorValue` per term, in ORDER BY
    // order), mirroring the engine's `QueryCursor` (`engine.rs:166-196`) —
    // not just `{ id }`.
    //
    // #3900 — resume by REPLAYING the engine's positional keyset predicate
    // (`compareEntryToCursor`, above) rather than by re-locating an anchor
    // ROW by id. `decodeCursor` (#3899) now THROWS on a malformed, foreign,
    // or version-stale cursor instead of returning `null`, mirroring
    // `QueryCursor::decode` propagating `AppError::Validation` to the
    // caller.
    let startIdx = 0
    if (cursor != null) {
      const decoded = decodeCursor(cursor)
      const idx = matched.findIndex((m) => compareEntryToCursor(sortTerms, m, decoded.values) > 0)
      startIdx = idx === -1 ? matched.length : idx
    }
    const slice = matched.slice(startIdx, startIdx + limit + 1)
    const hasMore = slice.length > limit
    const pageEntries = hasMore ? slice.slice(0, limit) : slice
    const pageRows = pageEntries.map((m) => m.b)
    const lastRow = pageEntries.at(-1)
    const nextCursor =
      hasMore && lastRow ? encodeCursor(sortTerms.map((t) => cursorValueFor(t, lastRow))) : null
    return {
      rows: pageRows,
      nextCursor,
      hasMore,
      // total_count is first-page-only (null on cursor pages); the filtered-set
      // size is invariant across cursor pages, mirroring the pages handler.
      totalCount: cursor != null ? null : matched.length,
      ...(aggregateResults.length > 0 ? { aggregates: aggregateResults } : {}),
    }
  },

  /**
   * #3927 — the four reachable arms of `fts::search_with_toggles`
   * (`agaric-store/src/fts/toggle_filter.rs`), in the backend's dispatch
   * ORDER. Before this the handler was `if (!query) return empty` plus a
   * substring scan over every block: it ignored `filter` entirely, so
   * three of the four arms were absent and the fourth was unscoped.
   *
   * The conformance ratchet reported `search_blocks` as covered throughout,
   * because its single query step (`search_zebrafish`) left every toggle at
   * its `serde(default) = false` and supplied no filter — it drove the one
   * arm the mock happened to implement. The four steps in
   * `query_search_blocks_modes.json` drive the rest, and each of the four
   * divergences below was RED when they landed:
   *
   *   1. a blank query with a structural filter returned `[]` here and the
   *      filtered recency page on the backend;
   *   2. `isRegex` matched the pattern as a literal substring, so an anchored
   *      or class-bearing pattern found nothing;
   *   3. `caseSensitive` was ignored (the fold is unconditional);
   *   4. `wholeWord` was ignored.
   *
   * ## What is modelled, and what is not
   *
   * The structural predicate mirrors `apply_structural_filters`'s clause set
   * only as far as `parentId` / `tagIds` / `scope` / `blockTypeFilter`. The
   * page-name GLOBS and the `MetadataPredicates` bundle (state / priority /
   * due / scheduled / property / last-edited) are NOT applied — modelling
   * them means reimplementing `prepare_metadata`, whose date arms resolve
   * against `chrono::Local::now()`. They ARE counted by
   * {@link searchHasStructuralFilter}, because that predicate selects which
   * ARM runs and getting the arm wrong is the larger error. A query carrying
   * only a glob or a metadata filter therefore reaches the right arm here and
   * then over-returns; no conformance step drives one, which is exactly why
   * the gap should be closed by a step rather than trusted.
   *
   * The FTS5 candidate set is {@link matchesFtsIndex} over
   * {@link stripForFts}'s text (#3938) — the same `fts_blocks.stripped` column
   * the trigram index holds, so markup is gone, `#[ULID]` / `[[ULID]]`
   * references read as their target's NAME, and diacritics are NOT folded. It
   * was `matchesSearchFolded` over raw `content` until #3938, which both
   * over-matched (a diacritic-insensitive hit the index cannot produce) and
   * under-matched (a referenced page title the index carries and raw content
   * does not). What is still approximated is the QUERY side: a whole-query
   * substring test, not `sanitize_fts_query`'s trigram token list.
   *
   * Its ORDER is `(rank, id)` (#3943) — `approximateFtsRank` ascending, `id`
   * ascending as the tiebreak, mirroring `ORDER BY fts.rank, b.id`. The rank
   * VALUES are a density approximation, not bm25, so the order is comparable
   * across stacks only where ranks tie and `id` decides; the toggle steps that
   * ride it stay unordered for that reason.
   */
  search_blocks: (args): SearchPageResponse => {
    const a = args as Record<string, unknown>
    const query = (a['query'] as string | null) ?? ''
    const filter = (a['filter'] as Record<string, unknown> | undefined) ?? {}
    const rawCursor = (a['cursor'] as string | null | undefined) ?? null

    // #4030 items 2 + 4 — `search_blocks_inner`'s three PRE-DISPATCH checks, in
    // its order (`src-tauri/src/commands/queries.rs:228-246`). All three run
    // before `search_with_toggles` picks an arm, so each is the COMMAND's
    // refusal and applies to all four arms alike — including the two that
    // never look at a cursor and the one that answers the empty page.
    //
    //  1. `PageRequest::new` validates `limit` against `1..=MAX_PAGE_SIZE`
    //     (`pagination/mod.rs:856-865`) and REFUSES anything else. The mock
    //     clamped instead (`Math.min(…, SEARCH_MAX_RESULTS)`), which silently
    //     accepted a limit of `0` — served as an empty page with
    //     `has_more: false` even with rows remaining, because `items.at(-1)`
    //     is `undefined` — and equally silently shrank an over-cap ask;
    //  2. the SAME call then decodes the cursor (`mod.rs:866-869`), so a
    //     malformed cursor is refused ahead of any arm. Decoding here rather
    //     than inside the two paging helpers is what extends that to the regex
    //     and blank-unfiltered arms, which return before either helper runs;
    //  3. only then does `search_blocks_inner` reject a limit above the FTS
    //     scan ceiling (SQL-A1) — a different guard, in a different function,
    //     with its own message.
    //
    // The order is observable: `{limit: 0, cursor: <garbage>}` reports the
    // LIMIT and `{limit: 150, cursor: <garbage>}` reports the CURSOR.
    //
    // The range test is spelled as an ACCEPT (`(1..=MAX_PAGE_SIZE).contains`,
    // like the Rust) rather than as two comparisons, because a value that is
    // not an integer compares `false` against both bounds and would sail
    // through to `slice(0, limit + 1)` — where `'5' + 1` is `'51'` and
    // `50.5 + 1` is a fractional slice bound.
    //
    // Where the two stacks part, stated in full rather than by half. An
    // INTEGER out of range (`0`, `-1`, `201`) is `AppError::Validation` on both
    // sides, same kind and same text — that is the parity this guard exists
    // for. A NON-INTEGER (`50.5`) or non-number `limit` is not: the backend
    // never reaches `PageRequest::new` with one, because Tauri's `Option<i64>`
    // deserialisation refuses it at the IPC boundary, and a deserialisation
    // failure is not an `AppError` at all — there is no kind on that side for
    // this mock to be in parity WITH. So the `validation` kind thrown here is
    // the mock's own choice, not a mirrored one: it is the cheapest way to keep
    // a fractional bound out of `slice`, and it diverges from the backend in
    // kind as well as text. #2463's kind-parity rule is about refusals the
    // backend expresses as an `AppError`; this is the documented exception, and
    // the exception is why the test below asserts only that it refuses.
    //
    // Nor is it unreachable: `limit` is typed `number`, so a typed caller CAN
    // send `50.5` (only a non-number is ruled out by the types). No caller in
    // this repo does, and both stacks refuse it — they disagree about how.
    const rawLimit = (a['limit'] as number | null | undefined) ?? null
    if (
      rawLimit !== null &&
      !(Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= PAGINATION_MAX_PAGE_SIZE)
    ) {
      throw validationRejection(
        `pagination limit must be in [1, ${PAGINATION_MAX_PAGE_SIZE}]; got ${String(rawLimit)}. ` +
          `For larger result sets, use cursor pagination.`,
      )
    }
    const limit = rawLimit ?? PAGINATION_DEFAULT_PAGE_SIZE
    const cursor = rawCursor === null ? null : decodeSearchCursor(rawCursor)
    if (limit > SEARCH_MAX_RESULTS) {
      throw validationRejection(`search limit must be in [1, ${SEARCH_MAX_RESULTS}]; got ${limit}`)
    }

    const candidates = searchStructuralCandidates(filter)
    const empty = { items: [], next_cursor: null, has_more: false, total_count: null }

    // Arm 1 + 2 — a blank query has nothing for FTS5 MATCH or the regex
    // engine to act on, so the blank-ness test runs BEFORE the mode branch.
    // With no structural filter the answer is the empty page (never the whole
    // DB); with one it degrades to `fts_fetch_filter_only_page`, an
    // FTS-free `FROM blocks b` scan ordered `b.id DESC`.
    if (query.trim() === '') {
      if (!searchHasStructuralFilter(filter)) return empty
      return searchIdDescPage(candidates, cursor, limit)
    }

    // Arm 3 — regex mode BYPASSES FTS5: candidates come from the same
    // structural scan (`ORDER BY b.id DESC`, capped), the pattern runs
    // against RAW `blocks.content`, and the path never emits a cursor.
    if (filter['isRegex'] === true) {
      const re = buildSearchRegex(query, filter, false)
      const items = searchRegexPrefilterWindow(candidates)
        .filter((b) => searchRegexMatches(re, b))
        .slice(0, limit)
      return { items, next_cursor: null, has_more: false, total_count: null }
    }

    // The FTS5 MATCH: a case-folded (NOT diacritic-folded) test over each
    // block's `fts_blocks.stripped` text — see `stripForFts` (#3938). Stripped
    // ONCE here and carried alongside `b` (#4065 item 4) — arm 4 and arm 5
    // below both rank off it via {@link searchFtsRankedPage}, which used to
    // recompute it a second time per hit.
    const ftsCandidates = candidates
      .map((b) => ({ b, stripped: stripForFts(b['content'] as string | null) }))
      .filter((c) => matchesFtsIndex(c.stripped, query))

    // Arm 4 — every toggle off: the FTS5 candidate set IS the answer,
    // rank-ordered and `(rank, id)`-keyset paginated (`search_fts`).
    if (filter['caseSensitive'] !== true && filter['wholeWord'] !== true) {
      return searchFtsRankedPage(ftsCandidates, foldForFtsIndex(query), cursor, limit)
    }

    // Arm 5 — `caseSensitive` and/or `wholeWord` (and NOT `isRegex`): narrow
    // the case-insensitive FTS5 candidate set with the composed literal
    // pattern (`compose_literal_pattern` escapes the query, so metacharacters
    // stay literal here too).
    //
    // THIS is what arm 4's deletion would fall through to, and the two now
    // disagree wherever `fts_blocks.stripped` differs from raw `blocks.content`
    // — `post_filter_row` (`toggle_filter.rs:618-642`) matches the composed
    // pattern against the RAW column, so a block whose term survives only in
    // the stripped text is an arm-4 hit and an arm-5 miss. That divergence is
    // the whole of #3938: it is the only observable difference between the two
    // arms, and modelling `strip_for_fts` is what made it expressible here.
    const re = buildSearchRegex(query, filter, true)
    const survivors = ftsCandidates.filter((c) => searchRegexMatches(re, c.b))
    // `fts_fetch_post_filtered_page` (`fts/search/post_filter.rs:228-250`) pages
    // the SURVIVOR set on the same `(rank, id)` keyset, minting
    // `Cursor::for_id_and_rank` from the last RETURNED survivor — so this arm
    // gets the same treatment as arm 4, over a narrowed candidate list.
    //
    // Its `truncated_by_window_cap` branch (#1556 — the survivor scan ran out
    // of WINDOWS before filling a page, so `has_more` is true off an
    // under-full page) has no analogue here: this scan walks every candidate
    // in one pass, so `fts_exhausted` always holds when the page is short and
    // the branch's condition `!page_full && !fts_exhausted` is unsatisfiable.
    // Modelling it would need a window ceiling the mock does not have.
    return searchFtsRankedPage(survivors, foldForFtsIndex(query), cursor, limit)
  },

  search_blocks_partitioned: (args) => {
    // Phase 1 — partitions a single content scan over `blocks`
    // into `pages` (block_type='page') and `blocks` (unrestricted). The
    // real backend caps each partition independently from one FTS scan;
    // the mock mirrors that wire shape on a substring filter.
    //
    // #3938 — the two `search_fts_partitioned` scans read the SAME
    // `fts_blocks.stripped` column `search_fts` does, so this filter runs the
    // same {@link matchesFtsIndex} over {@link stripForFts} as `search_blocks`.
    // It was `matchesSearchFolded` over raw content, which made the two
    // commands disagree about which blocks match the same query — a divergence
    // between two mock handlers, on top of the one from the backend.
    //
    // #4030 item 1 — and the same is true of their ORDER, which #3938 left at
    // `blocks` Map insertion order. Both partitions run through
    // `fts_fetch_rows` (`partitioned.rs:165-212`), whose SQL ends
    // `ORDER BY fts.rank, b.id` (`fetch.rs:292`) — the very clause
    // {@link searchFtsRankedPage} models for `search_blocks`, which is why the
    // partitions go through that seam rather than a sort spelled again here.
    // `partitioned.rs:55-60` documents both partitions as "in rank order".
    //
    // #4065 item 1 — `filter` used to be read no further than `query` /
    // `pageLimit` / `blockLimit`, so this scan was UNSCOPED where
    // `search_blocks` honours `scope`. It now shares
    // {@link searchStructuralCandidates} with `search_blocks` for `parentId` /
    // `tagIds` / `scope` (→ `space_id`) — the fields
    // `search_blocks_partitioned_inner` also threads into `fts_fetch_rows` on
    // both partitions (`queries.rs:663-678`, `partitioned.rs:165-212`) —
    // called with `honourBlockType: false`, because `filter.block_type_filter`
    // is DOCUMENTED as ignored on this command (`queries.rs:657-663`: "the
    // partitioning IS the block-type split"). Page-name globs and the
    // `MetadataPredicates` bundle stay unmodelled here too, for the same
    // reason `search_blocks`'s docstring gives for leaving them out there.
    const a = args as Record<string, unknown>
    const query = (a['query'] as string) ?? ''
    const filter = (a['filter'] as Record<string, unknown> | undefined) ?? {}
    const pageLimit = (a['pageLimit'] as number) ?? 0
    const blockLimit = (a['blockLimit'] as number) ?? 0

    // #4065 item 2 — `search_blocks_partitioned_inner`'s BE-2 guard
    // (`queries.rs:735-741`) rejects either limit outside
    // `[0, MAX_SEARCH_RESULTS]` BEFORE dispatch, so an over-cap `blockLimit`
    // used to be served rather than refused. `0` is legal HERE (unlike
    // `search_blocks`'s `[1, 200]` `PageRequest::new` range) — see
    // `partitioned.rs:237-238`'s explicit `page_limit_usize > 0 && …` clause,
    // which is what makes this a DIFFERENT guard from the one #4030 item 4
    // added to `search_blocks`, not the same one reused.
    //
    // Where the two stacks part, in KIND as well as text — the same exception
    // {@link searchHandlers.search_blocks} documents for its own guard, which
    // this one inherited without inheriting the note. `page_limit` /
    // `block_limit` are `u32` in Rust (`queries.rs:713-720`), so a NEGATIVE or
    // FRACTIONAL value never reaches `search_blocks_partitioned_inner` at all:
    // Tauri's serde deserialisation refuses it at the IPC boundary, and a
    // deserialisation failure is not an `AppError`, so there is no backend kind
    // for this mock to be in parity WITH. Only an INTEGER above the cap is
    // `AppError::Validation` on both sides with the same text — that is the
    // parity this guard exists for. The `Number.isInteger` / `>= 0` half is the
    // mock's own choice (the cheapest way to keep a fractional bound out of
    // `slice`), and #2463's kind-parity rule is about refusals the backend
    // expresses as an `AppError`. Reachable, though: `pageLimit` is typed
    // `number`, so a typed caller CAN send `-1` or `50.5`; both stacks refuse
    // it, and they disagree about how — which is why the tests below assert
    // only THAT those two refuse, and pin kind + message for the over-cap case
    // alone.
    if (
      !(Number.isInteger(pageLimit) && pageLimit >= 0 && pageLimit <= SEARCH_MAX_RESULTS) ||
      !(Number.isInteger(blockLimit) && blockLimit >= 0 && blockLimit <= SEARCH_MAX_RESULTS)
    ) {
      throw validationRejection(
        `partitioned search limits must each be in [0, ${SEARCH_MAX_RESULTS}]; ` +
          `got page_limit=${pageLimit}, block_limit=${blockLimit}`,
      )
    }

    const structural = searchStructuralCandidates(filter, false)

    // Arm 1 + 2 — the blank-query dispatch, MODE-INDEPENDENT and therefore
    // ahead of the mode branch, exactly as `search_with_toggles_partitioned`
    // puts it ahead of its own (`toggle_filter.rs:330-360`).
    //
    // #4065 item 3 — every path on this command sets `total_count: null`
    // (`queries.rs:783-796`'s `PageResponse`s do); this short circuit used to
    // leave the key off entirely, so a consumer reading it got `undefined`
    // here and `null` everywhere else. Two SEPARATE literals, not one `empty`
    // shared by both partitions: a single object handed to both handed them
    // one `items` array as well, so a caller that mutated one partition's
    // items mutated the other's. Harmless while every caller treats the
    // response as read-only, but nothing here enforced that.
    //
    // #4151 review item 2 — `query.trim() === ''`, not `!query`. The backend
    // short-circuits on `query.trim().is_empty()` (`toggle_filter.rs:330`, and
    // `partitioned.rs:127` behind it), and this mock's own `search_blocks`
    // already trims. A query of `'   '` used to fall through to the FTS path
    // and match on a space substring where both backend sites answer the
    // blank-query dispatch.
    //
    // #4151 review item 1 — the other half of #4065 item 1. With NO user
    // filter the answer is two empty partitions; with at least one it is
    // `fts_fetch_filter_only_partitioned` (`toggle_filter.rs:1233-1288`) — the
    // same two partitions, FTS-free, each an `ORDER BY b.id DESC` scan
    // (`filter_only_scan`, `:1141-1145`) with its own `limit + 1` probe. Until
    // #4151 threaded `filter` through, this branch could not be told apart
    // from the unfiltered one, which is why the mock returned empty
    // unconditionally. `honourBlockType: false` on the `has_filters` test as
    // well as on the candidate scan: the partitioned Rust has no
    // `block_type_filter` parameter, so unlike `search_blocks` it does not
    // list one as a disjunct (see {@link searchHasStructuralFilter}).
    if (query.trim() === '') {
      if (!searchHasStructuralFilter(filter, false)) {
        return {
          pages: { items: [], next_cursor: null, has_more: false, total_count: null },
          blocks: { items: [], next_cursor: null, has_more: false, total_count: null },
        }
      }
      return {
        pages: searchPartitionOf(structural.filter(isPageTyped).toSorted(byIdDesc), pageLimit),
        blocks: searchPartitionOf(structural.toSorted(byIdDesc), blockLimit),
      }
    }

    // Arm 3 — `isRegex`: two parallel `regex_mode_query` scans, FTS bypassed
    // (`toggle_filter.rs:363-453`). The pages scan pushes `block_type = 'page'`
    // into the SAME SQL rather than filtering the shared window afterwards
    // (`:377-397`), so each partition gets its own
    // {@link searchRegexPrefilterWindow} — a pages partition can reach page
    // rows older than the newest 1000 blocks, which one shared window would
    // hide. Each scan asks for `limit + 1` (`probe_limit_i64`, `:551-555`),
    // which is what {@link searchPartitionOf} derives `has_more` from; the
    // scan itself answers `has_more: false` (`:952-957`) and the partitioned
    // caller overrides it (`:440-443`).
    if (filter['isRegex'] === true) {
      const re = buildSearchRegex(query, filter, false)
      const matches = (rows: Record<string, unknown>[]) =>
        searchRegexPrefilterWindow(rows).filter((b) => searchRegexMatches(re, b))
      return {
        pages: searchPartitionOf(matches(structural.filter(isPageTyped)), pageLimit),
        blocks: searchPartitionOf(matches(structural), blockLimit),
      }
    }

    // #4065 item 4 — stripped ONCE per structural candidate and carried
    // alongside `b`, not recomputed per partition. This used to run
    // `stripForFts` again inside {@link searchFtsRankedPage} for EACH
    // partition a row landed in — three times total for a page-typed match
    // (once here, once for `blocks`, once for `pages`).
    const matching = structural
      .map((b) => ({ b, stripped: stripForFts(b['content'] as string | null) }))
      .filter((c) => matchesFtsIndex(c.stripped, query))
    const pagesAll = matching.filter((c) => isPageTyped(c.b))
    const folded = foldForFtsIndex(query)

    // Arm 4 — every toggle off: the straight partitioned FTS scan
    // (`toggle_filter.rs:454-478`). Two INDEPENDENT scans, each capped at its
    // own limit — not one scan partitioned afterwards (`partitioned.rs:17-27`:
    // the one-scan shape could drop the pages partition entirely). `null` for
    // the cursor because the palette does not paginate:
    // `search_fts_partitioned` passes `None` through to both `fts_fetch_rows`
    // calls and the command answers `next_cursor: None`
    // (`queries.rs:783-796`), so the cursor the seam mints from the boundary
    // row is DISCARDED here rather than put on the wire. What is kept is the
    // rest of `search_fts`'s window: the `(rank, id)` order, the
    // `take(limit)`, and the `limit + 1` probe behind `has_more` — including
    // its zero-limit answer (`partitioned.rs:237-238`:
    // `page_limit_usize > 0 && …`, which the seam reproduces because a
    // zero-limit page has no boundary row to mint from).
    if (filter['caseSensitive'] !== true && filter['wholeWord'] !== true) {
      const pages = searchFtsRankedPage(pagesAll, folded, null, pageLimit)
      const blocksPartition = searchFtsRankedPage(matching, folded, null, blockLimit)
      return {
        pages: {
          items: pages.items,
          next_cursor: null,
          has_more: pages.has_more,
          total_count: null,
        },
        blocks: {
          items: blocksPartition.items,
          next_cursor: null,
          has_more: blocksPartition.has_more,
          total_count: null,
        },
      }
    }

    // Arm 5 — `caseSensitive` and/or `wholeWord` (and NOT `isRegex`)
    // (`toggle_filter.rs:479-543`). This path has no cursor, so it cannot page
    // for more survivors the way `search_blocks`'s arm 5 can: it OVER-FETCHES
    // each partition to `MAX_SEARCH_RESULTS` BEFORE the post-filter, then
    // derives `has_more` from the SURVIVOR count against the caller's real
    // limit (`:530-539`). That ceiling is observable and is modelled rather
    // than smoothed over: survivors ranked below the 100th candidate of a
    // partition are not surfaced at all, the documented best-effort trade-off
    // (`:490-496`).
    //
    // One divergence left standing, because it is arm 4's and not this arm's:
    // arm 4 ships `content` truncated to `PALETTE_CONTENT_PREVIEW_CAP` (512
    // codepoints, `partitioned.rs:30-53`) while this arm ships it in full so
    // the post-filter can match past the cut (`:499-511`). The mock models no
    // `content` truncation anywhere, so both arms ship full content here.
    const re = buildSearchRegex(query, filter, true)
    const survivors = (candidates: Array<{ b: Record<string, unknown>; stripped: string }>) =>
      searchFtsRankedPage(candidates, folded, null, SEARCH_MAX_RESULTS).items.filter((b) =>
        searchRegexMatches(re, b as Record<string, unknown>),
      ) as Record<string, unknown>[]
    return {
      pages: searchPartitionOf(survivors(pagesAll), pageLimit),
      blocks: searchPartitionOf(survivors(matching), blockLimit),
    }
  },

  list_unfinished_tasks: (args) => {
    const a = args as Record<string, unknown>
    const beforeDate = a['beforeDate'] as string
    const todoStates = a['todoStates'] as string[]
    const limit = (a['limit'] as number | null) ?? 200
    // Honour `scope: SpaceScope`. The previous mock read
    // `a['spaceId']`, which was the legacy IPC arg shape; the backend
    // now takes `scope: SpaceScope`, so callers in `tauri.ts` pass
    // `toSpaceScope(spaceId)` and the literal `spaceId` arg is no
    // longer present. Active scope: drop blocks whose owning page does
    // not carry `space = ?spaceId`. Global: unfiltered.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    const items = Array.from(blocks.values()).filter((b) => {
      if (b['deleted_at']) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      if (!todoStates.includes((b['todo_state'] as string) ?? '')) return false
      const date = b['due_date'] ?? b['scheduled_date']
      if (!date || date >= beforeDate) return false
      return true
    })

    items.sort((rowA: Record<string, unknown>, rowB: Record<string, unknown>) => {
      const dateA = rowA['due_date'] ?? rowA['scheduled_date'] ?? ''
      const dateB = rowB['due_date'] ?? rowB['scheduled_date'] ?? ''
      if (dateA !== dateB) return (dateB as string).localeCompare(dateA as string)
      return (rowB['id'] as string).localeCompare(rowA['id'] as string)
    })

    return Promise.resolve({
      items: items.slice(0, limit),
      next_cursor: null,
      has_more: items.length > limit,
      total_count: null,
    })
  },

  // AND-intersected property + tag query that the
  // backend resolves entirely in SQL via composed `EXISTS` subqueries.
  // The mock exists so FE tests can assert the IPC fires and observe
  // the post-intersection result; cursor pagination is intentionally
  // skipped (the backend semantic the audit cares about is "no silent
  // row cap" / "single round-trip", not "the mock paginates").
  filtered_blocks_query: (args) => {
    const a = args as Record<string, unknown>
    const propertyFilters = (a['propertyFilters'] as Record<string, unknown>[] | null) ?? []
    const tagFilters = (a['tagFilters'] as Record<string, unknown> | null) ?? null
    const blockType = (a['blockType'] as string | null) ?? null
    // Honour `scope: SpaceScope` (mirrors `filtered_blocks_query_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (blockType !== null && b['block_type'] !== blockType) return false
      if (!fbqInSpace(b, spaceId)) return false
      if (!propertyFilters.every((pf) => fbqPropertyFilterMatches(b, pf))) return false
      return fbqTagFilterMatches(b, tagFilters)
    })
    items.sort((x, y) => (x['id'] as string).localeCompare(y['id'] as string))
    return { items, next_cursor: null, has_more: false, total_count: null }
  },
} satisfies Pick<
  TypedHandlers,
  | 'run_advanced_query'
  | 'search_blocks'
  | 'search_blocks_partitioned'
  | 'list_unfinished_tasks'
  | 'filtered_blocks_query'
>
