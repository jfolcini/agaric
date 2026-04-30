/**
 * useAttachmentCount — fetches the attachment count for a single block.
 *
 * Owns the `attachmentCount` state plus the effect that calls
 * `listAttachments(blockId)` and stores `rows.length`. Failures are
 * logged via `logger.warn` and the count stays at 0.
 *
 * Extracted from `SortableBlock` (MAINT-128). The doubled IPC with
 * `useBlockAttachments` is acknowledged in MAINT-131; the fix is a
 * batched backend command, not reusing this hook.
 */

import { useEffect, useState } from 'react'
import { logger } from '../lib/logger'
import { listAttachments } from '../lib/tauri'

export function useAttachmentCount(blockId: string): number {
  const [attachmentCount, setAttachmentCount] = useState(0)

  useEffect(() => {
    let stale = false
    listAttachments(blockId)
      .then((rows) => {
        if (!stale) setAttachmentCount(rows.length)
      })
      .catch((err) => {
        logger.warn('SortableBlock', 'attachment count failed', undefined, err)
      })
    return () => {
      stale = true
    }
  }, [blockId])

  return attachmentCount
}
