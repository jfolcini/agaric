/**
 * #763 — the shared normalized-snapshot builder (TS / tauri-mock side).
 *
 * This is the TS twin of the Rust snapshot builder at
 * `src-tauri/src/command_integration_tests/conformance_snapshot.rs`. It must
 * produce a snapshot that is BYTE-IDENTICAL (after canonical key sorting) to
 * the one the backend authors for the same logical state. Keep the two in
 * lockstep — the canonical id relabeling, field projection, sort order, and
 * op_log-digest normalization rules are duplicated deliberately so an identical
 * state on both sides yields identical JSON.
 *
 * See the Rust module's doc comment for the relabeling contract.
 */

// ---------------------------------------------------------------------------
// Mock state shapes (subset of what handlers.ts reads/writes).
// ---------------------------------------------------------------------------

type MockBlock = Record<string, unknown>
type MockPropRow = Record<string, unknown>

export interface MockState {
  blocks: Map<string, MockBlock>
  properties: Map<string, Map<string, MockPropRow>>
  blockTags: Map<string, Set<string>>
  /** Ordered op_log: each entry has at least `op_type` and a JSON `payload`. */
  opLog: ReadonlyArray<{ op_type: string; payload: string }>
}

// ---------------------------------------------------------------------------
// Normalized snapshot shape (mirror of the Rust `Snapshot`).
// ---------------------------------------------------------------------------

export interface NormalizedSnapshot {
  blocks: Array<Record<string, unknown>>
  properties: Array<Record<string, unknown>>
  block_tags: Array<Record<string, unknown>>
  page_links: Array<Record<string, unknown>>
  op_log_digest: { count: number; ops: Array<Record<string, unknown>> }
}

// The same `[[ULID]]` link regex the mock's `deriveLinkEdges` uses. The mock
// derives page links live from non-deleted block content; we replicate that
// here so the TS snapshot is symmetric with the backend's `block_links` table.
const LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g

/** Numeric sort key for a `Bn` canonical token (`B12` < `B2` would be wrong
 *  lexically). Pass-through (non-`Bn`) tokens sort after all `Bn` tokens. */
function tokenKey(token: string): [number, number, string] {
  const m = /^B(\d+)$/.exec(token)
  if (m) return [0, Number(m[1]), '']
  return [1, 0, token]
}

function cmpTokens(a: string, b: string): number {
  const [ap, an, as_] = tokenKey(a)
  const [bp, bn, bs] = tokenKey(b)
  if (ap !== bp) return ap - bp
  if (an !== bn) return an - bn
  return as_ < bs ? -1 : as_ > bs ? 1 : 0
}

/**
 * Build the canonical id → `Bn` token map from the ordered list of raw ids
 * (seed ids in seed order, then created ids in op order — computed by the
 * caller from the fixture seed + the mock op_log's create_block entries).
 */
export function canonicalLabelMap(canonicalOrder: ReadonlyArray<string>): Map<string, string> {
  const map = new Map<string, string>()
  canonicalOrder.forEach((id, i) => {
    map.set(id, `B${i + 1}`)
  })
  return map
}

/**
 * Canonicalize a raw mock op_log entry into a digest entry (or `null` to drop
 * it). Mirrors `RawOp::canonicalize` on the Rust side: auto-derived timestamp
 * property writes are dropped; reserved-key set_property ops collapse to their
 * `set_<key>` logical name. The mock already emits dedicated op_types
 * (`set_todo_state`, …) so most entries pass through unchanged.
 */
function canonicalizeOp(opType: string, key: string | null): Record<string, unknown> | null {
  if (opType === 'set_property' && (key === 'created_at' || key === 'completed_at')) {
    return null
  }
  if (
    opType === 'set_property' &&
    key != null &&
    (key === 'todo_state' || key === 'priority' || key === 'due_date' || key === 'scheduled_date')
  ) {
    return { op_type: `set_${key}` }
  }
  if (opType === 'set_property') {
    return key != null ? { op_type: 'set_property', key } : { op_type: 'set_property' }
  }
  return { op_type: opType }
}

/**
 * Derive the `value_type` + `value` for a property row from whichever typed
 * column is set. Ref values are relabeled. Mirrors `property_typed_value`.
 */
function propertyTypedValue(
  row: MockPropRow,
  relabel: (id: string) => string,
): { value_type: string | null; value: unknown } {
  const text = row['value_text'] as string | null | undefined
  const num = row['value_num'] as number | null | undefined
  const date = row['value_date'] as string | null | undefined
  const ref = row['value_ref'] as string | null | undefined
  const bool = row['value_bool'] as number | boolean | null | undefined
  if (text != null) return { value_type: 'Text', value: text }
  if (num != null) return { value_type: 'Num', value: num }
  if (date != null) return { value_type: 'Date', value: date }
  if (ref != null) return { value_type: 'Ref', value: relabel(ref) }
  if (bool != null) return { value_type: 'Bool', value: bool === true || bool === 1 }
  return { value_type: null, value: null }
}

/**
 * Build the full normalized snapshot from the live mock state. `canonicalOrder`
 * supplies the relabel order (identical computation to the Rust runner).
 */
export function buildSnapshot(
  state: MockState,
  canonicalOrder: ReadonlyArray<string>,
): NormalizedSnapshot {
  const map = canonicalLabelMap(canonicalOrder)
  const relabel = (id: string): string => map.get(id) ?? id
  const relabelOpt = (id: string | null | undefined): string | null =>
    id == null ? null : relabel(id)

  // Blocks — sorted by canonical id.
  const blocks = [...state.blocks.values()]
    .map((b) => ({
      id: relabel(b['id'] as string),
      block_type: b['block_type'] as string,
      content: (b['content'] as string | null | undefined) ?? null,
      parent_id: relabelOpt(b['parent_id'] as string | null | undefined),
      page_id: relabelOpt(b['page_id'] as string | null | undefined),
      position: (b['position'] as number | null | undefined) ?? null,
      deleted_at: b['deleted_at'] == null ? null : 'DELETED',
      todo_state: (b['todo_state'] as string | null | undefined) ?? null,
      priority: (b['priority'] as string | null | undefined) ?? null,
      due_date: (b['due_date'] as string | null | undefined) ?? null,
      scheduled_date: (b['scheduled_date'] as string | null | undefined) ?? null,
    }))
    .sort((a, b) => cmpTokens(a.id, b.id))

  // Properties — block_properties projection. Exclude auto-derived timestamp
  // keys (created_at/completed_at) to match the Rust side.
  const propertyRows: Array<Record<string, unknown>> = []
  for (const [blockId, keyMap] of state.properties.entries()) {
    for (const [key, row] of keyMap.entries()) {
      if (key === 'created_at' || key === 'completed_at') continue
      // The mock stamps a `space` ref property on pages; the backend keeps
      // `space` in the column-backed `blocks.space_id` (NOT block_properties),
      // so it never appears in the snapshot's `properties`. Skip it here too.
      if (key === 'space') continue
      const { value_type, value } = propertyTypedValue(row, relabel)
      propertyRows.push({
        block_id: relabel(blockId),
        key,
        value_type,
        value,
      })
    }
  }
  const properties = propertyRows.sort((a, b) => {
    const c = cmpTokens(a['block_id'] as string, b['block_id'] as string)
    if (c !== 0) return c
    const ak = a['key'] as string
    const bk = b['key'] as string
    return ak < bk ? -1 : ak > bk ? 1 : 0
  })

  // Block tags — sorted by (block_id, tag_id).
  const tagRows: Array<Record<string, unknown>> = []
  for (const [blockId, tagSet] of state.blockTags.entries()) {
    for (const tagId of tagSet) {
      tagRows.push({ block_id: relabel(blockId), tag_id: relabel(tagId) })
    }
  }
  const block_tags = tagRows.sort((a, b) => {
    const c = cmpTokens(a['block_id'] as string, b['block_id'] as string)
    if (c !== 0) return c
    return cmpTokens(a['tag_id'] as string, b['tag_id'] as string)
  })

  // Page links — derive [[ULID]] edges from non-deleted block content, mirror
  // of the backend's `block_links` table joined to the source's page_id. The
  // target must reference a live block (mirrors the backend's EXISTS guard).
  const liveIds = new Set(
    [...state.blocks.values()].filter((b) => b['deleted_at'] == null).map((b) => b['id'] as string),
  )
  const linkRows: Array<Record<string, unknown>> = []
  for (const b of state.blocks.values()) {
    if (b['deleted_at'] != null) continue
    const content = (b['content'] as string | null) ?? ''
    if (!content.includes('[[')) continue
    const sourceId = b['id'] as string
    const sourcePageId = (b['page_id'] as string | null) ?? null
    LINK_RE.lastIndex = 0
    for (const m of content.matchAll(LINK_RE)) {
      const targetId = m[1] as string
      if (!liveIds.has(targetId)) continue
      linkRows.push({
        source_id: relabel(sourceId),
        target_id: relabel(targetId),
        source_page_id: relabelOpt(sourcePageId),
      })
    }
  }
  const page_links = linkRows.sort((a, b) => {
    let c = cmpTokens(a['source_id'] as string, b['source_id'] as string)
    if (c !== 0) return c
    c = cmpTokens(a['target_id'] as string, b['target_id'] as string)
    if (c !== 0) return c
    return cmpTokens(
      (a['source_page_id'] as string | null) ?? '',
      (b['source_page_id'] as string | null) ?? '',
    )
  })

  // Op log digest — ordered (the mock appends in op order), filtered/canonicalized.
  const ops: Array<Record<string, unknown>> = []
  for (const entry of state.opLog) {
    let key: string | null = null
    try {
      const payload = JSON.parse(entry.payload) as Record<string, unknown>
      key = (payload['key'] as string | undefined) ?? null
    } catch {
      key = null
    }
    const digest = canonicalizeOp(entry.op_type, key)
    if (digest != null) ops.push(digest)
  }
  const op_log_digest = { count: ops.length, ops }

  return { blocks, properties, block_tags, page_links, op_log_digest }
}
