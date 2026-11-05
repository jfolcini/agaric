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
 * only at boot or through *Retry*, so it is fetched on mount and after a retry,
 * never polled.
 *
 * *Retry* moves a delta back to the boot replay's inbox, so it is tried at the
 * next start, not now: the toast says so and offers *Restart now*.
 */

import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import type React from 'react'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useMinuteClock } from '@/hooks/useMinuteClock'
import { isNotFound, unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { formatBytes } from '@/lib/format'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { queryClient } from '@/lib/query-client'
import { relaunchApp } from '@/lib/relaunch-app'
import { LIST_QUARANTINED_SYNC_SLOTS_MAX, safeLimit } from '@/lib/safe-limit'
import { useSpaceStore } from '@/stores/space'

const QUERY_KEY = ['quarantinedSyncSlots']

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
  const [retryingId, setRetryingId] = useState<number | null>(null)
  // staleTime 0: a fresh read each time the tab opens, since a boot may have
  // moved a delta since the last one.
  const { data, isError } = useQuery(
    { queryKey: QUERY_KEY, queryFn: fetchQuarantinedSlots, staleTime: 0 },
    queryClient,
  )

  async function retry(id: number): Promise<void> {
    setRetryingId(id)
    try {
      unwrap(await commands.readmitQuarantinedSyncSlot(id))
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      notify.success(t('sync.quarantineRetried'), {
        action: { label: t('sync.quarantineRestartNow'), onClick: () => void relaunchApp() },
      })
    } catch (err) {
      // NotFound: the row was already retried, so the listed one is stale.
      if (isNotFound(err)) {
        await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      } else {
        logger.warn('QuarantinedSyncCard', 'retrying a quarantined sync delta failed', { id }, err)
        notify.error(t('sync.quarantineRetryFailed'))
      }
    } finally {
      setRetryingId(null)
    }
  }

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
        {data.slots.map((slot) => {
          const space = spaceNames.get(slot.space_id) ?? slot.space_id
          return (
            <li key={slot.id} className="min-w-0" data-testid="quarantined-sync-row">
              <p className="font-medium break-words">{space}</p>
              <p className="text-xs">
                {t('sync.quarantineRowMeta', {
                  when: formatRelativeTime(slot.first_seen_at_ms, t, now),
                  size: formatBytes(slot.byte_len),
                })}
              </p>
              <p className="text-xs text-muted-foreground break-all">{slot.last_reason}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-1"
                onClick={() => void retry(slot.id)}
                disabled={retryingId !== null}
                aria-label={t('sync.quarantineRetryLabel', { space })}
              >
                {retryingId === slot.id ? <Spinner /> : <RotateCcw />}
                {t('sync.quarantineRetry')}
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
