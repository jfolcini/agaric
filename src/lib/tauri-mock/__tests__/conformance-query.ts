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
 * table, the canonical relabeling and the sort rule are duplicated deliberately,
 * exactly as `conformance-snapshot.ts` duplicates the snapshot builder.
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
   * currently costs (#3821: the mock's `run_advanced_query` orders `b.id ASC`,
   * the engine `b.id DESC`; set `ordered` on those steps once it is fixed).
   */
  ordered?: boolean
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

interface WireShape {
  /** How the row array is located in the response. */
  rows: RowsLocation
  /** Row key holding the block id, or `null` for the `list_page_links` pair form. */
  idKey: string | null
  /** Envelope key for the scalar, or `null` when the response has no envelope
   *  to carry one — both runners then report `null`. */
  hasMoreKey: string | null
  totalKey: string | null
}

/**
 * The wire keys each command's response is read through. Deliberately literal:
 * a mock handler that returns the right rows under the wrong envelope key
 * projects to an EMPTY `rows` and fails, rather than being normalised into
 * agreement by a shape-tolerant extractor.
 */
const PAGED = { kind: 'key', key: 'items' } as const

const WIRE: Readonly<Record<string, WireShape>> = {
  run_advanced_query: {
    rows: { kind: 'key', key: 'rows' },
    idKey: 'id',
    hasMoreKey: 'hasMore',
    totalKey: 'totalCount',
  },
  filtered_blocks_query: {
    rows: PAGED,
    idKey: 'id',
    hasMoreKey: 'has_more',
    totalKey: 'total_count',
  },
  list_pages_with_metadata: {
    rows: PAGED,
    idKey: 'id',
    hasMoreKey: 'has_more',
    totalKey: 'total_count',
  },
  search_blocks: { rows: PAGED, idKey: 'id', hasMoreKey: 'has_more', totalKey: 'total_count' },
  list_unfinished_tasks: {
    rows: PAGED,
    idKey: 'id',
    hasMoreKey: 'has_more',
    totalKey: 'total_count',
  },
  list_undated_tasks: {
    rows: PAGED,
    idKey: 'id',
    hasMoreKey: 'has_more',
    totalKey: 'total_count',
  },
  // An edge is a PAIR, so its stable token is `source->target`; `truncated` /
  // `total` map onto the same two scalars every other command reports.
  list_page_links: {
    rows: { kind: 'key', key: 'edges' },
    idKey: null,
    hasMoreKey: 'truncated',
    totalKey: 'total',
  },
  // Journal reads answer BARE — `get_journal_page_by_date` with one row or
  // null, `list_journal_pages_in_range` with a flat array. There is no
  // envelope, so neither scalar exists and both runners report `null`.
  get_journal_page_by_date: {
    rows: { kind: 'bare-row' },
    idKey: 'id',
    hasMoreKey: null,
    totalKey: null,
  },
  list_journal_pages_in_range: {
    rows: { kind: 'bare-array' },
    idKey: 'id',
    hasMoreKey: null,
    totalKey: null,
  },
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

function relabelToken(token: string, labels: ReadonlyMap<string, string>): string {
  const arrow = token.indexOf('->')
  if (arrow >= 0) {
    const src = token.slice(0, arrow)
    const tgt = token.slice(arrow + 2)
    return `${labels.get(src) ?? src}->${labels.get(tgt) ?? tgt}`
  }
  return labels.get(token) ?? token
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
  }
}

function rawRows(response: unknown, shape: WireShape): string[] {
  const rows = locateRows(response, shape.rows)
  if (!Array.isArray(rows)) return []
  return rows.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>
    if (shape.idKey === null) {
      const src = (row['source_id'] as string | undefined) ?? '?'
      const tgt = (row['target_id'] as string | undefined) ?? '?'
      return `${src}->${tgt}`
    }
    return (row[shape.idKey] as string | undefined) ?? '<missing-id>'
  })
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
    const response = (await dispatch(step.command, args)) as unknown
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
