/**
 * useAppBootRecovery — mount-only IPC hydration extracted from App.tsx
 * (MAINT-124 step 4 / stretch).
 *
 * Two effects, both empty-deps (run once on mount), each retains its
 * original try/catch shape so failures stay non-fatal:
 *
 * 1. Orphan-draft flush — `listDrafts` → `flushDraft` for each entry
 *    left behind by a previous crash. Per-draft failures log a warn;
 *    the outer `listDrafts()` failure is also logged. Either way the
 *    app boots normally.
 * 2. Priority-levels load (UX-201b) — read the `priority` property
 *    definition's `options` JSON and hydrate the shared
 *    `setPriorityLevels` cache so badge colours / sort / filter
 *    choices reflect the user's configured set. Defensive parsing —
 *    malformed input leaves the default `['1','2','3']` levels untouched.
 */

import { useEffect } from 'react'
import { logger } from '../lib/logger'
import { setPriorityLevels } from '../lib/priority-levels'
import { flushDraft, listDrafts, listPropertyDefs } from '../lib/tauri'

export function useAppBootRecovery(): void {
  // ── Boot recovery: flush orphaned drafts from previous crash ──────
  useEffect(() => {
    listDrafts()
      .then((drafts) => {
        for (const draft of drafts) {
          flushDraft(draft.block_id).catch((err: unknown) => {
            logger.warn(
              'App',
              'Failed to flush orphaned draft during boot recovery',
              {
                blockId: draft.block_id,
              },
              err,
            )
          })
        }
        if (drafts.length > 0) {
          logger.info('boot', `Recovered ${drafts.length} unsaved draft(s)`)
        }
      })
      .catch((err: unknown) => {
        logger.warn('App', 'Failed to list drafts during boot recovery', undefined, err)
      })
  }, [])

  // ── Load user-configured priority levels (UX-201b) ────────────────
  // The `priority` property definition's `options` JSON is the source of
  // truth for the active level set. Parse defensively — malformed JSON
  // or a missing definition leaves the default `['1','2','3']` levels in
  // place.
  useEffect(() => {
    listPropertyDefs()
      .then((defs) => {
        if (!Array.isArray(defs)) return
        const priorityDef = defs.find((d) => d.key === 'priority')
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
