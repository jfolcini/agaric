/**
 * Palette tuning constants — shared across the palette body, the
 * ranking helper, and the tags mode. Extracted from CommandPalette.tsx
 * (#751) so both the pure-logic units and the rendering subcomponents
 * read the same caps without re-importing the whole orchestrator.
 */

/** Debounce window — palette UX is type-ahead; matches PEND-51's 80 ms. */
export const PALETTE_DEBOUNCE_MS = 80

/** Cap: page-groups rendered before the "see more" escalation. */
export const MAX_PAGE_GROUPS = 8
/** Cap: matches surfaced per group before the "+N more" pill. */
export const MAX_MATCHES_PER_GROUP = 2
/** Backend cap for the page partition. */
export const PAGE_QUERY_LIMIT = 8
/** Backend cap for the unrestricted blocks partition. */
export const BLOCK_QUERY_LIMIT = 40
/** Backend cap for the tags-mode partition. */
export const TAGS_QUERY_LIMIT = 40
