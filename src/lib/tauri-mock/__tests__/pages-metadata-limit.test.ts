/**
 * #4805 — `list_pages_with_metadata` REJECTS an over-cap limit on the mock, as
 * on the backend.
 *
 * The mock used to `Math.min(limit, 100)`, and that silent clamp is how the bug
 * shipped: `PagesTreeSection` asked for 200, every mock-backed test quietly
 * received 100 and passed, and the real backend refused the call with
 * `Validation`, so the child-pages tree was dead for every user on every page.
 *
 * AGENTS.md invariant 10: "Pagination `limit` is validated, not clamped."
 * Rust twin: `list_pages_with_metadata_inner`'s `MCP_PAGE_LIMIT_CAP` guard
 * (`src-tauri/src/commands/pages/metadata.rs`).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, opLog, properties, propertyDefs } from '@/lib/tauri-mock/seed'

const SPACE = '01SPACEA000000000000000001'
const HOME = '0000000000000000000000HOMEA'

// `dispatch` is synchronous: it RETURNS the payload and THROWS the rejection,
// so these are sync assertions rather than promise ones.
function listWithLimit(limit: number): unknown {
  return dispatch('list_pages_with_metadata', {
    filter: { spaceId: SPACE, filters: [] },
    cursor: null,
    limit,
  })
}

describe('#4805 list_pages_with_metadata limit', () => {
  beforeEach(() => {
    blocks.clear()
    properties.clear()
    propertyDefs.clear()
    opLog.length = 0
    blocks.set(SPACE, makeBlock(SPACE, 'page', 'Space', null, 1))
    const home = makeBlock(HOME, 'page', 'Home', null, 2)
    home['space_id'] = SPACE
    blocks.set(HOME, home)
  })

  it('rejects a limit above the command cap instead of clamping it', () => {
    // 200 is inside the SafeLimit brand's own range (PAGINATION_MAX), which is
    // exactly why nothing on the frontend caught #4805.
    expect(() => listWithLimit(200)).toThrow(
      /list_pages_with_metadata limit must be in \[1, 100\]; got 200/,
    )
  })

  // The accept-at-cap arm is pinned in `pages-last-modified-op-log.test.ts`,
  // which dispatches at `limit: 100` and asserts the returned rows.
  it.each([0, -1, 101])('rejects out-of-range limit %i', (bad) => {
    expect(() => listWithLimit(bad)).toThrow(/must be in \[1, 100\]/)
  })
})
