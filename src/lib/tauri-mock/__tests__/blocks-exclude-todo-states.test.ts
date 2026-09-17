/**
 * #5074 — the mock's half of `ListBlocksRequest.excludeTodoStates`.
 *
 * The agenda's DONE exclusion moved out of a client-side pass in
 * `useDuePanelData` and into SQL, because a client-side drop runs AFTER the
 * backend's 50-row page cap: a page that is entirely DONE comes back empty,
 * `DuePanel` renders `null`, and `LoadMoreButton` goes with it, stranding
 * every page behind it. Testing invariant 3 makes the mock the second
 * implementation of that predicate, so it needs pinning on its own terms:
 *
 *  - it drops the listed states and keeps a NULL state, the
 *    `b.todo_state IS NULL OR b.todo_state NOT IN (…)` arm;
 *  - it filters BEFORE paginating, which is the whole point;
 *  - it refuses the knob off the `date` branch, where
 *    `list_blocks_inner` answers `AppError::Validation` rather than an
 *    unfiltered set.
 *
 * Asserted through `dispatch('list_blocks', …)` — the real IPC surface —
 * rather than by reaching into the handler, for the reason
 * `blocks-cursor-strictness.test.ts` gives.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, seedBlocks } from '@/lib/tauri-mock/seed'

const DATE = '2026-03-04'

/** Deterministic 26-char block id from a short label. */
function id(label: string): string {
  return label.padStart(26, '0')
}

interface ListBlocksPage {
  items: Record<string, unknown>[]
  has_more: boolean
  next_cursor: string | null
  total_count: number | null
}

function listBlocks(request: Record<string, unknown>): ListBlocksPage {
  return dispatch('list_blocks', {
    request,
    scope: { kind: 'active', space_id: id('SP') },
  }) as ListBlocksPage
}

/** Seed one due-today block carrying `todoState`. */
function seedDue(label: string, todoState: string | null): string {
  const blockId = id(label)
  blocks.set(blockId, {
    ...makeBlock(blockId, 'content', label, null, 1),
    due_date: DATE,
    todo_state: todoState,
  })
  return blockId
}

describe('list_blocks — excludeTodoStates on the agenda-date branch', () => {
  beforeEach(() => {
    seedBlocks()
    blocks.clear()
  })

  it('drops the listed states and keeps an unlisted one and a NULL one', () => {
    const todo = seedDue('A1', 'TODO')
    seedDue('A2', 'DONE')
    const cancelled = seedDue('A3', 'CANCELLED')
    const stateless = seedDue('A4', null)

    const page = listBlocks({ date: DATE, excludeTodoStates: ['DONE'] })

    expect(page.items.map((b) => b['id'])).toEqual([todo, cancelled, stateless])
  })

  it('is no filter at all when the list is empty or absent', () => {
    seedDue('B1', 'TODO')
    seedDue('B2', 'DONE')

    expect(listBlocks({ date: DATE, excludeTodoStates: [] }).items).toHaveLength(2)
    expect(listBlocks({ date: DATE }).items).toHaveLength(2)
  })

  it('filters before paginating, so excluded rows cannot fill a page', () => {
    seedDue('C1', 'DONE')
    seedDue('C2', 'DONE')
    const open = seedDue('C3', 'TODO')

    // The two DONE rows sort ahead of the open one and would be the whole of
    // a limit-2 page if the exclusion ran after the cap.
    const page = listBlocks({ date: DATE, excludeTodoStates: ['DONE'], limit: 2 })

    expect(page.items.map((b) => b['id'])).toEqual([open])
    expect(page.has_more).toBe(false)
    expect(page.next_cursor).toBeNull()
  })

  it('refuses the knob off the `date` branch rather than ignoring it', () => {
    const page = id('P1')
    blocks.set(page, makeBlock(page, 'page', 'Home', null, 1))

    expect(() => listBlocks({ parentId: page, excludeTodoStates: ['DONE'] })).toThrow(
      /exclude_todo_states/,
    )
    expect(() =>
      listBlocks({
        dateRange: { start: DATE, end: DATE },
        excludeTodoStates: ['DONE'],
      }),
    ).toThrow(/exclude_todo_states/)
    // The same requests without the knob are served, so the rejection is the
    // knob's doing and not the fixture's.
    expect(() => listBlocks({ parentId: page })).not.toThrow()
  })
})
