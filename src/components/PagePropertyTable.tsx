/**
 * PagePropertyTable — collapsible property table for a page.
 *
 * Rendered below tags in PageHeader. Shows page properties with
 * typed inputs based on property definitions, and an "Add property"
 * popover for adding new properties from existing definitions or
 * creating new definitions.
 */

import { ChevronDown, ChevronRight, Pencil, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
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
import { Skeleton } from '@/components/ui/skeleton'
import type { PropertyDefinition, PropertyRow } from '../lib/tauri'
import {
  createPropertyDef,
  deleteProperty,
  getProperties,
  listPropertyDefs,
  setProperty,
  updatePropertyDefOptions,
} from '../lib/tauri'

interface PagePropertyTableProps {
  pageId: string
}

export function PagePropertyTable({ pageId }: PagePropertyTableProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([])
  const [showAddPopover, setShowAddPopover] = useState(false)
  const [defSearch, setDefSearch] = useState('')
  const [creatingDef, setCreatingDef] = useState(false)
  const [newDefType, setNewDefType] = useState('text')
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
        toast.error('Failed to load properties')
      })
      .finally(() => setLoading(false))
  }, [pageId])

  const findDef = useCallback(
    (key: string): PropertyDefinition | undefined => {
      return definitions.find((d) => d.key === key)
    },
    [definitions],
  )

  const handleSaveProperty = useCallback(
    async (key: string, def: PropertyDefinition | undefined, rawValue: string) => {
      try {
        const valueType = def?.value_type ?? 'text'
        if (valueType === 'number') {
          const num = Number(rawValue)
          if (rawValue.trim() && !Number.isNaN(num)) {
            await setProperty({ blockId: pageId, key, valueNum: num })
          } else if (rawValue.trim()) {
            toast.error(t('property.invalidNumber'))
            return
          } else {
            await setProperty({ blockId: pageId, key, valueText: '' })
          }
        } else if (valueType === 'date') {
          await setProperty({ blockId: pageId, key, valueDate: rawValue || null })
        } else {
          await setProperty({ blockId: pageId, key, valueText: rawValue })
        }
        const updated = await getProperties(pageId)
        setProperties(updated)
      } catch {
        toast.error('Failed to save property')
      }
    },
    [pageId, t],
  )

  const handleDeleteProperty = useCallback(
    async (key: string) => {
      try {
        await deleteProperty(pageId, key)
        setProperties((prev) => prev.filter((p) => p.key !== key))
      } catch {
        toast.error('Failed to delete property')
      }
    },
    [pageId],
  )

  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      handleDeleteProperty(deleteTarget)
      setDeleteTarget(null)
    }
  }, [deleteTarget, handleDeleteProperty])

  const handleAddFromDef = useCallback(
    async (def: PropertyDefinition) => {
      try {
        await setProperty({ blockId: pageId, key: def.key, valueText: '' })
        const updated = await getProperties(pageId)
        setProperties(updated)
        setShowAddPopover(false)
        setDefSearch('')
      } catch {
        toast.error('Failed to add property')
      }
    },
    [pageId],
  )

  const handleCreateDef = useCallback(async () => {
    const key = defSearch.trim()
    if (!key) return
    try {
      const newDef = await createPropertyDef({ key, valueType: newDefType })
      setDefinitions((prev) => [...prev, newDef])
      await setProperty({ blockId: pageId, key: newDef.key, valueText: '' })
      const updated = await getProperties(pageId)
      setProperties(updated)
      setShowAddPopover(false)
      setDefSearch('')
      setCreatingDef(false)
      setNewDefType('text')
    } catch (err: any) {
      toast.error(err.message ?? t('property.createDefFailed'))
    }
  }, [defSearch, newDefType, pageId, t])

  const filteredDefs = definitions.filter(
    (d) =>
      !properties.some((p) => p.key === d.key) &&
      (!defSearch || d.key.toLowerCase().includes(defSearch.toLowerCase())),
  )

  const searchMatchesExistingDef = definitions.some(
    (d) => d.key.toLowerCase() === defSearch.trim().toLowerCase(),
  )

  const propertyCount = properties.length

  return (
    <div className="page-property-table">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1 text-muted-foreground"
        onClick={() => setExpanded((prev) => !prev)}
        aria-label="Toggle properties"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        Properties{propertyCount > 0 ? ` (${propertyCount})` : ''}
      </Button>

      {expanded && (
        <div className="mt-1 space-y-1.5 pl-2">
          {loading && (
            <div className="space-y-2" data-testid="property-loading">
              <Skeleton className="h-6 w-full rounded" />
              <Skeleton className="h-6 w-full rounded" />
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
                  onSave={(rawValue) => handleSaveProperty(prop.key, def, rawValue)}
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
            <Popover open={showAddPopover} onOpenChange={setShowAddPopover}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  className="gap-1 text-muted-foreground"
                  aria-label="Add property"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add property
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 space-y-2 p-3" aria-label="Property picker">
                <Input
                  placeholder="Search definitions..."
                  value={defSearch}
                  onChange={(e) => {
                    setDefSearch(e.target.value)
                    setCreatingDef(false)
                  }}
                  aria-label="Search definitions"
                />
                <div className="max-h-40 overflow-y-auto">
                  {filteredDefs.map((def) => (
                    <button
                      key={def.key}
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
                      onClick={() => handleAddFromDef(def)}
                    >
                      <span className="flex-1">{def.key}</span>
                      <Badge variant="outline" className="font-mono text-xs">
                        {def.value_type}
                      </Badge>
                    </button>
                  ))}
                </div>
                {defSearch.trim() && !searchMatchesExistingDef && !creatingDef && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-muted-foreground"
                    onClick={() => setCreatingDef(true)}
                  >
                    Create &quot;{defSearch.trim()}&quot;
                  </Button>
                )}
                {creatingDef && (
                  <div className="space-y-2">
                    <label htmlFor="new-def-type" className="text-xs text-muted-foreground">
                      Value type
                    </label>
                    <select
                      id="new-def-type"
                      className="w-full rounded border px-2 py-1 text-sm"
                      value={newDefType}
                      onChange={(e) => setNewDefType(e.target.value)}
                      aria-label="Value type"
                    >
                      <option value="text">text</option>
                      <option value="number">number</option>
                      <option value="date">date</option>
                      <option value="select">select</option>
                    </select>
                    <Button size="sm" className="w-full" onClick={handleCreateDef}>
                      Create definition
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
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
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value
      setLocalValue(val)
      onSave(val)
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
      toast.error('Failed to update options')
    }
  }, [def, editingOptions, onDefUpdated])

  return (
    <div className="property-row flex items-center gap-2 text-sm">
      <Badge variant="outline" className="shrink-0 font-mono text-xs">
        {prop.key}
      </Badge>
      <div className="flex-1">
        {valueType === 'select' ? (
          <select
            className="w-full rounded border px-2 py-1 text-sm"
            value={localValue}
            onChange={handleSelectChange}
            aria-label={`${prop.key} value`}
          >
            <option value="">—</option>
            {selectOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : (
          <Input
            className="h-7 text-xs"
            type={valueType === 'number' ? 'number' : valueType === 'date' ? 'date' : 'text'}
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={handleBlur}
            aria-label={`${prop.key} value`}
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
              aria-label={`Edit options for ${prop.key}`}
            >
              <Pencil className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 space-y-2 p-3" aria-label={`Edit options for ${prop.key}`}>
            <div className="max-h-32 space-y-1 overflow-y-auto">
              {editingOptions.map((opt) => (
                <div key={opt} className="flex items-center justify-between gap-1 rounded px-1 py-0.5 text-sm hover:bg-accent">
                  <span className="truncate">{opt}</span>
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleRemoveOption(opt)}
                    aria-label={`Remove option ${opt}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-1">
              <Input
                className="h-7 flex-1 text-xs"
                placeholder="New option..."
                value={newOptionInput}
                onChange={(e) => setNewOptionInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddOption()
                  }
                }}
                aria-label="New option value"
              />
              <Button variant="ghost" size="xs" onClick={handleAddOption} aria-label="Add option">
                <Plus className="h-3 w-3" />
              </Button>
            </div>
            <Button size="sm" className="w-full" onClick={handleSaveOptions}>
              Save options
            </Button>
          </PopoverContent>
        </Popover>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onDelete}
        aria-label={`Delete property ${prop.key}`}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  )
}
