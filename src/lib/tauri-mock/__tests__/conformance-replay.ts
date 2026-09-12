/**
 * #763 / #4669 — the mock half of the conformance replay, as a module instead
 * of private helpers inside `conformance.test.ts`.
 *
 * Two drivers share this ONE replay path:
 *
 *   * `conformance.test.ts` replays every committed `conformance/fixtures/*.json`
 *     and asserts the snapshot equals the backend-authored `expected`.
 *   * `conformance-fuzz-bridge.ts` (#4669) answers the Rust differential-fuzz
 *     lane, which generates an op chain, renders it as a fixture, replays it
 *     against the REAL backend, and asks this module for the mock's snapshot of
 *     the same chain.
 *
 * A second copy of the seed loader or the arg expander would be a second
 * implementation of the thing conformance differences — the failure mode
 * `src/__tests__/AGENTS.md` § "Testing invariants" names. One replay path, two
 * drivers.
 */

import {
  type CommandOpStep,
  type CommandRecord,
  runCommandOp,
} from '@/lib/tauri-mock/__tests__/conformance-command'
import {
  type QueryResult,
  type QueryStep,
  relabelToken,
  stampMockSpace,
} from '@/lib/tauri-mock/__tests__/conformance-query'
import {
  buildSnapshot,
  canonicalLabelMap,
  type MockState,
  type NormalizedSnapshot,
} from '@/lib/tauri-mock/__tests__/conformance-snapshot'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  appSettings,
  attachments,
  blocks,
  blockTags,
  linkMetadata,
  makeBlock,
  opLog,
  pageAliases,
  peerRefs,
  properties,
  propertyDefs,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

export interface Fixture {
  name: string
  seed: {
    blocks: Array<Record<string, unknown>>
    properties: Array<Record<string, unknown>>
    tags: Array<Record<string, unknown>>
    /**
     * #3830 — the property-definition registry, when the fixture pins it. A
     * fixture that declares it declares the WHOLE registry: the Rust twin
     * clears the migration-seeded builtins first, because this map starts
     * empty (`clearMock`) and the two stacks must begin in the same state.
     */
    property_defs?: Array<Record<string, unknown>>
    /**
     * #3830 — attachment metadata rows, when the fixture pins the attachment
     * readers. Copied verbatim into the mock's `attachments` map; the Rust
     * twin inserts the same columns into the `attachments` table. The bytes
     * and the blob store are not seeded on either stack.
     */
    attachments?: Array<Record<string, unknown>>
    /**
     * #3830 — link metadata cache rows, when the fixture pins
     * `get_link_metadata`. Copied verbatim into the mock's `linkMetadata` map;
     * the Rust twin inserts the same columns into the `link_metadata` table.
     */
    link_metadata?: Array<Record<string, unknown>>
    /**
     * #3830 — device-local `app_settings` rows, when the fixture pins
     * `get_reminder_settings`. Copied verbatim into the mock's `appSettings`
     * map; the Rust twin inserts the same `(key, value)` pairs into the
     * `app_settings` table.
     */
    app_settings?: Array<Record<string, unknown>>
    /**
     * #3830 — peer registry rows, when the fixture pins `list_peer_refs`.
     * Copied verbatim into the mock's `peerRefs` map; the Rust twin inserts
     * the same thirteen columns into the `peer_refs` table.
     */
    peer_refs?: Array<Record<string, unknown>>
    /**
     * #3830 — page-alias rows, when the fixture pins the three alias readers.
     * `page_id` is a seed label; each `alias` is appended, in fixture order,
     * to that page's list in the mock's `pageAliases` map; the Rust twin
     * inserts the same `(page_id, alias)` pairs into the `page_aliases` table.
     */
    page_aliases?: Array<{ page_id: string; alias: string }>
  }
  ops: CommandOpStep[]
  expected: Record<string, unknown> | null
  /** #3347 — optional post-op READ steps (see `./conformance-query`). */
  queries?: QueryStep[]
  /** Backend-authored projection of each `queries` step. */
  expected_queries?: QueryResult[]
  /** #4670 — backend-authored record of each `via: "command"` op (see `./conformance-command`). */
  expected_ops?: CommandRecord[]
}

/**
 * Expand a stable seed label (`S1`, `S2`, …) to its 26-char block id — `label`
 * right-justified in 26 `'0'` chars. IDENTICAL to the Rust runner's
 * `seed_label_to_id`. Pages/blocks referenced in op args and `[[id]]` link
 * tokens must use the expanded form.
 */
export function seedLabelToId(label: string): string {
  if (label.length >= 26) return label
  return label.padStart(26, '0')
}

/**
 * #4669 — the ids of blocks CREATED by the ops replayed so far, in op order,
 * read from the mock op_log's `create_block` entries. This is the mock twin of
 * the Rust runner's `read_created_block_ids_in_op_order`, and it is what makes
 * a `Cn` op-arg label resolvable (see `expandOpArgs`).
 */
export function createdBlockIdsInOpOrder(): string[] {
  const out: string[] = []
  for (const entry of opLog) {
    if (entry.op_type !== 'create_block') continue
    let id: unknown
    try {
      id = (JSON.parse(entry.payload) as Record<string, unknown>)['block_id']
    } catch {
      continue // malformed payload: no create id to contribute
    }
    if (typeof id === 'string' && !out.includes(id)) out.push(id)
  }
  return out
}

/** Clear every mock store back to empty (no canonical browser-preview seed). */
export function clearMock(): void {
  seedBlocks() // resets counters + opLog + reseeds; we then wipe the canonical seed
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0
}

/** Walk `row`'s `parent_id` chain to the root page; the page root's id is the
 *  `page_id`. Cycle-guarded. Returns `null` when no page ancestor exists. */
function resolveRootPageId(row: Record<string, unknown>): string | null {
  let cursor: string | null = (row['parent_id'] as string | null) ?? null
  const guard = new Set<string>()
  while (cursor != null && !guard.has(cursor)) {
    guard.add(cursor)
    const parent = blocks.get(cursor)
    if (!parent) break
    if (parent['block_type'] === 'page') return parent['id'] as string
    cursor = (parent['parent_id'] as string | null) ?? null
  }
  return null
}

/** Insert one seed block into the `blocks` store. */
function loadSeedBlock(b: Record<string, unknown>): void {
  const id = seedLabelToId(b['id'] as string)
  const parentId = b['parent_id'] == null ? null : seedLabelToId(b['parent_id'] as string)
  blocks.set(
    id,
    makeBlock(
      id,
      b['block_type'] as string,
      (b['content'] as string | null) ?? null,
      parentId,
      (b['position'] as number | null) ?? 0,
    ),
  )
}

/** Insert one seed property bundle into the `properties` store. */
function loadSeedProperty(p: Record<string, unknown>): void {
  const blockId = seedLabelToId(p['block_id'] as string)
  const key = p['key'] as string
  const v = (p['value'] as Record<string, unknown>) ?? {}
  if (!properties.has(blockId)) properties.set(blockId, new Map())
  properties.get(blockId)?.set(key, {
    key,
    value_text: (v['value_text'] as string | null) ?? null,
    value_num: (v['value_num'] as number | null) ?? null,
    value_date: (v['value_date'] as string | null) ?? null,
    value_ref: v['value_ref'] == null ? null : seedLabelToId(v['value_ref'] as string),
    value_bool: v['value_bool'] == null ? null : (v['value_bool'] as boolean) ? 1 : 0,
  })
}

/**
 * The thirteen `peer_refs` columns the Rust seed binds, in `list_peer_refs`'s
 * SELECT order; every nullable one defaults to `null` when the fixture omits it.
 */
const PEER_REF_SEED_COLUMNS = [
  'peer_id',
  'last_hash',
  'last_sent_hash',
  'synced_at',
  'streamed_at',
  'reset_count',
  'last_reset_at',
  'cert_hash',
  'device_name',
  'remote_device_name',
  'last_address',
  'endpoint_id',
  'unpaired_by_peer_at_ms',
] as const

/** Load a fixture's seed state into the mock, mirroring the backend's raw insert. */
export function loadSeed(fixture: Fixture): void {
  for (const b of fixture.seed.blocks) {
    loadSeedBlock(b)
  }
  // #1775: `makeBlock` stamps a non-page block's `page_id` with its IMMEDIATE
  // parent, but the backend's `page_id` is the ROOT page of the parent chain.
  // Resolve every seeded block's `page_id` to its root page so nested-subtree
  // fixtures match the backend-authored snapshot (the move handler already does
  // this for moved subtrees via `refreshDescendantPageIds`; the seed loader did
  // not, so a never-moved nested block kept a stale immediate-parent page_id).
  for (const b of fixture.seed.blocks) {
    const id = seedLabelToId(b['id'] as string)
    const row = blocks.get(id)
    if (!row) continue
    row['page_id'] = row['block_type'] === 'page' ? id : resolveRootPageId(row)
  }
  for (const d of fixture.seed.property_defs ?? []) {
    propertyDefs.set(d['key'] as string, {
      key: d['key'],
      value_type: d['value_type'],
      options: d['options'] ?? null,
      // The backend stamps `now_rfc3339()`; a wall clock is never comparable,
      // so no token carries it (`PROPERTY_DEF_TOKEN`).
      created_at: new Date().toISOString(),
    })
  }
  for (const a of fixture.seed.attachments ?? []) {
    // The eight `attachments` columns the Rust seed binds, in the same order.
    attachments.set(a['id'] as string, {
      id: a['id'],
      block_id: seedLabelToId(a['block_id'] as string),
      mime_type: a['mime_type'],
      filename: a['filename'],
      size_bytes: a['size_bytes'],
      fs_path: a['fs_path'],
      created_at: a['created_at'],
      content_hash: a['content_hash'] ?? null,
    })
  }
  for (const m of fixture.seed.link_metadata ?? []) {
    // The seven `link_metadata` columns the Rust seed binds, in the same
    // order. The flags stay booleans: the backend struct has `bool` fields, so
    // both stacks serialize `true` / `false` and the tokens agree.
    linkMetadata.set(m['url'] as string, {
      url: m['url'],
      title: m['title'] ?? null,
      favicon_url: m['favicon_url'] ?? null,
      description: m['description'] ?? null,
      fetched_at: m['fetched_at'],
      auth_required: m['auth_required'],
      not_found: m['not_found'],
    })
  }
  for (const s of fixture.seed.app_settings ?? []) {
    appSettings.set(s['key'] as string, s['value'] as string)
  }
  for (const p of fixture.seed.peer_refs ?? []) {
    const row: Record<string, unknown> = {}
    for (const col of PEER_REF_SEED_COLUMNS) row[col] = p[col] ?? null
    peerRefs.set(p['peer_id'] as string, row)
  }
  for (const r of fixture.seed.page_aliases ?? []) {
    const pageId = seedLabelToId(r.page_id)
    pageAliases.set(pageId, [...(pageAliases.get(pageId) ?? []), r.alias])
  }
  for (const p of fixture.seed.properties) {
    loadSeedProperty(p)
  }
  for (const t of fixture.seed.tags) {
    const blockId = seedLabelToId(t['block_id'] as string)
    const tagId = seedLabelToId(t['tag_id'] as string)
    if (!blockTags.has(blockId)) blockTags.set(blockId, new Set())
    blockTags.get(blockId)?.add(tagId)
  }
}

/**
 * Resolve one id-shaped op arg.
 *
 * `Sn` (and any label under 26 chars) expands to the seed id. `Cn` (#4669) is
 * the id of the **n-th block the ops created so far**, 1-based, read from the
 * op log — the only way a fixture can name a block that did not exist when it
 * was authored, because BOTH runners mint their own ULID for a `create_block`
 * and reconcile through the canonical relabel. Without it a generated chain
 * could create blocks but never edit, move, tag or delete one.
 *
 * Fails CLOSED: an out-of-range `Cn` throws rather than falling through to the
 * seed expansion, which would silently address a block that does not exist.
 */
function resolveOpArgId(label: string, createdIds: readonly string[]): string {
  // `\d{1,6}` (not `\d+`): a literal 26-char ULID may begin with `C` followed
  // by digits, and must pass through to `seedLabelToId` untouched.
  const m = /^C(\d{1,6})$/.exec(label)
  if (!m) return seedLabelToId(label)
  const n = Number(m[1])
  const id = n >= 1 ? createdIds[n - 1] : undefined
  if (id == null) {
    throw new Error(
      `conformance op arg '${label}' names the ${n}th op-created block, but only ` +
        `${createdIds.length} have been created at this point in the op list`,
    )
  }
  return id
}

/**
 * Rewrite an op's args for the mock: labels referenced by id-shaped arg keys
 * are resolved (`S1` → its 26-char seed id, `C1` → the first op-created block).
 * `value_ref` inside a `set_property` value bundle is resolved too.
 */
export function expandOpArgs(
  args: Record<string, unknown>,
  createdIds: readonly string[] = [],
): Record<string, unknown> {
  const out = { ...args }
  for (const key of ['blockId', 'parentId', 'newParentId', 'tagId']) {
    if (typeof out[key] === 'string') out[key] = resolveOpArgId(out[key] as string, createdIds)
  }
  if (out['value'] != null && typeof out['value'] === 'object') {
    const v = { ...(out['value'] as Record<string, unknown>) }
    if (typeof v['value_ref'] === 'string') {
      v['value_ref'] = resolveOpArgId(v['value_ref'] as string, createdIds)
    }
    out['value'] = v
  }
  return out
}

/** Build the canonical relabel order: seed ids (seed order) then created ids
 *  (op order, from the mock op_log's create_block entries). Mirrors the Rust
 *  runner's order computation exactly. */
export function canonicalOrder(fixture: Fixture): string[] {
  const order: string[] = []
  for (const b of fixture.seed.blocks) {
    order.push(seedLabelToId(b['id'] as string))
  }
  for (const id of createdBlockIdsInOpOrder()) {
    if (!order.includes(id)) order.push(id)
  }
  return order
}

/**
 * Replay `fixture.ops` against the loaded mock. A `via: "command"` op (#4670)
 * is recorded — raw ids, relabelled by the caller — and its declared refusal
 * is caught there rather than crashing the replay; every other op dispatches
 * as before. Mirror of the op loop in the Rust `replay_fixture`.
 */
function replayOps(fixture: Fixture): CommandRecord[] {
  const records: CommandRecord[] = []
  const names = new Set<string>()
  for (const op of fixture.ops) {
    const args = expandOpArgs(op.args, createdBlockIdsInOpOrder())
    if (op.via == null) {
      dispatch(op.command, args)
      continue
    }
    if (op.via !== 'command') {
      throw new Error(
        `fixture '${fixture.name}': op '${op.command}' has \`via\`: ${JSON.stringify(op.via)}; ` +
          `the only value is "command"`,
      )
    }
    const record = runCommandOp(op, args, fixture.name)
    if (names.has(record.name)) {
      throw new Error(
        `fixture '${fixture.name}' has duplicate command op name '${record.name}' — every ` +
          `\`via: "command"\` op's \`name\` must be unique, or a failure cannot be attributed ` +
          `to the right op.`,
      )
    }
    names.add(record.name)
    records.push(record)
  }
  return records
}

/**
 * Reset the mock, load `fixture`'s seed, replay its ops, and return the
 * normalized snapshot — the SAME shape the Rust runner authors as `expected`.
 */
export function replayFixture(fixture: Fixture): NormalizedSnapshot {
  clearMock()
  loadSeed(fixture)
  replayOps(fixture)
  const state: MockState = { blocks, properties, blockTags, opLog }
  return buildSnapshot(state, canonicalOrder(fixture))
}

/**
 * The replay the QUERY and COMMAND legs run over: seed, then the mirror image
 * of the Rust runner's two `assign_all_to_test_space` calls around the ops —
 * the backend replays every op with space membership already resolved, and the
 * second stamp catches pages the ops created. Returns the relabelled
 * `expected_ops` records, which the command leg asserts and the query leg
 * ignores.
 *
 * The snapshot leg ({@link replayFixture}) does NOT stamp, so a space-scoped
 * guard in the mock (`ownerSpaceOf`) silently no-ops there; a command whose
 * refusal depends on the space must ride this replay.
 */
export function replayFixtureInSpace(fixture: Fixture): CommandRecord[] {
  clearMock()
  loadSeed(fixture)
  stampMockSpace()
  const records = replayOps(fixture)
  stampMockSpace()
  const labels = canonicalLabelMap(canonicalOrder(fixture))
  for (const r of records) r.returns = r.returns.map((t) => relabelToken(t, labels))
  return records
}
