/**
 * #3833 item 1 — `stampMockSpace` must be the MIRROR of the Rust harness's
 * `assign_all_to_test_space` (`src-tauri/tests/command_integration/common.rs`),
 * not merely its rough equivalent.
 *
 * The two functions place a fixture's rows in the harness space on their own
 * stack, and the conformance differential then compares what the space-scoped
 * read commands answer. A disagreement between the two STAMPS therefore shows
 * up as a disagreement between the two IMPLEMENTATIONS: the fixture reddens,
 * and the author debugs a mock handler that is behaving correctly. That is the
 * failure mode `conformance-query.ts`'s own header calls "a harness divergence
 * wearing the costume of an implementation one".
 *
 * The backend statement is
 *
 * ```sql
 * UPDATE blocks SET space_id = ?TEST
 *  WHERE id <> ?TEST AND id = page_id AND space_id IS NULL
 * ```
 *
 * so the properties under test are: roots only, the space block excluded, an
 * existing membership PRESERVED rather than overwritten, and the root's
 * membership propagated to every block paged to it.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { CONFORMANCE_SPACE_ID, stampMockSpace } from '@/lib/tauri-mock/__tests__/conformance-query'
import { blocks, makeBlock } from '@/lib/tauri-mock/seed'

/** Another space's id — any 26-char literal that is not the harness space. */
const OTHER_SPACE_ID = '01OTHERSPACE00000000000001'

/** A block's `space_id`, the column the backend statement writes. */
function spaceOf(id: string): string | null {
  return (blocks.get(id)?.['space_id'] as string | null) ?? null
}

/** Place `id` in `spaceId`, as a fixture's cross-space page arrives. */
function seedSpace(id: string, spaceId: string): void {
  const row = blocks.get(id)
  if (row) row['space_id'] = spaceId
}

describe('stampMockSpace mirrors assign_all_to_test_space', () => {
  beforeEach(() => {
    blocks.clear()
  })

  it('stamps a page that has no space yet', () => {
    blocks.set('P1', makeBlock('P1', 'page', 'Unscoped', null, 0))

    stampMockSpace()

    expect(spaceOf('P1')).toBe(CONFORMANCE_SPACE_ID)
  })

  // The pair of the test above: without this one, "preserve an existing
  // membership" is satisfiable by a function that stamps nothing at all.
  it('leaves a page the fixture already placed in ANOTHER space alone', () => {
    blocks.set('P1', makeBlock('P1', 'page', 'Cross-space', null, 0))
    seedSpace('P1', OTHER_SPACE_ID)

    stampMockSpace()

    expect(spaceOf('P1')).toBe(OTHER_SPACE_ID)
  })

  it('does not make the space block a member of itself', () => {
    blocks.set(CONFORMANCE_SPACE_ID, makeBlock(CONFORMANCE_SPACE_ID, 'page', 'TestSpace', null, 0))

    stampMockSpace()

    expect(spaceOf(CONFORMANCE_SPACE_ID)).toBeNull()
  })

  // The backend's third statement: propagate a root's membership to every
  // block paged to it, the cross-space one included.
  it('propagates a page membership to the blocks paged to it', () => {
    blocks.set('P1', makeBlock('P1', 'page', 'Page', null, 0))
    blocks.set('C1', makeBlock('C1', 'content', 'Child', 'P1', 0))
    blocks.set('P2', makeBlock('P2', 'page', 'Cross-space', null, 0))
    blocks.set('C2', makeBlock('C2', 'content', 'Other child', 'P2', 0))
    seedSpace('P2', OTHER_SPACE_ID)

    stampMockSpace()

    expect(spaceOf('C1')).toBe(CONFORMANCE_SPACE_ID)
    expect(spaceOf('C2')).toBe(OTHER_SPACE_ID)
  })

  // The backend's `UPDATE blocks SET page_id = id WHERE page_id IS NULL` makes
  // a parentless non-page a ROOT, so its `space_id` is stamped there; the
  // mock's `makeBlock` leaves such a block's `page_id` null. Without the
  // read-only normalisation the two disagree exactly on the row
  // `list_all_tags_in_space` reads.
  it('stamps a parentless non-page, which the backend treats as a root', () => {
    blocks.set('T1', makeBlock('T1', 'tag', 'urgent', null, 0))

    stampMockSpace()

    expect(spaceOf('T1')).toBe(CONFORMANCE_SPACE_ID)
  })

  it('is idempotent across the two calls the harness makes', () => {
    blocks.set('P1', makeBlock('P1', 'page', 'Unscoped', null, 0))
    blocks.set('P2', makeBlock('P2', 'page', 'Cross-space', null, 0))
    seedSpace('P2', OTHER_SPACE_ID)

    stampMockSpace()
    stampMockSpace()

    expect(spaceOf('P1')).toBe(CONFORMANCE_SPACE_ID)
    expect(spaceOf('P2')).toBe(OTHER_SPACE_ID)
  })
})
