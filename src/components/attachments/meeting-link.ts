/**
 * Reload the page a meeting's link landed on (#5364). A meeting made from the
 * palette is linked from its day's journal, a page this dialog has no store
 * for, so the mounted journal reloads it the way an MCP write does.
 */

import { reloadChangedPageStores } from '@/hooks/useSyncEvents'
import { unwrap } from '@/lib/app-error'
import type { MeetingResult } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'

export async function reloadMeetingLink(created: MeetingResult): Promise<void> {
  if (created.link_block_id === null) {
    reloadChangedPageStores([created.page_id])
    return
  }
  try {
    const link = unwrap(await commands.getBlock(created.link_block_id))
    reloadChangedPageStores([link.page_id ?? link.id, created.page_id])
  } catch (err) {
    logger.warn('reloadMeetingLink', 'could not find the meeting’s link', undefined, err)
    reloadChangedPageStores()
  }
}
