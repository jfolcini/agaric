/**
 * Cross-impl conformance test for the tauri-mock's Pages Tag + HasProperty
 * filter primitives (#1908 slice 2, increment c).
 *
 * `metaRowMatchesFilter` (in `../handlers`) re-implements the backend's
 * per-primitive predicate matrix in TypeScript; `Tag` reads the module-level
 * `blockTags` map and `HasProperty` reads the `properties` map (both exported
 * from `../seed`). This test drives it from the SHARED golden fixture
 * `conformance/pages-metadata/tag-property.vectors.json`, which the Rust query
 * path asserts against too (driving the real `list_pages_with_metadata_inner`
 * with the same `FilterPrimitive` list). If backend filter semantics change,
 * the fixture is regenerated from the Rust side and this test fails until
 * `handlers.ts` is realigned — that is the whole point of the cross-impl gate.
 * See `conformance/pages-metadata/README.md`.
 *
 * Scope: `Tag` plus the HasProperty predicates the mock actually implements —
 * `Exists`, `NotExists`, `Eq`, `Ne` — for BOTH Text and Ref values, plus
 * AND-composition. The ordered/LIKE predicates (Lt/Gt/Lte/Gte/Contains/
 * StartsWith) are intentionally OUT of scope: `hasPropertyMatches` returns
 * `true` (default branch) for them, a known gap tracked by a separate #1908
 * follow-up.
 *
 * Unlike the pure-over-row increment (a), these primitives read GLOBAL mock
 * state (`blockTags` / `properties`), so each scenario seeds those maps
 * directly and a `beforeEach` clears them so scenarios don't leak. We do NOT
 * call `seedBlocks()` (it would re-seed canonical fixtures we don't want).
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { type PageMetaRow, metaRowMatchesFilter } from '../handlers'
import { blockTags, properties } from '../seed'

interface FixturePropValue {
  type: 'Text' | 'Ref'
  value: string
}

interface FixtureProp {
  key: string
  value: FixturePropValue
}

interface FixtureRow {
  id: string
  title: string
  tags: string[]
  properties: FixtureProp[]
}

interface Scenario {
  name: string
  filters: Record<string, unknown>[]
  expectedMatchingIds: string[]
}

interface Vectors {
  rows: FixtureRow[]
  scenarios: Scenario[]
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'pages-metadata',
  'tag-property.vectors.json',
)
const vectors = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Vectors

/**
 * Seed the global `blockTags` / `properties` maps from the fixture rows, the
 * exact state the mock's `Tag` / `HasProperty` evaluation reads. A Ref value
 * stores `{ value_ref }`, a Text value stores `{ value_text }` — mirroring the
 * backend's `block_properties` columns.
 */
function seedScenario(rows: FixtureRow[]): void {
  for (const row of rows) {
    blockTags.set(row.id, new Set(row.tags))
    properties.set(
      row.id,
      new Map(
        row.properties.map((p) => [
          p.key,
          p.value.type === 'Ref' ? { value_ref: p.value.value } : { value_text: p.value.value },
        ]),
      ),
    )
  }
}

/**
 * Build a full `PageMetaRow` from a fixture row. `Tag` / `HasProperty` consult
 * only `row.id` (the map key); the remaining fields are defaulted.
 */
function toMetaRow(row: FixtureRow): PageMetaRow {
  return {
    id: row.id,
    blockType: 'page',
    content: row.title,
    parentId: null,
    position: 0,
    deletedAt: null,
    todoState: null,
    priority: null,
    dueDate: null,
    scheduledDate: null,
    pageId: row.id,
    lastModifiedAt: null,
    inboundLinkCount: 0,
    childBlockCount: 0,
    hasOutboundLink: false,
    flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
  }
}

/** Sorted ids of the rows that satisfy EVERY primitive in the scenario (AND). */
function matchingIds(scenario: Scenario): string[] {
  return vectors.rows
    .filter((row) => {
      const meta = toMetaRow(row)
      return scenario.filters.every((f) => metaRowMatchesFilter(meta, f))
    })
    .map((row) => row.id)
    .toSorted()
}

describe('tag/property cross-impl conformance', () => {
  beforeEach(() => {
    blockTags.clear()
    properties.clear()
  })

  for (const scenario of vectors.scenarios) {
    it(scenario.name, () => {
      seedScenario(vectors.rows)
      expect(matchingIds(scenario)).toEqual(scenario.expectedMatchingIds.toSorted())
    })
  }
})
