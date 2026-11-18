/**
 * SnapshotSection — the daily snapshot row of the Data settings tab (#6554):
 * when the last one was taken, on desktop the folder that holds them, and
 * *Restore…* (#6744), which names a snapshot for the backend to put in place
 * of the notes when the app starts again, and restarts it.
 */

import { FolderOpen, History } from 'lucide-react'
import type React from 'react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow } from '@/components/ui/setting-row'
import { unwrap } from '@/lib/app-error'
import { commands, type DailySnapshot } from '@/lib/bindings'
import { formatErrorForDisplay } from '@/lib/error-display'
import { formatTimestamp } from '@/lib/format'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { isMobilePlatform } from '@/lib/platform'
import { relaunchApp } from '@/lib/relaunch-app'

const MODULE = 'SnapshotSection'

/** The last snapshot's time in ms, `null` for none yet, or why it is not known. */
type LastSnapshot = number | null | 'loading' | 'unreadable'

export function SnapshotSection(): React.ReactElement {
  const { t } = useTranslation()
  const [last, setLast] = useState<LastSnapshot>('loading')
  const snapshotSelectId = useId()
  // The snapshots the restore dialog offers; `null` while it is closed.
  const [offered, setOffered] = useState<DailySnapshot[] | null>(null)
  const [chosenDay, setChosenDay] = useState('')

  useEffect(() => {
    commands
      .getLastSnapshotMs()
      .then(unwrap)
      .then(setLast)
      .catch((err: unknown) => {
        logger.warn(MODULE, 'failed to read the last snapshot time', undefined, err)
        setLast('unreadable')
      })
  }, [])

  const openFolder = async () => {
    try {
      unwrap(await commands.openDataFolder())
    } catch (err) {
      logger.error(MODULE, 'failed to open the data folder', undefined, err)
      notify.error(t('data.snapshotOpenFolderFailed'))
    }
  }

  const askToRestore = async () => {
    try {
      const snapshots = unwrap(await commands.listDailySnapshots())
      setChosenDay(snapshots[0]?.day ?? '')
      setOffered(snapshots)
    } catch (err) {
      logger.error(MODULE, 'failed to list the daily snapshots', undefined, err)
      notify.error(t('data.snapshotRestoreListFailed'))
    }
  }

  const restore = async () => {
    try {
      unwrap(await commands.requestSnapshotRestore(chosenDay))
    } catch (err) {
      logger.error(MODULE, 'failed to ask for a snapshot restore', undefined, err)
      notify.error(t('data.snapshotRestoreFailed', { reason: formatErrorForDisplay(err) }))
      // Rejecting keeps the dialog open.
      throw err
    }
    await relaunchApp()
  }

  const status =
    last === 'loading'
      ? null
      : last === 'unreadable'
        ? t('data.snapshotUnreadable')
        : last === null
          ? t('data.snapshotNone')
          : t('data.snapshotLast', { time: formatTimestamp(last) })

  return (
    <Card>
      <CardContent>
        <SettingRow
          label={t('data.snapshotLabel')}
          description={
            <>
              {t('data.snapshotDesc')}
              {status !== null && (
                <span className="block" data-testid="snapshot-status">
                  {status}
                </span>
              )}
            </>
          }
        >
          <div className="flex flex-wrap gap-2">
            {isMobilePlatform() ? null : (
              <Button variant="outline" size="sm" onClick={() => void openFolder()}>
                <FolderOpen />
                {t('data.snapshotOpenFolder')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={typeof last !== 'number'}
              onClick={() => void askToRestore()}
            >
              <History />
              {t('data.snapshotRestoreButton')}
            </Button>
          </div>
        </SettingRow>
        <ConfirmDialog
          open={offered !== null}
          onOpenChange={(open) => {
            if (!open) setOffered(null)
          }}
          titleKey="data.snapshotRestoreTitle"
          descriptionKey="data.snapshotRestoreDesc"
          confirmKey="data.snapshotRestoreConfirm"
          variant="destructive"
          onConfirm={restore}
        >
          <div className="space-y-2">
            <Label htmlFor={snapshotSelectId}>{t('data.snapshotRestoreSelectLabel')}</Label>
            <Select value={chosenDay} onValueChange={setChosenDay}>
              <SelectTrigger id={snapshotSelectId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(offered ?? []).map((snapshot) => (
                  <SelectItem key={snapshot.day} value={snapshot.day}>
                    {formatTimestamp(snapshot.taken_ms)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </ConfirmDialog>
      </CardContent>
    </Card>
  )
}
