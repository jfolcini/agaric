/**
 * #763 — mock-vs-backend conformance harness (TS / tauri-mock side).
 *
 * The Rust backend authors the source-of-truth `expected` snapshot for each
 * shared fixture in `conformance/fixtures/*.json` (see the Rust runner at
 * `src-tauri/src/command_integration_tests/conformance.rs`, UPDATE mode). This
 * test replays the SAME seed + op sequence through the 3.5k-line tauri-mock,
 * builds the SAME normalized snapshot (`./conformance-snapshot`), and asserts
 * it equals the backend-authored `expected`.
 *
 * Behavioral drift between the mock and the real backend then fails CI. Per the
 * #763 drift policy: an obvious mock bug with a safe fix is fixed in
 * `handlers.ts`; a subtle divergence the mock cannot cheaply mirror is left as
 * a `.skip`'d fixture with a `// DRIFT(#763): …` comment for issue triage. The
 * backend is NEVER changed to match the mock.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '../handlers'
import { blocks, blockTags, makeBlock, opLog, properties, propertyDefs, seedBlocks } from '../seed'
import { buildSnapshot, type MockState } from './conformance-snapshot'

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

interface Fixture {
  name: string
  seed: {
    blocks: Array<Record<string, unknown>>
    properties: Array<Record<string, unknown>>
    tags: Array<Record<string, unknown>>
  }
  ops: Array<{ command: string; args: Record<string, unknown> }>
  expected: Record<string, unknown> | null
}

const FIXTURES_DIR = join(process.cwd(), 'conformance', 'fixtures')

function loadFixtures(): Array<{ path: string; fixture: Fixture }> {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const path = join(FIXTURES_DIR, f)
      return { path, fixture: JSON.parse(readFileSync(path, 'utf8')) as Fixture }
    })
}

/**
 * Expand a stable seed label (`S1`, `S2`, …) to its 26-char block id — `label`
 * right-justified in 26 `'0'` chars. IDENTICAL to the Rust runner's
 * `seed_label_to_id`. Pages/blocks referenced in op args and `[[id]]` link
 * tokens must use the expanded form.
 */
function seedLabelToId(label: string): string {
  if (label.length >= 26) return label
  return label.padStart(26, '0')
}

// ---------------------------------------------------------------------------
// Mock reset + seed
// ---------------------------------------------------------------------------

/** Clear every mock store back to empty (no canonical browser-preview seed). */
function clearMock(): void {
  seedBlocks() // resets counters + opLog + reseeds; we then wipe the canonical seed
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0
}

/** Load a fixture's seed state into the mock, mirroring the backend's raw insert. */
function loadSeed(fixture: Fixture): void {
  for (const b of fixture.seed.blocks) {
    const id = seedLabelToId(b['id'] as string)
    const parentId = b['parent_id'] == null ? null : seedLabelToId(b['parent_id'] as string)
    const row = makeBlock(
      id,
      b['block_type'] as string,
      (b['content'] as string | null) ?? null,
      parentId,
      (b['position'] as number | null) ?? 0,
    )
    blocks.set(id, row)
  }
  for (const p of fixture.seed.properties) {
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
  for (const t of fixture.seed.tags) {
    const blockId = seedLabelToId(t['block_id'] as string)
    const tagId = seedLabelToId(t['tag_id'] as string)
    if (!blockTags.has(blockId)) blockTags.set(blockId, new Set())
    blockTags.get(blockId)?.add(tagId)
  }
}

/**
 * Rewrite an op's args for the mock: seed labels (`S1`) referenced by id-shaped
 * arg keys are expanded to their 26-char form so they match the inserted block
 * ids. `value_ref` inside a `set_property` value bundle is expanded too.
 */
function expandOpArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args }
  for (const key of ['blockId', 'parentId', 'newParentId', 'tagId']) {
    if (typeof out[key] === 'string') out[key] = seedLabelToId(out[key] as string)
  }
  if (out['value'] != null && typeof out['value'] === 'object') {
    const v = { ...(out['value'] as Record<string, unknown>) }
    if (typeof v['value_ref'] === 'string') v['value_ref'] = seedLabelToId(v['value_ref'] as string)
    out['value'] = v
  }
  return out
}

/** Build the canonical relabel order: seed ids (seed order) then created ids
 *  (op order, from the mock op_log's create_block entries). Mirrors the Rust
 *  runner's order computation exactly. */
function canonicalOrder(fixture: Fixture): string[] {
  const order: string[] = []
  for (const b of fixture.seed.blocks) {
    order.push(seedLabelToId(b['id'] as string))
  }
  for (const entry of opLog) {
    if (entry.op_type !== 'create_block') continue
    try {
      const payload = JSON.parse(entry.payload) as Record<string, unknown>
      const id = payload['block_id'] as string | undefined
      if (id != null && !order.includes(id)) order.push(id)
    } catch {
      // ignore malformed payloads
    }
  }
  return order
}

// ---------------------------------------------------------------------------
// Tests — one per fixture
// ---------------------------------------------------------------------------

const fixtures = loadFixtures()

// Fixtures whose mock snapshot is a KNOWN, documented divergence from the
// backend-authored expected. The backend is the source of truth; these are
// fixtures where mirroring its behaviour in the mock is not a cheap/safe change
// — file an issue instead. Each entry must have a `// DRIFT(#763): …` note.
const DRIFT_SKIP = new Set<string>([
  // (empty) — #891 fixed the Rust runner to author `expected` from the
  // production ENGINE path (dense-reproject positions) instead of the SQL-only
  // fallback (gapped provisional positions). `position_reproject_drift` now
  // MATCHES the mock's dense renumber, so it is no longer skipped.
])

describe('tauri-mock ⇄ backend conformance (#763)', () => {
  beforeEach(() => {
    clearMock()
  })

  for (const { fixture } of fixtures) {
    const run = DRIFT_SKIP.has(fixture.name) ? it.skip : it
    run(`fixture '${fixture.name}' — mock reproduces the backend-authored snapshot`, () => {
      expect(
        fixture.expected,
        `fixture '${fixture.name}' has no \`expected\` — author it with CONFORMANCE_UPDATE=1 on the Rust side`,
      ).not.toBeNull()

      loadSeed(fixture)
      for (const op of fixture.ops) {
        dispatch(op.command, expandOpArgs(op.args))
      }

      const state: MockState = { blocks, properties, blockTags, opLog }
      const snapshot = buildSnapshot(state, canonicalOrder(fixture))

      expect(snapshot).toEqual(fixture.expected)
    })
  }
})
