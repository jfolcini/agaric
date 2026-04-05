/**
 * PropertyRowEditor — renders a single property row with typed input.
 *
 * Supports text, number, date, and select value types with inline editing.
 * For select properties, includes a popover to manage the set of allowed
 * options (add / remove / save).
 *
 * Extracted from PagePropertyTable for reuse.
 */

import { Pencil, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import type { PropertyDefinition, PropertyRow } from '../lib/tauri'
import { updatePropertyDefOptions } from '../lib/tauri'

export interface PropertyRowEditorProps {
  prop: PropertyRow
  def: PropertyDefinition | undefined
  onSave: (rawValue: string) => void
  onDelete: () => void
  onDefUpdated?: (updatedDef: PropertyDefinition) => void
}

export function PropertyRowEditor({
  prop,
  def,
  onSave,
  onDelete,
  onDefUpdated,
}: PropertyRowEditorProps) {
  const { t } = useTranslation()
  const valueType = def?.value_type ?? 'text'

  const currentValue = (() => {
    if (prop.value_text != null) return prop.value_text
    if (prop.value_num != null) return String(prop.value_num)
    if (prop.value_date != null) return prop.value_date
    return ''
  })()

  const [localValue, setLocalValue] = useState(currentValue)

  // Sync localValue when prop changes externally
  useEffect(() => {
    setLocalValue(currentValue)
  }, [currentValue])

  const handleBlur = useCallback(() => {
    if (localValue !== currentValue) {
      onSave(localValue)
    }
  }, [localValue, currentValue, onSave])

  const handleSelectChange = useCallback(
    (val: string) => {
      const resolved = val === '__none__' ? '' : val
      setLocalValue(resolved)
      onSave(resolved)
    },
    [onSave],
  )

  const selectOptions: string[] = (() => {
    if (valueType !== 'select' || !def?.options) return []
    try {
      const parsed = JSON.parse(def.options)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })()

  // --- Edit select options popover state ---
  const [editOptionsOpen, setEditOptionsOpen] = useState(false)
  const [editingOptions, setEditingOptions] = useState<string[]>([])
  const [newOptionInput, setNewOptionInput] = useState('')

  const handleOpenEditOptions = useCallback(() => {
    setEditingOptions([...selectOptions])
    setNewOptionInput('')
    setEditOptionsOpen(true)
  }, [selectOptions])

  const handleRemoveOption = useCallback((opt: string) => {
    setEditingOptions((prev) => prev.filter((o) => o !== opt))
  }, [])

  const handleAddOption = useCallback(() => {
    const trimmed = newOptionInput.trim()
    if (!trimmed) return
    setEditingOptions((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]))
    setNewOptionInput('')
  }, [newOptionInput])

  const handleSaveOptions = useCallback(async () => {
    if (!def) return
    try {
      const updatedDef = await updatePropertyDefOptions(def.key, JSON.stringify(editingOptions))
      onDefUpdated?.(updatedDef)
      setEditOptionsOpen(false)
    } catch {
      toast.error(t('pageProperty.updateOptionsFailed'))
    }
  }, [def, editingOptions, onDefUpdated, t])

  return (
    <div className="property-row flex items-center gap-2 text-sm">
      <Badge variant="outline" className="shrink-0 font-mono text-xs">
        {formatPropertyName(prop.key)}
      </Badge>
      <div className="flex-1">
        {valueType === 'select' ? (
          <Select value={localValue || '__none__'} onValueChange={handleSelectChange}>
            <SelectTrigger
              className="w-full"
              aria-label={t('pageProperty.valueLabel', { key: prop.key })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t('pageProperty.emptyOption')}</SelectItem>
              {selectOptions.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            className="h-7 text-xs"
            type={valueType === 'number' ? 'number' : valueType === 'date' ? 'date' : 'text'}
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={handleBlur}
            aria-label={t('pageProperty.valueLabel', { key: prop.key })}
          />
        )}
      </div>
      {valueType === 'select' && (
        <Popover open={editOptionsOpen} onOpenChange={setEditOptionsOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground"
              onClick={handleOpenEditOptions}
              aria-label={t('pageProperty.editOptionsLabel', { key: prop.key })}
            >
              <Pencil className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="w-56 space-y-2 p-3 max-w-[calc(100vw-2rem)]"
            aria-label={t('pageProperty.editOptionsLabel', { key: prop.key })}
          >
            <ScrollArea className="max-h-32">
              <div className="space-y-1">
                {editingOptions.map((opt) => (
                  <div
                    key={opt}
                    className="flex items-center justify-between gap-1 rounded px-1 py-0.5 text-sm hover:bg-accent"
                  >
                    <span className="truncate">{opt}</span>
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemoveOption(opt)}
                      aria-label={t('pageProperty.removeOptionLabel', { option: opt })}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <div className="flex gap-1">
              <Input
                className="h-7 flex-1 text-xs"
                placeholder={t('pageProperty.newOptionPlaceholder')}
                value={newOptionInput}
                onChange={(e) => setNewOptionInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddOption()
                  }
                }}
                aria-label={t('pageProperty.newOptionLabel')}
              />
              <Button
                variant="ghost"
                size="xs"
                onClick={handleAddOption}
                aria-label={t('pageProperty.addOptionLabel')}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
            <Button size="sm" className="w-full" onClick={handleSaveOptions}>
              {t('pageProperty.saveOptionsButton')}
            </Button>
          </PopoverContent>
        </Popover>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onDelete}
        aria-label={t('pageProperty.deletePropertyLabel', { key: prop.key })}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  )
}
