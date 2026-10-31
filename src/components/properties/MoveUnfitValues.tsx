/**
 * MoveUnfitValues -- the Move step of the "don't fit" review (#6206). A key's
 * values that don't fit it, the Trash's included, move to another of the
 * space's keys on the same blocks, where they fit read under that key's type
 * (a number becomes its text under a text key), in one op the toast can undo.
 * Picking the key previews what moves, what stays because its block holds
 * that key already, and what stays because it doesn't fit there; the move
 * sends that preview as its acknowledgement, and when the backend refuses it
 * (the values changed since), the step says so and previews again, as
 * `MergePropertyDefinition` does.
 */

import type React from 'react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { unwrap, validationCode } from '@/lib/app-error'
import type { PropertyDefinition, UnfitMoveCounts, WithOps } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { ValidationCode } from '@/lib/search-query/validation-codes'

export interface MoveUnfitValuesProps {
  definition: PropertyDefinition
  spaceId: string
  /** The keys the values can move to. */
  targets: readonly PropertyDefinition[]
  onBack: () => void
  /** The values changed since they were shown: the review counts them again. */
  onChanged: () => void
  onDone: (moved: WithOps<UnfitMoveCounts>, into: string) => void
}

export function MoveUnfitValues({
  definition,
  spaceId,
  targets,
  onBack,
  onChanged,
  onDone,
}: MoveUnfitValuesProps): React.ReactElement {
  const { t } = useTranslation()
  const { isMobile, Footer } = useDialogOrSheet('dialog')
  const { key } = definition
  const [into, setInto] = useState<string | null>(null)
  const [counts, setCounts] = useState<UnfitMoveCounts | null>(null)
  // Asked again: the values changed after the user saw them.
  const [askedAgain, setAskedAgain] = useState(false)
  const [writing, setWriting] = useState(false)
  // A preview answered after another pick must not show its counts.
  const previewSeq = useRef(0)

  const preview = async (target: string): Promise<void> => {
    const seq = ++previewSeq.current
    setCounts(null)
    try {
      const previewed = unwrap(await commands.previewUnfitPropertyMove(spaceId, key, target))
      if (seq === previewSeq.current) setCounts(previewed)
    } catch (error) {
      reportIpcErrorWithReason('MoveUnfitValues', 'propertiesView.movePreviewFailed', error, t, {
        key,
        into: target,
      })
    }
  }

  const pick = (target: string): void => {
    setInto(target)
    setAskedAgain(false)
    // `preview` reports its own failure; never rejects.
    void preview(target)
  }

  const move = async (): Promise<void> => {
    if (into === null || counts === null || writing) return
    setWriting(true)
    try {
      onDone(unwrap(await commands.moveUnfitPropertyValues(spaceId, key, into, counts)), into)
    } catch (error) {
      if (validationCode(error) === ValidationCode.UnacknowledgedPropertyLoss) {
        setAskedAgain(true)
        onChanged()
        await preview(into)
      } else {
        reportIpcErrorWithReason('MoveUnfitValues', 'propertiesView.moveFailed', error, t, {
          key,
          into,
        })
      }
    } finally {
      setWriting(false)
    }
  }

  const body = (
    <div className="space-y-3 text-sm">
      <Select value={into ?? ''} onValueChange={pick}>
        <SelectTrigger aria-label={t('propertiesView.moveTargetLabel')}>
          <SelectValue placeholder={t('propertiesView.moveTargetPlaceholder')} />
        </SelectTrigger>
        <SelectContent>
          {targets.map((target) => (
            <SelectItem key={target.key} value={target.key}>
              {target.key}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {askedAgain && (
        <p role="alert" className="text-destructive">
          {t('propertiesView.typeChangeCountsChanged')}
        </p>
      )}
      {into !== null && counts !== null && (
        <div className="space-y-1" data-testid="property-unfit-move-counts">
          <p>{t('propertiesView.moveMoves', { count: counts.moved, into })}</p>
          <p>{t('propertiesView.moveOccupied', { count: counts.occupied, into })}</p>
          <p>{t('propertiesView.moveUnfitThere', { count: counts.unfit_there, into })}</p>
          <p className="text-muted-foreground">{t('propertiesView.mergeTrashNote')}</p>
        </div>
      )}
    </div>
  )

  return (
    <>
      {isMobile ? body : <DialogBody>{body}</DialogBody>}
      <Footer>
        <Button variant="outline" onClick={onBack}>
          {t('nav.back')}
        </Button>
        <Button
          disabled={counts === null || counts.moved === 0 || writing}
          onClick={() => {
            // `move` reports its own failure; never rejects.
            void move()
          }}
        >
          {t('propertiesView.moveConfirm', { count: counts?.moved ?? 0 })}
        </Button>
      </Footer>
    </>
  )
}
