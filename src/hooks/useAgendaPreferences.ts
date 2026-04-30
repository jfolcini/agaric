/**
 * useAgendaPreferences — localStorage persistence for agenda groupBy/sortBy.
 *
 * Extracted from AgendaView.tsx (R-13). Migrated to the shared
 * `useLocalStoragePreference` hook in MAINT-129.
 */

import type { AgendaGroupBy, AgendaSortBy } from '../lib/agenda-sort'
import { useLocalStoragePreference } from './useLocalStoragePreference'

const GROUP_BY_KEY = 'agaric:agenda:groupBy'
const SORT_BY_KEY = 'agaric:agenda:sortBy'

const VALID_GROUP_BY: readonly string[] = ['date', 'priority', 'state', 'page', 'none']
const VALID_SORT_BY: readonly string[] = ['date', 'priority', 'state', 'page']

export interface AgendaPreferences {
  groupBy: AgendaGroupBy
  sortBy: AgendaSortBy
  setGroupBy: (value: AgendaGroupBy) => void
  setSortBy: (value: AgendaSortBy) => void
}

// Stored format is the bare value (e.g. `date`, not `"date"`) — predates
// MAINT-129 and must keep parsing existing on-disk preferences.
const groupByOptions = {
  parse: (raw: string): AgendaGroupBy => {
    if (VALID_GROUP_BY.includes(raw)) return raw as AgendaGroupBy
    throw new Error('invalid groupBy')
  },
  serialize: (v: AgendaGroupBy): string => v,
  source: 'useAgendaPreferences',
}

const sortByOptions = {
  parse: (raw: string): AgendaSortBy => {
    if (VALID_SORT_BY.includes(raw)) return raw as AgendaSortBy
    throw new Error('invalid sortBy')
  },
  serialize: (v: AgendaSortBy): string => v,
  source: 'useAgendaPreferences',
}

export function useAgendaPreferences(): AgendaPreferences {
  const [groupBy, setGroupBy] = useLocalStoragePreference<AgendaGroupBy>(
    GROUP_BY_KEY,
    'page',
    groupByOptions,
  )
  const [sortBy, setSortBy] = useLocalStoragePreference<AgendaSortBy>(
    SORT_BY_KEY,
    'state',
    sortByOptions,
  )

  return { groupBy, sortBy, setGroupBy, setSortBy }
}
