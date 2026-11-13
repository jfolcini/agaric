/**
 * The page index (#6527): one listing of a space's pages behind every picker
 * that filters the whole list, re-read after a page's name changes.
 *
 * `invoke` is routed through the real tauri-mock `dispatch`, so each read
 * returns the pages the mock stores and the listing calls are counted on the
 * way through.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { logger } from '@/lib/logger'
import { notifyPageRenamed, notifyTagRenamed } from '@/lib/name-change-bus'
import { pageIndexQuery } from '@/lib/page-index'
import { queryClient } from '@/lib/query-client'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'

const PERSONAL = 'SPACE_PERSONAL'
const WORK = 'SPACE_WORK'

let listings: string[]

function titles(pages: Array<{ content: string | null }>): Array<string | null> {
  return pages.map((page) => page.content)
}

beforeEach(() => {
  seedBlocks()
  listings = []
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) => {
    if (cmd === 'list_all_pages_in_space') {
      const scope = (args as { scope: { space_id: string } }).scope
      listings.push(scope.space_id)
    }
    return dispatch(cmd, args)
  })
})

describe('pageIndexQuery', () => {
  it('lists a space once for any number of reads', async () => {
    const first = await queryClient.fetchQuery(pageIndexQuery(PERSONAL))
    const second = await queryClient.fetchQuery(pageIndexQuery(PERSONAL))

    expect(titles(first)).toContain('Getting Started')
    expect(second).toBe(first)
    expect(listings).toEqual([PERSONAL])
  })

  it('keeps one list per space', async () => {
    const personal = await queryClient.fetchQuery(pageIndexQuery(PERSONAL))
    const work = await queryClient.fetchQuery(pageIndexQuery(WORK))

    expect(titles(work)).not.toEqual(titles(personal))
    expect(listings).toEqual([PERSONAL, WORK])
  })

  it('re-reads after a page is renamed', async () => {
    await queryClient.fetchQuery(pageIndexQuery(PERSONAL))
    await dispatch('edit_block', { blockId: SEED_IDS.PAGE_GETTING_STARTED, toText: 'Renamed' })
    notifyPageRenamed(SEED_IDS.PAGE_GETTING_STARTED, 'Renamed', PERSONAL)

    const after = await queryClient.fetchQuery(pageIndexQuery(PERSONAL))

    expect(titles(after)).toContain('Renamed')
    expect(titles(after)).not.toContain('Getting Started')
  })

  it('keeps the list when a tag is renamed', async () => {
    await queryClient.fetchQuery(pageIndexQuery(PERSONAL))
    notifyTagRenamed('TAG', 'renamed', PERSONAL)

    await queryClient.fetchQuery(pageIndexQuery(PERSONAL))

    expect(listings).toEqual([PERSONAL])
  })

  it('logs and rejects when the listing fails', async () => {
    const failure = new Error('backend down')
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({ list_all_pages_in_space: () => Promise.reject(failure) }),
    )
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {})

    await expect(queryClient.fetchQuery(pageIndexQuery(PERSONAL))).rejects.toBe(failure)

    expect(logged).toHaveBeenCalledWith(
      'page-index',
      'reading the page list failed',
      { spaceId: PERSONAL },
      failure,
    )
    logged.mockRestore()
  })
})
