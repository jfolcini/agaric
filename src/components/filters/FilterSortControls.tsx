/**
 * FilterSortControls — the References panels' sort: a field picker joined to
 * an ascending/descending toggle.
 *
 * Built-in fields come first, then the user's properties whose type has an
 * order and that hold one value (`propertySortFields`). No sort means the backend's own order,
 * `DEFAULT_BACKLINK_SORT`, which the controls show and the toggle reverses.
 */

import { useQuery } from '@tanstack/react-query'
import { ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react'
import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/ui/icon-button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  BUILTIN_SORT_FIELDS,
  DEFAULT_BACKLINK_SORT,
  propertySortFields,
  sortFieldValue,
} from '@/lib/backlink-sort'
import type { BacklinkSort, PropertyDefinition } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { listAllPropertyDefs } from '@/lib/property-save-utils'
import { queryClient } from '@/lib/query-client'
import { useSpaceStore } from '@/stores/space'

export interface FilterSortControlsProps {
  sort: BacklinkSort | null
  onSortChange: (sort: BacklinkSort) => void
  /**
   * Load the property definitions behind the "Your properties" group. A panel
   * passes false until it is used, so opening a page costs no IPC.
   */
  loadProperties?: boolean
}

async function fetchPropertyDefs(spaceId: string): Promise<PropertyDefinition[]> {
  try {
    return await listAllPropertyDefs(spaceId)
  } catch (err) {
    logger.warn('FilterSortControls', 'failed to load property definitions', undefined, err)
    return []
  }
}

export function FilterSortControls({
  sort,
  onSortChange,
  loadProperties = true,
}: FilterSortControlsProps): React.ReactElement {
  const { t } = useTranslation()
  const current = sort ?? DEFAULT_BACKLINK_SORT
  // The active space's definitions (#5841). staleTime 0: a definition created
  // since the last open shows up on the next.
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const { data: defs } = useQuery(
    {
      queryKey: ['backlinkSortPropertyDefs', spaceId],
      queryFn: () => (spaceId === null ? [] : fetchPropertyDefs(spaceId)),
      enabled: loadProperties,
      staleTime: 0,
    },
    queryClient,
  )
  const propertyFields = useMemo(() => propertySortFields(defs ?? []), [defs])
  const hasPropertyFields = propertyFields.length > 0

  const ascending = current.dir === 'Asc'
  const directionLabel = t('backlink.sortDirectionLabel', {
    direction: t(ascending ? 'common.ascending' : 'common.descending'),
  })
  const DirectionIcon = ascending ? ArrowUpNarrowWide : ArrowDownWideNarrow

  const handleFieldChange = (value: string): void => {
    const field = [...BUILTIN_SORT_FIELDS, ...propertyFields].find((f) => f.value === value)
    if (field) onSortChange(field.toSort(current.dir))
  }

  return (
    <fieldset aria-label={t('backlink.sortGroupLabel')} className="flex min-w-0 items-center">
      <Select value={sortFieldValue(current)} onValueChange={handleFieldChange}>
        <SelectTrigger
          size="sm"
          aria-label={t('backlink.sortByLabel')}
          className="w-auto min-w-0 max-w-48 gap-1 rounded-r-none px-2"
        >
          <span className="shrink-0 text-muted-foreground">{t('backlink.sortPrefix')}</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>{t('backlink.sortGroupBuiltin')}</SelectLabel>
            {BUILTIN_SORT_FIELDS.map((field) => (
              <SelectItem key={field.value} value={field.value}>
                {t(field.labelKey)}
              </SelectItem>
            ))}
          </SelectGroup>
          {hasPropertyFields && <SelectSeparator />}
          {hasPropertyFields && (
            <SelectGroup>
              <SelectLabel>{t('backlink.sortGroupProperties')}</SelectLabel>
              {propertyFields.map((field) => (
                <SelectItem key={field.value} value={field.value}>
                  {field.key}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      <IconButton
        variant="outline"
        size="icon-xs"
        // As tall as the field picker it is joined to, on a touch screen too; the
        // rest of its 44 px target is invisible. As wide as that target, so the
        // target does not overhang the picker's end and take its taps.
        className="-ml-px size-7 rounded-l-none text-muted-foreground hover:text-foreground coarse:size-9 coarse:w-11 touch-hit-area"
        ariaLabel={directionLabel}
        tooltip={directionLabel}
        onClick={() => onSortChange({ ...current, dir: ascending ? 'Desc' : 'Asc' })}
        data-testid="backlink-sort-direction"
      >
        <DirectionIcon aria-hidden="true" />
      </IconButton>
    </fieldset>
  )
}
