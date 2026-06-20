/**
 * useAppBootRecovery — mount-only IPC hydration extracted from App.tsx
 * (stretch).
 *
 * Two effects, both empty-deps (run once on mount), each retains its
 * original try/catch shape so failures stay non-fatal:
 *
 * 1. Orphan-draft flush — `flushAllDrafts()` consolidates every
 *    pending draft left behind by a previous crash into a single
 * IPC + single `BEGIN IMMEDIATE` tx. Failures
 *    log a warn and let boot continue; the backend's all-or-nothing
 *    semantics mean a single bad draft rolls back the whole batch
 *    (the next user-driven `flushDraft` retries on demand).
 * 2. Priority-levels load — read the `priority` property
 *    definition's `options` JSON and hydrate the shared
 *    `setPriorityLevels` cache so badge colours / sort / filter
 *    choices reflect the user's configured set. Defensive parsing —
 *    malformed input leaves the default `['1','2','3']` levels untouched.
 */

import { useEffect } from 'react'

import { notify } from '@/lib/notify'

import { i18n } from '../lib/i18n'
import { logger } from '../lib/logger'
import { setPriorityLevels } from '../lib/priority-levels'
import { flushAllDrafts, getPropertyDef } from '../lib/tauri'

export function useAppBootRecovery(): void {
  // ── Boot recovery: flush orphaned drafts from previous crash ──────
  // One IPC, one `BEGIN IMMEDIATE` tx covering every
  // orphan draft. Was: `listDrafts` → N fire-and-forget `flushDraft`
  // calls (each opening its own tx that serialised on the writer lock).
  useEffect(() => {
    flushAllDrafts()
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

  // ── Load user-configured priority levels ────────────────
  // The `priority` property definition's `options` JSON is the source of
  // truth for the active level set. Parse defensively — malformed JSON
  // or a missing definition leaves the default `['1','2','3']` levels in
  // place.
  useEffect(() => {
    // Single-key PK lookup instead of paginating the
    // entire property-definition vocabulary just to read one row.
    getPropertyDef('priority')
      .then((priorityDef) => {
        if (!priorityDef) return
        if (priorityDef.options == null) return
        let parsed: unknown
        try {
          parsed = JSON.parse(priorityDef.options)
        } catch (err) {
          logger.warn(
            'App',
            'priority property definition has invalid JSON options',
            { options: priorityDef.options },
            err,
          )
          return
        }
        if (!Array.isArray(parsed)) {
          logger.warn('App', 'priority property options is not an array', {
            options: priorityDef.options,
          })
          return
        }
        const levels = parsed.filter((v): v is string => typeof v === 'string')
        if (levels.length === 0) return
        setPriorityLevels(levels)
      })
      .catch((err: unknown) => {
        logger.warn(
          'App',
          'Failed to load property definitions for priority levels',
          undefined,
          err,
        )
      })
  }, [])
}
