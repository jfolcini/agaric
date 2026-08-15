/**
 * #3347 — post-op READ-command query steps for the #763 conformance harness
 * (TS / tauri-mock side).
 *
 * This is the twin of `src-tauri/src/command_integration_tests/conformance_query.rs`.
 * The backend AUTHORS each fixture's `expected_queries` (via the same
 * `CONFORMANCE_UPDATE=1` flow that authors `expected`); this module replays the
 * SAME `queries` steps through the tauri-mock and produces the SAME projection,
 * so one recorded expectation binds both implementations.
 *
 * Keep the two in lockstep: the arg-token expansion, the per-command wire-key
 * table, the row-token grammar, the canonical relabeling and the sort rule are
 * duplicated deliberately, exactly as `conformance-snapshot.ts` duplicates the
 * snapshot builder.
 *
 * Two capabilities beyond "read the ids out of the envelope" (#3826): a row
 * token may carry ATTRIBUTES so a projection bug that keeps the right ids is
 * still visible ({@link TokenSpec}), and a step may take its page cursor from
 * an earlier step's `next_cursor` ({@link QueryStep.cursor_from}) so a fixture
 * can pin a SECOND page.
 *
 * Two more since: a step records the `AppErrorKind` of a command that REFUSED
 * ({@link QueryResult.error}, #3928), and the keyset SHAPE of the cursor it
 * minted ({@link cursorShape}, #3893). The cursor BYTES are still never
 * recorded.
 *
 * ## The space model is fabricated on both sides
 *
 * The backend scopes a block via the `blocks.space_id` COLUMN, which the Rust
 * runner stamps out-of-band with `assign_all_to_test_space`. The mock scopes a
 * block via a `space` REF PROPERTY on its owning page. `stampMockSpace` is the
 * mirror image of the Rust stamp — without it every space-scoped read returns
 * empty on the mock and the two stacks would "agree" only on emptiness. It is
 * called BOTH before and after the op replay (mirroring the Rust runner's two
 * `assign_all_to_test_space` calls) and writes the `properties` store directly
 * with no op-log entry. It cannot perturb the #763 snapshot assertion — but the
 * reason is that the snapshot builder skips the `space` key outright, NOT the
 * call ordering; see `stampMockSpace`'s own docstring below.
 */

import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, properties } from '@/lib/tauri-mock/seed'

/**
 * The harness space id. MUST equal `TEST_SPACE_ID` in
 * `src-tauri/src/command_integration_tests/common.rs` — fixtures never spell it
 * out, they use the `$SPACE` token which both runners expand to this literal.
 */
export const CONFORMANCE_SPACE_ID = '01TESTSPACE000000000000001'

/** Token expanded to {@link CONFORMANCE_SPACE_ID} in every query-step arg. */
const SPACE_TOKEN = '$SPACE'

export interface QueryStep {
  name: string
  command: string
  args?: Record<string, unknown>
  /**
   * Compare `rows` in the order the command returned them. Default: canonical
   * sort, i.e. a SET comparison that cannot see an ordering divergence — see
   * the "Ordering" section of the Rust twin's module docs for what that
   * currently costs. A step whose whole point is a SORT arm must therefore set
   * this: crediting an ordering branch from a set comparison is no evidence at
   * all (#3927, which is why the five `query_pages_metadata_sorts` steps and
   * the three `query_advanced_filters` ones are all `ordered`).
   *
   * Two live mock ordering bugs used to be invisible to an unordered step and
   * both are fixed: #3821 (`run_advanced_query` ordered `b.id ASC`, the engine
   * `b.id DESC`) and #3873 (`list_tags_for_block` returning insertion order).
   * The steps that pin them — `query_advanced_filters`' three, and
   * `query_point_reads_tags`'s `tags_two_surviving_in_id_order` — are
   * `ordered` now. #3821 only ever covered the DEFAULT keyset: the
   * `advanced_position_page_*` steps (#3893) name an EXPLICIT `position` sort,
   * are `ordered`, and pass, tiebreak included, so they were never exposed to
   * it in the first place.

   */
  ordered?: boolean
  /**
   * Take this step's page cursor from the `next_cursor` an EARLIER step of the
   * same fixture returned — the only honest way to spell "the second page",
   * since the cursor is an opaque per-stack keyset blob. Both runners feed each
   * stack its OWN cursor, so the recorded comparison is over the rows the page
   * contains (#3821: an ordering divergence changes WHICH rows a page holds).
   */
  cursor_from?: string
}

export interface QueryResult {
  name: string
  rows: string[]
  has_more: boolean | null
  total_count: number | null
  /**
   * The keyset SHAPE of this step's `next_cursor`, or `null` when it minted
   * none (#3893). See {@link cursorShape} for what the shape holds and why the
   * raw bytes are deliberately not it.
   */
  cursor: string | null
  /**
   * The `AppErrorKind` wire string when the command REFUSED, else `null`
   * (#3928). A refusal is an answer — `get_block` 404s a tombstone — and
   * recording it is what lets a fixture step pin one.
   */
  error: string | null
}

// ---------------------------------------------------------------------------
// Arg-token expansion (mirror of `expand_query_args` in the Rust twin)
// ---------------------------------------------------------------------------

const SEED_LABEL = /^S\d+$/

function expandToken(s: string): string {
  if (s === SPACE_TOKEN) return CONFORMANCE_SPACE_ID
  if (SEED_LABEL.test(s)) return s.padStart(26, '0')
  return s
}

export function expandQueryArgs(v: unknown): unknown {
  if (typeof v === 'string') return expandToken(v)
  if (Array.isArray(v)) return v.map(expandQueryArgs)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = expandQueryArgs(val)
    }
    return out
  }
  return v
}

// ---------------------------------------------------------------------------
// Per-command wire-key table (mirror of the Rust `run_step` arms)
// ---------------------------------------------------------------------------

/**
 * Where the row array lives in a command's response. Most read commands answer
 * with a pagination envelope (`{ items, has_more, total_count }`), but some
 * return the rows BARE — a flat `Vec<T>`, or a single `Option<T>` — with no
 * envelope at all.
 */
type RowsLocation =
  /** The envelope holds the row array under this key. */
  | { readonly kind: 'key'; readonly key: string }
  /** The response IS the row array (a bare `Vec<T>` command). */
  | { readonly kind: 'bare-array' }
  /** The response IS one row, or null/undefined for a miss (`Option<T>`). */
  | { readonly kind: 'bare-row' }
  /** The response is a `HashMap<K, Row>`; each entry projects `K-><row>`. */
  | { readonly kind: 'map-of-row' }
  /**
   * The response is a `HashMap<K, Row[]>`; each entry projects one `K-><row>`
   * per element, and `K->(none)` when the key is present holding an EMPTY
   * array. That last case is the point: `get_batch_properties_inner` OMITS a
   * block with no properties, so "key absent" vs "key present holding `[]`" is
   * a real difference a flattened projection would hide.
   */
  | { readonly kind: 'map-of-rows' }

/**
 * How one row becomes a token.
 *
 *     token := head ("#" attr-name "=" attr-value)*
 *     head  := <id> | <id> "->" <id> | <opaque key>
 *
 * {@link relabelToken} rewrites both sides of an arrow head AND every attr
 * value through the canonical `Bn` map. Attributes exist because an id-only
 * token cannot see a projection bug — the right rows with the wrong `page_id`,
 * the wrong `deleted` flag or the wrong typed value compare equal. Two rules
 * keep them comparable: never attach a clock-derived column verbatim
 * (`deleted_at` normalises to the `DELETED` sentinel the #763 snapshot uses),
 * and never attach content containing `#` or `->`.
 */
type TokenSpec =
  /** `row[idKey]`, plus one `#key=value` segment per `attrKeys` entry. */
  | { readonly kind: 'id'; readonly idKey: string; readonly attrKeys?: readonly string[] }
  /** The `list_page_links` edge pair — an edge's stable name is both ends. */
  | { readonly kind: 'pair' }
  /** A `PropertyRow`: `key#<ValueType>=<value>`. */
  | { readonly kind: 'property' }
  /** The row IS a bare string (the tag-id readers) — relabeled like any id. */
  | { readonly kind: 'scalar' }

interface WireShape {
  /** How the row array is located in the response. */
  rows: RowsLocation
  /** How each located row becomes a comparable token. */
  token: TokenSpec
  /** Envelope key for the scalar, or `null` when the response has no envelope
   *  to carry one — both runners then report `null`. */
  hasMoreKey: string | null
  totalKey: string | null
  /** Envelope key holding the next page cursor. Defaults to the `PageResponse`
   *  key `next_cursor`; `run_advanced_query` answers in camelCase. Read to
   *  thread a `cursor_from` chain AND, since #3893, projected through
   *  {@link cursorShape} into the recorded `cursor` field — no longer "never
   *  recorded". */
  cursorKey?: string
}

/**
 * Attributes carried by every `BlockRow`-shaped row. MUST match `BLOCK_ATTRS`
 * in the Rust twin.
 */
const BLOCK_ATTRS = ['parent_id', 'page_id', 'position', 'deleted_at'] as const

/** Attributes of a `ResolvedBlock` — `title` is the RENAMED `content` column
 *  and `deleted` the derived tombstone flag. Mirrors `RESOLVED_ATTRS`. */
const RESOLVED_ATTRS = ['title', 'block_type', 'deleted'] as const

/**
 * The wire keys each command's response is read through. Deliberately literal:
 * a mock handler that returns the right rows under the wrong envelope key
 * projects to an EMPTY `rows` and fails, rather than being normalised into
 * agreement by a shape-tolerant extractor.
 */
const PAGED = { kind: 'key', key: 'items' } as const
const ID_TOKEN = { kind: 'id', idKey: 'id' } as const
const BLOCK_TOKEN = { kind: 'id', idKey: 'id', attrKeys: BLOCK_ATTRS } as const

const WIRE: Readonly<Record<string, WireShape>> = {
  run_advanced_query: {
    rows: { kind: 'key', key: 'rows' },
    token: ID_TOKEN,
    hasMoreKey: 'hasMore',
    totalKey: 'totalCount',
    cursorKey: 'nextCursor',
  },
  filtered_blocks_query: {
    rows: PAGED,
    token: ID_TOKEN,
    hasMoreKey: 'has_more',
    totalKey: 'total_count',
  },
  list_pages_with_metadata: {
    rows: PAGED,
    token: ID_TOKEN,
    hasMoreKey: 'has_more',
    totalKey: 'total_count',
  },
  search_blocks: { rows: PAGED, token: ID_TOKEN, hasMoreKey: 'has_more', totalKey: 'total_count' },
  list_unfinished_tasks: {
    rows: PAGED,
    token: ID_TOKEN,
    hasMoreKey: 'has_more',
    totalKey: 'total_count',
  },
  list_undated_tasks: {
    rows: PAGED,
    token: ID_TOKEN,
    hasMoreKey: 'has_more',
    totalKey: 'total_count',
  },
  // An edge is a PAIR, so its stable token is `source->target`; `truncated` /
  // `total` map onto the same two scalars every other command reports.
  list_page_links: {
    rows: { kind: 'key', key: 'edges' },
    token: { kind: 'pair' },
    hasMoreKey: 'truncated',
    totalKey: 'total',
  },
  // Journal reads answer BARE — `get_journal_page_by_date` with one row or
  // null, `list_journal_pages_in_range` with a flat array. There is no
  // envelope, so neither scalar exists and both runners report `null`.
  get_journal_page_by_date: {
    rows: { kind: 'bare-row' },
    token: ID_TOKEN,
    hasMoreKey: null,
    totalKey: null,
  },
  list_journal_pages_in_range: {
    rows: { kind: 'bare-array' },
    token: ID_TOKEN,
    hasMoreKey: null,
    totalKey: null,
  },

  // ── Point reads over blocks / properties / tags (#3826) ──
  //
  // The #763 snapshot already diffs the ROWS these serve; what it does not
  // diff is each command's own projection, filtering and pagination of them.
  // Hence the block attributes on every row token: an id-only comparison
  // cannot tell a correct `page_id` from a stale one, or a served tombstone
  // from a filtered one.
  list_blocks: {
    rows: PAGED,
    token: BLOCK_TOKEN,
    hasMoreKey: 'has_more',
    totalKey: 'total_count',
  },
  get_block: { rows: { kind: 'bare-row' }, token: BLOCK_TOKEN, hasMoreKey: null, totalKey: null },
  get_blocks: {
    rows: { kind: 'bare-array' },
    token: BLOCK_TOKEN,
    hasMoreKey: null,
    totalKey: null,
  },
  batch_resolve: {
    rows: { kind: 'bare-array' },
    token: { kind: 'id', idKey: 'id', attrKeys: RESOLVED_ATTRS },
    hasMoreKey: null,
    totalKey: null,
  },
  first_child_for_blocks: {
    rows: { kind: 'map-of-row' },
    token: BLOCK_TOKEN,
    hasMoreKey: null,
    totalKey: null,
  },
  get_properties: {
    rows: { kind: 'bare-array' },
    token: { kind: 'property' },
    hasMoreKey: null,
    totalKey: null,
  },
  get_property: {
    rows: { kind: 'bare-row' },
    token: { kind: 'property' },
    hasMoreKey: null,
    totalKey: null,
  },
  get_batch_properties: {
    rows: { kind: 'map-of-rows' },
    token: { kind: 'property' },
    hasMoreKey: null,
    totalKey: null,
  },
  list_tags_for_block: {
    rows: { kind: 'bare-array' },
    token: { kind: 'scalar' },
    hasMoreKey: null,
    totalKey: null,
  },
  list_inherited_tags_for_block: {
    rows: { kind: 'bare-array' },
    token: { kind: 'scalar' },
    hasMoreKey: null,
    totalKey: null,
  },
  // `truncated` / `total` are the PAGE_SUBTREE_MAX_BLOCKS cap signal, mapping
  // onto the same two scalars every other command reports.
  load_page_subtree: {
    rows: { kind: 'key', key: 'blocks' },
    token: BLOCK_TOKEN,
    hasMoreKey: 'truncated',
    totalKey: 'total',
  },
}

/**
 * Where a command's opaque page cursor lives in its args (mirror of
 * `cursor_path` in the Rust twin) — `list_blocks` and `run_advanced_query` nest
 * every query param under their request DTO, everything else takes a top-level
 * `cursor`.
 *
 * `run_advanced_query` was missing here until #3893 added the first fixture
 * that chains it: `AdvancedQueryRequest.cursor` is a field of the DTO, so a
 * top-level `args.cursor` would have been ignored and the "second page" would
 * silently have been the FIRST page again.
 */
function cursorPath(command: string): readonly string[] {
  return command === 'list_blocks' || command === 'run_advanced_query'
    ? ['request', 'cursor']
    : ['cursor']
}

/** Write `cursor` into `args` at the command's {@link cursorPath}, creating the
 *  intermediate object when the fixture omitted it. */
function injectCursor(command: string, args: Record<string, unknown>, cursor: string | null): void {
  const path = cursorPath(command)
  let node = args
  for (const key of path.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[path.at(-1) as string] = cursor
}

// ---------------------------------------------------------------------------
// Cursor shape (#3893) — mirror of `cursor_shape` / `shape_of_cursor` in Rust
// ---------------------------------------------------------------------------

/**
 * Decode a `next_cursor` and render its keyset SHAPE, or `null` when the step
 * minted none.
 *
 * Before #3893 the harness captured `next_cursor` only to thread it into a
 * `cursor_from` step, and never put any part of it in the recorded
 * {@link QueryResult} — so no fixture assertion could see a cursor at all, and
 * a cursor-format change on the RUST side could land with the mock silently
 * diverging and every fixture green.
 *
 * The recorded value is deliberately NOT the raw cursor string. A cursor's
 * payload is the boundary row's sort tuple — block ids (stack-local for
 * op-created rows), page titles, and for a `LastEdited` sort an op-log clock
 * stamp — i.e. exactly the values the row-token grammar refuses to carry
 * verbatim. It would also false-redden on a `COALESCE(position, sentinel)`
 * whose sentinel is `i64::MAX` on one stack and `Number.MAX_SAFE_INTEGER` on
 * the other while both paginate identically.
 *
 * What IS comparable is the structure the two encoders agreed on: the schema
 * `version`, plus either the ORDERED `t` tags of the engine's `QueryCursor`
 * tuple (the #3863 class — a mock carrying `{id}` alone differs in arity) or
 * the sorted set of POPULATED slots of the `pagination::Cursor` struct (whose
 * optional fields are `skip_serializing_if = "Option::is_none"`, so presence
 * IS the keyset).
 *
 * The base64 decode is part of the assertion: strict URL-safe and unpadded, so
 * a `btoa` (standard alphabet, padded) on either side renders
 * `<not-base64url>` and reddens instead of being tolerated into agreement.
 * Written out here rather than routed through `@/lib/base64url` or the mock's
 * own `decodeCursor` on purpose — a projection that used the production codec
 * could not see a change the codec made to itself.
 *
 * The concrete boundary VALUES are pinned elsewhere and better: a `cursor_from`
 * step compares the ROWS the resumed page holds, which is what a wrong boundary
 * value actually changes.
 *
 * MUST render byte-identically to `shape_of_cursor` in the Rust twin — with
 * two known, narrow exceptions (#3942 review note 6), neither reachable from
 * a cursor either stack actually MINTS today; see `shape_of_cursor`'s own doc
 * comment for the full reachability argument on both:
 *
 *  1. Non-canonical trailing bits (e.g. `"AB"`, whose leftover 4 bits are not
 *     zero) decode silently here via `atob`, where the Rust twin's
 *     `URL_SAFE_NO_PAD` rejects them as `InvalidLastSymbol`. The SAME
 *     divergence every mock cursor decoder deliberately leaves unmirrored
 *     (`isBase64UrlNoPad`, `@/lib/base64url`) for the same reason: neither
 *     encoder can produce such bytes, only a hand-built cursor can.
 *  2. A JSON version literal written with a decimal point (`"version":1.0`)
 *     renders `v1` here — `Number.isInteger(1.0)` is `true`, and JSON's `1`
 *     vs `1.0` are indistinguishable once parsed into a JS `number` — where
 *     the Rust twin renders `v?` (`Value::as_u64` returns `None` for any
 *     float-typed `serde_json::Number`, decimal point and all). This
 *     direction cannot be closed from the TS side at all: by the time this
 *     function sees the value, the information it would need is already
 *     gone.
 */
export function cursorShape(raw: string | null): string | null {
  if (raw == null) return null
  // `URL_SAFE_NO_PAD`: the url-safe alphabet, no `=`, and never a 1-symbol
  // remainder (which carries no whole byte — Rust rejects it as InvalidLength).
  if (!/^[A-Za-z0-9_-]*$/.test(raw) || raw.length % 4 === 1) return '<not-base64url>'
  let bytes: Uint8Array
  try {
    const binary = atob(raw.replaceAll('-', '+').replaceAll('_', '/'))
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return '<not-base64url>'
  }
  let json: string
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return '<not-utf8>'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json) as unknown
  } catch {
    return '<not-json>'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return '<not-an-object>'
  }
  const obj = parsed as Record<string, unknown>
  const rawVersion = obj['version']
  const version =
    typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion >= 0
      ? String(rawVersion)
      : '?'
  const values = obj['values']
  if (Array.isArray(values)) {
    const tags = values.map((e) => {
      const tag = (e as Record<string, unknown> | null)?.['t']
      return typeof tag === 'string' ? tag : '<untagged>'
    })
    // Any SIBLING key of `values` is rendered too — without it the tuple branch
    // reads `version` and `values` and discards the rest, so `QueryCursor`
    // growing a field would be a cursor-format change with no effect on the
    // recorded shape (invisible on the axis #3893 exists to watch, and
    // asymmetric with the slot branch below). Empty today.
    const extra = Object.keys(obj)
      .filter((k) => k !== 'version' && k !== 'values')
      .toSorted()
    const suffix = extra.length === 0 ? '' : `+{${extra.join(',')}}`
    return `v${version}:[${tags.join(',')}]${suffix}`
  }
  const slots = Object.keys(obj)
    .filter((k) => k !== 'version')
    .toSorted()
  return `v${version}:{${slots.join(',')}}`
}

// ---------------------------------------------------------------------------
// Canonical relabeling + ordering (mirror of the Rust twin)
// ---------------------------------------------------------------------------

function tokenKey(token: string): [string, number, string] {
  const m = /^B(\d+)$/.exec(token)
  if (m) return ['B', Number(m[1]), '']
  return ['~', 0, token]
}

function cmpTokens(a: string, b: string): number {
  const [ap, an, as_] = tokenKey(a)
  const [bp, bn, bs] = tokenKey(b)
  if (ap !== bp) return ap < bp ? -1 : 1
  if (an !== bn) return an - bn
  return as_ < bs ? -1 : as_ > bs ? 1 : 0
}

/** Relabel one raw id (or an `a->b` pair) through the canonical map. */
function relabelHead(head: string, labels: ReadonlyMap<string, string>): string {
  const arrow = head.indexOf('->')
  if (arrow >= 0) {
    const src = head.slice(0, arrow)
    const tgt = head.slice(arrow + 2)
    return `${labels.get(src) ?? src}->${labels.get(tgt) ?? tgt}`
  }
  return labels.get(head) ?? head
}

/**
 * Relabel a full row token: the head and every attribute VALUE, so id-valued
 * attributes like `page_id` read `B1` rather than a stack-local id. Attribute
 * NAMES pass through untouched. Mirror of `relabel_token` in the Rust twin.
 */
function relabelToken(token: string, labels: ReadonlyMap<string, string>): string {
  const [head, ...attrs] = token.split('#')
  let out = relabelHead(head ?? token, labels)
  for (const attr of attrs) {
    const eq = attr.indexOf('=')
    out += eq < 0 ? `#${attr}` : `#${attr.slice(0, eq)}=${relabelHead(attr.slice(eq + 1), labels)}`
  }
  return out
}

// ---------------------------------------------------------------------------
// Space stamping (mirror image of the Rust `assign_all_to_test_space`)
// ---------------------------------------------------------------------------

/**
 * Give every PAGE block the mock's space marker — a `space` ref property
 * pointing at {@link CONFORMANCE_SPACE_ID}. Non-page blocks resolve their space
 * through their owning page (`fbqInSpace`), so pages are the whole surface.
 *
 * TOMBSTONED pages are stamped too: the Rust `assign_all_to_test_space` is a
 * blanket `UPDATE blocks SET space_id = …` with no `deleted_at` filter, so
 * skipping them here would make a tombstone-visible scoped read (trash / a
 * restore fixture) return rows on the backend and nothing on the mock — a
 * HARNESS divergence wearing the costume of an implementation one.
 *
 * Call it BOTH before and after the op replay, mirroring the Rust runner's two
 * `assign_all_to_test_space` calls: the backend replays every op with space
 * membership already resolved (write-time same-space filters — e.g.
 * `reindex_block_links` Phase 3 — depend on it), and the second call catches
 * pages the ops created.
 *
 * The #763 snapshot builder explicitly skips the `space` key (the backend keeps
 * it in the `blocks.space_id` column, not `block_properties`), so these writes
 * are invisible to the snapshot regardless of call order.
 */
export function stampMockSpace(): void {
  for (const b of blocks.values()) {
    if (b['block_type'] !== 'page') continue
    const id = b['id'] as string
    if (!properties.has(id)) properties.set(id, new Map())
    properties.get(id)?.set('space', {
      key: 'space',
      value_text: null,
      value_num: null,
      value_date: null,
      value_ref: CONFORMANCE_SPACE_ID,
      value_bool: null,
    })
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * The `deleted_at` sentinel — mirrors the #763 snapshot's normalisation of the
 * epoch-ms tombstone stamp, which is never comparable verbatim.
 */
const DELETED_SENTINEL = 'DELETED'

/**
 * Render one attribute value as a token segment (mirror of `attr_value`).
 *
 * `String(n)` switches to exponent notation outside ±[1e-6, 1e21) and prints
 * `-0` as `0`, where Rust's `Display` does neither. The Rust twin ASSERTS the
 * magnitude is inside that range before recording, so no expectation can exist
 * for a value the two renderings disagree on — hence no guard is needed here.
 */
function attrValue(name: string, v: unknown): string {
  if (v == null) return 'null'
  if (name === 'deleted_at') return DELETED_SENTINEL
  if (typeof v === 'string') return v
  return String(v)
}

/** Build `<row[idKey]>#<attr>=<value>…` for one row. */
function idToken(row: Record<string, unknown>, idKey: string, attrKeys: readonly string[]): string {
  let token = (row[idKey] as string | undefined) ?? '<missing-id>'
  for (const attr of attrKeys) {
    token += `#${attr}=${attrValue(attr, row[attr])}`
  }
  return token
}

/**
 * Build `<key>#<ValueType>=<value>` for one `PropertyRow`. The
 * first-non-null-column precedence is the SAME rule the #763 snapshot uses
 * (`propertyTypedValue` in `conformance-snapshot.ts`), so a property read and
 * the snapshot row behind it disagree only when the command's own projection is
 * wrong. `Bool` keeps SQLite's raw `0`/`1` INTEGER — both stacks store it.
 */
function propertyToken(row: Record<string, unknown>): string {
  const key = (row['key'] as string | undefined) ?? '<missing-key>'
  for (const [column, tag] of [
    ['value_text', 'Text'],
    ['value_num', 'Num'],
    ['value_date', 'Date'],
    ['value_ref', 'Ref'],
    ['value_bool', 'Bool'],
  ] as const) {
    if (row[column] != null) return `${key}#${tag}=${attrValue(column, row[column])}`
  }
  return `${key}#null=null`
}

/** Turn one located row into its token, per the command's {@link TokenSpec}. */
function rowToken(raw: unknown, spec: TokenSpec): string {
  if (spec.kind === 'scalar') return typeof raw === 'string' ? raw : '<not-a-string>'
  const row = (raw ?? {}) as Record<string, unknown>
  switch (spec.kind) {
    case 'id': {
      return idToken(row, spec.idKey, spec.attrKeys ?? [])
    }
    case 'pair': {
      const src = (row['source_id'] as string | undefined) ?? '?'
      const tgt = (row['target_id'] as string | undefined) ?? '?'
      return `${src}->${tgt}`
    }
    case 'property': {
      return propertyToken(row)
    }
  }
}

/** Locate the row array in a response, per the command's {@link RowsLocation}. */
function locateRows(response: unknown, where: RowsLocation): unknown {
  switch (where.kind) {
    case 'key': {
      return (response as Record<string, unknown> | null)?.[where.key]
    }
    case 'bare-array': {
      return response
    }
    case 'bare-row': {
      // A miss (`null` / `undefined`) is zero rows, a hit is exactly one.
      return response == null ? [] : [response]
    }
    case 'map-of-row':
    case 'map-of-rows': {
      // Handled by `rawRows` — the map KEY is half of every token, so the
      // entries cannot be flattened into a bare row array first.
      return response
    }
  }
}

function rawRows(response: unknown, shape: WireShape): string[] {
  if (shape.rows.kind === 'map-of-row' || shape.rows.kind === 'map-of-rows') {
    const map = (response ?? {}) as Record<string, unknown>
    if (typeof map !== 'object') return []
    const out: string[] = []
    for (const [key, value] of Object.entries(map)) {
      if (shape.rows.kind === 'map-of-row') {
        out.push(`${key}->${rowToken(value, shape.token)}`)
        continue
      }
      const rows = Array.isArray(value) ? value : []
      if (rows.length === 0) {
        out.push(`${key}->(none)`)
        continue
      }
      for (const r of rows) {
        out.push(`${key}->${rowToken(r, shape.token)}`)
      }
    }
    return out
  }
  const rows = locateRows(response, shape.rows)
  if (!Array.isArray(rows)) return []
  return rows.map((r) => rowToken(r, shape.token))
}

/**
 * #3833 item 7/12 — mirror of the Rust twin's duplicate-name check
 * (`conformance_query.rs::run_query_steps`). Positional alignment (both
 * twins index into `queries[i]` / `expected_queries[i]`) does not NEED
 * unique names to be correct, but a diff message that names a step by
 * `name` cannot be attributed to the right one when two steps share it.
 *
 * Exported so the property has a test of its own. No fixture can trip it
 * today, so leaving it private would make it a guard whose body never runs —
 * the failure mode it was written to prevent, one level up.
 */
export function assertUniqueStepNames(steps: ReadonlyArray<QueryStep>): void {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const step of steps) {
    if (seen.has(step.name)) dupes.add(step.name)
    seen.add(step.name)
  }
  if (dupes.size === 0) return
  throw new Error(
    `fixture has duplicate query step name(s) ${JSON.stringify([...dupes])} — every ` +
      `\`queries[].name\` in a fixture must be unique, or a failure cannot be attributed ` +
      `to the right step.`,
  )
}

/**
 * Replay a fixture's `queries` steps through the tauri-mock and project each
 * response exactly as the Rust twin does.
 */
export async function runQuerySteps(
  steps: ReadonlyArray<QueryStep>,
  labels: ReadonlyMap<string, string>,
): Promise<QueryResult[]> {
  assertUniqueStepNames(steps)
  const out: QueryResult[] = []
  const cursors = new Map<string, string | null>()
  for (const step of steps) {
    const shape = WIRE[step.command]
    if (!shape) {
      throw new Error(
        `conformance query command '${step.command}' is not wired in the TS runner ` +
          `(add an entry to WIRE in conformance-query.ts and the matching arm in ` +
          `conformance_query.rs)`,
      )
    }
    const args = expandQueryArgs(step.args ?? {}) as Record<string, unknown>
    if (step.cursor_from != null) {
      if (!cursors.has(step.cursor_from)) {
        throw new Error(
          `query step '${step.name}' reads \`cursor_from\` '${step.cursor_from}', which is ` +
            `not an EARLIER step in this fixture`,
        )
      }
      injectCursor(step.command, args, cursors.get(step.cursor_from) ?? null)
    }
    // A handler that REJECTS has behaved, and the refusal is recorded like any
    // other answer (#3928). Only an `AppError`-shaped rejection is treated as
    // one: a bare `Error` (or a thrown non-object) is a MOCK BUG, not a
    // backend-comparable refusal, and it re-throws so it cannot be authored
    // into a fixture as if the backend had answered that way. The kind the
    // handlers mint (`notFoundRejection` → `'not_found'`) is the same snake_case
    // `AppErrorKind` string the Rust twin records.
    let response: unknown
    let error: string | null = null
    try {
      response = (await dispatch(step.command, args)) as unknown
    } catch (err) {
      const kind = (err as Record<string, unknown> | null)?.['kind']
      if (typeof kind !== 'string') throw err
      response = null
      error = kind
    }
    const nextCursor =
      error === null
        ? ((((response ?? {}) as Record<string, unknown>)[shape.cursorKey ?? 'next_cursor'] as
            | string
            | null) ?? null)
        : null
    cursors.set(step.name, nextCursor)
    const rows = error === null ? rawRows(response, shape).map((t) => relabelToken(t, labels)) : []
    // Scalars are read off the ENVELOPE; a bare response has none, and the
    // Rust twin reports `None` for those commands.
    const envelope = (response ?? {}) as Record<string, unknown>
    out.push({
      name: step.name,
      rows: step.ordered === true ? rows : rows.toSorted(cmpTokens),
      has_more:
        error !== null || shape.hasMoreKey === null
          ? null
          : ((envelope[shape.hasMoreKey] as boolean) ?? null),
      total_count:
        error !== null || shape.totalKey === null
          ? null
          : ((envelope[shape.totalKey] as number | null) ?? null),
      cursor: cursorShape(nextCursor),
      error,
    })
  }
  return out
}
