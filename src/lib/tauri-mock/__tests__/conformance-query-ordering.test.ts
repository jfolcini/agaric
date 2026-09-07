/**
 * #4670 — the ordering rule of `runQuerySteps`, TS half.
 *
 * `rows` is compared in the order the command returned it; a step opts out with
 * `"unordered": "<reason>"`. The twin cases live in `conformance_query.rs`'s
 * `query_runner_context_tests` (`a_reasonless_unordered_opt_out_is_rejected`,
 * `a_blank_unordered_reason_is_rejected`), which panic where these throw.
 *
 * The pair that matters is the first two: a gate tested only on the inputs it
 * rejects says nothing about whether it still lets the ordered comparison
 * through, and one tested only on what it accepts says nothing about the
 * escape hatch it exists to close.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  CONFORMANCE_SPACE_ID,
  runQuerySteps,
  stampMockSpace,
} from '@/lib/tauri-mock/__tests__/conformance-query'
import { blocks, makeBlock, properties } from '@/lib/tauri-mock/seed'

/**
 * One step over the seeded space with no `sort`, so the engine's terminal
 * `b.id DESC` tiebreaker (`resolve_sort`) decides: `P1` before `C1`. The two
 * ids sort the OTHER way canonically, which is what makes the ordered and the
 * unordered projections distinguishable at all.
 */
const flatStep = {
  name: 'flat_no_group',
  command: 'run_advanced_query',
  args: { request: { spaceId: CONFORMANCE_SPACE_ID, limit: 100 } },
}

describe('runQuerySteps compares rows in order unless a step names a reason', () => {
  beforeEach(() => {
    blocks.clear()
    properties.clear()
    blocks.set('P1', makeBlock('P1', 'page', 'Page One', null, 0))
    blocks.set('C1', makeBlock('C1', 'content', 'A child', 'P1', 1))
    stampMockSpace()
  })

  it('keeps the returned order when the step says nothing', async () => {
    const out = await runQuerySteps([flatStep], new Map())
    expect(out[0]?.rows).toEqual(['P1', 'C1'])
  })

  it('canonically sorts a step that names why the order is not comparable', async () => {
    const out = await runQuerySteps(
      [{ ...flatStep, unordered: 'the two stacks mint different ids for these rows' }],
      new Map(),
    )
    expect(out[0]?.rows).toEqual(['C1', 'P1'])
  })

  // `"unordered": true` is the old opt-in wearing the new key's name: it reads
  // as "declared" to any truthiness test and would buy the weaker comparison
  // for nothing.
  it('rejects a reasonless opt-out', async () => {
    await expect(
      runQuerySteps([{ ...flatStep, unordered: true } as never], new Map()),
    ).rejects.toThrow(/`unordered` must be a NON-EMPTY reason string/)
  })

  it('rejects a blank reason', async () => {
    await expect(runQuerySteps([{ ...flatStep, unordered: '   ' }], new Map())).rejects.toThrow(
      /`unordered` must be a NON-EMPTY reason string/,
    )
  })
})
