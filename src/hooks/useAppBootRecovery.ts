/**
 * useAppBootRecovery — mount-only IPC hydration extracted from App.tsx
 * (stretch).
 *
 * Orphan-draft flush, run once on mount — `flushAllDrafts()` consolidates
 * every pending draft left behind by a previous crash into a single IPC +
 * single `BEGIN IMMEDIATE` tx. A draft the backend refuses (oversized
 * content) is skipped and stays in `block_drafts`; the rest of the batch
 * still lands. Failures log a warn and let boot continue (the next
 * user-driven `flushDraft` retries on demand).
 */

import { useEffect } from 'react'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

export function useAppBootRecovery(): void {
  // ── Boot recovery: flush orphaned drafts from previous crash ──────
  // One IPC, one `BEGIN IMMEDIATE` tx covering every
  // orphan draft. Was: `listDrafts` → N fire-and-forget `flushDraft`
  // calls (each opening its own tx that serialised on the writer lock).
  useEffect(() => {
    commands
      .flushAllDrafts()
      .then(unwrap)
      .then(({ flushed }) => {
        if (flushed > 0) {
          logger.info('boot', `Recovered ${flushed} unsaved draft(s)`)
          // Surface the recovery to the user — silent recovery
          // means crashed-mid-edit users have no clue their work was
          // saved. Stay silent on count === 0 (no announcement needed).
          notify.info(i18n.t('boot.recoveredDrafts', { count: flushed }))
        }
      })
      .catch((err: unknown) => {
        logger.warn('App', 'Failed to flush orphaned drafts during boot recovery', undefined, err)
      })
  }, [])
}
