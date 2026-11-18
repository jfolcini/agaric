/**
 * *Open a folder of notes* in the mirror's card (#6540): the row that picks
 * and imports a folder, and the preview shown before it is adopted in place
 * as its space's mirror folder, saying what adopting does to its files, the
 * lines of each file Agaric writes in its own form once their block is
 * changed, and the files it leaves alone.
 */

import { FolderInput } from 'lucide-react'
import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { PageSourceChanges } from '@/components/pages/PageSourceChanges'
import type { AdoptionQuestion, UseAdoptFolder } from '@/components/settings/useAdoptFolder'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingRow } from '@/components/ui/setting-row'
import { Spinner } from '@/components/ui/spinner'
import type { AdoptChange } from '@/lib/bindings'
import { diffLines } from '@/lib/line-diff'

function FileChanges({ change }: { change: AdoptChange }): React.ReactElement {
  const diff = useMemo(() => diffLines(change.before, change.after), [change])
  return (
    <li>
      <p className="font-mono text-sm break-all">{change.path}</p>
      <PageSourceChanges diff={diff} />
    </li>
  )
}

export function AdoptFolderDialog({
  question,
  onConfirm,
  onDecline,
  onDismiss,
}: {
  question: AdoptionQuestion | null
  onConfirm: () => void
  /** *Not now*: the notes stay in their space, and the user is told so. */
  onDecline: () => void
  /** The dialog closed, after a confirm or by Escape. */
  onDismiss: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const changes = question?.preview.changes ?? []
  const leftAlone = question?.preview.left_alone ?? []
  return (
    <ConfirmDialog
      open={question !== null}
      // A confirm closes the dialog too, so only *Not now* says the folder stays unmirrored.
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
      onCancel={onDecline}
      titleKey="data.mirrorAdoptTitle"
      descriptionKey="data.mirrorAdoptDescription"
      confirmKey="data.mirrorAdoptConfirm"
      cancelKey="data.mirrorAdoptDecline"
      values={{ name: question?.name ?? '' }}
      onConfirm={onConfirm}
      contentTestId="mirror-adopt-dialog"
      actionTestId="mirror-adopt-confirm"
      cancelTestId="mirror-adopt-decline"
    >
      <ScrollArea className="max-h-[50vh]">
        <div className="space-y-3 text-sm">
          <h3 className="font-medium">
            {t('data.mirrorAdoptChangesHeading', { count: changes.length })}
          </h3>
          {changes.length === 0 ? (
            <p className="text-muted-foreground">{t('data.mirrorAdoptNoChanges')}</p>
          ) : (
            <ul className="space-y-3" data-testid="mirror-adopt-changes">
              {changes.map((change) => (
                <FileChanges key={change.path} change={change} />
              ))}
            </ul>
          )}
          {leftAlone.length > 0 && (
            <>
              <h3 className="font-medium">
                {t('data.mirrorAdoptLeftAloneHeading', { count: leftAlone.length })}
              </h3>
              <ul
                className="list-disc pl-5 font-mono break-all"
                data-testid="mirror-adopt-left-alone"
              >
                {leftAlone.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </ScrollArea>
    </ConfirmDialog>
  )
}

/**
 * *Open a folder of notes* (#6540): one folder picked, imported and, once
 * the preview is confirmed, kept in place as its space's mirror folder.
 */
export function AdoptFolderRow({
  adopt,
  disabled,
}: {
  adopt: UseAdoptFolder
  disabled: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const { importing, currentFileIndex, totalFiles, cancel } = adopt.runner
  return (
    <SettingRow label={t('data.mirrorAdoptLabel')} description={t('data.mirrorAdoptDesc')}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || importing}
          onClick={() => {
            void adopt.start()
          }}
        >
          {importing ? <Spinner /> : <FolderInput />}
          {t('data.mirrorAdoptButton')}
        </Button>
        {importing && (
          <>
            <output className="text-sm text-muted-foreground">
              {t('data.mirrorAdoptImporting', {
                current: currentFileIndex ?? 0,
                total: totalFiles,
              })}
            </output>
            <Button variant="ghost" size="sm" onClick={cancel}>
              {t('data.mirrorAdoptCancel')}
            </Button>
          </>
        )}
      </div>
    </SettingRow>
  )
}
