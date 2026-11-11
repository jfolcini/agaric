// Vitest tests for `dealSpecs` in `wdio.conf.ts`, which orders the real-backend
// specs so wdio's `--shard i/n` slices take about the same time.

import { describe, expect, it } from 'vitest'

import { dealSpecs } from '../wdio.conf'

/** The specs wdio runs as shard `current` of `total`, cut as `ConfigParser.shard` does. */
function wdioShard(specs: string[], current: number, total: number): string[] {
  const per = Math.max(Math.round(specs.length / total), 1)
  return specs.slice((current - 1) * per, current === total ? undefined : current * per)
}

/** Each shard's seconds when wdio slices `specs` into `total` shards. */
function shardSeconds(specs: string[], total: number, seconds: Record<string, number>): number[] {
  return Array.from({ length: total }, (_unused, i) =>
    wdioShard(specs, i + 1, total).reduce((sum, spec) => sum + (seconds[spec] ?? 0), 0),
  )
}

const SECONDS = { a: 9, b: 8, c: 7, d: 3, e: 2, f: 2, g: 1 }
const SPECS = Object.keys(SECONDS)

describe('dealSpecs', () => {
  it('gives each of wdio’s shards about the same time', () => {
    expect(shardSeconds(dealSpecs(SPECS, 3, SECONDS), 3, SECONDS)).toEqual([11, 10, 11])
  })

  it('runs every spec exactly once across the shards', () => {
    const dealt = dealSpecs(SPECS, 3, SECONDS)
    const run = [1, 2, 3].flatMap((shard) => wdioShard(dealt, shard, 3))
    expect(run.toSorted()).toEqual(SPECS)
  })

  it('counts a spec it has no time for as the median of the known ones', () => {
    // Known times 9, 8, 1: median 8. Counted as 8, `new` pairs with `b` and
    // `a` with `g`: 16 and 10. Counted as nothing, it would join `g` instead.
    const seconds = { a: 9, b: 8, g: 1 }
    const dealt = dealSpecs(['a', 'b', 'g', 'new'], 2, seconds)
    expect([wdioShard(dealt, 1, 2), wdioShard(dealt, 2, 2)]).toEqual([
      ['a', 'g'],
      ['b', 'new'],
    ])
  })

  it('leaves the order alone for a single shard', () => {
    expect(dealSpecs(['b', 'a'], 1, SECONDS)).toEqual(['b', 'a'])
  })
})
