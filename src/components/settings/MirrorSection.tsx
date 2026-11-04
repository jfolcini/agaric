/**
 * MirrorSection — the Markdown mirror card of the Data settings tab (#5363).
 *
 * The mirror is device-local and off by default: choosing a folder makes the
 * backend write every page into it as a `.md` file. Picking and setting are
 * separate commands, so a cancelled OS dialog changes nothing. A file edited
 * outside Agaric is never overwritten; the backend lists it under `diverged`.
 *
 * Where the backend cannot mirror (`supported: false`, the mobile builds) the
 * card renders nothing.
 */

import { FileCheck, FolderOpen, FolderX } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingRow } from '@/components/ui/setting-row'
import { Spinner } from '@/components/ui/spinner'
import { unwrap } from '@/lib/app-error'
import { commands, type MirrorStatus } from '@/lib/bindings'
import { formatErrorForDisplay } from '@/lib/error-display'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

const MODULE = 'MirrorSection'

type Action = 'choose' | 'off'

export function MirrorSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const divergedHeadingId = useId()
  const failedHeadingId = useId()
  const [status, setStatus] = useState<MirrorStatus | null>(null)
  const [pending, setPending] = useState<Action | null>(null)

  useEffect(() => {
    commands
      .getMirrorStatus()
      .then(unwrap)
      .then(setStatus)
      .catch((err: unknown) => {
        logger.warn(MODULE, 'failed to load the mirror status; hiding the card', undefined, err)
      })
  }, [])

  const run = useCallback(
    async (action: Action) => {
      setPending(action)
      try {
        const path = action === 'choose' ? unwrap(await commands.pickMirrorFolder()) : null
        if (action === 'choose' && path === null) return
        setStatus(unwrap(await commands.setMirrorFolder(path)))
      } catch (err) {
        logger.error(MODULE, 'failed to change the mirror folder', undefined, err)
        notify.error(t('data.mirrorFailed', { reason: formatErrorForDisplay(err) }))
      } finally {
        setPending(null)
      }
    },
    [t],
  )

  if (status === null || !status.supported) return null

  const on = status.folder !== null

  return (
    <Card>
      <CardHeader>
        <CardTitle data-testid="mirror-panel-title">{t('data.mirrorTitle')}</CardTitle>
        <CardDescription>{t('data.mirrorDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SettingRow
          label={t('data.mirrorFolderLabel')}
          description={
            on ? (
              <span className="font-mono break-all" data-testid="mirror-folder">
                {status.folder}
              </span>
            ) : (
              t('data.mirrorOff')
            )
          }
        >
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pending !== null}
              onClick={() => {
                void run('choose')
              }}
            >
              {pending === 'choose' ? <Spinner /> : <FolderOpen />}
              {t('data.mirrorChooseButton')}
            </Button>
            {on && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending !== null}
                onClick={() => {
                  void run('off')
                }}
              >
                {pending === 'off' ? <Spinner /> : <FolderX />}
                {t('data.mirrorTurnOffButton')}
              </Button>
            )}
          </div>
        </SettingRow>

        {status.paused !== null && (
          <output className="block text-sm text-status-pending-foreground">
            {t('data.mirrorPaused', { reason: status.paused })}
          </output>
        )}

        {on && (
          <div className="space-y-2">
            <p id={divergedHeadingId} className="text-sm font-medium">
              {t('data.mirrorDivergedHeading')}
            </p>
            {status.diverged.length === 0 ? (
              <EmptyState
                compact
                headingLevel="p"
                icon={FileCheck}
                message={t('data.mirrorDivergedNone')}
              />
            ) : (
              <ScrollArea className="max-h-56 rounded-md border" viewportClassName="p-3">
                <ul aria-labelledby={divergedHeadingId} className="space-y-1 text-sm">
                  {status.diverged.map((file) => (
                    <li key={file.page_id} className="font-mono break-all">
                      {file.path}
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </div>
        )}

        {status.failed.length > 0 && (
          <div className="space-y-2">
            <p id={failedHeadingId} className="text-sm font-medium text-destructive">
              {t('data.mirrorFailedHeading')}
            </p>
            <ScrollArea className="max-h-56 rounded-md border" viewportClassName="p-3">
              <ul aria-labelledby={failedHeadingId} className="space-y-1 text-sm">
                {status.failed.map((failure) => (
                  <li key={failure.page_id} className="break-all">
                    {t('data.mirrorFailedItem', { path: failure.path, message: failure.message })}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
