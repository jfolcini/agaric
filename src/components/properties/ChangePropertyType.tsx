/**
 * ChangePropertyType -- "Change type…" on a user property definition (#5841).
 * `change_property_type` converts each value the space's blocks hold under
 * the key, Trash included, and keeps the ones the new type cannot hold as
 * text (#6206), in one op the toast can undo. The dialog shows
 * `preview_property_type_change`'s counts and the blocks behind each first,
 * and the change sends the counts back as its acknowledgement. When the
 * backend refuses that (the values changed since), the dialog previews again
 * and asks again, as `MergePropertyDefinition` does. "Holds several values"
 * turns the key into a list or back (#6741); a change from one value to a
 * list asks where to split each value, and one from a list to text how to
 * join each list.
 */

import { Shapes } from 'lucide-react'
import type React from 'react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { notifyDefinitionWrite } from '@/components/properties/notify-definition-write'
import { type Preview, type Target, TypeChangeTabs } from '@/components/properties/TypeChangeValues'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogBody } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { unwrap, validationCode } from '@/lib/app-error'
import type { ListSeparator, PropertyDefinition } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS } from '@/lib/block-utils'
import { invalidatePropertyCaches } from '@/lib/property-caches'
import { selectOptionsJson, VALUE_TYPES, valueTypeLabel } from '@/lib/property-utils'
import { reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { ValidationCode } from '@/lib/search-query/validation-codes'

export interface ChangePropertyTypeProps {
  definition: PropertyDefinition
  spaceId: string
  /** Read the list again after a change or its undo. */
  onChanged: () => void
  className?: string
}

/** Where to split or join, or `none` for neither; null until the user picks. */
type SeparatorPick = ListSeparator | 'none'

/** What the dialog's controls hold; a null type keeps the key's own. */
interface Draft {
  valueType: string | null
  optionsText: string
  several: boolean
  separator: SeparatorPick | null
}

/** Whether a change to `valueType` holding a list or not asks where to split or how to join. */
function separatorAsked(
  definition: PropertyDefinition,
  valueType: string,
  multiple: boolean,
): 'split' | 'join' | null {
  const wasMultiple = definition.multiple === true
  if (multiple && !wasMultiple) return 'split'
  // Only a text can hold a whole list's items.
  if (!multiple && wasMultiple && (valueType === 'text' || valueType === 'url')) return 'join'
  return null
}

/** The change `draft` asks for; null while it changes nothing or misses an answer. */
function targetOf(definition: PropertyDefinition, draft: Draft): Target | null {
  const valueType = draft.valueType ?? definition.value_type
  // A boolean never holds a list.
  const multiple = draft.several && valueType !== 'boolean'
  const sameType = valueType === definition.value_type
  if (sameType && multiple === (definition.multiple === true)) return null
  const options =
    valueType !== 'select'
      ? null
      : sameType
        ? definition.options
        : selectOptionsJson(draft.optionsText)
  // A select needs its options before the backend can say what fits.
  if (valueType === 'select' && options === null) return null
  const asked = separatorAsked(definition, valueType, multiple)
  if (asked !== null && draft.separator === null) return null
  const separator = asked === null || draft.separator === 'none' ? null : draft.separator
  return { valueType, options, multiple, separator }
}

export function ChangePropertyType({
  definition,
  spaceId,
  onChanged,
  className,
}: ChangePropertyTypeProps): React.ReactElement | null {
  const { t } = useTranslation()
  const parts = useDialogOrSheet('dialog')
  const [open, setOpen] = useState(false)
  const unchanged = (): Draft => ({
    valueType: null,
    optionsText: '',
    several: definition.multiple === true,
    separator: null,
  })
  const [draft, setDraft] = useState<Draft>(unchanged)
  const [shown, setShown] = useState<Preview | null>(null)
  // Asked again: the values changed after the user saw them.
  const [askedAgain, setAskedAgain] = useState(false)
  const [changing, setChanging] = useState(false)
  // A preview answered after another pick must not show its counts.
  const previewSeq = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const severalId = useId()
  const separatorLabelId = useId()
  const { key } = definition

  const preview = async (target: Target): Promise<void> => {
    const seq = ++previewSeq.current
    setShown(null)
    try {
      const counts = unwrap(
        await commands.previewPropertyTypeChange(
          spaceId,
          key,
          target.valueType,
          target.options,
          target.multiple,
          target.separator,
        ),
      )
      if (seq === previewSeq.current) setShown({ target, counts, seq })
    } catch (error) {
      reportIpcErrorWithReason(
        'ChangePropertyType',
        'propertiesView.typeChangePreviewFailed',
        error,
        t,
        { key, valueType: target.valueType },
      )
    }
  }

  // Reads the draft of the commit before it fires: the typed options among it.
  const previewOptions = useDebouncedCallback(() => {
    const target = targetOf(definition, draft)
    // `preview` reports its own failure; never rejects.
    if (target !== null) void preview(target)
  }, 300)

  if (definition.builtin || INTERNAL_PROPERTY_KEYS.has(key)) return null

  const changed = (): void => {
    onChanged()
    invalidatePropertyCaches()
  }

  /** Take `patch` into the draft and preview what it asks for, typed options after a pause. */
  const update = (patch: Partial<Draft>, typed = false): void => {
    const next = { ...draft, ...patch }
    setDraft(next)
    setAskedAgain(false)
    previewOptions.cancel()
    previewSeq.current += 1
    setShown(null)
    const target = targetOf(definition, next)
    if (target === null) return
    if (typed) previewOptions.schedule()
    // `preview` reports its own failure; never rejects.
    else void preview(target)
  }

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (next) return
    previewOptions.cancel()
    previewSeq.current += 1
    setShown(null)
    setAskedAgain(false)
  }

  const change = async (): Promise<void> => {
    if (shown === null || changing) return
    const { target, counts } = shown
    setChanging(true)
    try {
      const result = unwrap(
        await commands.changePropertyType(
          spaceId,
          key,
          target.valueType,
          target.options,
          target.multiple,
          target.separator,
          counts,
        ),
      )
      onOpenChange(false)
      notifyDefinitionWrite(
        t('propertiesView.typeChanged', {
          key,
          type: valueTypeLabel({ value_type: target.valueType, multiple: target.multiple }, t),
        }),
        result.op_refs,
        changed,
      )
      changed()
    } catch (error) {
      if (validationCode(error) === ValidationCode.UnacknowledgedPropertyLoss) {
        setAskedAgain(true)
        await preview(target)
      } else {
        reportIpcErrorWithReason(
          'ChangePropertyType',
          'propertiesView.typeChangeFailed',
          error,
          t,
          {
            key,
            valueType: target.valueType,
          },
        )
      }
    } finally {
      setChanging(false)
    }
  }

  const valueType = draft.valueType ?? definition.value_type
  const asked = separatorAsked(definition, valueType, draft.several && valueType !== 'boolean')
  const { Root, Content, Header, Title, Description, Footer } = parts
  const body = (
    <div className="space-y-3 text-sm">
      <Select value={valueType} onValueChange={(next) => update({ valueType: next })}>
        <SelectTrigger aria-label={t('propertiesView.typeChangeTypeLabel')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {VALUE_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {type}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {valueType === 'select' && definition.value_type !== 'select' && (
        <Input
          value={draft.optionsText}
          onChange={(e) => update({ optionsText: e.target.value }, true)}
          placeholder={t('properties.newSelectOptions')}
          aria-label={t('properties.newSelectOptions')}
        />
      )}
      {valueType !== 'boolean' && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={severalId}
            checked={draft.several}
            onCheckedChange={(checked) => update({ several: checked === true, separator: null })}
          />
          <Label htmlFor={severalId} muted={false}>
            {t('properties.holdsSeveralValues')}
          </Label>
        </div>
      )}
      {asked !== null && (
        <div className="space-y-1">
          <span id={separatorLabelId} className="block font-medium">
            {t(
              asked === 'split'
                ? 'propertiesView.typeChangeSplitLabel'
                : 'propertiesView.typeChangeJoinLabel',
            )}
          </span>
          <ToggleGroup
            type="single"
            className="flex-wrap"
            value={draft.separator ?? ''}
            onValueChange={(value) => {
              if (value === 'comma' || value === 'semicolon' || value === 'none') {
                update({ separator: value })
              }
            }}
            aria-labelledby={separatorLabelId}
          >
            {SEPARATOR_PICKS.map((pick) => (
              <ToggleGroupItem key={pick} value={pick}>
                {t(SEPARATOR_LABELS[asked][pick])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}
      {askedAgain && (
        <p role="alert" className="text-destructive">
          {t('propertiesView.typeChangeCountsChanged')}
        </p>
      )}
      {shown !== null && (
        <>
          <div className="space-y-1" data-testid="property-type-change-counts">
            <p>{t('propertiesView.typeChangeConverts', { count: shown.counts.converted })}</p>
            {shown.counts.unfit > 0 && (
              <p>
                {t('propertiesView.typeChangeUnfit', {
                  count: shown.counts.unfit,
                  type: shown.target.valueType,
                })}
              </p>
            )}
            <p className="text-muted-foreground">{t('propertiesView.typeChangeTrashNote')}</p>
          </div>
          <TypeChangeTabs
            spaceId={spaceId}
            propertyKey={key}
            fromType={definition.value_type}
            preview={shown}
          />
        </>
      )}
    </div>
  )

  return (
    <>
      <IconButton
        ref={triggerRef}
        variant="ghost"
        size="icon-xs"
        tooltip={t('propertiesView.typeChangeTooltip')}
        ariaLabel={t('propertiesView.typeChangeLabel', { key })}
        className={className}
        onClick={() => {
          // From the definition as it stands now: a change or its undo may have moved it.
          setDraft(unchanged())
          setOpen(true)
        }}
      >
        <Shapes />
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
            <Title>{t('propertiesView.typeChangeTitle', { key })}</Title>
            <Description>{t('propertiesView.typeChangeDescription', { key })}</Description>
          </Header>
          {parts.isMobile ? body : <DialogBody>{body}</DialogBody>}
          <Footer>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('action.cancel')}
            </Button>
            <Button
              disabled={shown === null || changing}
              onClick={() => {
                // `change` reports its own failure; never rejects.
                void change()
              }}
            >
              {t('propertiesView.typeChangeConfirm')}
            </Button>
          </Footer>
        </Content>
      </Root>
    </>
  )
}

const SEPARATOR_PICKS: readonly SeparatorPick[] = ['comma', 'semicolon', 'none']

const SEPARATOR_LABELS: Readonly<Record<'split' | 'join', Record<SeparatorPick, string>>> = {
  split: {
    comma: 'propertiesView.typeChangeSplitComma',
    semicolon: 'propertiesView.typeChangeSplitSemicolon',
    none: 'propertiesView.typeChangeSplitNone',
  },
  join: {
    comma: 'propertiesView.typeChangeJoinComma',
    semicolon: 'propertiesView.typeChangeJoinSemicolon',
    none: 'propertiesView.typeChangeJoinNone',
  },
}
