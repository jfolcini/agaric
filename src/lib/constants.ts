import { paginationLimit, type SafeLimit } from '@/lib/safe-limit'

/**
 * Default page size for cursor-paginated list queries.
 *
 * Typed as {@link SafeLimit} so it satisfies the typed-boundary
 * contract on every IPC wrapper without an explicit `safeLimit(...)`
 * call at each site (limit-clamp-followup Phase 3).
 */
export const PAGINATION_LIMIT: SafeLimit = paginationLimit(50)

/**
 * Window (ms) within which consecutive ops group into one undo: wide enough
 * for a recurrence burst on a slow device, narrow enough not to merge two
 * intentional actions. Drives capture-time coalescing in the undo store's
 * `onNewAction` and the backend's grouping for the positional fallback. Here,
 * not in the store, so `e2e/helpers.ts` can read it in Node.
 */
export const UNDO_GROUP_WINDOW_MS = 500
