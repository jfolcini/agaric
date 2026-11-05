/**
 * #6057 — the mock's `list_quarantined_sync_slots` mirrors
 * `list_quarantined_sync_slots_inner`: a limit outside `[1, 100]` is a
 * Validation error, rows come newest first by `(quarantined_at_ms, id)`, the
 * limit caps the rows but not `total`, and the rows are copies.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { QuarantinedSlotList } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { addMockQuarantinedSlot, seedBlocks, syncQuarantine } from '@/lib/tauri-mock/seed'

function list(limit: number): QuarantinedSlotList {
  return dispatch('list_quarantined_sync_slots', { limit }) as QuarantinedSlotList
}

describe('list_quarantined_sync_slots (mock)', () => {
  beforeEach(() => {
    seedBlocks()
  })

  it('lists newest first, breaking a tie by id, and caps rows but not the total', () => {
    const a = addMockQuarantinedSlot({ quarantined_at_ms: 2_000 })
    const b = addMockQuarantinedSlot({ quarantined_at_ms: 1_000 })
    const c = addMockQuarantinedSlot({ quarantined_at_ms: 2_000 })

    expect(list(100).slots.map((s) => s.id)).toEqual([c.id, a.id, b.id])
    const capped = list(2)
    expect(capped.slots.map((s) => s.id)).toEqual([c.id, a.id])
    expect(capped.total).toBe(3)
  })

  it.each([0, 101])('rejects limit %i as a validation error', (limit) => {
    expect(() => list(limit)).toThrow(
      expect.objectContaining({
        kind: 'validation',
        message: `list_quarantined_sync_slots limit must be in [1, 100]; got ${limit}`,
      }),
    )
  })

  it('returns copies, and a reset clears the quarantine', () => {
    const seeded = addMockQuarantinedSlot({ space_id: 'SPACE_A' })
    const [row] = list(100).slots
    if (!row) throw new Error('expected one row')
    row.space_id = 'MUTATED'
    expect(syncQuarantine.get(seeded.id)?.space_id).toBe('SPACE_A')

    seedBlocks()
    expect(list(100)).toEqual({ slots: [], total: 0 })
  })
})

describe('readmit_quarantined_sync_slot (mock)', () => {
  beforeEach(() => {
    seedBlocks()
  })

  it('takes the row out of the list and leaves the others', () => {
    const kept = addMockQuarantinedSlot({ quarantined_at_ms: 1_000 })
    const retried = addMockQuarantinedSlot({ quarantined_at_ms: 2_000 })

    dispatch('readmit_quarantined_sync_slot', { id: retried.id })

    expect(list(100)).toEqual({ slots: [kept], total: 1 })
  })

  it('rejects an unknown id as not found and changes nothing', () => {
    const kept = addMockQuarantinedSlot()

    expect(() => dispatch('readmit_quarantined_sync_slot', { id: kept.id + 1 })).toThrow(
      expect.objectContaining({
        kind: 'not_found',
        message: `quarantined sync slot ${kept.id + 1}`,
      }),
    )
    expect(list(100)).toEqual({ slots: [kept], total: 1 })
  })
})
