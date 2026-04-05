/**
 * useAgendaPreferences — localStorage persistence for agenda groupBy/sortBy.
 *
 * Extracted from AgendaView.tsx (R-13).
 */

import { useEffect, useState } from 'react'
import type { AgendaGroupBy, AgendaSortBy } from '../lib/agenda-sort'

const GROUP_BY_KEY = 'agaric:agenda:groupBy'
const SORT_BY_KEY = 'agaric:agenda:sortBy'

const VALID_GROUP_BY: readonly string[] = ['date', 'priority', 'state', 'none']
const VALID_SORT_BY: readonly string[] = ['date', 'priority', 'state']

function readGroupBy(): AgendaGroupBy {
  try {
    const stored = localStorage.getItem(GROUP_BY_KEY)
    if (stored && VALID_GROUP_BY.includes(stored)) return stored as AgendaGroupBy
  } catch {
    /* ignore */
  }
  return 'date'
}

function readSortBy(): AgendaSortBy {
  try {
    const stored = localStorage.getItem(SORT_BY_KEY)
    if (stored && VALID_SORT_BY.includes(stored)) return stored as AgendaSortBy
  } catch {
    /* ignore */
  }
  return 'date'
}

export interface AgendaPreferences {
  groupBy: AgendaGroupBy
  sortBy: AgendaSortBy
  setGroupBy: (value: AgendaGroupBy) => void
  setSortBy: (value: AgendaSortBy) => void
}

export function useAgendaPreferences(): AgendaPreferences {
  const [groupBy, setGroupBy] = useState<AgendaGroupBy>(readGroupBy)
  const [sortBy, setSortBy] = useState<AgendaSortBy>(readSortBy)

  useEffect(() => {
    try {
      localStorage.setItem(GROUP_BY_KEY, groupBy)
    } catch {
      /* ignore */
    }
  }, [groupBy])

  useEffect(() => {
    try {
      localStorage.setItem(SORT_BY_KEY, sortBy)
    } catch {
      /* ignore */
    }
  }, [sortBy])

  return { groupBy, sortBy, setGroupBy, setSortBy }
}
