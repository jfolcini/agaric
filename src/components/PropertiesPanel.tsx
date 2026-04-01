import { Plus, Settings2, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { PropertyRow } from '../lib/tauri'
import { deleteProperty, getProperties, setProperty } from '../lib/tauri'
import { EmptyState } from './EmptyState'

interface PropertiesPanelProps {
  blockId: string | null
}

export function PropertiesPanel({ blockId }: PropertiesPanelProps): React.ReactElement {
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [loading, setLoading] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  useEffect(() => {
    if (!blockId) {
      setProperties([])
      return
    }
    setLoading(true)
    getProperties(blockId)
      .then(setProperties)
      .catch(() => {
        toast.error('Failed to load properties')
      })
      .finally(() => setLoading(false))
  }, [blockId])

  const handleAdd = useCallback(async () => {
    if (!blockId || !newKey.trim()) return
    try {
      await setProperty({ blockId, key: newKey.trim(), valueText: newValue })
      const updated = await getProperties(blockId)
      setProperties(updated)
      setNewKey('')
      setNewValue('')
      setShowAddForm(false)
    } catch {
      toast.error('Failed to add property')
    }
  }, [blockId, newKey, newValue])

  const handleDelete = useCallback(
    async (key: string) => {
      if (!blockId) return
      try {
        await deleteProperty(blockId, key)
        setProperties((prev) => prev.filter((p) => p.key !== key))
      } catch {
        toast.error('Failed to delete property')
      }
    },
    [blockId],
  )

  if (!blockId)
    return <EmptyState icon={Settings2} message="Select a block to see properties" compact />

  // Render property value based on which field is set
  function renderValue(prop: PropertyRow): string {
    if (prop.value_text != null) return prop.value_text
    if (prop.value_num != null) return String(prop.value_num)
    if (prop.value_date != null) return prop.value_date
    if (prop.value_ref != null) return `→ ${prop.value_ref.slice(0, 8)}...`
    return '(empty)'
  }

  return (
    <div className="properties-panel space-y-2">
      {loading && (
        <div className="properties-panel-loading space-y-2">
          <Skeleton className="h-6 w-full rounded" />
          <Skeleton className="h-6 w-full rounded" />
        </div>
      )}

      {!loading && properties.length === 0 && (
        <EmptyState icon={Settings2} message="No properties set" compact />
      )}

      {properties.map((prop) => (
        <div key={prop.key} className="property-row flex items-center gap-2 text-sm">
          <Badge variant="outline" className="shrink-0 font-mono text-xs">
            {prop.key}
          </Badge>
          <span className="flex-1 truncate text-muted-foreground">{renderValue(prop)}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => handleDelete(prop.key)}
            aria-label={`Delete property ${prop.key}`}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}

      {!showAddForm ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground gap-1"
          onClick={() => setShowAddForm(true)}
        >
          <Plus className="h-3.5 w-3.5" /> Add property
        </Button>
      ) : (
        <fieldset
          aria-label="Add property"
          className="add-property-form flex items-center gap-2 border-none p-0 m-0"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAdd()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setShowAddForm(false)
            }
          }}
        >
          <Input
            className="h-7 flex-1 text-xs"
            placeholder="Key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <Input
            className="h-7 flex-1 text-xs"
            placeholder="Value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
          />
          <Button size="xs" onClick={handleAdd}>
            Add
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setShowAddForm(false)}>
            Cancel
          </Button>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Press Enter to add, Escape to cancel
          </p>
        </fieldset>
      )}
    </div>
  )
}
