/**
 * #5057 — what `op_log_compaction.json` cannot project about the compaction
 * pair, which for `compact_op_log_cmd` is its entire delete path.
 *
 * `oldest_op_date` is `MIN(op_log.created_at)` in epoch ms, a clock reading
 * taken while a fixture replays, so a backend-authored expectation would bind
 * to the millisecond it was written on. `eligible_ops` is pinned there, but
 * only at zero: every op a fixture replays is minted during the run, so the
 * arm that COUNTS — an op older than `now() - DEFAULT_RETENTION_DAYS` — is out
 * of that corpus's reach, and pinning one arm of the pair is the half-cover
 * AGENTS.md names. Both are pinned here instead, against the backend's SQL
 * rather than against the backend itself.
 *
 * Two things were wrong and only the second is visible from a single op: the
 * mock answered `opLog[0].created_at`, an ISO STRING where
 * `CompactionStatus.oldest_op_date` is `number | null` and `CompactionCard`
 * hands it to `new Date(...)`, taken at the position the first op was PUSHED
 * rather than at the minimum — and the seed pushes older ops after newer ones
 * (`stampPageLastEdited`), which is exactly the shape that separates the two.
 *
 * The same clock bound puts `compact_op_log_cmd`'s PURGE out of the corpus's
 * reach: the fixture pins `ops_deleted = 0` on a log where nothing can be
 * eligible, so the branch that deletes is pinned here or nowhere. Invariant 1
 * names compaction as the one exception to the append-only op log, so this is
 * the only mock path allowed to shorten `opLog`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { opLog, pushOpAt, seedBlocks } from '@/lib/tauri-mock/seed'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const NEWER = '2025-06-01T00:00:00.000Z'
const OLDER = '2024-01-01T00:00:00.000Z'

/** Exact 24-hour days back from now, the way the backend's cutoff is built
 *  (`chrono::Duration::days`) — not the seed's calendar-day `offsetIso`. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

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

  it('counts an op past the retention window as eligible and a fresh one as not', () => {
    pushOpAt('edit_block', { block_id: 'B1' }, isoDaysAgo(91))
    pushOpAt('edit_block', { block_id: 'B1' }, isoDaysAgo(89))
    pushOpAt('edit_block', { block_id: 'B1' }, isoDaysAgo(0))

    const status = dispatch('get_compaction_status', {}) as Record<string, unknown>

    expect(status['eligible_ops']).toBe(1)
    expect(status['total_ops']).toBe(3)
    expect(status['retention_days']).toBe(90)
  })

  it('reports no oldest op for an empty log', () => {
    const status = dispatch('get_compaction_status', {}) as Record<string, unknown>

    expect(status['oldest_op_date']).toBeNull()
    expect(status['total_ops']).toBe(0)
  })
})

describe('compact_op_log_cmd (mock-internal)', () => {
  beforeEach(() => {
    seedBlocks()
    opLog.length = 0
  })

  it('deletes exactly the ops past the window and keeps the rest', () => {
    pushOpAt('edit_block', { block_id: 'B1' }, isoDaysAgo(120))
    pushOpAt('edit_block', { block_id: 'B1' }, isoDaysAgo(91))
    const fresh = pushOpAt('edit_block', { block_id: 'B1' }, isoDaysAgo(1))

    const result = dispatch('compact_op_log_cmd', { retentionDays: 90 }) as Record<string, unknown>

    expect(result['ops_deleted']).toBe(2)
    // Re-queried, not inferred from the return value: the purge has to have
    // reached the log the next command reads.
    expect(opLog.map((op) => op.seq)).toEqual([fresh.seq])
    expect(dispatch('get_compaction_status', {})).toMatchObject({
      total_ops: 1,
      eligible_ops: 0,
    })
  })

  it('purges against the window it was given, not the one the status reports', () => {
    pushOpAt('edit_block', { block_id: 'B1' }, isoDaysAgo(30))

    // The 90-day status counts this op as nothing to do; a 7-day compaction
    // still takes it, which is why the cutoff reads the argument.
    expect(dispatch('get_compaction_status', {})).toMatchObject({ eligible_ops: 0 })

    const result = dispatch('compact_op_log_cmd', { retentionDays: 7 }) as Record<string, unknown>

    expect(result['ops_deleted']).toBe(1)
    expect(opLog).toHaveLength(0)
  })

  it('leaves the log untouched when it refuses the window', () => {
    pushOpAt('edit_block', { block_id: 'B1' }, isoDaysAgo(120))

    expect(() => dispatch('compact_op_log_cmd', { retentionDays: 6 })).toThrow()

    // The floor is checked before any work, so the op it would otherwise have
    // been well past the cutoff for is still there.
    expect(opLog).toHaveLength(1)
  })
})
