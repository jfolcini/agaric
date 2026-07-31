/**
 * Cross-impl conformance test for the tauri-mock's Pages filter-primitive
 * evaluation (#1908 slice 2, increment a).
 *
 * `metaRowMatchesFilter` (in `../handlers`) re-implements the backend's
 * per-primitive predicate matrix in TypeScript. This test drives it from the
 * SHARED golden fixture `conformance/pages-metadata/filters.vectors.json`,
 * which the Rust query path asserts against too (driving the real
 * `list_pages_with_metadata_inner` with the same `FilterPrimitive` list). If
 * backend filter semantics change, the fixture is regenerated from the Rust
 * side and this test fails until `handlers.ts` is realigned — that is the
 * whole point of the cross-impl gate. See
 * `conformance/pages-metadata/README.md`.
 *
 * Scope: the PURE-over-row primitives (Stub, HasNoInboundLinks, Priority,
 * LastEdited Range) plus AND-composition. The mock composes a filter list
 * with AND (every primitive must match), mirroring `compile_pages_filters`.
 *
 * State and DueDate(Between) exclude/is_null and inclusive-bounds parity
 * (#3314 finding 1) are NOT driven through this shared fixture — the real
 * Pages query path rejects `state`/`due-date` filters outright (see
 * `PAGES_ALLOWED_KEYS` in `agaric-store/src/filters/primitive.rs`), so the
 * Rust-side conformance harness in
 * `pages_filter_primitive_conformance_tests.rs` cannot exercise them either.
 * Instead they're pinned directly against `metaRowMatchesFilter` in the
 * "State exclude/is_null (#3314 finding 1)" and "Between inclusive bounds
 * (#3314 finding 1)" describe blocks below, mirroring the pre-existing Rust
 * `PagesProjection::compile` tests `pages_state_exclude_keeps_null_outside_the_in_list`
 * and `pages_due_date_matches_legacy_date_predicate_oracle`.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { type PageMetaRow, metaRowMatchesFilter } from '@/lib/tauri-mock/handlers'
import { datePredicateMatches } from '@/lib/tauri-mock/handlers/shared'

interface FixtureRow {
  id: string
  title: string
  childBlockCount: number
  inboundLinkCount: number
  priority: string | null
  lastModifiedAt: string | null
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
  'filters.vectors.json',
)
const vectors = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Vectors

/**
 * Build a full `PageMetaRow` from a fixture row, defaulting the fields the
 * in-scope primitives do not read. The primitives under test consult
 * `childBlockCount`, `inboundLinkCount`, `priority`, and `lastModifiedAt`.
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
    priority: row.priority,
    dueDate: null,
    scheduledDate: null,
    pageId: row.id,
    lastModifiedAt: row.lastModifiedAt,
    inboundLinkCount: row.inboundLinkCount,
    childBlockCount: row.childBlockCount,
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

describe('filter-primitive cross-impl conformance', () => {
  for (const scenario of vectors.scenarios) {
    it(scenario.name, () => {
      expect(matchingIds(scenario)).toEqual(scenario.expectedMatchingIds.toSorted())
    })
  }
})

/**
 * `State` exclude/is_null parity (#3314 finding 1). Not driven through the
 * shared JSON fixture — the real Pages query path rejects `state` filters
 * (`PAGES_ALLOWED_KEYS` in `agaric-store/src/filters/primitive.rs` omits
 * `state`), so `pages_filter_primitive_conformance_tests.rs` can't exercise
 * this primitive either. These four cases mirror the pre-existing Rust
 * `PagesProjection::compile` test
 * `pages_state_exclude_keeps_null_outside_the_in_list`
 * (`src-tauri/agaric-store/src/filters/primitive.rs`), which pins the same
 * (exclude x is_null) matrix directly against the SQL compiler.
 */
describe('State exclude/is_null (#3314 finding 1)', () => {
  const base: PageMetaRow = {
    id: 'row',
    blockType: 'page',
    content: 'row',
    parentId: null,
    position: 0,
    deletedAt: null,
    todoState: null,
    priority: null,
    dueDate: null,
    scheduledDate: null,
    pageId: 'row',
    lastModifiedAt: null,
    inboundLinkCount: 0,
    childBlockCount: 0,
    hasOutboundLink: false,
    flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
  }
  const todo: PageMetaRow = { ...base, todoState: 'todo' }
  const done: PageMetaRow = { ...base, todoState: 'done', id: 'done', pageId: 'done' }
  const nullState: PageMetaRow = { ...base, todoState: null, id: 'null', pageId: 'null' }

  it('include, is_null=false: matches only listed values, NULL excluded', () => {
    const f = { type: 'State', values: ['todo'], is_null: false, exclude: false }
    expect(metaRowMatchesFilter(todo, f)).toBe(true)
    expect(metaRowMatchesFilter(done, f)).toBe(false)
    expect(metaRowMatchesFilter(nullState, f)).toBe(false)
  })

  it('include, is_null=true: listed values OR NULL', () => {
    const f = { type: 'State', values: ['todo'], is_null: true, exclude: false }
    expect(metaRowMatchesFilter(todo, f)).toBe(true)
    expect(metaRowMatchesFilter(done, f)).toBe(false)
    expect(metaRowMatchesFilter(nullState, f)).toBe(true)
  })

  it('exclude, is_null=false: NULL-state rows are KEPT (OR-join)', () => {
    const f = { type: 'State', values: ['todo'], is_null: false, exclude: true }
    expect(metaRowMatchesFilter(todo, f)).toBe(false)
    expect(metaRowMatchesFilter(done, f)).toBe(true)
    expect(metaRowMatchesFilter(nullState, f)).toBe(true)
  })

  it('exclude, is_null=true: NULL-state rows are ALSO excluded (#2019 AND-join, tautology guard)', () => {
    const f = { type: 'State', values: ['todo'], is_null: true, exclude: true }
    expect(metaRowMatchesFilter(todo, f)).toBe(false)
    expect(metaRowMatchesFilter(done, f)).toBe(true)
    expect(metaRowMatchesFilter(nullState, f)).toBe(false)
  })
})

/**
 * `Between` inclusive-bounds parity (#3314 finding 1). Not driven through
 * the shared JSON fixture for the same `PAGES_ALLOWED_KEYS` reason as
 * `State` above (`due-date` is also excluded from the Pages surface).
 * Mirrors the pre-existing Rust test
 * `pages_due_date_all_variants_guard_is_not_null` /
 * `pages_due_date_matches_legacy_date_predicate_oracle`
 * (`src-tauri/agaric-store/src/filters/primitive.rs`), which pin
 * `pages_date_predicate`'s `Between` arm to SQL `BETWEEN ? AND ?` —
 * inclusive on both ends.
 */
describe('Between inclusive bounds (#3314 finding 1)', () => {
  const pred = { type: 'Between', from: '2026-03-01', to: '2026-03-10' }

  it('matches the lower bound exactly', () => {
    expect(datePredicateMatches('2026-03-01', pred)).toBe(true)
  })

  it('matches the upper bound exactly', () => {
    expect(datePredicateMatches('2026-03-10', pred)).toBe(true)
  })

  it('matches a value strictly inside the range', () => {
    expect(datePredicateMatches('2026-03-05', pred)).toBe(true)
  })

  it('excludes a value just outside the lower bound', () => {
    expect(datePredicateMatches('2026-02-28', pred)).toBe(false)
  })

  it('excludes a value just outside the upper bound', () => {
    expect(datePredicateMatches('2026-03-11', pred)).toBe(false)
  })
})
