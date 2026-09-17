/**
 * #5057 — the one field of `get_compaction_status` that
 * `op_log_compaction.json` cannot project.
 *
 * `oldest_op_date` is `MIN(op_log.created_at)` in epoch ms, a clock reading
 * taken while a fixture replays, so a backend-authored expectation would bind
 * to the millisecond it was written on. The other three counters are pinned
 * there; this one is pinned here, against the backend's SQL rather than against
 * the backend itself.
 *
 * Two things were wrong and only the second is visible from a single op: the
 * mock answered `opLog[0].created_at`, an ISO STRING where
 * `CompactionStatus.oldest_op_date` is `number | null` and `CompactionCard`
 * hands it to `new Date(...)`, taken at the position the first op was PUSHED
 * rather than at the minimum — and the seed pushes older ops after newer ones
 * (`stampPageLastEdited`), which is exactly the shape that separates the two.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { opLog, pushOpAt, seedBlocks } from '@/lib/tauri-mock/seed'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const NEWER = '2025-06-01T00:00:00.000Z'
const OLDER = '2024-01-01T00:00:00.000Z'

describe('get_compaction_status (mock-internal)', () => {
  beforeEach(() => {
    seedBlocks()
    opLog.length = 0
  })

  it('reports the oldest op as epoch ms, whatever order the ops were pushed in', () => {
    pushOpAt('edit_block', { block_id: 'B1' }, NEWER)
    pushOpAt('edit_block', { block_id: 'B1' }, OLDER)

    const status = dispatch('get_compaction_status', {}) as Record<string, unknown>

    expect(status['oldest_op_date']).toBe(Date.parse(OLDER))
    expect(status['total_ops']).toBe(2)
  })

  it('reports no oldest op for an empty log', () => {
    const status = dispatch('get_compaction_status', {}) as Record<string, unknown>

    expect(status['oldest_op_date']).toBeNull()
    expect(status['total_ops']).toBe(0)
  })
})
