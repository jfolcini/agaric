/**
 * QuarantinedSyncCard — the sync deltas the boot replay gave up on (#6057).
 *
 * A delta that stays unapplied across `QUARANTINE_AFTER_BOOTS` restarts is moved,
 * bytes intact, into `loro_sync_quarantine` (#3226). Without this card that move
 * reached only the log while every sync indicator said "synced".
 *
 * Rendered first in Settings › Sync & devices, outside `SyncStatusCard`: that
 * card hides when nothing is paired, and a quarantined delta outlives an unpair.
 * Hidden while loading and when nothing is quarantined. The quarantine changes
 * only at boot, so it is fetched on mount and never polled.
 */

import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type React from 'react'
import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useMinuteClock } from '@/hooks/useMinuteClock'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { formatBytes } from '@/lib/format'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import { LIST_QUARANTINED_SYNC_SLOTS_MAX, safeLimit } from '@/lib/safe-limit'
import { useSpaceStore } from '@/stores/space'

const NOTICE_CLASS =
  'flex flex-col gap-2 rounded-md border border-alert-warning-border bg-alert-warning p-4 text-sm text-alert-warning-foreground'

async function fetchQuarantinedSlots() {
  try {
    return unwrap(
      await commands.listQuarantinedSyncSlots(
        safeLimit(LIST_QUARANTINED_SYNC_SLOTS_MAX, LIST_QUARANTINED_SYNC_SLOTS_MAX),
      ),
    )
  } catch (err) {
    logger.warn('QuarantinedSyncCard', 'listing quarantined sync deltas failed', undefined, err)
    throw err
  }
}

export function QuarantinedSyncCard(): React.ReactElement | null {
  const { t } = useTranslation()
  const now = useMinuteClock()
  const titleId = useId()
  const spaces = useSpaceStore((s) => s.availableSpaces)
  const spaceNames = useMemo(() => new Map(spaces.map((s) => [s.id, s.name])), [spaces])
  // staleTime 0: a fresh read each time the tab opens, since a boot may have
  // moved a delta since the last one.
  const { data, isError } = useQuery(
    { queryKey: ['quarantinedSyncSlots'], queryFn: fetchQuarantinedSlots, staleTime: 0 },
    queryClient,
  )

  if (isError) {
    return (
      <div className={NOTICE_CLASS} role="alert" data-testid="quarantined-sync-card">
        <p>{t('sync.quarantineLoadFailed')}</p>
      </div>
    )
  }
  if (!data?.total) return null

  return (
    <section className={NOTICE_CLASS} aria-labelledby={titleId} data-testid="quarantined-sync-card">
      <p id={titleId} className="flex items-start gap-2 font-semibold">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        {t('sync.quarantineTitle', { count: data.total })}
      </p>
      <p className="ml-6">{t('sync.quarantineBody')}</p>
      <ul className="ml-6 flex flex-col gap-2" aria-label={t('sync.quarantineListLabel')}>
        {data.slots.map((slot) => (
          <li key={slot.id} className="min-w-0" data-testid="quarantined-sync-row">
            <p className="font-medium break-words">
              {spaceNames.get(slot.space_id) ?? slot.space_id}
            </p>
            <p className="text-xs">
              {t('sync.quarantineRowMeta', {
                when: formatRelativeTime(slot.first_seen_at_ms, t, now),
                size: formatBytes(slot.byte_len),
              })}
            </p>
            <p className="text-xs text-muted-foreground break-all">{slot.last_reason}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
