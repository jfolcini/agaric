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

import type { LucideIcon } from 'lucide-react'
import { X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { announce } from '@/lib/announcer'
import { logger } from '@/lib/logger'
import { buildInitParams, NON_DELETABLE_PROPERTIES } from '@/lib/property-save-utils'
import { BUILTIN_PROPERTY_ICONS, formatPropertyName } from '@/lib/property-utils'
import { useBlockPropertyIpc } from '../hooks/useBlockPropertyIpc'
import { useBlockReschedule } from '../hooks/useBlockReschedule'
import { useDateInput } from '../hooks/useDateInput'
import { usePropertySave } from '../hooks/usePropertySave'
import type { PropertyDefinition, PropertyRow as PropertyRowData } from '../lib/tauri'
import { type PageBlockState, usePageBlockStore, usePageBlockStoreApi } from '../stores/page-blocks'
import { AddPropertyPopover } from './AddPropertyPopover'
import { BuiltinDateFields } from './BuiltinDateFields'
import { LoadingSkeleton } from './LoadingSkeleton'
import { PropertyRowEditor } from './PropertyRowEditor'

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
    (s: PageBlockState) => (blockId ? s.blocks.find((b) => b.id === blockId) : undefined),
    [blockId],
  )
  const block = usePageBlockStore(blockSelector)
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
      .catch((err: unknown) => {
        logger.error(
          'BlockPropertyDrawer',
          'Failed to load properties',
          {
            blockId: blockId ?? '',
          },
          err,
        )
        toast.error(t('property.loadFailed'))
      })
      .finally(() => setLoading(false))
  }, [blockId, open, t, getProperties, listPropertyDefs])

  // Save / delete via shared hook (M-28)
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
          blockId: blockId ?? '',
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
            blockId: blockId ?? '',
            field,
          },
          err,
        )
        toast.error(t('property.saveFailed'))
      }
    },
    [blockId, setDueDateCmd, setScheduledDateCmd, t, pageStore.setState],
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
            blockId: blockId ?? '',
            field,
            value,
          },
          err,
        )
        toast.error(t('property.saveFailed'))
      }
    },
    [blockId, setDueDateCmd, setScheduledDateCmd, t, pageStore.setState],
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
            blockId: blockId ?? '',
            key: def.key,
          },
          err,
        )
        toast.error(t('property.saveFailed'))
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
      <SheetContent side="right" className="w-80">
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

// ── PropertyRow ─────────────────────────────────────────────────────────

export interface PropertyRowProps {
  /** Optional icon to display in the badge. When provided, the badge uses icon+text styling; otherwise font-mono. */
  icon?: LucideIcon | undefined
  /** Text displayed inside the badge and as its title attribute. */
  label: string
  /** Current value for the input field (used as defaultValue). */
  value: string
  /** HTML input type (e.g. "date", "text"). Defaults to the browser default (text). */
  inputType?: string
  /** Accessible label for the input element. */
  ariaLabel: string
  /** Optional stable selector applied as `data-testid` on the value input (for E2E specs). */
  testId?: string | undefined
  /** Called with the new value when the input loses focus or Enter is pressed. */
  onSave: (value: string) => void
  /** When provided, renders the X (remove) button. Omit or pass null/undefined to hide it. */
  onRemove?: (() => void) | null | undefined
  /** Accessible label for the remove button. */
  removeAriaLabel?: string
}

export function PropertyRow({
  icon: Icon,
  label,
  value,
  inputType,
  ariaLabel,
  testId,
  onSave,
  onRemove,
  removeAriaLabel,
}: PropertyRowProps): React.ReactElement {
  const { t } = useTranslation()
  const isDate = inputType === 'date'

  // Date input hook (M-29) — always called, values used only when isDate
  const {
    dateInput,
    datePreview,
    dateError,
    handleChange: handleDateChange,
    handleBlur: handleDateBlur,
  } = useDateInput({ initialValue: value, onSave: isDate ? onSave : undefined })

  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
      <Badge
        variant="outline"
        className={
          Icon
            ? 'shrink-0 text-xs max-w-[120px] truncate flex items-center gap-1'
            : 'shrink-0 font-mono text-xs max-w-[120px] truncate'
        }
        title={label}
      >
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </Badge>
      <div className="flex-1">
        <Input
          className="h-7 text-xs"
          type={isDate ? 'text' : inputType}
          aria-label={ariaLabel}
          {...(testId !== undefined ? { 'data-testid': testId } : {})}
          {...(isDate ? { value: dateInput } : { defaultValue: value })}
          placeholder={isDate ? t('property.datePlaceholder') : undefined}
          onBlur={isDate ? handleDateBlur : (e) => onSave(e.target.value)}
          onChange={isDate ? handleDateChange : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        {isDate && datePreview && (
          <p className="text-[10px] text-muted-foreground mt-0.5">{datePreview}</p>
        )}
        {isDate && dateError && (
          <p className="text-[10px] text-destructive mt-0.5">{t('property.dateParseError')}</p>
        )}
      </div>
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
          aria-label={removeAriaLabel}
          onClick={onRemove}
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  )
}
