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
 * so the properties under test are: pages only, the space block excluded, and
 * — the one that was missing — an existing membership PRESERVED rather than
 * overwritten.
 *
 * A fourth: the stamp writes the mock's own `space_id` COLUMN as well as its
 * `space` property. The backend statement above targets `blocks.space_id`, the
 * #533 sole source of truth, and the mock has a literal analogue of that column
 * which `list_all_tags_in_space` already filters on — so a property-only stamp
 * left every conformance page `space_id === null` on the mock while its backend
 * twin held `TEST_SPACE_ID`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { CONFORMANCE_SPACE_ID, stampMockSpace } from '@/lib/tauri-mock/__tests__/conformance-query'
import { blocks, makeBlock, properties } from '@/lib/tauri-mock/seed'

/** Another space's id — any 26-char literal that is not the harness space. */
const OTHER_SPACE_ID = '01OTHERSPACE00000000000001'

/** Read a page's mock space membership: the `space` property's ref, or null. */
function spaceOf(id: string): string | null {
  return (properties.get(id)?.get('space')?.['value_ref'] as string | null) ?? null
}

/** The mock's literal analogue of `blocks.space_id` — the column the backend
 *  statement actually writes, and the one `list_all_tags_in_space` reads. */
function spaceColumnOf(id: string): string | null {
  return (blocks.get(id)?.['space_id'] as string | null) ?? null
}

/** Place `id` in `spaceId` the way the fixture seed loader does — a direct
 *  property-map write, which is what a cross-space SEED looks like on the mock
 *  (the backend's counterpart routes `space` to the `blocks.space_id` column,
 *  which `assign_all_to_test_space` then sees as non-NULL). */
function seedSpace(id: string, spaceId: string): void {
  if (!properties.has(id)) properties.set(id, new Map())
  properties.get(id)?.set('space', {
    key: 'space',
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: spaceId,
    value_bool: null,
  })
}

describe('stampMockSpace mirrors assign_all_to_test_space', () => {
  beforeEach(() => {
    blocks.clear()
    properties.clear()
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

  // Non-pages resolve their space through their owning page, so the stamp must
  // not write one onto them — the Rust twin's `id = page_id` clause.
  it('stamps pages only', () => {
    blocks.set('P1', makeBlock('P1', 'page', 'Page', null, 0))
    blocks.set('C1', makeBlock('C1', 'content', 'Child', 'P1', 0))

    stampMockSpace()

    expect(spaceOf('P1')).toBe(CONFORMANCE_SPACE_ID)
    expect(spaceOf('C1')).toBeNull()
  })

  // The harness calls it twice — before and after the op replay — so the
  // second call must be a no-op on everything the first one settled.
  // The column, not just the property. `blocks.space_id` is the #533 sole
  // source of truth the backend statement writes; the mock has a literal
  // analogue of it and `list_all_tags_in_space` already reads it, so a
  // property-only stamp left every conformance page null where its backend
  // twin held the test space.
  it('writes the space_id COLUMN a page, not only the space property', () => {
    blocks.set('P1', makeBlock('P1', 'page', 'Unscoped', null, 0))

    stampMockSpace()

    expect(spaceColumnOf('P1')).toBe(CONFORMANCE_SPACE_ID)
  })

  // The seed loader writes the PROPERTY map only, so a cross-space page reaches
  // the stamp with its column still null while its backend twin already holds
  // that space. Preserving means reconciling the column onto it, not skipping.
  it('reconciles the column of a page the fixture seeded into another space', () => {
    blocks.set('P1', makeBlock('P1', 'page', 'Cross-space', null, 0))
    seedSpace('P1', OTHER_SPACE_ID)

    stampMockSpace()

    expect(spaceColumnOf('P1')).toBe(OTHER_SPACE_ID)
  })

  // The backend's third statement: propagate a root's membership to every
  // block paged to it. Non-pages get the column but never the property.
  it('propagates a page membership to the blocks paged to it', () => {
    blocks.set('P1', makeBlock('P1', 'page', 'Page', null, 0))
    blocks.set('C1', makeBlock('C1', 'content', 'Child', 'P1', 0))
    blocks.set('P2', makeBlock('P2', 'page', 'Cross-space', null, 0))
    blocks.set('C2', makeBlock('C2', 'content', 'Other child', 'P2', 0))
    seedSpace('P2', OTHER_SPACE_ID)

    stampMockSpace()

    expect(spaceColumnOf('C1')).toBe(CONFORMANCE_SPACE_ID)
    expect(spaceColumnOf('C2')).toBe(OTHER_SPACE_ID)
    expect(spaceOf('C1')).toBeNull()
  })

  // The backend's `UPDATE blocks SET page_id = id WHERE page_id IS NULL` makes
  // a parentless non-page a ROOT, so its `space_id` is stamped there; the
  // mock's `makeBlock` leaves such a block's `page_id` null. Without the
  // read-only normalisation the two disagree exactly on the row
  // `list_all_tags_in_space` reads.
  it('stamps the column of a parentless non-page, which the backend treats as a root', () => {
    blocks.set('T1', makeBlock('T1', 'tag', 'urgent', null, 0))

    stampMockSpace()

    expect(spaceColumnOf('T1')).toBe(CONFORMANCE_SPACE_ID)
  })

  it('leaves the space block own column null', () => {
    blocks.set(CONFORMANCE_SPACE_ID, makeBlock(CONFORMANCE_SPACE_ID, 'page', 'TestSpace', null, 0))

    stampMockSpace()

    expect(spaceColumnOf(CONFORMANCE_SPACE_ID)).toBeNull()
  })

  it('is idempotent across the two calls the harness makes', () => {
    blocks.set('P1', makeBlock('P1', 'page', 'Unscoped', null, 0))
    blocks.set('P2', makeBlock('P2', 'page', 'Cross-space', null, 0))
    seedSpace('P2', OTHER_SPACE_ID)

    stampMockSpace()
    stampMockSpace()

    expect(spaceOf('P1')).toBe(CONFORMANCE_SPACE_ID)
    expect(spaceOf('P2')).toBe(OTHER_SPACE_ID)
    expect(spaceColumnOf('P1')).toBe(CONFORMANCE_SPACE_ID)
    expect(spaceColumnOf('P2')).toBe(OTHER_SPACE_ID)
  })
})
