/**
 * #5057 review — undoing a cross-space move must return the page to the space
 * it came FROM.
 *
 * `move_blocks_to_space` writes membership twice: the `space` property row and
 * the denormalized `blocks.space_id` column every space-scoped query reads. Its
 * op carried no `from_value`, so the revert had nothing to restore and cleared
 * the column — the page left the destination space without rejoining the
 * original, dropping out of every space listing. The backend's
 * `set_property_in_tx` records the prior value, and the mock's generic
 * `set_property` handler does too; this pins that the batch writer now agrees.
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

const PAGE = '00000000000000000000PAGEZZ'
const SPACE_A = '01SPACEA000000000000000001'
const SPACE_B = '01SPACEB000000000000000001'

function spaceRow(blockId: string, spaceId: string): Record<string, unknown> {
  return {
    block_id: blockId,
    key: 'space',
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: spaceId,
    value_bool: null,
  }
}

/** A live space block, the shape `require_live_space_in_tx` demands. */
function seedSpace(spaceId: string, name: string, position: number): void {
  blocks.set(spaceId, makeBlock(spaceId, 'page', name, null, position))
  properties.set(
    spaceId,
    new Map([
      [
        'is_space',
        {
          block_id: spaceId,
          key: 'is_space',
          value_text: 'true',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      ],
    ]),
  )
}

/** A page living in SPACE_A, both ways the mock records membership. */
function seedPageInSpaceA(): void {
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0

  // Both spaces are real blocks: `move_blocks_to_space` validates its TARGET
  // once, up front, exactly as the backend does.
  seedSpace(SPACE_A, 'Space A', 1)
  seedSpace(SPACE_B, 'Space B', 1)

  const row = makeBlock(PAGE, 'page', 'Test Page', null, 0)
  row['space_id'] = SPACE_A
  blocks.set(PAGE, row)
  properties.set(PAGE, new Map([['space', spaceRow(PAGE, SPACE_A)]]))
}

function memberships(): { column: unknown; property: unknown } {
  return {
    column: blocks.get(PAGE)?.['space_id'],
    property: properties.get(PAGE)?.get('space')?.['value_ref'],
  }
}

describe('undoing a cross-space move (#5057)', () => {
  beforeEach(seedPageInSpaceA)

  it('returns the page to its original space, not to none', () => {
    expect(dispatch('move_blocks_to_space', { blockIds: [PAGE], spaceId: SPACE_B })).toBe(1)
    expect(memberships()).toEqual({ column: SPACE_B, property: SPACE_B })

    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    expect(memberships()).toEqual({ column: SPACE_A, property: SPACE_A })
  })

  it('clears both records when the page had no space to begin with', () => {
    const row = blocks.get(PAGE)
    if (row) row['space_id'] = null
    properties.get(PAGE)?.delete('space')

    expect(dispatch('move_blocks_to_space', { blockIds: [PAGE], spaceId: SPACE_B })).toBe(1)
    expect(memberships()).toEqual({ column: SPACE_B, property: SPACE_B })

    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    // `from_value: null` means "no membership before", so the revert removes
    // both records rather than inventing a space to fall back to.
    expect(memberships()).toEqual({ column: null, property: undefined })
  })
})
