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

import { base64UrlToUtf8, utf8ToBase64Url } from '@/lib/base64url'
import { foldForSearch, matchesSearchFolded } from '@/lib/fold-for-search'
import {
  type PageMetaRow,
  type TypedHandlers,
  buildPageMetaRow,
  deriveLinkEdges,
  fbqInSpace,
  fbqPropertyFilterMatches,
  fbqTagFilterMatches,
  metaRowMatchesExpr,
  rawOpLogLastEditedAt,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { blocks, properties } from '@/lib/tauri-mock/seed'

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
 *  - Real ranking runs over `strip_for_fts_with_maps`'s stripped text, which
 *    also embeds referenced tag/page NAMES, so a block linking `[[Foo]]`
 *    ranks for a `Foo` query even without the literal substring. This scores
 *    the block's raw `content` only — the same simplification this file's
 *    `search_blocks` / `search_blocks_partitioned` handlers already make.
 *    Same for the MATCH narrowing itself (below): it is a folded substring
 *    test, not an FTS5 trigram/`sanitize_fts_query` query.
 *
 * That second divergence runs in BOTH directions, which is easy to miss
 * because only the false-negative half is obvious:
 *
 *  - FALSE NEGATIVE (the `[[Foo]]` case above): real FTS matches text this
 *    scan cannot see, so the mock under-matches.
 *  - FALSE POSITIVE: real FTS indexes the STRIPPED text, so the markdown
 *    delimiters themselves are gone from it. This scans raw `content`, where
 *    they are still present — a query containing `**`, `[[` or `#` can match
 *    here and match nothing in the real index. The same asymmetry skews the
 *    score even when both agree on matching, since `foldedText.length` counts
 *    delimiter characters that real bm25's document length never saw, so a
 *    heavily-formatted block ranks worse here than it does in the backend.
 *
 * Neither direction is a defect to fix in the mock — reproducing them needs
 * the real stripper and an FTS5 index. They are the boundary of what a mock
 * relevance assertion can be trusted to prove, and a test that depends on
 * either direction is testing this approximation, not the backend.
 *
 * Exported ONLY as a test seam (#3914 review note 3): the zero-occurrence
 * branch below is unreachable through `run_advanced_query`, and what makes it
 * unreachable is a COUPLING to `matchesSearchFolded` that is now load-bearing
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
export function approximateFtsRank(content: string | null, foldedQuery: string): number {
  const foldedText = foldForSearch(content ?? '')
  // A non-empty `fulltext` CAN fold to `''` (a lone combining mark folds
  // away entirely), and `matchesSearchFolded` admits every row when it does —
  // so this branch is on the reachable path and must return a FINITE length,
  // not fall through to the zero-occurrence guard below.
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
  // `matchesSearchFolded(row.content ?? '', fulltext)` (`fold-for-search.ts`)
  // and ranks with `approximateFtsRank(row.content, foldForSearch(fulltext))`
  // — the SAME haystack through the SAME `foldForSearch`, against the SAME
  // folded needle. `includes` is true exactly when `split` yields ≥ 2 parts,
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
        get: (m) => approximateFtsRank(m.row.content, foldedQuery),
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
      get: (m) => approximateFtsRank(m.row.content, foldedQuery),
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
      // (`matchesSearchFolded`) and `approximateFtsRank` fold the SAME query
      // with the SAME function, so every surviving row has ≥1 occurrence —
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

/**
 * The unpadded base64url alphabet, plus the length rule
 * `URL_SAFE_NO_PAD.decode` enforces — a remainder of 1 symbol carries no
 * whole byte, so Rust rejects it as `InvalidLength`.
 *
 * Checked ahead of {@link base64UrlToUtf8} rather than relying on `atob` to
 * throw, for two reasons: it separates the engine's FIRST failure mode (bad
 * base64) from its SECOND (invalid UTF-8), which the single combined call
 * cannot, and it does so without sniffing the host's exception type —
 * `atob` throws a `DOMException` and a fatal `TextDecoder` a `TypeError`, but
 * which of those is observable is a runtime detail (jsdom vs Node), the same
 * host-dependence #3914 review note 2 objects to in the message.
 *
 * Deliberately NOT mirrored: Rust's base64 also rejects non-canonical
 * trailing bits — a final symbol whose leftover bits are not zero, such as
 * `"AB"` (12 bits for one byte, and the spare 4 are `0001`) — which `atob`
 * silently discards instead. That is a strictly narrower acceptance on the
 * engine's side and a cursor with such bytes cannot be minted by
 * {@link encodeCursor}, so the residual divergence is unreachable except by a
 * hand-built cursor whose payload would then have to also be valid UTF-8,
 * valid JSON and a valid `CursorValue` list to reach the keyset at all.
 */
const BASE64URL_NO_PAD = /^[A-Za-z0-9_-]*$/

function isBase64UrlNoPad(s: string): boolean {
  return BASE64URL_NO_PAD.test(s) && s.length % 4 !== 1
}

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
  // when one is present (a folded-substring test over the block's own
  // `content` — see `approximateFtsRank`'s docs for what that leaves out),
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
    const foldedQuery = hasFulltext ? foldForSearch(fulltext) : ''
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
      // the structural predicate (`FROM fts_blocks fts JOIN blocks b …`).
      // The mock approximates the MATCH with a folded substring test over
      // the row's own content — see `approximateFtsRank`'s docs for what
      // that leaves out (referenced tag/page names, real FTS5 query syntax).
      if (hasFulltext && !matchesSearchFolded(row.content ?? '', fulltext)) continue
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

  search_blocks: (args) => {
    const a = args as Record<string, unknown>
    const query = (a['query'] as string) ?? ''
    if (!query) return { items: [], next_cursor: null, has_more: false, total_count: null }
    // Unicode-aware fold so the mock parity-matches the real
    // backend's FTS5 / `COLLATE NOCASE` behaviour for Turkish / German
    // / accented inputs.  Tests that assert Unicode matching against
    // the mock now see consistent behaviour.
    const items = [...blocks.values()].filter(
      (b) =>
        !(b['deleted_at'] as string | null) &&
        matchesSearchFolded((b['content'] as string) ?? '', query),
    )
    return { items, next_cursor: null, has_more: false, total_count: null }
  },

  search_blocks_partitioned: (args) => {
    // Phase 1 — partitions a single content-fold over `blocks`
    // into `pages` (block_type='page') and `blocks` (unrestricted). The
    // real backend caps each partition independently from one FTS scan;
    // the mock mirrors that wire shape on a folded-substring filter.
    const a = args as Record<string, unknown>
    const query = (a['query'] as string) ?? ''
    const pageLimit = (a['pageLimit'] as number) ?? 0
    const blockLimit = (a['blockLimit'] as number) ?? 0
    const empty = { items: [], next_cursor: null, has_more: false }
    if (!query) return { pages: empty, blocks: empty }

    const matching = [...blocks.values()].filter(
      (b) =>
        !(b['deleted_at'] as string | null) &&
        matchesSearchFolded((b['content'] as string) ?? '', query),
    )

    const pagesAll = matching.filter((b) => (b['block_type'] as string) === 'page')
    const pagesItems = pagesAll.slice(0, pageLimit)
    const blocksItems = matching.slice(0, blockLimit)

    return {
      pages: {
        items: pagesItems,
        next_cursor: null,
        has_more: pageLimit > 0 && pagesItems.length === pageLimit && pagesAll.length > pageLimit,
        total_count: null,
      },
      blocks: {
        items: blocksItems,
        next_cursor: null,
        has_more:
          blockLimit > 0 && blocksItems.length === blockLimit && matching.length > blockLimit,
        total_count: null,
      },
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
