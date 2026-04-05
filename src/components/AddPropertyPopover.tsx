/**
 * AddPropertyPopover — shared popover for adding a property from
 * existing definitions, with optional "create new definition" flow.
 *
 * Used by both PagePropertyTable (with `supportCreateDef`) and
 * BlockPropertyDrawer (without).
 */

import { Plus } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatPropertyName } from '@/lib/property-utils'
import type { PropertyDefinition } from '../lib/tauri'

export interface AddPropertyPopoverProps {
  /** Definitions to show in the picker. Already filtered by the parent. */
  definitions: PropertyDefinition[]
  /** Called when the user picks an existing definition. */
  onAdd: (def: PropertyDefinition) => void | Promise<void>
  /** When true, show the "Create new definition" flow. */
  supportCreateDef?: boolean
  /** Called when a new definition is created via the create flow. */
  onCreateDef?: (key: string, valueType: string) => void | Promise<void>
  /** Controlled open state (optional). */
  open?: boolean
  /** Controlled open-change handler (optional). */
  onOpenChange?: (open: boolean) => void
}

export function AddPropertyPopover({
  definitions,
  onAdd,
  supportCreateDef,
  onCreateDef,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: AddPropertyPopoverProps) {
  const { t } = useTranslation()
  const [internalOpen, setInternalOpen] = useState(false)
  const [defSearch, setDefSearch] = useState('')
  const [creatingDef, setCreatingDef] = useState(false)
  const [newDefType, setNewDefType] = useState('text')

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

  const filteredDefs = definitions.filter(
    (d) => !defSearch || d.key.toLowerCase().includes(defSearch.toLowerCase()),
  )

  const searchMatchesExistingDef = definitions.some(
    (d) => d.key.toLowerCase() === defSearch.trim().toLowerCase(),
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
    await onCreateDef(key, newDefType)
    setPopoverOpen(false)
    setDefSearch('')
    setCreatingDef(false)
    setNewDefType('text')
  }, [defSearch, newDefType, onCreateDef, setPopoverOpen])

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="gap-1 text-muted-foreground"
          aria-label={t('pageProperty.addPropertyLabel')}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('pageProperty.addPropertyButton')}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 space-y-2 p-3 max-w-[calc(100vw-2rem)]"
        aria-label={t('pageProperty.pickerLabel')}
      >
        <Input
          placeholder={t('pageProperty.searchPlaceholder')}
          value={defSearch}
          onChange={(e) => {
            setDefSearch(e.target.value)
            setCreatingDef(false)
          }}
          aria-label={t('pageProperty.searchLabel')}
        />
        <ScrollArea className="max-h-40">
          {filteredDefs.map((def) => (
            <button
              key={def.key}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1
                text-left text-sm hover:bg-accent"
              onClick={() => handleAddFromDef(def)}
            >
              <span className="flex-1">{formatPropertyName(def.key)}</span>
              <Badge variant="outline" className="font-mono text-xs">
                {def.value_type}
              </Badge>
            </button>
          ))}
        </ScrollArea>

        {/* "Create new definition" prompt */}
        {supportCreateDef && defSearch.trim() && !searchMatchesExistingDef && !creatingDef && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={() => setCreatingDef(true)}
          >
            {t('pageProperty.createButton', { name: defSearch.trim() })}
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
                <SelectItem value="select">{t('pageProperty.selectType')}</SelectItem>
                <SelectItem value="ref">{t('pageProperty.refType')}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" className="w-full" onClick={handleCreateDef}>
              {t('pageProperty.createDefinitionButton')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
