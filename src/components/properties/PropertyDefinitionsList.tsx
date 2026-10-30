/**
 * PropertyDefinitionsList -- CRUD for one space's property definitions.
 *
 * A space selector (definitions are per space, #5841; it starts on the
 * active space), search/filter, create form, list rendering, delete
 * confirmation, editing and renaming a select's options, renaming a key,
 * merging it into another, changing its type, and copying a definition to
 * another space. A
 * built-in definition shows a lock and offers no action.
 */

import { HelpCircle, Lock, Plus, Search, Settings2, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { ListViewState } from '@/components/common/ListViewState'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { ChangePropertyType } from '@/components/properties/ChangePropertyType'
import { CopyDefinitionToSpace } from '@/components/properties/CopyDefinitionToSpace'
import { EditSelectOptions } from '@/components/properties/EditSelectOptions'
import { MergePropertyDefinition } from '@/components/properties/MergePropertyDefinition'
import { notifyDefinitionWrite } from '@/components/properties/notify-definition-write'
import { RenamePropertyDefinition } from '@/components/properties/RenamePropertyDefinition'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { ListItem } from '@/components/ui/list-item'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isValidation, unwrap } from '@/lib/app-error'
import type { PropertyDefinition } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { formatPropertyName, selectOptionsJson, VALUE_TYPES } from '@/lib/property-utils'
import { reportIpcError, reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'

/** The space marker every space block carries is app bookkeeping (#5629). */
const SPACE_MARKER_KEY = 'is_space'

export function PropertyDefinitionsList(): React.ReactElement {
  const { t } = useTranslation()
  const activeSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaces = useSpaceStore((s) => s.availableSpaces)
  // The space whose definitions are shown: the one picked, else the active one.
  const [pickedSpaceId, setPickedSpaceId] = useState<string | null>(null)
  const spaceId = pickedSpaceId ?? activeSpaceId
  // A load answered after the space changed again must not show the old list.
  const loadSeq = useRef(0)
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([])
  const [loading, setLoading] = useState(true)
  // #3306 — settled failure vs genuinely-empty vocabulary.
  const [loadError, setLoadError] = useState(false)
  const [searchFilter, setSearchFilter] = useState('')
  // Live blocks holding a value, per key; null while loading or after a failure, which show no count.
  const [usage, setUsage] = useState<ReadonlyMap<string, number> | null>(null)
  const usageSeq = useRef(0)

  // Create form state
  const [newKey, setNewKey] = useState('')
  const [newType, setNewType] = useState<string>('text')
  const [newOptions, setNewOptions] = useState('')
  const newOptionsJson = newType === 'select' ? selectOptionsJson(newOptions) : null
  const [isCreating, setIsCreating] = useState(false)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const loadDefinitions = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    setLoadError(false)
    try {
      // `listPropertyDefs` is paginated. The settings panel is
      // single-page-by-design — it surfaces the built-ins plus the space's
      // definitions, which fit well under one page; we destructure `.items`
      // and ignore the cursor.
      const defs =
        spaceId === null ? [] : unwrap(await commands.listPropertyDefs(spaceId, null, null)).items
      if (seq !== loadSeq.current) return
      setDefinitions(defs)
    } catch (error) {
      if (seq !== loadSeq.current) return
      // Replace bespoke `String(error)` toast with the unified
      // helper — error detail goes to the structured log; the user sees
      // the localized message.
      setLoadError(true)
      reportIpcError('PropertyDefinitionsList', 'property.errorLoad', error, t, { spaceId })
    }
    setLoading(false)
  }, [spaceId, t])

  const loadUsage = useCallback(async () => {
    const seq = ++usageSeq.current
    setUsage(null)
    if (spaceId === null) return
    try {
      const rows = unwrap(await commands.countPropertyUsage(spaceId))
      if (seq === usageSeq.current) setUsage(new Map(rows.map((row) => [row.key, row.count])))
    } catch (error) {
      logger.warn('PropertyDefinitionsList', 'count_property_usage failed', { spaceId }, error)
    }
  }, [spaceId])

  useEffect(() => {
    // `loadUsage` logs its own failure; never rejects.
    // oxlint-disable-next-line react/set-state-in-effect -- kicks off the `count_property_usage` IPC load; `loadUsage` clears the stale counts before that await, which no render-time derivation can replace
    void loadUsage()
  }, [loadUsage])

  // What an Undo changed, read again: both loads report their own failure.
  const reload = useCallback(() => {
    void loadDefinitions()
    void loadUsage()
  }, [loadDefinitions, loadUsage])

  useEffect(() => {
    // `loadDefinitions` reports its own failure (reportIpcError); never rejects.
    // oxlint-disable-next-line react/set-state-in-effect -- kicks off the `list_property_defs` IPC load; `loadDefinitions` sets loading/error state around that await, which no render-time derivation can replace; see #4407
    void loadDefinitions()
  }, [loadDefinitions])

  const handleCreate = useCallback(async () => {
    const key = newKey.trim()
    if (!key || spaceId === null) return
    setIsCreating(true)
    try {
      const def = unwrap(await commands.createPropertyDef(spaceId, key, newType, newOptionsJson))
      setDefinitions((prev) => [...prev, def])
      setNewKey('')
      setNewType('text')
      setNewOptions('')
      notifyDefinitionWrite(t('propertiesView.created'), def.op_refs, reload)
      void loadUsage()
    } catch (error) {
      // See loadDefinitions above — unified error reporting, but this one
      // keeps the backend's REASON (#4399). `create_property_def` refuses to
      // declare a type over a key whose existing values contradict it, and
      // the refusal names the key, how many values are in the way and what
      // shape they hold. This is the entry point the issue calls "the direct
      // one" — type `year`, pick `number`, done — and the offending values
      // are anywhere in the space, so they are usually nowhere near this
      // screen. A bare
      // "Failed to create property definition" gives the user nothing to act
      // on. Non-validation kinds still fall back to the localized message.
      reportIpcErrorWithReason('PropertyDefinitionsList', 'property.errorCreate', error, t, { key })
    }
    setIsCreating(false)
  }, [spaceId, newKey, newType, newOptionsJson, t, loadUsage, reload])

  const handleDelete = useCallback(
    async (key: string) => {
      if (spaceId === null) return
      try {
        const { op_refs } = unwrap(await commands.deletePropertyDef(spaceId, key))
        setDefinitions((prev) => prev.filter((d) => d.key !== key))
        setDeleteTarget(null)
        notifyDefinitionWrite(t('propertiesView.deleted'), op_refs, reload)
        void loadUsage()
      } catch (error) {
        // The backend refuses a definition a block still uses, with a count that takes in
        // trashed blocks; the badge's does not, so beside a badge the refusal says why they differ.
        if (isValidation(error) && usage?.has(key)) {
          logger.error(
            'PropertyDefinitionsList',
            'property.errorDelete (IPC error)',
            { key },
            error,
          )
          notify.error(t('propertiesView.deleteRefusedInUse', { reason: error.message }))
        } else {
          reportIpcErrorWithReason('PropertyDefinitionsList', 'property.errorDelete', error, t, {
            key,
          })
        }
      }
    },
    [spaceId, t, loadUsage, usage, reload],
  )

  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      // `handleDelete` reports its own failure; never rejects.
      void handleDelete(deleteTarget)
    }
  }, [deleteTarget, handleDelete])

  // Hidden from the list only: the duplicate-key check still sees it.
  const visibleDefs = definitions.filter((d) => d.key !== SPACE_MARKER_KEY)
  // Unicode-aware fold.
  const filteredDefs = visibleDefs.filter((d) => matchesSearchFolded(d.key, searchFilter))

  return (
    <div className="space-y-6">
      {/* The space whose definitions this lists and edits */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <span className="text-sm font-medium" aria-hidden="true">
          {t('propertiesView.definitionsIn')}
        </span>
        <Select
          value={spaceId ?? ''}
          onValueChange={setPickedSpaceId}
          disabled={spaces.length === 0}
        >
          <SelectTrigger
            className="sm:w-56"
            aria-label={t('propertiesView.definitionsIn')}
            data-testid="property-definitions-space"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {spaces.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

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
                      {usage?.has(def.key) && (
                        <Badge tone="outline" data-testid={`property-usage-${def.key}`}>
                          {t('propertiesView.usageCount', { count: usage.get(def.key) })}
                        </Badge>
                      )}
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
                        {!def.builtin && spaceId !== null && (
                          <EditSelectOptions
                            definition={def}
                            spaceId={spaceId}
                            onChanged={reload}
                          />
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
                      <div
                        className={cn(
                          'flex shrink-0 items-center max-sm:col-start-2 max-sm:row-start-1',
                          !hasOptionsCell && 'sm:ml-auto',
                        )}
                      >
                        {spaceId !== null && (
                          <>
                            <RenamePropertyDefinition
                              definition={def}
                              spaceId={spaceId}
                              definitions={definitions}
                              onChanged={reload}
                              className="text-muted-foreground"
                            />
                            <MergePropertyDefinition
                              definition={def}
                              spaceId={spaceId}
                              definitions={definitions}
                              onChanged={reload}
                              className="text-muted-foreground"
                            />
                            <ChangePropertyType
                              definition={def}
                              spaceId={spaceId}
                              onChanged={reload}
                              className="text-muted-foreground"
                            />
                            <CopyDefinitionToSpace
                              definition={def}
                              fromSpaceId={spaceId}
                              className="text-muted-foreground"
                            />
                          </>
                        )}
                        <IconButton
                          variant="ghost"
                          size="icon-xs"
                          tooltip={t('propertiesView.deleteTooltip')}
                          ariaLabel={t('properties.deleteDefinition', { key: def.key })}
                          className="[@media(pointer:coarse)]:-mr-3 text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
                          onClick={() => setDeleteTarget(def.key)}
                        >
                          <Trash2 />
                        </IconButton>
                      </div>
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
