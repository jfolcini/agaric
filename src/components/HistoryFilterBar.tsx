/**
 * HistoryFilterBar --- operation type filter dropdown for the history view.
 *
 * Extracted from HistoryView for testability.
 *
 * FEAT-3 Phase 8 — also hosts the "All spaces" toggle. The toggle is
 * controlled (state owned by HistoryView, *not* persisted) so every
 * History session starts current-space-only by design.
 */

import { HelpCircle, X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton } from '@/components/ui/icon-button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * UX-350 — convert backend op-type enum values (snake_case, e.g. `edit_block`)
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
  { value: 'restore_block', labelKey: 'history.opTypeRestore' },
  { value: 'purge_block', labelKey: 'history.opTypePurge' },
] as const

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface HistoryFilterBarProps {
  opTypeFilter: string | null
  onFilterChange: (filter: string | null) => void
  /**
   * FEAT-3 Phase 8 — controlled "All spaces" toggle. Optional: when
   * BOTH `showAllSpaces` and `onShowAllSpacesChange` are provided the
   * toggle renders; otherwise it is hidden. The per-page consumer
   * (`HistoryPanel`) omits both because per-page mode already
   * implicitly scopes to a single space (the page's owning space) and
   * the FEAT-3p8 SQL ignores `space_id` for non-`"__all__"` page IDs.
   */
  showAllSpaces?: boolean
  /** Callback when the user flips the "All spaces" switch. */
  onShowAllSpacesChange?: (next: boolean) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryFilterBar({
  opTypeFilter,
  onFilterChange,
  showAllSpaces,
  onShowAllSpacesChange,
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
      {/* UX-350: ? help icon opens a popover legend explaining each
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
      {/* UX-275 sub-fix 3: inline ✕ to clear an active filter without
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
      {/* FEAT-3 Phase 8 — "All spaces" toggle.
          Off by default in HistoryView; flipping on drops the
          space-membership filter from the IPC and surfaces ops from
          every space. State is controlled by the parent and not
          persisted across History sessions. The toggle is hidden when
          either prop is omitted (e.g., per-page HistoryPanel mode). */}
      {showAllSpaces !== undefined && onShowAllSpacesChange !== undefined && (
        <div
          className="history-filter-bar-all-spaces ml-auto flex items-center gap-2"
          title={t('history.allSpacesTooltip')}
        >
          <Label
            htmlFor="history-all-spaces-toggle"
            muted={false}
            className="text-sm font-medium text-muted-foreground"
          >
            {t('history.allSpacesToggle')}
          </Label>
          <Switch
            id="history-all-spaces-toggle"
            checked={showAllSpaces}
            onCheckedChange={onShowAllSpacesChange}
            aria-label={t('history.allSpacesToggle')}
            data-testid="history-all-spaces-toggle"
          />
        </div>
      )}
    </div>
  )
}
