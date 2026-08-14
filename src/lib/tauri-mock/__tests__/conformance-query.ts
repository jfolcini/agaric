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
 * can pin a SECOND page — the cursor is threaded, never recorded.
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
   * currently costs — two LIVE mock ordering bugs are invisible to an
   * unordered step today: #3821 (`run_advanced_query` orders `b.id ASC`, the
   * engine `b.id DESC`) and #3873 (`list_tags_for_block` returns insertion
   * order, the backend `ORDER BY tag_id`). Both have a fixture step already
   * shaped to pin the order: set `ordered` and re-author once they are fixed.
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
   *  key `next_cursor`; `run_advanced_query` answers in camelCase. Read only to
   *  thread a `cursor_from` chain — never recorded. */
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
 * `cursor_path` in the Rust twin) — `list_blocks` nests every query param under
 * its `request` DTO, everything else takes a top-level `cursor`.
 */
function cursorPath(command: string): readonly string[] {
  return command === 'list_blocks' ? ['request', 'cursor'] : ['cursor']
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
 * Replay a fixture's `queries` steps through the tauri-mock and project each
 * response exactly as the Rust twin does.
 */
export async function runQuerySteps(
  steps: ReadonlyArray<QueryStep>,
  labels: ReadonlyMap<string, string>,
): Promise<QueryResult[]> {
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
    const response = (await dispatch(step.command, args)) as unknown
    cursors.set(
      step.name,
      (((response ?? {}) as Record<string, unknown>)[shape.cursorKey ?? 'next_cursor'] as
        | string
        | null) ?? null,
    )
    const rows = rawRows(response, shape).map((t) => relabelToken(t, labels))
    // Scalars are read off the ENVELOPE; a bare response has none, and the
    // Rust twin reports `None` for those commands.
    const envelope = (response ?? {}) as Record<string, unknown>
    out.push({
      name: step.name,
      rows: step.ordered === true ? rows : rows.toSorted(cmpTokens),
      has_more:
        shape.hasMoreKey === null ? null : ((envelope[shape.hasMoreKey] as boolean) ?? null),
      total_count:
        shape.totalKey === null ? null : ((envelope[shape.totalKey] as number | null) ?? null),
    })
  }
  return out
}
