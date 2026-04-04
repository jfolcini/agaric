/**
 * Shared test fixtures — canonical factory helpers for test data.
 *
 * Each factory accepts an optional `overrides` bag that is spread over
 * sensible defaults, following the Partial<T> pattern.
 */

import type { BlockRow } from '../../lib/tauri'
import type { FlatBlock } from '../../lib/tree-utils'

/** Create a FlatBlock (block + depth) with sensible defaults. */
export function makeBlock(overrides: Partial<FlatBlock> = {}): FlatBlock {
  return {
    id: 'BLK001',
    block_type: 'content',
    content: 'Test block',
    parent_id: null,
    position: 0,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    depth: 0,
    ...overrides,
  }
}

/** Create a page-type BlockRow. */
export function makePage(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'PAGE001',
    block_type: 'page',
    content: 'Test page',
    parent_id: null,
    position: null,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  }
}

/** Create a conflict-type BlockRow (is_conflict: true). */
export function makeConflict(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'CONFLICT001',
    block_type: 'content',
    content: 'Conflict content',
    parent_id: 'ORIG001',
    position: null,
    deleted_at: null,
    archived_at: null,
    is_conflict: true,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  }
}

/** Create a daily journal page BlockRow. */
export function makeDailyPage(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'DAILY001',
    block_type: 'page',
    content: '2025-01-01',
    parent_id: null,
    position: null,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  }
}

/** Common empty paginated response. */
export const emptyPage = { items: [], next_cursor: null, has_more: false }
