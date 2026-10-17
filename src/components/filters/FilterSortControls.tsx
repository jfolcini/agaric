/**
 * FilterSortControls — the References panels' sort: a field picker joined to
 * an ascending/descending toggle.
 *
 * Built-in fields come first, then the user's properties whose type has an
 * order (`propertySortFields`). No sort means the backend's own order,
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
import { queryClient } from '@/lib/query-client'
import { listAllPropertyDefs } from '@/stores/inline-property-commit'

export interface FilterSortControlsProps {
  sort: BacklinkSort | null
  onSortChange: (sort: BacklinkSort) => void
  /**
   * Load the property definitions behind the "Your properties" group. A panel
   * passes false until it is used, so opening a page costs no IPC.
   */
  loadProperties?: boolean
}

async function fetchPropertyDefs(): Promise<PropertyDefinition[]> {
  try {
    return await listAllPropertyDefs()
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
  // staleTime 0: a definition created since the last open shows up on the next.
  const { data: defs } = useQuery(
    {
      queryKey: ['backlinkSortPropertyDefs'],
      queryFn: fetchPropertyDefs,
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
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a field picker and its direction toggle form one control; <fieldset> would nest inside the builder's own fieldset and add a legend
      role="group"
      aria-label={t('backlink.sortGroupLabel')}
      className="ml-auto flex min-w-0 items-center"
    >
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
        className="-ml-px size-7 rounded-l-none text-muted-foreground hover:text-foreground"
        ariaLabel={directionLabel}
        tooltip={directionLabel}
        onClick={() => onSortChange({ ...current, dir: ascending ? 'Desc' : 'Asc' })}
        data-testid="backlink-sort-direction"
      >
        <DirectionIcon className="size-4" aria-hidden="true" />
      </IconButton>
    </div>
  )
}
