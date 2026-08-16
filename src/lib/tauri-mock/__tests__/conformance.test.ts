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
  type NormalizedSnapshot,
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

// ---------------------------------------------------------------------------
// #3966 — the SNAPSHOT leg's vacuity guard
// ---------------------------------------------------------------------------

/**
 * The QUERY leg has had a vacuity guard since #3347: a step that records zero
 * rows must SAY so (`"expect_empty": true`), because `[] == []` passes having
 * compared nothing. The SNAPSHOT leg — every fixture, and the only assertion
 * the op-only fixtures carry — had no analogue. Nothing required a fixture's
 * `expected` to DIFFER from the state its seed alone produces, so a fixture
 * whose ops coincidentally leave the projection unchanged could be recorded by
 * `CONFORMANCE_UPDATE=1` and replayed forever, comparing two copies of the
 * seed and reading as coverage.
 *
 * The guard replays the seed ALONE and requires the recorded `expected` to
 * differ from it.
 *
 * ## Why `op_log_digest` is excluded, and why that is the whole point
 *
 * A naive "the snapshot changed" check compares the WHOLE snapshot, and every
 * fixture with at least one op passes it trivially: the op log grew, so
 * `op_log_digest.count` went from 0 to N. That check cannot fail for any
 * fixture the guard is meant to catch — it would be a second decorative unit
 * shipped by the batch that exists to delete decorative units. What must move
 * is the PROJECTED DOMAIN STATE (`blocks` / `properties` / `block_tags` /
 * `page_links`), which is what the mock and the backend are being differenced
 * on. So the comparison drops `op_log_digest` deliberately.
 *
 * ## Scope
 *
 * Applies to every fixture, not only the op-only ones. A fixture that carries
 * query steps is not exempt: its snapshot leg is a separate `it` asserting the
 * same thing, and an inert op list makes THAT assertion vacuous regardless of
 * how much its read leg proves.
 */
const SNAPSHOT_OPS_INERT: ReadonlyMap<string, string> = new Map<string, string>([
  // Fixtures whose ops legitimately leave the projected domain state
  // untouched, each with the reason.
  //
  // Empty today, but NOT because the sweep found nothing. The #3966 sweep over
  // all 40 fixtures found TWO offenders — `restore_block` (delete S2, restore
  // S2) and `delete_property_reserved_key_clears_column` (set `todo_state`,
  // delete `todo_state`) — both pure round trips whose recorded `expected`
  // equalled their seed-only snapshot, and both reproducible by a mock with
  // the handlers no-op'd. This map is empty because those two were REPAIRED
  // (each gained a second block the ops treat differently), not because the
  // tree was clean. Waiving them here would have been the cheaper option and
  // would have left two fixtures that pass without testing anything.
])

/**
 * Deep-compare two snapshot sections independently of key order. The mock
 * builds row objects in insertion order; the fixture JSON carries whatever
 * order `serde_json` wrote, so a plain `JSON.stringify` comparison would
 * report a difference that is not one.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b)),
        )
      : val,
  )
}

/** Every snapshot section EXCEPT `op_log_digest` — see the note above. */
function snapshotDomainOnly(
  snapshot: NormalizedSnapshot | Record<string, unknown>,
): Record<string, unknown> {
  const { op_log_digest: _opLogDigest, ...domain } = snapshot as Record<string, unknown>
  return domain
}

describe("#3966 every fixture's ops move the projected domain state", () => {
  beforeEach(() => {
    clearMock()
  })

  it('no fixture records an `expected` its seed alone already produces', () => {
    const inert: string[] = []
    const noOps: string[] = []
    for (const { fixture } of fixtures) {
      if (fixture.expected == null) continue // the per-fixture `it` above fails first
      if (SNAPSHOT_OPS_INERT.has(fixture.name)) continue
      if (fixture.ops.length === 0) {
        // A zero-op fixture is NOT inert, and saying so precisely matters more
        // than reddening on it. Its snapshot leg still differences the two SEED
        // LOADERS — `page_id` root resolution, position defaults, the reserved
        // columns — which is a real (if narrow) claim, and #1775 was exactly a
        // seed-loader divergence. What it cannot do is carry evidence about an
        // OP, so its evidence has to live in its query steps. A fixture with
        // neither ops nor queries asserts only that two seed loaders agree
        // about a state nothing then reads, which no `conformance/fixtures`
        // entry should be.
        if ((fixture.queries?.length ?? 0) === 0) noOps.push(fixture.name)
        continue
      }
      clearMock()
      loadSeed(fixture)
      // `canonicalOrder` reads created ids out of the op log, which is empty
      // here — so this is exactly the seed's own label vocabulary, and any
      // block the ops CREATE is missing from this snapshot, which is itself a
      // difference (correctly: a fixture that creates a block is not inert).
      const seedOnly = buildSnapshot(
        { blocks, properties, blockTags, opLog },
        canonicalOrder(fixture),
      )
      if (
        canonicalJson(snapshotDomainOnly(seedOnly)) ===
        canonicalJson(snapshotDomainOnly(fixture.expected))
      ) {
        inert.push(fixture.name)
      }
    }

    expect(
      inert,
      `These fixtures record an \`expected\` identical to the snapshot their SEED ` +
        `alone produces ${JSON.stringify(inert)} — every op in them left ` +
        `blocks/properties/block_tags/page_links exactly as seeded, so the ` +
        `mock-vs-backend assertion compares two copies of the seed and passes ` +
        `having exercised nothing. \`CONFORMANCE_UPDATE=1\` will happily record ` +
        `such a snapshot and the replay will confirm it forever. FIX by giving ` +
        `the fixture ops that actually change state, or — if the no-op IS the ` +
        `behaviour under test — declare it in SNAPSHOT_OPS_INERT with the ` +
        `reason.`,
    ).toEqual([])

    expect(
      noOps,
      `These fixtures declare neither ops nor query steps ${JSON.stringify(noOps)}. ` +
        `All they assert is that the two SEED LOADERS agree about a state nothing ` +
        `then mutates or reads. Give them ops, give them query steps, or delete them.`,
    ).toEqual([])
  })

  // The guard's own falsification, kept in-tree so its reach is not a claim.
  // `op_log_digest` is what a whole-snapshot comparison would key on, and it
  // moves for EVERY fixture with an op — so a guard that failed to drop it
  // could not fail at all. These pin that it is dropped, in both directions.
  it('ignores `op_log_digest` and consults every other section', () => {
    const seedOnly = { blocks: [{ id: 'B1' }], op_log_digest: { count: 0, ops: [] } }
    const recorded = { blocks: [{ id: 'B1' }], op_log_digest: { count: 3, ops: [{ x: 1 }] } }
    // A grown op log alone does NOT make a fixture non-inert.
    expect(canonicalJson(snapshotDomainOnly(seedOnly))).toBe(
      canonicalJson(snapshotDomainOnly(recorded)),
    )
    // A moved domain row DOES.
    const moved = {
      blocks: [{ id: 'B1', content: 'edited' }],
      op_log_digest: { count: 0, ops: [] },
    }
    expect(canonicalJson(snapshotDomainOnly(seedOnly))).not.toBe(
      canonicalJson(snapshotDomainOnly(moved)),
    )
    // Key order is not a difference (the fixture JSON and the mock disagree
    // about it routinely).
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })

  // Every entry in the escape hatch must name a fixture that exists, and must
  // carry a reason — the same two-way staleness contract the query-leg
  // allowlists carry. Without this an entry survives the fixture it waives.
  it('SNAPSHOT_OPS_INERT names only live fixtures, each with a reason', () => {
    const names = new Set(fixtures.map(({ fixture }) => fixture.name))
    const stale = [...SNAPSHOT_OPS_INERT.keys()].filter((n) => !names.has(n))
    expect(
      stale,
      `SNAPSHOT_OPS_INERT names fixtures that no longer exist ${JSON.stringify(stale)}.`,
    ).toEqual([])
    const unreasoned = [...SNAPSHOT_OPS_INERT.entries()]
      .filter(([, reason]) => !reason.trim())
      .map(([name]) => name)
    expect(
      unreasoned,
      `SNAPSHOT_OPS_INERT entries with a blank reason ${JSON.stringify(unreasoned)}. ` +
        `An escape hatch from a vacuity guard must cost a sentence.`,
    ).toEqual([])
  })
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

  // #3980 note 6 — the two twins must AGREE on a step with no usable `name`.
  // `QueryStep.name` is typed `string`, but the fixture is an unvalidated
  // `JSON.parse(...) as Fixture`, so this is reachable. Unchecked, `undefined`
  // flowed into the `Set` and this side reported a duplicate of `[null]` —
  // a name no step has — while the Rust twin dropped the step in silence.
  // TWO nameless steps, because that is the shape that fabricated the `[null]`
  // (one alone collided with nothing); plus a non-string `name`, the other half
  // of what the Rust `as_str()` rejects. The Rust twin runs the same three.
  it('rejects a step with no string name, as the Rust twin does', () => {
    const nameless = [
      { command: 'list_page_links', args: {} },
      { command: 'list_page_links', args: {} },
      { name: 7, command: 'list_page_links' },
    ] as unknown as QueryStep[]
    expect(() => assertUniqueStepNames(nameless)).toThrow(
      /query step\(s\) at index \[0,1,2\] with no string `name`/,
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
