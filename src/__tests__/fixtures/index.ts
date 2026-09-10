/**
 * Shared test fixtures — canonical factory helpers for test data.
 *
 * Each factory accepts an optional `overrides` bag that is spread over
 * sensible defaults, following the Partial<T> pattern.
 */

import type {
  BlockRow,
  HistoryEntry,
  PageHeading,
  PageWithMetadataRow,
  WithOps,
} from '@/lib/bindings'
import type { FlatBlock } from '@/lib/tree-utils'

/** Create a FlatBlock (block + depth) with sensible defaults. */
export function makeBlock(overrides: Partial<FlatBlock> = {}): FlatBlock {
  return {
    id: 'BLK001',
    block_type: 'content',
    content: 'Test block',
    parent_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
    depth: 0,
    ...overrides,
  }
}

/** Create a page-type BlockRow. */
export function makePage(overrides: Partial<BlockRow> = {}): BlockRow {
  return makeBlockRow({
    id: 'PAGE001',
    block_type: 'page',
    content: 'Test page',
    position: null,
    ...overrides,
  })
}

/** Create a daily journal page BlockRow. */
export function makeDailyPage(overrides: Partial<BlockRow> = {}): BlockRow {
  return makeBlockRow({
    id: 'DAILY001',
    block_type: 'page',
    content: '2025-01-01',
    position: null,
    ...overrides,
  })
}

/** Common empty paginated response; `PageResponse` always carries `total_count`. */
export const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

/** Create a HistoryEntry (op_log row) with positional defaults. */
export function makeHistoryEntry(
  seq: number,
  opType: string,
  payload: unknown,
  createdAt: number = 1736942400000,
  deviceId = 'DEVICE01',
  isReplicated = false,
): HistoryEntry {
  return {
    device_id: deviceId,
    seq,
    op_type: opType,
    payload: JSON.stringify(payload),
    created_at: createdAt,
    // #2481 phase 2: foreign audit rows carry is_replicated=1.
    is_replicated: isReplicated,
  }
}

/**
 * A complete {@link BlockRow}, with the fields a test cares about overridden.
 *
 * Defaults are the "plain live content block" case: no TODO state, no
 * priority, no dates, not deleted.
 */
export function makeBlockRow(overrides: Partial<BlockRow> & Pick<BlockRow, 'id'>): BlockRow {
  return {
    block_type: 'content',
    content: null,
    parent_id: null,
    position: 1,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
    ...overrides,
  }
}

/**
 * A {@link BlockRow} wrapped in the `op_refs` envelope the mutating block
 * commands return (`create_block`, `edit_block`, `delete_block`, …).
 *
 * Stubs routinely returned the bare row, which is a shape the backend never
 * sends: `WithOps<T>` is `{ op_refs } & T`, and a component reading `op_refs`
 * would have seen `undefined` in the test and a real array in production.
 */
export function withOps<T>(value: T): WithOps<T> {
  return { op_refs: [], ...value }
}

/** A complete {@link PageHeading} (snake_case, unlike the metadata row). */
export function makePageHeading(
  overrides: Partial<PageHeading> & Pick<PageHeading, 'id'>,
): PageHeading {
  return {
    content: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  }
}

/**
 * Re-shape a {@link BlockRow} into the {@link PageWithMetadataRow} that
 * `list_pages_with_metadata` actually returns.
 *
 * The two differ in more than field names: specta renames this struct to
 * camelCase, and it carries metadata columns (`lastModifiedAt`,
 * `inboundLinkCount`, `childBlockCount`, `flags`) that no `BlockRow` has.
 * Suites stubbed the command with `BlockRow`s for exactly as long as nothing
 * typed the seam (#4668).
 */
export function asPageWithMetadataRow(row: BlockRow): PageWithMetadataRow {
  return {
    id: row.id,
    blockType: row.block_type,
    content: row.content,
    parentId: row.parent_id,
    position: row.position,
    deletedAt: row.deleted_at,
    todoState: row.todo_state,
    priority: row.priority,
    dueDate: row.due_date,
    scheduledDate: row.scheduled_date,
    pageId: row.page_id,
    // The metadata columns no `BlockRow` has.
    lastModifiedAt: null,
    inboundLinkCount: 0,
    childBlockCount: 0,
    flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
  }
}
