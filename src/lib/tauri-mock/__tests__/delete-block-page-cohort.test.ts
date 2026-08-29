/**
 * #4523 — the mock's `delete_block` must report `affected_page_ids`.
 *
 * The backend cascade walks `parent_id` with NO page-boundary stop
 * (`collect_subtree_ids_unbounded` filters on `deleted_at` and depth, never on
 * `block_type`), so deleting a page tombstones its nested PAGE children too.
 * `DeleteResponse.affected_page_ids` is what lets `usePageDeleteAction` evict
 * those from the `[[` picker's per-space name cache; without it the picker
 * goes on offering rows that are now in the trash.
 *
 * The mock is the backend Playwright runs against, so a mock that reported
 * only the seed would let exactly that bug pass in the in-browser harness —
 * the same trap the batch handler's `affected_page_ids` closes (#4480/#4521).
 * Pinned here because nothing else exercises the field through `dispatch`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
} from '@/lib/tauri-mock/seed'

const ROOT = '000000000000000000000ROOTP'
const ROOT_TEXT = '000000000000000000000ROOTC'
const KID = '0000000000000000000000KIDP'
const KID_TEXT = '0000000000000000000000KIDC'
const SIBLING = '00000000000000000000SIBLNG'

/**
 * ROOT (page)
 *  ├─ ROOT_TEXT (content)
 *  └─ KID (page)
 *      └─ KID_TEXT (content)
 * SIBLING (page, untouched)
 */
function seedNestedPages(): void {
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0

  blocks.set(ROOT, makeBlock(ROOT, 'page', 'Root Page', null, 0))
  blocks.set(ROOT_TEXT, makeBlock(ROOT_TEXT, 'content', 'root text', ROOT, 1))
  blocks.set(KID, makeBlock(KID, 'page', 'Kid Page', ROOT, 2))
  blocks.set(KID_TEXT, makeBlock(KID_TEXT, 'content', 'kid text', KID, 1))
  blocks.set(SIBLING, makeBlock(SIBLING, 'page', 'Sibling Page', null, 3))
}

describe('tauri-mock delete_block — cascaded page cohort (#4523)', () => {
  beforeEach(seedNestedPages)

  // NON-TAUTOLOGY — what each half rules out:
  //   * `affected_page_ids` = `[ROOT]` → the mock stops the walk at the nested
  //     page boundary, or reports only the seed. Either way the in-browser
  //     harness would show the picker bug as fixed while it is not.
  //   * `affected_page_ids` containing ROOT_TEXT / KID_TEXT → the
  //     `block_type === 'page'` filter is missing; the frontend would burn its
  //     `NAME_CACHE_FANOUT_MAX_IDS` budget on rows the picker cannot hold.
  //   * `affected_page_ids` containing SIBLING → the handler is reporting live
  //     pages rather than the cohort's. The sibling is a live page for exactly
  //     that reason.
  it('reports the PAGE members of the cascade, seed included and content excluded', () => {
    const resp = dispatch('delete_block', { blockId: ROOT }) as Record<string, unknown>

    expect(resp['descendants_affected']).toBe(4)
    expect([...(resp['affected_page_ids'] as string[])].toSorted()).toEqual([ROOT, KID].toSorted())
  })

  // The empty list is a real answer, not an "unknown": a content-only cascade
  // owes the picker no eviction at all. A handler that defaulted to "everything
  // in the cohort" would return two ids here.
  it('reports an empty cohort when the cascade touches no page', () => {
    const resp = dispatch('delete_block', { blockId: ROOT_TEXT }) as Record<string, unknown>

    expect(resp['descendants_affected']).toBe(1)
    expect(resp['affected_page_ids']).toEqual([])
  })

  // The seed is soft-deleted, so the cascade is a no-op and there is nothing to
  // evict. Pins that `deleteCohort`'s early return still yields a LIST — a
  // handler reading `.length` off `undefined` would throw instead.
  it('reports an empty cohort for an already-deleted seed', () => {
    dispatch('delete_block', { blockId: KID })
    const resp = dispatch('delete_block', { blockId: KID }) as Record<string, unknown>

    expect(resp['descendants_affected']).toBe(0)
    expect(resp['affected_page_ids']).toEqual([])
  })
})
