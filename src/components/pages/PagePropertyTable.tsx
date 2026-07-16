/**
 * PagePropertyTable — collapsible property table for a page.
 *
 * Rendered below tags in PageHeader. Shows page properties with
 * typed inputs based on property definitions, and a `t('pageProperty.addPropertyButton')`
 * popover for adding new properties from existing definitions or
 * creating new definitions.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { AddPropertyPopover } from '@/components/properties/AddPropertyPopover'
import { PropertyRowEditor } from '@/components/properties/PropertyRowEditor'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { usePropertySave } from '@/hooks/usePropertySave'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { buildInitParams, NON_DELETABLE_PROPERTIES } from '@/lib/property-save-utils'
import { reportIpcError } from '@/lib/report-ipc-error'
import type { PropertyDefinition, PropertyRow } from '@/lib/tauri'
import { createPropertyDef, getProperties, listPropertyDefs, setProperty } from '@/lib/tauri'

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
  // #2792 — keys of text/select properties added but not yet persisted.
  // Mirrors `BlockPropertyDrawer`'s `draftKeys` (#2656): such properties
  // cannot be created with an empty `value_text` (the real backend rejects
  // it), so we render a local DRAFT row for value entry and only write on
  // the first non-empty save. A draft is dropped (no backend call) if the
  // user leaves it empty.
  const [draftKeys, setDraftKeys] = useState<Set<string>>(() => new Set())

  // Load properties and definitions in parallel.
  // `listPropertyDefs` is paginated; this surface is
  // single-page-by-design — the seeded property vocabulary fits
  // well under one page, so we destructure `.items` and ignore the cursor.
  // FE-H-17: use `Promise.allSettled` so a single rejection no longer fails
  // the whole load. Each fetch reports its own failure via `reportIpcError`,
  // and the failed slice falls back to an empty array so the user still sees
  // the half that loaded.
  useEffect(() => {
    setLoading(true)
    // #2792 — drop any unsaved draft rows from a previous page so they can't
    // leak into this page's table (drafts are transient, never persisted).
    // Mirrors `BlockPropertyDrawer`'s per-blockId draft reset (#2656).
    setDraftKeys((prev) => (prev.size > 0 ? new Set() : prev))
    Promise.allSettled([getProperties(pageId), listPropertyDefs()]).then(
      ([propsResult, defsResult]) => {
        if (propsResult.status === 'fulfilled') {
          const props = propsResult.value
          setProperties(Array.isArray(props) ? props : [])
        } else {
          reportIpcError('PagePropertyTable', 'pageProperty.loadFailed', propsResult.reason, t, {
            pageId,
            fetch: 'getProperties',
          })
          setProperties([])
        }
        if (defsResult.status === 'fulfilled') {
          const defsPage = defsResult.value
          setDefinitions(Array.isArray(defsPage?.items) ? defsPage.items : [])
        } else {
          reportIpcError('PagePropertyTable', 'pageProperty.loadFailed', defsResult.reason, t, {
            pageId,
            fetch: 'listPropertyDefs',
          })
          setDefinitions([])
        }
        setLoading(false)
      },
    )
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
    (key: string): PropertyDefinition | undefined => definitions.find((d) => d.key === key),
    [definitions],
  )

  // Save / delete via shared hook
  const { handleSave: doSave, handleDelete: doDeleteProperty } = usePropertySave({
    blockId: pageId,
    setProperties,
    toasts: {
      saveFailed: 'pageProperty.saveFailed',
      deleteFailed: 'pageProperty.deleteFailed',
    },
  })

  /**
   * Wrapper that resolves valueType from def before delegating to hook.
   *
   * #2792 — for a not-yet-persisted DRAFT (text/select) row, an empty value
   * means "nothing entered": drop the draft locally without a backend call
   * (an empty `value_text` would be rejected). A non-empty value clears the
   * draft flag and persists via the shared save hook (the reload then
   * replaces the draft with the stored row). Mirrors
   * `BlockPropertyDrawer.handleSaveField`.
   */
  const doSaveProperty = useCallback(
    async (key: string, def: PropertyDefinition | undefined, rawValue: string) => {
      const valueType = def?.value_type ?? 'text'
      if (draftKeys.has(key)) {
        if (rawValue.trim() === '') {
          setProperties((prev) => prev.filter((p) => p.key !== key))
          setDraftKeys((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
          return
        }
        setDraftKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
      await doSave(key, rawValue, valueType)
    },
    [doSave, draftKeys],
  )

  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      doDeleteProperty(deleteTarget)
      setDeleteTarget(null)
    }
  }, [deleteTarget, doDeleteProperty])

  // #2792 / #2804 — text/select properties have no valid empty initializer
  // (the backend rejects an empty `value_text` and, for select, any value
  // outside the definition's options). Add a local draft row for value
  // entry instead of persisting an invalid placeholder; it writes on the
  // first non-empty save (see `doSaveProperty`). Shared by both
  // `handleAddFromDef` (existing def) and `handleCreateDef` (brand-new
  // def, #2804) since both land on the same "just-added property with no
  // value yet" state.
  const addDraftRow = useCallback((def: PropertyDefinition) => {
    setDraftKeys((prev) => {
      if (prev.has(def.key)) return prev
      const next = new Set(prev)
      next.add(def.key)
      return next
    })
    setProperties((prev) =>
      prev.some((p) => p.key === def.key)
        ? prev
        : [
            ...prev,
            {
              key: def.key,
              value_text: null,
              value_num: null,
              value_date: null,
              value_ref: null,
              value_bool: null,
            },
          ],
    )
  }, [])

  const handleAddFromDef = useCallback(
    async (def: PropertyDefinition) => {
      // #2792 — mirrors `BlockPropertyDrawer.handleAddFromDef` (#2656).
      if (def.value_type === 'text' || def.value_type === 'select') {
        addDraftRow(def)
        return
      }
      try {
        const params = buildInitParams(pageId, def)
        if (!params) return
        await setProperty(params)
        const updated = await getProperties(pageId)
        setProperties(updated)
      } catch (err) {
        logger.warn('PagePropertyTable', 'add property failed', { pageId }, err)
        notify.error(t('pageProperty.addFailed'))
      }
    },
    [pageId, t, addDraftRow],
  )

  const handleCreateDef = useCallback(
    async (key: string, valueType: string) => {
      try {
        const newDef = await createPropertyDef({ key, valueType })
        setDefinitions((prev) => [...prev, newDef])
        // #2804 — same rationale as `handleAddFromDef`: a brand-new
        // text/select def has no valid empty initializer, so add a draft
        // row instead of init-persisting an empty `value_text`.
        if (newDef.value_type === 'text' || newDef.value_type === 'select') {
          addDraftRow(newDef)
          return
        }
        const params = buildInitParams(pageId, newDef)
        if (params) {
          await setProperty(params)
          const updated = await getProperties(pageId)
          setProperties(updated)
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : undefined
        notify.error(message ?? t('property.createDefFailed'))
      }
    },
    [pageId, t, addDraftRow],
  )

  // Definitions available for the add-property popover:
  // exclude already-set keys, task-only properties, and system-managed builtin keys.
  const availableDefs = definitions.filter(
    (d) =>
      !properties.some((p) => p.key === d.key) &&
      !TASK_ONLY_PROPERTIES.has(d.key) &&
      !NON_DELETABLE_PROPERTIES.has(d.key),
  )

  const propertyCount = properties.length

  if (!loading && properties.length === 0 && !forceExpanded) {
    return null
  }

  return (
    <div className="page-property-table">
      <CollapsiblePanelHeader
        isCollapsed={!expanded}
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
              const canDelete = !NON_DELETABLE_PROPERTIES.has(prop.key)
              return (
                <PropertyRowEditor
                  key={prop.key}
                  blockId={pageId}
                  prop={prop}
                  def={def}
                  onSave={(rawValue) => doSaveProperty(prop.key, def, rawValue)}
                  forceSaveOnBlur={draftKeys.has(prop.key)}
                  onDelete={canDelete ? () => setDeleteTarget(prop.key) : undefined}
                  onDefUpdated={(updatedDef) => {
                    setDefinitions((prev) =>
                      prev.map((d) => (d.key === updatedDef.key ? updatedDef : d)),
                    )
                  }}
                  onRefSaved={async () => {
                    const updated = await getProperties(pageId)
                    setProperties(updated)
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
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        titleKey="property.deleteConfirm"
        descriptionKey="property.deleteConfirmDesc"
        cancelKey="action.cancel"
        confirmKey="action.delete"
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}
