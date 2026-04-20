import { i18n } from './i18n'
import { getPriorityLevels } from './priority-levels'

export type AgendaFilterDimension =
  | 'status'
  | 'priority'
  | 'dueDate'
  | 'scheduledDate'
  | 'completedDate'
  | 'createdDate'
  | 'tag'
  | 'property'

/**
 * Fixed TODO states (UX-202). The cycle is locked to
 * `none -> TODO -> DOING -> DONE -> CANCELLED -> none` (UX-234); this array
 * exposes the non-null members for filter dimension `choices`.
 */
export const TASK_STATES: readonly string[] = ['TODO', 'DOING', 'DONE', 'CANCELLED']

/**
 * Backwards-compatible accessor. Historically this read from localStorage;
 * the states are now fixed (UX-202).
 */
export function getTaskStates(): string[] {
  return [...TASK_STATES]
}

/**
 * Priority filter choices. User-configurable via the `priority` property
 * definition's options (UX-201b) — returns a fresh copy of the active
 * levels at call time.
 */
export function getPriorityChoices(): string[] {
  return [...getPriorityLevels()]
}

export const DIMENSION_OPTIONS: Record<
  AgendaFilterDimension,
  { labelKey: string; choices: string[] | null | (() => string[]) }
> = {
  status: { labelKey: 'agendaFilter.status', choices: getTaskStates },
  priority: { labelKey: 'agendaFilter.priority', choices: getPriorityChoices },
  dueDate: {
    labelKey: 'agendaFilter.dueDate',
    choices: [
      'Today',
      'This week',
      'This month',
      'Overdue',
      'Next 7 days',
      'Next 14 days',
      'Next 30 days',
    ],
  },
  scheduledDate: {
    labelKey: 'agendaFilter.scheduledDate',
    choices: [
      'Today',
      'This week',
      'This month',
      'Overdue',
      'Next 7 days',
      'Next 14 days',
      'Next 30 days',
    ],
  },
  completedDate: {
    labelKey: 'agendaFilter.completedDate',
    choices: ['Today', 'This week', 'This month', 'Last 7 days', 'Last 30 days'],
  },
  createdDate: {
    labelKey: 'agendaFilter.createdDate',
    choices: ['Today', 'This week', 'This month', 'Last 7 days', 'Last 30 days'],
  },
  tag: { labelKey: 'agendaFilter.tag', choices: null },
  property: { labelKey: 'agendaFilter.property', choices: null },
}

export const ALL_DIMENSIONS: AgendaFilterDimension[] = [
  'status',
  'priority',
  'dueDate',
  'scheduledDate',
  'completedDate',
  'createdDate',
  'tag',
  'property',
]

export function dimensionLabel(dim: AgendaFilterDimension): string {
  return i18n.t(DIMENSION_OPTIONS[dim].labelKey)
}
