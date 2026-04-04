import type { BlockRow } from './tauri'

export type AgendaSortBy = 'date' | 'priority' | 'state'
export type AgendaGroupBy = 'date' | 'priority' | 'state' | 'none'

/**
 * Effective date for a block: prefer due_date, then scheduled_date.
 * Returns '9999-12-31' for blocks with no date (sort to bottom).
 */
function effectiveDate(block: BlockRow): string {
  return block.due_date ?? block.scheduled_date ?? '9999-12-31'
}

/** State sort rank: DOING=0, TODO=1, DONE=2, null/other=3 */
function stateRank(state: string | null): number {
  if (state === 'DOING') return 0
  if (state === 'TODO') return 1
  if (state === 'DONE') return 2
  return 3
}

/** Priority sort rank: 1=0, 2=1, 3=2, null/other=3 */
function priorityRank(priority: string | null): number {
  if (priority === '1') return 0
  if (priority === '2') return 1
  if (priority === '3') return 2
  return 3
}

/**
 * Sort agenda blocks using the key chain: date ASC → state (DOING > TODO > DONE > null) → priority (1 > 2 > 3 > null).
 * Pure function, does not mutate input.
 */
export function sortAgendaBlocks(blocks: BlockRow[]): BlockRow[] {
  return [...blocks].sort((a, b) => {
    // 1. Date ascending
    const dateA = effectiveDate(a)
    const dateB = effectiveDate(b)
    if (dateA !== dateB) return dateA < dateB ? -1 : 1

    // 2. State: DOING > TODO > DONE > null
    const stateA = stateRank(a.todo_state)
    const stateB = stateRank(b.todo_state)
    if (stateA !== stateB) return stateA - stateB

    // 3. Priority: 1 > 2 > 3 > null
    const prioA = priorityRank(a.priority)
    const prioB = priorityRank(b.priority)
    return prioA - prioB
  })
}

export interface AgendaGroup {
  label: string
  /** CSS class for the group header */
  className?: string
  blocks: BlockRow[]
}

/**
 * Group blocks by effective date. Returns groups in date order.
 * Special groups: "Overdue" (pinned first), "Today", "Tomorrow", then date strings.
 */
export function groupByDate(blocks: BlockRow[]): AgendaGroup[] {
  const sorted = sortAgendaBlocks(blocks)
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

  const groups = new Map<string, BlockRow[]>()

  for (const block of sorted) {
    const date = effectiveDate(block)
    let label: string
    if (date === '9999-12-31') {
      label = 'No date'
    } else if (date < todayStr && block.todo_state !== 'DONE') {
      label = 'Overdue'
    } else if (date === todayStr) {
      label = 'Today'
    } else if (date === tomorrowStr) {
      label = 'Tomorrow'
    } else {
      label = formatGroupDate(date)
    }

    const existing = groups.get(label) ?? []
    existing.push(block)
    groups.set(label, existing)
  }

  // Sort group keys: Overdue first, then Today, Tomorrow, then chronological, No date last
  const ORDER = ['Overdue', 'Today', 'Tomorrow']
  const result: AgendaGroup[] = []

  for (const key of ORDER) {
    if (groups.has(key)) {
      result.push({
        label: key,
        blocks: groups.get(key) ?? [],
        className: key === 'Overdue' ? 'text-red-600 dark:text-red-400' : undefined,
      })
      groups.delete(key)
    }
  }

  // Remaining date groups (sorted chronologically), excluding "No date"
  const noDate = groups.get('No date')
  groups.delete('No date')

  const remaining = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [label, blocks] of remaining) {
    result.push({ label, blocks })
  }

  // No date group at the end
  if (noDate) {
    result.push({ label: 'No date', blocks: noDate, className: 'text-muted-foreground' })
  }

  return result
}

/**
 * Group blocks by priority level. Returns groups in order: P1, P2, P3, No priority.
 * Within each group, blocks are sorted by date ASC then state.
 */
export function groupByPriority(blocks: BlockRow[]): AgendaGroup[] {
  const buckets = new Map<string, BlockRow[]>([
    ['P1', []],
    ['P2', []],
    ['P3', []],
    ['No priority', []],
  ])

  for (const block of blocks) {
    const key =
      block.priority === '1'
        ? 'P1'
        : block.priority === '2'
          ? 'P2'
          : block.priority === '3'
            ? 'P3'
            : 'No priority'
    buckets.get(key)?.push(block)
  }

  const sortWithin = (a: BlockRow, b: BlockRow): number => {
    // date ASC
    const dateA = effectiveDate(a)
    const dateB = effectiveDate(b)
    if (dateA !== dateB) return dateA < dateB ? -1 : 1
    // state
    return stateRank(a.todo_state) - stateRank(b.todo_state)
  }

  const CLASS_MAP: Record<string, string> = {
    P1: 'text-red-600 dark:text-red-400',
    P2: 'text-yellow-600 dark:text-yellow-400',
    P3: 'text-blue-600 dark:text-blue-400',
    'No priority': 'text-muted-foreground',
  }

  const result: AgendaGroup[] = []
  for (const [label, group] of buckets) {
    if (group.length === 0) continue
    result.push({
      label,
      blocks: [...group].sort(sortWithin),
      className: CLASS_MAP[label],
    })
  }
  return result
}

/**
 * Group blocks by todo state. Returns groups in order: DOING, TODO, DONE, No state.
 * Within each group, blocks are sorted by date ASC then priority.
 */
export function groupByState(blocks: BlockRow[]): AgendaGroup[] {
  const buckets = new Map<string, BlockRow[]>([
    ['DOING', []],
    ['TODO', []],
    ['DONE', []],
    ['No state', []],
  ])

  for (const block of blocks) {
    const key =
      block.todo_state === 'DOING'
        ? 'DOING'
        : block.todo_state === 'TODO'
          ? 'TODO'
          : block.todo_state === 'DONE'
            ? 'DONE'
            : 'No state'
    buckets.get(key)?.push(block)
  }

  const sortWithin = (a: BlockRow, b: BlockRow): number => {
    // date ASC
    const dateA = effectiveDate(a)
    const dateB = effectiveDate(b)
    if (dateA !== dateB) return dateA < dateB ? -1 : 1
    // priority
    return priorityRank(a.priority) - priorityRank(b.priority)
  }

  const CLASS_MAP: Record<string, string> = {
    DOING: 'text-amber-600 dark:text-amber-400',
    TODO: 'text-blue-600 dark:text-blue-400',
    DONE: 'text-green-600 dark:text-green-400',
    'No state': 'text-muted-foreground',
  }

  const result: AgendaGroup[] = []
  for (const [label, group] of buckets) {
    if (group.length === 0) continue
    result.push({
      label,
      blocks: [...group].sort(sortWithin),
      className: CLASS_MAP[label],
    })
  }
  return result
}

/**
 * Sort agenda blocks using the key chain: priority ASC → date ASC → state.
 * Pure function, does not mutate input.
 */
export function sortByPriority(blocks: BlockRow[]): BlockRow[] {
  return [...blocks].sort((a, b) => {
    // 1. Priority: 1 > 2 > 3 > null
    const prioA = priorityRank(a.priority)
    const prioB = priorityRank(b.priority)
    if (prioA !== prioB) return prioA - prioB

    // 2. Date ascending
    const dateA = effectiveDate(a)
    const dateB = effectiveDate(b)
    if (dateA !== dateB) return dateA < dateB ? -1 : 1

    // 3. State: DOING > TODO > DONE > null
    const stateA = stateRank(a.todo_state)
    const stateB = stateRank(b.todo_state)
    return stateA - stateB
  })
}

/**
 * Sort agenda blocks using the key chain: state (DOING>TODO>DONE>null) → date ASC → priority.
 * Pure function, does not mutate input.
 */
export function sortByState(blocks: BlockRow[]): BlockRow[] {
  return [...blocks].sort((a, b) => {
    // 1. State: DOING > TODO > DONE > null
    const stateA = stateRank(a.todo_state)
    const stateB = stateRank(b.todo_state)
    if (stateA !== stateB) return stateA - stateB

    // 2. Date ascending
    const dateA = effectiveDate(a)
    const dateB = effectiveDate(b)
    if (dateA !== dateB) return dateA < dateB ? -1 : 1

    // 3. Priority: 1 > 2 > 3 > null
    const prioA = priorityRank(a.priority)
    const prioB = priorityRank(b.priority)
    return prioA - prioB
  })
}

/**
 * Dispatch to the correct sort function based on the sortBy parameter.
 * Defaults to date-first sort.
 */
export function sortAgendaBlocksBy(blocks: BlockRow[], sortBy: AgendaSortBy): BlockRow[] {
  switch (sortBy) {
    case 'priority':
      return sortByPriority(blocks)
    case 'state':
      return sortByState(blocks)
    default:
      return sortAgendaBlocks(blocks)
  }
}

/** Short month names for compact date display. */
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** Format YYYY-MM-DD for group headers. Same year -> "Mon DD", different year -> "Mon DD, YYYY". */
function formatGroupDate(dateStr: string): string {
  const parts = dateStr.split('-')
  if (parts.length !== 3) return dateStr
  const [y, m, d] = parts.map(Number)
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return dateStr
  const month = MONTH_SHORT[(m ?? 1) - 1] ?? 'Jan'
  const day = d ?? 1
  const now = new Date()
  // Include weekday for dates within 7 days
  const date = new Date(y as number, (m as number) - 1, d)
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const weekday = WEEKDAYS[date.getDay()]
  if (y === now.getFullYear()) return `${weekday}, ${month} ${day}`
  return `${weekday}, ${month} ${day}, ${y}`
}
