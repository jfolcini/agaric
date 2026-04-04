/**
 * BlockPropertyDrawer — slide-out drawer showing all properties for a given block.
 *
 * Follows the HistorySheet pattern: a Sheet component controlled from BlockTree
 * state. Displays property rows with inline editing, deletion, and an
 * AddPropertySection for adding new properties from existing definitions.
 */

import { Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { announce } from '../lib/announcer'
import type { PropertyDefinition, PropertyRow } from '../lib/tauri'
import { deleteProperty, getProperties, listPropertyDefs, setProperty } from '../lib/tauri'

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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80">
        <SheetHeader>
          <SheetTitle>{t('property.drawerTitle')}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-3 px-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('property.loading')}</p>
          ) : properties.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('property.noProperties')}</p>
          ) : (
            properties.map((prop) => (
              <div key={prop.key} className="flex items-center gap-2">
                <span
                  className="text-xs font-medium text-muted-foreground w-20 truncate"
                  title={prop.key}
                >
                  {prop.key}
                </span>
                <Input
                  className="flex-1 h-7 text-sm"
                  defaultValue={
                    prop.value_text ??
                    prop.value_date ??
                    (prop.value_num != null ? String(prop.value_num) : '') ??
                    ''
                  }
                  onBlur={(e) => handleSave(prop.key, e.target.value, getType(prop.key))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive p-0.5"
                  aria-label={t('property.delete')}
                  onClick={() => handleDelete(prop.key)}
                >
                  <X size={14} />
                </button>
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
                className="flex-1 h-7 text-sm"
                placeholder={selectedKey}
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
