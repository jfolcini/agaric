/**
 * #4667 — `get_backlinks` REJECTS an out-of-range limit on the mock, as on the
 * backend.
 *
 * `get_backlinks_inner` goes through `pagination::PageRequest::new`, which
 * returns `AppError::Validation` for anything outside `[1, MAX_PAGE_SIZE]`
 * rather than clamping (`agaric-store/src/pagination/mod.rs`). The mock used to
 * ignore `limit` entirely, so it answered where the backend errors — the #4805
 * shape, and AGENTS.md invariant 10: "Pagination `limit` is validated, not
 * clamped."
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, opLog, properties } from '@/lib/tauri-mock/seed'

const SPACE = '01SPACEA000000000000000001'
const TARGET = '0000000000000000000TARGETA'
const SOURCE = '0000000000000000000SOURCEA'

// `dispatch` is synchronous: it RETURNS the payload and THROWS the rejection.
function backlinksWithLimit(limit: number | null): unknown {
  return dispatch('get_backlinks', {
    blockId: TARGET,
    cursor: null,
    limit,
    scope: { kind: 'active', space_id: SPACE },
  })
}

describe('#4667 get_backlinks limit', () => {
  beforeEach(() => {
    blocks.clear()
    properties.clear()
    opLog.length = 0
    blocks.set(SPACE, makeBlock(SPACE, 'page', 'Space', null, 1))
    for (const [id, content] of [
      [TARGET, 'Target'],
      [SOURCE, `links to [[${TARGET}]]`],
    ] as const) {
      blocks.set(id, makeBlock(id, 'page', content, null, 1))
      // `inSpaceScope` reads the owning page's `space` REF property, not a
      // column (`ownerSpaceOf` in handlers/shared.ts).
      properties.set(
        id,
        new Map([
          [
            'space',
            {
              key: 'space',
              value_text: null,
              value_num: null,
              value_date: null,
              value_ref: SPACE,
              value_bool: null,
            },
          ],
        ]),
      )
    }
  })

  it('accepts a limit at the cap', () => {
    expect(backlinksWithLimit(200)).toMatchObject({ items: [{ id: SOURCE }] })
  })

  it('defaults a null limit to the backend page size', () => {
    expect(backlinksWithLimit(null)).toMatchObject({ items: [{ id: SOURCE }] })
  })

  it.each([0, -1, 201])('rejects out-of-range limit %i', (bad) => {
    expect(() => backlinksWithLimit(bad)).toThrow(/pagination limit must be in \[1, 200\]/)
  })
})
