/**
 * The time buckets of today's task panel (#7155 R7): every open task under the
 * one tab its earlier date (due or scheduled) puts it in, sorted by that date,
 * then priority.
 */

import type { BlockRow } from '@/lib/bindings'
import { priorityRank } from '@/lib/priority-levels'

export const TASK_BUCKETS = ['overdue', 'today', 'thisWeek', 'later', 'noDate'] as const
export type TaskBucket = (typeof TASK_BUCKETS)[number]

/** The earlier of a block's due and scheduled dates; `null` when it has neither. */
export function taskDate(block: BlockRow): string | null {
  const { due_date: due, scheduled_date: scheduled } = block
  if (due != null && scheduled != null) return due < scheduled ? due : scheduled
  return due ?? scheduled ?? null
}

/** By date, then priority; a row dated by a property alone sorts as `fallbackDate`. */
export function byDateThenPriority(fallbackDate: string) {
  return (a: BlockRow, b: BlockRow): number =>
    (taskDate(a) ?? fallbackDate).localeCompare(taskDate(b) ?? fallbackDate) ||
    priorityRank(a.priority) - priorityRank(b.priority)
}

/**
 * `dayRows` are the day's own agenda rows (any source, open or stateless);
 * `openTasks` every open task. A row in both goes where its date puts it, so a
 * task due today but scheduled last week is overdue.
 */
export function bucketTasks(
  dayRows: BlockRow[],
  openTasks: BlockRow[],
  today: string,
  weekEnd: string,
): Record<TaskBucket, BlockRow[]> {
  const buckets: Record<TaskBucket, BlockRow[]> = {
    overdue: [],
    today: [],
    thisWeek: [],
    later: [],
    noDate: [],
  }
  const placed = new Set<string>()
  for (const task of openTasks) {
    const date = taskDate(task)
    const bucket: TaskBucket =
      date == null
        ? 'noDate'
        : date < today
          ? 'overdue'
          : date === today
            ? 'today'
            : date <= weekEnd
              ? 'thisWeek'
              : 'later'
    buckets[bucket].push(task)
    placed.add(task.id)
  }
  for (const row of dayRows) if (!placed.has(row.id)) buckets.today.push(row)
  const order = byDateThenPriority(today)
  for (const bucket of TASK_BUCKETS) buckets[bucket].sort(order)
  return buckets
}
