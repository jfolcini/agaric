/**
 * MirrorSection — the Markdown mirror card of the Data settings tab (#5363).
 *
 * The mirror is device-local and off by default: choosing a folder makes the
 * backend write every page into it as a `.md` file. Picking and setting are
 * separate commands, so a cancelled OS dialog changes nothing. A file edited
 * outside Agaric is never overwritten; the backend lists it under `diverged`.
 *
 * Reading changes back is chosen with the folder and changeable later. While
 * it is off, the backend lists the files turning it on would read in under
 * `pending`; turning it on with any asks first, and the confirm sends the
 * files the dialog listed, so the backend refuses it when another file
 * changed since: nothing is read in that the user was not shown.
 *
 * Copying attachments into the folder is a stored switch of its own, off by
 * default; a copy changed in the folder is kept, and listed under `diverged`.
 *
 * Where the backend cannot mirror (`supported: false`, the mobile builds) the
 * card says so and offers no folder picker, which would only fail there.
 */

import { FileCheck, FolderOpen, FolderX } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingRow, settingDescriptionId } from '@/components/ui/setting-row'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { unwrap } from '@/lib/app-error'
import { commands, type MirrorStatus } from '@/lib/bindings'
import { formatErrorForDisplay } from '@/lib/error-display'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

const MODULE = 'MirrorSection'

type Action = 'choose' | 'off' | 'readBack' | 'copyFiles'

export function MirrorSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const divergedHeadingId = useId()
  const failedHeadingId = useId()
  const readBackId = useId()
  const copyFilesId = useId()
  const [status, setStatus] = useState<MirrorStatus | null>(null)
  const [pending, setPending] = useState<Action | null>(null)
  // Reading back for the next folder chosen, while the mirror is off.
  const [readBackChoice, setReadBackChoice] = useState(true)
  const [askToReadPending, setAskToReadPending] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(unwrap(await commands.getMirrorStatus()))
    } catch (err) {
      logger.warn(MODULE, 'failed to load the mirror status; hiding the card', undefined, err)
    }
  }, [])

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
        // The backend takes it only when the mirror turns on.
        setStatus(unwrap(await commands.setMirrorFolder(path, readBackChoice)))
      } catch (err) {
        logger.error(MODULE, 'failed to change the mirror folder', undefined, err)
        notify.error(t('data.mirrorFailed', { reason: formatErrorForDisplay(err) }))
      } finally {
        setPending(null)
      }
    },
    [t, readBackChoice],
  )

  const setReadBack = useCallback(
    async (on: boolean, confirmed: string[]) => {
      setPending('readBack')
      try {
        setStatus(unwrap(await commands.setMirrorReadBack(on, confirmed)))
      } catch (err) {
        logger.error(MODULE, 'failed to change reading changes back', undefined, err)
        notify.error(t('data.mirrorReadBackFailed', { reason: formatErrorForDisplay(err) }))
        await load()
      } finally {
        setPending(null)
      }
    },
    [t, load],
  )

  const setCopyFiles = useCallback(
    async (on: boolean) => {
      setPending('copyFiles')
      try {
        setStatus(unwrap(await commands.setMirrorCopyFiles(on)))
      } catch (err) {
        logger.error(MODULE, 'failed to change copying attachments', undefined, err)
        notify.error(t('data.mirrorCopyFilesFailed', { reason: formatErrorForDisplay(err) }))
      } finally {
        setPending(null)
      }
    },
    [t],
  )

  const onReadBackChange = (on: boolean): void => {
    if (status?.folder == null) {
      setReadBackChoice(on)
    } else if (on && status.pending.length > 0) {
      setAskToReadPending(true)
    } else {
      void setReadBack(on, [])
    }
  }

  if (status === null) return null

  const header = (
    <CardHeader>
      <CardTitle data-testid="mirror-panel-title">{t('data.mirrorTitle')}</CardTitle>
      <CardDescription>{t('data.mirrorDesc')}</CardDescription>
    </CardHeader>
  )

  if (!status.supported) {
    return (
      <Card>
        {header}
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('data.mirrorUnsupported')}</p>
        </CardContent>
      </Card>
    )
  }

  const on = status.folder !== null

  return (
    <Card>
      {header}
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

        <SettingRow
          label={t('data.mirrorReadBackLabel')}
          description={t('data.mirrorReadBackDesc')}
          controlId={readBackId}
        >
          <Switch
            id={readBackId}
            aria-describedby={settingDescriptionId(readBackId)}
            checked={on ? status.read_back : readBackChoice}
            disabled={pending !== null}
            onCheckedChange={onReadBackChange}
          />
        </SettingRow>

        <SettingRow
          label={t('data.mirrorCopyFilesLabel')}
          description={t('data.mirrorCopyFilesDesc')}
          controlId={copyFilesId}
        >
          <Switch
            id={copyFilesId}
            aria-describedby={settingDescriptionId(copyFilesId)}
            checked={status.copy_files}
            disabled={pending !== null}
            onCheckedChange={(checked) => {
              void setCopyFiles(checked)
            }}
          />
        </SettingRow>

        <ConfirmDialog
          open={askToReadPending}
          onOpenChange={setAskToReadPending}
          titleKey="data.mirrorReadPendingTitle"
          descriptionKey="data.mirrorReadPendingDesc"
          values={{ count: status.pending.length }}
          confirmKey="data.mirrorReadPendingConfirm"
          cancelKey="data.mirrorReadPendingCancel"
          onConfirm={() => setReadBack(true, status.pending)}
        >
          <ScrollArea className="max-h-56 rounded-md border" viewportClassName="p-3">
            <ul className="space-y-1 text-sm">
              {status.pending.map((path) => (
                <li key={path} className="font-mono break-all">
                  {path}
                </li>
              ))}
            </ul>
          </ScrollArea>
        </ConfirmDialog>

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
                    <li key={file.path} className="font-mono break-all">
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
                  <li key={failure.path} className="break-all">
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
