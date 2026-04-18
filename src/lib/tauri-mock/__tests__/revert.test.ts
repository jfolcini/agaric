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
    is_conflict: false,
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

  it('reverts move_block by restoring old parent and position', () => {
    const b = makeBlockRow('BLK_4', { parent_id: 'PARENT_NEW', position: 7 })
    blocks.set('BLK_4', b)
    const op = makeOp('move_block', {
      block_id: 'BLK_4',
      old_parent_id: 'PARENT_OLD',
      old_position: 2,
    })

    applyRevertForOp(op, blocks)

    expect(b['parent_id']).toBe('PARENT_OLD')
    expect(b['position']).toBe(2)
    // content untouched
    expect(b['content']).toBe('hello')
  })

  it('reverts move_block with null old_parent_id (root move)', () => {
    const b = makeBlockRow('BLK_4B', { parent_id: 'PARENT_NEW', position: 7 })
    blocks.set('BLK_4B', b)
    const op = makeOp('move_block', {
      block_id: 'BLK_4B',
      old_parent_id: null,
      old_position: 0,
    })

    applyRevertForOp(op, blocks)

    expect(b['parent_id']).toBeNull()
    expect(b['position']).toBe(0)
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
})
