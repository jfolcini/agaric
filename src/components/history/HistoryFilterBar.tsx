/**
 * HistoryFilterBar --- operation type filter dropdown for the history view.
 *
 * Extracted from HistoryView for testability.
 */

import { HelpCircle, X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Convert backend op-type enum values (snake_case, e.g. `edit_block`)
 * to camelCase (`editBlock`) for i18n key lookup. The i18n key naming
 * convention (enforced by `src/lib/__tests__/i18n.test.ts`) requires
 * alphanumeric segments separated by dots; underscores are reserved for the
 * `_one` / `_other` plural suffixes only.
 */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_match, ch: string) => ch.toUpperCase())
}

const OP_TYPES = [
  { value: 'edit_block', labelKey: 'history.opTypeEdit' },
  { value: 'create_block', labelKey: 'history.opTypeCreate' },
  { value: 'delete_block', labelKey: 'history.opTypeDelete' },
  { value: 'move_block', labelKey: 'history.opTypeMove' },
  { value: 'add_tag', labelKey: 'history.opTypeAddTag' },
  { value: 'remove_tag', labelKey: 'history.opTypeRemoveTag' },
  { value: 'set_property', labelKey: 'history.opTypeSetProperty' },
  { value: 'delete_property', labelKey: 'history.opTypeDeleteProperty' },
  { value: 'add_attachment', labelKey: 'history.opTypeAddAttachment' },
  { value: 'delete_attachment', labelKey: 'history.opTypeRemoveAttachment' },
  // #4277 — `rename_attachment` was missing here because the op could never
  // appear in the list this filter narrows: `list_page_history` had no
  // attachment disjunct, so selecting it would have returned nothing.
  { value: 'rename_attachment', labelKey: 'history.opTypeRenameAttachment' },
  { value: 'restore_block', labelKey: 'history.opTypeRestore' },
  { value: 'purge_block', labelKey: 'history.opTypePurge' },
] as const

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface HistoryFilterBarProps {
  opTypeFilter: string | null
  onFilterChange: (filter: string | null) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryFilterBar({
  opTypeFilter,
  onFilterChange,
}: HistoryFilterBarProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    // PEND block-history-sheet-fix: the bar uses `flex flex-wrap items-center`
    // so it fills available width and wraps row-by-row only when it actually
    // runs out of space — works for both the wide HistoryView and the narrow
    // ~512 px Sheet without a media query. The Select trigger, help-popover
    // (?), and clear-✕ live in the same flex row so they read as one cluster.
    // The standalone `<label>` was dropped because the Select already has an
    // `aria-label` — the visible duplicate was just stealing a vertical row
    // at narrow widths.
    <div className="history-filter-bar flex flex-wrap items-center gap-2">
      <Select
        value={opTypeFilter ?? '__all__'}
        onValueChange={(val) => onFilterChange(val === '__all__' ? null : val)}
      >
        <SelectTrigger
          id="op-type-filter"
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          aria-label={t('history.filterByTypeLabel')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">{t('history.allTypesOption')}</SelectItem>
          {OP_TYPES.map((opType) => (
            <SelectItem key={opType.value} value={opType.value}>
              {t(opType.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* ? help icon opens a popover legend explaining each
          op type — addresses the lack of in-UI explanation for the 12
          internal op-type values shown in the Select. */}
      <Popover>
        <PopoverTrigger asChild>
          <IconButton
            type="button"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground"
            tooltip={t('history.filterBar.legend')}
            ariaLabel={t('history.opTypeLegendLabel')}
            data-testid="history-filter-legend-trigger"
          >
            <HelpCircle className="h-4 w-4" />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent
          className="w-80"
          align="start"
          aria-label={t('history.opTypeLegendPopoverLabel')}
        >
          <h4 className="text-sm font-semibold mb-2">{t('history.opTypeLegendTitle')}</h4>
          <dl className="text-xs space-y-1.5">
            {OP_TYPES.map((opType) => (
              <div key={opType.value} className="flex gap-2">
                <dt className="font-mono shrink-0 w-32">{t(opType.labelKey)}</dt>
                <dd className="text-muted-foreground">
                  {t(`history.opTypeDescription.${snakeToCamel(opType.value)}`)}
                </dd>
              </div>
            ))}
          </dl>
        </PopoverContent>
      </Popover>
      {/*  sub-fix 3: inline ✕ to clear an active filter without
          opening the dropdown. Sits next to the Select trigger so it
          reads as part of the same filter control. */}
      {opTypeFilter !== null && (
        <IconButton
          type="button"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => onFilterChange(null)}
          tooltip={t('history.filterBar.clear')}
          ariaLabel={t('history.clearFilter')}
          data-testid="history-filter-clear"
        >
          <X className="h-3.5 w-3.5" />
        </IconButton>
      )}
    </div>
  )
}
