/**
 * The central registry of traced interaction span names (#2110, M4).
 *
 * Every `traceInteraction` call MUST name its span with a member of this map —
 * enforced by `scripts/check-trace-interactions.mjs`. Centralising the names
 * is the M4 PII guarantee for the *name* dimension: a span name can only ever
 * be one of these reviewed, opaque labels, never an interpolated string that
 * could leak a page title, query text, or block content.
 *
 * Attribute *values* carry the same discipline (ids / counts / enums / booleans
 * only — never content); that is the call site's responsibility, called out at
 * each instrumentation point.
 *
 * Names use a dotted `area.action` shape so a local trace file groups naturally
 * by interaction kind.
 */
export const INTERACTIONS = {
  /** Free-text / structural search in the Search panel. */
  SEARCH: 'search',
  /** Command-palette tag lookup (debounced tag search). */
  PALETTE_QUERY: 'palette.query',
  /** Opening a page/journal and loading its top-level blocks. */
  PAGE_OPEN: 'page.open',
} as const

/** A valid interaction span name — one of the [`INTERACTIONS`] values. */
export type InteractionName = (typeof INTERACTIONS)[keyof typeof INTERACTIONS]
