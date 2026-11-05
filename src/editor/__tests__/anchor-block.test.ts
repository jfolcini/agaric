/**
 * #6033 — the block a typed `[[Page#anchor]]` names: `anchorBlockIn` over a
 * page's subtree, and `findAnchorBlock`, which loads it. How a heading's text
 * compares is pinned to Rust by `reference-tokens-conformance.test.ts`.
 */

import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow } from '@/__tests__/fixtures'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { anchorBlockIn, findAnchorBlock } from '@/editor/anchor-block'
import type { BlockRow, PageSubtree } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { useSpaceStore } from '@/stores/space'

const PAGE = '01PAGE00000000000000000000'

const row = (id: string, content: string, parent = PAGE, position = 1): BlockRow =>
  makeBlockRow({ id, content, parent_id: parent, position, page_id: PAGE })

describe('anchorBlockIn', () => {
  it('names the first heading of the text in document order, not row order', () => {
    // The rows come as the backend sends them, by position: `NESTED` sits
    // under `TOP`, before `LATER` in the page.
    const blocks = [
      row('TOP', 'intro', PAGE, 1),
      row('LATER', '## Second', PAGE, 2),
      row('NESTED', '### second', 'TOP', 5),
    ]
    expect(anchorBlockIn(blocks, PAGE, 'Second')).toBe('NESTED')
  })

  it('names nothing when no heading has the text', () => {
    expect(anchorBlockIn([row('A', '# First'), row('B', 'Second')], PAGE, 'Second')).toBeUndefined()
  })

  it('names the block of a ^ULID in the page, and nothing for a ULID outside it', () => {
    const blocks = [row('01BLOCKA000000000000000000', 'plain')]
    expect(anchorBlockIn(blocks, PAGE, '^01BLOCKA000000000000000000')).toBe(
      '01BLOCKA000000000000000000',
    )
    expect(anchorBlockIn(blocks, PAGE, '^01BLOCKB000000000000000000')).toBeUndefined()
  })
})

describe('findAnchorBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("loads the page's subtree in the active space and names the heading's block", async () => {
    const subtree: PageSubtree = {
      blocks: [row('H1', '# First'), row('H2', '## Second', PAGE, 2)],
      truncated: false,
      total: 2,
    }
    const loads = vi.fn(() => subtree)
    vi.mocked(invoke).mockImplementation(mockInvokeCommands({ load_page_subtree: loads }))

    await expect(findAnchorBlock(PAGE, 'second')).resolves.toBe('H2')
    expect(loads).toHaveBeenCalledWith({
      rootBlockId: PAGE,
      scope: { kind: 'active', space_id: 'SPACE_1' },
    })
  })

  it('names nothing, and warns, when the subtree cannot load', async () => {
    const warn = vi.spyOn(logger, 'warn')
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        load_page_subtree: () => {
          throw new Error('page is in the trash')
        },
      }),
    )

    await expect(findAnchorBlock(PAGE, 'Second')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('names nothing without an active space, asking nothing', async () => {
    useSpaceStore.setState({ currentSpaceId: null })
    const loads = vi.fn()
    vi.mocked(invoke).mockImplementation(mockInvokeCommands({ load_page_subtree: loads }))

    await expect(findAnchorBlock(PAGE, 'Second')).resolves.toBeUndefined()
    expect(loads).not.toHaveBeenCalled()
  })
})
