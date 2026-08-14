/**
 * Tests for the `FilterPredicate` boundary validator — Issue #3791.
 *
 * `isFilterPredicate` / `parseFilterPredicates` are the runtime check that
 * stands in for the type system at the `JSON.parse` boundary
 * (`GraphFilterBar.readPersistedFilters`, which the component test in
 * `src/components/graph/__tests__/GraphFilterBar.test.tsx` covers
 * end-to-end). These tests exercise the validator directly, per `kind`.
 */

import { describe, expect, it } from 'vitest'

import { graphFiltersToCanonical } from '@/lib/filters/model'
import { isFilterPredicate, parseFilterPredicates } from '@/lib/filters/validate'
import type { GraphFilter } from '@/lib/graph-filters'

describe('isFilterPredicate', () => {
  it('rejects non-objects and null', () => {
    expect(isFilterPredicate(null)).toBe(false)
    expect(isFilterPredicate(undefined)).toBe(false)
    expect(isFilterPredicate('status')).toBe(false)
    expect(isFilterPredicate(42)).toBe(false)
    expect(isFilterPredicate([])).toBe(false)
  })

  it('rejects an object with no kind field', () => {
    expect(isFilterPredicate({ values: ['TODO'] })).toBe(false)
  })

  it('rejects a non-string kind', () => {
    expect(isFilterPredicate({ kind: 1 })).toBe(false)
  })

  it('rejects an unrecognised kind outright, even with plausible-looking fields', () => {
    expect(isFilterPredicate({ kind: 'totallyMadeUp', values: ['a'], exclude: false })).toBe(false)
  })

  describe('tag', () => {
    it('accepts by:id with a string tagId', () => {
      expect(isFilterPredicate({ kind: 'tag', by: 'id', tagId: 't-1' })).toBe(true)
    })

    it('accepts by:name with a string name', () => {
      expect(isFilterPredicate({ kind: 'tag', by: 'name', name: 'work' })).toBe(true)
    })

    it('rejects by:id with a non-string tagId', () => {
      expect(isFilterPredicate({ kind: 'tag', by: 'id', tagId: 42 })).toBe(false)
    })

    it('rejects an unrecognised by discriminant', () => {
      expect(isFilterPredicate({ kind: 'tag', by: 'bogus', tagId: 't-1' })).toBe(false)
    })

    it('rejects a tag/by:id predicate missing tagId entirely', () => {
      expect(isFilterPredicate({ kind: 'tag', by: 'id' })).toBe(false)
    })
  })

  describe('status', () => {
    it('accepts a well-formed status predicate', () => {
      expect(
        isFilterPredicate({
          kind: 'status',
          values: ['TODO', 'DOING'],
          isNull: false,
          exclude: false,
        }),
      ).toBe(true)
    })

    it('rejects a status predicate whose values is not a string array', () => {
      expect(
        isFilterPredicate({ kind: 'status', values: [1, 2], isNull: false, exclude: false }),
      ).toBe(false)
    })

    it('rejects a status predicate missing isNull', () => {
      expect(isFilterPredicate({ kind: 'status', values: ['TODO'], exclude: false })).toBe(false)
    })

    it('rejects a status predicate with a non-boolean exclude', () => {
      expect(
        isFilterPredicate({ kind: 'status', values: ['TODO'], isNull: false, exclude: 'no' }),
      ).toBe(false)
    })

    // #3791 — the concrete scenario from the issue: a stray `by: 'id'` field
    // borrowed from the `tag` variant must not make a `status` predicate pass
    // (it isn't part of the `status` shape, so it's simply ignored — the
    // predicate is judged on its OWN required fields, all of which are
    // present here).
    it('is unaffected by an extra stray field borrowed from another variant', () => {
      expect(
        isFilterPredicate({
          kind: 'status',
          by: 'id',
          values: ['TODO'],
          isNull: false,
          exclude: false,
        }),
      ).toBe(true)
    })
  })

  describe('priority', () => {
    it('accepts a well-formed priority predicate', () => {
      expect(isFilterPredicate({ kind: 'priority', values: ['1'], exclude: false })).toBe(true)
    })

    it('rejects a priority predicate missing exclude', () => {
      expect(isFilterPredicate({ kind: 'priority', values: ['1'] })).toBe(false)
    })
  })

  describe('date', () => {
    it('accepts a well-formed date predicate on a recognised field', () => {
      expect(isFilterPredicate({ kind: 'date', field: 'due', predicate: { type: 'IsNull' } })).toBe(
        true,
      )
      expect(
        isFilterPredicate({
          kind: 'date',
          field: 'scheduled',
          predicate: { type: 'After', date: '__graph-has-date__' },
        }),
      ).toBe(true)
    })

    it('rejects a date predicate on an unrecognised field', () => {
      expect(
        isFilterPredicate({ kind: 'date', field: 'bogus', predicate: { type: 'IsNull' } }),
      ).toBe(false)
    })

    it('rejects a date predicate whose nested predicate is malformed', () => {
      expect(isFilterPredicate({ kind: 'date', field: 'due', predicate: { type: 'Before' } })).toBe(
        false,
      )
      expect(
        isFilterPredicate({
          kind: 'date',
          field: 'due',
          predicate: { type: 'Between', from: 'a' },
        }),
      ).toBe(false)
    })
  })

  describe('hasBacklinks / excludeTemplates / boolean-only variants', () => {
    it('accepts hasBacklinks with a boolean value', () => {
      expect(isFilterPredicate({ kind: 'hasBacklinks', value: true })).toBe(true)
    })

    it('rejects hasBacklinks with a non-boolean value', () => {
      expect(isFilterPredicate({ kind: 'hasBacklinks', value: 'true' })).toBe(false)
    })

    it('accepts excludeTemplates with no other fields', () => {
      expect(isFilterPredicate({ kind: 'excludeTemplates' })).toBe(true)
    })
  })

  describe('property', () => {
    it('accepts a well-formed property predicate', () => {
      expect(
        isFilterPredicate({
          kind: 'property',
          key: 'due',
          predicate: { type: 'Eq', value: { type: 'Text', value: 'x' } },
          exclude: false,
        }),
      ).toBe(true)
    })

    it('rejects a property predicate whose nested PropertyPredicate is malformed', () => {
      expect(
        isFilterPredicate({
          kind: 'property',
          key: 'due',
          predicate: { type: 'Eq' }, // missing `value`
          exclude: false,
        }),
      ).toBe(false)
    })
  })

  describe('lastEdited', () => {
    it('accepts a Rolling spec', () => {
      expect(isFilterPredicate({ kind: 'lastEdited', spec: { type: 'Rolling', days: 7 } })).toBe(
        true,
      )
    })

    it('rejects a Rolling spec with a non-number days', () => {
      expect(isFilterPredicate({ kind: 'lastEdited', spec: { type: 'Rolling', days: '7' } })).toBe(
        false,
      )
    })
  })
})

describe('parseFilterPredicates', () => {
  it('returns an empty result for a non-array value', () => {
    expect(parseFilterPredicates({ not: 'an array' })).toEqual({
      predicates: [],
      droppedCount: 0,
    })
    expect(parseFilterPredicates(null)).toEqual({ predicates: [], droppedCount: 0 })
  })

  it('passes through every entry of a fully valid array', () => {
    const input = [
      { kind: 'status', values: ['TODO'], isNull: false, exclude: false },
      { kind: 'tag', by: 'id', tagId: 't-1' },
    ]
    expect(parseFilterPredicates(input)).toEqual({ predicates: input, droppedCount: 0 })
  })

  it('drops entries that fail validation while keeping the valid ones, in order', () => {
    const valid = { kind: 'status', values: ['TODO'], isNull: false, exclude: false }
    const malformedShape = { kind: 'status', values: [1, 2], isNull: false, exclude: false }
    const unknownKind = { kind: 'totallyMadeUp', foo: 'bar' }
    const notAnObject = 'nope'

    const result = parseFilterPredicates([valid, malformedShape, unknownKind, notAnObject])
    expect(result.predicates).toEqual([valid])
    expect(result.droppedCount).toBe(3)
  })

  // #3791 — a too-strict validator is a silent data-loss bug: it would drop
  // a user's own legitimately saved filters on upgrade. Round-trip one
  // instance of every `GraphFilter` kind the graph surface can actually
  // write (`GraphFilterBar.writePersistedFilters` → `graphFiltersToCanonical`)
  // through the validator and confirm NOTHING the app itself constructs is
  // ever dropped.
  it("accepts every canonical predicate produced by the app's own write path, for one instance of each GraphFilter kind", () => {
    const filters: GraphFilter[] = [
      { type: 'tag', tagIds: ['t-1', 't-2'] },
      { type: 'tag', tagIds: [] },
      { type: 'status', values: ['TODO', 'DOING'] },
      { type: 'priority', values: ['1'] },
      { type: 'hasDueDate', value: true },
      { type: 'hasDueDate', value: false },
      { type: 'hasScheduledDate', value: true },
      { type: 'hasScheduledDate', value: false },
      { type: 'hasBacklinks', value: true },
      { type: 'excludeTemplates', value: true },
    ]
    const canonical = graphFiltersToCanonical(filters)
    // Sanity: the fixture actually produced a non-trivial payload (the
    // `tag` case fans out to one predicate per id, plus an empty-id no-op
    // predicate) — guards this test against vacuously passing if the
    // fixture ever stops lining up with the converter.
    expect(canonical.length).toBeGreaterThanOrEqual(filters.length)

    const result = parseFilterPredicates(canonical)
    expect(result.droppedCount).toBe(0)
    expect(result.predicates).toEqual(canonical)
  })
})
