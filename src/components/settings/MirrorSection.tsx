/**
 * MirrorSection — the Markdown mirror card of the Data settings tab (#5363).
 *
 * The mirror is device-local and off by default: choosing a folder makes the
 * backend write every page into it as a `.md` file. Picking and setting are
 * separate commands, so a cancelled OS dialog changes nothing. A file edited
 * outside Agaric is never overwritten; the backend lists it under `diverged`.
 *
 * Reading changes back is a stored switch, kept while the mirror is off and
 * sent with the folder chosen next. While it is off, the backend lists the
 * files turning it on would read in under `pending`, each with what reading
 * it in does; turning it on with any asks first, listing them by that, and
 * the confirm sends the paths the dialog listed, so the backend refuses it
 * when another file changed since: nothing is read in that the user was not
 * shown. A folder chosen again holding files changed while
 * the mirror was off or writing elsewhere, or chosen again to start fresh,
 * turns it on with reading back off, and the same question is asked at once
 * when reading back was on.
 *
 * Copying attachments into the folder is a stored switch of its own, off by
 * default; a copy changed in the folder is kept, and listed under `diverged`.
 *
 * Asking before reading in many changes is a stored switch too, on by
 * default: while many files of a space changed at once, the backend reads
 * nothing back, reports reading back off, and names the space under `held`
 * and `failed`. Turning reading back on then asks as above. Beside that line
 * and in the question a button moves focus to the switch, which sits in this
 * card, for a workflow such as renaming well-linked notes that wants it off.
 *
 * A tick that reads a file back emits `mirror:ingested`; the card reads its
 * status again then. A tick that only writes, or holds reading back, emits
 * nothing, so those show the next time the card mounts.
 *
 * Where the backend cannot mirror (`supported: false`, the mobile builds) the
 * card says so and offers no folder picker, which would only fail there.
 */

import { FileCheck, FolderOpen, FolderX } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { AdoptFolderDialog, AdoptFolderRow } from '@/components/settings/AdoptFolder'
import { ImportMergeDialog } from '@/components/settings/ImportMergeDialog'
import { useAdoptFolder } from '@/components/settings/useAdoptFolder'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingRow, settingDescriptionId } from '@/components/ui/setting-row'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { MIRROR_INGESTED_EVENT } from '@/hooks/useMirrorIngestEvents'
import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { unwrap } from '@/lib/app-error'
import { commands, type MirrorPendingKind, type MirrorStatus } from '@/lib/bindings'
import { formatErrorForDisplay } from '@/lib/error-display'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useSpaceStore } from '@/stores/space'

const MODULE = 'MirrorSection'

type Action = 'choose' | 'off' | 'readBack' | 'copyFiles' | 'askMassChange' | 'space'

/** The read-in question's groups, in order, each headed by what reading its files in does. */
const PENDING_GROUPS = [
  ['edited', 'data.mirrorPendingEdited'],
  ['new', 'data.mirrorPendingNew'],
  ['gone', 'data.mirrorPendingGone'],
] as const satisfies ReadonlyArray<readonly [MirrorPendingKind, string]>

export function MirrorSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const divergedHeadingId = useId()
  const failedHeadingId = useId()
  const readBackId = useId()
  const spacesHeadingId = useId()
  const pendingHeadingId = useId()
  const spaces = useSpaceStore((s) => s.availableSpaces)
  const copyFilesId = useId()
  const askMassChangeId = useId()
  const askMassChangeSwitch = useRef<HTMLButtonElement>(null)
  // Where focus goes when the read-in question closes: the ask switch once
  // its button moved there, else back to what opened the question.
  const focusAfterQuestion = useRef<HTMLElement | null>(null)
  const [status, setStatus] = useState<MirrorStatus | null>(null)
  const adopt = useAdoptFolder(setStatus)
  const [pending, setPending] = useState<Action | null>(null)
  const [askToReadPending, setAskToReadPending] = useState(false)

  const askToReadIn = useCallback(() => {
    focusAfterQuestion.current = null
    setAskToReadPending(true)
  }, [])

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

  useTauriEventListener(
    MIRROR_INGESTED_EVENT,
    () => {
      void load()
    },
    { enabled: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window },
  )

  const run = useCallback(
    async (action: Action) => {
      setPending(action)
      try {
        const path = action === 'choose' ? unwrap(await commands.pickMirrorFolder()) : null
        if (action === 'choose' && path === null) return
        // The backend takes it only when the mirror turns on.
        const readBack = status?.read_back ?? false
        const next = unwrap(await commands.setMirrorFolder(path, readBack))
        setStatus(next)
        // Held off for files changed in the folder: asked about now.
        if (readBack && !next.read_back && next.pending.length > 0) askToReadIn()
      } catch (err) {
        logger.error(MODULE, 'failed to change the mirror folder', undefined, err)
        notify.error(t('data.mirrorFailed', { reason: formatErrorForDisplay(err) }))
      } finally {
        setPending(null)
      }
    },
    [t, status, askToReadIn],
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

  const setSpaceMirrored = useCallback(
    async (spaceId: string, mirrored: boolean) => {
      setPending('space')
      try {
        setStatus(unwrap(await commands.setMirrorSpace(spaceId, mirrored)))
      } catch (err) {
        logger.error(MODULE, 'failed to change which spaces are mirrored', undefined, err)
        notify.error(t('data.mirrorSpaceFailed', { reason: formatErrorForDisplay(err) }))
      } finally {
        setPending(null)
      }
    },
    [t],
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

  const setAskMassChange = useCallback(
    async (on: boolean) => {
      setPending('askMassChange')
      try {
        setStatus(unwrap(await commands.setMirrorAskMassChange(on)))
      } catch (err) {
        logger.error(MODULE, 'failed to change asking before many changes', undefined, err)
        notify.error(t('data.mirrorAskMassChangeFailed', { reason: formatErrorForDisplay(err) }))
      } finally {
        setPending(null)
      }
    },
    [t],
  )

  const showAskSetting = (): void => {
    // After a click, focus moved by script shows no ring unless asked to.
    askMassChangeSwitch.current?.focus({ focusVisible: true })
  }

  const showAskSettingFromQuestion = (): void => {
    focusAfterQuestion.current = askMassChangeSwitch.current
    setAskToReadPending(false)
  }

  const onReadBackChange = (on: boolean): void => {
    if (on && status !== null && status.pending.length > 0) {
      askToReadIn()
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
  const held = status.held.length > 0

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

        {!on && <AdoptFolderRow adopt={adopt} disabled={pending !== null} />}

        <SettingRow
          label={t('data.mirrorReadBackLabel')}
          description={t('data.mirrorReadBackDesc')}
          controlId={readBackId}
        >
          <Switch
            id={readBackId}
            aria-describedby={settingDescriptionId(readBackId)}
            checked={status.read_back}
            disabled={pending !== null}
            onCheckedChange={onReadBackChange}
          />
        </SettingRow>

        <SettingRow
          label={t('data.mirrorAskMassChangeLabel')}
          description={t('data.mirrorAskMassChangeDesc')}
          controlId={askMassChangeId}
        >
          <Switch
            ref={askMassChangeSwitch}
            id={askMassChangeId}
            aria-describedby={settingDescriptionId(askMassChangeId)}
            checked={status.ask_mass_change}
            disabled={pending !== null}
            onCheckedChange={(checked) => {
              void setAskMassChange(checked)
            }}
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

        {spaces.length > 1 && (
          <div className="space-y-2">
            <p id={spacesHeadingId} className="text-sm font-medium">
              {t('data.mirrorSpacesHeading')}
            </p>
            <ul aria-labelledby={spacesHeadingId} className="space-y-2">
              {spaces.map((space) => (
                <li key={space.id}>
                  <SettingRow label={space.name} controlId={`mirror-space-${space.id}`}>
                    <Switch
                      id={`mirror-space-${space.id}`}
                      checked={!status.unmirrored_spaces.includes(space.id)}
                      disabled={pending !== null}
                      onCheckedChange={(mirrored) => {
                        void setSpaceMirrored(space.id, mirrored)
                      }}
                    />
                  </SettingRow>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ConfirmDialog
          open={askToReadPending}
          onOpenChange={setAskToReadPending}
          titleKey="data.mirrorReadPendingTitle"
          descriptionKey={held ? 'data.mirrorReadMassChangeDesc' : 'data.mirrorReadPendingDesc'}
          values={{ count: status.pending.length }}
          confirmKey="data.mirrorReadPendingConfirm"
          cancelKey="data.mirrorReadPendingCancel"
          onConfirm={() =>
            setReadBack(
              true,
              status.pending.map((file) => file.path),
            )
          }
          returnFocusRef={focusAfterQuestion}
        >
          {held && (
            <div className="mb-3 space-y-2 text-sm">
              <p>{t('data.mirrorMassChangeTurnOff')}</p>
              <Button variant="outline" size="sm" onClick={showAskSettingFromQuestion}>
                {t('data.mirrorMassChangeShowSetting')}
              </Button>
            </div>
          )}
          <ScrollArea className="max-h-56 rounded-md border" viewportClassName="p-3">
            <div className="space-y-3">
              {PENDING_GROUPS.map(([kind, headingKey]) => {
                const files = status.pending.filter((file) => file.kind === kind)
                if (files.length === 0) return null
                const headingId = `${pendingHeadingId}-${kind}`
                return (
                  <div key={kind} className="space-y-1 text-sm">
                    <p id={headingId} className="font-medium">
                      {t(headingKey)}
                    </p>
                    <ul aria-labelledby={headingId} className="space-y-1">
                      {files.map((file) => (
                        <li key={file.path} className="font-mono break-all">
                          {file.path}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>
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
                    {status.held.includes(failure.path) && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-2 align-baseline"
                        onClick={showAskSetting}
                      >
                        {t('data.mirrorMassChangeShowSetting')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </div>
        )}
      </CardContent>
      <AdoptFolderDialog
        question={adopt.question}
        onConfirm={() => {
          void adopt.confirm()
        }}
        onDecline={adopt.decline}
      />
      <ImportMergeDialog question={adopt.runner.mergeQuestion} />
    </Card>
  )
}
