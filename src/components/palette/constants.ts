/**
 * Palette tuning constants — shared across the palette body, the
 * ranking helper, and the tags mode. Extracted from CommandPalette.tsx
 * (#751) so both the pure-logic units and the rendering subcomponents
 * read the same caps without re-importing the whole orchestrator.
 */

import { partitionedSearchLimit, type SafeLimit } from '@/lib/safe-limit'

/** Debounce window — palette UX is type-ahead; matches 80 ms. */
export const PALETTE_DEBOUNCE_MS = 80

/** Cap: page-groups rendered before the "see more" escalation. */
export const MAX_PAGE_GROUPS = 8
/** Cap: matches surfaced per group before the "+N more" pill. */
export const MAX_MATCHES_PER_GROUP = 2
/**
 * Backend cap for the page partition, branded {@link SafeLimit} so it
 * feeds `searchBlocksPartitioned` without a per-callsite cap check and
 * an over-cap literal would fail at this construction site.
 */
export const PAGE_QUERY_LIMIT: SafeLimit = partitionedSearchLimit(8)
/** Backend cap for the unrestricted blocks partition (branded {@link SafeLimit}). */
export const BLOCK_QUERY_LIMIT: SafeLimit = partitionedSearchLimit(40)
/**
 * Link-mode blocks-partition limit — `0` means "pages only, skip the
 * blocks partition entirely". Branded {@link SafeLimit} (the
 * `[0, MAX_SEARCH_RESULTS]` helper admits 0) so it slots into
 * `searchBlocksPartitioned`'s `blockLimit` without widening the call's
 * ternary back to a plain `number`.
 */
export const LINK_MODE_BLOCK_LIMIT: SafeLimit = partitionedSearchLimit(0)
/** Backend cap for the tags-mode partition. */
export const TAGS_QUERY_LIMIT = 40
