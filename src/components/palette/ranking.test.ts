/**
 * Unit tests for `mergeAndRankGroups` extracted from CommandPalette.tsx
 * (#751). The component-level CommandPalette.test.tsx already exercises
 * caps + surplus through the rendered DOM; these tests pin the pure
 * merge/rank/cap/score behaviour directly so a regression surfaces here
 * without a full React render.
 */

import { describe, expect, it } from 'vitest'

import type { SearchBlockRow } from '@/lib/tauri'

import { mergeAndRankGroups } from './ranking'

function pageRow(id: string, content: string): SearchBlockRow {
  return {
    id,
    block_type: 'page',
    content,
    parent_id: null,
    page_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    snippet: null,
    match_offsets: [],
  } as SearchBlockRow
}

function blockRow(id: string, content: string, pageId: string): SearchBlockRow {
  return {
    id,
    block_type: 'content',
    content,
    parent_id: null,
    page_id: pageId,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    snippet: null,
    match_offsets: [],
  } as SearchBlockRow
}

describe('mergeAndRankGroups', () => {
  it('seeds a page-name-match group from each pages-partition row', () => {
    const out = mergeAndRankGroups([pageRow('P1', 'Home')], [], 'home')
    expect(out).toHaveLength(1)
    expect(out[0]?.pageId).toBe('P1')
    expect(out[0]?.hasPageNameMatch).toBe(true)
    expect(out[0]?.matches).toHaveLength(0)
  })

  it('attaches block hits to the group keyed by page_id', () => {
    const out = mergeAndRankGroups([pageRow('P1', 'Home')], [blockRow('B1', 'a hit', 'P1')], 'hit')
    expect(out).toHaveLength(1)
    expect(out[0]?.matches.map((m) => m.id)).toEqual(['B1'])
  })

  it('seeds a content-only group when no page row exists for a block', () => {
    const out = mergeAndRankGroups([], [blockRow('B1', 'orphan', 'P9')], 'orphan')
    expect(out).toHaveLength(1)
    expect(out[0]?.pageId).toBe('P9')
    expect(out[0]?.hasPageNameMatch).toBe(false)
    expect(out[0]?.pageTitle).toBe('Untitled')
  })

  it('caps matches per group at 2 and reports surplus', () => {
    const blocks = [
      blockRow('B1', 'one', 'P1'),
      blockRow('B2', 'two', 'P1'),
      blockRow('B3', 'three', 'P1'),
      blockRow('B4', 'four', 'P1'),
    ]
    const out = mergeAndRankGroups([pageRow('P1', 'Home')], blocks, 'home')
    expect(out[0]?.matches).toHaveLength(2)
    expect(out[0]?.surplus).toBe(2)
  })

  it('caps the number of page-groups at 8', () => {
    const pages = Array.from({ length: 12 }, (_, i) => pageRow(`P${i}`, `Page ${i}`))
    const out = mergeAndRankGroups(pages, [], 'page')
    expect(out).toHaveLength(8)
  })

  it('orders by the 4-band rule: exact title outranks prefix outranks contains', () => {
    const pages = [
      pageRow('CONTAINS', 'xx report yy'),
      pageRow('EXACT', 'report'),
      pageRow('PREFIX', 'report card'),
    ]
    const out = mergeAndRankGroups(pages, [], 'report')
    expect(out.map((g) => g.pageId)).toEqual(['EXACT', 'PREFIX', 'CONTAINS'])
  })

  it('promotes a page row to title-match when a block row preceded it', () => {
    // Block hits for P1 arrive first (content-only group), then the
    // page-title row promotes the same group to hasPageNameMatch.
    const out = mergeAndRankGroups([pageRow('P1', 'Home')], [blockRow('B1', 'body', 'P1')], 'home')
    expect(out[0]?.hasPageNameMatch).toBe(true)
    expect(out[0]?.pageTitle).toBe('Home')
  })
})
