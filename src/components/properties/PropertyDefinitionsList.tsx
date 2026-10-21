/**
 * PropertyDefinitionsList -- CRUD for property definitions.
 *
 * Search/filter, create form, list rendering, delete confirmation,
 * and edit options for select-type properties. A built-in definition
 * (#5841) shows a lock and offers no action.
 */

import { HelpCircle, Lock, Plus, Search, Settings2, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { ListViewState } from '@/components/common/ListViewState'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { unwrap } from '@/lib/app-error'
import type { PropertyDefinition } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { notify } from '@/lib/notify'
import { formatPropertyName, selectOptionsJson } from '@/lib/property-utils'
import { reportIpcError, reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { cn } from '@/lib/utils'

const VALUE_TYPES = ['text', 'number', 'date', 'select', 'ref', 'boolean', 'url'] as const

/** The space marker every space block carries is app bookkeeping (#5629). */
const SPACE_MARKER_KEY = 'is_space'

export function PropertyDefinitionsList(): React.ReactElement {
  const { t } = useTranslation()
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([])
  const [loading, setLoading] = useState(true)
  // #3306 — settled failure vs genuinely-empty vocabulary.
  const [loadError, setLoadError] = useState(false)
  const [searchFilter, setSearchFilter] = useState('')

  // Create form state
  const [newKey, setNewKey] = useState('')
  const [newType, setNewType] = useState<string>('text')
  const [newOptions, setNewOptions] = useState('')
  const newOptionsJson = newType === 'select' ? selectOptionsJson(newOptions) : null
  const [isCreating, setIsCreating] = useState(false)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // Edit options state (for select-type properties)
  const [editingOptionsKey, setEditingOptionsKey] = useState<string | null>(null)
  const [editOptionsValue, setEditOptionsValue] = useState('')

  // Derive inline JSON parse error so the user gets immediate
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
    setLoadError(false)
    try {
      // `listPropertyDefs` is paginated. The settings panel is
      // single-page-by-design — it surfaces the built-ins plus the user's
      // definitions, which fit well under one page; we destructure `.items`
      // and ignore the cursor.
      const { items: defs } = unwrap(await commands.listPropertyDefs(null, null))
      setDefinitions(defs)
    } catch (error) {
      // Replace bespoke `String(error)` toast with the unified
      // helper — error detail goes to the structured log; the user sees
      // the localized message.
      setLoadError(true)
      reportIpcError('PropertyDefinitionsList', 'property.errorLoad', error, t)
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    // `loadDefinitions` reports its own failure (reportIpcError); never rejects.
    // oxlint-disable-next-line react/set-state-in-effect -- kicks off the `list_property_defs` IPC load; `loadDefinitions` sets loading/error state around that await, which no render-time derivation can replace; see #4407
    void loadDefinitions()
  }, [loadDefinitions])

  const handleCreate = useCallback(async () => {
    const key = newKey.trim()
    if (!key) return
    setIsCreating(true)
    try {
      const def = unwrap(await commands.createPropertyDef(key, newType, newOptionsJson))
      setDefinitions((prev) => [...prev, def])
      setNewKey('')
      setNewType('text')
      setNewOptions('')
      notify.success(t('propertiesView.created'))
    } catch (error) {
      // See loadDefinitions above — unified error reporting, but this one
      // keeps the backend's REASON (#4399). `create_property_def` refuses to
      // declare a type over a key whose existing values contradict it, and
      // the refusal names the key, how many values are in the way and what
      // shape they hold. This is the entry point the issue calls "the direct
      // one" — type `year`, pick `number`, done — and the offending values
      // are vault-wide, so they are usually nowhere near this screen. A bare
      // "Failed to create property definition" gives the user nothing to act
      // on. Non-validation kinds still fall back to the localized message.
      reportIpcErrorWithReason('PropertyDefinitionsList', 'property.errorCreate', error, t, { key })
    }
    setIsCreating(false)
  }, [newKey, newType, newOptionsJson, t])

  const handleDelete = useCallback(
    async (key: string) => {
      try {
        unwrap(await commands.deletePropertyDef(key))
        setDefinitions((prev) => prev.filter((d) => d.key !== key))
        setDeleteTarget(null)
        notify.success(t('propertiesView.deleted'))
      } catch (error) {
        // The backend refuses a definition a block still uses, and says so.
        reportIpcErrorWithReason('PropertyDefinitionsList', 'property.errorDelete', error, t, {
          key,
        })
      }
    },
    [t],
  )

  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      // `handleDelete` reports its own failure; never rejects.
      void handleDelete(deleteTarget)
    }
  }, [deleteTarget, handleDelete])

  const handleSaveOptions = useCallback(
    async (key: string) => {
      try {
        const updated = unwrap(await commands.updatePropertyDefOptions(key, editOptionsValue))
        setDefinitions((prev) => prev.map((d) => (d.key === key ? updated : d)))
        setEditingOptionsKey(null)
      } catch (err) {
        // See loadDefinitions above — unified error reporting.
        reportIpcError('PropertyDefinitionsList', 'property.errorUpdate', err, t, { key })
      }
    },
    [editOptionsValue, t],
  )

  // Hidden from the list only: the duplicate-key check still sees it.
  const visibleDefs = definitions.filter((d) => d.key !== SPACE_MARKER_KEY)
  // Unicode-aware fold.
  const filteredDefs = visibleDefs.filter((d) => matchesSearchFolded(d.key, searchFilter))

  return (
    <div className="space-y-6">
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
          // `handleCreate` reports its own failure; never rejects.
          void handleCreate()
        }}
        className="flex flex-col sm:flex-row sm:items-center gap-2"
      >
        <Input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder={t('propertiesView.createKey')}
          className="sm:flex-1"
          aria-label={t('propertiesView.createKey')}
          aria-describedby={
            newKey.trim() && definitions.some((d) => d.key === newKey.trim())
              ? 'duplicate-key-warning'
              : undefined
          }
        />
        <Select value={newType} onValueChange={setNewType}>
          <SelectTrigger className="sm:w-36" aria-label={t('propertiesView.createType')}>
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
        {newType === 'select' && (
          <Input
            value={newOptions}
            onChange={(e) => setNewOptions(e.target.value)}
            placeholder={t('properties.newSelectOptions')}
            className="sm:flex-1"
            aria-label={t('properties.newSelectOptions')}
          />
        )}
        {/* Default size: it shares a row with an h-9 input and select. */}
        <Button
          type="submit"
          variant="outline"
          disabled={
            !newKey.trim() ||
            isCreating ||
            definitions.some((d) => d.key === newKey.trim()) ||
            (newType === 'select' && newOptionsJson === null)
          }
        >
          <Plus /> {t('propertiesView.create')}
        </Button>
      </form>
      {newKey.trim() && definitions.some((d) => d.key === newKey.trim()) && (
        <p id="duplicate-key-warning" className="text-xs text-destructive">
          {t('propertiesView.duplicateKey')}
        </p>
      )}

      <ListViewState
        loading={loading}
        items={visibleDefs}
        skeleton={<LoadingSkeleton count={3} height="h-10" data-testid="properties-loading" />}
        error={loadError && t('property.loadFailed')}
        onRetry={loadDefinitions}
        empty={<EmptyState icon={Settings2} message={t('propertiesView.empty')} />}
      >
        {() =>
          filteredDefs.length > 0 ? (
            <ul className="space-y-1">
              {filteredDefs.map((def) => {
                // A built-in's options are fixed (#5841); `todo_state` keeps the cell for
                // its cycle help.
                const hasOptionsCell =
                  def.value_type === 'select' && (!def.builtin || def.key === 'todo_state')
                return (
                  // On a phone the options take a second line, flush with the name, while
                  // Delete or Built-in stays on the name's line; one row when wider (#5925).
                  // Tab order follows the DOM (name, options, Delete), which is the wide row's
                  // left-to-right order; on a phone Delete is drawn above the options, so the
                  // two swap. Matching them would put Delete before the options on desktop.
                  <ListItem
                    key={def.key}
                    className="max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-y-0"
                  >
                    <div className="flex min-w-0 items-center gap-3 [@media(pointer:coarse)]:min-h-11">
                      <span className="font-medium text-sm">{formatPropertyName(def.key)}</span>
                      <Badge tone="secondary">{def.value_type}</Badge>
                    </div>
                    {hasOptionsCell && (
                      <div className="flex items-center gap-3 max-sm:col-span-2 sm:ml-auto">
                        {def.key === 'todo_state' && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="text-muted-foreground"
                                data-testid="todo-state-cycle-help"
                                aria-label={t('propertiesView.taskCycleHelpLabel')}
                              >
                                <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              {t('propertiesView.taskCycleHelpContent')}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {!def.builtin && (
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
                                size="xs"
                                className="max-sm:px-0!"
                                aria-label={t('propertiesView.editOptionsTooltip')}
                              >
                                <Settings2 />
                                {t('propertiesView.editOptions')}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent
                              aria-label={t('propertiesView.editOptionsPopoverLabel')}
                            >
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
                      </div>
                    )}
                    {def.builtin ? (
                      <Badge
                        tone="outline"
                        data-testid={`builtin-lock-${def.key}`}
                        className={cn(
                          'shrink-0 text-xs text-muted-foreground max-sm:col-start-2 max-sm:row-start-1',
                          !hasOptionsCell && 'sm:ml-auto',
                        )}
                      >
                        <Lock aria-hidden="true" />
                        {t('propertiesView.builtIn')}
                      </Badge>
                    ) : (
                      <IconButton
                        variant="ghost"
                        size="icon-xs"
                        tooltip={t('propertiesView.deleteTooltip')}
                        ariaLabel={t('properties.deleteDefinition', { key: def.key })}
                        className={cn(
                          'max-sm:col-start-2 max-sm:row-start-1 [@media(pointer:coarse)]:-mr-3 text-muted-foreground hover:text-destructive active:text-destructive active:scale-95',
                          !hasOptionsCell && 'sm:ml-auto',
                        )}
                        onClick={() => setDeleteTarget(def.key)}
                      >
                        <Trash2 />
                      </IconButton>
                    )}
                  </ListItem>
                )
              })}
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
        titleKey="propertiesView.deleteConfirm"
        descriptionKey="propertiesView.deleteDesc"
        cancelKey="action.cancel"
        confirmKey="action.delete"
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}
