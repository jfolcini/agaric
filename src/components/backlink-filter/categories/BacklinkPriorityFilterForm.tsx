/**
 * BacklinkPriorityFilterForm — priority selector for the `priority` filter
 * category, applied as a `Priority` filter.
 *
 * Issue #2281 item 10 — the vocabulary is the same `PRIORITY_LEVELS` set the
 * search `priority:` form uses (plus the `none` sentinel), so the option set
 * and value space match across both surfaces. Levels 1/2/3 carry their
 * translated High/Medium/Low labels.
 */

import type React from 'react'
import { useImperativeHandle, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { FilterFormHandle } from '@/components/backlink-filter/categories/types'
import { FilterValueSelect } from '@/components/filters/forms/FilterValueSelect'
import { PRIORITY_LEVELS } from '@/lib/priority-levels'

export interface BacklinkPriorityFilterFormProps {
  ref?: React.Ref<FilterFormHandle>
}

export function BacklinkPriorityFilterForm({
  ref,
}: BacklinkPriorityFilterFormProps): React.ReactElement {
  const { t } = useTranslation()

  // Same vocabulary as the search `priority:` form: the levels plus the
  // `none` sentinel ("no priority set", see `buildPriorityFilter`).
  const options = useMemo(() => {
    const labels: Record<string, string> = {
      '1': t('backlink.highPriority'),
      '2': t('backlink.mediumPriority'),
      '3': t('backlink.lowPriority'),
    }
    return [
      ...PRIORITY_LEVELS.map((p) => ({ value: p, label: labels[p] })),
      { value: 'none', label: t('filterState.none') },
    ]
  }, [t])

  const [priorityValue, setPriorityValue] = useState<string>(PRIORITY_LEVELS[0] ?? 'none')

  useImperativeHandle(ref, () => ({ getState: () => ({ priorityValue }) }), [priorityValue])

  return (
    <FilterValueSelect
      options={options}
      value={priorityValue}
      onValueChange={setPriorityValue}
      ariaLabel={t('backlink.priorityValueLabel')}
    />
  )
}
