/**
 * reloadMeetingLink (#5364): the page a palette meeting's link landed on is
 * the one reloaded, and a link it cannot read reloads every page.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow } from '@/__tests__/fixtures'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { reloadMeetingLink } from '@/components/attachments/meeting-link'
import { reloadChangedPageStores } from '@/hooks/useSyncEvents'
import type { MeetingResult } from '@/lib/bindings'
import { logger } from '@/lib/logger'

vi.mock('@/hooks/useSyncEvents', () => ({ reloadChangedPageStores: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockedInvoke = vi.mocked(invoke)

function meeting(linkBlockId: string | null): MeetingResult {
  return {
    page_id: 'MEETING_PAGE',
    recording_block_id: 'RECORDING',
    link_block_id: linkBlockId,
    attachments: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('reloadMeetingLink', () => {
  it('reloads the journal day the link is on, and the meeting page', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ get_block: () => makeBlockRow({ id: 'LINK', page_id: 'DAY_PAGE' }) }),
    )

    await reloadMeetingLink(meeting('LINK'))

    expect(reloadChangedPageStores).toHaveBeenCalledWith(['DAY_PAGE', 'MEETING_PAGE'])
  })

  it('reloads only the meeting page when there is no link', async () => {
    await reloadMeetingLink(meeting(null))

    expect(mockedInvoke).not.toHaveBeenCalled()
    expect(reloadChangedPageStores).toHaveBeenCalledWith(['MEETING_PAGE'])
  })

  it('reloads every page, and says why, when the link cannot be read', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ get_block: () => Promise.reject(new Error('backend down')) }),
    )

    await reloadMeetingLink(meeting('LINK'))

    expect(reloadChangedPageStores).toHaveBeenCalledWith()
    expect(logger.warn).toHaveBeenCalledOnce()
  })
})
