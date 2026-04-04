/**
 * BlockPropertyDrawer — slide-out drawer showing all properties for a given block.
 *
 * Follows the HistorySheet pattern: a Sheet component controlled from BlockTree
 * state. Displays property rows with inline editing, deletion, and an
 * AddPropertySection for adding new properties from existing definitions.
 *
 * Built-in block fields (due_date, scheduled_date) are shown as read-only
 * summary rows at the top, sourced from the block store for reactivity.
 */

import { CalendarCheck2, CalendarClock, Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { announce } from '../lib/announcer'
import type { PropertyDefinition, PropertyRow } from '../lib/tauri'
import {
  deleteProperty,
  getProperties,
  listPropertyDefs,
  setDueDate as setDueDateCmd,
  setProperty,
  setScheduledDate as setScheduledDateCmd,
} from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'

const BUILTIN_PROPERTY_KEYS = new Set([
  'todo_state',
  'priority',
  'due_date',
  'scheduled_date',
  'created_at',
  'completed_at',
  'effort',
  'assignee',
  'location',
  'repeat',
  'repeat-until',
  'repeat-count',
  'repeat-seq',
  'repeat-origin',
])

export interface BlockPropertyDrawerProps {
  blockId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function BlockPropertyDrawer({
  blockId,
  open,
  onOpenChange,
}: BlockPropertyDrawerProps): React.ReactElement {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([])

  // Subscribe to built-in date fields from the block store so the drawer
  // updates reactively when dates are set via toolbar (H-12).
  const block = useBlockStore((s) => (blockId ? s.blocks.find((b) => b.id === blockId) : undefined))
  const dueDate = block?.due_date ?? null
  const scheduledDate = block?.scheduled_date ?? null

  // Load properties + definitions when blockId changes or drawer opens
  useEffect(() => {
    if (!blockId || !open) return
    setLoading(true)
    Promise.all([getProperties(blockId), listPropertyDefs()])
      .then(([props, defs]) => {
        setProperties(Array.isArray(props) ? props : [])
        setDefinitions(Array.isArray(defs) ? defs : [])
      })
      .catch(() => toast.error(t('property.loadFailed')))
      .finally(() => setLoading(false))
  }, [blockId, open, t])

  // Save handler
  const handleSave = useCallback(
    async (key: string, value: string, type: string) => {
      if (!blockId) return
      try {
        const params: Parameters<typeof setProperty>[0] = { blockId, key }
        if (type === 'number') {
          const num = Number(value)
          if (Number.isNaN(num)) {
            toast.error(t('property.invalidNumber'))
            return
          }
          params.valueNum = num
        } else if (type === 'date') {
          params.valueDate = value || null
        } else {
          params.valueText = value || null
        }
        await setProperty(params)
        // Refresh
        const props = await getProperties(blockId)
        setProperties(Array.isArray(props) ? props : [])
        announce('Property saved')
      } catch {
        toast.error(t('property.saveFailed'))
      }
    },
    [blockId, t],
  )

  // Delete handler
  const handleDelete = useCallback(
    async (key: string) => {
      if (!blockId) return
      try {
        await deleteProperty(blockId, key)
        setProperties((prev) => prev.filter((p) => p.key !== key))
        announce('Property deleted')
      } catch {
        toast.error(t('property.deleteFailed'))
      }
    },
    [blockId, t],
  )

  // Determine property type from definitions
  const getType = useCallback(
    (key: string) => {
      return definitions.find((d) => d.key === key)?.value_type ?? 'text'
    },
    [definitions],
  )

  // Clear a built-in date field (due_date or scheduled_date)
  const handleClearBuiltinDate = useCallback(
    async (field: 'due_date' | 'scheduled_date') => {
      if (!blockId) return
      try {
        if (field === 'due_date') {
          await setDueDateCmd(blockId, null)
        } else {
          await setScheduledDateCmd(blockId, null)
        }
        useBlockStore.setState((s) => ({
          blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, [field]: null } : b)),
        }))
        announce('Date cleared')
      } catch {
        toast.error(t('property.saveFailed'))
      }
    },
    [blockId, t],
  )

  // Update a built-in date field
  const handleSaveBuiltinDate = useCallback(
    async (field: 'due_date' | 'scheduled_date', value: string) => {
      if (!blockId || !value) return
      try {
        if (field === 'due_date') {
          await setDueDateCmd(blockId, value)
        } else {
          await setScheduledDateCmd(blockId, value)
        }
        useBlockStore.setState((s) => ({
          blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, [field]: value } : b)),
        }))
        announce('Date updated')
      } catch {
        toast.error(t('property.saveFailed'))
      }
    },
    [blockId, t],
  )

  const hasBuiltinDates = dueDate !== null || scheduledDate !== null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80">
        <SheetHeader>
          <SheetTitle>{t('property.drawerTitle')}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-3 px-4">
          {/* Built-in date fields from the blocks table (H-12) */}
          {!loading && hasBuiltinDates && (
            <>
              {dueDate !== null && (
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
                  <Badge
                    variant="outline"
                    className="shrink-0 text-xs max-w-[120px] truncate flex items-center gap-1"
                    title={t('property.dueDate')}
                  >
                    <CalendarCheck2 size={12} />
                    {t('property.dueDate')}
                  </Badge>
                  <Input
                    className="flex-1 h-7 text-xs"
                    type="date"
                    aria-label={t('property.valueLabel', { key: t('property.dueDate') })}
                    defaultValue={dueDate}
                    key={`due-${dueDate}`}
                    onBlur={(e) => handleSaveBuiltinDate('due_date', e.target.value)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('property.clearDueDate')}
                    onClick={() => handleClearBuiltinDate('due_date')}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
              {scheduledDate !== null && (
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
                  <Badge
                    variant="outline"
                    className="shrink-0 text-xs max-w-[120px] truncate flex items-center gap-1"
                    title={t('property.scheduledDate')}
                  >
                    <CalendarClock size={12} />
                    {t('property.scheduledDate')}
                  </Badge>
                  <Input
                    className="flex-1 h-7 text-xs"
                    type="date"
                    aria-label={t('property.valueLabel', { key: t('property.scheduledDate') })}
                    defaultValue={scheduledDate}
                    key={`sched-${scheduledDate}`}
                    onBlur={(e) => handleSaveBuiltinDate('scheduled_date', e.target.value)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('property.clearScheduledDate')}
                    onClick={() => handleClearBuiltinDate('scheduled_date')}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
              {properties.length > 0 && <div className="border-t border-border/40" />}
            </>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">{t('property.loading')}</p>
          ) : properties.length === 0 && !hasBuiltinDates ? (
            <p className="text-sm text-muted-foreground">{t('property.noProperties')}</p>
          ) : (
            properties.map((prop) => (
              <div key={prop.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
                <Badge
                  variant="outline"
                  className="shrink-0 font-mono text-xs max-w-[120px] truncate"
                  title={prop.key}
                >
                  {prop.key}
                </Badge>
                <Input
                  className="flex-1 h-7 text-xs"
                  aria-label={t('property.valueLabel', { key: prop.key })}
                  defaultValue={
                    prop.value_text ??
                    prop.value_date ??
                    (prop.value_num != null ? String(prop.value_num) : '')
                  }
                  onBlur={(e) => handleSave(prop.key, e.target.value, getType(prop.key))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
                {!BUILTIN_PROPERTY_KEYS.has(prop.key) && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('property.delete')}
                    onClick={() => handleDelete(prop.key)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))
          )}
          {/* Add property from definitions */}
          {!loading && (
            <AddPropertySection
              blockId={blockId}
              definitions={definitions}
              existingKeys={new Set(properties.map((p) => p.key))}
              onAdded={async () => {
                if (!blockId) return
                const props = await getProperties(blockId)
                setProperties(Array.isArray(props) ? props : [])
              }}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ── AddPropertySection ──────────────────────────────────────────────────

interface AddPropertySectionProps {
  blockId: string | null
  definitions: PropertyDefinition[]
  existingKeys: Set<string>
  onAdded: () => void | Promise<void>
}

function AddPropertySection({
  blockId,
  definitions,
  existingKeys,
  onAdded,
}: AddPropertySectionProps): React.ReactElement {
  const { t } = useTranslation()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [newValue, setNewValue] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const availableDefs = definitions.filter((d) => !existingKeys.has(d.key))

  const handleAdd = useCallback(async () => {
    if (!blockId || !selectedKey) return
    try {
      const def = definitions.find((d) => d.key === selectedKey)
      const type = def?.value_type ?? 'text'
      const params: Parameters<typeof setProperty>[0] = { blockId, key: selectedKey }
      if (type === 'number') {
        const num = Number(newValue)
        if (Number.isNaN(num)) {
          toast.error(t('property.invalidNumber'))
          return
        }
        params.valueNum = num
      } else if (type === 'date') {
        params.valueDate = newValue || null
      } else {
        params.valueText = newValue || null
      }
      await setProperty(params)
      setNewValue('')
      setSelectedKey(null)
      setPopoverOpen(false)
      await onAdded()
    } catch {
      toast.error(t('property.saveFailed'))
    }
  }, [blockId, selectedKey, newValue, definitions, onAdded, t])

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-1 text-muted-foreground"
        >
          <Plus size={14} />
          {t('property.addProperty')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <div className="space-y-2">
          {availableDefs.length > 0 ? (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {availableDefs.map((def) => (
                <button
                  key={def.key}
                  type="button"
                  className={`w-full text-left rounded px-2 py-1 text-sm hover:bg-accent transition-colors ${selectedKey === def.key ? 'bg-accent' : ''}`}
                  onClick={() => setSelectedKey(def.key)}
                >
                  {def.key}{' '}
                  <span className="text-xs text-muted-foreground">({def.value_type})</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('property.noProperties')}</p>
          )}
          {selectedKey && (
            <div className="flex items-center gap-1">
              <Input
                className="flex-1 h-7 text-xs"
                placeholder={selectedKey}
                aria-label={t('property.valueLabel', { key: selectedKey })}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd()
                }}
              />
              <Button size="sm" className="h-7" onClick={handleAdd}>
                {t('action.save')}
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
