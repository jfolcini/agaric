/**
 * #3091 — mock↔backend purge parity: satellite completeness, the soft-delete
 * guard, the depth cap, and reserved-value validation.
 *
 * Backend references (source of truth):
 *   - soft-delete guard + depth cap: `purge_block_inner` (crud.rs);
 *   - satellite cascade (block_tags tag_id side, block_tag_refs both FK
 *     columns, attachments): `purge_block_sql_cascade`
 *     (agaric-engine/apply/loro_apply.rs) + `purge_subtree_tables`
 *     (commands/block_cleanup.rs) + migrations 0034/0061;
 *   - reserved-value validation: `validate_reserved_property_value`
 *     (commands/properties.rs), `validate_set_property` (agaric-store/op.rs).
 *
 * Every assertion re-reads the durable store AFTER the op (the #3086
 * re-queried-effect invariant), not just the command's return value.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  attachmentBytes,
  attachments,
  blockTagRefs,
  blockTags,
  blocks,
  makeBlock,
  opLog,
  pageAliases,
  properties,
  propertyDefs,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

const PAGE = '000000000000000000000PAGE1'
const A = '0000000000000000000000000A'
const T = '0000000000000000000000000T'
const B = '0000000000000000000000000B'

function padId(n: number): string {
  return String(n).padStart(26, '0').slice(0, 26)
}

function resetMockState(): void {
  seedBlocks()
  blocks.clear()
  properties.clear()
  blockTags.clear()
  blockTagRefs.clear()
  attachments.clear()
  attachmentBytes.clear()
  pageAliases.clear()
  propertyDefs.clear()
  opLog.length = 0
  blocks.set(PAGE, makeBlock(PAGE, 'page', 'Home', null, 1))
  blocks.set(A, makeBlock(A, 'content', 'a', PAGE, 1))
  blocks.set(T, makeBlock(T, 'content', 'tag', PAGE, 2))
  blocks.set(B, makeBlock(B, 'content', 'b', PAGE, 3))
}

describe('#3091 purge parity', () => {
  beforeEach(() => {
    resetMockState()
  })

  describe('soft-delete guard', () => {
    it('rejects purging a LIVE block with invalid_operation', () => {
      let caught: unknown
      try {
        dispatch('purge_block', { blockId: A })
      } catch (e) {
        caught = e
      }
      expect((caught as { kind?: string }).kind).toBe('invalid_operation')
      expect((caught as Error).message).toContain('must be soft-deleted before purging')
      // Durable: the block is untouched.
      expect(blocks.has(A)).toBe(true)
    })

    it('rejects purging a MISSING block with not_found', () => {
      let caught: unknown
      try {
        dispatch('purge_block', { blockId: 'MISSING000000000000000000' })
      } catch (e) {
        caught = e
      }
      expect((caught as { kind?: string }).kind).toBe('not_found')
    })

    it('purges once the block is soft-deleted', () => {
      dispatch('delete_block', { blockId: A })
      const res = dispatch('purge_block', { blockId: A }) as { purged_count: number }
      expect(res.purged_count).toBe(1)
      expect(blocks.has(A)).toBe(false)
    })
  })

  describe('satellite cleanup — block_tags tag_id side (block used AS a tag)', () => {
    it('purging a tag block removes the association from every surviving block', () => {
      // A and B are both tagged with T; T is itself a block.
      blockTags.set(A, new Set([T]))
      blockTags.set(B, new Set([T]))
      dispatch('delete_block', { blockId: T })
      dispatch('purge_block', { blockId: T })
      // Durable: T is gone AND the tag_id-side rows on the SURVIVORS are gone.
      expect(blocks.has(T)).toBe(false)
      expect(blockTags.get(A)?.has(T) ?? false).toBe(false)
      expect(blockTags.get(B)?.has(T) ?? false).toBe(false)
      // Survivors themselves are intact.
      expect(blocks.has(A)).toBe(true)
      expect(blocks.has(B)).toBe(true)
    })
  })

  describe('satellite cleanup — block_tag_refs (both FK columns cascade)', () => {
    it('purging clears refs where the block is the SOURCE and where it is the TAG', () => {
      // A references T inline; B references T inline; T references A inline.
      blockTagRefs.set(A, new Set([T]))
      blockTagRefs.set(B, new Set([T]))
      blockTagRefs.set(T, new Set([A]))
      dispatch('delete_block', { blockId: T })
      dispatch('purge_block', { blockId: T })
      // source_id side: T's own ref row is gone.
      expect(blockTagRefs.has(T)).toBe(false)
      // tag_id side: T removed from every surviving source's ref set.
      expect(blockTagRefs.get(A)?.has(T) ?? false).toBe(false)
      expect(blockTagRefs.get(B)?.has(T) ?? false).toBe(false)
    })
  })

  describe('satellite cleanup — attachments + raw bytes (keyed by attachment_id)', () => {
    it('purging a block deletes its attachment rows and their bytes', () => {
      const attId = 'ATT00000000000000000000001'
      attachments.set(attId, {
        id: attId,
        block_id: A,
        filename: 'f.txt',
        mime_type: 'text/plain',
        size_bytes: 3,
        fs_path: '/mock/f.txt',
        created_at: '2026-01-01T00:00:00Z',
      })
      attachmentBytes.set(attId, [1, 2, 3])
      dispatch('delete_block', { blockId: A })
      dispatch('purge_block', { blockId: A })
      // Durable: the row (keyed by attachment_id, not block_id) AND its bytes
      // are gone — the old `attachments.delete(blockId)` no-op leaked both.
      expect(attachments.has(attId)).toBe(false)
      expect(attachmentBytes.has(attId)).toBe(false)
    })
  })

  describe('depth cap', () => {
    it('refuses a subtree >= 99 levels deep with a validation error', () => {
      // Build a chain PAGE > n0 > n1 > ... > n100 (deepest descendant at
      // depth 101 from PAGE, well past the depth-100 cap). Purge the chain root.
      let parent = PAGE
      const rootChain = padId(1000)
      blocks.set(rootChain, makeBlock(rootChain, 'content', 'r', parent, 1))
      parent = rootChain
      for (let i = 0; i < 101; i++) {
        const id = padId(2000 + i)
        blocks.set(id, makeBlock(id, 'content', `c${i}`, parent, 1))
        parent = id
      }
      // Soft-delete the chain root so the depth guard (not the soft-delete
      // guard) is what fires.
      dispatch('delete_block', { blockId: rootChain })
      let caught: unknown
      try {
        dispatch('purge_block', { blockId: rootChain })
      } catch (e) {
        caught = e
      }
      expect((caught as { kind?: string }).kind).toBe('validation')
      expect((caught as Error).message).toContain('too deep to purge (>=99 levels)')
      // Durable: nothing was purged — the root is still present.
      expect(blocks.has(rootChain)).toBe(true)
    })
  })

  describe('empty-trash (purge_all_deleted) cleans satellites uniformly', () => {
    it('removes tag_id-side rows on surviving blocks when a deleted tag is emptied', () => {
      // B (live) is tagged with A; A is soft-deleted then trash is emptied.
      blockTags.set(B, new Set([A]))
      blockTagRefs.set(B, new Set([A]))
      dispatch('delete_block', { blockId: A })
      const res = dispatch('purge_all_deleted', {}) as { affected_count: number }
      expect(res.affected_count).toBe(1)
      expect(blocks.has(A)).toBe(false)
      expect(blockTags.get(B)?.has(A) ?? false).toBe(false)
      expect(blockTagRefs.get(B)?.has(A) ?? false).toBe(false)
    })
  })

  describe('purge_blocks_by_ids cleans satellites uniformly', () => {
    it('removes tag_id-side rows on surviving blocks', () => {
      blockTags.set(B, new Set([A]))
      dispatch('delete_block', { blockId: A })
      const res = dispatch('purge_blocks_by_ids', { blockIds: [A] }) as {
        affected_count: number
      }
      expect(res.affected_count).toBe(1)
      expect(blocks.has(A)).toBe(false)
      expect(blockTags.get(B)?.has(A) ?? false).toBe(false)
    })
  })
})

describe('#3091 reserved-value validation (no normalization)', () => {
  beforeEach(() => {
    resetMockState()
  })

  it('rejects a lowercase todo_state (case-sensitive membership, not normalized)', () => {
    let caught: unknown
    try {
      dispatch('set_property', { blockId: A, key: 'todo_state', value: { value_text: 'done' } })
    } catch (e) {
      caught = e
    }
    expect((caught as { kind?: string }).kind).toBe('validation')
    // Durable: the column was NOT written (neither raw nor upper-cased).
    expect(blocks.get(A)?.['todo_state']).toBeNull()
  })

  it('accepts a canonical todo_state and stores it verbatim', () => {
    dispatch('set_property', { blockId: A, key: 'todo_state', value: { value_text: 'DONE' } })
    expect(blocks.get(A)?.['todo_state']).toBe('DONE')
  })

  it('rejects an empty due_date (set_property.value_date.empty)', () => {
    let caught: unknown
    try {
      dispatch('set_property', { blockId: A, key: 'due_date', value: { value_date: '   ' } })
    } catch (e) {
      caught = e
    }
    expect((caught as { kind?: string }).kind).toBe('validation')
    expect((caught as Error).message).toContain('value_date.empty')
    expect(blocks.get(A)?.['due_date']).toBeNull()
  })

  it('rejects a lowercase todo_state via set_property_batch', () => {
    expect(() =>
      dispatch('set_property_batch', { blockIds: [A], key: 'todo_state', value: 'done' }),
    ).toThrow()
    expect(blocks.get(A)?.['todo_state']).toBeNull()
  })

  it('rejects a lowercase todo_state at create time (create_blocks_batch)', () => {
    expect(() =>
      dispatch('create_blocks_batch', {
        specs: [
          {
            parentId: PAGE,
            blockType: 'content',
            content: 'x',
            properties: { todo_state: 'done' },
          },
        ],
      }),
    ).toThrow()
  })
})
