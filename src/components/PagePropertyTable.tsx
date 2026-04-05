/**
 * PagePropertyTable — collapsible property table for a page.
 *
 * Rendered below tags in PageHeader. Shows page properties with
 * typed inputs based on property definitions, and an "Add property"
 * popover for adding new properties from existing definitions or
 * creating new definitions.
 */

import { Pencil, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import { handleDeleteProperty, handleSaveProperty } from '@/lib/property-save-utils'
import { formatPropertyName } from '@/lib/property-utils'
import type { PropertyDefinition, PropertyRow } from '../lib/tauri'
import {
  createPropertyDef,
  getProperties,
  listPropertyDefs,
  setProperty,
  updatePropertyDefOptions,
} from '../lib/tauri'
import { AddPropertyPopover } from './AddPropertyPopover'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { LoadingSkeleton } from './LoadingSkeleton'

// Properties designed for task blocks (content blocks with todo_state).
// Filtered out of the "add property" popover for pages.
const TASK_ONLY_PROPERTIES = new Set(['effort', 'assignee', 'location'])

interface PagePropertyTableProps {
  pageId: string
  forceExpanded?: boolean
}

export function PagePropertyTable({ pageId, forceExpanded }: PagePropertyTableProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([])
  const [showAddPopover, setShowAddPopover] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // Load properties and definitions in parallel
  useEffect(() => {
    setLoading(true)
    Promise.all([getProperties(pageId), listPropertyDefs()])
      .then(([props, defs]) => {
        setProperties(Array.isArray(props) ? props : [])
        setDefinitions(Array.isArray(defs) ? defs : [])
      })
      .catch(() => {
        toast.error(t('pageProperty.loadFailed'))
      })
      .finally(() => setLoading(false))
  }, [pageId, t])

  // Auto-expand and open add-popover when forceExpanded transitions to true
  const prevForceRef = useRef(false)
  useEffect(() => {
    if (forceExpanded && !prevForceRef.current) {
      setExpanded(true)
      setShowAddPopover(true)
    }
    prevForceRef.current = !!forceExpanded
  }, [forceExpanded])

  const findDef = useCallback(
    (key: string): PropertyDefinition | undefined => {
      return definitions.find((d) => d.key === key)
    },
    [definitions],
  )

  const doSaveProperty = useCallback(
    async (key: string, def: PropertyDefinition | undefined, rawValue: string) => {
      try {
        const valueType = def?.value_type ?? 'text'
        const ok = await handleSaveProperty(pageId, key, rawValue, valueType, (props) =>
          setProperties(props),
        )
        if (!ok) {
          toast.error(t('property.invalidNumber'))
        }
      } catch {
        toast.error(t('pageProperty.saveFailed'))
      }
    },
    [pageId, t],
  )

  const doDeleteProperty = useCallback(
    async (key: string) => {
      try {
        await handleDeleteProperty(pageId, key, () => {
          setProperties((prev) => prev.filter((p) => p.key !== key))
        })
      } catch {
        toast.error(t('pageProperty.deleteFailed'))
      }
    },
    [pageId, t],
  )

  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      doDeleteProperty(deleteTarget)
      setDeleteTarget(null)
    }
  }, [deleteTarget, doDeleteProperty])

  const handleAddFromDef = useCallback(
    async (def: PropertyDefinition) => {
      try {
        await setProperty({ blockId: pageId, key: def.key, valueText: '' })
        const updated = await getProperties(pageId)
        setProperties(updated)
      } catch {
        toast.error(t('pageProperty.addFailed'))
      }
    },
    [pageId, t],
  )

  const handleCreateDef = useCallback(
    async (key: string, valueType: string) => {
      try {
        const newDef = await createPropertyDef({ key, valueType })
        setDefinitions((prev) => [...prev, newDef])
        await setProperty({ blockId: pageId, key: newDef.key, valueText: '' })
        const updated = await getProperties(pageId)
        setProperties(updated)
      } catch (err: any) {
        toast.error(err.message ?? t('property.createDefFailed'))
      }
    },
    [pageId, t],
  )

  // Definitions available for the add-property popover:
  // exclude already-set keys and task-only properties.
  const availableDefs = definitions.filter(
    (d) => !properties.some((p) => p.key === d.key) && !TASK_ONLY_PROPERTIES.has(d.key),
  )

  const propertyCount = properties.length

  if (!loading && properties.length === 0 && !forceExpanded) {
    return null
  }

  return (
    <div className="page-property-table">
      <CollapsiblePanelHeader
        collapsed={!expanded}
        onToggle={() => setExpanded((prev) => !prev)}
        className="page-property-table-header"
      >
        {t('pageProperty.propertiesButton')}
        {propertyCount > 0 ? ` (${propertyCount})` : ''}
      </CollapsiblePanelHeader>

      {expanded && (
        <div className="mt-1 space-y-1.5 pl-2">
          {loading && (
            <div aria-busy="true">
              <LoadingSkeleton count={2} height="h-6" data-testid="property-loading" />
            </div>
          )}

          {!loading &&
            properties.map((prop) => {
              const def = findDef(prop.key)
              return (
                <PropertyRowEditor
                  key={prop.key}
                  prop={prop}
                  def={def}
                  onSave={(rawValue) => doSaveProperty(prop.key, def, rawValue)}
                  onDelete={() => setDeleteTarget(prop.key)}
                  onDefUpdated={(updatedDef) => {
                    setDefinitions((prev) =>
                      prev.map((d) => (d.key === updatedDef.key ? updatedDef : d)),
                    )
                  }}
                />
              )
            })}

          {!loading && (
            <AddPropertyPopover
              definitions={availableDefs}
              onAdd={handleAddFromDef}
              supportCreateDef
              onCreateDef={handleCreateDef}
              open={showAddPopover}
              onOpenChange={setShowAddPopover}
            />
          )}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('property.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>{t('property.deleteConfirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('action.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>
              {t('action.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PropertyRowEditor — renders a single property row with typed input
// ---------------------------------------------------------------------------

interface PropertyRowEditorProps {
  prop: PropertyRow
  def: PropertyDefinition | undefined
  onSave: (rawValue: string) => void
  onDelete: () => void
  onDefUpdated?: (updatedDef: PropertyDefinition) => void
}

function PropertyRowEditor({ prop, def, onSave, onDelete, onDefUpdated }: PropertyRowEditorProps) {
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
