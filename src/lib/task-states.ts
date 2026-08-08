/**
 * Canonical task-state vocabulary shared by editor, filter, agenda, and block surfaces.
 *
 * `TASK_STATES` follows the user-facing toggle/filter order. Agenda sorting deliberately
 * uses a different order, captured separately by `TASK_STATE_SORT_ORDER`; deriving one
 * from the other would move TODO ahead of in-progress work.
 */
export const TASK_STATES = ['TODO', 'DOING', 'DONE', 'CANCELLED'] as const

export type TodoState = (typeof TASK_STATES)[number]

/** Locked click cycle: none -> TODO -> DOING -> DONE -> CANCELLED -> none. */
export const TASK_CYCLE: readonly (TodoState | null)[] = [null, ...TASK_STATES]

/** Agenda order: active work first, then queued, completed, cancelled, and no state. */
export const TASK_STATE_SORT_ORDER = [
  'DOING',
  'TODO',
  'DONE',
  'CANCELLED',
] as const satisfies readonly TodoState[]

/** Search/autocomplete adds `none` as a query sentinel, not as a persisted task state. */
export const TASK_STATE_AUTOCOMPLETE_VALUES = [...TASK_STATES, 'none'] as const

/** Canonical serialization marker for each persisted task state. */
export const TASK_STATE_TO_MARKER = {
  TODO: ' ',
  DOING: '/',
  DONE: 'x',
  CANCELLED: '-',
} as const satisfies Record<TodoState, string>

/** GFM / Obsidian Tasks checkbox markers shared by paste and markdown parsing. */
export const TASK_MARKER_TO_STATE = {
  ' ': 'TODO',
  '/': 'DOING',
  x: 'DONE',
  X: 'DONE',
  '-': 'CANCELLED',
} as const satisfies Record<string, TodoState>

export type TaskMarker = keyof typeof TASK_MARKER_TO_STATE

const TASK_STATE_SET: ReadonlySet<unknown> = new Set(TASK_STATES)

// The explicit record is load-bearing: adding or removing a TodoState must fail type-checking
// until its agenda rank is chosen deliberately.
const TASK_STATE_RANK = {
  DOING: 0,
  TODO: 1,
  DONE: 2,
  CANCELLED: 3,
} as const satisfies Record<TodoState, number>

export function isTodoState(value: unknown): value is TodoState {
  return TASK_STATE_SET.has(value)
}

/** Map a checkbox marker without pretending arbitrary strings are valid keys. */
export function taskStateFromMarker(marker: string): TodoState | null {
  return Object.hasOwn(TASK_MARKER_TO_STATE, marker)
    ? TASK_MARKER_TO_STATE[marker as TaskMarker]
    : null
}

/** Return the next state while preserving the legacy invalid-value recovery (`unknown` -> null). */
export function nextTaskState(current: string | null): TodoState | null {
  const currentIndex = TASK_CYCLE.findIndex((state) => state === current)
  const nextIndex = (currentIndex + 1) % TASK_CYCLE.length
  return TASK_CYCLE[nextIndex] ?? null
}

/** Unknown and null states sort after every persisted task state. */
export function taskStateRank(state: string | null): number {
  return isTodoState(state) ? TASK_STATE_RANK[state] : TASK_STATE_SORT_ORDER.length
}
