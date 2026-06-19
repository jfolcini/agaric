import { getPriorityLevels, priorityRank } from './priority-levels'
import type { BlockRow } from './tauri'

export type AgendaSortBy = 'date' | 'priority' | 'state' | 'page'
export type AgendaGroupBy = 'date' | 'priority' | 'state' | 'page' | 'none'

/**
 * Effective date for a block: prefer due_date, then scheduled_date.
 * Returns '9999-12-31' for blocks with no date (sort to bottom).
 */
function effectiveDate(block: BlockRow): string {
  return block.due_date ?? block.scheduled_date ?? '9999-12-31'
}

/** State sort rank: DOING=0, TODO=1, DONE=2, CANCELLED=3, null/other=4. */
function stateRank(state: string | null): number {
  if (state === 'DOING') return 0
  if (state === 'TODO') return 1
  if (state === 'DONE') return 2
  if (state === 'CANCELLED') return 3
  return 4
}

/**
 * Sort agenda blocks using the key chain: date ASC → state (DOING > TODO > DONE > CANCELLED > null) → priority (1 > 2 > 3 > null).
 * Pure function, does not mutate input.
 */
export function sortAgendaBlocks(blocks: BlockRow[]): BlockRow[] {
  return [...blocks].sort((a, b) => {
    // 1. Date ascending
    const dateA = effectiveDate(a)
    const dateB = effectiveDate(b)
    if (dateA !== dateB) return dateA < dateB ? -1 : 1

    // 2. State: DOING > TODO > DONE > CANCELLED > null
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
  className?: string | undefined
  blocks: BlockRow[]
}

/**
 * Group blocks by effective date. Returns groups in date order.
 * Special group keys (renderer maps to t('agenda.overdue') / t('agenda.today') /
 * t('agenda.tomorrow') / t('agenda.noDate')): `Overdue` (pinned first),
 * `Today`, `Tomorrow`, then date strings, then `No date` last.
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
    // Map keys: the special group names plus raw YYYY-MM-DD strings for
    // every other date. Raw-date keys keep lexicographic order ==
    // chronological order (#719) — formatting happens at output time.
    let key: string
    if (date === '9999-12-31') {
      key = 'No date'
    } else if (date < todayStr && block.todo_state !== 'DONE') {
      key = 'Overdue'
    } else if (date === todayStr) {
      key = 'Today'
    } else if (date === tomorrowStr) {
      key = 'Tomorrow'
    } else {
      key = date
    }

    const existing = groups.get(key) ?? []
    existing.push(block)
    groups.set(key, existing)
  }

  // Order EVERY group by a chronological sort key, rather than pinning the
  // three special groups ahead of an otherwise-sorted remainder. The old
  // approach emitted Overdue/Today/Tomorrow first, then the raw-date groups —
  // so a past-dated group (e.g. a completed task keyed by its own past
  // YYYY-MM-DD, which is NOT bucketed as Overdue) rendered AFTER Today/Tomorrow
  // and broke chronological monotonicity (#1524). Now each group maps to a
  // sort key: `Overdue` (past, not-done) sorts before every real date, the
  // special day groups sort by their actual date, raw-date keys sort by
  // themselves (already chronological — #719), and `No date` sinks last.
  // Labels are formatted only after ordering.
  const SPECIAL_SORT_KEY: Record<string, string> = {
    Overdue: '0000-00-00',
    Today: todayStr,
    Tomorrow: tomorrowStr,
    'No date': '9999-99-99',
  }
  const sortKeyFor = (key: string): string => SPECIAL_SORT_KEY[key] ?? key

  return [...groups.entries()]
    .sort(([a], [b]) => {
      const ka = sortKeyFor(a)
      const kb = sortKeyFor(b)
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    .map(([key, blocks]) => ({
      label: key in SPECIAL_SORT_KEY ? key : formatGroupDate(key),
      blocks,
      className:
        key === 'Overdue'
          ? 'text-destructive'
          : key === 'No date'
            ? 'text-muted-foreground'
            : undefined,
    }))
}

/**
 * Group blocks by priority level. Returns groups in level order
 * (configurable via UX-201b), with the `No priority` key last (renderer
 * translates via t('agenda.noPriority')). Within each group,
 * blocks are sorted by date ASC then state.
 *
 * Index-keyed `CLASS_MAP` matches the first three groups to the
 * destructive / pending / active semantic tokens; level 4+ re-uses the
 * "active" token (same fallback as `priorityColor`).
 */
export function groupByPriority(blocks: BlockRow[]): AgendaGroup[] {
  const levels = getPriorityLevels()
  const groupLabel = (p: string) => `P${p}`
  const NO_PRIORITY = 'No priority'

  const buckets = new Map<string, BlockRow[]>()
  for (const lv of levels) buckets.set(groupLabel(lv), [])
  buckets.set(NO_PRIORITY, [])

  for (const block of blocks) {
    const key =
      block.priority != null && levels.indexOf(block.priority) >= 0
        ? groupLabel(block.priority)
        : NO_PRIORITY
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

  const INDEX_CLASS = [
    'text-destructive',
    'text-status-pending-foreground',
    'text-status-active-foreground',
  ] as const

  const classForLevel = (lv: string): string => {
    const idx = levels.indexOf(lv)
    if (idx < 0) return ''
    return INDEX_CLASS[Math.min(idx, INDEX_CLASS.length - 1)] ?? ''
  }

  const result: AgendaGroup[] = []
  for (const [label, group] of buckets) {
    if (group.length === 0) continue
    const className =
      label === NO_PRIORITY ? 'text-muted-foreground' : classForLevel(label.replace(/^P/, ''))
    result.push({
      label,
      blocks: [...group].sort(sortWithin),
      className,
    })
  }
  return result
}

/**
 * Group blocks by todo state. Returns groups in order: DOING, TODO, DONE, CANCELLED, No state.
 * Within each group, blocks are sorted by date ASC then priority.
 */
export function groupByState(blocks: BlockRow[]): AgendaGroup[] {
  const buckets = new Map<string, BlockRow[]>([
    ['DOING', []],
    ['TODO', []],
    ['DONE', []],
    ['CANCELLED', []],
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
            : block.todo_state === 'CANCELLED'
              ? 'CANCELLED'
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
    DOING: 'text-status-pending-foreground',
    TODO: 'text-status-active-foreground',
    DONE: 'text-status-done-foreground',
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

    // 3. State: DOING > TODO > DONE > CANCELLED > null
    const stateA = stateRank(a.todo_state)
    const stateB = stateRank(b.todo_state)
    return stateA - stateB
  })
}

/**
 * Sort agenda blocks using the key chain: state (DOING>TODO>DONE>CANCELLED>null) → date ASC → priority.
 * Pure function, does not mutate input.
 */
export function sortByState(blocks: BlockRow[]): BlockRow[] {
  return [...blocks].sort((a, b) => {
    // 1. State: DOING > TODO > DONE > CANCELLED > null
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
 * Group blocks by page_id. Returns groups in alphabetical order by page title,
 * with the `No page` key at the end (renderer translates via t('agenda.noPage')).
 * Within each group, blocks are sorted by state (DOING > TODO > DONE > CANCELLED > null),
 * then priority, then date.
 */
export function groupByPage(blocks: BlockRow[], pageTitles: Map<string, string>): AgendaGroup[] {
  const buckets = new Map<string, BlockRow[]>()

  for (const block of blocks) {
    const key = block.page_id ?? '__no_page__'
    const existing = buckets.get(key) ?? []
    existing.push(block)
    buckets.set(key, existing)
  }

  const sortWithin = (a: BlockRow, b: BlockRow): number => {
    // state
    const stateA = stateRank(a.todo_state)
    const stateB = stateRank(b.todo_state)
    if (stateA !== stateB) return stateA - stateB
    // priority
    const prioA = priorityRank(a.priority)
    const prioB = priorityRank(b.priority)
    if (prioA !== prioB) return prioA - prioB
    // date
    const dateA = effectiveDate(a)
    const dateB = effectiveDate(b)
    if (dateA !== dateB) return dateA < dateB ? -1 : 1
    return 0
  }

  // Separate no-page bucket
  const noPageBlocks = buckets.get('__no_page__')
  buckets.delete('__no_page__')

  // Build entries with resolved titles, then sort alphabetically
  const entries: Array<{ pageId: string; title: string; blocks: BlockRow[] }> = []
  for (const [pageId, group] of buckets) {
    const title = pageTitles.get(pageId) ?? pageId
    entries.push({ pageId, title, blocks: group })
  }
  entries.sort((a, b) => a.title.localeCompare(b.title))

  const result: AgendaGroup[] = []
  for (const entry of entries) {
    result.push({
      label: entry.title,
      blocks: [...entry.blocks].sort(sortWithin),
    })
  }

  // `No page` group key at the end (renderer translates via t('agenda.noPage'))
  if (noPageBlocks && noPageBlocks.length > 0) {
    result.push({
      label: 'No page',
      blocks: [...noPageBlocks].sort(sortWithin),
      className: 'text-muted-foreground',
    })
  }

  return result
}

/**
 * Sort blocks alphabetically by page title (resolved via pageTitles map).
 * Within same page: sort by state, then priority, then date.
 * Blocks with no page_id sort to the end.
 * Pure function, does not mutate input.
 */
export function sortByPage(blocks: BlockRow[], pageTitles: Map<string, string>): BlockRow[] {
  return [...blocks].sort((a, b) => {
    const titleA = a.page_id ? (pageTitles.get(a.page_id) ?? a.page_id) : null
    const titleB = b.page_id ? (pageTitles.get(b.page_id) ?? b.page_id) : null

    // Blocks with no page_id sort to the end
    if (titleA === null && titleB !== null) return 1
    if (titleA !== null && titleB === null) return -1

    // Both have page titles — compare alphabetically
    if (titleA !== null && titleB !== null && titleA !== titleB) {
      return titleA.localeCompare(titleB)
    }

    // Same page (or both null): sort by state, then priority, then date
    const stateA = stateRank(a.todo_state)
    const stateB = stateRank(b.todo_state)
    if (stateA !== stateB) return stateA - stateB

    const prioA = priorityRank(a.priority)
    const prioB = priorityRank(b.priority)
    if (prioA !== prioB) return prioA - prioB

    const dateA = effectiveDate(a)
    const dateB = effectiveDate(b)
    if (dateA !== dateB) return dateA < dateB ? -1 : 1

    return 0
  })
}

/**
 * Dispatch to the correct sort function based on the sortBy parameter.
 * Defaults to date-first sort.
 */
export function sortAgendaBlocksBy(
  blocks: BlockRow[],
  sortBy?: AgendaSortBy | undefined,
  pageTitles?: Map<string, string> | undefined,
): BlockRow[] {
  switch (sortBy) {
    case 'priority':
      return sortByPriority(blocks)
    case 'state':
      return sortByState(blocks)
    case 'page':
      return sortByPage(blocks, pageTitles ?? new Map())
    default:
      return sortAgendaBlocks(blocks)
  }
}

/**
 * Format YYYY-MM-DD for group headers: weekday always included, year only
 * when it differs from the current year (e.g. "Mon, Jun 15" vs
 * "Mon, Jun 15, 2026" in an en locale).
 *
 * #757 — uses the runtime locale via `toLocaleDateString(undefined, …)`
 * (the `formatDateDisplay` convention in date-utils.ts) instead of
 * hardcoded English weekday/month tables, so concrete date headers are
 * localized like the special labels (Overdue/Today/…) that go through
 * t(). Malformed inputs fall back to the raw string.
 */
function formatGroupDate(dateStr: string): string {
  const parts = dateStr.split('-')
  if (parts.length !== 3) return dateStr
  const [y, m, d] = parts.map(Number)
  if (y === undefined || m === undefined || d === undefined) return dateStr
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return dateStr
  const date = new Date(y, m - 1, d)
  const sameYear = y === new Date().getFullYear()
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}
