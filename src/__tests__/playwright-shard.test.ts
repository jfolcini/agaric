import { describe, expect, it } from 'vitest'

// @ts-expect-error — no type declarations for the .mjs script.
import { dealSpecFiles, secondsFromReport } from '../../scripts/playwright-shard.mjs'

const SECONDS = { a: 9, b: 8, c: 7, d: 3, e: 2, f: 2, g: 1 }
const FILES = Object.keys(SECONDS)

function shardSeconds(shards: string[][], seconds: Record<string, number>): number[] {
  return shards.map((files) => files.reduce((sum, file) => sum + (seconds[file] ?? 0), 0))
}

describe('dealSpecFiles', () => {
  it('gives each shard about the same time', () => {
    expect(shardSeconds(dealSpecFiles(FILES, 3, SECONDS), SECONDS)).toEqual([11, 11, 10])
  })

  it('puts every file in exactly one shard', () => {
    const shards: string[][] = dealSpecFiles(FILES, 3, SECONDS)
    expect(shards.flat().toSorted()).toEqual(FILES)
  })

  it('counts a file it has no time for as the median of the known ones', () => {
    // Known times 9, 8, 1: median 8. Counted as 8, `new` pairs with `b` and
    // `a` with `g`. Counted as nothing, it would join `a` instead.
    expect(dealSpecFiles(['a', 'b', 'g', 'new'], 2, { a: 9, b: 8, g: 1 })).toEqual([
      ['a', 'g'],
      ['b', 'new'],
    ])
  })
})

describe('secondsFromReport', () => {
  const result = (status: string, duration: number) => ({ status, duration })

  it('sums the passed runs of each file, nested suites included', () => {
    const report = {
      suites: [
        {
          specs: [{ file: 'a.spec.ts', tests: [{ results: [result('passed', 1500)] }] }],
          suites: [
            {
              specs: [
                {
                  file: 'a.spec.ts',
                  tests: [{ results: [result('passed', 2000), result('failed', 9000)] }],
                },
                { file: 'b.spec.ts', tests: [{ results: [result('passed', 200)] }] },
              ],
            },
          ],
        },
      ],
    }
    expect(secondsFromReport(report)).toEqual({ 'e2e/a.spec.ts': 4, 'e2e/b.spec.ts': 1 })
  })

  it('leaves out a file with no passed run, so it counts as the median', () => {
    const report = {
      suites: [{ specs: [{ file: 'a.spec.ts', tests: [{ results: [result('failed', 50)] }] }] }],
    }
    expect(secondsFromReport(report)).toEqual({})
  })
})
