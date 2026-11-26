/**
 * AddPropertyPopover — shared popover for adding a property from
 * existing definitions, with optional "create new definition" flow.
 *
 * Used by both PagePropertyTable (with `supportCreateDef`) and
 * BlockPropertyDrawer (without).
 */

import { Plus } from 'lucide-react'
import { useCallback, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { InfoPopover } from '@/components/ui/info-popover'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { PropertyDefinition } from '@/lib/bindings'
import { foldForSearch, matchesSearchFolded } from '@/lib/fold-for-search'
import { keepFocusThatMovedOn } from '@/lib/keep-focus-that-moved-on'
import { formatPropertyName, selectOptionsJson, valueTypeLabel } from '@/lib/property-utils'

export interface AddPropertyPopoverProps {
  /** Definitions to show in the picker. Already filtered by the parent. */
  definitions: PropertyDefinition[]
  /** Called when the user picks an existing definition. */
  onAdd: (def: PropertyDefinition) => void | Promise<void>
  /** When true, show the "Create new definition" flow. */
  supportCreateDef?: boolean
  /**
   * Called when a new definition is created via the create flow. `options` is
   * the select's options JSON, `null` for every other type; `multiple` that the
   * key holds a list of `valueType` items.
   */
  onCreateDef?: (
    key: string,
    valueType: string,
    options: string | null,
    multiple: boolean,
  ) => void | Promise<void>
  /** Controlled open state (optional). */
  open?: boolean
  /** Controlled open-change handler (optional). */
  onOpenChange?: (open: boolean) => void
  /** When true, the trigger is disabled and an ⓘ beside it explains why. */
  disabled?: boolean
  /** The ⓘ's explanation while disabled. */
  disabledTooltip?: string
}

export function AddPropertyPopover({
  definitions,
  onAdd,
  supportCreateDef,
  onCreateDef,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  disabled,
  disabledTooltip,
}: AddPropertyPopoverProps) {
  const { t } = useTranslation()
  const [internalOpen, setInternalOpen] = useState(false)
  const [defSearch, setDefSearch] = useState('')
  const [creatingDef, setCreatingDef] = useState(false)
  const [newDefType, setNewDefType] = useState('text')
  const [newDefOptions, setNewDefOptions] = useState('')
  const newDefOptionsJson = newDefType === 'select' ? selectOptionsJson(newDefOptions) : null
  // A boolean never holds a list.
  const [newDefSeveral, setNewDefSeveral] = useState(false)
  const newDefMultiple = newDefSeveral && newDefType !== 'boolean'
  const severalId = useId()

  const isControlled = controlledOpen !== undefined
  const popoverOpen = isControlled ? controlledOpen : internalOpen
  const setPopoverOpen = useCallback(
    (next: boolean) => {
      if (isControlled) {
        controlledOnOpenChange?.(next)
      } else {
        setInternalOpen(next)
      }
    },
    [isControlled, controlledOnOpenChange],
  )

  // Unicode-aware fold. Both the filter and the
  // "exists-exact-match" check must agree on Unicode equivalence
  // (`café-visits` matching `cafe`), otherwise the picker shows
  // the matching definition AND the `t('pageProperty.createButton')`
  // suggestion at the same time.
  const filteredDefs = definitions.filter((d) => matchesSearchFolded(d.key, defSearch))

  const searchMatchesExistingDef = definitions.some(
    (d) => foldForSearch(d.key) === foldForSearch(defSearch.trim()),
  )

  const handleAddFromDef = useCallback(
    async (def: PropertyDefinition) => {
      await onAdd(def)
      setPopoverOpen(false)
      setDefSearch('')
    },
    [onAdd, setPopoverOpen],
  )

  const handleCreateDef = useCallback(async () => {
    const key = defSearch.trim()
    if (!key || !onCreateDef) return
    await onCreateDef(key, newDefType, newDefOptionsJson, newDefMultiple)
    setPopoverOpen(false)
    setDefSearch('')
    setCreatingDef(false)
    setNewDefType('text')
    setNewDefOptions('')
    setNewDefSeveral(false)
  }, [defSearch, newDefType, newDefOptionsJson, newDefMultiple, onCreateDef, setPopoverOpen])

  const triggerButton = (
    <Button
      variant="ghost"
      size="xs"
      className="gap-1 text-muted-foreground"
      aria-label={t('pageProperty.addPropertyLabel')}
      disabled={disabled}
    >
      <Plus />
      {t('pageProperty.addPropertyButton')}
    </Button>
  )

  // A disabled button opens nothing, so it needs no picker around it.
  if (disabled && disabledTooltip) {
    return (
      <span className="inline-flex items-center gap-1">
        {triggerButton}
        <InfoPopover
          variant="icon"
          ariaLabel={t('pageProperty.addPropertyDisabledInfo')}
          content={disabledTooltip}
        />
      </span>
    )
  }

  const pickerBody = (
    <>
      <Input
        placeholder={t('pageProperty.searchPlaceholder')}
        value={defSearch}
        onChange={(e) => {
          setDefSearch(e.target.value)
          setCreatingDef(false)
        }}
        aria-label={t('pageProperty.searchLabel')}
        className="h-8"
      />
      <ScrollArea className="max-h-[min(240px,40vh)]">
        {filteredDefs.map((def) => (
          <Button
            key={def.key}
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => void handleAddFromDef(def)}
          >
            <span className="flex-1 text-left">{formatPropertyName(def.key)}</span>
            <Badge tone="outline" className="font-mono text-xs">
              {valueTypeLabel(def, t)}
            </Badge>
          </Button>
        ))}
      </ScrollArea>

      {/* "Create new definition" prompt —  sub-fix 7: surface the
          default value type so users know what they get when clicking. */}
      {supportCreateDef && defSearch.trim() && !searchMatchesExistingDef && !creatingDef && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-muted-foreground"
          onClick={() => setCreatingDef(true)}
        >
          {t('pageProperty.createButton', { name: defSearch.trim() })}
          <span className="ml-1 text-xs text-muted-foreground" data-testid="create-new-type-hint">
            {t('properties.createNewTypeHint')}
          </span>
        </Button>
      )}

      {/* Type selector for creating a new definition */}
      {creatingDef && (
        <div className="space-y-2">
          <Label size="xs" htmlFor="new-def-type">
            {t('pageProperty.valueTypeLabel')}
          </Label>
          <Select value={newDefType} onValueChange={setNewDefType}>
            <SelectTrigger
              id="new-def-type"
              className="w-full"
              aria-label={t('pageProperty.valueTypeLabel')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">{t('pageProperty.textType')}</SelectItem>
              <SelectItem value="number">{t('pageProperty.numberType')}</SelectItem>
              <SelectItem value="date">{t('pageProperty.dateType')}</SelectItem>
              <SelectItem value="datetime">{t('pageProperty.datetimeType')}</SelectItem>
              <SelectItem value="select">{t('pageProperty.selectType')}</SelectItem>
              <SelectItem value="ref">{t('pageProperty.refType')}</SelectItem>
              <SelectItem value="boolean">{t('pageProperty.booleanType')}</SelectItem>
              <SelectItem value="url">{t('pageProperty.urlType')}</SelectItem>
            </SelectContent>
          </Select>
          {newDefType === 'select' && (
            <Input
              value={newDefOptions}
              onChange={(e) => setNewDefOptions(e.target.value)}
              placeholder={t('properties.newSelectOptions')}
              aria-label={t('properties.newSelectOptions')}
              className="h-8"
            />
          )}
          {newDefType !== 'boolean' && (
            <div className="flex items-center gap-2">
              <Checkbox
                id={severalId}
                checked={newDefSeveral}
                onCheckedChange={(checked) => setNewDefSeveral(checked === true)}
              />
              <Label size="xs" htmlFor={severalId} muted={false}>
                {t('properties.holdsSeveralValues')}
              </Label>
            </div>
          )}
          <Button
            size="sm"
            className="w-full"
            onClick={() => void handleCreateDef()}
            disabled={newDefType === 'select' && newDefOptionsJson === null}
          >
            {t('pageProperty.createDefinitionButton')}
          </Button>
        </div>
      )}
    </>
  )

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={setPopoverOpen}
      sheetTitle={t('pageProperty.addPropertyButton')}
    >
      <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      <MenuPopoverContent
        className="space-y-2 p-3"
        aria-label={t('pageProperty.pickerLabel')}
        onCloseAutoFocus={keepFocusThatMovedOn}
      >
        {pickerBody}
      </MenuPopoverContent>
    </Popover>
  )
}
