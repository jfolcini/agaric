import type { BlockRow } from '@/lib/bindings'
import { getPriorityLevels, priorityRank } from '@/lib/priority-levels'
import {
  isTodoState,
  TASK_STATE_SORT_ORDER,
  taskStateRank,
  type TodoState,
} from '@/lib/task-states'

export type AgendaSortBy = 'date' | 'priority' | 'state' | 'page'
export type AgendaGroupBy = 'date' | 'priority' | 'state' | 'page' | 'none'

/**
 * Effective date for a block: prefer due_date, then scheduled_date.
 *
 * Returns `null` — NOT a far-future date string — when the block has neither.
 * This used to return `'9999-12-31'`, a calendar-valid ISO date that
 * `set_due_date` accepts, so a block genuinely due that day was
 * indistinguishable from an undated one (#3806). "Undated" now lives in a
 * value that no date can occupy.
 */
function effectiveDate(block: BlockRow): string | null {
  return block.due_date ?? block.scheduled_date ?? null
}

/**
 * Chronological compare of two `YYYY-MM-DD` strings.
 *
 * Lexicographic order == chronological order for that format (#719), so this
 * is a plain string compare. The one definition is shared by the block-level
 * comparator and the group-order comparator so both are exercised by the same
 * tests instead of each carrying its own untested arm.
 */
function compareDateStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compare two blocks by effective date ascending, undated last.
 *
 * This is the composite sort key `[hasDate, date]` evaluated lazily: the
 * "has a date" rank is compared first, and the date strings only when both
 * blocks are dated — so no real date can sort as though undated (#3806).
 * Returns 0 for equal keys, so callers fall through to their own tiebreaks.
 */
function compareByDate(a: BlockRow, b: BlockRow): number {
  const dateA = effectiveDate(a)
  const dateB = effectiveDate(b)
  if (dateA === null) return dateB === null ? 0 : 1
  if (dateB === null) return -1
  return compareDateStrings(dateA, dateB)
}

/**
 * Sort agenda blocks using the key chain: date ASC → state (DOING > TODO > DONE > CANCELLED > null) → priority (1 > 2 > 3 > null).
 * Pure function, does not mutate input.
 */
export function sortAgendaBlocks(blocks: BlockRow[]): BlockRow[] {
  return [...blocks].toSorted((a, b) => {
    // 1. Date ascending (undated last)
    const byDate = compareByDate(a, b)
    if (byDate !== 0) return byDate

    // 2. State: DOING > TODO > DONE > CANCELLED > null
    const stateA = taskStateRank(a.todo_state)
    const stateB = taskStateRank(b.todo_state)
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
    if (date === null) {
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
  // and broke chronological monotonicity (#1524).
  //
  // The key is a composite `[rank, date]`, not a magic date string: rank
  // BEFORE_DATES pins `Overdue` ahead of every real date, DATED holds the
  // special day groups and the raw-date keys (which sort by themselves —
  // already chronological, #719), and AFTER_DATES sinks `No date` last. The
  // date half is only compared within a rank.
  //
  // The previous encoding put those three positions in the date field itself
  // ('0000-00-00' for Overdue, '9999-99-99' for No date). Those are strings a
  // raw `due_date` can equal, so a block dated '0000-00-00' tied with the
  // Overdue group and the order fell out of Map insertion order (#3790
  // finding 4). A rank is a field no date string can occupy, so the tie —
  // and the whole class — is gone. Labels are formatted only after ordering.
  const RANK_BEFORE_DATES = -1
  const RANK_DATED = 0
  const RANK_AFTER_DATES = 1
  type GroupSortKey = readonly [rank: number, date: string]
  // A Map, not an object literal: bucket keys are raw `due_date` strings, and
  // `'constructor' in {}` / `{}['constructor']` are truthy through the
  // prototype chain.
  const SPECIAL_SORT_KEY = new Map<string, GroupSortKey>([
    ['Overdue', [RANK_BEFORE_DATES, '']],
    ['Today', [RANK_DATED, todayStr]],
    ['Tomorrow', [RANK_DATED, tomorrowStr]],
    ['No date', [RANK_AFTER_DATES, '']],
  ])
  const sortKeyFor = (key: string): GroupSortKey => SPECIAL_SORT_KEY.get(key) ?? [RANK_DATED, key]

  return [...groups.entries()]
    .toSorted(([a], [b]) => {
      const [rankA, dateA] = sortKeyFor(a)
      const [rankB, dateB] = sortKeyFor(b)
      // The rank comparison is what actually reorders anything: `groups` is
      // built from a date-ascending pass, so the DATED groups are already in
      // chronological insertion order and only `Overdue` has to move. The date
      // half is therefore a no-op today — it exists so the comparator is total
      // and stays correct if the bucketing order ever changes, which is why
      // mutants on the `rankA !== rankB` guard survive.
      if (rankA !== rankB) return rankA - rankB
      return compareDateStrings(dateA, dateB)
    })
    .map(([key, groupBlocks]) => ({
      label: SPECIAL_SORT_KEY.has(key) ? key : formatGroupDate(key),
      blocks: groupBlocks,
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
 * (configurable via), with the `No priority` key last (renderer
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
    // date ASC (undated last)
    const byDate = compareByDate(a, b)
    if (byDate !== 0) return byDate
    // state
    return taskStateRank(a.todo_state) - taskStateRank(b.todo_state)
  }

  const INDEX_CLASS = [
    'text-destructive',
    'text-status-pending-foreground',
    'text-status-active-foreground',
  ] as const

  // `lv` always comes from `levels`: the only call site passes
  // `label.replace(/^P/, '')` where `label` is `` `P${lv}` ``, so the strip is
  // an exact round-trip and `idx >= 0` always (levels are normalised to
  // non-empty, deduped strings in priority-levels.ts). The clamped index is
  // therefore always in range — the `?? ''` is unreachable at runtime and
  // exists only for `noUncheckedIndexedAccess`, which types a variable tuple
  // index as `string | undefined`.
  const classForLevel = (lv: string): string => {
    const idx = levels.indexOf(lv)
    return INDEX_CLASS[Math.min(idx, INDEX_CLASS.length - 1)] ?? ''
  }

  const result: AgendaGroup[] = []
  for (const [label, group] of buckets) {
    if (group.length === 0) continue
    const className =
      label === NO_PRIORITY ? 'text-muted-foreground' : classForLevel(label.replace(/^P/, ''))
    result.push({
      label,
      blocks: [...group].toSorted(sortWithin),
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
  const NO_STATE = 'No state'
  const buckets = new Map<string, BlockRow[]>(
    TASK_STATE_SORT_ORDER.map((state) => [state, []] as const),
  )
  buckets.set(NO_STATE, [])

  for (const block of blocks) {
    const key = isTodoState(block.todo_state) ? block.todo_state : NO_STATE
    buckets.get(key)?.push(block)
  }

  const sortWithin = (a: BlockRow, b: BlockRow): number => {
    // date ASC (undated last)
    const byDate = compareByDate(a, b)
    if (byDate !== 0) return byDate
    // priority
    return priorityRank(a.priority) - priorityRank(b.priority)
  }

  const CLASS_MAP = {
    DOING: 'text-status-pending-foreground',
    TODO: 'text-status-active-foreground',
    DONE: 'text-status-done-foreground',
    CANCELLED: 'text-task-cancelled',
    [NO_STATE]: 'text-muted-foreground',
  } satisfies Record<TodoState | typeof NO_STATE, string>

  const result: AgendaGroup[] = []
  for (const [label, group] of buckets) {
    if (group.length === 0) continue
    result.push({
      label,
      blocks: [...group].toSorted(sortWithin),
      className: CLASS_MAP[label as TodoState | typeof NO_STATE],
    })
  }
  return result
}

/**
 * Sort agenda blocks using the key chain: priority ASC → date ASC → state.
 * Pure function, does not mutate input.
 */
export function sortByPriority(blocks: BlockRow[]): BlockRow[] {
  return [...blocks].toSorted((a, b) => {
    // 1. Priority: 1 > 2 > 3 > null
    const prioA = priorityRank(a.priority)
    const prioB = priorityRank(b.priority)
    if (prioA !== prioB) return prioA - prioB

    // 2. Date ascending (undated last)
    const byDate = compareByDate(a, b)
    if (byDate !== 0) return byDate

    // 3. State: DOING > TODO > DONE > CANCELLED > null
    const stateA = taskStateRank(a.todo_state)
    const stateB = taskStateRank(b.todo_state)
    return stateA - stateB
  })
}

/**
 * Sort agenda blocks using the key chain: state (DOING>TODO>DONE>CANCELLED>null) → date ASC → priority.
 * Pure function, does not mutate input.
 */
export function sortByState(blocks: BlockRow[]): BlockRow[] {
  return [...blocks].toSorted((a, b) => {
    // 1. State: DOING > TODO > DONE > CANCELLED > null
    const stateA = taskStateRank(a.todo_state)
    const stateB = taskStateRank(b.todo_state)
    if (stateA !== stateB) return stateA - stateB

    // 2. Date ascending (undated last)
    const byDate = compareByDate(a, b)
    if (byDate !== 0) return byDate

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
    const stateA = taskStateRank(a.todo_state)
    const stateB = taskStateRank(b.todo_state)
    if (stateA !== stateB) return stateA - stateB
    // priority
    const prioA = priorityRank(a.priority)
    const prioB = priorityRank(b.priority)
    if (prioA !== prioB) return prioA - prioB
    // date (undated last)
    return compareByDate(a, b)
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
      blocks: [...entry.blocks].toSorted(sortWithin),
    })
  }

  // `No page` group key at the end (renderer translates via t('agenda.noPage'))
  // No length check: the `__no_page__` bucket is only ever created by pushing
  // a block into it, so when present it is non-empty.
  if (noPageBlocks) {
    result.push({
      label: 'No page',
      blocks: [...noPageBlocks].toSorted(sortWithin),
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
  return [...blocks].toSorted((a, b) => {
    const titleA = a.page_id ? (pageTitles.get(a.page_id) ?? a.page_id) : null
    const titleB = b.page_id ? (pageTitles.get(b.page_id) ?? b.page_id) : null

    // Blocks with no page_id sort to the end
    if (titleA === null && titleB !== null) return 1
    if (titleA !== null && titleB === null) return -1

    // Both have page titles — compare alphabetically.
    // The two `!== null` clauses are always true here (the one-sided-null
    // cases returned above), but they are required for narrowing: without
    // them TS reports `'titleA' is possibly 'null'` on `.localeCompare`.
    if (titleA !== null && titleB !== null && titleA !== titleB) {
      return titleA.localeCompare(titleB)
    }

    // Same page (or both null): sort by state, then priority, then date
    const stateA = taskStateRank(a.todo_state)
    const stateB = taskStateRank(b.todo_state)
    if (stateA !== stateB) return stateA - stateB

    const prioA = priorityRank(a.priority)
    const prioB = priorityRank(b.priority)
    if (prioA !== prioB) return prioA - prioB

    return compareByDate(a, b)
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
    case 'priority': {
      return sortByPriority(blocks)
    }
    case 'state': {
      return sortByState(blocks)
    }
    case 'page': {
      return sortByPage(blocks, pageTitles ?? new Map())
    }
    default: {
      return sortAgendaBlocks(blocks)
    }
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
  // Unreachable at runtime — `parts.length === 3` is guaranteed by the early
  // return above, so all three destructured slots exist. Kept for narrowing:
  // `noUncheckedIndexedAccess` types them `number | undefined`, and without
  // this guard `new Date(y, m - 1, d)` fails to typecheck.
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
