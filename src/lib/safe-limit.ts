/**
 * Compile-time pagination-limit boundary — limit-clamp-followup Phase 3.
 *
 * The BUG-48 anti-pattern (`listBlocks({ limit: 500 })` silently
 * truncated to the backend clamp) is now both a backend `AppError::
 * Validation` (Phase 1) AND a TypeScript error (this module).  Every
 * pagination-aware IPC wrapper in `src/lib/tauri.ts` takes
 * `SafeLimit` instead of `number`, so a plain `number` literal does
 * not assign and the caller is forced through {@link safeLimit} (or
 * one of the per-IPC cap helpers below), which runs the bounds check
 * at the call site rather than silently round-tripping a bad value
 * to the backend.
 *
 * Design note — single unbranded shape.  An earlier iteration of this
 * module parameterised the brand by the per-IPC cap
 * (`SafeLimit<MAX>`) so a `SafeLimit<500>` could not slot into a
 * wrapper expecting `SafeLimit<100>`.  That made the brand strictly
 * per-IPC and broke shared callsites (e.g. `PAGINATION_LIMIT = 50`
 * being passed to both a cap-100 IPC and a cap-200 IPC) without
 * runtime benefit, because the cap is already enforced by Phase 1's
 * backend `AppError::Validation`.  The current shape is intentionally
 * a single unparameterised brand: the type system enforces "you
 * went through `safeLimit()`" and the backend enforces the numeric
 * cap.  Per-IPC helpers below remain for self-documenting call sites.
 *
 * Backend caps (mirrored here as `const` so a future bump shows up as
 * a coordinated change rather than a silent drift):
 *
 *   - `listBlocks`              → 100  (`list_blocks_inner`)
 *   - `searchBlocks`            → 100  (`search_blocks_inner`; SQL-A1
 *                                       hard-rejects `> MAX_SEARCH_RESULTS`
 *                                       even though `PageRequest::new` would
 *                                       accept up to 200)
 *   - `queryByProperty`,
 *     `listUnfinishedTasks`,
 *     `listUndatedTasks`,
 *     `listTagsByPrefix`,
 *     `listBacklinks` & friends → 200  (`PageRequest::new`)
 *   - `listProjectedAgenda`     → 500  (`list_projected_agenda_inner`)
 *
 * IPCs that return a bounded set (no pagination) — e.g.
 * `listAllPagesInSpace`, `listAllTagsInSpace`, `countTrash`,
 * `loadPageSubtree` — take NO limit argument and are exempt from this
 * module.  Callers that genuinely need "all of X" must route through
 * those dedicated IPCs.
 */

declare const SAFE_LIMIT: unique symbol

/**
 * A `number` proven to lie in `[1, cap]` against SOME per-IPC cap.
 * Constructed only via {@link safeLimit} (or its per-IPC helpers).
 */
export type SafeLimit = number & {
  readonly [SAFE_LIMIT]: true
}

/** Backend cap for `list_blocks_inner`. */
export const LIST_BLOCKS_MAX = 100

/**
 * Backend cap for `search_blocks_inner`. Although `PageRequest::new`
 * accepts up to {@link PAGINATION_MAX}, SQL-A1 rejects any
 * `search_blocks` limit above `MAX_SEARCH_RESULTS` (the FTS scan
 * ceiling), so the effective cap is 100.
 */
export const SEARCH_BLOCKS_MAX = 100

/**
 * Backend cap for every IPC routed through `pagination::PageRequest::new`
 * (`query_by_property`, `list_unfinished_tasks`, `list_undated_tasks`,
 * `list_tags_by_prefix`, `list_backlinks` and its grouped/unlinked
 * variants, `list_page_history`, `get_block_history`,
 * `list_page_aliases_by_prefix`, `list_property_defs`,
 * `query_by_tags`, `filtered_blocks_query`).
 *
 * NOTE: `search_blocks` is NOT in this group — it routes through
 * `PageRequest::new` (1..=200) but then SQL-A1 hard-rejects any limit
 * above `MAX_SEARCH_RESULTS` (100). Use {@link searchBlocksLimit}.
 */
export const PAGINATION_MAX = 200

/** Backend cap for `list_projected_agenda_inner`. */
export const LIST_PROJECTED_AGENDA_MAX = 500

/**
 * Build a {@link SafeLimit} from a runtime `number`, validating that
 * the value is in `[1, max]`.  Throws synchronously when out of range
 * so a bad literal fails at the call site, not at the IPC boundary
 * after a round trip.
 */
export function safeLimit(n: number, max: number): SafeLimit {
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new RangeError(
      `safeLimit: ${n} is outside [1, ${max}]. Pagination limits must be in this range.`,
    )
  }
  return n as SafeLimit
}

/** Shorthand for {@link safeLimit}`(n, LIST_BLOCKS_MAX)`. */
export function listBlocksLimit(n: number): SafeLimit {
  return safeLimit(n, LIST_BLOCKS_MAX)
}

/** Shorthand for {@link safeLimit}`(n, SEARCH_BLOCKS_MAX)`. */
export function searchBlocksLimit(n: number): SafeLimit {
  return safeLimit(n, SEARCH_BLOCKS_MAX)
}

/** Shorthand for {@link safeLimit}`(n, PAGINATION_MAX)`. */
export function paginationLimit(n: number): SafeLimit {
  return safeLimit(n, PAGINATION_MAX)
}

/** Shorthand for {@link safeLimit}`(n, LIST_PROJECTED_AGENDA_MAX)`. */
export function listProjectedAgendaLimit(n: number): SafeLimit {
  return safeLimit(n, LIST_PROJECTED_AGENDA_MAX)
}
