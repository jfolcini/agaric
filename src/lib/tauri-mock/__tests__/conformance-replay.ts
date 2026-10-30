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
  labelCreatedIds,
  runCommandOp,
} from '@/lib/tauri-mock/__tests__/conformance-command'
import {
  CONFORMANCE_SPACE_ID,
  createdBlockIdsInOpOrder,
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
  keptLinkKinds,
  linkMetadata,
  makeBlock,
  opLog,
  pageAliases,
  peerRefs,
  properties,
  propertyDefs,
  pushOp,
  seedBlocks,
  spacePropertyDefs,
  unresolvedLinks,
} from '@/lib/tauri-mock/seed'

export interface Fixture {
  name: string
  seed: {
    blocks: Array<Record<string, unknown>>
    properties: Array<Record<string, unknown>>
    tags: Array<Record<string, unknown>>
    /**
     * #3830 — the property-definition registry, when the fixture pins it. A
     * fixture that declares it declares the WHOLE set of user rows: the Rust
     * twin clears the migrations' seeded rows first, because this map starts
     * empty (`clearMock`) and the two stacks must begin in the same state. The
     * built-ins (#5841) are constants on both stacks.
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
  // #5057 — a seeded PROPERTY is not a raw insert on the backend: its seed
  // loader calls `set_property_inner`, the real command, which appends an op.
  // Seeded BLOCKS are inserted raw and append nothing, which is why the two
  // halves of this loader differ. Without this the mock starts every fixture
  // that seeds a property one op behind, and `property_def_writes` is the
  // first fixture that ever did.
  pushOp('set_property', { block_id: blockId, key, from_value: null })
}

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
    // A root that is not a page owns itself, as the Rust stamp's
    // `SET page_id = id WHERE page_id IS NULL` leaves it.
    row['page_id'] =
      row['block_type'] === 'page' || row['parent_id'] == null ? id : resolveRootPageId(row)
  }
  // The harness space's definitions (#5841), as the Rust seed declares them.
  for (const d of fixture.seed.property_defs ?? []) {
    spacePropertyDefs(CONFORMANCE_SPACE_ID).set(d['key'] as string, {
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
    // Copied verbatim: `PEER_REF_TOKEN.attrKeys` is what selects the columns,
    // and `attrValue` renders an absent one exactly as it renders an explicit
    // null, so a third copy of the peer column list would buy nothing.
    peerRefs.set(p['peer_id'] as string, { ...p })
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
    // The backend's seed loader tags through `add_tag_inner`, the real command,
    // which appends an op. Writing `blockTags` alone left the digest one op
    // short per seeded tag — the same gap the property half above had. No
    // fixture seeds tags today, so this is latent rather than red, and the
    // first one that did would have inherited a confusing digest diff.
    pushOp('add_tag', { block_id: blockId, tag_id: tagId })
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

/** A link token whose id is a label: `[[Cn]]`, `((Cn))` or `#[Cn]`, and the
 *  same with `Sn`. Rust twin: `CONTENT_LABEL_RE` in `conformance.rs`. */
const CONTENT_LABEL = /\[\[([CS]\d{1,6})\]\]|\(\(([CS]\d{1,6})\)\)|#\[([CS]\d{1,6})\]/g

/**
 * Resolve the labels inside the link tokens of a `content` or `toText` arg
 * (#6054), so a fixture's text can link, reference or tag-reference a block an
 * earlier op created: `see [[C3]]` reaches the command as `see [[<id of C3>]]`.
 *
 * The grammar is the three token forms the backend scans (`[[id]]`, `((id))`,
 * `#[id]`) with a `Cn` or `Sn` label in the id's place; each label resolves as
 * an id-shaped arg does ({@link resolveOpArgId}), and every other text passes
 * through untouched, a literal 26-char id included. `labelCreatedIds` is the
 * inverse the projections apply, so a stored text reads back as written.
 *
 * Rust twin: `expand_content_labels` in `conformance.rs`.
 */
export function expandContentLabels(text: string, createdIds: readonly string[]): string {
  return text.replace(CONTENT_LABEL, (token, ...groups: unknown[]) => {
    const label = groups.slice(0, 3).find((g) => typeof g === 'string') as string
    return token.replace(label, resolveOpArgId(label, createdIds))
  })
}

/** Every op this fixture has appended, in `seq` order — what an `On` label
 *  resolves against. Local rows only, mirroring `read_op_refs_in_op_order`;
 *  the mock has no replicated rows, so the filter is the device id alone. */
function opRefsInOpOrder(): Array<{ device_id: string; seq: number }> {
  return opLog.map((entry) => ({ device_id: entry.device_id, seq: entry.seq }))
}

/**
 * Resolve an `On` fixture op arg into the op-log coordinate it names.
 *
 * `On` (#5057) is the **n-th op the fixture has appended so far**, 1-based —
 * the `OpRef` analogue of `Cn`, and for the same reason. An `OpRef` is
 * `(device_id, seq)` and the two runners' device ids differ, so a fixture
 * cannot spell one literally.
 *
 * Fails CLOSED: an out-of-range `On` throws, because a silently wrong ref
 * would undo the wrong op and still look like a pass.
 *
 * Rust twin: `resolve_op_ref_label` in `conformance.rs`.
 */
function resolveOpRefLabel(label: string): { device_id: string; seq: number } {
  const m = /^O(\d{1,6})$/.exec(label)
  if (!m) {
    throw new Error(
      `conformance op ref '${label}' is not an \`On\` label; an OpRef arg cannot be spelled ` +
        `literally, because the two runners' device ids differ`,
    )
  }
  const refs = opRefsInOpOrder()
  const n = Number(m[1])
  const ref = n >= 1 ? refs[n - 1] : undefined
  if (ref == null) {
    throw new Error(
      `conformance op ref '${label}' names the ${n}th op this fixture appended, but only ` +
        `${refs.length} have been appended at this point in the op list`,
    )
  }
  return ref
}

/**
 * Rewrite an op's args for the mock: labels referenced by id-shaped arg keys
 * are resolved (`S1` → its 26-char seed id, `C1` → the first op-created block).
 * `value_ref` inside a `set_property` value bundle is resolved too, and so are
 * the link-token labels inside `content` and `toText` ({@link expandContentLabels}).
 */
export function expandOpArgs(
  args: Record<string, unknown>,
  createdIds: readonly string[] = [],
): Record<string, unknown> {
  const out = { ...args }
  // #5057 — `spaceId` joined the list with the spaces cluster. The Rust runner
  // expands it (`arg_label_id("spaceId")`), so leaving it out here handed the
  // mock a raw `C1`: the page was still created, under a space id nothing
  // matched, and only its sibling RANK gave the mismatch away.
  for (const key of [
    'blockId',
    'anchorBlockId',
    'parentId',
    'newParentId',
    'tagId',
    'pageId',
    'spaceId',
  ]) {
    if (typeof out[key] === 'string') out[key] = resolveOpArgId(out[key] as string, createdIds)
  }
  for (const key of ['content', 'toText']) {
    if (typeof out[key] === 'string') out[key] = expandContentLabels(out[key], createdIds)
  }
  // `$SPACE` names the harness space, as inside a `scope` below. Mirror of the
  // Rust runner's `arg_label_id`.
  if (args['spaceId'] === '$SPACE') out['spaceId'] = CONFORMANCE_SPACE_ID
  // #5236 — `create_block` takes its space as the wire's `scope` object; the
  // `space_id` inside is a label like `spaceId`, or `$SPACE` for the harness
  // space. Mirror of the Rust runner's `scope()`.
  const scope = out['scope']
  if (scope != null && typeof scope === 'object') {
    const spaceId = (scope as Record<string, unknown>)['space_id']
    if (typeof spaceId === 'string') {
      out['scope'] = {
        ...scope,
        space_id: spaceId === '$SPACE' ? CONFORMANCE_SPACE_ID : resolveOpArgId(spaceId, createdIds),
      }
    }
  }
  // #5057 — a batch command takes the SAME labels as a list, so each entry
  // expands exactly as the scalar keys above do. Mirror of the Rust runner's
  // `block_ids()`; without it the mock is handed raw labels, matches no block,
  // and every batch op silently degenerates into a no-op that still "passes"
  // its own guards.
  // #5057 — `create_blocks_batch` carries its labels inside a list of SPECS
  // rather than a list of ids, so `parentId` there expands exactly as the
  // scalar key of the same name does.
  if (Array.isArray(out['specs'])) {
    out['specs'] = out['specs'].map((spec) => {
      if (spec == null || typeof spec !== 'object') return spec
      const copy = { ...(spec as Record<string, unknown>) }
      if (typeof copy['parentId'] === 'string') {
        copy['parentId'] = resolveOpArgId(copy['parentId'], createdIds)
      }
      return copy
    })
  }
  if (Array.isArray(out['blockIds'])) {
    out['blockIds'] = out['blockIds'].map((label) =>
      typeof label === 'string' ? resolveOpArgId(label, createdIds) : label,
    )
  }
  // #5057 — an `OpRef` arg is an `On` label, never a literal.
  if (typeof out['opRef'] === 'string') out['opRef'] = resolveOpRefLabel(out['opRef'])
  // The list form, mirroring `blockIds`.
  if (Array.isArray(out['ops'])) {
    out['ops'] = out['ops'].map((label) =>
      typeof label === 'string' ? resolveOpRefLabel(label) : label,
    )
  }
  // The SPLIT form: two commands take the coordinate as two positional args.
  // The fixture spells one `On` label either way; the split happens here, so
  // the convention stays single across all five ref-addressed commands.
  for (const [label, device, seq] of [
    ['undoOp', 'undoDeviceId', 'undoSeq'],
    ['targetOp', 'targetDeviceId', 'targetSeq'],
  ] as const) {
    if (typeof out[label] !== 'string') continue
    const ref = resolveOpRefLabel(out[label])
    delete out[label]
    out[device] = ref.device_id
    out[seq] = ref.seq
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
    const createdIds = createdBlockIdsInOpOrder()
    const args = expandOpArgs(op.args, createdIds)
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
    const record = runCommandOp(op, args, fixture.name, createdIds)
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
  return replayFixtureWithRecords(fixture).snapshot
}

/**
 * {@link replayFixture}, plus the relabelled record of every `via: "command"`
 * op: what the #6054 differential fuzz compares against the backend's.
 */
export function replayFixtureWithRecords(fixture: Fixture): {
  snapshot: NormalizedSnapshot
  records: CommandRecord[]
} {
  clearMock()
  loadSeed(fixture)
  // The Rust runner stamps the seed into the test space before any op, so a
  // command that resolves names in the anchor's space (`paste_blocks`, #5160
  // N4) sees one; the stamp writes nothing the snapshot reads.
  stampMockSpace()
  const records = replayOps(fixture)
  const state: MockState = {
    blocks,
    properties,
    blockTags,
    opLog,
    unresolvedLinks,
    keptLinkKinds,
  }
  const order = canonicalOrder(fixture)
  const snapshot = buildSnapshot(state, order)
  const createdIds = createdBlockIdsInOpOrder()
  for (const b of snapshot.blocks) {
    if (typeof b['content'] === 'string') b['content'] = labelCreatedIds(b['content'], createdIds)
  }
  return { snapshot, records: relabelRecords(records, order) }
}

function relabelRecords(records: CommandRecord[], order: string[]): CommandRecord[] {
  const labels = canonicalLabelMap(order)
  return records.map((r) => ({ ...r, returns: r.returns.map((t) => relabelToken(t, labels)) }))
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
  return relabelRecords(records, canonicalOrder(fixture))
}
