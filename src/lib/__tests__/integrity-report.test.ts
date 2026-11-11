/**
 * Tests for the integrity report's grouping and plain-words names (#6488).
 */

import { describe, expect, it } from 'vitest'

import type { ReconciliationReport } from '@/lib/bindings'
import { divergenceKind, groupByKind, problemId, tableId } from '@/lib/integrity-report'

const REPORT: ReconciliationReport = {
  blocks_scanned: 2441,
  today: '2026-11-11',
  total_divergences: 31,
  artefacts: [
    { artefact: 'fts_blocks.stripped', count: 27, sample_keys: ['01KNHVPXFE9T6SFZMNJXAYAPMJ'] },
    { artefact: 'engine.blocks.row', count: 3, sample_keys: [] },
    { artefact: 'pages_cache.title_sort_key', count: 1, sample_keys: [] },
  ],
}

describe('divergenceKind', () => {
  it('is engine for an engine artefact and rebuildable for every other', () => {
    expect(divergenceKind('engine.blocks.content')).toBe('engine')
    expect(divergenceKind('fts_blocks.stripped')).toBe('rebuildable')
    expect(divergenceKind('blocks.page_id')).toBe('rebuildable')
  })
})

describe('tableId', () => {
  it('names a cache table, an engine table, and nothing it does not know', () => {
    expect(tableId('fts_blocks.stripped')).toBe('search')
    expect(tableId('engine.page_aliases.row')).toBe('pageAliases')
    expect(tableId('block_tag_inherited')).toBe('inheritedTags')
    expect(tableId('a_new_table.column')).toBeNull()
    expect(tableId('engine.a_new_table.row')).toBeNull()
  })
})

describe('problemId', () => {
  it('says an older strip, missing rows, counts, a sort key, or values', () => {
    expect(problemId('fts_blocks.stripped')).toBe('olderStrip')
    expect(problemId('fts_blocks.duplicate_row')).toBe('duplicate')
    expect(problemId('page_link_cache.edge')).toBe('rows')
    expect(problemId('pages_cache.child_block_count')).toBe('counts')
    expect(problemId('attachment_blobs.refcount')).toBe('counts')
    expect(problemId('pages_cache.title_sort_key')).toBe('sortKey')
    expect(problemId('tags_cache.name')).toBe('values')
    expect(problemId('block_tag_inherited')).toBe('values')
  })

  it('tells engine rows from engine values', () => {
    expect(problemId('engine.blocks.row')).toBe('engineRows')
    expect(problemId('engine.blocks.content')).toBe('engineValues')
  })
})

describe('groupByKind', () => {
  it('puts the caches first, keeps the backend order within each, and sums the rows', () => {
    expect(groupByKind(REPORT)).toEqual([
      {
        kind: 'rebuildable',
        artefacts: [REPORT.artefacts[0], REPORT.artefacts[2]],
        rows: 28,
      },
      { kind: 'engine', artefacts: [REPORT.artefacts[1]], rows: 3 },
    ])
  })

  it('leaves out a kind with no rows, and a clean report has no group', () => {
    expect(groupByKind({ ...REPORT, artefacts: [REPORT.artefacts[1]] }).map((g) => g.kind)).toEqual(
      ['engine'],
    )
    expect(groupByKind({ ...REPORT, total_divergences: 0, artefacts: [] })).toEqual([])
  })
})

describe('the non-standard id group (#6488)', () => {
  it('is its own kind, named Blocks, last after the engine', () => {
    expect(divergenceKind('blocks.id_form')).toBe('ids')
    expect(tableId('blocks.id_form')).toBe('blocks')
    expect(problemId('blocks.id_form')).toBe('idForm')
    const report: ReconciliationReport = {
      ...REPORT,
      artefacts: [
        { artefact: 'blocks.id_form', count: 2, sample_keys: ['01lower'] },
        ...REPORT.artefacts,
      ],
    }
    expect(groupByKind(report).map((g) => [g.kind, g.rows])).toEqual([
      ['rebuildable', 28],
      ['engine', 3],
      ['ids', 2],
    ])
  })
})
