import { beforeEach, describe, expect, it } from 'vitest'

import { applyRevertForOp } from '../revert'
import type { MockOpLogEntry } from '../seed'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOp(
  opType: string,
  payload: Record<string, unknown>,
  overrides: Partial<MockOpLogEntry> = {},
): MockOpLogEntry {
  return {
    device_id: 'test-device',
    seq: 1,
    op_type: opType,
    payload: JSON.stringify(payload),
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeBlockRow(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    block_type: 'content',
    content: 'hello',
    parent_id: 'PARENT_A',
    page_id: 'PARENT_A',
    position: 3,
    deleted_at: null,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyRevertForOp', () => {
  let blocks: Map<string, Record<string, unknown>>

  beforeEach(() => {
    blocks = new Map()
  })

  it('reverts create_block by setting deleted_at', () => {
    const b = makeBlockRow('BLK_1')
    blocks.set('BLK_1', b)
    const op = makeOp('create_block', { block_id: 'BLK_1' })

    applyRevertForOp(op, blocks)

    expect(typeof b['deleted_at']).toBe('string')
    // Not a truthy-checked assertion — verify it's an ISO date-like string.
    expect((b['deleted_at'] as string).length).toBeGreaterThan(0)
    // Other fields untouched
    expect(b['content']).toBe('hello')
    expect(b['parent_id']).toBe('PARENT_A')
    expect(b['position']).toBe(3)
  })

  it('reverts delete_block by clearing deleted_at', () => {
    const b = makeBlockRow('BLK_2', { deleted_at: '2024-12-31T00:00:00.000Z' })
    blocks.set('BLK_2', b)
    const op = makeOp('delete_block', { block_id: 'BLK_2' })

    applyRevertForOp(op, blocks)

    expect(b['deleted_at']).toBeNull()
    expect(b['content']).toBe('hello')
  })

  it('reverts edit_block by restoring from_text into content', () => {
    const b = makeBlockRow('BLK_3', { content: 'new text' })
    blocks.set('BLK_3', b)
    const op = makeOp('edit_block', { block_id: 'BLK_3', from_text: 'old text' })

    applyRevertForOp(op, blocks)

    expect(b['content']).toBe('old text')
  })

  it('reverts edit_block with null from_text to null content', () => {
    const b = makeBlockRow('BLK_3B', { content: 'new text' })
    blocks.set('BLK_3B', b)
    const op = makeOp('edit_block', { block_id: 'BLK_3B', from_text: null })

    applyRevertForOp(op, blocks)

    expect(b['content']).toBeNull()
  })

  it('reverts move_block by restoring old parent and renumbering to a dense rank', () => {
    // Lone child of PARENT_OLD → dense renumber collapses to position 1.
    const b = makeBlockRow('BLK_4', { parent_id: 'PARENT_NEW', position: 7 })
    blocks.set('BLK_4', b)
    const op = makeOp('move_block', {
      block_id: 'BLK_4',
      old_parent_id: 'PARENT_OLD',
      old_position: 2,
    })

    applyRevertForOp(op, blocks)

    expect(b['parent_id']).toBe('PARENT_OLD')
    // #958 — dense 1-based rank, not the raw old_position.
    expect(b['position']).toBe(1)
    // content untouched
    expect(b['content']).toBe('hello')
  })

  it('reverts move_block with null old_parent_id (root move) to a dense rank', () => {
    const b = makeBlockRow('BLK_4B', { parent_id: 'PARENT_NEW', position: 7 })
    blocks.set('BLK_4B', b)
    const op = makeOp('move_block', {
      block_id: 'BLK_4B',
      old_parent_id: null,
      old_position: 0,
    })

    applyRevertForOp(op, blocks)

    expect(b['parent_id']).toBeNull()
    // #958 — lone root child collapses to dense rank 1.
    expect(b['position']).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // #958 — reverting a reorder must restore the ORDER, not just write a raw
  // position that collides with the sibling now in the old slot. Without the
  // renumber, both blocks share a position and the load order (position ASC,
  // id ASC) breaks → order fails to revert in place.
  // ---------------------------------------------------------------------------

  it('reverts a same-parent reorder so the two siblings end at distinct dense ranks', () => {
    // Pre-move: A at slot 0 (pos 1), B at slot 1 (pos 2).
    // Forward "move A down" renumbered to B=1, A=2. Now undo A's move.
    // ZZ_A > AA_B lexically, so a raw old_position=1 write would collide
    // (both pos 1) and the id-tiebreak would keep B first — the bug.
    const a = makeBlockRow('ZZ_A', { parent_id: 'P', page_id: 'P', position: 2 })
    const bsib = makeBlockRow('AA_B', { parent_id: 'P', page_id: 'P', position: 1 })
    blocks.set('ZZ_A', a)
    blocks.set('AA_B', bsib)

    const op = makeOp('move_block', {
      block_id: 'ZZ_A',
      old_parent_id: 'P',
      old_position: 1,
      new_parent_id: 'P',
      new_position: 2,
    })

    applyRevertForOp(op, blocks)

    // Distinct dense ranks, A before B (the reverted order).
    expect(a['position']).toBe(1)
    expect(bsib['position']).toBe(2)
    expect(a['position']).not.toBe(bsib['position'])
  })

  it('reverts a reparent (dedent) so source and destination groups are both dense', () => {
    // Tree before undo (post-dedent): CHILD is at root next to PARENT.
    //   PARENT (root, pos 1) ; CHILD (root, pos 2)
    // The forward op was a dedent of CHILD out of PARENT. Undo re-nests CHILD
    // under PARENT and must renumber BOTH root (PARENT alone) and PARENT's
    // children (CHILD alone) to dense ranks.
    const parent = makeBlockRow('PARENT', { parent_id: null, page_id: 'PG', position: 1 })
    const child = makeBlockRow('CHILD', { parent_id: null, page_id: 'PG', position: 2 })
    blocks.set('PARENT', parent)
    blocks.set('CHILD', child)

    const op = makeOp('move_block', {
      block_id: 'CHILD',
      old_parent_id: 'PARENT',
      old_position: 1,
      new_parent_id: null,
      new_position: 2,
    })

    applyRevertForOp(op, blocks)

    // CHILD re-nested under PARENT at dense rank 1.
    expect(child['parent_id']).toBe('PARENT')
    expect(child['position']).toBe(1)
    // Root group renumbered (PARENT alone → rank 1).
    expect(parent['position']).toBe(1)
  })

  it('reverts restore_block by setting deleted_at', () => {
    const b = makeBlockRow('BLK_5', { deleted_at: null })
    blocks.set('BLK_5', b)
    const op = makeOp('restore_block', { block_id: 'BLK_5' })

    applyRevertForOp(op, blocks)

    expect(typeof b['deleted_at']).toBe('string')
    expect((b['deleted_at'] as string).length).toBeGreaterThan(0)
  })

  it('is a no-op for unknown op types', () => {
    const b = makeBlockRow('BLK_6')
    blocks.set('BLK_6', b)
    const snapshotBefore = { ...b }
    const op = makeOp('frobulate_block', { block_id: 'BLK_6' })

    expect(() => {
      applyRevertForOp(op, blocks)
    }).not.toThrow()

    expect(b).toEqual(snapshotBefore)
    expect(blocks.size).toBe(1)
  })

  it('is a no-op when target block is missing from the map', () => {
    // Empty map — block referenced in payload does not exist.
    const op = makeOp('edit_block', { block_id: 'MISSING', from_text: 'old' })

    expect(() => {
      applyRevertForOp(op, blocks)
    }).not.toThrow()

    expect(blocks.size).toBe(0)
  })

  it('only mutates the targeted block, leaving siblings untouched', () => {
    const target = makeBlockRow('BLK_T', { content: 'new' })
    const sibling = makeBlockRow('BLK_S', { content: 'sibling content' })
    blocks.set('BLK_T', target)
    blocks.set('BLK_S', sibling)
    const siblingSnapshot = { ...sibling }

    const op = makeOp('edit_block', { block_id: 'BLK_T', from_text: 'old' })
    applyRevertForOp(op, blocks)

    expect(target['content']).toBe('old')
    expect(sibling).toEqual(siblingSnapshot)
  })

  // ---------------------------------------------------------------------------
  // TEST-3: task-property setters (revert to from_state / from_level / from_date)
  // ---------------------------------------------------------------------------

  it('reverts set_todo_state by restoring from_state on the block row', () => {
    const b = makeBlockRow('BLK_T1', { todo_state: 'DONE' })
    blocks.set('BLK_T1', b)
    const op = makeOp('set_todo_state', {
      block_id: 'BLK_T1',
      state: 'DONE',
      from_state: 'TODO',
    })

    applyRevertForOp(op, blocks)

    expect(b['todo_state']).toBe('TODO')
  })

  it('reverts set_todo_state with null from_state to null', () => {
    const b = makeBlockRow('BLK_T2', { todo_state: 'TODO' })
    blocks.set('BLK_T2', b)
    const op = makeOp('set_todo_state', { block_id: 'BLK_T2', state: 'TODO', from_state: null })

    applyRevertForOp(op, blocks)

    expect(b['todo_state']).toBeNull()
  })

  it('reverts set_priority by restoring from_level on the block row', () => {
    const b = makeBlockRow('BLK_P1', { priority: 'A' })
    blocks.set('BLK_P1', b)
    const op = makeOp('set_priority', { block_id: 'BLK_P1', level: 'A', from_level: 'C' })

    applyRevertForOp(op, blocks)

    expect(b['priority']).toBe('C')
  })

  it('reverts set_due_date by restoring from_date on the block row', () => {
    const b = makeBlockRow('BLK_D1', { due_date: '2025-12-25' })
    blocks.set('BLK_D1', b)
    const op = makeOp('set_due_date', {
      block_id: 'BLK_D1',
      date: '2025-12-25',
      from_date: '2025-01-01',
    })

    applyRevertForOp(op, blocks)

    expect(b['due_date']).toBe('2025-01-01')
  })

  it('reverts set_scheduled_date by restoring from_date on the block row', () => {
    const b = makeBlockRow('BLK_S1', { scheduled_date: '2025-06-01' })
    blocks.set('BLK_S1', b)
    const op = makeOp('set_scheduled_date', {
      block_id: 'BLK_S1',
      date: '2025-06-01',
      from_date: null,
    })

    applyRevertForOp(op, blocks)

    expect(b['scheduled_date']).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // TEST-3: property map mutations (set_property / delete_property)
  // ---------------------------------------------------------------------------

  it('reverts set_property by restoring the prior typed value', () => {
    const b = makeBlockRow('BLK_PR1')
    blocks.set('BLK_PR1', b)
    const properties = new Map<string, Map<string, Record<string, unknown>>>()
    properties.set(
      'BLK_PR1',
      new Map([
        [
          'effort',
          { key: 'effort', value_text: null, value_num: 5, value_date: null, value_ref: null },
        ],
      ]),
    )
    const op = makeOp('set_property', {
      block_id: 'BLK_PR1',
      key: 'effort',
      from_value: { value_text: null, value_num: 3, value_date: null, value_ref: null },
    })

    applyRevertForOp(op, blocks, { properties })

    expect(properties.get('BLK_PR1')?.get('effort')?.['value_num']).toBe(3)
  })

  it('reverts set_property with null from_value by removing the property', () => {
    const b = makeBlockRow('BLK_PR2')
    blocks.set('BLK_PR2', b)
    const properties = new Map<string, Map<string, Record<string, unknown>>>()
    properties.set(
      'BLK_PR2',
      new Map([
        [
          'note',
          { key: 'note', value_text: 'hi', value_num: null, value_date: null, value_ref: null },
        ],
      ]),
    )
    const op = makeOp('set_property', {
      block_id: 'BLK_PR2',
      key: 'note',
      from_value: null,
    })

    applyRevertForOp(op, blocks, { properties })

    expect(properties.get('BLK_PR2')?.has('note')).toBe(false)
  })

  it('reverts delete_property by re-adding the prior typed value', () => {
    const b = makeBlockRow('BLK_PR3')
    blocks.set('BLK_PR3', b)
    const properties = new Map<string, Map<string, Record<string, unknown>>>()
    // Property is currently absent (was just deleted).
    const op = makeOp('delete_property', {
      block_id: 'BLK_PR3',
      key: 'tags',
      from_value: {
        value_text: 'urgent',
        value_num: null,
        value_date: null,
        value_ref: null,
      },
    })

    applyRevertForOp(op, blocks, { properties })

    expect(properties.get('BLK_PR3')?.get('tags')?.['value_text']).toBe('urgent')
  })

  it('property reverts no-op silently when state.properties is missing', () => {
    const b = makeBlockRow('BLK_PR4')
    blocks.set('BLK_PR4', b)
    const op = makeOp('set_property', {
      block_id: 'BLK_PR4',
      key: 'k',
      from_value: { value_text: 'x', value_num: null, value_date: null, value_ref: null },
    })

    expect(() => {
      applyRevertForOp(op, blocks)
    }).not.toThrow()
  })

  // ---------------------------------------------------------------------------
  // TEST-3: tag map mutations (add_tag / remove_tag)
  // ---------------------------------------------------------------------------

  it('reverts add_tag by removing the tag from the block', () => {
    const b = makeBlockRow('BLK_TG1')
    blocks.set('BLK_TG1', b)
    const blockTags = new Map<string, Set<string>>()
    blockTags.set('BLK_TG1', new Set(['TAG_A', 'TAG_B']))
    const op = makeOp('add_tag', { block_id: 'BLK_TG1', tag_id: 'TAG_B' })

    applyRevertForOp(op, blocks, { blockTags })

    expect(blockTags.get('BLK_TG1')?.has('TAG_B')).toBe(false)
    // Other tags untouched
    expect(blockTags.get('BLK_TG1')?.has('TAG_A')).toBe(true)
  })

  it('reverts remove_tag by re-adding the tag to the block', () => {
    const b = makeBlockRow('BLK_TG2')
    blocks.set('BLK_TG2', b)
    const blockTags = new Map<string, Set<string>>()
    blockTags.set('BLK_TG2', new Set(['TAG_A']))
    const op = makeOp('remove_tag', { block_id: 'BLK_TG2', tag_id: 'TAG_C' })

    applyRevertForOp(op, blocks, { blockTags })

    expect(blockTags.get('BLK_TG2')?.has('TAG_C')).toBe(true)
    expect(blockTags.get('BLK_TG2')?.has('TAG_A')).toBe(true)
  })

  it('tag reverts no-op silently when state.blockTags is missing', () => {
    const b = makeBlockRow('BLK_TG3')
    blocks.set('BLK_TG3', b)
    const op = makeOp('add_tag', { block_id: 'BLK_TG3', tag_id: 'TAG_X' })

    expect(() => {
      applyRevertForOp(op, blocks)
    }).not.toThrow()
  })
})
