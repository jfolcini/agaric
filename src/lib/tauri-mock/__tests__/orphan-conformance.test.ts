/**
 * Cross-impl conformance test for the tauri-mock's Pages `Orphan` filter
 * primitive (#1908 slice 2, increment b).
 *
 * `metaRowMatchesFilter` (in `../handlers`) re-implements the backend's
 * per-primitive predicate matrix in TypeScript. This test drives it from the
 * SHARED golden fixture `conformance/pages-metadata/orphan.vectors.json`,
 * which the Rust query path asserts against too (driving the real
 * `list_pages_with_metadata_inner` with the same `FilterPrimitive` list). If
 * backend filter semantics change, the fixture is regenerated from the Rust
 * side and this test fails until `handlers.ts` is realigned — that is the
 * whole point of the cross-impl gate. See
 * `conformance/pages-metadata/README.md`.
 *
 * Scope: the `Orphan` primitive — `r.inboundLinkCount === 0 && !r.hasOutboundLink`
 * — paired against the looser `HasNoInboundLinks` sibling, plus AND-composition.
 * The mock composes a filter list with AND (every primitive must match),
 * mirroring `compile_pages_filters`.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { type PageMetaRow, metaRowMatchesFilter } from '../handlers'

interface FixtureRow {
  id: string
  title: string
  inboundLinkCount: number
  hasOutboundLink: boolean
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
  'orphan.vectors.json',
)
const vectors = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Vectors

/**
 * Build a full `PageMetaRow` from a fixture row, defaulting the fields the
 * `Orphan` primitive does not read. `Orphan` only consults `inboundLinkCount`
 * and `hasOutboundLink`.
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
    inboundLinkCount: row.inboundLinkCount,
    childBlockCount: 0,
    hasOutboundLink: row.hasOutboundLink,
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

describe('orphan cross-impl conformance', () => {
  for (const scenario of vectors.scenarios) {
    it(scenario.name, () => {
      expect(matchingIds(scenario)).toEqual(scenario.expectedMatchingIds.toSorted())
    })
  }
})
