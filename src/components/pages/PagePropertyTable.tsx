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
import { usePageProperties } from '@/hooks/usePageProperties'
import { usePropertySave } from '@/hooks/usePropertySave'
import { unwrap } from '@/lib/app-error'
import type { PropertyDefinition, PropertyRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS } from '@/lib/block-utils'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import {
  buildInitParams,
  DRAFT_ROW_VALUE_TYPES,
  NON_DELETABLE_PROPERTIES,
  SYSTEM_MANAGED_PROPERTY_KEYS,
} from '@/lib/property-save-utils'
import { reportIpcError, reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { useSpaceStore } from '@/stores/space'

// Properties designed for task blocks (content blocks with todo_state).
// Filtered out of the "add property" popover for pages.
const TASK_ONLY_PROPERTIES = new Set(['effort', 'assignee', 'location'])

interface PagePropertyTableProps {
  pageId: string
  forceExpanded?: boolean
}

export function PagePropertyTable({ pageId, forceExpanded }: PagePropertyTableProps) {
  const { t } = useTranslation()
  // The page is in the active space, whose definitions apply (#5841).
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const [expanded, setExpanded] = useState(false)
  const [definitionsLoading, setDefinitionsLoading] = useState(true)
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([])
  const [showAddPopover, setShowAddPopover] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  // #2792 — keys of `DRAFT_ROW_VALUE_TYPES` properties added but not yet
  // persisted. Mirrors `BlockPropertyDrawer`'s `draftKeys` (#2656): such
  // properties have no valid empty value (the real backend rejects it), so we
  // render a local DRAFT row for value entry and only write on the first
  // non-empty save. A draft is dropped (no backend call) if the user leaves it
  // empty or removes it.
  const [draftKeys, setDraftKeys] = useState<Set<string>>(() => new Set())

  const { data: storedRows, error: storedRowsError, isPending } = usePageProperties(pageId)
  const loading = isPending || definitionsLoading

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- marks the per-page definitions IPC load below pending; `definitionsLoading` tracks that async round-trip, not a value derivable during render; see #4407
    setDefinitionsLoading(true)
  }, [pageId])

  // Adopted during render, not in an effect: a frame with the fetch settled but
  // `properties` still empty renders nothing and swallows a click on the header.
  // A refetch keeps this page's unsaved draft rows: the backend has no row for them.
  // #2792 — a page switch drops them, in this same render: a cached page's rows
  // are adopted at once and must not carry the previous page's drafts.
  const [adopted, setAdopted] = useState<{ pageId: string; rows: PropertyRow[] | undefined }>({
    pageId,
    rows: undefined,
  })
  if (adopted.pageId !== pageId || adopted.rows !== storedRows) {
    const samePage = adopted.pageId === pageId
    setAdopted({ pageId, rows: storedRows })
    if (!samePage) setDraftKeys((prev) => (prev.size > 0 ? new Set() : prev))
    if (storedRows) {
      setProperties((prev) => [
        ...storedRows,
        ...(samePage
          ? prev.filter((p) => draftKeys.has(p.key) && !storedRows.some((s) => s.key === p.key))
          : []),
      ])
    }
  }

  // FE-H-17: a failed slice falls back to an empty array so the user still
  // sees the half that loaded.
  useEffect(() => {
    if (!storedRowsError) return
    reportIpcError('PagePropertyTable', 'pageProperty.loadFailed', storedRowsError, t, {
      pageId,
      fetch: 'getProperties',
    })
    // oxlint-disable-next-line react/set-state-in-effect -- clears the table when the shared properties fetch fails; see #4407
    setProperties([])
  }, [storedRowsError, pageId, t])

  // `listPropertyDefs` is paginated; this surface is single-page-by-design —
  // the seeded property vocabulary fits well under one page, so we
  // destructure `.items` and ignore the cursor.
  useEffect(() => {
    if (spaceId === null) return
    // A page switch can land before this answer; the older page's load must
    // not clear the new page's pending state.
    let active = true
    commands
      .listPropertyDefs(spaceId, null, null)
      .then(unwrap)
      .then((defsPage) => {
        if (active) setDefinitions(Array.isArray(defsPage?.items) ? defsPage.items : [])
      })
      .catch((err: unknown) => {
        if (!active) return
        reportIpcError('PagePropertyTable', 'pageProperty.loadFailed', err, t, {
          pageId,
          fetch: 'listPropertyDefs',
        })
        setDefinitions([])
      })
      .finally(() => {
        if (active) setDefinitionsLoading(false)
      })
    return () => {
      active = false
    }
  }, [pageId, spaceId, t])

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
    logTag: 'PagePropertyTable',
  })

  const forgetDraft = useCallback((key: string) => {
    setDraftKeys((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

  const dropDraft = useCallback(
    (key: string) => {
      setProperties((prev) => prev.filter((p) => p.key !== key))
      forgetDraft(key)
    },
    [forgetDraft],
  )

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
          dropDraft(key)
          return
        }
        forgetDraft(key)
      }
      await doSave(key, rawValue, valueType)
    },
    [doSave, draftKeys, dropDraft, forgetDraft],
  )

  // A draft was never written, so removing one is local: a `delete_property`
  // for a key the page never held appends an op whose undo fails, which
  // aborts the page's undo group.
  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      if (draftKeys.has(deleteTarget)) {
        dropDraft(deleteTarget)
      } else {
        // `usePropertySave` toasts and logs its own failure; never rejects.
        void doDeleteProperty(deleteTarget)
      }
      setDeleteTarget(null)
    }
  }, [deleteTarget, doDeleteProperty, draftKeys, dropDraft])

  // #2792 / #2804 — `DRAFT_ROW_VALUE_TYPES` have no valid empty initializer
  // (the backend rejects an empty `value_text`, a ref with no target and, for
  // select, any value outside the definition's options). Add a local draft row
  // for value entry instead of persisting an invalid placeholder; it writes on
  // the first non-empty save (see `doSaveProperty`). Shared by both
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
      if (DRAFT_ROW_VALUE_TYPES.has(def.value_type)) {
        addDraftRow(def)
        return
      }
      try {
        const params = buildInitParams(pageId, def)
        if (!params) return
        unwrap(
          await commands.setProperty(params.blockId, params.key, {
            value_text: params.valueText ?? null,
            value_num: params.valueNum ?? null,
            value_date: params.valueDate ?? null,
            value_ref: params.valueRef ?? null,
            value_bool: params.valueBool ?? null,
          }),
        )
        const updated = unwrap(await commands.getProperties(pageId))
        setProperties(updated)
      } catch (err) {
        logger.warn('PagePropertyTable', 'add property failed', { pageId }, err)
        notify.error(t('pageProperty.addFailed'))
      }
    },
    [pageId, t, addDraftRow],
  )

  const handleCreateDef = useCallback(
    async (key: string, valueType: string, options: string | null) => {
      if (spaceId === null) return
      try {
        const newDef = unwrap(await commands.createPropertyDef(spaceId, key, valueType, options))
        setDefinitions((prev) => [...prev, newDef])
        // #2804 — same rationale as `handleAddFromDef`: a brand-new
        // `DRAFT_ROW_VALUE_TYPES` def has no valid empty initializer, so add a
        // draft row instead of init-persisting an empty value.
        if (DRAFT_ROW_VALUE_TYPES.has(newDef.value_type)) {
          addDraftRow(newDef)
          return
        }
        const params = buildInitParams(pageId, newDef)
        if (params) {
          unwrap(
            await commands.setProperty(params.blockId, params.key, {
              value_text: params.valueText ?? null,
              value_num: params.valueNum ?? null,
              value_date: params.valueDate ?? null,
              value_ref: params.valueRef ?? null,
              value_bool: params.valueBool ?? null,
            }),
          )
          const updated = unwrap(await commands.getProperties(pageId))
          setProperties(updated)
        }
      } catch (err: unknown) {
        // #4399 — this intended to surface the backend's own reason, and
        // could not: `unwrap` throws the deserialized `AppError` OBJECT, so
        // `err instanceof Error` is false for exactly the IPC rejections
        // whose message matters and every one of them fell through to the
        // generic toast. It matters more now that `create_property_def`
        // refuses to declare a type over a key whose existing values
        // contradict it — the refusal names the key, the count and the
        // stored shapes. Shared helper so this and the Settings → Properties
        // call site cannot drift; it also adds the structured log line this
        // branch never had.
        reportIpcErrorWithReason('PagePropertyTable', 'property.createDefFailed', err, t, {
          pageId,
          key,
        })
      }
    },
    [pageId, spaceId, t, addDraftRow],
  )

  // Definitions available for the add-property popover:
  // exclude already-set keys, task-only properties, and system-managed builtin keys.
  const availableDefs = definitions.filter(
    (d) =>
      !properties.some((p) => p.key === d.key) &&
      !TASK_ONLY_PROPERTIES.has(d.key) &&
      !NON_DELETABLE_PROPERTIES.has(d.key) &&
      !INTERNAL_PROPERTY_KEYS.has(d.key),
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
              const canDelete = !SYSTEM_MANAGED_PROPERTY_KEYS.has(prop.key)
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
                    forgetDraft(prop.key)
                    const updated = unwrap(await commands.getProperties(pageId))
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
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}
