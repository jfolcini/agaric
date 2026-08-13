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
 *
 * `||`, not `??`: both columns are `string | null`, so the only falsy value
 * besides `null` is `''` — which is not a date and must bucket as "No date",
 * not as an Overdue one (`'' < todayStr`). `validate_date_format` rejects `''`
 * on every write path, so this is the same hand-edited/imported-data class as
 * `'0000-00-00'`, and the same rule applies: nothing that is not a date may
 * enter the date half of a sort key.
 */
function effectiveDate(block: BlockRow): string | null {
  return block.due_date || block.scheduled_date || null
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
 * Chronological compare of two OPTIONAL `YYYY-MM-DD` strings, undated last.
 *
 * The composite sort key `[hasDate, date]` evaluated lazily: the "has a date"
 * rank is compared first, and the date strings only when both sides are dated
 * — so no real date can sort as though undated (#3806). Returns 0 for equal
 * keys, so callers fall through to their own tiebreaks.
 *
 * Shared by the block comparator and the group-order comparator
 * (`compareGroupSortKeys`), so the null arms are exercised by one set of tests
 * instead of each caller carrying its own copy.
 */
function compareNullableDateStrings(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  return compareDateStrings(a, b)
}

/** Compare two blocks by effective date ascending, undated last. */
function compareByDate(a: BlockRow, b: BlockRow): number {
  return compareNullableDateStrings(effectiveDate(a), effectiveDate(b))
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
  /**
   * Which fixed `SpecialLabel` bucket this group is (`groupByDate` only);
   * `null`/absent for a raw date bucket and for every group produced by
   * the other `groupBy*` functions. Exists so callers can derive a render
   * key that does not collide when a raw date bucket's (possibly
   * unformatted, #3814) label happens to spell a special label verbatim —
   * see `getAgendaGroupKey` (#3845).
   */
  special?: SpecialLabel | null | undefined
}

/**
 * Unique, stable identity for a group — the source `getGroupKey` for the
 * `header:${...}` React key built by `useVirtualizedGroupedRows` (#2252).
 *
 * `label` ALONE is not safe to key on: `groupByDate` can produce two
 * groups that render the identical display label. A raw `due_date` that
 * literally spells `'Today'` lands in its own date bucket (`special:
 * null`) — separate data from the real "Today" special bucket (`special:
 * 'Today'`) — but `formatGroupDate` falls back to the raw string for a
 * non-`YYYY-MM-DD` input, so BOTH groups render the heading "Today"
 * (`#3814`'s known, deliberately-unfixed display gap). A label-keyed
 * `header:Today` would collide for the two — duplicate React keys, not
 * just a repeated heading (#3845).
 *
 * Namespacing by `special` before falling back to `label` keeps the two
 * apart: the four fixed `SpecialLabel` values and an arbitrary `label`
 * string can never collide here even when their raw text is identical,
 * because they are tagged into different namespaces before being joined.
 */
export function getAgendaGroupKey(group: AgendaGroup): string {
  // `!= null`, not truthiness: every current `SpecialLabel` is a non-empty
  // string, but a future `''` member would fall silently into the `label:`
  // namespace — the exact collision class this function exists to prevent.
  // Matches how `groupI18nKey` already discriminates the same field.
  return group.special != null ? `special:${group.special}` : `label:${group.label}`
}

/**
 * Rank half of a `groupByDate` group-order key.
 *
 * A rank is a field no date string can occupy, which is the whole point: the
 * previous encoding expressed these three positions in the DATE field itself
 * (`'0000-00-00'` for Overdue, `'9999-99-99'` for No date), and those are
 * strings a raw `due_date` can equal — so a block dated `'0000-00-00'` tied
 * with the Overdue group (#3790 finding 4).
 *
 * Exported for tests, which drive `compareGroupSortKeys` directly rather than
 * relying on the order `groupByDate` happens to insert its buckets in.
 */
export const GROUP_RANK = { beforeDates: -1, dated: 0, afterDates: 1 } as const

/**
 * Composite group-order key: rank first, then the group's own date.
 *
 * `Overdue` (before every real date) and `No date` (after every real date) are
 * ranks with no date of their own, so they carry `null` — and the type makes
 * any other value there UNREPRESENTABLE, so no future construction site can
 * smuggle a placeholder like `''` or `'9999-99-99'` back into the date half.
 * `dated` covers both the raw `YYYY-MM-DD` bucket keys and the `Today` /
 * `Tomorrow` special groups, which sort by the date they stand for.
 */
export type GroupSortKey =
  | readonly [rank: typeof GROUP_RANK.beforeDates | typeof GROUP_RANK.afterDates, date: null]
  | readonly [rank: typeof GROUP_RANK.dated, date: string]

/**
 * Order two group keys: by rank, then chronologically within a rank.
 *
 * The rank comparison is the only half that reorders anything in production:
 * `groupByDate` builds its buckets from a date-ascending pass, so the `dated`
 * groups already arrive chronologically and only `Overdue` has to move. The
 * date half is nonetheless the ordering CONTRACT — it is what makes the
 * comparator total and independent of insertion order — so it is tested here
 * directly instead of being left implicit in how the buckets happen to be
 * built.
 */
export function compareGroupSortKeys(a: GroupSortKey, b: GroupSortKey): number {
  const [rankA, dateA] = a
  const [rankB, dateB] = b
  if (rankA !== rankB) return rankA - rankB
  return compareNullableDateStrings(dateA, dateB)
}

/**
 * The four fixed non-date buckets `groupByDate` can produce, kept as a
 * distinct type rather than folding into the same `string` space as a raw
 * YYYY-MM-DD key (#3814). This is latent, not live: `validate_date_format`
 * rejects a non-ISO string like `'Today'` at every validated write path, so
 * reaching a collision needs a hand-edited database or a sync-protocol bug
 * — the same reachability class as the `effectiveDate` fix above.
 */
export type SpecialLabel = 'Overdue' | 'Today' | 'Tomorrow' | 'No date'

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

  // Two maps, not one: `specialGroups` is keyed by the fixed `SpecialLabel`
  // union, `dateGroups` by a raw YYYY-MM-DD string. A block lands in exactly
  // one, and the two key spaces cannot collide at the type level — unlike a
  // single `Map<string, BlockRow[]>`, where a `due_date` that happened to
  // spell a label (e.g. the literal string "Today") would merge into that
  // label's group and inherit its semantics (#3814).
  const specialGroups = new Map<SpecialLabel, BlockRow[]>()
  const dateGroups = new Map<string, BlockRow[]>()

  const pushTo = <K>(map: Map<K, BlockRow[]>, key: K, block: BlockRow): void => {
    const existing = map.get(key) ?? []
    existing.push(block)
    map.set(key, existing)
  }

  for (const block of sorted) {
    const date = effectiveDate(block)
    if (date === null) {
      pushTo(specialGroups, 'No date', block)
    } else if (date < todayStr && block.todo_state !== 'DONE') {
      pushTo(specialGroups, 'Overdue', block)
    } else if (date === todayStr) {
      pushTo(specialGroups, 'Today', block)
    } else if (date === tomorrowStr) {
      pushTo(specialGroups, 'Tomorrow', block)
    } else {
      // Raw-date keys keep lexicographic order == chronological order (#719)
      // — formatting happens at output time.
      pushTo(dateGroups, date, block)
    }
  }

  // Order EVERY group by a chronological sort key, rather than pinning the
  // three special groups ahead of an otherwise-sorted remainder. The old
  // approach emitted Overdue/Today/Tomorrow first, then the raw-date groups —
  // so a past-dated group (e.g. a completed task keyed by its own past
  // YYYY-MM-DD, which is NOT bucketed as Overdue) rendered AFTER Today/Tomorrow
  // and broke chronological monotonicity (#1524).
  //
  // The key is a composite `[rank, date]`, not a magic date string (see
  // `GroupSortKey` / `compareGroupSortKeys`): `beforeDates` pins `Overdue`
  // ahead of every real date, `dated` holds the special day groups and the
  // raw-date keys (which sort by themselves — already chronological, #719),
  // and `afterDates` sinks `No date` last. Labels are formatted only after
  // ordering.
  // An object literal is safe HERE, where a Map was required before (#3814).
  // The old single-map design keyed this by raw `due_date` strings, and
  // `{}['constructor']` / `'constructor' in {}` are truthy through the
  // prototype chain — so a due_date of `'constructor'` would have resolved to
  // `Object.prototype.constructor` and been destructured as `[rank, date]`.
  // Now it is indexed ONLY by the closed `SpecialLabel` union: raw dates go to
  // `dateGroups` (a real Map) and build their sort key inline, never through
  // this object. Keep it that way — if a raw date ever reaches this lookup,
  // it needs to be a Map again.
  const specialSortKey: Record<SpecialLabel, GroupSortKey> = {
    Overdue: [GROUP_RANK.beforeDates, null],
    Today: [GROUP_RANK.dated, todayStr],
    Tomorrow: [GROUP_RANK.dated, tomorrowStr],
    'No date': [GROUP_RANK.afterDates, null],
  }

  // `special` carries the ORIGINAL (unformatted) special label forward for
  // the `className` step below, kept separate from `label` (which for a
  // date bucket is the formatted display string) so a coincidentally-named
  // date bucket cannot be mistaken for a special one there either.
  interface GroupEntry {
    label: string
    blocks: BlockRow[]
    sortKey: GroupSortKey
    special: SpecialLabel | null
  }
  const entries: GroupEntry[] = [
    ...[...specialGroups.entries()].map(([label, groupBlocks]): GroupEntry => ({
      label,
      blocks: groupBlocks,
      sortKey: specialSortKey[label],
      special: label,
    })),
    ...[...dateGroups.entries()].map(([date, groupBlocks]): GroupEntry => ({
      label: formatGroupDate(date),
      blocks: groupBlocks,
      sortKey: [GROUP_RANK.dated, date],
      special: null,
    })),
  ]

  return entries
    .toSorted((a, b) => compareGroupSortKeys(a.sortKey, b.sortKey))
    .map(({ label, blocks: groupBlocks, special }) => ({
      label,
      blocks: groupBlocks,
      special,
      className:
        special === 'Overdue'
          ? 'text-destructive'
          : special === 'No date'
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
