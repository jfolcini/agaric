/**
 * Shared types for per-category filter forms.
 *
 * Each per-category form component owns its own state slots and exposes
 * a narrow `getState()` slice via `useImperativeHandle`.  The parent
 * (`AddFilterRow`) merges the slice into a full `BuildState` before
 * dispatching to the module-level `buildFilterForCategory` switch.
 */

import type { CompareOp } from '../../../lib/tauri'

/**
 * Full state shape consumed by the module-level `build*Filter` helpers.
 * Each per-category form returns a `Partial<BuildState>` slice covering
 * only the fields it owns.
 */
export interface BuildState {
  blockType: string
  statusValue: string
  priorityValue: string
  containsQuery: string
  propKey: string
  propOp: CompareOp
  propValue: string
  propType: 'text' | 'num' | 'date'
  dateAfter: string
  dateBefore: string
  propSetKey: string
  propEmptyKey: string
  tagValue: string
  prefixValue: string
  propertyKeys: string[]
}

/**
 * Imperative handle each per-category form exposes via `useImperativeHandle`.
 * `getState()` returns only the slot(s) that form owns; the parent merges
 * the slice with defaults to construct a full `BuildState`.
 */
export interface FilterFormHandle {
  getState: () => Partial<BuildState>
}
