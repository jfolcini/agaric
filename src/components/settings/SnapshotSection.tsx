/**
 * SnapshotSection — the daily snapshot row of the Data settings tab (#6554):
 * when the last one was taken and, on desktop, the folder that holds them.
 * It only reports: nothing here restores a snapshot.
 */

import { FolderOpen } from 'lucide-react'
import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { SettingRow } from '@/components/ui/setting-row'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { formatTimestamp } from '@/lib/format'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { isMobilePlatform } from '@/lib/platform'

const MODULE = 'SnapshotSection'

/** The last snapshot's time in ms, `null` for none yet, or why it is not known. */
type LastSnapshot = number | null | 'loading' | 'unreadable'

export function SnapshotSection(): React.ReactElement {
  const { t } = useTranslation()
  const [last, setLast] = useState<LastSnapshot>('loading')

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
          {isMobilePlatform() ? null : (
            <Button variant="outline" size="sm" onClick={openFolder}>
              <FolderOpen />
              {t('data.snapshotOpenFolder')}
            </Button>
          )}
        </SettingRow>
      </CardContent>
    </Card>
  )
}
