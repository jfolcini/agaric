/**
 * Typed row factories for IPC stubs (#4668).
 *
 * ## Why this exists
 *
 * Before `mockInvokeCommands` was typed against the generated command return
 * types, every suite hand-built its own `BlockRow`-shaped literal with whatever
 * subset of fields that test happened to read. Those literals drifted: a stub
 * missing `todo_state` / `priority` / `due_date` / `scheduled_date` still
 * satisfied the component under test, so the suite went green against a
 * response the backend never produces.
 *
 * A factory keyed to the GENERATED type fixes both halves — the literal is
 * complete by construction, and a field added to the Rust struct fails
 * `npm run typecheck` here once, rather than silently in every stub that
 * omitted it.
 */

import type { BlockRow, OpRef, PageHeading, PageWithMetadataRow, WithOps } from '@/lib/bindings'

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
export function withOps<T>(value: T, opRefs: OpRef[] = []): WithOps<T> {
  return { op_refs: opRefs, ...value }
}

/**
 * A complete {@link PageWithMetadataRow}.
 *
 * Note the casing: specta renames this struct's fields to camelCase, while
 * {@link BlockRow} stays snake_case. Stubs for `list_pages_with_metadata` were
 * returning `BlockRow`-shaped objects — a different shape in both field names
 * and content, which the suite could not notice because nothing typed the seam.
 */
export function makePageWithMetadataRow(
  overrides: Partial<PageWithMetadataRow> & Pick<PageWithMetadataRow, 'id'>,
): PageWithMetadataRow {
  return {
    blockType: 'page',
    content: null,
    parentId: null,
    position: 1,
    deletedAt: null,
    todoState: null,
    priority: null,
    dueDate: null,
    scheduledDate: null,
    pageId: null,
    lastModifiedAt: null,
    inboundLinkCount: 0,
    childBlockCount: 0,
    flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
    ...overrides,
  }
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
  return makePageWithMetadataRow({
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
  })
}
