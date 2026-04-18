import { i18n } from './i18n'
import { logger } from './logger'

export type AgendaFilterDimension =
  | 'status'
  | 'priority'
  | 'dueDate'
  | 'scheduledDate'
  | 'completedDate'
  | 'createdDate'
  | 'tag'
  | 'property'

/** Read custom task states from localStorage, filtering out nulls. */
export function getTaskStates(): string[] {
  try {
    const stored = localStorage.getItem('task_cycle')
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0)
      }
    }
  } catch (err) {
    logger.warn('filter-dimension-metadata', 'failed to read task_cycle from localStorage', {}, err)
  }
  return ['TODO', 'DOING', 'DONE']
}

export const DIMENSION_OPTIONS: Record<
  AgendaFilterDimension,
  { labelKey: string; choices: string[] | null | (() => string[]) }
> = {
  status: { labelKey: 'agendaFilter.status', choices: getTaskStates },
  priority: { labelKey: 'agendaFilter.priority', choices: ['1', '2', '3'] },
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
