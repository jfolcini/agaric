import { paginationLimit, type SafeLimit } from './safe-limit'

/**
 * Default page size for cursor-paginated list queries.
 *
 * Typed as {@link SafeLimit} so it satisfies the typed-boundary
 * contract on every IPC wrapper without an explicit `safeLimit(...)`
 * call at each site (limit-clamp-followup Phase 3).
 */
export const PAGINATION_LIMIT: SafeLimit = paginationLimit(50)
