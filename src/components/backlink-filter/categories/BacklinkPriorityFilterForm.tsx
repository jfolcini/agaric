/**
 * BacklinkPriorityFilterForm — priority selector for the `priority` filter
 * category.  Shortcut for `PropertyText` with key `priority`.
 *
 * Issue #2281 item 10 — the vocabulary is now the same user-configurable
 * `usePriorityLevels()` set the search `priority:` form uses (plus the
 * `none` sentinel), so the option set and value space match across both
 * surfaces instead of this surface keeping a fixed 1/2/3 shortlist
 * (the pre-#2281 per-surface split from #1647). The legacy default
 * levels 1/2/3 keep their translated High/Medium/Low labels;
 * user-defined levels render verbatim.
 */

import type React from 'react'
import { useImperativeHandle, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FilterValueSelect } from '@/components/filters/forms/FilterValueSelect'
import { usePriorityLevels } from '@/hooks/usePriorityLevels'

import type { FilterFormHandle } from './types'

export interface BacklinkPriorityFilterFormProps {
  ref?: React.Ref<FilterFormHandle>
}

export function BacklinkPriorityFilterForm({
  ref,
}: BacklinkPriorityFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const priorityLevels = usePriorityLevels()

  // Same vocabulary as the search `priority:` form: configured levels plus
  // the `none` sentinel ("no priority set" — mapped to `PropertyIsEmpty`
  // downstream in `buildPriorityFilter`, mirroring the Status form's `none`).
  const options = useMemo(() => {
    // Legacy 1/2/3 defaults keep their descriptive labels; anything the
    // user configured beyond that renders as its raw value.
    const legacyLabels: Record<string, string> = {
      '1': t('backlink.highPriority'),
      '2': t('backlink.mediumPriority'),
      '3': t('backlink.lowPriority'),
    }
    return [
      ...priorityLevels.map((p) => ({ value: p, label: legacyLabels[p] })),
      { value: 'none', label: t('filterState.none') },
    ]
  }, [priorityLevels, t])

  const [priorityValue, setPriorityValue] = useState<string>(priorityLevels[0] ?? 'none')

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
