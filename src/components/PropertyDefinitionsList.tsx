/**
 * PropertyDefinitionsList -- CRUD for property definitions.
 *
 * Search/filter, create form, list rendering, delete confirmation,
 * and edit options for select-type properties.
 */

import { HelpCircle, Lock, Plus, Search, Settings2, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ListItem } from '@/components/ui/list-item'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '@/lib/logger'
import { LOCKED_PROPERTY_OPTIONS, NON_DELETABLE_PROPERTIES } from '@/lib/property-save-utils'
import { formatPropertyName } from '@/lib/property-utils'
import { reportIpcError } from '@/lib/report-ipc-error'
import { setPriorityLevels } from '../lib/priority-levels'
import type { PropertyDefinition } from '../lib/tauri'
import {
  createPropertyDef,
  deletePropertyDef,
  listPropertyDefs,
  updatePropertyDefOptions,
} from '../lib/tauri'
import { EmptyState } from './EmptyState'
import { ListViewState } from './ListViewState'

const VALUE_TYPES = ['text', 'number', 'date', 'select', 'ref'] as const

export function PropertyDefinitionsList(): React.ReactElement {
  const { t } = useTranslation()
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [searchFilter, setSearchFilter] = useState('')

  // Create form state
  const [newKey, setNewKey] = useState('')
  const [newType, setNewType] = useState<string>('text')
  const [isCreating, setIsCreating] = useState(false)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // Edit options state (for select-type properties)
  const [editingOptionsKey, setEditingOptionsKey] = useState<string | null>(null)
  const [editOptionsValue, setEditOptionsValue] = useState('')

  // UX-339: derive inline JSON parse error so the user gets immediate
  // feedback (and Save is disabled) instead of only seeing a toast on
  // failed save. Empty input is treated as valid (clears options).
  const jsonError = useMemo<string | null>(() => {
    if (editOptionsValue.trim() === '') return null
    try {
      JSON.parse(editOptionsValue)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }, [editOptionsValue])

  const loadDefinitions = useCallback(async () => {
    setLoading(true)
    try {
      // M-85: `listPropertyDefs` is paginated. The settings panel is
      // single-page-by-design — it surfaces the seeded vocabulary
      // (~19 built-ins plus user-authored entries), which fits well
      // under one page; we destructure `.items` and ignore the cursor.
      const { items: defs } = await listPropertyDefs()
      setDefinitions(defs)
    } catch (error) {
      // FE-M-8: replace bespoke `String(error)` toast with the unified
      // helper — error detail goes to the structured log; the user sees
      // the localized message.
      reportIpcError('PropertyDefinitionsList', 'property.errorLoad', error, t)
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    loadDefinitions()
  }, [loadDefinitions])

  const handleCreate = useCallback(async () => {
    const key = newKey.trim()
    if (!key) return
    setIsCreating(true)
    try {
      const def = await createPropertyDef({ key, valueType: newType })
      setDefinitions((prev) => [...prev, def])
      setNewKey('')
      setNewType('text')
      toast.success(t('propertiesView.created'))
    } catch (error) {
      // FE-M-8: see loadDefinitions above — unified error reporting.
      reportIpcError('PropertyDefinitionsList', 'property.errorCreate', error, t)
    }
    setIsCreating(false)
  }, [newKey, newType, t])

  const handleDelete = useCallback(
    async (key: string) => {
      try {
        await deletePropertyDef(key)
        setDefinitions((prev) => prev.filter((d) => d.key !== key))
        setDeleteTarget(null)
        toast.success(t('propertiesView.deleted'))
      } catch (error) {
        // FE-M-8: see loadDefinitions above — unified error reporting.
        reportIpcError('PropertyDefinitionsList', 'property.errorDelete', error, t, { key })
      }
    },
    [t],
  )

  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      handleDelete(deleteTarget)
    }
  }, [deleteTarget, handleDelete])

  const handleSaveOptions = useCallback(
    async (key: string) => {
      try {
        const updated = await updatePropertyDefOptions(key, editOptionsValue)
        setDefinitions((prev) => prev.map((d) => (d.key === key ? updated : d)))
        setEditingOptionsKey(null)
        // UX-201b: sync the active priority level cache when the user
        // edits `priority.options`. Other property keys are untouched.
        if (key === 'priority' && updated.options != null) {
          try {
            const parsed: unknown = JSON.parse(updated.options)
            if (Array.isArray(parsed)) {
              const levels = parsed.filter((v): v is string => typeof v === 'string')
              if (levels.length > 0) setPriorityLevels(levels)
            }
          } catch (parseErr) {
            // Server already accepted the payload; the cache just won't
            // update. Log so silent drift doesn't mask real bugs.
            logger.warn(
              'PropertyDefinitionsList',
              'Could not parse saved priority options after successful update',
              { options: updated.options },
              parseErr,
            )
          }
        }
      } catch (err) {
        // FE-M-8: see loadDefinitions above — unified error reporting.
        reportIpcError('PropertyDefinitionsList', 'property.errorUpdate', err, t, { key })
      }
    },
    [editOptionsValue, t],
  )

  // UX-248 — Unicode-aware fold.
  const filteredDefs = definitions.filter((d) => matchesSearchFolded(d.key, searchFilter))

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t('propertiesView.title')}</h2>

      {/* Search input */}
      <div className="relative">
        <Search
          className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
        <SearchInput
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          placeholder={t('propertiesView.search')}
          aria-label={t('propertiesView.search')}
          className="pl-8"
          clearAriaLabelKey="propertiesView.clearSearch"
        />
      </div>

      {/* Create form */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleCreate()
        }}
        className="flex flex-col sm:flex-row sm:items-center gap-2"
      >
        <Input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder={t('propertiesView.createKey')}
          className="flex-1"
          aria-label={t('propertiesView.createKey')}
          aria-describedby={
            newKey.trim() && definitions.some((d) => d.key === newKey.trim())
              ? 'duplicate-key-warning'
              : undefined
          }
        />
        <Select value={newType} onValueChange={setNewType}>
          <SelectTrigger
            className="rounded-md border bg-background px-3 py-2 text-sm"
            aria-label={t('propertiesView.createType')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VALUE_TYPES.map((vt) => (
              <SelectItem key={vt} value={vt}>
                {vt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="submit"
          variant="outline"
          disabled={
            !newKey.trim() || isCreating || definitions.some((d) => d.key === newKey.trim())
          }
        >
          <Plus className="h-4 w-4" /> {t('propertiesView.create')}
        </Button>
      </form>
      {newKey.trim() && definitions.some((d) => d.key === newKey.trim()) && (
        <p id="duplicate-key-warning" className="text-xs text-destructive">
          {t('propertiesView.duplicateKey')}
        </p>
      )}

      <ListViewState
        loading={loading}
        items={definitions}
        skeleton={<LoadingSkeleton count={3} height="h-10" data-testid="properties-loading" />}
        empty={<EmptyState icon={Settings2} message={t('propertiesView.empty')} />}
      >
        {() =>
          filteredDefs.length > 0 ? (
            <ul className="space-y-1">
              {filteredDefs.map((def) => (
                <ListItem key={def.key}>
                  <span className="font-medium text-sm">{formatPropertyName(def.key)}</span>
                  <Badge variant="secondary">{def.value_type}</Badge>
                  {def.value_type === 'select' && LOCKED_PROPERTY_OPTIONS.has(def.key) && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground"
                            data-testid={`locked-options-${def.key}`}
                          >
                            <Lock className="h-3 w-3" aria-hidden="true" />
                            {t('propertiesView.optionsLocked')}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{t('propertiesView.optionsLockedTooltip')}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {def.key === 'todo_state' && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex items-center justify-center text-muted-foreground"
                            data-testid="todo-state-cycle-help"
                            aria-label={t('propertiesView.taskCycleHelpLabel')}
                          >
                            <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          {t('propertiesView.taskCycleHelpContent')}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {def.value_type === 'select' && !LOCKED_PROPERTY_OPTIONS.has(def.key) && (
                    <Popover
                      open={editingOptionsKey === def.key}
                      onOpenChange={(open) => {
                        if (open) {
                          setEditingOptionsKey(def.key)
                          setEditOptionsValue(def.options ?? '')
                        } else {
                          setEditingOptionsKey(null)
                        }
                      }}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('propertiesView.editOptionsTooltip')}
                        >
                          <Settings2 className="h-3.5 w-3.5 mr-1" />
                          {t('propertiesView.editOptions')}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent aria-label={t('propertiesView.editOptionsPopoverLabel')}>
                        <div className="space-y-2">
                          <Input
                            value={editOptionsValue}
                            onChange={(e) => setEditOptionsValue(e.target.value)}
                            placeholder={t('propertiesView.optionsJsonPlaceholder')}
                            aria-label={t('propertiesView.optionsJsonLabel')}
                            aria-invalid={jsonError != null}
                            aria-describedby={
                              jsonError != null ? 'property-options-json-error' : undefined
                            }
                          />
                          {jsonError && (
                            <p
                              id="property-options-json-error"
                              className="text-xs text-destructive"
                              role="alert"
                            >
                              {t('propertiesView.invalidJsonHint', { error: jsonError })}
                            </p>
                          )}
                          <Button
                            size="sm"
                            disabled={jsonError != null}
                            onClick={() => handleSaveOptions(def.key)}
                          >
                            {t('action.save')}
                          </Button>
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                  <div className="flex-1" />
                  {NON_DELETABLE_PROPERTIES.has(def.key) ? (
                    <Badge variant="outline" className="shrink-0 text-xs text-muted-foreground">
                      {t('propertiesView.builtIn')}
                    </Badge>
                  ) : (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={t('properties.deleteDefinition', { key: def.key })}
                            className="shrink-0 [@media(pointer:coarse)]:opacity-100 touch-target [@media(pointer:coarse)]:min-w-[44px] focus-visible:opacity-100 text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
                            onClick={() => setDeleteTarget(def.key)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('propertiesView.deleteTooltip')}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </ListItem>
              ))}
            </ul>
          ) : searchFilter ? (
            <EmptyState icon={Search} message={t('propertiesView.noFilterResults')} compact />
          ) : null
        }
      </ListViewState>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={t('propertiesView.deleteConfirm')}
        description={t('propertiesView.deleteDesc')}
        cancelLabel={t('action.cancel')}
        actionLabel={t('action.delete')}
        onAction={handleConfirmDelete}
      />
    </div>
  )
}
