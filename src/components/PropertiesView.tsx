/**
 * PropertiesView — browse, create, and manage property definitions.
 *
 * Lists all property definitions with search/filter, create form,
 * delete with confirmation, and edit options for select-type properties.
 */

import { Plus, Settings2, Trash2, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ListItem } from '@/components/ui/list-item'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { formatPropertyName } from '@/lib/property-utils'
import type { PropertyDefinition } from '../lib/tauri'
import {
  createPropertyDef,
  deletePropertyDef,
  listPropertyDefs,
  updatePropertyDefOptions,
} from '../lib/tauri'
import { EmptyState } from './EmptyState'

const VALUE_TYPES = ['text', 'number', 'date', 'select'] as const

function TaskStatesSection(): React.ReactElement {
  const { t } = useTranslation()
  const [states, setStates] = useState<(string | null)[]>(() => {
    try {
      const stored = localStorage.getItem('task_cycle')
      if (stored) return JSON.parse(stored)
    } catch {}
    return [null, 'TODO', 'DOING', 'DONE']
  })
  const [newState, setNewState] = useState('')

  const save = useCallback((updated: (string | null)[]) => {
    setStates(updated)
    try {
      localStorage.setItem('task_cycle', JSON.stringify(updated))
    } catch {}
  }, [])

  const handleAdd = useCallback(() => {
    const trimmed = newState.trim().toUpperCase()
    if (!trimmed || states.includes(trimmed)) return
    save([...states, trimmed])
    setNewState('')
  }, [newState, states, save])

  const handleRemove = useCallback(
    (state: string) => {
      save(states.filter((s) => s !== state))
    },
    [states, save],
  )

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t('propertiesView.taskStates')}</h3>
      <p className="text-xs text-muted-foreground">{t('propertiesView.taskStatesDesc')}</p>
      <div className="flex flex-wrap gap-1">
        <Badge variant="outline" className="text-xs">
          none
        </Badge>
        {states.filter(Boolean).map((s) => (
          <Badge key={s} variant="secondary" className="text-xs flex items-center gap-1">
            {s}
            <button
              type="button"
              className="ml-0.5 hover:text-destructive"
              aria-label={`Remove state ${s}`}
              onClick={() => {
                if (s) handleRemove(s)
              }}
            >
              <X size={10} />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-1">
        <Input
          className="h-7 text-sm flex-1"
          placeholder={t('propertiesView.addTaskState')}
          value={newState}
          onChange={(e) => setNewState(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
        />
        <Button size="sm" variant="outline" onClick={handleAdd} disabled={!newState.trim()}>
          {t('propertiesView.add')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('propertiesView.taskStatesReload')}</p>
    </div>
  )
}

function DeadlineWarningSection(): React.ReactElement {
  const { t } = useTranslation()
  const [days, setDays] = useState(() => {
    try {
      const stored = localStorage.getItem('agaric:deadlineWarningDays')
      return stored ? Number.parseInt(stored, 10) : 0
    } catch {
      return 0
    }
  })

  const handleChange = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(90, value))
    setDays(clamped)
    try {
      localStorage.setItem('agaric:deadlineWarningDays', String(clamped))
    } catch {}
  }, [])

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t('propertiesView.deadlineWarning')}</h3>
      <p className="text-xs text-muted-foreground">{t('propertiesView.deadlineWarningDesc')}</p>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          className="h-7 w-20 text-sm"
          min={0}
          max={90}
          value={days}
          aria-label={t('propertiesView.deadlineWarning')}
          onChange={(e) => handleChange(Number.parseInt(e.target.value, 10) || 0)}
        />
        <span className="text-xs text-muted-foreground">days (0 = disabled)</span>
      </div>
    </div>
  )
}

export function PropertiesView(): React.ReactElement {
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

  const loadDefinitions = useCallback(async () => {
    setLoading(true)
    try {
      const defs = await listPropertyDefs()
      setDefinitions(defs)
    } catch (error) {
      toast.error(`Failed to load property definitions: ${String(error)}`)
    }
    setLoading(false)
  }, [])

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
      toast.error(`Failed to create property definition: ${String(error)}`)
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
        toast.error(`Failed to delete property definition: ${String(error)}`)
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
      } catch (error) {
        toast.error(`Failed to update options: ${String(error)}`)
      }
    },
    [editOptionsValue],
  )

  const filteredDefs = definitions.filter((d) =>
    d.key.toLowerCase().includes(searchFilter.toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <TaskStatesSection />
      <Separator />
      <DeadlineWarningSection />
      <Separator />
      <h2 className="text-lg font-semibold">{t('propertiesView.title')}</h2>

      {/* Search input */}
      <Input
        value={searchFilter}
        onChange={(e) => setSearchFilter(e.target.value)}
        placeholder={t('propertiesView.search')}
        aria-label={t('propertiesView.search')}
      />

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

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2" data-testid="properties-loading">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      )}

      {/* Empty state */}
      {!loading && definitions.length === 0 && (
        <EmptyState icon={Settings2} message={t('propertiesView.empty')} />
      )}

      {/* Definitions list */}
      {!loading && filteredDefs.length > 0 && (
        <ul className="space-y-2">
          {filteredDefs.map((def) => (
            <ListItem key={def.key}>
              <span className="font-medium text-sm">{formatPropertyName(def.key)}</span>
              <Badge variant="secondary">{def.value_type}</Badge>
              {def.value_type === 'select' && (
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
                    <Button variant="ghost" size="sm">
                      {t('propertiesView.editOptions')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent>
                    <div className="space-y-2">
                      <Input
                        value={editOptionsValue}
                        onChange={(e) => setEditOptionsValue(e.target.value)}
                        placeholder="Options JSON"
                        aria-label={t('propertiesView.optionsJsonLabel')}
                      />
                      <Button size="sm" onClick={() => handleSaveOptions(def.key)}>
                        {t('action.save')}
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete property ${def.key}`}
                className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target [@media(pointer:coarse)]:min-w-[44px] focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteTarget(def.key)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </ListItem>
          ))}
        </ul>
      )}

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
