/**
 * PageSourceConflictDialog — a source save found the page changed since the
 * buffer was loaded (#5140). Lists what changed elsewhere and offers Merge,
 * Reload, Overwrite, or Keep editing.
 */

import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { diffSourceByAnchor, type SourceChange } from '@/lib/page-source-diff'
import { cn } from '@/lib/utils'

const CHANGE_GLYPH: Record<SourceChange['kind'], string> = {
  added: '+',
  removed: '−',
  changed: '~',
}

const CHANGE_GLYPH_CLASS: Record<SourceChange['kind'], string> = {
  added: 'text-op-create-foreground',
  removed: 'text-destructive',
  changed: 'text-op-edit-foreground',
}

const CHANGE_LABEL_KEY: Record<SourceChange['kind'], string> = {
  added: 'pageSource.changeAdded',
  removed: 'pageSource.changeRemoved',
  changed: 'pageSource.changeChanged',
}

export interface PageSourceConflictDialogProps {
  /** The source the buffer was loaded from. */
  base: string
  /** The page's source now; the dialog is open while it is set. */
  current: string | null
  onMerge: () => void
  onReload: () => void
  onOverwrite: () => void
  onKeepEditing: () => void
  /** Where focus goes on close; the dialog has no trigger to return it to. */
  onCloseAutoFocus: (event: Event) => void
}

export function PageSourceConflictDialog({
  base,
  current,
  onMerge,
  onReload,
  onOverwrite,
  onKeepEditing,
  onCloseAutoFocus,
}: PageSourceConflictDialogProps) {
  const { t } = useTranslation()
  const mergeHintId = useId()
  const overwriteWarningId = useId()
  const changes = useMemo(
    () => (current === null ? [] : diffSourceByAnchor(base, current)),
    [base, current],
  )

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) onKeepEditing()
      }}
    >
      <DialogContent className="sm:max-w-2xl" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t('pageSource.conflictTitle')}</DialogTitle>
          <DialogDescription>{t('pageSource.conflictDescription')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('pageSource.onlyOrderChanged')}</p>
          ) : (
            <ul className="space-y-1">
              {changes.map((change) => (
                <li key={`${change.kind}:${change.text}`} className="flex gap-2 font-mono text-sm">
                  <span
                    aria-hidden="true"
                    className={cn('shrink-0 font-semibold', CHANGE_GLYPH_CLASS[change.kind])}
                  >
                    {CHANGE_GLYPH[change.kind]}
                  </span>
                  <span className="sr-only">{t(CHANGE_LABEL_KEY[change.kind])}</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words">{change.text}</span>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <p id={mergeHintId} className="text-sm text-muted-foreground">
          {t('pageSource.mergeHint')}
        </p>
        <p id={overwriteWarningId} className="text-sm text-muted-foreground">
          {t('pageSource.overwriteWarning')}
        </p>
        <DialogFooter>
          <Button variant="destructive" onClick={onOverwrite} aria-describedby={overwriteWarningId}>
            {t('pageSource.overwrite')}
          </Button>
          <Button variant="outline" onClick={onReload}>
            {t('action.reload')}
          </Button>
          <Button variant="outline" onClick={onKeepEditing}>
            {t('pageSource.keepEditing')}
          </Button>
          <Button
            onClick={onMerge}
            aria-describedby={mergeHintId}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the primary action is last, as in every dialog here, and Radix would otherwise focus Overwrite, the first button, so a reflexive Enter would discard the page's changes
            autoFocus
          >
            {t('pageSource.merge')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
