/**
 * BlockPropertyDrawer — slide-out drawer showing all properties for a given block.
 *
 * Follows the HistorySheet pattern: a Sheet component controlled from BlockTree
 * state. Displays property rows with inline editing, deletion, and an
 * AddPropertyPopover for adding new properties from existing definitions.
 *
 * Built-in block fields (due_date, scheduled_date) are shown as read-only
 * summary rows at the top, sourced from the block store for reactivity.
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AddPropertyPopover } from '@/components/properties/AddPropertyPopover'
import { BuiltinDateFields } from '@/components/properties/BuiltinDateFields'
import { PropertyRow } from '@/components/properties/PropertyRow'
import { PropertyRowEditor } from '@/components/PropertyRowEditor'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useBlockPropertyIpc } from '@/hooks/useBlockPropertyIpc'
import { useBlockReschedule } from '@/hooks/useBlockReschedule'
import { usePropertySave } from '@/hooks/usePropertySave'
import { announce } from '@/lib/announcer'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { buildInitParams, NON_DELETABLE_PROPERTIES } from '@/lib/property-save-utils'
import { BUILTIN_PROPERTY_ICONS, formatPropertyName } from '@/lib/property-utils'
import { reportIpcError } from '@/lib/report-ipc-error'
import type { PropertyDefinition, PropertyRow as PropertyRowData } from '@/lib/tauri'
import { type PageBlockState, usePageBlockStore, usePageBlockStoreApi } from '@/stores/page-blocks'

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
  const [properties, setProperties] = useState<PropertyRowData[]>([])
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([])
  const { setDueDate: setDueDateCmd, setScheduledDate: setScheduledDateCmd } = useBlockReschedule()
  const { getProperties, listPropertyDefs, setProperty } = useBlockPropertyIpc()

  // Subscribe to built-in date fields from the block store so the drawer
  // updates reactively when dates are set via toolbar (H-12).
  const pageStore = usePageBlockStoreApi()
  const blockSelector = useCallback(
    (s: PageBlockState) => (blockId ? s.blocksById.get(blockId) : undefined),
    [blockId],
  )
  const block = usePageBlockStore(blockSelector)
  const dueDate = block?.due_date ?? null
  const scheduledDate = block?.scheduled_date ?? null

  // Load properties + definitions when blockId changes or drawer opens
  useEffect(() => {
    if (!blockId || !open) return
    setLoading(true)
    // `listPropertyDefs` is paginated. The drawer is single-page-by-design —
    // it shows the property-defs vocabulary picker, which fits well under one page.
    // FE-H-17: use `Promise.allSettled` so a single rejection no longer fails the
    // whole load. Each fetch reports its own failure via `reportIpcError`, and
    // the failed slice falls back to an empty array so the user still sees the
    // half that loaded.
    Promise.allSettled([getProperties(blockId), listPropertyDefs()]).then(
      ([propsResult, defsResult]) => {
        if (propsResult.status === 'fulfilled') {
          const props = propsResult.value
          setProperties(Array.isArray(props) ? props : [])
        } else {
          reportIpcError('BlockPropertyDrawer', 'property.loadFailed', propsResult.reason, t, {
            blockId: blockId ?? '',
            fetch: 'getProperties',
          })
          setProperties([])
        }
        if (defsResult.status === 'fulfilled') {
          const defsPage = defsResult.value
          setDefinitions(Array.isArray(defsPage?.items) ? defsPage.items : [])
        } else {
          reportIpcError('BlockPropertyDrawer', 'property.loadFailed', defsResult.reason, t, {
            blockId: blockId ?? '',
            fetch: 'listPropertyDefs',
          })
          setDefinitions([])
        }
        setLoading(false)
      },
    )
  }, [blockId, open, t, getProperties, listPropertyDefs])

  // Save / delete via shared hook
  const { handleSave, handleDelete } = usePropertySave({
    blockId,
    setProperties,
    announceOnSave: 'property.saved',
    announceOnDelete: 'property.deleted',
    logTag: 'BlockPropertyDrawer',
  })

  // Determine property type from definitions
  const getType = useCallback(
    (key: string) => {
      return definitions.find((d) => d.key === key)?.value_type ?? 'text'
    },
    [definitions],
  )

  // Reload properties after ref picker saves a value
  const reloadProperties = useCallback(async () => {
    if (!blockId) return
    try {
      const props = await getProperties(blockId)
      setProperties(Array.isArray(props) ? props : [])
    } catch (err) {
      logger.warn(
        'BlockPropertyDrawer',
        'Failed to reload properties after ref save',
        {
          blockId,
        },
        err,
      )
    }
  }, [blockId, getProperties])

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
        pageStore.setState((s) => ({
          blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, [field]: null } : b)),
        }))
        announce(t('property.dateCleared'))
      } catch (err) {
        logger.error(
          'BlockPropertyDrawer',
          'Failed to clear builtin date',
          {
            blockId,
            field,
          },
          err,
        )
        notify.error(t('property.saveFailed'))
      }
    },
    [blockId, setDueDateCmd, setScheduledDateCmd, t, pageStore],
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
        pageStore.setState((s) => ({
          blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, [field]: value } : b)),
        }))
        announce(t('property.dateUpdated'))
      } catch (err) {
        logger.error(
          'BlockPropertyDrawer',
          'Failed to save builtin date',
          {
            blockId,
            field,
            value,
          },
          err,
        )
        notify.error(t('property.saveFailed'))
      }
    },
    [blockId, setDueDateCmd, setScheduledDateCmd, t, pageStore],
  )

  const hasBuiltinDates = dueDate !== null || scheduledDate !== null

  // Add property from definition
  const handleAddFromDef = useCallback(
    async (def: PropertyDefinition) => {
      if (!blockId) return
      try {
        const params = buildInitParams(blockId, def)
        if (!params) return
        await setProperty(params)
        const updated = await getProperties(blockId)
        setProperties(Array.isArray(updated) ? updated : [])
      } catch (err) {
        logger.error(
          'BlockPropertyDrawer',
          'Failed to add property from definition',
          {
            blockId,
            key: def.key,
          },
          err,
        )
        notify.error(t('property.saveFailed'))
      }
    },
    [blockId, t, setProperty, getProperties],
  )

  // Definitions available for the add-property popover:
  // exclude already-set keys and system-managed builtin keys.
  const existingKeys = new Set(properties.map((p) => p.key))
  const availableDefs = definitions.filter(
    (d) => !existingKeys.has(d.key) && !NON_DELETABLE_PROPERTIES.has(d.key),
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-3/4 sm:w-80">
        <SheetHeader>
          <SheetTitle>{t('property.drawerTitle')}</SheetTitle>
          <SheetDescription>{t('property.drawerDescription')}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="mt-4 space-y-3 px-4 pb-4">
            {/* Built-in date fields from the blocks table (H-12) */}
            {!loading && (
              <BuiltinDateFields
                dueDate={dueDate}
                scheduledDate={scheduledDate}
                hasCustomProperties={properties.length > 0}
                onSaveDate={handleSaveBuiltinDate}
                onClearDate={handleClearBuiltinDate}
              />
            )}

            {loading ? (
              <LoadingSkeleton
                count={3}
                height="h-7"
                aria-label={t('properties.loadingPropertiesTitle')}
                data-testid="block-property-drawer-loading"
              />
            ) : properties.length === 0 && !hasBuiltinDates ? (
              <p className="text-sm text-muted-foreground">{t('property.noProperties')}</p>
            ) : (
              properties.map((prop) => {
                const propType = getType(prop.key)
                // Use PropertyRowEditor for ref-type properties (includes page picker)
                if (propType === 'ref' && blockId) {
                  const def = definitions.find((d) => d.key === prop.key)
                  return (
                    <PropertyRowEditor
                      key={prop.key}
                      blockId={blockId}
                      prop={prop}
                      def={def}
                      onSave={(v) => handleSave(prop.key, v, propType)}
                      onDelete={
                        !NON_DELETABLE_PROPERTIES.has(prop.key)
                          ? () => handleDelete(prop.key)
                          : undefined
                      }
                      onRefSaved={reloadProperties}
                    />
                  )
                }
                const Icon = BUILTIN_PROPERTY_ICONS[prop.key]
                const label = Icon ? formatPropertyName(prop.key) : prop.key
                return (
                  <PropertyRow
                    key={prop.key}
                    propKey={prop.key}
                    icon={Icon}
                    label={label}
                    value={
                      prop.value_text ??
                      prop.value_date ??
                      (prop.value_num != null ? String(prop.value_num) : '')
                    }
                    ariaLabel={t('property.valueLabel', { key: prop.key })}
                    testId={`property-value-input-${prop.key}`}
                    onSave={(v) => handleSave(prop.key, v, getType(prop.key))}
                    onRemove={
                      !NON_DELETABLE_PROPERTIES.has(prop.key)
                        ? () => handleDelete(prop.key)
                        : undefined
                    }
                    removeAriaLabel={t('property.delete')}
                  />
                )
              })
            )}
            {/* Add property from definitions — shown during load with a
                tooltip-explained disabled state so the layout doesn't jump. */}
            <AddPropertyPopover
              definitions={availableDefs}
              onAdd={handleAddFromDef}
              disabled={loading}
              disabledTooltip={t('properties.loadingPropertiesDisabled')}
            />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
