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

import {
  assertUniqueStepNames,
  type QueryResult,
  type QueryStep,
  runQuerySteps,
  stampMockSpace,
} from '@/lib/tauri-mock/__tests__/conformance-query'
import {
  buildSnapshot,
  canonicalLabelMap,
  type MockState,
} from '@/lib/tauri-mock/__tests__/conformance-snapshot'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blocks,
  blockTags,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

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
  /** #3347 — optional post-op READ steps (see `./conformance-query`). */
  queries?: QueryStep[]
  /** Backend-authored projection of each `queries` step. */
  expected_queries?: QueryResult[]
}

const FIXTURES_DIR = join(process.cwd(), 'conformance', 'fixtures')

function loadFixtures(): Array<{ path: string; fixture: Fixture }> {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .toSorted()
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

/** Insert one seed block into the `blocks` store and return its expanded id. */
function loadSeedBlock(b: Record<string, unknown>): string {
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
  return id
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

/** Load a fixture's seed state into the mock, mirroring the backend's raw insert. */
function loadSeed(fixture: Fixture): void {
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
  // #891 fixed the Rust runner to author `expected` from the production ENGINE
  // path (dense-reproject positions) instead of the SQL-only fallback (gapped
  // provisional positions). `position_reproject_drift` now MATCHES the mock's
  // dense renumber, so it is no longer skipped.
  // #1775 RESOLVED: the mock's single-op `delete_block` / `restore_block`
  // handlers now mirror the backend's cascade — `delete_block` tombstones the
  // whole ACTIVE descendant subtree (`descendants_cte_active`) and
  // `restore_block` restores the SAME-COHORT contiguous chain
  // (`descendants_cte_cohort`, `deleted_at_ref`-keyed), preserving an
  // independently-deleted descendant. The `cascade_delete_subtree` and
  // `restore_after_cascade_independent_child` fixtures are therefore no longer
  // skipped and now assert mock == backend.
])

/**
 * Fixtures whose QUERY leg is a known divergence but whose SNAPSHOT leg agrees.
 *
 * Kept separate from {@link DRIFT_SKIP} deliberately. A read divergence says
 * nothing about the op replay behind it, and skipping a whole fixture for one
 * would darken assertions that PASS — the same "a skip that reads like
 * coverage" failure the `QUERY_STEPS_BACKEND_ONLY` guard in
 * `conformance-coverage.test.ts` exists to prevent. Every name here therefore
 * still asserts `mock == backend` on its snapshot; only its query steps are
 * unasserted. Each entry needs a `// DRIFT(#763): …` note naming the issue.
 *
 * ## Why the granularity is the FIXTURE and not the step
 *
 * A per-STEP skip set lived here briefly, to keep a diverging command from
 * darkening its passing siblings. It was removed because per-step skipping is
 * UNSOUND for the step shape this harness leans on hardest: a PAIR, where a
 * non-empty step and an `expect_empty` step are only meaningful TOGETHER.
 * `query_inherited_tags` is the case in point — its empty step pins that the
 * direct-tag reader does NOT answer the inherited tag, which proves something
 * only while the inherited reader is asserted to return that tag. Skip the
 * non-empty half and the survivor asserts `[] == []`: a mock whose
 * `list_tags_for_block` is a constant `() => []` passes it. The `expect_empty`
 * vacuity guard in `conformance-coverage.test.ts` cannot catch that, because
 * the step legitimately declared itself empty; the skip is what hollowed it.
 *
 * So: skipping any step of a pair must skip BOTH, and since a pair is the
 * normal shape here, the honest unit is the fixture. If per-step skipping is
 * ever reintroduced, it must name every step of the pair — and the guard that
 * decides which commands are differentially covered must count a step's
 * recorded ROWS, not merely its presence (see `QUERY_STEPS_BACKEND_ONLY`).
 */
const QUERY_DRIFT_SKIP = new Set<string>([
  // #3826 found four READ divergences and filed them rather than accommodating
  // them; #3870 / #3871 / #3872 / #3873 fixed all four in the MOCK, so this set
  // is now empty and every query fixture in the tree asserts mock == backend:
  //   - #3870 `list_blocks` honours `limit` + the `(position, id)` keyset
  //     cursor (`query_list_blocks_pagination`),
  //   - #3871 the mock derives `block_tag_inherited` (`query_inherited_tags`),
  //   - #3872 `get_batch_properties` omits a property-less block
  //     (`query_batch_properties_empty_entry`),
  //   - #3873 `list_tags_for_block` sorts by tag id, so
  //     `query_point_reads_tags`'s `tags_two_surviving_in_id_order` step is now
  //     an `"ordered": true` pin.
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

  // #3347 — the READ leg. The op replay is identical; what differs is that the
  // fixture then calls query commands and diffs their projected responses
  // against the SAME backend-authored recording. Kept as its own `it` per
  // fixture so a query divergence names the query, not the snapshot.
  for (const { fixture } of fixtures) {
    if (!fixture.queries || fixture.queries.length === 0) continue
    // A snapshot divergence invalidates the state the reads run over, so the
    // query leg skips for EITHER set.
    const run = DRIFT_SKIP.has(fixture.name) || QUERY_DRIFT_SKIP.has(fixture.name) ? it.skip : it
    run(
      `fixture '${fixture.name}' — mock reproduces the backend-authored query results`,
      async () => {
        expect(
          fixture.expected_queries,
          `fixture '${fixture.name}' declares \`queries\` but has no \`expected_queries\` — ` +
            `author it with CONFORMANCE_UPDATE=1 on the Rust side`,
        ).toBeDefined()

        loadSeed(fixture)
        // Mirror image of the Rust runner's `assign_all_to_test_space`, which
        // runs BOTH after the seed insert (so ops replay with space membership
        // already resolved) and again after the ops (to catch pages the ops
        // created). Stamping only once, at the end, would replay every op
        // against a space-less mock.
        stampMockSpace()
        for (const op of fixture.ops) {
          dispatch(op.command, expandOpArgs(op.args))
        }
        stampMockSpace()

        const labels = canonicalLabelMap(canonicalOrder(fixture))
        const actual = await runQuerySteps(fixture.queries ?? [], labels)

        expect(actual).toEqual(fixture.expected_queries)
      },
    )
  }
})

// #3833 items 7/12 — the duplicate-step-name guard's own test. `runQuerySteps`
// calls `assertUniqueStepNames` on every fixture, but no fixture has a
// duplicate, so without this the guard body never executes and the check is
// decoration. The Rust twin's copy of this property lives in
// `conformance_query.rs::step_name_uniqueness_tests`.
describe('#3833 query step names are unique within a fixture', () => {
  const step = (name: string): QueryStep => ({ name, command: 'list_page_links', args: {} })

  it('accepts distinct names', () => {
    expect(() => assertUniqueStepNames([step('a'), step('b'), step('c')])).not.toThrow()
    expect(() => assertUniqueStepNames([])).not.toThrow()
  })

  it('rejects a duplicate and names every offender once', () => {
    expect(() => assertUniqueStepNames([step('a'), step('b'), step('a')])).toThrow(
      /duplicate query step name\(s\) \["a"\]/,
    )
    // Three copies of one name report it once, not twice.
    expect(() => assertUniqueStepNames([step('a'), step('a'), step('a')])).toThrow(
      /duplicate query step name\(s\) \["a"\]/,
    )
    // Two distinct duplicated names are both reported.
    expect(() => assertUniqueStepNames([step('a'), step('b'), step('a'), step('b')])).toThrow(
      /duplicate query step name\(s\) \["a","b"\]/,
    )
  })

  // The CALL SITE, not just the body: a guard function that is tested in
  // isolation and never wired in is the half-covered pair this repo has
  // shipped before. `runQuerySteps` must reject before it replays anything.
  it('is enforced by runQuerySteps itself, before any step is replayed', async () => {
    await expect(runQuerySteps([step('dup'), step('dup')], new Map())).rejects.toThrow(
      /duplicate query step name\(s\) \["dup"\]/,
    )
  })
})
