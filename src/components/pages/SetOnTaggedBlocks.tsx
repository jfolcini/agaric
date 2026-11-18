/**
 * SetOnTaggedBlocks — "Set on tagged blocks" in a tag's "Properties for
 * tagged blocks" (#6755): one of the tag's keys, a value in that key's typed
 * editor, and whether blocks tagged with a nested tag count and whether held
 * values are overwritten (both off by default). The preview counts what the
 * write does; confirming writes it as one transaction, one Undo in the toast.
 * A count that changed meanwhile is refused and asked again.
 *
 * A key whose values are pages or a list is left out: their editors write to
 * a block themselves, and there is no one block here.
 */

import { useId, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { notifyDefinitionWrite } from '@/components/properties/notify-definition-write'
import { PropertyRowEditor } from '@/components/properties/PropertyRowEditor'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { reloadChangedPageStores } from '@/hooks/useSyncEvents'
import { unwrap, validationCode } from '@/lib/app-error'
import type {
  PropertyDefinition,
  PropertyRow,
  TaggedBlocksWrite,
  TaggedWriteCounts,
} from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { notify } from '@/lib/notify'
import { invalidatePropertyCaches } from '@/lib/property-caches'
import { buildPropertyParams, type SetPropertyParams } from '@/lib/property-save-utils'
import { reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { ValidationCode } from '@/lib/search-query/validation-codes'

export interface SetOnTaggedBlocksProps {
  tagId: string
  keys: string[]
  definitions: PropertyDefinition[]
}

/** The row the value editor shows: `raw` read as `key`'s type, or empty. */
function rowOf(key: string, raw: string, valueType: string): PropertyRow {
  const built = buildPropertyParams('', key, raw, valueType)
  const p: Partial<SetPropertyParams> = built.ok ? built.params : {}
  return {
    key,
    value_text: p.valueText ?? null,
    value_num: p.valueNum ?? null,
    value_date: p.valueDate ?? null,
    value_ref: null,
    value_bool: p.valueBool == null ? null : p.valueBool ? 1 : 0,
  }
}

export function SetOnTaggedBlocks({
  tagId,
  keys,
  definitions,
}: SetOnTaggedBlocksProps): React.ReactElement | null {
  const { t } = useTranslation()
  const nestedId = useId()
  const overwriteId = useId()
  const settable = keys.filter((k) => {
    const def = definitions.find((d) => d.key === k)
    return def === undefined || (def.value_type !== 'ref' && def.multiple !== true)
  })
  const [chosen, setChosen] = useState<string | null>(null)
  const [raw, setRaw] = useState('')
  const [includeNested, setIncludeNested] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [counts, setCounts] = useState<TaggedWriteCounts | null>(null)
  const key = chosen !== null && settable.includes(chosen) ? chosen : (settable[0] ?? null)
  if (key === null) return null
  const def = definitions.find((d) => d.key === key)
  const valueType = def?.value_type ?? 'text'

  const request = (): TaggedBlocksWrite | null => {
    const built = buildPropertyParams(tagId, key, raw, valueType)
    if (!built.ok || raw.trim() === '') return null
    const p = built.params
    return {
      tag_id: tagId,
      key,
      value: {
        value_text: p.valueText ?? null,
        value_num: p.valueNum ?? null,
        value_date: p.valueDate ?? null,
        value_ref: null,
        value_bool: p.valueBool ?? null,
      },
      include_nested: includeNested,
      overwrite,
    }
  }

  /** Count the write; `true` when there is something to confirm. */
  const preview = async (): Promise<boolean> => {
    const write = request()
    if (write === null) {
      notify.error(t('tagProperties.valueNeeded'))
      return false
    }
    try {
      const next = unwrap(await commands.previewSetPropertyOnTaggedBlocks(write))
      if (next.added + next.changed === 0) {
        notify.success(t('tagProperties.nothingToSet', { key }))
        return false
      }
      setCounts(next)
      return true
    } catch (err) {
      reportIpcErrorWithReason('SetOnTaggedBlocks', 'tagProperties.setFailed', err, t, { tagId })
      return false
    }
  }

  const apply = async (acknowledged: TaggedWriteCounts): Promise<void> => {
    const write = request()
    if (write === null) return
    try {
      const done = unwrap(await commands.setPropertyOnTaggedBlocks(write, acknowledged))
      setCounts(null)
      const changed = () => {
        invalidatePropertyCaches()
        reloadChangedPageStores()
      }
      notifyDefinitionWrite(
        t('tagProperties.setDone', { n: done.added + done.changed, key }),
        done.op_refs,
        changed,
      )
      changed()
    } catch (err) {
      if (validationCode(err) === ValidationCode.UnacknowledgedPropertyLoss) {
        notify.error(t('tagProperties.countsChanged'))
        // Thrown into `ConfirmDialog` so it stays open on the new counts.
        if (await preview()) throw err
        return
      }
      reportIpcErrorWithReason('SetOnTaggedBlocks', 'tagProperties.setFailed', err, t, { tagId })
    }
  }

  return (
    <div className="space-y-2" data-testid="set-on-tagged-blocks">
      <h3 className="text-sm font-medium">{t('tagProperties.setTitle')}</h3>
      <Select
        value={key}
        onValueChange={(next) => {
          setChosen(next)
          setRaw('')
        }}
      >
        <SelectTrigger size="sm" aria-label={t('tagProperties.keyLabel')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {settable.map((k) => (
            <SelectItem key={k} value={k}>
              {k}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <PropertyRowEditor
        key={key}
        blockId={tagId}
        prop={rowOf(key, raw, valueType)}
        def={def}
        onSave={setRaw}
      />
      <div className="flex items-center gap-2">
        <Checkbox
          id={nestedId}
          checked={includeNested}
          onCheckedChange={(v) => setIncludeNested(v === true)}
        />
        <Label htmlFor={nestedId}>{t('tagProperties.includeNested')}</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={overwriteId}
          checked={overwrite}
          onCheckedChange={(v) => setOverwrite(v === true)}
        />
        <Label htmlFor={overwriteId}>{t('tagProperties.overwrite')}</Label>
      </div>
      <Button size="sm" variant="outline" onClick={() => void preview()}>
        {t('tagProperties.setButton')}
      </Button>
      <ConfirmDialog
        open={counts !== null}
        onOpenChange={(open) => {
          if (!open) setCounts(null)
        }}
        titleKey="tagProperties.confirmTitle"
        descriptionKey={
          overwrite ? 'tagProperties.confirmWithOverwrite' : 'tagProperties.confirmDescription'
        }
        values={{ key, added: counts?.added ?? 0, changed: counts?.changed ?? 0 }}
        confirmKey="tagProperties.confirmButton"
        cancelKey="action.cancel"
        onConfirm={() => (counts ? apply(counts) : undefined)}
      />
    </div>
  )
}
