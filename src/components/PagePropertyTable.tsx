/**
 * PagePropertyTable — collapsible property table for a page.
 *
 * Rendered below tags in PageHeader. Shows page properties with
 * typed inputs based on property definitions, and an "Add property"
 * popover for adding new properties from existing definitions or
 * creating new definitions.
 */

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
import { handleDeleteProperty, handleSaveProperty } from '@/lib/property-save-utils'
import type { PropertyDefinition, PropertyRow } from '../lib/tauri'
import { createPropertyDef, getProperties, listPropertyDefs, setProperty } from '../lib/tauri'
import { AddPropertyPopover } from './AddPropertyPopover'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { LoadingSkeleton } from './LoadingSkeleton'
import { PropertyRowEditor } from './PropertyRowEditor'

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
