/**
 * MergePropertyDefinition -- "Merge into…" on a user property definition
 * (#5841). `merge_property_key` moves the key's values to another definition
 * of the same type and removes the key, in one op the toast can undo. A block
 * holding both keys keeps the target's value and loses this one, so the
 * dialog shows `preview_property_merge`'s counts first and the merge sends
 * them back as its acknowledgement. When the backend refuses that (the counts
 * changed since), the dialog previews again and asks again, as
 * `useSpaceMove` does for a cross-space move.
 */

import { Merge } from 'lucide-react'
import type React from 'react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { notifyDefinitionWrite } from '@/components/properties/notify-definition-write'
import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { unwrap, validationCode } from '@/lib/app-error'
import type { PropertyDefinition, PropertyMergeCounts } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS } from '@/lib/block-utils'
import { invalidatePropertyCaches } from '@/lib/property-caches'
import { reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { ValidationCode } from '@/lib/search-query/validation-codes'

export interface MergePropertyDefinitionProps {
  definition: PropertyDefinition
  spaceId: string
  /** The space's definitions: the merge targets are its user ones of the same type. */
  definitions: readonly PropertyDefinition[]
  /** Read the list again after a merge or its undo. */
  onChanged: () => void
  className?: string
}

export function MergePropertyDefinition({
  definition,
  spaceId,
  definitions,
  onChanged,
  className,
}: MergePropertyDefinitionProps): React.ReactElement | null {
  const { t } = useTranslation()
  const parts = useDialogOrSheet('dialog')
  const [open, setOpen] = useState(false)
  const [into, setInto] = useState<string | null>(null)
  const [counts, setCounts] = useState<PropertyMergeCounts | null>(null)
  // Asked again: the counts changed after the user saw them.
  const [askedAgain, setAskedAgain] = useState(false)
  const [merging, setMerging] = useState(false)
  const inProgress = useRef(false)
  // A preview answered after another pick must not show its counts.
  const previewSeq = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { key } = definition
  const targets = definitions.filter(
    (d) =>
      !d.builtin &&
      d.key !== key &&
      d.value_type === definition.value_type &&
      !INTERNAL_PROPERTY_KEYS.has(d.key),
  )
  if (targets.length === 0) return null

  const changed = (): void => {
    onChanged()
    invalidatePropertyCaches()
  }

  const preview = async (target: string): Promise<void> => {
    const seq = ++previewSeq.current
    setCounts(null)
    try {
      const previewed = unwrap(await commands.previewPropertyMerge(spaceId, key, target))
      if (seq === previewSeq.current) setCounts(previewed)
    } catch (error) {
      reportIpcErrorWithReason(
        'MergePropertyDefinition',
        'propertiesView.mergePreviewFailed',
        error,
        t,
        { key, into: target },
      )
    }
  }

  const pick = (target: string): void => {
    setInto(target)
    setAskedAgain(false)
    // `preview` reports its own failure; never rejects.
    void preview(target)
  }

  const merge = async (): Promise<void> => {
    if (into === null || counts === null || inProgress.current) return
    inProgress.current = true
    setMerging(true)
    try {
      const merged = unwrap(await commands.mergePropertyKey(spaceId, key, into, counts))
      setOpen(false)
      notifyDefinitionWrite(
        t('propertiesView.merged', { from: key, into }),
        merged.op_refs,
        changed,
      )
      changed()
    } catch (error) {
      if (validationCode(error) === ValidationCode.UnacknowledgedPropertyLoss) {
        setAskedAgain(true)
        await preview(into)
      } else {
        reportIpcErrorWithReason(
          'MergePropertyDefinition',
          'propertiesView.mergeFailed',
          error,
          t,
          {
            key,
            into,
          },
        )
      }
    } finally {
      inProgress.current = false
      setMerging(false)
    }
  }

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (next) return
    previewSeq.current += 1
    setInto(null)
    setCounts(null)
    setAskedAgain(false)
  }

  const { Root, Content, Header, Title, Description, Footer } = parts
  const body = (
    <div className="space-y-3 text-sm">
      <Select value={into ?? ''} onValueChange={pick}>
        <SelectTrigger aria-label={t('propertiesView.mergeTargetLabel')}>
          <SelectValue placeholder={t('propertiesView.mergeTargetPlaceholder')} />
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
          {t('propertiesView.mergeCountsChanged')}
        </p>
      )}
      {into !== null && counts !== null && (
        <div className="space-y-1" data-testid="property-merge-counts">
          <p>{t('propertiesView.mergeMoves', { count: counts.moved, into })}</p>
          {counts.dropped > 0 && (
            <p>{t('propertiesView.mergeDrops', { count: counts.dropped, into, from: key })}</p>
          )}
          <p className="text-muted-foreground">{t('propertiesView.mergeTrashNote')}</p>
        </div>
      )}
    </div>
  )

  return (
    <>
      <IconButton
        ref={triggerRef}
        variant="ghost"
        size="icon-xs"
        tooltip={t('propertiesView.mergeTooltip')}
        ariaLabel={t('propertiesView.mergeLabel', { key })}
        className={className}
        onClick={() => setOpen(true)}
      >
        <Merge />
      </IconButton>
      <Root open={open} onOpenChange={onOpenChange}>
        <Content
          onCloseAutoFocus={(event: Event) => {
            // No dialog trigger to return to: the opener, while its row stands.
            event.preventDefault()
            if (triggerRef.current?.isConnected) triggerRef.current.focus()
          }}
        >
          <Header>
            <Title>{t('propertiesView.mergeTitle', { key })}</Title>
            <Description>{t('propertiesView.mergeDescription', { key })}</Description>
          </Header>
          {parts.isMobile ? body : <DialogBody>{body}</DialogBody>}
          <Footer>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('action.cancel')}
            </Button>
            <Button
              disabled={counts === null || merging}
              onClick={() => {
                // `merge` reports its own failure; never rejects.
                void merge()
              }}
            >
              {t('propertiesView.mergeConfirm')}
            </Button>
          </Footer>
        </Content>
      </Root>
    </>
  )
}
