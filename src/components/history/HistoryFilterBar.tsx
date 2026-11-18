/**
 * HistoryFilterBar --- operation type filter dropdown for the history view.
 *
 * Extracted from HistoryView for testability.
 */

import { X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/ui/icon-button'
import { InfoPopover } from '@/components/ui/info-popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { OP_TYPE_LABEL_KEYS } from '@/lib/history-utils'

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

const OP_TYPES = Object.entries(OP_TYPE_LABEL_KEYS).map(([value, labelKey]) => ({
  value,
  labelKey,
}))

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
    // ~512 px Sheet without a media query. The Select trigger, legend ⓘ
    // and clear-✕ live in the same flex row so they read as one cluster.
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
          // `w-auto flex-1`: the trigger's own `w-full` wrapped the ⓘ onto a row of its own.
          className="h-8 w-auto flex-1 rounded-md border border-input bg-background px-2 text-sm"
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
      {/* ⓘ opens a legend explaining each op type — the Select shows the
          internal op-type values without saying what they mean. */}
      <InfoPopover
        variant="icon"
        data-testid="history-filter-legend-trigger"
        ariaLabel={t('history.opTypeLegendLabel')}
        content={
          <>
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
          </>
        }
      />
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
          <X />
        </IconButton>
      )}
    </div>
  )
}
