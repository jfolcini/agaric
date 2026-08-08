/**
 * stateVocabulary — the SINGLE canonical task-state vocabulary shared by
 * BOTH filter surfaces:
 *   - search builder `StateFilterForm`   (`state:` / `not-state:`)
 *   - backlink category `StatusFilterForm` (PropertyText key=`todo`)
 *
 * Issue #1647 follow-up — the maintainer decided to UNIFY the search
 * "State" and backlink "Status" vocabularies into one source of truth so
 * they can never drift again. Previously search used the full
 * autocomplete state set while backlink kept a TODO/DOING/DONE
 * shortlist; both now read this module.
 *
 * The canonical VALUE set is `TASK_STATE_AUTOCOMPLETE_VALUES` from the leaf
 * task-state module (the same tuple that drives search autocomplete and the
 * `state:` filter parser). We re-export it here under
 * a vocabulary-neutral name and pair it with translated labels, so the
 * unified vocab reads consistently on both surfaces and a future edit can
 * only change ONE list.
 */

import { useTranslation } from 'react-i18next'

import type { FilterValueOption } from '@/components/filters/forms/FilterValueSelect'
import { TASK_STATE_AUTOCOMPLETE_VALUES } from '@/lib/task-states'

/**
 * The canonical task-state value set. Re-exported from the search
 * task-state source-of-truth so the VALUE set has exactly one definition.
 */
export const STATE_FILTER_VALUES = TASK_STATE_AUTOCOMPLETE_VALUES

export type StateFilterValue = (typeof STATE_FILTER_VALUES)[number]

/** i18n key for a given canonical state value's user-facing label. */
const STATE_LABEL_KEYS: Record<StateFilterValue, string> = {
  TODO: 'filterState.todo',
  DOING: 'filterState.doing',
  DONE: 'filterState.done',
  CANCELLED: 'filterState.cancelled',
  none: 'filterState.none',
}

/**
 * The unified state vocabulary as `FilterValueSelect` options, with
 * translated labels. Both the search State form and the backlink Status
 * form consume this so neither the value set nor the labels can diverge.
 */
export function useStateFilterOptions(): FilterValueOption[] {
  const { t } = useTranslation()
  return STATE_FILTER_VALUES.map((value) => ({ value, label: t(STATE_LABEL_KEYS[value]) }))
}
